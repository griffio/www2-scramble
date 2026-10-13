// Standalone WebGL2 viewer for js/models.js (debug tool).
import { buildModels, STATIC_CAMO } from '../js/models.js';
import { MeshBuilder, MAT } from '../js/mesh.js';

const q = new URLSearchParams(location.search);
const view = q.get('view') || '34';
const showMarkers = q.get('markers') === '1';
const showGear = q.get('gear') !== '0';
const showProps = q.get('props') !== '0';
const showGround = q.get('ground') === '1';
const zoom = +(q.get("zoom") || 0.62);
let rot = +(q.get('rot') || 0) * Math.PI / 180, elev = +(q.get('elev') || 0) * Math.PI / 180;

const t0 = performance.now();
const M = buildModels();
console.log(`buildModels ${(performance.now() - t0).toFixed(0)} ms`);

let names = (q.get('m') || 'aircraft.spitfire').split(',');
names = names.flatMap((n) => (n.endsWith('.*') ? Object.keys(M[n.slice(0, -2)]).map((k) => n.slice(0, -1) + k) : [n]));

const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: true });
const dpr = Math.min(2, devicePixelRatio || 1);
canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;

const VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec4 aNrm; layout(location=2) in vec4 aCol;
uniform mat4 uVP, uM;
out vec3 vN; out vec3 vP; out vec3 vWP; out vec3 vC; flat out int vMat;
void main(){ vec4 wp = uM * vec4(aPos,1.0); vWP = wp.xyz; vP = aPos; vN = mat3(uM) * aNrm.xyz; vC = aCol.rgb; vMat = int(aCol.a*255.0+0.5); gl_Position = uVP * wp; }`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP; in vec3 vWP; in vec3 vC; flat in int vMat;
uniform vec3 uCamA, uCamB, uUnder, uEye; uniform float uScale; uniform vec3 uTint; uniform int uNoGlass;
out vec4 o;
float pat(vec3 p){ p /= uScale; return sin(p.x*1.3 + 1.7*sin(p.z*0.9 + 0.4*p.y)) * sin(p.z*1.1 + 1.3*sin(p.x*0.7 + 0.8)) + 0.35*sin(p.y*2.1+p.x*0.6); }
void main(){
  vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n;
  vec3 L = normalize(vec3(0.45, 0.8, 0.35)); vec3 V = normalize(uEye - vWP);
  if (uNoGlass == 1 && vMat == 3) discard;
  vec3 base = vC; float spec = 0.0;
  if (vMat == 1) base *= (pat(vP) > 0.0 ? uCamA : uCamB);
  else if (vMat == 2) base *= uUnder;
  else if (vMat == 3) { base = vec3(0.06,0.09,0.14) + 0.25*vec3(0.5,0.6,0.7)*max(0.0,n.y); spec = 1.0; }
  else if (vMat == 4) { base *= 0.6; spec = 0.6; }
  else if (vMat == 5) { o = vec4(vC, 1.0); return; }
  float d = max(dot(n, L), 0.0);
  float hemi = 0.5 + 0.5*n.y;
  vec3 col = base * (0.28 + 0.22*hemi + 0.75*d);
  vec3 H = normalize(L + V); col += spec * pow(max(dot(n,H),0.0), 40.0) * 0.8;
  o = vec4(pow(col*uTint, vec3(1.0/1.2)), 1.0);
}`;
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
const U = {}; for (const n of ['uVP', 'uM', 'uCamA', 'uCamB', 'uUnder', 'uScale', 'uEye', 'uTint', 'uNoGlass']) U[n] = gl.getUniformLocation(prog, n);

function upload(m) {
  if (m._gl) return m._gl;
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.BYTE, true, 20, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 20, 16);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.index, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  m._gl = { vao, type: m.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  return m._gl;
}

// ---- mat4 (column-major)
const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const persp = (fov, asp, n, f) => { const t = 1 / Math.tan(fov / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]); };
const nrm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function lookAt(e, t, up) { const z = nrm([e[0] - t[0], e[1] - t[1], e[2] - t[2]]), x = nrm(crs(up, z)), y = crs(z, x); return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2]), -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2]), -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2]), 1]); }
const tr = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const sc = (s) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
const rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); };
const I = tr(0, 0, 0);

