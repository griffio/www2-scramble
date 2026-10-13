// WebGL2 renderer.
//  * camera-relative rendering (positions are sent relative to the camera, so a 48 km map has
//    no float jitter) + logarithmic depth (cockpit frame at 0.3 m and hills at 40 km)
//  * CDLOD terrain: one 33x33 grid patch, instanced over a quadtree selection, vertex morphing
//    between levels, heights fetched from a float texture in the vertex shader (2 draw calls)
//  * everything else is instanced: aircraft per type, buildings, trees, props, particles,
//    tracers, clouds -> ~30 draw calls a frame
//  * MSAA scene target, bloom, film-style grading, dynamic resolution
import { m4, m4perspective, m4viewFromQuat, m4mul, clamp } from './math.js';
import { HM_N, HM_CELL, HM_X0 } from './world.js';

// ------------------------------------------------------------------ shared GLSL
const FRAME = `
layout(std140) uniform Frame {
  mat4 uVP;
  mat4 uInvVP;
  vec4 uCam;     // xyz camera, w time
  vec4 uSun;     // xyz to-sun, w log-depth coefficient
  vec4 uFogC;    // horizon colour, w fog density
  vec4 uZen;     // zenith colour, w fog height falloff
  vec4 uSunC;    // sun colour, w ambient
  vec4 uMisc;    // x cloud shadow, yz cloud offset, w pixel angle
};`;
const COMMON = `${FRAME}
uniform sampler2D uNoise;
vec3 sky(vec3 d) {
  float h = max(d.y, 0.0);
  vec3 c = mix(uFogC.rgb, uZen.rgb, pow(h, 0.5));
  float s = max(dot(d, uSun.xyz), 0.0);
  c += uSunC.rgb * (pow(s, 6.0) * 0.22 + pow(s, 48.0) * 0.3);
  c = mix(c, uFogC.rgb * 0.95, clamp(-d.y * 5.0, 0.0, 1.0));
  return c;
}
float fogAmount(vec3 rel) {
  float hAvg = max(0.0, uCam.y + rel.y * 0.5);
  return 1.0 - exp(-length(rel) * uFogC.w * exp(-hAvg * uZen.w));
}
vec4 fogParams(vec3 rel) {   // rgb: fog colour toward rel, a: amount
  vec3 dir = rel / max(length(rel), 1e-3);
  return vec4(sky(vec3(dir.x, max(dir.y, 0.0) * 0.25 + 0.01, dir.z)), fogAmount(rel));
}
vec3 fogApply(vec3 col, vec3 rel) { vec4 f = fogParams(rel); return mix(col, f.rgb, f.a); }
float cloudShadow(vec2 xz) {
  float n = texture(uNoise, (xz + uMisc.yz) / 11000.0).r;
  return 1.0 - smoothstep(0.58, 0.68, n) * uMisc.x;
}
`;
// Depth: reversed-Z with a float depth buffer when EXT_clip_control exists (early-Z stays on, MSAA
// depth per sample); otherwise logarithmic depth written per fragment.
const LOGZ = `
#ifndef REVZ
  gl_FragDepth = log2(vW + 1.0) * uSun.w;
#endif
`;
const BBZ = (w) => `
#ifndef REVZ
  gl_Position.z = (log2(max(1e-6, ${w} + 1.0)) * uSun.w * 2.0 - 1.0) * ${w};
#endif
`;

const OBJ_VS = `#version 300 es
precision highp float;
${FRAME}
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aNrm;
layout(location=2) in vec4 aCol;
layout(location=3) in vec4 iPos;     // xyz position (relative to uOrigin), w scale
layout(location=4) in vec4 iRot;     // quaternion
layout(location=5) in vec4 iExtra;   // x soot, y flags, z hit flash, w seed
layout(location=6) in vec4 iExtra2;  // x shadow plane y (rel), y shadow strength
uniform vec3 uOrigin;
uniform float uShadow;
out vec3 vRel; out vec3 vN; out vec4 vCol; out vec3 vObj; out vec4 vEx; out float vW;
vec3 qrot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
void main() {
  vec3 p = qrot(iRot, aPos * iPos.w) + iPos.xyz - uOrigin;
  vN = qrot(iRot, aNrm.xyz);
  vObj = aPos; vCol = aCol; vEx = iExtra;
  if (uShadow > 0.5) {
    if (iExtra2.y < 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // planar projection onto the ground along the sun direction
    float t = (p.y - iExtra2.x) / max(uSun.y, 0.15);
    p = p - uSun.xyz * t;
    p.y = iExtra2.x + 0.12;
    vEx = vec4(iExtra2.y, 0.0, 0.0, 0.0);
  }
  vRel = p;
  gl_Position = uVP * vec4(p, 1.0);
  vW = gl_Position.w;
}`;
const OBJ_FS = `#version 300 es
precision highp float;
${COMMON}
in vec3 vRel; in vec3 vN; in vec4 vCol; in vec3 vObj; in vec4 vEx; in float vW;
uniform vec3 uCamoA, uCamoB, uUnder;
uniform vec4 uEye;    // cockpit view: model-space eye point + radius of canopy structure to hide
uniform float uCamoScale, uShadow, uAlpha;
out vec4 o;
void main() {
  if (uShadow > 0.5) { o = vec4(vec3(1.0 - 0.55 * vEx.x), 1.0); ${LOGZ} return; }
  int mat = int(vCol.a * 255.0 + 0.5);
  float flags = vEx.y;
  if (flags > 0.5) {                               // cockpit view: no glazing, no canopy frame around the head
    if (mat == 3) discard;
    vec3 de = vObj - uEye.xyz;
    if (uEye.w > 0.0 && de.y > -0.3 && dot(de, de) < uEye.w * uEye.w) discard;
  }
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 v = -normalize(vRel);
  vec3 base = vCol.rgb;
  float spec = 0.08, shin = 24.0;
  if (mat == 1) {
    vec2 cp = (vObj.xz + vObj.yy * 0.6) / uCamoScale;
    float k = texture(uNoise, cp * 0.11 + vEx.w).g * 0.65 + texture(uNoise, cp * 0.31).b * 0.35;
    base *= mix(uCamoA, uCamoB, smoothstep(0.47, 0.53, k));
  } else if (mat == 2) base *= uUnder;
  else if (mat == 3) { base = vec3(0.05, 0.07, 0.09); spec = 1.2; shin = 90.0; }
  else if (mat == 4) { spec = 0.6; shin = 40.0; }
  if (mat == 5) { o = vec4(fogApply(base * 1.6, vRel) * uAlpha, uAlpha); ${LOGZ} return; }
  // soot / damage
  float soot = vEx.x * smoothstep(0.35, 0.75, texture(uNoise, vObj.xz * 0.21 + vObj.yy * 0.13).r + vEx.x * 0.3);
  base *= 1.0 - soot * 0.8;
  float diff = max(dot(n, uSun.xyz), 0.0);
  float sh = cloudShadow(vRel.xz + uCam.xz);
  vec3 amb = mix(vec3(0.42, 0.40, 0.34), vec3(0.62, 0.70, 0.86), n.y * 0.5 + 0.5) * uSunC.w;
  vec3 c = base * (amb + uSunC.rgb * diff * 0.95 * sh);
  vec3 h = normalize(uSun.xyz + v);
  c += uSunC.rgb * spec * pow(max(dot(n, h), 0.0), shin) * sh;
  if (mat == 3) c += sky(reflect(-v, n)) * 0.25;
  c += vec3(1.0, 0.9, 0.7) * vEx.z;
  o = vec4(fogApply(c, vRel) * uAlpha, uAlpha);
  ${LOGZ}
}`;

