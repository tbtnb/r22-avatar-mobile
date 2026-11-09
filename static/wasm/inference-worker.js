import * as ort from './vendor/ort.wasm.min.mjs';
import {logMelFrames,prepareSamples} from './fbank.js';
import {LipColorLock} from './lip-color.js';

const embedded=globalThis.dhEmbeddedModelData;
const runtimeURL=path=>new URL(path,import.meta.url).href;
const threads=!embedded&&self.crossOriginIsolated?Math.min(4,navigator.hardwareConcurrency||1):1;
ort.env.wasm.numThreads=threads;
if(embedded)ort.env.wasm.wasmPaths={wasm:embedded['/static/wasm/vendor/ort-wasm-simd-threaded.wasm']};
else ort.env.wasm.wasmPaths=runtimeURL('./vendor/');
const config=embedded
  ?Promise.resolve(JSON.parse(new TextDecoder().decode(embedded['/static/wasm/config.json'])))
  :fetch(runtimeURL('config.json')).then(response=>{
  if(!response.ok)throw new Error('WASM 模型配置加载失败');
  return response.json();
});
const sessions=new Map(),size=184,plane=size*size,imageBytes=plane*4;
const imageShape=[1,4,size,size],stateShape=[2,1,192];
const inputNames=['source_rgba','prompt_rgba','flow_rgba'];
const rendererKeys={preserve:'renderer',detail:'detail_renderer',baseline:'baseline_renderer'};
let identity,lipColor;

async function model(key){
  if(!sessions.has(key)){
    const pending=config.then(options=>ort.InferenceSession.create(
      embedded?embedded['/static/wasm/'+options[key]]:runtimeURL(options[key]),{
      executionProviders:['wasm'],
    })).catch(error=>{sessions.delete(key);throw error;});
    sessions.set(key,pending);
  }
  return sessions.get(key);
}

async function render({payload,mode,frame}){
  if(!identity)throw new Error('形象尚未加载');
  const session=await model(rendererKeys[mode]);
  const feeds={identity};
  for(let i=0;i<inputNames.length;i++){
    const name=inputNames[i];
    if(!session.inputNames.includes(name))continue;
    const data=new Float32Array(imageBytes),offset=i*imageBytes;
    for(let j=0;j<plane;j++){
      const k=offset+j*4;
      data[j]=payload[k]/255;
      data[plane+j]=payload[k+1]/255;
      data[2*plane+j]=payload[k+2]/255;
      data[3*plane+j]=payload[k+3]/255;
    }
    feeds[name]=new ort.Tensor('float32',data,imageShape);
  }
  const start=performance.now();
  const outputs=await session.run(feeds);
  const planar=outputs[session.outputNames[0]].data,pixels=new Float32Array(imageBytes);
  for(let j=0;j<plane;j++){
    for(let c=0;c<4;c++)pixels[j*4+c]=Math.max(0,Math.min(255,planar[c*plane+j]*255));
  }
  if(mode!=='baseline')lipColor.apply(payload,payload.subarray(imageBytes,2*imageBytes),pixels,frame);
  return {pixels:new Uint8ClampedArray(pixels),inferenceMs:performance.now()-start};
}

async function animate({pcm}){
  if(!pcm.length||pcm.length>16000*120)throw new Error('请选择 120 秒以内的音频');
  const {fps,audio_advance_frames:advance,audio_scale:scale}=await config;
  const session=await model('audio_model');
  const features=logMelFrames(prepareSamples(pcm,advance));
  const {poses}=await session.run({
    features:new ort.Tensor('float32',features,[1,features.length/80,80]),
    h:new ort.Tensor('float32',new Float32Array(384),stateShape),
    c:new ort.Tensor('float32',new Float32Array(384),stateShape),
  });
  const count=Math.ceil(pcm.length*fps/16000),length=poses.data.length/6;
  const values=Array.from({length:count},(_,i)=>{
    const start=Math.min(i+advance,length-1)*6;
    return Array.from(poses.data.subarray(start,start+6),x=>x*scale);
  });
  if(values.some(row=>row.length!==6||row.some(x=>!Number.isFinite(x))))throw new Error('音频模型返回了无效口型');
  return {fps,poses:values};
}

const actions={
  async avatar({avatar,mode}){
    await model(rendererKeys[mode]);
    identity=new ort.Tensor('float32',Float32Array.from(avatar.identity),[1,64]);
    lipColor=new LipColorLock(avatar);
    return {threads};
  },
  render,
  animate,
};

// Serialize operations so switching an avatar cannot change the identity of an in-flight frame.
let queue=Promise.resolve();
self.onmessage=({data:{id,action,data}})=>{
  queue=queue.then(async()=>{
    try{
      const value=await actions[action](data);
      self.postMessage({id,value},value.pixels?[value.pixels.buffer]:[]);
    }catch(error){
      self.postMessage({id,error:error instanceof Error?error.message:String(error)});
    }
  });
};
