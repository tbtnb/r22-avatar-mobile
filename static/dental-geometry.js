import {articulationRig} from './articulation.js?v=tongue-coarticulation-r17';

// Fit the existing upper dental arch to a personalized neutral face.
// This changes the semantic geometry supplied to DINet, not tooth pixels.
// Coordinates are avatar-local; the rule is independent of video size/person.
export function alignDentalMesh(avatar) {
  const out=structuredClone(avatar), vertices=out.vertices, ix=out.mouthIndices;
  if(!ix)throw new Error('Dental alignment requires mouth landmarks');
  const rig=articulationRig(avatar),width=rig.width;
  const local=i=>rig.local(vertices.slice(i,i+3));
  const lip=rig.local(vertices.slice(ix.upperInner*5,ix.upperInner*5+3));
  if(!Number.isFinite(width)||width<1)throw new Error('Invalid mouth width');
  const upper=[],front=[];let tip=-Infinity;
  for(let i=0;i<vertices.length;i+=5){
    if(vertices[i+3]!==3)continue;
    upper.push(i);
    const p=local(i);if(Math.abs(p[0]-lip[0])<width*.16){tip=Math.max(tip,p[1]);front.push(p);}
  }
  if(!upper.length||!Number.isFinite(tip))throw new Error('Upper dental arch is missing');
  // Work in the mouth's orthonormal frame: raising/recessing the arch must not
  // drift when alignment is called twice or when the avatar turns its head.
  const desired=lip[1]+width*.078;
  const shift=Math.max(-width*.10,Math.min(width*.10,desired-tip));
  const depth=front.reduce((sum,p)=>sum+p[2],0)/front.length;
  const depthShift=Math.max(0,Math.min(width*.08,lip[2]+width*.15-depth));
  const xs=upper.map(i=>local(i)[0]),center=(Math.min(...xs)+Math.max(...xs))/2;
  const span=Math.max(...xs)-Math.min(...xs),widthScale=Math.min(1,width*.79/Math.max(span,1e-8));
  for(const i of upper){
    const dx=(local(i)[0]-center)*(widthScale-1);
    for(let k=0;k<3;k++)vertices[i+k]+=rig.x[k]*dx+rig.y[k]*shift+rig.z[k]*depthShift;
  }
  out.dentalAlignment={version:3,upperShift:shift,depthShift,widthScale,mouthWidth:width,source:'neutral mouth frame; rigid skull attachment'};
  return out;
}