const TERR_VS = `#version 300 es
precision highp float;
${FRAME}
layout(location=0) in vec2 aGrid;
layout(location=1) in vec4 iNode;     // origin x,z, size, level
uniform highp sampler2D uHeight;
uniform vec4 uMorph[14];
uniform vec4 uHM;                      // x0, cell, N
uniform float uDy;                     // vertical camera distance to the terrain height range (as the CPU LOD selection)
out vec3 vRel; out vec2 vXZ; out float vH; out float vW;
float hf(ivec2 c) { c = clamp(c, ivec2(0), ivec2(int(uHM.z) - 1)); return texelFetch(uHeight, c, 0).r; }
float height(vec2 p) {
  vec2 f = clamp((p - uHM.xx) / uHM.y, vec2(0.0), vec2(uHM.z - 1.001));
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  return mix(mix(hf(i), hf(i + ivec2(1, 0)), t.x), mix(hf(i + ivec2(0, 1)), hf(i + ivec2(1, 1)), t.x), t.y);
}
void main() {
  int L = int(iNode.w);
  float cell = iNode.z / 32.0;
  vec2 wp = iNode.xy + aGrid * cell;
  float d = length(vec3(wp.x - uCam.x, uDy, wp.y - uCam.z));
  float m = clamp((d - uMorph[L].x) * uMorph[L].y, 0.0, 1.0);
  wp -= fract(aGrid * 0.5) * 2.0 * m * cell;
  float h = height(wp);
  vH = h; vXZ = wp;
  vec3 rel = vec3(wp.x, max(h, 0.0), wp.y) - uCam.xyz;
  vRel = rel;
  gl_Position = uVP * vec4(rel, 1.0);
  vW = gl_Position.w;
}`;
const TERR_FS = `#version 300 es
precision highp float;
${COMMON}
in vec3 vRel; in vec2 vXZ; in float vH; in float vW;
uniform sampler2D uNormal, uMat;
uniform vec4 uHM;
uniform vec4 uFA[2];   // centre x,z, u-axis x,z
uniform vec4 uFB[2];   // runway length, width, damage, elevation
out vec4 o;
float hash(vec2 p) {   // integer hash: stable at large coordinates (fract(sin()) bands on some GPUs)
  uvec2 q = uvec2(ivec2(floor(p * 4.0))) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8u) * (1.0 / 16777216.0);
}
vec3 fieldCol(vec2 p, float px, float side) {
  // each farm estate has its own field orientation (wavy borders between estates)
  vec2 reg = floor(p / 2300.0 + (texture(uNoise, p / 31000.0).rg - 0.5) * 1.6);
  float ang = hash(reg + side * 7.0) * 3.14159;
  float c = cos(ang), s = sin(ang);
  vec2 fs = vec2(230.0, 160.0) * (0.6 + 0.9 * hash(reg + 3.0));
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y) / fs;
  q.x += (texture(uNoise, q * 0.013).r - 0.5) * 0.6;
  vec2 id = floor(q), f = fract(q);
  float r = hash(id + side * 31.0);
  vec3 col;
  if (r < 0.34) col = vec3(0.30, 0.43, 0.17);          // pasture
  else if (r < 0.52) col = vec3(0.38, 0.48, 0.20);     // young crops
  else if (r < 0.68) col = vec3(0.62, 0.56, 0.30);     // wheat
  else if (r < 0.80) col = vec3(0.45, 0.36, 0.24);     // ploughed
  else if (r < 0.92) col = vec3(0.34, 0.47, 0.22);
  else col = vec3(0.55, 0.52, 0.28);                   // hay
  // furrows / texture inside the field
  float stripe = sin((q.x * fs.x + hash(id) * 10.0) * (0.9 + r));
  col *= 0.94 + 0.06 * stripe * (1.0 - smoothstep(0.5, 2.0, px));
  vec2 e = min(f, 1.0 - f) * fs;
  float ed = min(e.x, e.y);
  float hedge = (1.0 - smoothstep(2.0, 2.0 + px * 1.2, ed)) * (1.0 - smoothstep(4.0, 14.0, px)) * step(0.15, hash(id + 0.5));
  col = mix(col, vec3(0.13, 0.22, 0.08), hedge);
  return mix(col, vec3(0.38, 0.45, 0.22), smoothstep(30.0, 140.0, px));
}
void main() {
  vec2 p = vXZ;
  vec2 dpx = dFdx(p), dpy = dFdy(p);
  float px = sqrt(abs(dpx.x * dpy.y - dpx.y * dpy.x)) + 1e-3;   // metres per pixel (area)
  vec2 uvT = (p - uHM.xx) / uHM.y / uHM.z + 0.5 / uHM.z;
  vec3 n = normalize(texture(uNormal, uvT).xyz * 2.0 - 1.0);
  vec4 m = texture(uMat, uvT);
  vec3 v = -normalize(vRel);
  float sh = cloudShadow(p);
  float dt = texture(uNoise, p / 37.0).r * 0.6 + texture(uNoise, p / 7.0).g * 0.4;
  vec3 col;
  if (vH < 0.0) {
    // ---------------------------------------------------------------- sea
    float depth = -vH;
    vec3 wc = mix(vec3(0.10, 0.28, 0.27), vec3(0.03, 0.10, 0.14), smoothstep(0.5, 22.0, depth));
    float t = uCam.w;
    vec2 u1 = p / 140.0 + vec2(0.012, 0.007) * t, u2 = p / 53.0 + vec2(-0.01, 0.018) * t, u3 = p / 17.0 + vec2(0.03, -0.02) * t;
    vec4 a = texture(uNoise, u1), b = texture(uNoise, u2), c3 = texture(uNoise, u3);
    float amp = 1.0 - smoothstep(1.5, 25.0, px);
    vec3 wn = normalize(vec3((a.g - 0.5) * 0.5 + (b.b - 0.5) * 0.35 + (c3.r - 0.5) * 0.2 * amp, 1.0, (a.b - 0.5) * 0.5 + (b.g - 0.5) * 0.35 + (c3.g - 0.5) * 0.2 * amp));
    wn = normalize(mix(vec3(0.0, 1.0, 0.0), wn, 0.35 + 0.65 * amp));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(wn, v), 0.0), 5.0);
    vec3 refl = sky(reflect(-v, wn));
    float diff = max(dot(wn, uSun.xyz), 0.0);
    col = wc * (uSunC.w * 0.8 + diff * 0.6 * sh);
    col = mix(col, refl, fres * 0.85);
    vec3 hv = normalize(uSun.xyz + v);
    col += uSunC.rgb * pow(max(dot(wn, hv), 0.0), 220.0) * 2.5 * sh;
    float foam = (1.0 - smoothstep(0.2, 1.6 + a.r * 2.0, depth)) * smoothstep(0.35, 0.6, b.r);
    col = mix(col, vec3(0.85, 0.9, 0.92), foam * 0.8);
    col = mix(col, vec3(0.72, 0.82, 0.85), (1.0 - smoothstep(0.0, 0.35, depth)) * 0.6);
  } else {
    // ---------------------------------------------------------------- land
    float side = p.y > 0.0 ? 1.0 : 0.0;
    col = fieldCol(p, px, side) * (0.88 + 0.24 * dt);
    // forest canopy
    if (m.r > 0.35) {
      float fo = smoothstep(0.35, 0.7, m.r);
      float cn = texture(uNoise, p / 19.0).b * 0.6 + texture(uNoise, p / 6.0).r * 0.4;
      vec3 fc = mix(vec3(0.07, 0.15, 0.05), vec3(0.22, 0.32, 0.12), smoothstep(0.3, 0.75, cn)) * (0.85 + 0.3 * texture(uNoise, p / 170.0).g);
      col = mix(col, fc, fo);
    }
    // towns: roofs and streets
    if (m.g > 0.25) {
      float tw = smoothstep(0.25, 0.6, m.g);
      vec2 tq = p / 22.0;
      float roof = hash(floor(tq));
      vec3 tc = mix(vec3(0.42, 0.40, 0.37), roof > 0.5 ? vec3(0.50, 0.26, 0.20) : vec3(0.36, 0.36, 0.38), step(0.3, fract(tq.x)) * step(0.3, fract(tq.y)));
      col = mix(col, tc, tw * 0.85 * (1.0 - smoothstep(12.0, 40.0, px)) + tw * 0.4 * smoothstep(12.0, 40.0, px));
    }
    // airfield grass (mown)
    if (m.b > 0.5) col = mix(col, vec3(0.33, 0.46, 0.19) * (0.97 + 0.03 * sign(sin(dot(p, uFA[0].zw) / 11.0))) * (0.9 + 0.2 * dt), smoothstep(0.5, 0.9, m.b));
    // steep: rock / chalk
    float steep = 1.0 - smoothstep(0.62, 0.86, n.y);
    vec3 rock = mix(vec3(0.42, 0.40, 0.34), vec3(0.80, 0.80, 0.75), smoothstep(0.2, 0.6, m.a));
    col = mix(col, rock * (0.85 + 0.3 * dt), max(steep, smoothstep(0.2, 0.5, m.a) * (1.0 - smoothstep(0.85, 0.97, n.y))));
    // beach
    col = mix(col, vec3(0.78, 0.72, 0.55) * (0.9 + 0.2 * dt), (1.0 - smoothstep(1.4, 2.6, vH)) * (1.0 - steep));
    // runways, aprons, taxiways
    if (m.b > 0.3) for (int i = 0; i < 2; i++) {      // runways / aprons only inside airfield areas
      vec2 d = p - uFA[i].xy;
      vec2 U = uFA[i].zw, V = vec2(-U.y, U.x);     // V = right of the take-off direction
      float u = dot(d, U), w = dot(d, V);
      float len = uFB[i].x * 0.5, wid = uFB[i].y * 0.5;
      float conc = 0.0;
      if (abs(u) < len && abs(w) < wid) conc = 1.0;
      if (abs(u) < 470.0 && w > 150.0 && w < 245.0) conc = 1.0;                       // apron
      if ((abs(u - 600.0) < 9.0 || abs(u + 600.0) < 9.0) && w > 0.0 && w < 160.0) conc = 1.0;   // taxiways
      if (conc > 0.0) {
        vec3 cc = vec3(0.56, 0.55, 0.52) * (0.9 + 0.15 * dt);
        vec2 slab = fract(vec2(u, w) / vec2(8.0, 7.5));
        cc *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.05, min(slab.x, slab.y))) * (1.0 - smoothstep(0.2, 1.0, px));
        if (abs(u) < len && abs(w) < wid) {
          float mk = 0.0;
          if (abs(w) < 0.5 && fract(u / 30.0) < 0.5) mk = 1.0;                          // centre line
          if (abs(abs(w) - wid + 1.2) < 0.45) mk = 1.0;                                 // edges
          if (abs(u) > len - 30.0 && abs(u) < len - 6.0 && fract((w + wid) / 3.6) < 0.55 && abs(w) < wid - 3.0) mk = 1.0;  // thresholds
          cc = mix(cc, vec3(0.9, 0.9, 0.86), mk * (1.0 - smoothstep(1.0, 3.0, px)));
          cc *= 1.0 - 0.18 * smoothstep(0.4, 0.8, texture(uNoise, p / 31.0).b);    // tyre marks / oil
        }
        col = cc;
      }
    }
    float diff = max(dot(n, uSun.xyz), 0.0);
    vec3 amb = vec3(0.60, 0.68, 0.82) * uSunC.w * (0.75 + 0.25 * n.y);
    col *= amb + uSunC.rgb * diff * sh;
  }
  o = vec4(fogApply(col, vRel), 1.0);
  ${LOGZ}
}`;

