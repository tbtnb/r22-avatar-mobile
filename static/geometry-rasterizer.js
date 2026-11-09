// CPU implementation of mouth.vert/mouth.frag for the two 184px neural inputs.
// These buffers go directly to CPU ONNX; rasterizing here avoids two blocking
// GPU -> CPU readPixels transfers per frame. Dental display stays on the GPU.
import {articulate3D,deformedVertices} from './articulation.js?v=tongue-coarticulation-r17';
import {neutralMouthMetrics} from './frame-metrics.js?v=stability-r9c';
import {dentalVisibility,dentalCoverage} from './dental-visibility.js?v=tongue-coarticulation-r17';

const byte=x=>Math.max(0,Math.min(255,Math.round(x*255)));
export class SoftwareMouthRasterizer {
  constructor(avatar,basis,rig){
    this.avatar=avatar;this.basis=basis;this.rig=rig;this.size=avatar.size;
    const count=avatar.vertices.length/5,n=this.size*this.size;
    this.projected=new Float64Array(count*6);
    this.offsets=new Float32Array(count*3);
    this.prompt=new Uint8Array(n*4);this.flow=new Uint8Array(n*4);
    this.promptDepth=new Float64Array(n);this.flowDepth=new Float64Array(n);
    this.openingIndices=[...avatar.lipContours.upper.slice(11),...avatar.lipContours.lower.slice(12,-1)];
    this.opening=new Float64Array(this.openingIndices.length*2);
    this.openingMask=new Uint8Array(n);
  }
  render(frame,pose,guide=null){
    const {avatar,basis,size,projected:p,prompt,flow,promptDepth,flowDepth}=this;
    const vertices=avatar.vertices,m=frame.points;
    articulate3D(this.rig,pose,basis,guide,this.offsets);
    const deformed=deformedVertices(pose,vertices,basis);
    for(let i=0;i<vertices.length/5;i++){
      const k=i*6,x=deformed[i*3]+this.offsets[i*3],y=deformed[i*3+1]+this.offsets[i*3+1],z=deformed[i*3+2]+this.offsets[i*3+2];
      const px=m[0]*x+m[4]*y+m[8]*z+m[12],py=m[1]*x+m[5]*y+m[9]*z+m[13];
      p[k]=px;p[k+1]=py;p[k+2]=m[2]*x+m[6]*y+m[10]*z+m[14];
      const type=vertices[i*5+3],id=vertices[i*5+4];
      p[k+3]=type===-1||id>=209 ? .5 : .5+(px-m[16+id*2])/184;
      p[k+4]=type===-1||id>=209 ? .5 : .5+(py-m[17+id*2])/184;
      p[k+5]=type;
    }
    for(let i=0;i<prompt.length;i+=4){prompt[i]=prompt[i+1]=prompt[i+2]=flow[i]=flow[i+1]=flow[i+2]=128;prompt[i+3]=flow[i+3]=0;}
    promptDepth.fill(Infinity);flowDepth.fill(Infinity);
    const opening=this.opening;
    this.openingIndices.forEach((id,i)=>{opening[i*2]=p[id*6];opening[i*2+1]=p[id*6+1];});
    const ix=avatar.mouthIndices;
    const neutral=neutralMouthMetrics(frame,vertices,ix),upperTarget=[p[ix.upperInner*6],p[ix.upperInner*6+1]],lowerTarget=[p[ix.lowerInner*6],p[ix.lowerInner*6+1]];
    const visibility=this.dentalVisibility=dentalVisibility({...neutral,upperTarget,lowerTarget},opening,guide);
    this.openingMask.fill(0);
    const exposeTeeth=visibility.gate>.005;
    if(exposeTeeth){
      // Scanline fill is equivalent to the fragment shader's even/odd polygon.
      const intersections=[];
      for(let y=0;y<size;y++){
        intersections.length=0;const sy=y+.5;
        for(let i=0,j=opening.length-2;i<opening.length;j=i,i+=2){
          const ay=opening[i+1],by=opening[j+1];
          if((ay>sy)!==(by>sy))intersections.push((opening[j]-opening[i])*(sy-ay)/(by-ay)+opening[i]);
        }
        intersections.sort((a,b)=>a-b);
        for(let i=0;i+1<intersections.length;i+=2){
          const left=Math.max(0,Math.ceil(intersections[i]-.5)),right=Math.min(size,Math.ceil(intersections[i+1]-.5));
          this.openingMask.fill(1,y*size+left,y*size+Math.max(left,right));
        }
      }
    }
    const triangles=avatar.triangles;
    const raster=(a,b,c,dental=false)=>{
      const ia=a*6,ib=b*6,ic=c*6;
      const ax=p[ia],ay=p[ia+1],bx=p[ib],by=p[ib+1],cx=p[ic],cy=p[ic+1];
      const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
      // Neural prompt shader uses CW front faces with a positive-Y projection.
      if(area>=-1e-8)return;
      const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(size-1,Math.floor(Math.max(ax,bx,cx)-.5));
      const y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),y1=Math.min(size-1,Math.floor(Math.max(ay,by,cy)-.5));
      const ta=p[ia+5],tb=p[ib+5],tc=p[ic+5],uniform=ta===tb&&ta===tc;
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const px=x+.5,py=y+.5;
        const wa=((bx-px)*(cy-py)-(by-py)*(cx-px))/area;
        const wb=((cx-px)*(ay-py)-(cy-py)*(ax-px))/area;
        const wc=1-wa-wb;
        if(wa<0||wb<0||wc<0)continue;
        const pixel=y*size+x,at=pixel*4;
        if(dental){if(this.openingMask[pixel]&&dentalCoverage(visibility,px,py)>=.5){prompt[at]=0;prompt[at+1]=255;prompt[at+2]=0;prompt[at+3]=255;}continue;}
        const depth=wa*p[ia+2]+wb*p[ib+2]+wc*p[ic+2];
        if(depth < -1000||depth > 1000)continue;
        const r=byte(wa*p[ia+3]+wb*p[ib+3]+wc*p[ic+3]);
        const g=byte(wa*p[ia+4]+wb*p[ib+4]+wc*p[ic+4]);
        if(depth<flowDepth[pixel]){
          flowDepth[pixel]=depth;flow[at]=r;flow[at+1]=g;flow[at+2]=128;flow[at+3]=255;
        }
        const type=uniform?ta:wa*ta+wb*tb+wc*tc;
        if(Math.abs(type-3)<.001||depth>=promptDepth[pixel])continue;
        promptDepth[pixel]=depth;prompt[at+3]=255;
        if(type===2){prompt[at]=255;prompt[at+1]=prompt[at+2]=0;}
        else if(type>2&&type<2.1){prompt[at]=128;prompt[at+1]=prompt[at+2]=0;}
        else if(type===4){prompt[at]=prompt[at+1]=0;prompt[at+2]=255;}
        else if((type>3&&type<4)||type===-2){prompt[at]=prompt[at+1]=prompt[at+2]=0;}
        else{prompt[at]=r;prompt[at+1]=g;prompt[at+2]=128;}
      }
    };
    for(let i=0;i<triangles.length;i+=3)raster(triangles[i],triangles[i+1],triangles[i+2]);
    if(exposeTeeth)for(let i=0;i<triangles.length;i+=3){
      const a=triangles[i],b=triangles[i+1],c=triangles[i+2];
      if(vertices[a*5+3]===3&&vertices[b*5+3]===3&&vertices[c*5+3]===3)raster(a,b,c,true);
    }
    return {prompt,flow};
  }
}
