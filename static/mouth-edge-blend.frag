#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform sampler2D band;
uniform float radius;
out vec4 out_color;
void main(){
  vec4 center=texture(image,uv);float weight=texture(band,uv).r*.85;
  vec3 rgb=center.rgb;
  if(weight>.001){
    vec3 sum=vec3(0.0);float coverage=0.0;
    for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
      float w=(x==0?2.0:1.0)*(y==0?2.0:1.0)/16.0;
      vec4 sampleColor=texture(image,uv+vec2(x,y)*radius*1.414214/184.0);
      sum+=sampleColor.rgb*sampleColor.a*w;coverage+=sampleColor.a*w;
    }
    rgb=mix(rgb,sum/max(coverage,.0001),weight);
  }
  vec3 srgb=mix(rgb*12.92,1.055*pow(max(rgb,vec3(0.0)),vec3(1.0/2.4))-.055,step(vec3(.0031308),rgb));
  out_color=vec4(srgb*center.a,center.a);
}
