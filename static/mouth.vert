#version 300 es
// Adapted from kleinlee/DH_live, MIT; see licenses/DH_live.txt.
            layout(location = 0) in vec3 a_position;
            layout(location = 1) in vec2 a_texture;
            layout(location = 3) in vec3 a_articulation;
            uniform float bsVec[12];
            uniform mat4 gProjection;
            uniform mat4 gWorld0;
            uniform sampler2D texture_bs;
            uniform vec2 vertBuffer[209];
            out vec2 v_texture;
            out vec2 v_bias;
            out vec2 v_screen;

            vec4 calculateMorphPosition(vec3 position, vec2 textureCoord) {
                vec4 tmp_Position2 = vec4(position, 1.0);
                if (textureCoord.x < 3.0 && textureCoord.x >= 0.0) {
                    vec3 morphSum = vec3(0.0);
                    for (int i = 0; i < 6; i++) {
                        ivec2 coord = ivec2(int(textureCoord.y), i);
                        vec3 morph = texelFetch(texture_bs, coord, 0).xyz * 2.0 - 1.0;
                        morphSum += bsVec[i] * morph;
                    }
                    tmp_Position2.xyz += morphSum;
                }
                else if (textureCoord.x == 4.0) {
                    float z_ = (bsVec[0] + bsVec[1])/ 3.9;
                    z_ = max(z_, 0.0);
                    vec3 morphSum = vec3(0.0, (bsVec[0] + bsVec[1]) / 3.0 + 6.0, z_);
                    tmp_Position2.xyz += morphSum;
                }
                return tmp_Position2;
            }

            void main() {
                mat4 gWorld = gWorld0;

                vec4 tmp_Position2 = calculateMorphPosition(a_position, a_texture);
                tmp_Position2.xyz += a_articulation;
                vec4 tmp_Position = gWorld * tmp_Position2;

                v_bias = vec2(0.0, 0.0);
                if (a_texture.x == -1.0f) {
                    v_bias = vec2(0.0, 0.0);
                }
                else if (a_texture.y < 209.0f) {
                    vec4 vert_new = gProjection * vec4(tmp_Position.x, tmp_Position.y, tmp_Position.z, 1.0);
                    v_bias = vert_new.xy - (vertBuffer[int(a_texture.y)].xy / 184.0 * 2.0 - 1.0);
                }
                gl_Position = gProjection * vec4(tmp_Position.xyz, 1.0);
                v_screen=tmp_Position.xy;
                v_texture = a_texture;
            }
        
