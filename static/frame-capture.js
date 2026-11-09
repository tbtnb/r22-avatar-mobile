// Read a small, chroma-aligned rectangle from the frozen decoder frame, then
// resize in CPU memory. No Canvas2D GPU readback is needed for ONNX input.
export class FrameCapture {
  constructor(size=184){this.size=size;this.pixels=new Uint8ClampedArray(size*size*4);this.bytes=null;this.unavailable=false;}
  async read(frame,rect){
    if(this.unavailable||!frame?.copyTo||frame.rotation||frame.flip||frame.displayWidth!==frame.visibleRect.width||frame.displayHeight!==frame.visibleRect.height||frame.visibleRect.x||frame.visibleRect.y)return null;
    const [x0,y0,x1,y1]=rect;
    const left=Math.max(0,Math.floor((x0-1)/2)*2),top=Math.max(0,Math.floor((y0-1)/2)*2);
    const right=Math.min(frame.visibleRect.width,Math.ceil((x1+1)/2)*2),bottom=Math.min(frame.visibleRect.height,Math.ceil((y1+1)/2)*2);
    const width=right-left,height=bottom-top;
    const options={format:'RGBA',colorSpace:'srgb',rect:{x:left,y:top,width,height}};
    let layout;
    try{
      const length=frame.allocationSize(options);
      if(this.bytes?.length!==length)this.bytes=new Uint8Array(length);
      layout=await frame.copyTo(this.bytes,options);
    }catch(error){this.unavailable=true;this.reason=error.message;return null;}
    const {stride,offset}=layout[0]??{};
    if(layout.length!==1||!Number.isInteger(stride)||stride<width*4||
      !Number.isInteger(offset)||offset<0||offset+(height-1)*stride+width*4>this.bytes.length){
      this.unavailable=true;
      this.reason='Decoder did not return a packed RGBA frame';
      return null;
    }
    const bytes=this.bytes,out=this.pixels,size=this.size;
    for(let y=0;y<size;y++){
      const sy=y0-top+(y+.5)*(y1-y0)/size-.5,iy=Math.floor(sy),ty=sy-iy;
      const row0=offset+Math.max(0,Math.min(height-1,iy))*stride,row1=offset+Math.max(0,Math.min(height-1,iy+1))*stride;
      for(let x=0;x<size;x++){
        const sx=x0-left+(x+.5)*(x1-x0)/size-.5,ix=Math.floor(sx),tx=sx-ix;
        const col0=Math.max(0,Math.min(width-1,ix))*4,col1=Math.max(0,Math.min(width-1,ix+1))*4,at=(y*size+x)*4;
        for(let k=0;k<4;k++){
          const a=bytes[row0+col0+k]*(1-tx)+bytes[row0+col1+k]*tx;
          const b=bytes[row1+col0+k]*(1-tx)+bytes[row1+col1+k]*tx;
          out[at+k]=a*(1-ty)+b*ty;
        }
      }
    }
    return {data:out};
  }
}