function bbox(m) { const f = new Float32Array(m.data), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let v = 0; v < m.vcount; v++) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], f[v * 5 + j]); hi[j] = Math.max(hi[j], f[v * 5 + j]); } return { lo, hi }; }

// marker mesh (octahedron)
function octa(col) { const b = new MeshBuilder(), s = 1; const P = [[s, 0, 0], [-s, 0, 0], [0, s, 0], [0, -s, 0], [0, 0, s], [0, 0, -s]]; const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]; for (const [a, c, d] of F) b.tri(P[a], P[c], P[d], col, MAT.EMIT); return b.build(); }
const MK = { gun: octa([1, 0.1, 0.1]), hp: octa([1, 0.55, 0]), wheel: octa([0.1, 1, 0.2]), cockpit: octa([0, 1, 1]), prop: octa([1, 0, 1]), gunner: octa([1, 1, 0]), exhaust: octa([1, 1, 1]), engine: octa([0.6, 0.2, 1]) };
const ground = (() => { const b = new MeshBuilder(); const s = 200; b.quad([-s, -0.02, s], [s, -0.02, s], [s, -0.02, -s], [-s, -0.02, -s], [0.32, 0.45, 0.22], MAT.PLAIN); for (let i = -10; i <= 10; i++) { b.quad([i * 10 - 0.05, -0.01, -100], [i * 10 + 0.05, -0.01, -100], [i * 10 + 0.05, -0.01, 100], [i * 10 - 0.05, -0.01, 100], [0.25, 0.35, 0.18], MAT.PLAIN); } return b.build(); })();

const VIEWS = {
  '34': { d: [-1.0, 0.55, -1.15] }, side: { d: [-1, 0.03, 0] }, sider: { d: [1, 0.03, 0] }, top: { d: [0, 1, 0.0001], up: [0, 0, -1] },
  bottom: { d: [0, -1, 0.0001], up: [0, 0, -1] }, front: { d: [0, 0.08, -1] }, rear: { d: [0, 0.22, 1] }, r34: { d: [1.0, 0.5, 1.2] }, chase: { d: [0, 0.18, 1], chase: true }, cockpit: { d: [0, 0, 1], cockpit: true },
};
const V = VIEWS[view] || VIEWS['34'];

const items = names.map((n) => {
  const [grp, key] = n.split('.');
  const obj = M[grp]?.[key];
  if (!obj) { console.error('no model', n); return null; }
  const ac = grp === 'aircraft' ? obj : null;
  const body = ac ? ac.body : obj;
  const bb = bbox(body);
  const tris = body.count / 3 + (ac && showGear ? ac.gear.count / 3 : 0);
  return { name: n, ac, body, bb, tris, camo: ac ? ac.camo : { ...STATIC_CAMO, scale: 3 } };
}).filter(Boolean);

const cols = Math.ceil(Math.sqrt(items.length)), rows = Math.ceil(items.length / cols);
const labels = items.map((it) => { const d = document.createElement('div'); d.className = 'lbl'; d.textContent = `${it.name}  ${it.tris} tris  r=${it.body.radius.toFixed(1)}` + (it.ac ? `  span ${it.ac.span} len ${it.ac.length}` : ''); document.body.appendChild(d); return d; });

function draw(m, model, VP) { const g = upload(m); gl.uniformMatrix4fv(U.uM, false, model); gl.bindVertexArray(g.vao); gl.drawElements(gl.TRIANGLES, m.count, g.type, 0); }