const SKY_VS = `#version 300 es
${FRAME}
out vec3 vDir;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vec4 w = uInvVP * vec4(p, 1.0, 1.0);
  vDir = w.xyz / w.w;
#ifdef REVZ
  gl_Position = vec4(p, 0.0, 1.0);
#else
  gl_Position = vec4(p, 1.0, 1.0);
#endif
}`;
const SKY_FS = `#version 300 es
precision highp float;
${COMMON}
in vec3 vDir;
out vec4 o;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = sky(d);
  float s = dot(d, uSun.xyz);
  c += uSunC.rgb * smoothstep(0.99955, 0.9998, s) * 4.0;     // sun disc (blooms)
  // high cirrus
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.08) * 0.35 + uMisc.yz * 0.000004;
    float ci = texture(uNoise, uv * 0.6).g * texture(uNoise, uv * 1.7 + 3.1).r;
    c = mix(c, vec3(1.0, 0.99, 0.97), smoothstep(0.2, 0.5, ci) * 0.35 * smoothstep(0.0, 0.15, d.y));
  }
  o = vec4(c, 1.0);
}`;

// billboards: particles (premultiplied alpha; alpha 0 = additive)
const PART_VS = `#version 300 es
precision highp float;
${FRAME}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPos;     // rel xyz, size
layout(location=2) in vec4 iCol;     // premultiplied rgba
layout(location=3) in vec4 iMisc;    // rotation, atlas tile, stretch, -
out vec2 vUV; out vec4 vCol; out float vTile; flat out float vFog;
float fogAmount(vec3 rel) {
  float hAvg = max(0.0, uCam.y + rel.y * 0.5);
  return 1.0 - exp(-length(rel) * uFogC.w * exp(-hAvg * uZen.w));
}
void main() {
  vec3 right = normalize(uInvVP[0].xyz);
  vec3 up = normalize(uInvVP[1].xyz);
  float c = cos(iMisc.x), s = sin(iMisc.x);
  vec2 q = vec2(c * aCorner.x - s * aCorner.y, s * aCorner.x + c * aCorner.y);
  float d = length(iPos.xyz);
  float size = max(iPos.w, d * uMisc.w * 2.0);
  vec3 p = iPos.xyz + (right * q.x + up * q.y) * size;
  vFog = fogAmount(iPos.xyz);
  vUV = aCorner * 0.5 + 0.5; vTile = iMisc.y;
  vCol = iCol * (iPos.w / size);
  // fade particles that are very close to the camera
  vCol *= smoothstep(0.5, 3.0, d);
  gl_Position = uVP * vec4(p, 1.0);
  ${BBZ('gl_Position.w')}
}`;
const PART_FS = `#version 300 es
precision highp float;
${FRAME}
uniform sampler2D uAtlas;
in vec2 vUV; in vec4 vCol; in float vTile; flat in float vFog;
out vec4 o;
void main() {
  float t = vTile;
  vec2 uv = (vUV + vec2(mod(t, 2.0), floor(t / 2.0))) * 0.5;
  vec4 tx = texture(uAtlas, uv);              // premultiplied
  vec4 c = vCol * tx.a;
  c.rgb *= tx.r / max(tx.a, 1e-4);
  // fog the smoke (not the fire)
  float f = vFog;
  c.rgb = mix(c.rgb, uFogC.rgb * c.a, f * step(0.001, c.a));
  c *= 1.0 - f * step(c.a, 0.001);
  o = c;
}`;

