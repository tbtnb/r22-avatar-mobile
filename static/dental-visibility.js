// Cheek and lip occlusion for the neural prompt and the display layers.
// The display renderer adapts its upper crown height and span separately.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
export function dentalVisibility(neutral,opening,guide=null){
  const dx=neutral.right[0]-neutral.left[0],dy=neutral.right[1]-neutral.left[1],width=Math.max(1,Math.hypot(dx,dy)),axis=[dx/width,dy/width];
  const positions=[];for(let i=0;i<opening.length;i+=2)positions.push(opening[i]*axis[0]+opening[i+1]*axis[1]);
  const lo=Math.min(...positions),hi=Math.max(...positions),half=Math.max(0,(hi-lo)/2);
  const upper=neutral.upperTarget,lower=neutral.lowerTarget;
  const aperture=Math.abs((lower[1]-upper[1])*axis[0]-(lower[0]-upper[0])*axis[1])/width;
  const narrow=1-smooth(.055,.20,aperture),round=clamp((guide?.[0]||0)*(guide?.[5]||0),0,1),seal=clamp(guide?.[2]||0,0,1);
  const phoneticLimit=clamp(guide?.toothLimit??1,.65,1);
  const ratio=clamp((.82-.18*narrow-.12*round)*phoneticLimit,.36,.82);
  return {window:new Float32Array([axis[0],axis[1],(lo+hi)/2,half*ratio]),softness:Math.max(.65,width*.018),gate:smooth(.025,.060,aperture)*(1-seal),aperture,spanRatio:ratio};
}
export function dentalCoverage(visibility,x,y){
  const [dx,dy,center,half]=visibility.window,d=Math.abs(x*dx+y*dy-center);
  if(half<=.0001||visibility.gate<=0)return 0;
  return (1-smooth(Math.max(0,half-visibility.softness),half,d))*visibility.gate;
}
