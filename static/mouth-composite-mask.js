import {smoothContour} from './mouth-edge-mask.js?v=lip-edge-r15';

function addContour(path,points){
  const contour=smoothContour(points);
  path.moveTo(contour[0],contour[1]);
  for(let i=2;i<contour.length;i+=2)path.lineTo(contour[i],contour[i+1]);
  path.closePath();
}

export class MouthCompositeMask {
  constructor(size){
    this.canvas=Object.assign(document.createElement('canvas'),{width:size,height:size});
    this.mask=this.canvas.getContext('2d');
    this.mask.lineJoin='round';
  }

  apply(output,frame,outerIndices,target,width){
    // Include the tracked source mouth so its lips cannot show through
    // when the generated lips move. Both contours use the same winding.
    const source=outerIndices.flatMap(id=>frame.points.slice(16+id*2,18+id*2));
    const path=new Path2D();
    addContour(path,source);
    addContour(path,target);

    const mask=this.mask;
    mask.clearRect(0,0,this.canvas.width,this.canvas.height);
    mask.fill(path);
    // Feather from the edge of the mouth into the original skin with
    // nested strokes. The full lip contours get an opaque margin.
    const bands=8;
    let previous=0;
    for(let step=1;step<=bands;step++){
      const t=step/bands,coverage=t*t*(3-2*t);
      mask.lineWidth=2*width*(.18-.12*t);
      mask.globalAlpha=(coverage-previous)/(1-previous);
      mask.stroke(path);
      previous=coverage;
    }
    mask.globalAlpha=1;
    output.save();
    output.globalCompositeOperation='destination-in';
    output.drawImage(this.canvas,0,0,output.canvas.width,output.canvas.height);
    output.restore();
  }
}
