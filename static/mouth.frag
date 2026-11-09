#version 300 es
// Adapted from kleinlee/DH_live, MIT; see licenses/DH_live.txt.
            precision mediump float;
            in mediump vec2 v_texture;
            in mediump vec2 v_bias;
            out vec4 out_color;
            uniform int passMode;
            uniform int teethPass;
            uniform vec2 lipOpening[20];
            uniform vec4 dentalWindow;
            uniform vec2 dentalOcclusion;
            in mediump vec2 v_screen;

            bool insideOpening(vec2 p){
                bool inside=false;vec2 previous=lipOpening[19];
                for(int i=0;i<20;i++){
                    vec2 current=lipOpening[i];
                    if((current.y>p.y)!=(previous.y>p.y)){
                        float crossing=(previous.x-current.x)*(p.y-current.y)/(previous.y-current.y)+current.x;
                        if(p.x<crossing)inside=!inside;
                    }
                    previous=current;
                }
                return inside;
            }

            void main() {
                if (passMode == 1) {
                    out_color = vec4((v_bias.xy + 1.0) / 2.0, 0.5, 1.0);
                    return;
                }
                if(teethPass==1){
                    if(abs(v_texture.x-3.0)>.001||!insideOpening(v_screen))discard;
                    if(dentalWindow.w<=.0001||dentalOcclusion.y<=0.0)discard;
                    float side=abs(dot(v_screen,dentalWindow.xy)-dentalWindow.z);
                    float visible=(1.0-smoothstep(max(0.0,dentalWindow.w-dentalOcclusion.x),dentalWindow.w,side))*dentalOcclusion.y;
                    if(visible<.5)discard;
                    out_color=vec4(0.0,1.0,0.0,1.0);return;
                }
                if(abs(v_texture.x-3.0)<.001)discard;
                if (v_texture.x == 2.0f) {
                    out_color = vec4(1.0, 0.0, 0.0, 1.0);
                }
                else if (v_texture.x > 2.0f && v_texture.x < 2.1f) {
                    out_color = vec4(0.5f, 0.0, 0.0, 1.0);
                }
                else if (v_texture.x == 3.0f) {
                    out_color = vec4(0.0, 1.0, 0.0, 1.0);
                }
                else if (v_texture.x == 4.0f) {
                    out_color = vec4(0.0, 0.0, 1.0, 1.0);
                }
                else if (v_texture.x > 3.0f && v_texture.x < 4.0f) {
                    out_color = vec4(0.0, 0.0, 0.0, 1.0);
                }
                else if (v_texture.x == -2.0f) {
                    out_color = vec4(0.0, 0.0, 0.0, 1.0);
                }
                else {
                    vec2 wrap = (v_bias.xy + 1.0) / 2.0;
                    out_color = vec4(wrap.xy, 0.5, 1.0);
                }
            }
        
