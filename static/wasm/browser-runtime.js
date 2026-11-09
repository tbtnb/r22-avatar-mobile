export class BrowserRuntime {
  constructor(){
    const embedded=globalThis.dhEmbeddedAssets?.['/static/wasm/inference-worker.js'];
    this.worker=embedded?new Worker(embedded):new Worker(new URL('./inference-worker.js',import.meta.url),{type:'module'});
    this.nextId=0;
    this.pending=new Map();
    this.worker.onmessage=({data:{id,value,error}})=>{
      const request=this.pending.get(id);
      if(!request)return;
      this.pending.delete(id);
      if(error)request.reject(new Error(error));
      else request.resolve(value);
    };
    this.worker.onerror=event=>this.fail(event.message||'浏览器 WASM 推理启动失败');
    this.worker.onmessageerror=()=>this.fail('浏览器 WASM 推理通信失败');
    if(embedded){
      this.worker.postMessage(globalThis.dhEmbeddedWorkerPackage);
      delete globalThis.dhEmbeddedWorkerPackage;
    }
  }
  fail(message){
    this.error=new Error(message);
    for(const request of this.pending.values())request.reject(this.error);
    this.pending.clear();
    this.worker.terminate();
  }
  call(action,data,transfer=[]){
    if(this.error)return Promise.reject(this.error);
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.worker.postMessage({id,action,data},transfer);}
      catch(error){this.pending.delete(id);reject(error);}
    });
  }
  avatar(avatar,mode){
    const {identity,lipContours,frames}=avatar;
    const lips=frames.map(({points})=>({points}));
    return this.call('avatar',{avatar:{identity,lipContours,frames:lips},mode});
  }
  render(payload,mode,frame){
    const copy=payload.slice();
    return this.call('render',{payload:copy,mode,frame},[copy.buffer]);
  }
  async animate(audio){
    if(audio.duration>120||audio.length===0)throw new Error('请选择 120 秒以内的音频');
    const pcm=new Float32Array(audio.length);
    for(let i=0;i<audio.numberOfChannels;i++){
      const channel=audio.getChannelData(i);
      for(let j=0;j<pcm.length;j++)pcm[j]+=channel[j]/audio.numberOfChannels;
    }
    return this.call('animate',{pcm},[pcm.buffer]);
  }
}