// tracers: view-aligned streaks between head and tail points
const TRACER_VS = `#version 300 es
precision highp float;
${FRAME}
layout(location=0) in vec2 aCorner;   // x: 0 tail .. 1 head, y: -1..1 side
layout(location=1) in vec4 iHead;     // rel xyz, width
layout(location=2) in vec4 iTail;     // rel xyz, brightness
layout(location=3) in vec4 iCol;
out vec4 vCol; out float vSide;
void main() {
  vec3 a = iTail.xyz, b = iHead.xyz;
  vec3 p = mix(a, b, aCorner.x);
  vec3 dir = normalize(b - a + 1e-5);
  vec3 side = normalize(cross(dir, p) + 1e-6);
  float d = length(p);
  float w = max(iHead.w, d * uMisc.w * 1.6);
  p += side * aCorner.y * w;
  vCol = iCol * iTail.w * (iHead.w / w) * (0.35 + 0.65 * aCorner.x);
  vSide = aCorner.y;
  gl_Position = uVP * vec4(p, 1.0);
  ${BBZ('gl_Position.w')}
}`;
const TRACER_FS = `#version 300 es
precision highp float;
in vec4 vCol; in float vSide;
out vec4 o;
void main() {
  float k = 1.0 - vSide * vSide;
  o = vec4(vCol.rgb * k * k * 2.2, 0.0);
}`;

// cloud sprites: sorted, lit by height in the cloud and the sun direction
const CLOUD_VS = `#version 300 es
precision highp float;
${COMMON}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPos;     // rel xyz, size
layout(location=2) in vec4 iMisc;    // shade (0 bottom .. 1 top), rotation, alpha, tile
out vec2 vUV; out float vShade; out float vA; out float vTile; flat out vec4 vFog; flat out float vSunF;
void main() {
  vec3 right = normalize(uInvVP[0].xyz);
  vec3 up = normalize(uInvVP[1].xyz);
  float c = cos(iMisc.y), s = sin(iMisc.y);
  vec2 q = vec2(c * aCorner.x - s * aCorner.y, s * aCorner.x + c * aCorner.y);
  vec3 p = iPos.xyz + (right * q.x + up * q.y) * iPos.w;
  vUV = aCorner * 0.5 + 0.5; vShade = iMisc.x; vTile = iMisc.w;
  vFog = fogParams(iPos.xyz * 0.7);
  vSunF = pow(max(dot(normalize(iPos.xyz), uSun.xyz), 0.0), 4.0);
  float d = length(iPos.xyz);
  vA = iMisc.z * smoothstep(iPos.w * 0.3, iPos.w * 1.3, d);
  gl_Position = uVP * vec4(p, 1.0);
  ${BBZ('gl_Position.w')}
}`;
const CLOUD_FS = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uPuff;
in vec2 vUV; in float vShade; in float vA; in float vTile; flat in vec4 vFog; flat in float vSunF;
out vec4 o;
void main() {
  vec4 t = texture(uPuff, (vUV + vec2(vTile, 0.0)) * vec2(0.5, 1.0));   // premultiplied
  float a = t.a * vA;
  if (a < 0.004) discard;
  float lum = t.r / max(t.a, 1e-4);
  vec3 lit = mix(vec3(0.62, 0.66, 0.74), vec3(1.0, 0.98, 0.95), clamp(vShade * 0.8 + lum * 0.5 - 0.15, 0.0, 1.0));
  lit = lit * (0.85 + 0.25 * uSunC.w) + uSunC.rgb * vSunF * 0.35 * (1.0 - t.a * 0.5);
  vec3 c = mix(lit, vFog.rgb, vFog.a);
  o = vec4(c * a, a);
}`;

// ------------------------------------------------------------------ post
const FS_TRI = `#version 300 es
out vec2 vUV;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const BRIGHT_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex; uniform vec2 uTexel;
in vec2 vUV; out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  c += texture(uTex, vUV + uTexel * vec2(-1, -1)).rgb; c += texture(uTex, vUV + uTexel * vec2(1, -1)).rgb;
  c += texture(uTex, vUV + uTexel * vec2(-1, 1)).rgb; c += texture(uTex, vUV + uTexel * vec2(1, 1)).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.3, 0.55, 0.15));
  o = vec4(c * smoothstep(0.86, 1.0, l), 1.0);
}`;
const BLUR_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex; uniform vec2 uDir;
in vec2 vUV; out vec4 o;
void main() {
  vec3 c = texture(uTex, vUV).rgb * 0.227;
  c += (texture(uTex, vUV + uDir * 1.385).rgb + texture(uTex, vUV - uDir * 1.385).rgb) * 0.316;
  c += (texture(uTex, vUV + uDir * 3.231).rgb + texture(uTex, vUV - uDir * 3.231).rgb) * 0.07;
  o = vec4(c, 1.0);
}`;
const FINAL_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex, uBloom;
uniform vec4 uP;     // x time, y newsreel, z damage flash, w blackout
uniform vec4 uP2;    // x whiteout, y bloom strength, z grain, w redout
uniform vec2 uRes;
in vec2 vUV; out vec4 o;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = vUV;
  vec3 c = texture(uTex, uv).rgb;
  c += texture(uBloom, uv).rgb * uP2.y;
  // gentle filmic curve + warm grade
  c = c * (1.0 + c * 0.08) / (1.0 + c * 0.12);
  c = pow(c, vec3(1.02, 1.0, 0.98));
  vec2 q = uv - 0.5;
  float vig = 1.0 - dot(q, q) * 0.55;
  if (uP.y > 0.5) {
    // newsreel: black and white film, grain, flicker, scratches, gate weave
    float l = dot(c, vec3(0.3, 0.59, 0.11));
    l = (l - 0.5) * 1.25 + 0.5;
    float t = floor(uP.x * 18.0);
    l *= 0.94 + 0.06 * h(vec2(t, 1.0));
    l += (h(uv * uRes + t) - 0.5) * 0.16;
    float sx = h(vec2(t, 7.0));
    l *= 1.0 - 0.35 * smoothstep(0.0012, 0.0, abs(uv.x - sx)) * step(0.6, h(vec2(t, 3.0)));
    vig *= 1.0 - dot(q, q) * 1.2;
    c = vec3(l) * vec3(1.02, 0.98, 0.9);
  } else {
    c += (h(uv * uRes + uP.x) - 0.5) * uP2.z;
  }
  c *= vig;
  // cloud whiteout, damage flash, blackout / redout
  c = mix(c, vec3(0.86, 0.88, 0.9), uP2.x);
  float r = length(q);
  c = mix(c, vec3(0.6, 0.0, 0.0), uP.z * smoothstep(0.2, 0.75, r));
  c = mix(c, vec3(0.0), uP.w * smoothstep(0.75 - uP.w * 0.75, 0.9 - uP.w * 0.5, r * 1.3));
  c = mix(c, vec3(0.45, 0.0, 0.0), uP2.w);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// ------------------------------------------------------------------ helpers
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    throw new Error('shader compile: ' + log + '\n' + lines.slice(0, 4000));
  }
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
  const bi = gl.getUniformBlockIndex(p, 'Frame');
  if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 0);
  return { p, u };
}

