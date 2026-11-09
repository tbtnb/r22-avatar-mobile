import {neutralMouthMetrics} from './frame-metrics.js?v=stability-r9c';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

// Estimate edge spread in the *captured source*, never the synthetic teeth.
// A small binomial prefilter suppresses codec noise; the ratio of derivative
// energies is contrast independent. It is a bounded visual heuristic, not an
// objective focus score. Textureless regions retain the previous estimate.
export class DentalDetailMatcher {
  constructor(){
    this.gray=new Float32Array(184*184);
    this.filtered=new Float32Array(184*184);
    this.sigma=.75;this.initialized=false;
  }
  update(source,frame,vertices,ix){
    if(!source||source.length!==184*184*4)return {sigma:this.sigma,confidence:0};
    const {gray,filtered}=this;
    const m=neutralMouthMetrics(frame,vertices,ix),w=m.width;
    const x0=clamp(Math.floor(m.center[0]-w*.78),2,181),x1=clamp(Math.ceil(m.center[0]+w*.78),2,181);
    const y0=clamp(Math.floor(m.center[1]-w*.52),2,181),y1=clamp(Math.ceil(m.center[1]+w*.52),2,181);
    for(let y=y0-2;y<=y1+2;y++)for(let x=x0-2;x<=x1+2;x++){
      const at=y*184+x,i=at*4;gray[at]=source[i]*.2126+source[i+1]*.7152+source[i+2]*.0722;
    }
    for(let y=y0-1;y<=y1+1;y++)for(let x=x0-1;x<=x1+1;x++){
      const i=y*184+x;
      filtered[i]=(gray[i-185]+2*gray[i-184]+gray[i-183]+2*gray[i-1]+4*gray[i]+2*gray[i+1]+gray[i+183]+2*gray[i+184]+gray[i+185])/16;
    }
    let gradient=0,laplacian=0,count=0;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const i=y*184+x,dx=(filtered[i+1]-filtered[i-1])*.5,dy=(filtered[i+184]-filtered[i-184])*.5;
      const energy=dx*dx+dy*dy;
      if(energy<4)continue;
      const lap=filtered[i-1]+filtered[i+1]+filtered[i-184]+filtered[i+184]-4*filtered[i];
      gradient+=energy;laplacian+=lap*lap;count++;
    }
    const confidence=clamp(count/80,0,1);
    if(count>=24&&laplacian>1e-4){
      const target=clamp(Math.sqrt(Math.max(.16,.5*gradient/laplacian-.5)),.4,1.8);
      this.sigma=this.initialized?this.sigma*.84+target*.16:target;this.initialized=true;
    }
    return {sigma:this.sigma,confidence,edgeSamples:count};
  }
}
