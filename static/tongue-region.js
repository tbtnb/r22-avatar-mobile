// Conservative tongue support in oral coordinates. It never changes lip geometry.
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
export const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const luminance=c=>c[0]*.2126+c[1]*.7152+c[2]*.0722;

export function oralFrame(opening){
  if(opening?.length!==40||!Array.from(opening).every(Number.isFinite))return null;
  const p=Array.from({length:20},(_,i)=>[opening[i*2],opening[i*2+1]]);
  // The ordered inner rim starts at one commissure and reaches the other at
  // index 10. Fixed anatomical anchors avoid axis jumps on round openings.
  let left=p[0],right=p[10];
  if(left[0]>right[0])[left,right]=[right,left];
  const width=Math.hypot(right[0]-left[0],right[1]-left[1]);if(width<2||(right[0]-left[0])/width<.55)return null;
  const axis=[(right[0]-left[0])/width,(right[1]-left[1])/width],normal=[-axis[1],axis[0]];
  const polygon=p.map(v=>[v[0]*axis[0]+v[1]*axis[1],v[0]*normal[0]+v[1]*normal[1]]);
  const min=Math.min(...polygon.map(v=>v[0])),max=Math.max(...polygon.map(v=>v[0]));
  return {axis,normal,polygon,left:min,right:max,center:(min+max)/2,width:max-min,
    bounds:[Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))]};
}

export function oralSlice(frame,u){
  let top=Infinity,bottom=-Infinity;
  for(let i=0,j=19;i<20;j=i++){
    const a=frame.polygon[i],b=frame.polygon[j];
    if(Math.abs(a[0]-b[0])<1e-7||u<Math.min(a[0],b[0])||u>Math.max(a[0],b[0]))continue;
    const v=a[1]+(u-a[0])*(b[1]-a[1])/(b[0]-a[0]);top=Math.min(top,v);bottom=Math.max(bottom,v);
  }
  return Number.isFinite(top)&&bottom>top?[top,bottom]:null;
}

export function tongueCoordinates(frame,x,y){
  const u=x*frame.axis[0]+y*frame.axis[1],v=x*frame.normal[0]+y*frame.normal[1],slice=oralSlice(frame,u);
  if(!slice)return null;
  return {x:(u-frame.center)/(frame.width*.5),t:(v-slice[0])/(slice[1]-slice[0]),gap:slice[1]-slice[0]};
}

export function tongueWeight(position,seal=0){
  if(!position||seal>=.98)return 0;
  const {x,t,gap}=position;if(t<=0||t>=1||Math.abs(x)>=.89)return 0;
  const start=.42+.25*x*x;
  return smooth(start,start+.12,t)*(1-smooth(.82,1,t))*(1-smooth(.60,.89,Math.abs(x)))
    *smooth(4,11,gap)*(1-clamp(seal));
}

function trimmedColor(colors,lo=.3,hi=.8){
  if(colors.length<4)return null;
  colors.sort((a,b)=>luminance(a)-luminance(b));
  const selection=colors.slice(Math.floor(colors.length*lo),Math.max(1,Math.ceil(colors.length*hi)));
  return [0,1,2].map(c=>selection.reduce((sum,p)=>sum+p[c],0)/selection.length);
}

export class TongueSurfaceState{
  reset(){this.tone=null;this.confidence=0;this.active=false;}
  constructor(){this.reset();}
  update(opening,rgba,prompt,seal=0){
    this.active=false;const frame=oralFrame(opening);if(!frame)return null;
    const mid=oralSlice(frame,frame.center);if(!mid)return null;
    const gate=smooth(.075,.18,(mid[1]-mid[0])/frame.width)*(1-clamp(seal));
    if(gate<.005)return null;
    const tissue=[],lip=[];const [x0,y0,x1,y1]=frame.bounds;
    // Tone estimation needs sparse robust samples, not a second full raster pass.
    for(let y=Math.max(0,Math.floor(y0)-3);y<Math.min(184,Math.ceil(y1)+8);y+=2){
      for(let x=Math.max(0,Math.floor(x0)-2);x<Math.min(184,Math.ceil(x1)+2);x+=2){
        const at=(y*184+x)*4,c=[rgba[at]/255,rgba[at+1]/255,rgba[at+2]/255];
        if(prompt[at]>.3*255&&prompt[at+1]<25&&prompt[at+2]<25&&y>(y0+y1)*.5&&luminance(c)>.12)lip.push(c);
        const position=tongueCoordinates(frame,x+.5,y+.5);
        if(tongueWeight(position)>.35&&prompt[at+1]<200&&c[0]>.15&&c[0]>c[1]*1.04&&c[0]>c[2]*.98)tissue.push(c);
      }
    }
    const observed=trimmedColor(tissue,.5,.9);
    // No tongue evidence means no replacement. A uniformly dark cavity stays dark.
    if(!observed)return null;
    const lipColor=trimmedColor(lip),confidence=smooth(3,10,tissue.length)*smooth(.12,.22,luminance(observed));
    if(confidence<.005)return null;
    const target=observed.map((v,c)=>clamp(lipColor?.[c] ? .35*v+.65*lipColor[c]*[.75,.72,.76][c] : v,.12,.65));
    target[1]=Math.max(target[1],target[0]/1.85);target[2]=clamp(target[2],target[0]*.58,target[0]*.98);
    this.tone=this.tone?this.tone.map((v,c)=>v*.85+target[c]*.15):target;
    this.confidence=confidence;this.active=true;
    return {frame,tone:this.tone,gate:gate*confidence,tissuePixels:tissue.length};
  }
}
