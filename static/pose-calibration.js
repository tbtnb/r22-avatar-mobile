// Project coefficients onto simple anatomical bounds in this frame's pixel space.
// Bounds preserve this avatar's lip thickness; they are not phoneme labels.
import {neutralMouthMetrics} from './frame-metrics.js?v=stability-r9c';
export function calibratePose(pose,frame,vertices,basis,ix) {
  const result=Float64Array.from(pose);
  if(!ix||!basis)return result;
  const m=frame.points;
  const projected=(id,axis)=>m[axis]*vertices[id*5]+m[4+axis]*vertices[id*5+1]+m[8+axis]*vertices[id*5+2]+m[12+axis];
  const neutral=neutralMouthMetrics(frame,vertices,ix);
  const width=neutral.widthX,upper=neutral.upper,lower=neutral.lower;
  const definitions=[
    [ix.lowerInner,ix.upperInner,1,.35,width*.30],
    [ix.right,ix.left,0,width*.91,width*1.04],
    [ix.upperInner,ix.upperOuter,1,upper*.80,upper*1.15],
    [ix.lowerOuter,ix.lowerInner,1,lower*.80,lower*1.15]
  ];
  const constraints=definitions.map(([a,b,axis,lo,hi])=>{
    const base=projected(a,axis)-projected(b,axis);
    const gradient=basis.map(shape=>m[axis]*(shape[a*3]-shape[b*3])+m[4+axis]*(shape[a*3+1]-shape[b*3+1])+m[8+axis]*(shape[a*3+2]-shape[b*3+2]));
    const norm=gradient.reduce((s,v)=>s+v*v,0);
    // If the tracked neutral itself lies just outside the range, include it;
    // zero remains a feasible fallback for every frame and head pose.
    return {base,gradient,norm,lo:Math.min(lo,base),hi:Math.max(hi,base)};
  });
  for(let round=0;round<16;round++){
    let residual=0;
    for(const c of constraints){
      const value=c.base+c.gradient.reduce((s,v,k)=>s+v*result[k],0);
      const target=Math.max(c.lo,Math.min(c.hi,value)),delta=target-value;
      residual=Math.max(residual,Math.abs(delta));
      if(Math.abs(delta)>.001&&c.norm>1e-8)for(let k=0;k<6;k++)result[k]+=delta*c.gradient[k]/c.norm;
    }
    if(residual<.01)break;
  }
  // Bound any tiny remaining residual without accumulating frame-to-frame drift.
  let scale=1;
  for(const c of constraints){
    const d=c.gradient.reduce((s,v,k)=>s+v*result[k],0);
    if(d>0)scale=Math.min(scale,(c.hi-c.base)/d);
    else if(d<0)scale=Math.min(scale,(c.lo-c.base)/d);
  }
  scale=Math.max(0,Math.min(1,scale));
  return result.map(v=>v*scale);
}
