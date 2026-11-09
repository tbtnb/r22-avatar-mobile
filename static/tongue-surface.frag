#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform sampler2D semantic;
uniform sampler2D dental;
uniform bool hasDental;
uniform float lowerExposure;
uniform vec2 polygon[20];
uniform vec2 axis;
uniform vec2 oralRange;
uniform vec2 verticalRange;
uniform vec3 tissueTone;
uniform float strength;
uniform float detailAmount;
out vec4 out_color;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
    vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
// Sample toward the visible enamel, in the rotated mouth's local frame.
float crownContact(vec2 direction){
    vec2 stepUV=direction/184.0;
    float a=texture(dental,uv+.65*stepUV).a;
    float b=texture(dental,uv+1.55*stepUV).a;
    float c=texture(dental,uv+2.65*stepUV).a;
    float d=texture(dental,uv+3.90*stepUV).a;
    return min(1.0,a*.56+b*.34+c*.23+d*.13);
}
void main(){
    vec4 center=texture(image,uv);vec3 rgb=center.rgb;
    vec2 p=uv*184.0,n=vec2(-axis.y,axis.x);
    float u=dot(p,axis),v=dot(p,n),x=(u-oralRange.x)/oralRange.y;
    if(abs(x)<.89&&v>verticalRange.x&&v<verticalRange.y){
        float top=10000.0,bottom=-10000.0;vec2 previous=polygon[19];
        for(int i=0;i<20;i++){
            vec2 current=polygon[i];float delta=current.x-previous.x;
            if(abs(delta)>.00001&&u>=min(current.x,previous.x)&&u<=max(current.x,previous.x)){
                float y=previous.y+(u-previous.x)*(current.y-previous.y)/delta;
                top=min(top,y);bottom=max(bottom,y);
            }
            previous=current;
        }
        float gap=bottom-top;
        if(gap>0.0&&v>top&&v<bottom){
            float t=(v-top)/gap,start=.42+.25*x*x;
            float mask=smoothstep(start,start+.12,t)*(1.0-smoothstep(.82,1.0,t))
                *(1.0-smoothstep(.60,.89,abs(x)))*smoothstep(4.0,11.0,gap)*strength;
            float upperContact=0.0,lowerContact=0.0;
            if(hasDental){
                // The matte contains the crowns that were actually rendered.
                // Both fades stop at the inner lip rim and around the corners.
                float above=crownContact(-n),below=crownContact(n);
                upperContact=max(above,.60*below)*(1.0-smoothstep(.30,.56,t));
                lowerContact=max(below,.42*above)*smoothstep(.43,.69,t);
                // A visible lower arch occludes the tongue's front and sides.
                // Keep a softly rounded center rather than a second pink row.
                vec2 tongueCenter=vec2(x/.60,(t-.60)/.24);
                float tongueReveal=.38*(1.0-smoothstep(.12,1.0,dot(tongueCenter,tongueCenter)));
                float lowerCover=smoothstep(.04,.70,lowerExposure);
                mask*=mix(1.0,tongueReveal,lowerCover)*(1.0-.35*lowerContact);
            }
            vec3 label=texture(semantic,uv).rgb;
            // Lip labels and either dental label are hard protections. Also
            // preserve bright, near-neutral neural enamel outside those labels.
            bool enamel=dot(rgb,vec3(.2126,.7152,.0722))>.42&&max(max(rgb.r,rgb.g),rgb.b)-min(min(rgb.r,rgb.g),rgb.b)<.12;
            if(label.g>.7||label.b>.7||(label.r>.3&&label.g<.1&&label.b<.1)||enamel)mask=0.0;
            if(mask>.00001){
                float shade=.72+.38*exp(-pow((t-.72)/.26,2.0))-.17*x*x;
                vec2 canonical=vec2((x+1.0)*.5,t);
                float grain=(noise(canonical*vec2(69.0,43.0))-.5)*.012
                    +(noise(canonical*vec2(131.0,77.0))-.5)*.006;
                float groove=-.007*exp(-pow(x/.065,2.0))*smoothstep(.5,.68,t)*(1.0-smoothstep(.78,.96,t));
                float wet=.012*exp(-pow((x-.2)/.35,2.0)-pow((t-.77)/.14,2.0));
                vec3 low=vec3(0);
                for(int y=-1;y<=1;y++)for(int a=-1;a<=1;a++){
                    float w=(a==0?2.0:1.0)*(y==0?2.0:1.0)/16.0;
                    low+=texture(image,uv+vec2(a,y)/184.0).rgb*w;
                }
                vec3 observed=clamp(rgb-low,vec3(-.012),vec3(.025))*.20;
                vec3 surface=tissueTone*shade+vec3(grain*detailAmount+groove+wet)+observed;
                rgb=mix(rgb,clamp(surface,0.0,1.0),mask);
            }
            if(hasDental){
                float rim=smoothstep(.16,.92,min(v-top,bottom-v));
                float here=texture(dental,uv).a;
                float pocket=smoothstep(.52,.84,t)*(1.0-smoothstep(.70,.93,abs(x)))*lowerExposure;
                float contact=max(.42*upperContact,max(.75*lowerContact,.54*pocket))*rim*(1.0-here);
                if(contact>.0001){
                    // Pick up the local cavity color. This keeps tissue
                    // behind the incisal edge instead of leaving a pink rim
                    // with the same brightness as the foreground crowns.
                    vec3 cavity=texture(image,uv+n*(top+gap*.40-v)/184.0).rgb;
                    vec3 recessed=min(rgb,mix(rgb*vec3(.69,.81,.86),cavity,.40));
                    rgb=mix(rgb,recessed,contact);
                }
            }
        }
    }
    out_color=vec4(rgb*center.a,center.a);
}
