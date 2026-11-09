#version 300 es
// Same motion/pose convention as the DINet semantic geometry; adds dental UVs.
layout(location=0) in vec3 a_position;
layout(location=1) in vec2 a_texture;
layout(location=2) in vec2 a_dental_uv;
layout(location=3) in vec3 a_articulation;
uniform mat4 gProjection;
uniform mat4 gWorld0;
uniform vec3 lowerOffset;
uniform vec4 dentalWindow;
uniform vec2 upperShape;
uniform vec2 lipOpening[20];
out vec2 v_dental_uv;
out vec2 v_screen_uv;
out float v_category;

float upperRimHeight(float across,vec2 axis,vec2 normal){
  float nearest=10000.0,height=0.0;
  for(int i=0;i<10;i++){
    vec2 a=lipOpening[i],b=lipOpening[i+1];
    float from=dot(a,axis),to=dot(b,axis);
    if(abs(to-from)<.0001)continue;
    float t=clamp((across-from)/(to-from),0.0,1.0);
    float distance=abs(across-mix(from,to,t));
    if(distance<nearest){
      nearest=distance;
      height=dot(mix(a,b,t),normal);
    }
  }
  return height;
}

void main(){
  vec3 position=a_position;
  if(a_texture.x==4.0)position+=lowerOffset;
  position+=a_articulation;
  vec4 world=gWorld0*vec4(position,1.0);
  if(a_texture.x==3.0){
    vec2 axis=dentalWindow.xy,normal=vec2(-axis.y,axis.x);
    float across=dot(world.xy,axis);
    float widen=.12*(across-dentalWindow.z);
    world.xy+=axis*widen;
    float top=upperRimHeight(across+widen,axis,normal);
    float v=dot(world.xy,normal);
    float side=smoothstep(.25,.50,abs(a_dental_uv.x-.5));
    float depth=upperShape.y*(1.0-.22*side);
    float tip=clamp(v-top,.86*depth,1.10*depth);
    // Extend the root behind the upper lip so visible UVs start on enamel.
    float target=top+mix(-1.36*depth,tip,a_dental_uv.y);
    world.xy+=normal*(target-v);
  }
  gl_Position=gProjection*world;
  v_screen_uv=world.xy/184.0;
  v_dental_uv=a_dental_uv;
  v_category=a_texture.x;
}
