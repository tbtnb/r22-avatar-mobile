import {assetURL} from './asset-url.js';
import {MouthEdgeMask} from './mouth-edge-mask.js?v=lip-edge-r15';

// Filter only the seam band of the already completed neural/dental composite.
// Its RGB silhouette/alpha stay in place; this pass never draws a new lip ring.
export class MouthEdgeBlend {
  async init(){
    this.canvas=Object.assign(document.createElement('canvas'),{width:368,height:368});
    const gl=this.gl=this.canvas.getContext('webgl2',{antialias:false});if(!gl)throw Error('边缘融合需要 WebGL 2');
    const vs='#version 300 es\nlayout(location=0) in vec2 position;out vec2 uv;void main(){gl_Position=vec4(position,0,1);uv=vec2(position.x*.5+.5,.5-position.y*.5);}';
    const fs=await(await fetch(assetURL('/static/mouth-edge-blend.frag'),{cache:'no-store'})).text();
    const shaders=[vs,fs].map((code,i)=>{const s=gl.createShader(i?gl.FRAGMENT_SHADER:gl.VERTEX_SHADER);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;});
    this.program=gl.createProgram();shaders.forEach(s=>gl.attachShader(this.program,s));gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(this.program));gl.useProgram(this.program);
    const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    this.locations={};for(const key of ['image','band','radius'])this.locations[key]=gl.getUniformLocation(this.program,key);
    const texture=(unit,format)=>{const t=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,format,368,368,0,unit?gl.RED:gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;};
    this.imageTexture=texture(0,gl.SRGB8_ALPHA8);this.maskTexture=texture(1,gl.R8);gl.uniform1i(this.locations.image,0);gl.uniform1i(this.locations.band,1);this.mask=new MouthEdgeMask();
  }
  draw(input,inner,outer,sigma=1,seal=0){
    if(seal>=.98)return null;
    const gl=this.gl;gl.useProgram(this.program);
    const band=this.mask.update(inner,outer);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.imageTexture);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,input);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.maskTexture);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,368,368,gl.RED,gl.UNSIGNED_BYTE,band);
    gl.uniform1f(this.locations.radius,Math.max(.50,Math.min(1.25,sigma)));
    gl.viewport(0,0,368,368);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.DITHER);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    return this.canvas;
  }
  dispose(){this.gl?.getExtension('WEBGL_lose_context')?.loseContext();this.gl=null;}
}