function frame() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.56, 0.65, 0.74, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.SCISSOR_TEST);
  gl.useProgram(prog);
  const tw = canvas.width / cols, th = canvas.height / rows;
  items.forEach((it, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    const x0 = Math.floor(cx * tw), y0 = Math.floor(canvas.height - (cy + 1) * th);
    gl.viewport(x0, y0, Math.floor(tw), Math.floor(th)); gl.scissor(x0, y0, Math.floor(tw), Math.floor(th));
    gl.clear(gl.DEPTH_BUFFER_BIT);
    labels[i].style.left = (cx * tw) / dpr + 'px'; labels[i].style.top = (cy * th) / dpr + 'px';
    const { lo, hi } = it.bb;
    const tgt = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const rad = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    let d = V.d.slice();
    // yaw / elevation offsets
    const cr = Math.cos(rot), sr = Math.sin(rot); d = [d[0] * cr + d[2] * sr, d[1], -d[0] * sr + d[2] * cr];
    d = nrm(d); if (elev) { d[1] += elev; d = nrm(d); }
    const fov = (V.cockpit ? 75 : 35) * Math.PI / 180, asp = tw / th;
    let dist = (rad / Math.sin(fov / 2)) * 1.02 * zoom;
    if (asp < 1) dist /= asp;
    let eye = [tgt[0] + d[0] * dist, tgt[1] + d[1] * dist, tgt[2] + d[2] * dist];
    let look = tgt;
    if (V.chase) { eye = [0, 4 * zoom, 20 * zoom]; look = [0, 1, -10]; }
    if (V.cockpit && it.ac) { eye = it.ac.cockpit.slice(); look = [eye[0] - Math.sin(rot) * 10, eye[1] + Math.sin(elev) * 10 - 0.6, eye[2] - Math.cos(rot) * 10]; }
    gl.uniform1i(U.uNoGlass, V.cockpit ? 1 : 0);
    const VP = mul(persp(fov, asp, V.cockpit ? 0.05 : 0.1, dist * 4 + 500), lookAt(eye, look, V.up || [0, 1, 0]));
    gl.uniformMatrix4fv(U.uVP, false, VP); gl.uniform3fv(U.uEye, eye);
    gl.uniform3fv(U.uCamA, it.camo.a); gl.uniform3fv(U.uCamB, it.camo.b); gl.uniform3fv(U.uUnder, it.camo.under); gl.uniform1f(U.uScale, it.camo.scale || 2); gl.uniform3fv(U.uTint, [1, 1, 1]);
    if (showGround) draw(ground, I, VP);
    draw(it.body, I, VP);
    const ac = it.ac;
    if (ac) {
      if (showGear) draw(ac.gear, I, VP);
      if (showProps) ac.props.forEach((p, j) => draw(M.props[p.blades === 4 ? 'prop4' : 'prop3'], mul(tr(p.x, p.y, p.z), mul(sc(p.r), rz(0.35 + j))), VP));
      if (showMarkers) {
        gl.disable(gl.DEPTH_TEST);
        const s = 0.09;
        const mk = (m, p) => draw(m, mul(tr(p[0], p[1], p[2]), sc(s)), VP);
        ac.guns.forEach((g) => mk(MK.gun, [g.x, g.y, g.z]));
        ac.hardpoints.forEach((g) => mk(MK.hp, [g.x, g.y, g.z]));
        ac.gunners.forEach((g) => mk(MK.gunner, [g.x, g.y, g.z]));
        ac.exhausts.forEach((g) => mk(MK.exhaust, [g.x, g.y, g.z]));
        ac.engines.forEach((g) => mk(MK.engine, [g.x, g.y, g.z]));
        ac.props.forEach((g) => mk(MK.prop, [g.x, g.y, g.z]));
        mk(MK.wheel, ac.mainWheel); mk(MK.wheel, [-ac.mainWheel[0], ac.mainWheel[1], ac.mainWheel[2]]); mk(MK.wheel, ac.tailWheel); mk(MK.cockpit, ac.cockpit);
        gl.enable(gl.DEPTH_TEST);
      }
      // bombs on hardpoints
      if (q.get('bombs') === '1') ac.hardpoints.forEach((h) => draw(M.statics[h.kind], tr(h.x, h.y, h.z), VP));
    }
  });
  gl.disable(gl.SCISSOR_TEST);
}

// drag to orbit
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', (e) => { if (!drag) return; rot -= (e.clientX - drag[0]) * 0.01; elev += (e.clientY - drag[1]) * 0.01; drag = [e.clientX, e.clientY]; requestAnimationFrame(frame); });
addEventListener('resize', () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; frame(); });
frame();
console.log('rendered', names.join(','));
