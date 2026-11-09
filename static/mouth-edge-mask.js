// A soft processing band, never a cutout of the rendered mouth. Work at twice
// the neural crop resolution and retain smooth, subpixel contour placement.
export function smoothContour(points,steps=4){
  const n=points.length/2,out=new Float32Array(n*steps*2);
  for(let i=0;i<n;i++)for(let k=0;k<steps;k++)for(let axis=0;axis<2;axis++){
    const a=points[((i+n-1)%n)*2+axis],b=points[i*2+axis],c=points[((i+1)%n)*2+axis],d=points[((i+2)%n)*2+axis],t=k/steps;
    out[(i*steps+k)*2+axis]=.5*(2*b+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);
  }
  return out;
}
function fillPolygon(points,out,size){
  out.fill(0);const cross=[];
  for(let y=0;y<size;y++){
    const sy=(y+.5)/2;cross.length=0;
    for(let i=0,j=points.length-2;i<points.length;j=i,i+=2)if((points[i+1]>sy)!==(points[j+1]>sy))cross.push(points[i]+(points[j]-points[i])*(sy-points[i+1])/(points[j+1]-points[i+1]));
    cross.sort((a,b)=>a-b);
    for(let i=0;i+1<cross.length;i+=2){
      const a=Math.max(0,Math.min(size,Math.ceil(cross[i]*2-.5))),b=Math.max(a,Math.min(size,Math.ceil(cross[i+1]*2-.5)));out.fill(1,y*size+a,y*size+b);
    }
  }
}
function soften(mask,temp,size,passes){
  for(let pass=0;pass<passes;pass++){
    for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){const i=y*size+x;temp[i]=(mask[i-1]+2*mask[i]+mask[i+1])*.25;}
    for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){const i=y*size+x;mask[i]=(temp[i-size]+2*temp[i]+temp[i+size])*.25;}
  }
}
export class MouthEdgeMask {
  constructor(){this.size=368;this.inner=new Float32Array(368*368);this.outer=new Float32Array(368*368);this.temp=new Float32Array(368*368);this.bytes=new Uint8Array(368*368);}
  update(inner,outer){
    fillPolygon(smoothContour(inner),this.inner,368);fillPolygon(smoothContour(outer),this.outer,368);
    soften(this.inner,this.temp,368,8);soften(this.outer,this.temp,368,6);
    for(let i=0;i<this.bytes.length;i++){
      const a=this.inner[i],b=this.outer[i];this.bytes[i]=Math.round(255*Math.min(1,4*a*(1-a)+.28*4*b*(1-b)));
    }
    return this.bytes;
  }
}
