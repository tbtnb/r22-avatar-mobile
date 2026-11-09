// Extra motion in the personalized face's 3D space, shared by semantic geometry,
// texture flow and the dental occluders. Teeth stay rigid; the jaw carries the
// lower arch, while lips round/roll in front of the upper arch.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a,b)=>a.map((x,k)=>x-b[k]);
const norm=a=>{const n=Math.hypot(...a);return a.map(x=>x/Math.max(n,1e-8));};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function deformedVertices(pose,vertices,basis){
  const out=new Float64Array(vertices.length/5*3);
  for(let i=0;i<vertices.length/5;i++){
    const type=vertices[i*5+3],index=vertices[i*5+4];
    for(let k=0;k<3;k++)out[i*3+k]=vertices[i*5+k];
    if(type>=0&&type<3){
      for(let b=0;b<6;b++)for(let k=0;k<3;k++)out[i*3+k]+=pose[b]*basis[b][index*3+k];
    }else if(type===4){
      out[i*3+1]+=(pose[0]+pose[1])/3+6;
      out[i*3+2]+=Math.max((pose[0]+pose[1])/3.9,0);
    }
  }
  return out;
}

export function articulationRig(avatar){
  const v=avatar.vertices,ix=avatar.mouthIndices;
  const at=i=>v.slice(i*5,i*5+3);
  const x=norm(sub(at(ix.right),at(ix.left)));
  const down=sub(at(ix.lowerOuter),at(ix.upperOuter));
  const y=norm(down.map((a,k)=>a-dot(down,x)*x[k]));
  const z=norm(cross(x,y));
  const width=Math.hypot(...sub(at(ix.right),at(ix.left)));
  const center=at(ix.upperInner).map((a,k)=>(a+at(ix.lowerInner)[k])/2);
  const local=p=>{const d=sub(p,center);return [dot(d,x),dot(d,y),dot(d,z)];};
  const lipMid=local(at(ix.lowerInner))[1];
  const inner=new Set([...avatar.lipContours.upper.slice(11),...avatar.lipContours.lower.slice(11)]);
  const curve=ids=>ids.map(id=>local(at(id))).sort((a,b)=>a[0]-b[0]);
  const atX=(points,x)=>{
    if(x<=points[0][0])return points[0][1];
    for(let i=1;i<points.length;i++)if(x<=points[i][0]){
      const t=(x-points[i-1][0])/Math.max(1e-6,points[i][0]-points[i-1][0]);
      return points[i-1][1]*(1-t)+points[i][1]*t;
    }
    return points.at(-1)[1];
  };
  const curves={};
  for(const key of ['upper','lower'])curves[key]=[curve(avatar.lipContours[key].slice(0,11)),curve(avatar.lipContours[key].slice(11))];
  const lipRows=new Float32Array(v.length/5);
  for(let i=0;i<lipRows.length;i++){
    const type=v[i*5+3];if(type!==2&&!(type>2&&type<2.1))continue;
    const key=type===2?'upper':'lower',p=local(at(i));
    const outer=atX(curves[key][0],p[0]),inside=atX(curves[key][1],p[0]);
    lipRows[i]=inner.has(v[i*5+4])?1:clamp((p[1]-outer)/(Math.abs(inside-outer)>.001?inside-outer:.001),0,1);
  }
  const upperThickness=Math.abs(local(at(ix.upperInner))[1]-local(at(ix.upperOuter))[1]);
  const lowerThickness=Math.abs(local(at(ix.lowerOuter))[1]-local(at(ix.lowerInner))[1]);
  return {x,y,z,width,center,local,lipMid,inner,ix,vertices:v,lipRows,upperThickness,lowerThickness,
          openingLeft:avatar.lipContours.upper[11],openingRight:avatar.lipContours.upper.at(-1)};
}

