import {assetURL} from './asset-url.js';
import {BrowserRuntime} from './wasm/browser-runtime.js?v=wasm-r22';
import {MouthGeometry} from './geometry.js?v=tongue-coarticulation-r17';
import {alignDentalMesh} from './dental-geometry.js?v=tongue-coarticulation-r17';
import {DentalTextureRenderer} from './dental-texture.js?v=upper-crown-r22';
import {MouthEdgeBlend} from './mouth-edge-blend.js?v=lip-edge-r15';
import {TongueSurfaceRenderer} from './tongue-surface.js?v=dental-occlusion-r21';
import {neutralMouthMetrics} from './frame-metrics.js?v=stability-r9c';
import {FrameCapture} from './frame-capture.js?v=ios-rgba-guard';
const $=id=>document.getElementById(id);
const runtimeOptions=new URLSearchParams(location.search);
const useSoftware=runtimeOptions.get('raster')!=='gpu',useDecoderCopy=runtimeOptions.get('capture')!=='canvas';
const appleMobile=/iPhone|iPad|iPod/i.test(navigator.userAgent)||
  (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
// Freeze the video in a canvas on iOS. Its hardware-decoder copy path can
// return planar bytes despite a packed RGB request.
const useVideoFrame=typeof VideoFrame==='function'&&!appleMobile;
const syncDecoded=!['raf','independent'].includes(runtimeOptions.get('clock'));
const useWasm=document.documentElement.dataset.runtime==='wasm';
let browserRuntime=null;
const output=$('output'),ctx=output.getContext('2d',{alpha:true,colorSpace:'srgb'});
const zoom=$('zoom'),zoomCtx=zoom.getContext('2d',{alpha:false,colorSpace:'srgb'});
const video=$('base-video');
video.muted=true;video.loop=true;video.playsInline=true;video.preload='auto';
// The decoded video keeps playing while inference is pending. Capture once and
// display that exact frame under its completed mouth, never the newer video.
const processingFrame=document.createElement('canvas');processingFrame.id='processing-base-frame';
const processingCtx=processingFrame.getContext('2d',{colorSpace:'srgb'});
const coherentBase=$('coherent-base'),baseCtx=coherentBase.getContext('2d',{alpha:false,colorSpace:'srgb'});
const crop=document.createElement('canvas');crop.width=crop.height=184;
const cropCtx=crop.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'});
const frameCapture=new FrameCapture();
const frameCode=document.createElement('canvas');frameCode.width=frameCode.height=2;
const codeCtx=frameCode.getContext('2d',{willReadFrequently:true});
const geometry=new MouthGeometry();
const detailGeometry=new MouthGeometry();
const dentalRenderer=new DentalTextureRenderer();
const mouthEdgeBlend=new MouthEdgeBlend();
const tongueSurface=new TongueSurfaceRenderer();
const neuralOutput=document.createElement('canvas');neuralOutput.width=neuralOutput.height=184;
const neuralOutputCtx=neuralOutput.getContext('2d');
let avatar,active=null,lastClip=null,audioContext=null,source=null,generation=0,loadingSpeech=false;
let requestController=null,busy=false,lastTick=0,ready=false,renderFailures=0,renderSuspended=false;
let neutralTransition=null;
let offsetMs=0,gain=1,framesInSecond=0,lastFpsTime=0;
let library=[],currentItem=null,canDrive=false,switching=false,decodedTime=0,lastDecodedAt=0;
let pendingSnapshot=null;
function clearPendingSnapshot(){pendingSnapshot?.frame.close();pendingSnapshot=null;}
if(video.requestVideoFrameCallback){
  const onFrame=(now,metadata)=>{
    video.requestVideoFrameCallback(onFrame);
    decodedTime=metadata.mediaTime;
    lastDecodedAt=performance.now();
    if(ready&&(!useVideoFrame||syncDecoded)){
      if(!busy)draw(now,metadata.mediaTime);
      else if(useVideoFrame&&canDrive&&!document.hidden){
        // Keep only the latest decoded frame while one inference is in flight.
        // Start it immediately on completion, rather than losing a 33ms decoder
        // callback and waiting another full frame interval.
        clearPendingSnapshot();pendingSnapshot={frame:new VideoFrame(video),id:currentItem.id};
      }else stats.skippedFrames++;
    }
  };
  video.requestVideoFrameCallback(onFrame);
}
const stats={engine:useWasm?'browser-onnx-wasm':'independent-onnx',renderedFrames:0,skippedFrames:0,lastInferenceMs:0,lastRoundTripMs:0,audioFrame:0,baseFrame:0,errors:[],playing:false,renderSamples:[]};
window.avatarDiagnostics=stats;

function status(text,error=false){$('speech-status').textContent=text;$('speech-status').classList.toggle('error',error);}
function controls(){
  $('speak').disabled=!ready||!canDrive||loadingSpeech||(!useWasm&&!$('text').value.trim());
  $('choose-audio').disabled=!ready||!canDrive||loadingSpeech;
  $('replay').disabled=!ready||!canDrive||!lastClip||loadingSpeech;
  $('stop').disabled=!loadingSpeech&&!active;
}
function stop({cancelRequest=true,announce=true}={}){
  // Stopping speech changes the drive input, never the image presentation path.
  if(active)neutralTransition={pose:samplePose(),guide:sampleArticulation(),start:performance.now()};
  generation++;
  if(cancelRequest){requestController?.abort();requestController=null;loadingSpeech=false;}
  if(source){source.onended=null;try{source.stop();}catch{}source.disconnect();source=null;}
  active=null;stats.playing=false;
  $('play-label').textContent='待机';
  if(announce)status('朗读已停止，继续保持待机口型。');controls();
}
function getAudioContext(){audioContext??=new AudioContext();return audioContext;}
async function decode(payload){
  const bytes=Uint8Array.from(atob(payload.audio),c=>c.charCodeAt(0));
  const buffer=await getAudioContext().decodeAudioData(bytes.buffer);
  if(!Array.isArray(payload.poses)||!payload.poses.length||payload.poses.some(p=>p.length!==6||p.some(x=>!Number.isFinite(x))))throw new Error('口型数据无效');
  const articulation=payload.articulation;
  if(articulation&&(!Array.isArray(articulation.values)||articulation.values.length!==payload.poses.length||articulation.values.some(p=>p.length!==6||p.some(x=>!Number.isFinite(x)))))throw new Error('发音动作数据无效');
  if(articulation?.dental&&(!Array.isArray(articulation.dental.values)||articulation.dental.values.length!==payload.poses.length||articulation.dental.values.some(x=>!Number.isFinite(x)||x<0||x>1)))throw new Error('牙齿遮挡控制无效');
  stats.articulationSource=articulation?.source||'unavailable';
  return {buffer,poses:payload.poses,fps:payload.fps,articulation};
}
async function play(clip){
  if(!ready||!canDrive)return;
  stop({cancelRequest:false,announce:false});
  const token=generation;
  await getAudioContext().resume();
  if(token!==generation)return;
  const node=audioContext.createBufferSource();node.buffer=clip.buffer;node.connect(audioContext.destination);
  // Optional local recording hook is created only by the developer validation page.
  if(window.avatarRecordingDestination)node.connect(window.avatarRecordingDestination);
  const start=audioContext.currentTime+.12;
  active={...clip,start,token};neutralTransition=null;source=node;stats.playing=true;
  node.onended=()=>{if(token!==generation)return;generation++;node.disconnect();source=null;active=null;stats.playing=false;$('play-label').textContent='待机';status('朗读结束，继续保持待机口型。');controls();};
  node.start(start);$('play-label').textContent='正在朗读';status('正在朗读');controls();
}
async function localAudioClip(file,signal){
  if(file&&file.size>64*1024*1024)throw new Error('请选择小于 64 MB 的音频');
  const load=async url=>{
    const response=await fetch(assetURL(url),{signal});
    if(!response.ok)throw new Error('示例语音加载失败');
    return response;
  };
  const bytes=file?await file.arrayBuffer():await (await load('/static/wasm/demo.wav')).arrayBuffer();
  const buffer=await getAudioContext().decodeAudioData(bytes.slice(0));
  if(buffer.duration>120||!buffer.length)throw new Error('请选择 120 秒以内的音频');
  const analysis=await new OfflineAudioContext(1,1,16000).decodeAudioData(bytes);
  if(signal.aborted)throw signal.reason;
  const {poses,fps}=await browserRuntime.animate(analysis);
  const articulation=file?null:await (await load('/static/wasm/demo-articulation.json')).json();
  if(articulation&&articulation.values.length!==poses.length)throw new Error('示例口型与语音长度不一致');
  stats.articulationSource=articulation?.source||'audio-model';
  return {buffer,poses,fps,articulation};
}
async function speak(file=null){
  const text=$('text').value.trim();if(!ready||!canDrive||(!useWasm&&!text)||loadingSpeech)return;
  stop({announce:false});await getAudioContext().resume();
  const token=generation;
  loadingSpeech=true;requestController=new AbortController();status('正在生成本地语音与口型…');controls();
  try{
    const signal=requestController.signal;
    let clip;
    if(useWasm)clip=await localAudioClip(file,signal);
    else{
      const response=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal});
      if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.detail||'语音生成失败');}
      clip=await decode(await response.json());
    }
    if(token!==generation)return;
    lastClip=clip;loadingSpeech=false;requestController=null;await play(clip);
  }catch(error){if(token===generation&&error.name!=='AbortError')status(error.message,true);}
  finally{if(token===generation){loadingSpeech=false;requestController=null;controls();}}
}
function samplePose(){
  if(!active){
    if(!neutralTransition)return [0,0,0,0,0,0];
    const t=Math.min(1,(performance.now()-neutralTransition.start)/120),weight=1-t*t*(3-2*t);
    if(t>=1){neutralTransition=null;return [0,0,0,0,0,0];}
    return neutralTransition.pose.map(x=>x*weight);
  }
  const elapsed=audioContext.currentTime-active.start;
  const anticipating=$('articulation').value==='enhanced'&&active.articulation?.source!=='unavailable'&&active.articulation;
  if((elapsed<0&&!anticipating)||elapsed<-.12||elapsed>=active.buffer.duration)return [0,0,0,0,0,0];
  const position=Math.max(0,(elapsed+offsetMs/1000)*active.fps);
  const index=Math.max(0,Math.min(Math.floor(position),active.poses.length-1));
  const next=Math.min(index+1,active.poses.length-1),mix=Math.max(0,Math.min(1,position-index));
  stats.audioFrame=position;
  const t=Math.max(0,Math.min(1,(elapsed+(anticipating ? .12 : 0))/.12,(active.buffer.duration-elapsed)/.12));
  const weight=t*t*(3-2*t);
  return active.poses[index].map((x,k)=>(x*(1-mix)+active.poses[next][k]*mix)*gain*weight);
}
const idleGuide=[0,0,1,0,0,1];
function blendFromIdle(guide,weight){
  const out=idleGuide.map((idle,k)=>idle*(1-weight)+(guide?.[k]||0)*weight);
  out.toothLimit=1-(1-(guide?.toothLimit??1))*weight;return out;
}
function sampleArticulation(){
  // The personalized zero pose can contain a smile/opening. Seal the lips at
  // rest in every appearance/action mode, using the same neural/flow pipeline.
  if(!active){
    if(!neutralTransition)return idleGuide;
    const t=Math.min(1,(performance.now()-neutralTransition.start)/120);
    return blendFromIdle(neutralTransition.guide,1-t*t*(3-2*t));
  }
  const elapsed=audioContext.currentTime-active.start;
  const enhanced=$('articulation').value==='enhanced'&&active.articulation?.source!=='unavailable'&&active.articulation;
  let guide=null;
  if(enhanced){
    const values=active.articulation.values,position=(elapsed+offsetMs/1000)*active.fps;
    if(position>=-.12*active.fps&&position<values.length){
      const i=Math.max(0,Math.floor(position)),j=Math.min(i+1,values.length-1),mix=Math.max(0,position-i);
      guide=values[i].map((x,k)=>x*(1-mix)+values[j][k]*mix);
      guide[4]=Math.min(1,guide[4]*gain);
      const dental=active.articulation.dental?.values;
      if(dental)guide.toothLimit=dental[i]*(1-mix)+dental[j]*mix;
    }
  }
  const t=Math.max(0,Math.min(1,(elapsed+(enhanced ? .12 : 0))/.12,(active.buffer.duration-elapsed)/.12));
  return blendFromIdle(guide,t*t*(3-2*t));
}
function frameIndex(mediaTime=decodedTime,frameSource=video){
  if(avatar.playback==='forward'){
    const index=Math.max(0,Math.min(avatar.frames.length-1,Math.round((video.requestVideoFrameCallback?mediaTime:video.currentTime)*avatar.fps)));
    stats.baseFrame=index;return index;
  }
  codeCtx.drawImage(frameSource,video.videoWidth-2,0,2,2,0,0,2,2);
  const p=codeCtx.getImageData(0,0,2,2).data;
  const exact=(p[0]>128?2:0)+(p[4]>128?1:0)+(p[8]>128?8:0)+(p[12]>128?4:0);
  const rough=Math.floor((video.requestVideoFrameCallback?mediaTime:video.currentTime)*avatar.fps);
  let selected=rough;
  for(let delta=-7;delta<=7;delta++)if(rough+delta>=0&&(rough+delta)%16===exact){selected=rough+delta;break;}
  selected=Math.min(selected,avatar.frames.length*2-1);
  stats.baseFrame=selected;
  return selected<avatar.frames.length?selected:avatar.frames.length*2-selected-1;
}
function drawZoom(frame,speaking=false,frameSource=video){
  // Default includes cheeks/chin so the surrounding expression remains visible.
  const close=$('zoom-view').value==='mouth';
  const height=close?260:328;if(zoom.height!==height)zoom.height=height;
  const rect=frame.rect;
  const [x0,y0,x1,y1]=rect,w=x1-x0,h=y1-y0;
  const neutral=neutralMouthMetrics(frame,avatar.vertices,avatar.mouthIndices);
  const localWidth=neutral.width*(close?1.43:2.0),localHeight=localWidth*(close?5/7:.89);
  const cx=neutral.center[0],cy=neutral.center[1]+neutral.width*(close ? .10 : .08);
  const sx=x0+(cx-localWidth/2)/184*w,sy=y0+(cy-localHeight/2)/184*h;
  const sw=localWidth/184*w,sh=localHeight/184*h;
  zoomCtx.clearRect(0,0,zoom.width,zoom.height);
  zoomCtx.drawImage(frameSource,sx,sy,sw,sh,0,0,zoom.width,zoom.height);
  if(speaking){zoomCtx.globalAlpha=Number(output.style.opacity||1);zoomCtx.drawImage(output,(sx-x0)/w*output.width,(sy-y0)/h*output.height,sw/w*output.width,sh/h*output.height,0,0,zoom.width,zoom.height);zoomCtx.globalAlpha=1;}
  stats.zoomView={center:[cx,cy],width:localWidth,height:localHeight};
}
function countFrame(now){
  if(!lastFpsTime)lastFpsTime=now;
  framesInSecond++;
  if(now-lastFpsTime>=1000){stats.displayFps=Math.round(framesInSecond*1000/(now-lastFpsTime));$('fps-label').textContent=stats.displayFps+' fps';framesInSecond=0;lastFpsTime=now;}
}
function resetFrameCounter(label){framesInSecond=0;lastFpsTime=0;stats.displayFps=0;$('fps-label').textContent=label;}
async function draw(now,mediaTime=decodedTime,providedSnapshot=null){
  if(!ready||renderSuspended||document.hidden||video.readyState<2){providedSnapshot?.close();return;}
  if(!canDrive){providedSnapshot?.close();countFrame(now);return;}
  const pose=samplePose(),token=generation;
  const mode=$('appearance').value;
  stats.appearance=mode;
  const driveState=active?'speaking':neutralTransition?'settling':'idle';
  const frameStarted=performance.now();
  busy=true;
  let snapshot=null;
  try{
    if(coherentBase.width!==video.videoWidth||coherentBase.height!==video.videoHeight){
      coherentBase.width=video.videoWidth;coherentBase.height=video.videoHeight;
    }
    let frameSource;
    if(useVideoFrame){
      snapshot=providedSnapshot||new VideoFrame(video);frameSource=snapshot;
      mediaTime=snapshot.timestamp/1e6;stats.snapshotType='VideoFrame';
    }else{
      if(processingFrame.width!==video.videoWidth||processingFrame.height!==video.videoHeight){processingFrame.width=video.videoWidth;processingFrame.height=video.videoHeight;}
      processingCtx.drawImage(video,0,0,processingFrame.width,processingFrame.height);
      frameSource=processingFrame;stats.snapshotType='canvas';
    }
    const selectedFrame=frameIndex(mediaTime,frameSource),frame=avatar.frames[selectedFrame];
    const [x0,y0,x1,y1]=frame.rect;
    let original=useDecoderCopy&&snapshot?await frameCapture.read(snapshot,frame.rect):null;
    stats.captureBackend=original?'decoder-copy':'canvas';
    if(!original){cropCtx.drawImage(frameSource,x0,y0,x1-x0,y1-y0,0,0,184,184);original=cropCtx.getImageData(0,0,184,184);}
    if(token!==generation||!ready)return;
    const capturedAt=performance.now();
    const activeGeometry=(mode==='detail'||mode==='teeth')?detailGeometry:geometry;
    const conditioned=mode==='baseline'?pose:activeGeometry.condition(frame,pose);
    const guide=sampleArticulation(),articulationMode=$('articulation').value;stats.articulationGuide=guide;stats.articulationMode=articulationMode;
    const payload=new Uint8Array(original.data.length*3);payload.set(original.data);
    if(useSoftware){
      const pair=activeGeometry.renderPair(frame,conditioned,guide);
      payload.set(pair.prompt,original.data.length);payload.set(pair.flow,original.data.length*2);
    }else{
      payload.set(activeGeometry.render(frame,conditioned,0,guide),original.data.length);
      payload.set(activeGeometry.render(frame,conditioned,1,guide),original.data.length*2);
    }
    stats.geometryBackend=useSoftware?'cpu-rasterizer':'webgl-readback';
    const start=performance.now();
    const apiMode=mode==='teeth'?'detail':mode;
    let rgba;
    if(useWasm){
      const result=await browserRuntime.render(payload,apiMode,selectedFrame);
      rgba=result.pixels;
      stats.lastInferenceMs=result.inferenceMs;
    }else{
      const response=await fetch('/api/render?mode='+apiMode+'&frame='+selectedFrame+'&avatar='+encodeURIComponent(currentItem.id),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:payload,signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error('本地渲染服务返回异常');
      rgba=new Uint8ClampedArray(await response.arrayBuffer());
      stats.lastInferenceMs=Number(response.headers.get('X-Inference-Ms'));
    }
    if(rgba.length!==184*184*4)throw new Error('渲染结果尺寸不正确');
    stats.lastRoundTripMs=performance.now()-start;
    const renderSample={captureMs:capturedAt-frameStarted,geometryMs:start-capturedAt,roundTripMs:stats.lastRoundTripMs,inferenceMs:stats.lastInferenceMs};
    stats.renderSamples.push(renderSample);if(stats.renderSamples.length>500)stats.renderSamples.shift();
    if(token!==generation||!ready||!canDrive||$('appearance').value!==mode||$('articulation').value!==articulationMode)return;
    const canvasSize=mode==='teeth'?368:184;
    if(output.width!==canvasSize){output.width=output.height=canvasSize;}
    if(mode==='teeth'){
      const startDental=performance.now();
      neuralOutputCtx.putImageData(new ImageData(rgba,184,184),0,0);
      ctx.clearRect(0,0,368,368);ctx.drawImage(neuralOutput,0,0,368,368);
      const prompt=payload.subarray(original.data.length,original.data.length*2);
      const dental=dentalRenderer.draw(frame,conditioned,rgba,prompt,guide,original.data);
      renderSample.dentalCompositeMs=performance.now()-startDental;
      stats.dentalVisiblePixels=dentalRenderer.visiblePixels;stats.dentalExposure=dentalRenderer.exposure;
      stats.dentalBlurSigma=dentalRenderer.blurSigma;stats.dentalSourceQuality=dentalRenderer.sourceQuality;
      stats.dentalSpanRatio=dentalRenderer.dentalVisibility.spanRatio;stats.dentalAperture=dentalRenderer.openingRatio;
      stats.dentalPhoneticLimit=guide.toothLimit??1;stats.lowerDentalExposure=dentalRenderer.lowerExposure;
      const startTongue=performance.now();
      const visibleDental=dentalRenderer.exposure>.005||dentalRenderer.lowerExposure>.005;
      const oralSurface=tongueSurface.draw(output,rgba,prompt,dentalRenderer.opening,dentalRenderer.blurSigma,
        guide?.[2]||0,visibleDental?dental:null,dentalRenderer.lowerExposure);
      if(oralSurface){ctx.clearRect(0,0,368,368);ctx.drawImage(oralSurface,0,0);}
      renderSample.tongueSurfaceMs=performance.now()-startTongue;
      stats.tongueSurface=tongueSurface.lastLayout?'local-surface-reconstruction':'occluded-or-no-evidence';
      stats.tongueTissuePixels=tongueSurface.lastLayout?.tissuePixels||0;
      ctx.drawImage(dental,0,0,368,368);
      const startEdge=performance.now();
      const blended=mouthEdgeBlend.draw(output,dentalRenderer.opening,dentalRenderer.outerOpening,dentalRenderer.blurSigma,guide?.[2]||0);
      if(blended){ctx.clearRect(0,0,368,368);ctx.drawImage(blended,0,0);}
      renderSample.edgeBlendMs=performance.now()-startEdge;stats.edgeBlend=blended?'seam-band':'idle-pass-through';
    }else ctx.putImageData(new ImageData(rgba,184,184),0,0);
    output.style.left=x0/video.videoWidth*100+'%';output.style.top=y0/video.videoHeight*100+'%';
    output.style.width=(x1-x0)/video.videoWidth*100+'%';output.style.height=(y1-y0)/video.videoHeight*100+'%';
    // Neutral and audio-driven mouths are always fully composited. Only the
    // coefficients ease in/out, so starting speech never reveals raw video.
    output.style.opacity='1';
    baseCtx.drawImage(frameSource,0,0);coherentBase.style.display='block';
    output.style.display='block';drawZoom(frame,true,frameSource);
    $('loading').hidden=true;$('loading').style.display='none';
    stats.driveState=driveState;stats.drivingPose=Array.from(pose);
    stats.idleFrames=(stats.idleFrames||0)+(driveState==='idle'?1:0);
    stats.speechFrames=(stats.speechFrames||0)+(driveState==='speaking'?1:0);
    stats.continuousComposite=true;
    stats.presentedFrame=selectedFrame;stats.presentedMediaTime=mediaTime;
    stats.framePair={base:selectedFrame,mouth:selectedFrame,mediaTime};
    renderSample.presented=true;renderSample.sourceMediaTime=mediaTime;
    renderSample.totalMs=performance.now()-frameStarted;
    stats.renderedFrames++;renderFailures=0;countFrame(performance.now());
  }catch(error){
    stats.errors.push(error.message);stats.errors=stats.errors.slice(-10);renderFailures++;
    if(renderFailures>=3){renderSuspended=true;stop({announce:false});output.style.display='none';coherentBase.style.display='none';stats.continuousComposite=false;status('渲染服务暂不可用，请重新启动独立版。',true);}
  }finally{
    snapshot?.close();busy=false;
    const next=pendingSnapshot;pendingSnapshot=null;
    if(next){
      if(next.id===currentItem?.id)draw(performance.now(),next.frame.timestamp/1e6,next.frame);
      else next.frame.close();
    }
  }
}
function tick(now){
  requestAnimationFrame(tick);
  scheduleFrame(now);
}
function scheduleFrame(now){
  if(video.requestVideoFrameCallback&&!video.paused&&(!useVideoFrame||(syncDecoded&&performance.now()-lastDecodedAt<120)))return;
  if(now-lastTick<40)return;
  if(busy){stats.skippedFrames++;return;}
  lastTick=now-(now-lastTick)%40;
  draw(now,video.currentTime);
}
stats.scheduler='animation-frame';
if(runtimeOptions.get('clock')!=='raf'&&typeof Worker==='function'){
  try{
    const clock=new Worker(assetURL('/static/render-clock.js?v=performance-r11'));
    clock.onmessage=()=>{scheduleFrame(performance.now());clock.postMessage('ack');};
    clock.onerror=()=>{stats.scheduler='animation-frame';clock.terminate();};
    const updateClock=()=>clock.postMessage(document.hidden?'pause':'start');
    document.addEventListener('visibilitychange',updateClock);updateClock();stats.scheduler=syncDecoded&&video.requestVideoFrameCallback?'video-frame-with-worker-fallback':'worker-and-animation-frame';
    window.addEventListener('pagehide',()=>clock.terminate(),{once:true});
  }catch{stats.scheduler='animation-frame';}
}
$('speak').addEventListener('click',()=>speak());
$('choose-audio').addEventListener('click',()=>$('audio-file').click());
$('audio-file').addEventListener('change',event=>{
  const [file]=event.target.files;
  event.target.value='';
  if(file)speak(file);
});
$('replay').addEventListener('click',()=>{if(lastClip)play(lastClip).catch(e=>status(e.message,true));});
$('stop').addEventListener('click',()=>stop());
$('text').addEventListener('input',()=>{$('count').textContent=$('text').value.length+' / 300';controls();});
$('vowel-example').addEventListener('click',()=>{$('text').value='啊，哦，鹅。衣，乌，迂。阿姨来了，婆婆摸摸宝宝，哥哥喝可乐。';$('count').textContent=$('text').value.length+' / 300';controls();});
$('text').addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();speak();}});
function setTuning(){offsetMs=Number($('offset').value);gain=Number($('gain').value);$('offset-label').textContent=(offsetMs>0?'+':'')+offsetMs+' ms';$('gain-label').textContent=gain.toFixed(2);}
$('offset').addEventListener('input',setTuning);$('gain').addEventListener('input',setTuning);
$('reset').addEventListener('click',()=>{$('offset').value=0;$('gain').value=1;$('appearance').value=useWasm?'teeth':'preserve';setTuning();});
document.addEventListener('visibilitychange',()=>{resetFrameCounter(document.hidden?'预览已暂停':'正在恢复画面…');if(document.hidden){clearPendingSnapshot();if(active)stop();}});
window.addEventListener('pagehide',()=>{clearPendingSnapshot();stop({announce:false});mouthEdgeBlend.dispose();tongueSurface.dispose();});
async function loadAvatar(id){
  if(switching)return;
  const item=library.find(x=>x.id===id);if(!item||!['ready','preview'].includes(item.status))return;
  switching=true;ready=false;canDrive=false;stop({announce:false});clearPendingSnapshot();neutralTransition=null;renderSuspended=false;renderFailures=0;
  resetFrameCounter('正在准备画面…');
  output.style.display='none';coherentBase.style.display='none';stats.continuousComposite=false;controls();
  $('avatar-select').disabled=true;$('loading').hidden=false;$('loading').style.display='grid';$('loading').textContent='正在切换视频…';
  document.querySelectorAll('.video-card').forEach(card=>{card.disabled=true;});
  try{
    currentItem=item;stats.currentAvatar=id;stats.avatarName=item.name;stats.errors=[];
    geometry.dispose();detailGeometry.dispose();dentalRenderer.dispose();tongueSurface.reset();frameCapture.unavailable=false;
    avatar=null;zoomCtx.clearRect(0,0,zoom.width,zoom.height);decodedTime=0;
    if(item.status==='ready'){
      const url=useWasm?new URL('avatar.json',new URL(item.video,location.href)).pathname:'/api/avatars/'+encodeURIComponent(id);
      const response=await fetch(assetURL(url));if(!response.ok)throw new Error('形象数据加载失败');avatar=await response.json();
      if(useWasm){
        const appearance=$('appearance').value;
        const {threads}=await browserRuntime.avatar(avatar,appearance==='teeth'?'detail':appearance);
        stats.wasmThreads=threads;
      }
      await geometry.init(avatar);await detailGeometry.init(alignDentalMesh(avatar));await dentalRenderer.init(alignDentalMesh(avatar));
      canDrive=true;
    }
    const wrap=video.closest('.video-wrap');wrap.style.aspectRatio=item.width+'/'+item.height;wrap.classList.toggle('portrait',item.height>item.width);
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('底板视频加载失败'));video.src=assetURL(item.video);video.load();});
    try{await video.play();}
    catch(error){
      if(!useWasm||error.name!=='NotAllowedError')throw error;
      const start=document.createElement('button');
      start.type='button';start.textContent='点此开始预览';
      $('loading').replaceChildren(start);
      await new Promise((resolve,reject)=>start.addEventListener('click',()=>video.play().then(resolve,reject),{once:true}));
    }
    ready=true;
    if(canDrive)$('loading').textContent='正在准备待机口型…';else{$('loading').hidden=true;$('loading').style.display='none';}
    $('connection').textContent=useWasm?'浏览器 WASM 运行中':'本机运行中';$('status-dot').classList.add('ready');$('play-label').textContent=canDrive?'待机':'原视频预览';
    $('avatar-name').textContent=item.name;$('avatar-size').textContent=item.width+' × '+item.height;
    $('avatar-note').textContent=item.note||'可驱动口型';$('avatar-select').value=id;
    stats.canDrive=canDrive;stats.videoSize=[item.width,item.height];
    document.querySelectorAll('.video-card').forEach(card=>card.setAttribute('aria-pressed',String(card.dataset.id===id)));
    if(!globalThis.dhEmbeddedAssets){
      const params=new URLSearchParams(location.search);
      params.set('avatar',id);history.replaceState(null,'','?'+params);
    }
    status(canDrive?(lastClip?'已切换视频，可重播同一句话对比。':'准备好后即可朗读。'):(item.note||'仅播放原视频'));
  }catch(error){$('loading').textContent=error.message;$('connection').textContent='加载失败';status(error.message,true);stats.errors.push(error.message);}
  finally{switching=false;$('avatar-select').disabled=false;document.querySelectorAll('.video-card').forEach(card=>{card.disabled=!['ready','preview'].includes(library.find(x=>x.id===card.dataset.id).status);});controls();}
}
$('avatar-select').addEventListener('change',()=>loadAvatar($('avatar-select').value));
async function init(){
  try{
    if(useWasm){
      browserRuntime=new BrowserRuntime();
      $('text-controls').hidden=true;
      $('vowel-example').hidden=true;
      $('wasm-input').hidden=false;
      $('speak').textContent='播放示例语音';
      $('replay').textContent='重播语音';
      $('appearance').value='teeth';
      $('articulation').value='enhanced';
    }
    await mouthEdgeBlend.init();
    await tongueSurface.init();
    const requestedAppearance=new URLSearchParams(location.search).get('appearance');
    if(new URLSearchParams(location.search).get('articulation')==='1')$('articulation').value='enhanced';
    if(['preserve','baseline','detail','teeth'].includes(requestedAppearance))$('appearance').value=requestedAppearance;
    const response=await fetch(assetURL(useWasm?'/static/assets/library/catalog.json':'/api/avatars'));if(!response.ok)throw new Error('视频列表加载失败');library=(await response.json()).items;
    const readyCount=library.filter(x=>x.status==='ready').length;
    $('library-count').textContent=library.length+' 个视频 · '+readyCount+' 个可驱动';
    for(const item of library){
      const usable=['ready','preview'].includes(item.status);
      const option=document.createElement('option');option.value=item.id;option.textContent=item.name+(item.status==='ready'?'':' · '+(item.note||'正在准备'));option.disabled=!usable;$('avatar-select').append(option);
      const card=document.createElement('button');card.type='button';card.className='video-card '+item.status;card.dataset.id=item.id;card.disabled=!usable;card.setAttribute('aria-pressed','false');card.title=item.note||item.name;
      if(item.thumbnail){const img=document.createElement('img');img.src=assetURL(item.thumbnail);img.alt='';img.loading='lazy';card.append(img);}
      const name=document.createElement('strong');name.textContent=item.name;const note=document.createElement('small');note.textContent=item.status==='ready'?'可驱动 · '+item.width+'×'+item.height:(item.note||'正在准备');card.append(name,note);card.addEventListener('click',()=>loadAvatar(item.id));$('video-library').append(card);
    }
    const requestedId=new URLSearchParams(location.search).get('avatar');
    const initial=library.find(x=>x.id===requestedId&&['ready','preview'].includes(x.status))||library.find(x=>x.name==='fixend_1080p_2.mp4'&&x.status==='ready')||library.find(x=>x.status==='ready')||library.find(x=>x.status==='preview');
    if(!initial)throw new Error('视频正在准备，请稍后刷新');
    await loadAvatar(initial.id);
    $('count').textContent=$('text').value.length+' / 300';controls();requestAnimationFrame(tick);
  }catch(error){$('loading').textContent=error.message;$('connection').textContent='启动失败';status(error.message,true);stats.errors.push(error.message);}
}
init();
