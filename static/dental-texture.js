import {assetURL} from './asset-url.js';
import {MouthGeometry} from './geometry.js?v=mouth-stability-1';
import {articulationRig} from './articulation.js?v=mouth-stability-1';
import {DentalDetailMatcher} from './dental-detail.js?v=dental-blend-r13';

export function dentalUVs(avatar,category=3){
  const vertices=avatar.vertices,uv=new Float32Array(vertices.length/5*2),row=[];
  for(let i=0;i<vertices.length;i+=5)if(vertices[i+3]===category)row.push(i/5);
  if(row.length!==18)throw new Error('牙弓网格格式不匹配');
  row.sort((a,b)=>vertices[a*5]-vertices[b*5]);
  const stations=[];
  for(let i=0;i<row.length;i+=2){
    const pair=row.slice(i,i+2).sort((a,b)=>vertices[a*5+1]-vertices[b*5+1]);
    const center=[0,1,2].map(axis=>(vertices[pair[0]*5+axis]+vertices[pair[1]*5+axis])/2);
    stations.push({pair,center,distance:0});
  }
  for(let i=1;i<stations.length;i++)stations[i].distance=stations[i-1].distance+Math.hypot(...stations[i].center.map((v,k)=>v-stations[i-1].center[k]));
  const total=stations.at(-1).distance;
  if(!(total>0))throw new Error('牙弓尺寸无效');
  for(const station of stations){
    for(let i=0;i<2;i++){const at=station.pair[i]*2;uv[at]=station.distance/total;uv[at+1]=i;}
  }
  return uv;
}

// Refit only the display mesh. The legacy lower arch is also a neural prompt
// category, so its original geometry and blendshape contract stay in use there.
function fitLowerArch(avatar,uv){
  const rig=articulationRig(avatar),vertices=avatar.vertices.slice();
  const lip=rig.local(vertices.slice(avatar.mouthIndices.lowerInner*5,avatar.mouthIndices.lowerInner*5+3));
  const row=[];
  for(let i=0;i<vertices.length;i+=5){
    if(vertices[i+3]===4)row.push({i,p:rig.local(vertices.slice(i,i+3))});
  }
  const xs=row.map(({p})=>p[0]),min=Math.min(...xs),max=Math.max(...xs),center=(min+max)/2;
  const anchor=row.filter(({i})=>uv[i/5*2+1]===0)
    .reduce((a,b)=>Math.abs(a.p[0]-center)<Math.abs(b.p[0]-center)?a:b);
  for(const {i,p} of row){
    const across=(p[0]-center)/(max-min);
    const root=uv[i/5*2+1];
    const x=lip[0]+rig.width*.57*across;
    const y=lip[1]+rig.width*(-.082+.157*root+.14*across*across);
    const z=lip[2]+rig.width*.12+(p[2]-anchor.p[2])*.85;
    for(let axis=0;axis<3;axis++){
      vertices[i+axis]+=rig.x[axis]*(x-p[0])+rig.y[axis]*(y-p[1])+rig.z[axis]*(z-p[2]);
    }
  }
  return {avatar:{...avatar,vertices},anchor:anchor.i/5};
}

const smooth=(a,b,x)=>{
  const t=Math.max(0,Math.min(1,(x-a)/(b-a)));
  return t*t*(3-2*t);
};