export function articulate3D(rig,pose,basis,guide,offsets=new Float32Array(rig.vertices.length/5*3)){
  offsets.fill(0);
  if(!guide||guide.length!==6||guide.some(v=>!Number.isFinite(v)))return offsets;
  const [r,s,seal0,bite0,opening0,weight0]=guide.map(v=>clamp(v,0,1));
  const weight=Math.max(weight0,seal0*.8,bite0*.7);
  if(weight<.0001)return offsets;
  const seal=seal0,bite=bite0;
  // Small closing apertures cannot support the same pucker as an open vowel.
  // Keep the contraction bounded and ease it away during bilabial closure.
  const round=r*weight*.86*(1-.65*seal)*(1-.45*bite),spread=s*weight;
  const {vertices:v,width:w,x:ex,y:ey,z:ez,center,local,ix,inner}=rig;
  const deformed=deformedVertices(pose,v,basis);
  const at=i=>Array.from(deformed.slice(i*3,i*3+3));
  const upper=local(at(ix.upperInner)),lower=local(at(ix.lowerInner));
  const gap=Math.max(.002*w,lower[1]-upper[1]);
  const upperLift=w*.008*opening0*weight*(1-seal);
  // Absolute aperture distinguishes vowels even when the six learned channels
  // happen to predict the same jaw opening. The neural detail path is unchanged.
  let target=w*(.045+.345*opening0);
  target=gap*(1-weight)+target*weight;
  target=target*(1-.98*seal)+w*.004*(.98*seal);
  target=target*(1-.65*bite)+w*.020*(.65*bite);
  target*=1-.10*round*(1-seal)*(1-bite);
  target=clamp(target,w*.003,w*.40);
  const hingeY=-w*.55,hingeZ=Math.max(w*1.20,lower[2]+w*.90);
  const py=lower[1]-hingeY,pz=lower[2]-hingeZ;
  const wanted=target-gap-upperLift;
  let angle=clamp(wanted/Math.max(w*.2,-pz),-.30,.45);
  for(let k=0;k<4;k++){
    const f=py*(Math.cos(angle)-1)-pz*Math.sin(angle)-wanted;
    const derivative=-py*Math.sin(angle)-pz*Math.cos(angle);
    if(Math.abs(derivative)>w*.04)angle=clamp(angle-f/derivative,-.30,.45);
  }
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const closeCenter=(upper[1]+lower[1])/2;
  const lowerJawDelta=py*(cos-1)-pz*sin;
  const roundCenter=(upper[1]-upperLift+lower[1]+lowerJawDelta)/2+w*.005*round;
  const actualGap=lower[1]+lowerJawDelta-upper[1]+upperLift;
  // Roll a small amount of the upper inner rim over the rigid crowns as the
  // aperture shrinks. Clamp by the remaining gap so closure cannot invert it.
  const ordinaryCover=w*.015*(1-smooth(w*.14,w*.27,actualGap));
  const phoneticCover=w*.05*(1-clamp(guide.toothLimit??1,.65,1));
  const upperCover=Math.min(w*.030,Math.max(0,actualGap)*.30,ordinaryCover+phoneticCover)*(1-seal);
  const outerHalf=Math.max(Math.abs(local(at(ix.left))[0]),Math.abs(local(at(ix.right))[0]));
  const innerHalf=Math.max(...[rig.openingLeft,rig.openingRight].filter(Number.isInteger).map(id=>Math.abs(local(at(id))[0])),outerHalf*.82);
  const cornerY=(local(at(ix.left))[1]+local(at(ix.right))[1])/2;
  for(let i=0;i<v.length/5;i++){
    const type=v[i*5+3],id=v[i*5+4];
    if(type===-1||type===3)continue; // crop boundary and skull-fixed upper teeth
    const p=at(i),q=local(p),[x,y,z]=q;
    const horizontal=1-smooth(w*.54,w*.95,Math.abs(x));
    const neighborhood=horizontal*(1-smooth(w*.37,w*.88,Math.abs(y)));
    const upperLip=type===2,lowerLip=type>2&&type<2.1,lip=upperLip||lowerLip;
    const jawWeight=type===4?1:lowerLip?1:upperLip?0:smooth(-w*.015,w*.27,y)*neighborhood;
    let dx=0,dy=((y-hingeY)*(cos-1)-(z-hingeZ)*sin)*jawWeight;
    let dz=((y-hingeY)*sin+(z-hingeZ)*(cos-1))*jawWeight;
    if(upperLip)dy-=upperLift;
    else if(type===0&&y<0)dy-=upperLift*neighborhood*.28;
    if(type!==4){
      const rim=lip?rig.lipRows[i]:0;
      // Use one continuous contraction field across the lip annulus and its
      // neighboring skin. Independently squeezing inner/outer rings stretches
      // the vermilion and can turn small rounded apertures inside out.
      const field=lip?1:horizontal*(1-smooth(w*.08,w*.52,Math.abs(y)));
      const contraction=.34-.08*opening0;
      dx=x*(-contraction*round*field+.055*spread*(lip?1:neighborhood));
      const roll=field*(1-smooth(w*.35,w*.70,Math.abs(x)));
      dz-=w*round*.070*roll;
      // Round the corners through a shared smooth field while retaining each
      // person's lip contour/thickness, instead of imposing two separate arcs.
      const cornerInfluence=Math.exp(-(((Math.abs(x)/w-.46)/.25)**2))*field;
      dy+=(roundCenter-cornerY)*round*cornerInfluence;
      if(lip){
        const half=(outerHalf*(1-rim)+innerHalf*rim)*(1-contraction*round+.055*spread);
        const arc=Math.sqrt(Math.max(0,1-Math.min(1,Math.abs(x+dx)/half)**2));
        const thickness=(upperLip?rig.upperThickness:rig.lowerThickness)*(1-rim)*.85;
        const roundedY=roundCenter+(upperLip?-1:1)*(actualGap*.5+thickness)*arc;
        // Corners stay on the continuous field. Independent arc fitting there
        // can reverse tiny triangles as the upper/lower inner rims meet.
        const shaping=round*.6*(1-smooth(w*.25,w*.44,Math.abs(x)));
        dy=dy*(1-shaping)+(roundedY-y)*shaping;
      }
      if(lip&&seal>.001){
        const movedY=y+dy;
        const boundary=upperLip?closeCenter-w*.002:closeCenter+w*.002;
        const centerWeight=1-smooth(w*.25,w*.52,Math.abs(x));
        if(inner.has(id))dy+=(boundary-movedY)*seal*centerWeight*.85;
      }
      if(upperLip)dy+=upperCover*rim*(1-smooth(w*.18,w*.36,Math.abs(x)));
    }
    if(type===-2){dx*=.7;dz*=.7;}
    for(let k=0;k<3;k++)offsets[i*3+k]=ex[k]*dx+ey[k]*dy+ez[k]*dz;
  }
  return offsets;
}
