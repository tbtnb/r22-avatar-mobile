#version 300 es
precision highp float;
in vec2 v_dental_uv;
in vec2 v_screen_uv;
in float v_category;
uniform sampler2D dentalTexture;
uniform vec4 dentalRect;
uniform vec3 toothTint;
uniform vec3 upperGumTone;
uniform vec3 lowerGumTone;
uniform float dentalMix;
uniform float lowerExposure;
uniform float dentalBlur;
uniform float dentalScale;
uniform vec2 lipOpening[20];
uniform vec4 dentalWindow;
uniform vec2 upperShape;
uniform vec2 dentalOcclusion;
out vec4 out_color;

vec4 archMaterial(vec2 uv,vec2 dx,vec2 dy,vec3 gumTone,out float gum){
  // Filter premultiplied material so the dark atlas backdrop cannot bleed in.
  vec4 material=vec4(0.0);
  vec2 sx=dx*dentalBlur*1.414214,sy=dy*dentalBlur*1.414214;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    float w=(x==0?2.0:1.0)*(y==0?2.0:1.0)/16.0;
    material+=textureGrad(dentalTexture,uv+float(x)*sx+float(y)*sy,dx,dy)*w;
  }
  vec3 atlas=material.rgb/max(material.a,.0001);
  gum=smoothstep(.13,.29,(atlas.r-atlas.g)/max(atlas.r,.05));
  // Use the character's lip tones in the gingiva, with a continuous blend
  // through the warm neck of each tooth. Keep the atlas's scalloped contour.
  vec3 crown=atlas*toothTint;
  vec3 gingiva=mix(crown,gumTone*1.12,.38);
  return vec4(mix(crown,gingiva,gum),material.a);
}

void main(){
  bool lower=v_category>3.5;
  vec2 materialUV=v_dental_uv;
  if(lower){
    // The lower incisors are narrower. Reparameterize the shared atlas
    // around the front teeth while keeping its individual crown contours.
    float across=materialUV.x*2.0-1.0;
    float taper=1.0-abs(across);
    materialUV.x+=.25*across*taper*taper;
    materialUV.y=1.0-materialUV.y;
  }
  vec2 atlasUV=mix(dentalRect.xy,dentalRect.zw,materialUV);
  // Derivatives must be computed before the non-uniform stencil discards.
  vec2 dx=dFdx(atlasUV)*dentalScale,dy=dFdy(atlasUV)*dentalScale;
  float exposure=lower?lowerExposure:dentalMix;
  if(dentalWindow.w<=.0001||exposure<=.0001)discard;
  vec2 p=v_screen_uv*184.0,previous=lipOpening[19];bool inside=false;
  for(int i=0;i<20;i++){
    vec2 current=lipOpening[i];
    if((current.y>p.y)!=(previous.y>p.y)){
      float crossing=(previous.x-current.x)*(p.y-current.y)/(previous.y-current.y)+current.x;
      if(p.x<crossing)inside=!inside;
    }
    previous=current;
  }
  if(!inside)discard;
  float gum;
  vec4 material=archMaterial(atlasUV,dx,dy,lower?lowerGumTone:upperGumTone,gum);
  float lipDistance=184.0,upperDistance=184.0,lowerDistance=184.0;
  for(int i=0;i<20;i++){
    vec2 a=lipOpening[i],b=lipOpening[(i+1)%20],edge=b-a;
    float t=clamp(dot(p-a,edge)/max(dot(edge,edge),.0001),0.0,1.0);
    float d=length(p-a-edge*t);
    lipDistance=min(lipDistance,d);
    if(i<10)upperDistance=min(upperDistance,d);
    else lowerDistance=min(lowerDistance,d);
  }
  float contactDistance=lower?lowerDistance:upperDistance;
  float shadow=mix(lower?.69:.80,.99,smoothstep(0.0,2.2+dentalBlur*.4,contactDistance));
  float flank=abs(v_dental_uv.x-.5);
  if(lower)shadow*=1.0-.25*smoothstep(.12,.48,flank);
  float halfSpan=lower?.95*dentalWindow.w:upperShape.x;
  float side=abs(dot(p,dentalWindow.xy)-dentalWindow.z);
  float sideFade=lower?dentalOcclusion.x:max(dentalOcclusion.x,halfSpan*.19);
  float sideCoverage=1.0-smoothstep(max(0.0,halfSpan-sideFade),halfSpan,side);
  if(!lower)shadow*=mix(1.0,.80,smoothstep(.69,1.0,side/max(halfSpan,.001)));
  float edgeFade=lower?.62+dentalBlur*.25:.24+dentalBlur*.16;
  float coverage=exposure*sideCoverage*material.a*smoothstep(0.0,edgeFade,lipDistance);
  if(lower)coverage*=1.0-smoothstep(.36,.50,flank);
  // Soft tissue stays close to the root at the lip. Fade exposed gingiva
  // toward the sides of the arch and away from its adjacent lip.
  float exposedGum=max(smoothstep(.25,.46,flank),smoothstep(1.0,3.2,contactDistance));
  coverage*=1.0-.80*gum*exposedGum;
  // Both rows are premultiplied for transparent Canvas2D composition.
  out_color=vec4(clamp(material.rgb*shadow,0.0,1.0)*coverage,coverage);
}
