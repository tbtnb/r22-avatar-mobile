const size=184,pixelCount=size*size;
const luma=(rgba,i)=>.2126*rgba[i]+.7152*rgba[i+1]+.0722*rgba[i+2];

function coreIndices(polygon){
  const inside=new Uint8Array(pixelCount);
  const x0=Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[0]))));
  const x1=Math.min(size-1,Math.ceil(Math.max(...polygon.map(p=>p[0]))));
  const y0=Math.max(0,Math.floor(Math.min(...polygon.map(p=>p[1]))));
  const y1=Math.min(size-1,Math.ceil(Math.max(...polygon.map(p=>p[1]))));
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      let covered=false;
      for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
        const [ax,ay]=polygon[j],[bx,by]=polygon[i];
        if((ay>y+.5)!==(by>y+.5)&&x+.5<(bx-ax)*(y+.5-ay)/(by-ay)+ax)covered=!covered;
      }
      if(covered)inside[y*size+x]=1;
    }
  }
  const indices=[];
  for(let y=Math.max(1,y0);y<=Math.min(size-2,y1);y++){
    for(let x=Math.max(1,x0);x<=Math.min(size-2,x1);x++){
      const i=y*size+x;
      if(inside[i]&&inside[i-1]&&inside[i+1]&&inside[i-size]&&inside[i+size])indices.push(i*4);
    }
  }
  return indices;
}

export class LipColorLock {
  constructor(avatar){
    this.avatar=avatar;
    this.cache=new Map();
    this.labels=new Uint8Array(pixelCount);
  }
  reference(frame){
    if(!this.cache.has(frame)){
      const points=this.avatar.frames[frame].points;
      const indices=['upper','lower'].map(name=>coreIndices(this.avatar.lipContours[name]
        .map(i=>[points[16+2*i],points[17+2*i]])));
      this.cache.set(frame,indices);
    }
    return this.cache.get(frame);
  }
  apply(source,prompt,pixels,frame){
    const reference=this.reference(frame),labels=this.labels;
    if(reference.every(x=>x.length<24))return;
    labels.fill(0);
    for(let i=0;i<pixelCount;i++){
      const j=i*4,r=prompt[j];
      if(prompt[j+1]<25&&prompt[j+2]<25)labels[i]=r>220?1:r>100&&r<160?2:0;
    }
    const areas=[[],[]],counts=[0,0],sums=[0,0];
    for(let y=0;y<size;y++){
      for(let x=0;x<size;x++){
        const i=y*size+x,label=labels[i];
        if(!label)continue;
        const core=x>0&&x<size-1&&y>0&&y<size-1&&labels[i-1]===label&&labels[i+1]===label
          &&labels[i-size]===label&&labels[i+size]===label;
        const j=i*4,region=label-1;
        areas[region].push(core?j+1:-(j+1));
        if(core){counts[region]++;sums[region]+=luma(pixels,j);}
      }
    }
    for(let k=0;k<2;k++){
      if(reference[k].length<24||counts[k]<24)continue;
      const sourceLuma=reference[k].reduce((sum,j)=>sum+luma(source,j),0)/reference[k].length;
      const gain=Math.max(1,Math.min(1.08,sourceLuma/Math.max(1,sums[k]/counts[k])));
      if(gain===1)continue;
      for(const index of areas[k]){
        const j=Math.abs(index)-1,scale=index>0?gain:1+.35*(gain-1);
        for(let c=0;c<3;c++)pixels[j+c]=Math.min(255,pixels[j+c]*scale);
      }
    }
  }
}
