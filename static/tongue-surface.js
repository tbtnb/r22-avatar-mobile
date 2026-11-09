import {assetURL} from './asset-url.js';
import {oralFrame,TongueSurfaceState} from './tongue-region.js?v=tongue-surface-r18';

// Analytic surface reconstruction, not super-resolution or recovered anatomy.
// Canonical UVs keep synthesized detail attached to the tongue across frames.
export class TongueSurfaceRenderer{
  async init(){
    this.state=new TongueSurfaceState();this.canvas=Object.assign(document.createElement('canvas'),{width:368,height:368});
    const gl=this.gl=this.canvas.getContext('webgl2',{antialias:false});if(!gl)throw Error('舌面重建需要 WebGL 2');
    const vertex='#version 300 es\nlayout(location=0) in vec2 position;out vec2 uv;void main(){gl_Position=vec4(position,0,1);uv=vec2(position.x*.5+.5,.5-position.y*.5);}';
    const response=await fetch(assetURL('/static/tongue-surface.frag'),{cache:'no-store'});if(!response.ok)throw Error('无法加载舌面渲染程序');
    const shaders=[vertex,await response.text()].map((code,i)=>{const s=gl.createShader(i?gl.FRAGMENT_SHADER:gl.VERTEX_SHADER);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;});
    this.program=gl.createProgram();shaders.forEach(s=>gl.attachShader(this.program,s));gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(this.program));gl.useProgram(this.program);
    const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    this.locations={};for(const key of ['image','semantic','polygon','axis','oralRange','verticalRange','tissueTone','strength','detailAmount','dental','hasDental','lowerExposure'])this.locations[key]=gl.getUniformLocation(this.program,key);
    this.textures=[368,184,736].map((size,unit)=>{const t=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,unit===1?gl.NEAREST:gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,unit===1?gl.NEAREST:gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;});
    gl.uniform1i(this.locations.image,0);gl.uniform1i(this.locations.semantic,1);gl.uniform1i(this.locations.dental,2);
  }
  reset(){this.state?.reset();}
  draw(input,rgba,prompt,opening,sigma=1,seal=0,dental=null,lowerExposure=0){
    const layout=this.state.update(opening,rgba,prompt,seal);this.lastLayout=layout;
    if(!layout&&!dental)return null;
    const frame=layout?.frame??oralFrame(opening);
    if(!frame)return null;
    const gl=this.gl;gl.useProgram(this.program);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.textures[0]);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,input);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.textures[1]);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,184,184,gl.RGBA,gl.UNSIGNED_BYTE,prompt);
    if(dental){
      gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,this.textures[2]);
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,dental);
    }
    gl.uniform1i(this.locations.hasDental,dental?1:0);
    gl.uniform1f(this.locations.lowerExposure,dental?lowerExposure:0);
    gl.uniform2fv(this.locations.polygon,frame.polygon.flat());gl.uniform2fv(this.locations.axis,frame.axis);
    gl.uniform2f(this.locations.oralRange,frame.center,frame.width*.5);if(layout)gl.uniform3fv(this.locations.tissueTone,layout.tone);
    gl.uniform2f(this.locations.verticalRange,Math.min(...frame.polygon.map(p=>p[1])),Math.max(...frame.polygon.map(p=>p[1])));
    gl.uniform1f(this.locations.strength,(layout?.gate??0)*.90);gl.uniform1f(this.locations.detailAmount,Math.max(.10,Math.min(1,1/(Math.max(.7,sigma)**2))));
    gl.viewport(0,0,368,368);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.DITHER);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    return this.canvas;
  }
  dispose(){this.gl?.getExtension('WEBGL_lose_context')?.loseContext();this.gl=null;}
}
