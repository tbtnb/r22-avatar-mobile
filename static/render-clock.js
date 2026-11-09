// A visible embedded preview can have its compositor callbacks throttled when
// the host window is occluded. Wake the same single-flight render scheduler;
// drawing and inference remain on their existing paths.
let timer=null,waiting=false;
self.onmessage=({data})=>{
  if(data==='ack'){waiting=false;return;}
  clearInterval(timer);timer=null;
  waiting=false;
  if(data==='start')timer=setInterval(()=>{if(!waiting){waiting=true;self.postMessage(0);}},40);
};