export class DentalTextureRenderer extends MouthGeometry{
  async init(avatar){
    const lowerUV=dentalUVs(avatar,4),display=fitLowerArch(avatar,lowerUV);
    await super.init(display.avatar,{renderScale:4,shaderRoot:'/static/dental-texture/'});
    this.lowerAnchor=display.anchor;
    const gl=this.gl,uv=dentalUVs(avatar),lowerIndices=[];
    for(let i=0;i<avatar.triangles.length;i+=3){
      const triangle=avatar.triangles.slice(i,i+3);
      if(triangle.every(id=>avatar.vertices[id*5+3]===4))lowerIndices.push(...triangle);
    }
    lowerUV.forEach((v,i)=>uv[i]+=v);
    this.lowerIndexBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.lowerIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(lowerIndices),gl.STATIC_DRAW);
    this.lowerIndexCount=lowerIndices.length;
    const uvBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,uv,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,8,0);
    for(const key of ['dentalTexture','upperShape','dentalRect','toothTint','dentalMix','dentalBlur','dentalScale','lowerExposure','lowerOffset','upperGumTone','lowerGumTone'])this.locations[key]=gl.getUniformLocation(this.program,key);
    const image=new Image();image.src=assetURL('/static/assets/dental-material-r8.png');await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,image.width,image.height).data;
    let count=0;const sum=[0,0,0];
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
      const i=(y*image.width+x)*4;
      if(pixels[i+3]!==255)throw new Error('牙齿材质必须是不透明图像');
      const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
      if(y>image.height*.35&&y<image.height*.76&&r+g+b>300&&r<g*1.25&&g<b*1.35){for(let c=0;c<3;c++)sum[c]+=pixels[i+c]/255;count++;}
    }
    if(!count)throw new Error('牙齿材质为空');
    this.referenceMean=sum.map(x=>x/count);
    // Remove only the atlas's dark empty background, retaining attached
    // gingiva and solid enamel. Premultiply *before* generating mipmaps so
    // filtering cannot drag that background into the tooth contours.
    for(let i=0;i<pixels.length;i+=4){
      const value=Math.max(pixels[i],pixels[i+1],pixels[i+2])/255;
      const t=Math.max(0,Math.min(1,(value-.19)/.15)),coverage=t*t*(3-2*t);
      for(let c=0;c<3;c++)pixels[i+c]=Math.round(pixels[i+c]*coverage);
      pixels[i+3]=Math.round(255*coverage);
    }
    this.textureBounds=[0,.10,1,.79];
    this.dentalTexture=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.dentalTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,image.width,image.height,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.uniform1i(this.locations.dentalTexture,1);
    this.tint=[.85,.85,.85];this.visiblePixels=0;
    this.gumTones=[[.38,.20,.20],[.40,.22,.22]];
    this.detailMatcher=new DentalDetailMatcher();this.blurSigma=.75;
    this.displayProjection=new Float32Array([2/184,0,0,0,0,-2/184,0,0,0,0,.001,0,-1,1,0,1]);
  }
  sourceTeeth(source,frame){
    if(!source||!frame)return [];
    const polygon=this.openingIndices.map(id=>[frame.points[16+id*2],frame.points[17+id*2]]);
    const x0=Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[0])))),x1=Math.min(183,Math.ceil(Math.max(...polygon.map(p=>p[0]))));
    const y0=Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[1])))),y1=Math.min(183,Math.ceil(Math.max(...polygon.map(p=>p[1]))));
    const colors=[];
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      let inside=false,previous=polygon.at(-1);
      for(const current of polygon){if((current[1]>y+.5)!=(previous[1]>y+.5)&&x+.5<(previous[0]-current[0])*(y+.5-current[1])/(previous[1]-current[1])+current[0])inside=!inside;previous=current;}
      if(!inside)continue;
      const i=(y*184+x)*4,r=source[i]/255,g=source[i+1]/255,b=source[i+2]/255;
      if(r+g+b>1.05&&r<g*1.30&&g<b*1.35)colors.push([r,g,b]);
    }
    return colors;
  }
  lighting(rgba,prompt,source,frame){
    const colors=[],lips=[[0,0,0,0],[0,0,0,0]];let teeth=0;
    for(let i=0;i<prompt.length;i+=4){
      const r=rgba[i]/255,g=rgba[i+1]/255,b=rgba[i+2]/255;
      if(prompt[i]<30&&prompt[i+1]>220&&prompt[i+2]<30){
        if(r+g+b>1.05&&r<g*1.30&&g<b*1.35)colors.push([r,g,b]);
        teeth++;
      }else if(prompt[i]>=120&&prompt[i+1]<25&&prompt[i+2]<25&&r>.16&&r>g*1.12&&r>b*1.05){
        const sum=lips[prompt[i]>200?0:1];
        sum[0]+=r;sum[1]+=g;sum[2]+=b;sum[3]++;
      }
    }
    this.gumTones=this.gumTones.map((tone,row)=>{
      const sum=lips[row];
      return sum[3]<8?tone:tone.map((v,c)=>v*.8+sum[c]/sum[3]*[.86,.76,.80][c]*.2);
    });
    this.visiblePixels=teeth;
    const actual=this.sourceTeeth(source,frame),samples=actual.length>=8?actual:colors;
    this.lightingSource=actual.length>=8?'source-teeth':colors.length>=8?'neutral-generated-teeth':'previous-lighting';
    if(samples.length>=8){
      samples.sort((a,b)=>a[0]+a[1]+a[2]-b[0]-b[1]-b[2]);
      const selected=samples.slice(Math.floor(samples.length*.45),Math.max(1,Math.ceil(samples.length*.85)));
      const color=[0,1,2].map(c=>selected.reduce((s,p)=>s+p[c],0)/selected.length);
      this.tint=this.tint.map((x,c)=>x*.85+Math.max(.35,Math.min(1.02,color[c]/this.referenceMean[c]))*.15);
    }
  }
  lowerJawOffset(pose,lipCover){
    const {vertices,y,ix,width}=this.articulationRig;
    const lip=ix.lowerInner,tip=this.lowerAnchor,basisIndex=vertices[lip*5+4]*3;
    const offset=y.reduce((sum,axis,k)=>{
      let motion=this.articulationOffsets[lip*3+k]-this.articulationOffsets[tip*3+k];
      for(let i=0;i<6;i++)motion+=pose[i]*this.basis[i][basisIndex+k];
      return sum+axis*motion;
    },0);
    return y.map(axis=>axis*(offset+width*lipCover));
  }
  draw(frame,pose,rgba,prompt,guide=null,source=null){
    this.lighting(rgba,prompt,source,frame);const gl=this.gl;
    this.sourceQuality=this.detailMatcher.update(source,frame,this.avatar.vertices,this.avatar.mouthIndices);
    this.blurSigma=this.sourceQuality.sigma;
    this.setArticulation(pose,guide);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locations.gWorld0,false,new Float32Array(frame.points.slice(0,16)));
    gl.uniformMatrix4fv(this.locations.gProjection,false,this.displayProjection);
    gl.uniform4fv(this.locations.dentalRect,this.textureBounds);gl.uniform3fv(this.locations.toothTint,this.tint);
    this.setOpening(frame,pose,guide);
    const {window:occlusionWindow,aperture,spanRatio}=this.dentalVisibility;
    const [dx,dy]=occlusionWindow,top=this.openingUpperIndex,bottom=this.openingLowerIndex;
    const gap=Math.max(0,dx*(this.opening[bottom+1]-this.opening[top+1])
      -dy*(this.opening[bottom]-this.opening[top]));
    const halfOpening=occlusionWindow[3]/spanRatio;
    const round=(guide?.[0]||0)*(guide?.[5]||0);
    const seal=guide?.[2]||0,bite=guide?.[3]||0;
    const phoneticLimit=guide?.toothLimit??1;
    // The neural prompt may hide the whole row even in an open vowel. Size
    // the display arch from the actual lip opening, using the prompt for tint.
    const upperSpan=(.58+.25*smooth(.065,.22,aperture))*(1-.25*round)*(.88+.12*phoneticLimit);
    const upperDepth=Math.min(halfOpening*.18,gap*.40)*(1-.45*round)*(.85+.15*phoneticLimit);
    this.exposure=smooth(.047,.105,aperture)*(1-seal);
    gl.uniform2f(this.locations.upperShape,halfOpening*upperSpan,upperDepth);
    const lowerVisibility=smooth(.105,.225,aperture)
      *(1-seal)*(1-.80*round)*(1-.85*bite)*phoneticLimit**1.5;
    // Reveal more of the crown from behind the lip as the jaw opens. Use
    // alpha only for the last sliver instead of cross-fading the whole row.
    this.lowerExposure=smooth(.02,.23,lowerVisibility);
    const lipCover=.075*(1-lowerVisibility);
    gl.uniform1f(this.locations.dentalMix,this.exposure);
    gl.uniform1f(this.locations.lowerExposure,this.lowerExposure);
    gl.uniform3fv(this.locations.lowerOffset,this.lowerJawOffset(pose,lipCover));
    gl.uniform3fv(this.locations.upperGumTone,this.gumTones[0]);
    gl.uniform3fv(this.locations.lowerGumTone,this.gumTones[1]);
    gl.uniform1f(this.locations.dentalBlur,this.blurSigma);gl.uniform1f(this.locations.dentalScale,this.canvas.width/184);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.frontFace(gl.CCW);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if(this.lowerExposure>.005){
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.lowerIndexBuffer);
      gl.drawElements(gl.TRIANGLES,this.lowerIndexCount,gl.UNSIGNED_SHORT,0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.dentalIndexBuffer);gl.drawElements(gl.TRIANGLES,this.dentalIndexCount,gl.UNSIGNED_SHORT,0);
    return this.canvas;
  }
}