// tileable RGBA noise (each channel a different octave mix), also returned for CPU sampling
export function makeNoise(N = 256) {
  const data = new Uint8Array(N * N * 4);
  const lat = (G, seed) => { const a = new Float32Array(G * G); let s = seed >>> 0; for (let i = 0; i < G * G; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; };
  const sample = (a, G, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % G) + G) % G, j0 = ((yi % G) + G) % G, i1 = (i0 + 1) % G, j1 = (j0 + 1) % G;
    const v00 = a[j0 * G + i0], v10 = a[j0 * G + i1], v01 = a[j1 * G + i0], v11 = a[j1 * G + i1];
    return (v00 + (v10 - v00) * fx) * (1 - fy) + (v01 + (v11 - v01) * fx) * fy;
  };
  const octs = [[4, 1], [8, 2], [16, 3], [32, 4], [64, 5]].map(([G, s]) => [G, lat(G, s * 7919)]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, w = 0;
    for (let k = 0; k < 5; k++) {
      const [G, a] = octs[k];
      const v = sample(a, G, x * G / N, y * G / N);
      r += v * [0.5, 0.25, 0.13, 0.07, 0.05][k];
      g += v * [0.15, 0.4, 0.25, 0.12, 0.08][k];
      b += v * [0.05, 0.15, 0.3, 0.3, 0.2][k];
    }
    const a = sample(octs[4][1], 64, x * 64 / N + 17.3, y * 64 / N + 5.1);
    const o = (y * N + x) * 4;
    data[o] = Math.min(255, r * 255); data[o + 1] = Math.min(255, g * 255); data[o + 2] = Math.min(255, b * 255); data[o + 3] = a * 255;
  }
  const at = (u, v, ch = 0) => {   // bilinear, repeat, u/v in texture units (1 = full tile)
    const x = u * N - 0.5, y = v * N - 0.5;
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const g = (i, j) => data[((((j % N) + N) % N) * N + (((i % N) + N) % N)) * 4 + ch] / 255;
    return (g(xi, yi) * (1 - fx) + g(xi + 1, yi) * fx) * (1 - fy) + (g(xi, yi + 1) * (1 - fx) + g(xi + 1, yi + 1) * fx) * fy;
  };
  return { data, N, at };
}

// procedural sprite atlases drawn with canvas 2D
function makeAtlas() {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const g = c.getContext('2d');
  // tile 0: smoke puff (lumpy), tile 1: fire glow, tile 2: spark dot, tile 3: debris chunk
  const puff = (ox, oy) => {
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * 6.28, r = Math.random() * S * 0.2;
      const x = ox + S / 2 + Math.cos(a) * r, y = oy + S / 2 + Math.sin(a) * r, rad = S * (0.18 + Math.random() * 0.14);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const l = 200 + Math.random() * 55;
      gr.addColorStop(0, `rgba(${l},${l},${l},0.55)`); gr.addColorStop(1, `rgba(${l},${l},${l},0)`);
      g.fillStyle = gr; g.fillRect(ox, oy, S, S);
    }
  };
  puff(0, 0);
  let gr = g.createRadialGradient(S * 1.5, S * 0.5, 0, S * 1.5, S * 0.5, S * 0.5);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(S, 0, S, S);
  gr = g.createRadialGradient(S * 0.5, S * 1.5, 0, S * 0.5, S * 1.5, S * 0.22);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, S, S, S);
  g.fillStyle = 'rgba(90,90,90,1)';
  g.beginPath(); g.moveTo(S * 1.3, S * 1.25); g.lineTo(S * 1.75, S * 1.35); g.lineTo(S * 1.62, S * 1.72); g.lineTo(S * 1.38, S * 1.6); g.closePath(); g.fill();
  return c;
}
function makePuffs() {
  const S = 256, c = document.createElement('canvas');
  c.width = S * 2; c.height = S;
  const g = c.getContext('2d');
  for (let t = 0; t < 2; t++) {
    const ox = t * S;
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * 6.28, r = Math.pow(Math.random(), 0.7) * S * 0.28;
      const x = ox + S / 2 + Math.cos(a) * r * 1.1, y = S / 2 + Math.sin(a) * r * 0.75 - S * 0.04, rad = S * (0.1 + Math.random() * 0.12);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const l = Math.round(180 + 75 * (1 - (y - S * 0.25) / (S * 0.5)));
      gr.addColorStop(0, `rgba(${l},${l},${l},0.32)`); gr.addColorStop(0.6, `rgba(${l},${l},${l},0.16)`); gr.addColorStop(1, `rgba(${l},${l},${l},0)`);
      g.fillStyle = gr; g.fillRect(ox, 0, S, S);
    }
  }
  return c;
}

