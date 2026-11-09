// Head-pose projection of the personalized neutral face. These proportions do
// not follow the source video's current phoneme; tracked source lips remain
// available separately for inverse texture warping and color sampling.
export function neutralMouthMetrics(frame,vertices,ix){
  const m=frame.points;
  const point=id=>[0,1].map(axis=>m[axis]*vertices[id*5]+m[4+axis]*vertices[id*5+1]+m[8+axis]*vertices[id*5+2]+m[12+axis]);
  const left=point(ix.left),right=point(ix.right),upperInner=point(ix.upperInner),lowerInner=point(ix.lowerInner);
  const upperOuter=point(ix.upperOuter),lowerOuter=point(ix.lowerOuter);
  return {left,right,upperInner,lowerInner,upperOuter,lowerOuter,
    width:Math.max(1,Math.hypot(right[0]-left[0],right[1]-left[1])),
    widthX:Math.max(20,Math.abs(right[0]-left[0])),
    upper:Math.max(2,Math.abs(upperInner[1]-upperOuter[1])),
    lower:Math.max(2,Math.abs(lowerOuter[1]-lowerInner[1])),
    center:[(upperInner[0]+lowerInner[0])/2,(upperInner[1]+lowerInner[1])/2]};
}

export function lipApertureRatio(neutral,upper,lower){
  const dx=neutral.right[0]-neutral.left[0],dy=neutral.right[1]-neutral.left[1];
  return Math.abs((lower[1]-upper[1])*dx-(lower[0]-upper[0])*dy)/Math.max(1,dx*dx+dy*dy);
}
