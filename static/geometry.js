import {assetURL} from './asset-url.js';
// Geometry rasterization adapted from DH_live (MIT); independent lifecycle and buffers.
import {calibratePose} from './pose-calibration.js?v=stability-r9c';
import {articulationRig,articulate3D,deformedVertices} from './articulation.js?v=tongue-coarticulation-r17';
import {neutralMouthMetrics,lipApertureRatio} from './frame-metrics.js?v=stability-r9c';
import {SoftwareMouthRasterizer} from './geometry-rasterizer.js?v=tongue-coarticulation-r17';
import {dentalVisibility} from './dental-visibility.js?v=tongue-coarticulation-r17';
export class MouthGeometry {
  dispose(){
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl=null;this.canvas=null;
  }
  async init(avatar,options={}) {
    this.size = avatar.size;
    this.avatar=avatar;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.size*(options.renderScale||1);
    const gl = this.gl = this.canvas.getContext('webgl2', {antialias:false});
    if (!gl) throw new Error('当前浏览器不支持 WebGL 2，请使用 Chrome');
    const sources = await Promise.all(['mouth.vert','mouth.frag'].map(async file => {
      const r = await fetch(assetURL((options.shaderRoot||'/static/')+file),{cache:'no-store'}); if (!r.ok) throw new Error('无法加载渲染程序'); return r.text();
    }));
    const shaders = sources.map((source,i) => {
      const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
      gl.shaderSource(shader,source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    });
    this.program = gl.createProgram();
    shaders.forEach(s=>gl.attachShader(this.program,s)); gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    gl.useProgram(this.program);
    const buffer=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(avatar.vertices),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,20,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,2,gl.FLOAT,false,20,12);
    this.articulationRig=articulationRig(avatar);
    this.articulationOffsets=new Float32Array(avatar.vertices.length/5*3);
    this.articulationBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.articulationBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,this.articulationOffsets,gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,3,gl.FLOAT,false,0,0);
    this.indexBuffer=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(avatar.triangles),gl.STATIC_DRAW);
    this.indexCount=avatar.triangles.length;
    const dentalIndices=[];
    for(let i=0;i<avatar.triangles.length;i+=3){
      const triangle=avatar.triangles.slice(i,i+3);
      if(triangle.every(id=>avatar.vertices[id*5+3]===3))dentalIndices.push(...triangle);
    }
    this.dentalIndexBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.dentalIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(dentalIndices),gl.STATIC_DRAW);this.dentalIndexCount=dentalIndices.length;
    this.openingIndices=[...avatar.lipContours.upper.slice(11),...avatar.lipContours.lower.slice(12,-1)];
    this.opening=new Float32Array(this.openingIndices.length*2);
    this.outerIndices=[...avatar.lipContours.upper.slice(0,11),...avatar.lipContours.lower.slice(1,10)];
    this.outerOpening=new Float32Array(this.outerIndices.length*2);
    this.openingUpperIndex=this.openingIndices.indexOf(avatar.mouthIndices.upperInner)*2;
    this.openingLowerIndex=this.openingIndices.indexOf(avatar.mouthIndices.lowerInner)*2;
    this.locations={};
    for(const name of ['gWorld0','gProjection','bsVec','vertBuffer','texture_bs','passMode','teethPass','lipOpening','dentalWindow','dentalOcclusion']) this.locations[name]=gl.getUniformLocation(this.program,name);
    const image = new Image(); image.src=assetURL('/static/assets/blendshapes.png'); await image.decode();
    const textureCanvas=document.createElement('canvas');textureCanvas.width=image.width;textureCanvas.height=image.height;
    const textureContext=textureCanvas.getContext('2d');textureContext.drawImage(image,0,0);
    const textureBytes=textureContext.getImageData(0,0,image.width,image.height).data;
    this.basis=Array.from({length:6},(_,shape)=>Float32Array.from({length:209*3},(_,k)=>textureBytes[(shape*image.width+Math.floor(k/3))*4+k%3]/255*2-1));
    this.rasterizer=new SoftwareMouthRasterizer(avatar,this.basis,this.articulationRig);
    this.texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.uniform1i(this.locations.texture_bs,0);
    // ReadPixels returns bottom-up rows; the public prompt convention already
    // accounts for this with a positive Y projection. Do not flip it twice.
    this.projection=new Float32Array([2/this.size,0,0,0, 0,2/this.size,0,0, 0,0,.001,0, -1,-1,0,1]);
    this.pixels=new Uint8Array(this.size*this.size*4);
    this.bs=new Float32Array(12);
    gl.viewport(0,0,this.size,this.size);
  }
  condition(frame,pose){return calibratePose(pose,frame,this.avatar.vertices,this.basis,this.avatar.mouthIndices);}
  renderPair(frame,pose,guide=null){return this.rasterizer.render(frame,pose,guide);}
  setArticulation(pose,guide){
    articulate3D(this.articulationRig,pose,this.basis,guide,this.articulationOffsets);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.articulationBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER,0,this.articulationOffsets);
  }
  setOpening(frame,pose,guide=null){
    const vertices=deformedVertices(pose,this.avatar.vertices,this.basis),m=frame.points;
    this.openingIndices.forEach((id,i)=>{
      const p=[0,1,2].map(k=>vertices[id*3+k]+this.articulationOffsets[id*3+k]);
      this.opening[i*2]=m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12];
      this.opening[i*2+1]=m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13];
    });
    this.gl.uniform2fv(this.locations.lipOpening,this.opening);
    this.outerIndices.forEach((id,i)=>{
      const p=[0,1,2].map(k=>vertices[id*3+k]+this.articulationOffsets[id*3+k]);
      this.outerOpening[i*2]=m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12];
      this.outerOpening[i*2+1]=m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13];
    });
    const upper=this.opening.slice(this.openingUpperIndex,this.openingUpperIndex+2);
    const lower=this.opening.slice(this.openingLowerIndex,this.openingLowerIndex+2);
    const neutral=neutralMouthMetrics(frame,this.avatar.vertices,this.avatar.mouthIndices);
    this.openingRatio=lipApertureRatio(neutral,upper,lower);
    this.dentalVisibility=dentalVisibility({...neutral,upperTarget:upper,lowerTarget:lower},this.opening,guide);
    this.gl.uniform4fv(this.locations.dentalWindow,this.dentalVisibility.window);
    this.gl.uniform2fv(this.locations.dentalOcclusion,new Float32Array([this.dentalVisibility.softness,this.dentalVisibility.gate]));
  }
  render(frame,pose,passMode=0,guide=null) {
    const gl=this.gl;
    if(passMode===0)this.setArticulation(pose,guide);
    this.bs.fill(0);this.bs.set(pose);
    gl.useProgram(this.program);
    gl.uniform1i(this.locations.passMode,passMode);
    gl.uniform1i(this.locations.teethPass,0);
    gl.uniformMatrix4fv(this.locations.gWorld0,false,new Float32Array(frame.points.slice(0,16)));
    gl.uniformMatrix4fv(this.locations.gProjection,false,this.projection);
    gl.uniform2fv(this.locations.vertBuffer,new Float32Array(frame.points.slice(16)));
    gl.uniform1fv(this.locations.bsVec,this.bs);
    gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.frontFace(gl.CW);
    gl.clearColor(.5,.5,.5,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.indexBuffer);
    gl.drawElements(gl.TRIANGLES,this.indexCount,gl.UNSIGNED_SHORT,0);
    if(passMode===0){
      // Skin triangles can cross the dental arch in this compact mesh. Clip the
      // rigid upper arch by the articulated inner lip boundary, not those triangles.
      this.setOpening(frame,pose,guide);
      if(this.dentalVisibility.gate>.005){
        gl.uniform1i(this.locations.teethPass,1);gl.disable(gl.DEPTH_TEST);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.dentalIndexBuffer);
        gl.drawElements(gl.TRIANGLES,this.dentalIndexCount,gl.UNSIGNED_SHORT,0);
        gl.uniform1i(this.locations.teethPass,0);gl.enable(gl.DEPTH_TEST);
      }
    }
    gl.readPixels(0,0,this.size,this.size,gl.RGBA,gl.UNSIGNED_BYTE,this.pixels);
    return this.pixels;
  }
}