// ------------------------------------------------------------------ renderer
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', desynchronized: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    // integrated GPUs get 2x MSAA and a smaller pixel budget
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    this.integrated = /intel|uhd|iris|mali|adreno|powervr|swiftshader/i.test(this.gpu);
    this.samples = Math.min(this.integrated ? 2 : 4, gl.getParameter(gl.MAX_SAMPLES));
    this.pixelCap = this.integrated ? 2.4e6 : 8.3e6;
    this.drawCalls = 0; this.tris = 0;
    this.resScale = 1; this.W = 0; this.H = 0;
    this.meshes = {};
    this.near = 0.25; this.far = 80000;
    this.proj = m4(); this.view = m4(); this.vp = m4(); this.inv = m4();
    this.frameData = new Float32Array(56);
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.frameData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    // reversed-Z (float depth, [0,1] clip range) when available; ?logz forces the fallback
    this.clip = new URLSearchParams(location.search).has('logz') ? null : gl.getExtension('EXT_clip_control');
    this.revZ = !!this.clip;
    if (this.revZ) this.clip.clipControlEXT(this.clip.LOWER_LEFT_EXT, this.clip.ZERO_TO_ONE_EXT);
    const def = (src) => src.replace('#version 300 es\n', `#version 300 es\n${this.revZ ? '#define REVZ 1\n' : ''}`);
    const pg = (vs, fs) => program(gl, def(vs), def(fs));
    this.progs = {
      obj: pg(OBJ_VS, OBJ_FS), terr: pg(TERR_VS, TERR_FS), sky: pg(SKY_VS, SKY_FS),
      part: pg(PART_VS, PART_FS), tracer: pg(TRACER_VS, TRACER_FS), cloud: pg(CLOUD_VS, CLOUD_FS),
      bright: pg(FS_TRI, BRIGHT_FS), blur: pg(FS_TRI, BLUR_FS), final: pg(FS_TRI, FINAL_FS),
    };
    // textures
    this.noise = makeNoise(256);
    this.noiseTex = this.tex2D(256, 256, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.noise.data, true, true);
    this.atlasTex = this.texFromCanvas(makeAtlas());
    this.puffTex = this.texFromCanvas(makePuffs());
    this.emptyVAO = gl.createVertexArray();
    this.quadVBO = this.buffer(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]));
    this.tracerVBO = this.buffer(new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]));
    this.initBillboards();
    this.fbo = null;
  }

  // ---------------------------------------------------------------- resources
  buffer(data, target = this.gl.ARRAY_BUFFER, usage = this.gl.STATIC_DRAW) {
    const gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(target, b); gl.bufferData(target, data, usage);
    return b;
  }
  tex2D(w, h, ifmt, fmt, type, data, linear = true, repeat = false, mips = repeat) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? (mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR) : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }
  texFromCanvas(c) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // correct mipmaps / filtering at sprite edges
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // a model mesh + its instance buffer (16 floats per instance for dynamic, 8 for static)
  addMesh(name, m, maxInst = 256, stat = false) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = this.buffer(m.data);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.BYTE, true, 20, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 20, 16);
    const ibo = this.buffer(m.index, gl.ELEMENT_ARRAY_BUFFER);
    const stride = stat ? 8 : 16;
    const inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, maxInst * stride * 4, gl.DYNAMIC_DRAW);
    for (let k = 0; k < (stat ? 2 : 4); k++) {
      gl.enableVertexAttribArray(3 + k);
      gl.vertexAttribPointer(3 + k, 4, gl.FLOAT, false, stride * 4, k * 16);
      gl.vertexAttribDivisor(3 + k, 1);
    }
    gl.bindVertexArray(null);
    const mesh = { vao, vbo, ibo, inst, count: m.count, itype: m.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, maxInst, stride, stat, data: new Float32Array(maxInst * stride), n: 0, radius: m.radius, tris: m.count / 3 };
    this.meshes[name] = mesh;
    return mesh;
  }
  // upload instances (Float32Array of n * stride)
  setInstances(mesh, data, n) {
    const gl = this.gl;
    if (n > mesh.maxInst) {
      mesh.maxInst = Math.ceil(n * 1.5);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.inst);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.maxInst * mesh.stride * 4, gl.DYNAMIC_DRAW);
      mesh.data = new Float32Array(mesh.maxInst * mesh.stride);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.inst);
    if (n) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * mesh.stride);
    mesh.n = n;
  }

  // ---------------------------------------------------------------- terrain
  initTerrain(world) {
    const gl = this.gl;
    this.world = world;
    this.hTex = this.tex2D(HM_N, HM_N, gl.R32F, gl.RED, gl.FLOAT, world.h, false);
    this.nTex = this.tex2D(HM_N, HM_N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, world.nrm, true);
    this.mTex = this.tex2D(HM_N, HM_N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, world.mat, true);
    // grid patch 32x32 cells
    const G = 32, verts = new Float32Array((G + 1) * (G + 1) * 2);
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) { verts[(j * (G + 1) + i) * 2] = i; verts[(j * (G + 1) + i) * 2 + 1] = j; }
    const mkIdx = (n) => {
      const idx = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (G + 1) + i, b = a + 1, c = a + G + 1, d = c + 1;
        if ((i + j) % 2) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
      }
      return new Uint16Array(idx);
    };
    const full = mkIdx(G), quarter = mkIdx(G / 2);
    const vbo = this.buffer(verts);
    const mk = (idx) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      const ibo = this.buffer(idx, gl.ELEMENT_ARRAY_BUFFER);
      const inst = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.bufferData(gl.ARRAY_BUFFER, 2048 * 16, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      return { vao, inst, count: idx.length, data: new Float32Array(2048 * 4), n: 0 };
    };
    this.tFull = mk(full); this.tQuarter = mk(quarter);
    // LOD ranges
    this.leaf = 512; this.levels = 8;    // root = 512 * 2^7 = 65536 m; 16 m cells near the camera (heightmap is 48 m)
    this.ranges = []; this.morph = new Float32Array(14 * 4);
    let r = 1440;
    for (let L = 0; L < this.levels; L++) { this.ranges.push(r); r *= 2; }
    for (let L = 0; L < this.levels; L++) {
      const hi = this.ranges[L], lo = L ? this.ranges[L - 1] : 0;
      const start = lo + (hi - lo) * 0.62;
      this.morph[L * 4] = start; this.morph[L * 4 + 1] = 1 / (hi * 0.97 - start);
    }
    this.hMin = -50; this.hMax = 0; for (const h of world.h) if (h > this.hMax) this.hMax = h;
    this.planes = new Float32Array(24);
  }

  extractFrustum() {
    const m = this.vp, P = this.planes;
    const set = (i, a, b, c, d) => { const l = Math.hypot(a, b, c); P[i * 4] = a / l; P[i * 4 + 1] = b / l; P[i * 4 + 2] = c / l; P[i * 4 + 3] = d / l; };
    set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
    set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
    set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
    set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
    if (this.revZ) set(4, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);   // near plane: z <= w
    else set(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);
    set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
  }
  boxVisible(x0, y0, z0, x1, y1, z1) {   // camera-relative AABB
    const P = this.planes;
    for (let i = 0; i < 5; i++) {
      const a = P[i * 4], b = P[i * 4 + 1], c = P[i * 4 + 2], d = P[i * 4 + 3];
      if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
    }
    return true;
  }
  selectTerrain(cam) {
    const T = this, full = this.tFull, quarter = this.tQuarter;
    full.n = 0; quarter.n = 0;
    const cx = cam.x, cy = cam.y, cz = cam.z, y0 = this.hMin - cy, y1 = this.hMax - cy;
    const distBox = (x, z, s) => {
      const dx = Math.max(x - cx, 0, cx - (x + s)), dz = Math.max(z - cz, 0, cz - (z + s));
      const dy = Math.max(T.hMin - cy, 0, cy - T.hMax);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    const add = (buf, x, z, s, L) => {
      if (buf.n >= 2040) return;
      const o = buf.n * 4; buf.data[o] = x; buf.data[o + 1] = z; buf.data[o + 2] = s; buf.data[o + 3] = L; buf.n++;
    };
    const sel = (x, z, s, L) => {
      if (distBox(x, z, s) > this.ranges[L]) return false;
      if (!this.boxVisible(x - cx, y0, z - cz, x + s - cx, y1, z + s - cz)) return true;
      if (L === 0 || distBox(x, z, s) > this.ranges[L - 1]) { add(full, x, z, s, L); return true; }
      const h = s / 2;
      for (let q = 0; q < 4; q++) {
        const qx = x + (q & 1) * h, qz = z + (q >> 1) * h;
        if (!sel(qx, qz, h, L - 1)) {
          if (this.boxVisible(qx - cx, y0, qz - cz, qx + h - cx, y1, qz + h - cz)) add(quarter, qx, qz, s, L);
        }
      }
      return true;
    };
    const root = this.leaf * 2 ** (this.levels - 1);
    sel(-root / 2, -root / 2, root, this.levels - 1);
    const gl = this.gl;
    for (const b of [full, quarter]) { gl.bindBuffer(gl.ARRAY_BUFFER, b.inst); if (b.n) gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.data, 0, b.n * 4); }
  }

  drawTerrain(fields) {
    const gl = this.gl, P = this.progs.terr;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(P.u.uNoise, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.hTex); gl.uniform1i(P.u.uHeight, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.nTex); gl.uniform1i(P.u.uNormal, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.mTex); gl.uniform1i(P.u.uMat, 3);
    if (!this.terrUniforms) {   // static: set once (uniform values live in the program)
      this.terrUniforms = true;
      gl.uniform4fv(P.u.uMorph, this.morph);
      gl.uniform4f(P.u.uHM, HM_X0, HM_CELL, HM_N, 0);
      const fa = new Float32Array(8), fb = new Float32Array(8);
      fields.forEach((f, i) => { fa.set([f.x, f.z, f.ux, f.uz], i * 4); fb.set([f.rwyLen, f.rwyW, 0, f.elev], i * 4); });
      gl.uniform4fv(P.u.uFA, fa); gl.uniform4fv(P.u.uFB, fb);
    }
    const cy = this.cam.pos.y;
    gl.uniform1f(P.u.uDy, Math.max(this.hMin - cy, 0, cy - this.hMax));
    for (const b of [this.tFull, this.tQuarter]) {
      if (!b.n) continue;
      gl.bindVertexArray(b.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0, b.n);
      this.drawCalls++; this.tris += b.count / 3 * b.n;
    }
  }

  // ---------------------------------------------------------------- billboards
  initBillboards() {
    const gl = this.gl;
    const mk = (corner, attrs, maxN) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, corner);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      const inst = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.bufferData(gl.ARRAY_BUFFER, maxN * attrs * 16, gl.DYNAMIC_DRAW);
      for (let k = 0; k < attrs; k++) {
        gl.enableVertexAttribArray(1 + k); gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, attrs * 16, k * 16); gl.vertexAttribDivisor(1 + k, 1);
      }
      gl.bindVertexArray(null);
      return { vao, inst, max: maxN, stride: attrs * 4 };
    };
    this.partBB = mk(this.quadVBO, 3, 16384);
    this.tracerBB = mk(this.tracerVBO, 3, 8192);
    this.cloudBB = mk(this.quadVBO, 2, 4096);
    this.cloudNearBB = mk(this.quadVBO, 2, 2048);
  }
  drawBillboards(bb, prog, data, n, setup) {
    if (!n) return;
    const gl = this.gl;
    n = Math.min(n, bb.max);
    gl.useProgram(prog.p);
    setup(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, bb.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * bb.stride);
    gl.bindVertexArray(bb.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    this.drawCalls++;
  }

  // ---------------------------------------------------------------- frame
  resize(devW, devH) {
    const gl = this.gl;
    if (this.canvas.width !== devW || this.canvas.height !== devH) { this.canvas.width = devW; this.canvas.height = devH; }
    const W = Math.max(2, Math.round(devW * this.resScale)), H = Math.max(2, Math.round(devH * this.resScale));
    if (W === this.W && H === this.H && this.fbo) return;
    this.W = W; this.H = H;
    const del = (x) => {
      if (!x) return;
      if (Array.isArray(x)) return x.forEach(del);
      if (x instanceof WebGLTexture) gl.deleteTexture(x);
      else if (x instanceof WebGLRenderbuffer) gl.deleteRenderbuffer(x);
      else if (x instanceof WebGLFramebuffer) gl.deleteFramebuffer(x);
    };
    if (this.fbo) del([this.fbo, this.msColor, this.msDepth, this.resolveFbo, this.sceneTex, this.bFbo, this.bTex]);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.msColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, W, H);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msColor);
    this.msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, this.revZ ? gl.DEPTH32F_STENCIL8 : gl.DEPTH24_STENCIL8, W, H);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.msDepth);
    this.sceneTex = this.tex2D(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, true);
    this.resolveFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
    // bloom chain at 1/4 resolution (two ping-pong targets)
    const bw = Math.max(1, W >> 2), bh = Math.max(1, H >> 2);
    this.bW = bw; this.bH = bh;
    this.bTex = [0, 1].map(() => this.tex2D(bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, true));
    this.bFbo = this.bTex.map((t) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // cam: {pos, q, fov}; env: {sunDir, sunCol, zen, hor, fogDensity, fogFall, ambient, cloudShadow, cloudOff, time}
  beginFrame(cam, env) {
    const gl = this.gl;
    this.drawCalls = 0; this.tris = 0;
    this.cam = cam;
    const aspect = this.W / this.H;
    if (this.revZ) {   // infinite far plane, depth = near / distance
      const f = 1 / Math.tan(cam.fov / 2), P = this.proj;
      P.fill(0); P[0] = f / aspect; P[5] = f; P[11] = -1; P[14] = this.near;
    } else m4perspective(this.proj, cam.fov, aspect, this.near, this.far);
    this.frameNo = (this.frameNo || 0) + 1;
    m4viewFromQuat(this.view, cam.q);
    m4mul(this.vp, this.proj, this.view);
    invert4(this.inv, this.vp);
    this.extractFrustum();
    const F = this.frameData;
    F.set(this.vp, 0); F.set(this.inv, 16);
    F[32] = cam.pos.x; F[33] = cam.pos.y; F[34] = cam.pos.z; F[35] = env.time;
    F[36] = env.sunDir[0]; F[37] = env.sunDir[1]; F[38] = env.sunDir[2]; F[39] = 2 / Math.log2(this.far + 1) * 0.5;
    F[40] = env.hor[0]; F[41] = env.hor[1]; F[42] = env.hor[2]; F[43] = env.fogDensity;
    F[44] = env.zen[0]; F[45] = env.zen[1]; F[46] = env.zen[2]; F[47] = env.fogFall;
    F[48] = env.sunCol[0]; F[49] = env.sunCol[1]; F[50] = env.sunCol[2]; F[51] = env.ambient;
    F[52] = env.cloudShadow; F[53] = env.cloudOff[0]; F[54] = env.cloudOff[1]; F[55] = 2 * Math.tan(cam.fov / 2) / this.H;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, F);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.depthMask(true);
    gl.clearColor(0.6, 0.7, 0.85, 1); gl.clearDepth(this.revZ ? 0 : 1); gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(this.revZ ? gl.GEQUAL : gl.LEQUAL);
    gl.vertexAttrib4f(5, 0, 0, 0, 0); gl.vertexAttrib4f(6, 0, 0, 0, 0);   // per-instance defaults for static meshes
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  }

  // draw an instanced model. opts: { camo:{a,b,under,scale}, world: bool (instances in world space) }
  drawMesh(mesh, opts = {}) {
    if (!mesh || !mesh.n) return;
    const gl = this.gl, P = this.progs.obj;
    gl.useProgram(P.p);
    if (this._objTex !== this.frameNo) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(P.u.uNoise, 0); this._objTex = this.frameNo; }
    const c = opts.camo || DEFAULT_CAMO;
    gl.uniform3fv(P.u.uCamoA, c.a); gl.uniform3fv(P.u.uCamoB, c.b); gl.uniform3fv(P.u.uUnder, c.under); gl.uniform1f(P.u.uCamoScale, c.scale || 2);
    const o = mesh.stat || opts.world ? this.cam.pos : ZERO;
    gl.uniform3f(P.u.uOrigin, o.x, o.y, o.z);
    gl.uniform1f(P.u.uShadow, opts.shadow ? 1 : 0);
    gl.uniform1f(P.u.uAlpha, opts.alpha ?? 1);
    const e = opts.eye || NO_EYE;
    gl.uniform4f(P.u.uEye, e[0], e[1], e[2], e[3]);
    gl.bindVertexArray(mesh.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.itype, 0, mesh.n);
    this.drawCalls++; this.tris += mesh.tris * mesh.n;
  }
  // planar shadows: stencil so overlapping triangles darken once; multiplicative blend
  beginShadows() {
    const gl = this.gl;
    gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.EQUAL, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.ZERO); gl.depthMask(false);
  }
  endShadows() { const gl = this.gl; gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND); gl.depthMask(true); }

  drawSky() {
    const gl = this.gl, P = this.progs.sky;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(P.u.uNoise, 0);
    gl.depthMask(false);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    this.drawCalls++;
  }

  beginTransparent() {
    const gl = this.gl;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  }
  drawClouds(data, n, near = false) {
    const gl = this.gl;
    this.drawBillboards(near ? this.cloudNearBB : this.cloudBB, this.progs.cloud, data, n, (P) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(P.u.uNoise, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.puffTex); gl.uniform1i(P.u.uPuff, 1);
    });
  }
  drawParticles(data, n) {
    const gl = this.gl;
    this.drawBillboards(this.partBB, this.progs.part, data, n, (P) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(P.u.uNoise, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.atlasTex); gl.uniform1i(P.u.uAtlas, 1);
    });
  }
  drawTracers(data, n) {
    const gl = this.gl;
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawBillboards(this.tracerBB, this.progs.tracer, data, n, () => {});
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  endTransparent() { const gl = this.gl; gl.disable(gl.BLEND); gl.depthMask(true); }

  // resolve MSAA, bloom, grade to the canvas
  endFrame(post) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo);
    gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, this.msAttach || (this.msAttach = [gl.COLOR_ATTACHMENT0, gl.DEPTH_STENCIL_ATTACHMENT]));
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVAO);
    // bloom
    let P = this.progs.bright;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bFbo[0]);
    gl.viewport(0, 0, this.bW, this.bH);
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex); gl.uniform1i(P.u.uTex, 0);
    gl.uniform2f(P.u.uTexel, 1 / this.W, 1 / this.H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    P = this.progs.blur;
    gl.useProgram(P.p); gl.uniform1i(P.u.uTex, 0);
    for (let k = 0; k < 2; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bFbo[1]);
      gl.bindTexture(gl.TEXTURE_2D, this.bTex[0]); gl.uniform2f(P.u.uDir, (1 + k) / this.bW, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bFbo[0]);
      gl.bindTexture(gl.TEXTURE_2D, this.bTex[1]); gl.uniform2f(P.u.uDir, 0, (1 + k) / this.bH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // final
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    P = this.progs.final;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex); gl.uniform1i(P.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bTex[0]); gl.uniform1i(P.u.uBloom, 1);
    gl.uniform4f(P.u.uP, post.time, post.newsreel ? 1 : 0, post.damage, post.blackout);
    gl.uniform4f(P.u.uP2, post.whiteout, post.bloom, post.grain, post.redout);
    gl.uniform2f(P.u.uRes, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls += 7;
    gl.enable(gl.DEPTH_TEST);
  }
}
const ZERO = { x: 0, y: 0, z: 0 };
const NO_EYE = [0, 0, 0, 0];
const DEFAULT_CAMO = { a: [0.3, 0.33, 0.22], b: [0.42, 0.36, 0.26], under: [0.6, 0.62, 0.6], scale: 4 };

function invert4(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
