// The audio model was trained on 8 kHz Kaldi log-mel features.
const sampleRate=8000, frameSize=400, frameShift=160, fftSize=512, melBins=80;
const bitReverse=Uint16Array.from({length:fftSize},(_,value)=>{
  let index=0;
  for(let bits=fftSize;bits>1;bits>>=1){index=(index<<1)|(value&1);value>>=1;}
  return index;
});
const cos=Float64Array.from({length:fftSize/2},(_,i)=>Math.cos(-2*Math.PI*i/fftSize));
const sin=Float64Array.from({length:fftSize/2},(_,i)=>Math.sin(-2*Math.PI*i/fftSize));

function powerSpectrum(input,real,imaginary,power){
  for(let i=0;i<fftSize;i++)real[bitReverse[i]]=input[i];
  imaginary.fill(0);
  for(let length=2;length<=fftSize;length*=2){
    const half=length/2,stride=fftSize/length;
    for(let start=0;start<fftSize;start+=length){
      for(let i=0;i<half;i++){
        const a=start+i,b=a+half,k=i*stride;
        const re=real[b]*cos[k]-imaginary[b]*sin[k];
        const im=real[b]*sin[k]+imaginary[b]*cos[k];
        real[b]=real[a]-re;
        imaginary[b]=imaginary[a]-im;
        real[a]+=re;
        imaginary[a]+=im;
      }
    }
  }
  for(let i=0;i<power.length;i++)power[i]=real[i]*real[i]+imaginary[i]*imaginary[i];
}
const window=Float32Array.from({length:frameSize},(_,i)=>Math.pow(.5-.5*Math.cos(2*Math.PI*i/(frameSize-1)),.85));
const mel=hz=>1127*Math.log1p(hz/700);
const low=mel(20),high=mel(sampleRate/2),step=(high-low)/(melBins+1);
const banks=Array.from({length:melBins},(_,b)=>{
  const center=low+step*(b+1),weights=[];
  for(let i=0;i<fftSize/2;i++){
    const weight=1-Math.abs(mel(i*sampleRate/fftSize)-center)/step;
    if(weight>0)weights.push([i,weight]);
  }
  return weights;
});

const radius=48;
const decimationKernel=Float32Array.from({length:radius*2+1},(_,i)=>{
  const x=i-radius;
  const sinc=x===0?.5:Math.sin(Math.PI*x*.5)/(Math.PI*x);
  return sinc*(.42+.5*Math.cos(Math.PI*x/radius)+.08*Math.cos(2*Math.PI*x/radius));
});
const normalization=decimationKernel.reduce((sum,x)=>sum+x,0);

export function prepareSamples(pcm,advance){
  const samples=new Float32Array(Math.floor((pcm.length+(advance+2)*640)/2));
  for(let i=0;i<Math.min(samples.length,Math.ceil((pcm.length+radius)/2));i++){
    const center=i*2;
    const first=Math.max(-radius,-center),last=Math.min(radius,pcm.length-1-center);
    let value=0;
    for(let k=first;k<=last;k++)value+=pcm[center+k]*decimationKernel[k+radius];
    samples[i]=value/normalization;
  }
  return samples;
}

export function logMelFrames(samples){
  // The original streaming extractor reflects the leading edge and emits only
  // complete windows. The caller supplies the same look-ahead padding.
  const frames=Math.floor(Math.max(0,Math.floor((samples.length-120)/frameShift))/2)*2;
  const output=new Float32Array(frames*melBins),input=new Float32Array(fftSize);
  const real=new Float64Array(fftSize),imaginary=new Float64Array(fftSize),power=new Float32Array(fftSize/2);
  for(let f=0;f<frames;f++){
    const start=f*frameShift-120;
    let mean=0;
    for(let i=0;i<frameSize;i++){
      const at=start+i;
      input[i]=samples[at<0?-at-1:at];
      mean+=input[i];
    }
    mean/=frameSize;
    let previous=input[0]-mean;
    for(let i=0;i<frameSize;i++){
      const sample=input[i]-mean;
      input[i]=(sample-.97*previous)*window[i];
      previous=sample;
    }
    powerSpectrum(input,real,imaginary,power);
    for(let b=0;b<melBins;b++){
      let energy=0;
      for(const [i,weight] of banks[b])energy+=power[i]*weight;
      output[f*melBins+b]=Math.log(Math.max(1.1920928955078125e-7,energy));
    }
  }
  return output;
}
