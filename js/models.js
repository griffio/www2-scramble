// Procedural 3D models: aircraft, propellers and static scenery.
// Pure geometry (no DOM / WebGL) - safe to import in Node.
// Axes: x = right, y = up, -z = forward. Metres.
import { MeshBuilder, MAT, T, RX, RY, RZ, chain, sub, cross, norm, faceNormal } from './mesh.js';

const PI = Math.PI, TAU = PI * 2, DEG = PI / 180;
const W = [1, 1, 1];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sgnpow = (v, e) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- palette
const COL = {
  rafRed: [0.68, 0.12, 0.11], rafBlue: [0.13, 0.17, 0.42], rafWhite: [0.93, 0.93, 0.9], rafYellow: [0.97, 0.78, 0.1],
  sky: [0.72, 0.8, 0.64], black: [0.04, 0.04, 0.045], white: [0.95, 0.95, 0.93], yellow: [0.98, 0.8, 0.08],
  tyre: [0.07, 0.07, 0.07], strut: [0.55, 0.56, 0.56], hub: [0.42, 0.43, 0.43], intake: [0.04, 0.04, 0.04],
  exhaust: [0.3, 0.22, 0.18], glow: [1.0, 0.42, 0.1], gun: [0.12, 0.12, 0.13], spinGer: [0.11, 0.14, 0.1],
  codes: [0.62, 0.66, 0.6], blade: [0.06, 0.06, 0.06],
};

// ---------------------------------------------------------------- monotone cubic interpolation
function mono(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ---------------------------------------------------------------- lofted body of super-elliptic sections
// keys: [z, halfWidth, heightAbove, heightBelow, yCentre = 0, exponent = 2]
class Body {
  constructor(keys) {
    this.zs = keys.map((k) => k[0]);
    const col = (j, d) => keys.map((k) => (k[j] ?? d));
    this.fw = mono(this.zs, col(1)); this.fht = mono(this.zs, col(2)); this.fhb = mono(this.zs, col(3));
    this.fyc = mono(this.zs, col(4, 0)); this.fn = mono(this.zs, col(5, 2));
  }
  sec(z) { return { w: this.fw(z), ht: this.fht(z), hb: this.fhb(z), yc: this.fyc(z), n: this.fn(z) }; }
  pt(z, th, off = 0) {
    const s = this.sec(z), c = Math.cos(th), sn = Math.sin(th), e = 2 / s.n, h = sn >= 0 ? s.ht : s.hb;
    const x = s.w * sgnpow(c, e), y = h * sgnpow(sn, e);
    if (!off) return [x, s.yc + y, z];
    const ee = (2 * (s.n - 1)) / s.n;
    let nx = sgnpow(c, ee) / s.w, ny = sgnpow(sn, ee) / h;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    return [x + nx * off, s.yc + y + ny * off, z];
  }
  // point on the right (side>0) or left side at height y
  side(z, y, side, off = 0) {
    const s = this.sec(z), yy = y - s.yc, h = yy >= 0 ? s.ht : s.hb;
    const a = clamp(Math.abs(yy) / h, 0, 0.995);
    let th = Math.asin(Math.sign(yy) * Math.pow(a, s.n / 2));
    if (side < 0) th = PI - th;
    return this.pt(z, th, off);
  }
  ring(z, K, th0 = 0, th1 = TAU, closed = true, off = 0) {
    const out = [];
    for (let k = 0; k < K; k++) out.push(this.pt(z, th0 + ((th1 - th0) * k) / (closed ? K : K - 1), off));
    return out;
  }
  zsamp(step, z0 = this.zs[0], z1 = this.zs[this.zs.length - 1]) {
    const ks = [z0, ...this.zs.filter((z) => z > z0 + 1e-6 && z < z1 - 1e-6), z1];
    const out = [];
    for (let i = 0; i < ks.length - 1; i++) {
      const n = Math.max(1, Math.ceil((ks[i + 1] - ks[i]) / step));
      for (let j = 0; j < n; j++) out.push(ks[i] + ((ks[i + 1] - ks[i]) * j) / n);
    }
    out.push(z1);
    return out;
  }
  rings(step, K, { th0 = 0, th1 = TAU, closed = true, off = 0, z0, z1 } = {}) {
    return this.zsamp(step, z0, z1).map((z) => this.ring(z, K, th0, th1, closed, off));
  }
}

// Loft with smooth normals over the whole grid but per-face colour / material (vertices are split
// where the material changes, so no triangle ever mixes material ids).
// faceFn(r, k, centroid, isCap) -> [r, g, b, mat]
function loftM(b, rings, faceFn, { closed = true, capStart = false, capEnd = false } = {}) {
  const R = rings.length, K = rings[0].length;
  const ff = typeof faceFn === 'function' ? faceFn : () => faceFn;
  const N = [];
  for (let r = 0; r < R; r++) {
    const row = [];
    for (let k = 0; k < K; k++) {
      const pr0 = rings[Math.max(0, r - 1)][k], pr1 = rings[Math.min(R - 1, r + 1)][k];
      const k0 = closed ? (k - 1 + K) % K : Math.max(0, k - 1), k1 = closed ? (k + 1) % K : Math.min(K - 1, k + 1);
      const n = cross(sub(rings[r][k1], rings[r][k0]), sub(pr1, pr0));
      const l = len3(n);
      row.push(l < 1e-10 ? null : scl3(n, 1 / l));
    }
    N.push(row);
  }
  // collapsed rings (pointed ends): average the neighbouring ring's normals (keeps winding agreement)
  for (let r = 0; r < R; r++) {
    for (let k = 0; k < K; k++) {
      if (N[r][k]) continue;
      const rr = r === 0 ? 1 : r - 1;
      let s = [0, 0, 0];
      for (let j = 0; j < K; j++) if (N[rr][j]) s = add3(s, N[rr][j]);
      N[r][k] = len3(s) > 1e-9 ? norm(s) : [0, 1, 0];
    }
  }
  const cache = new Map();
  const V = (r, k, col) => {
    const key = r * K + k + '|' + col[0] + ',' + col[1] + ',' + col[2] + ',' + col[3];
    let i = cache.get(key);
    if (i === undefined) { const p = rings[r][k], n = N[r][k]; i = b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], col, col[3]); cache.set(key, i); }
    return i;
  };
  const kmax = closed ? K : K - 1;
  for (let r = 0; r < R - 1; r++) {
    for (let k = 0; k < kmax; k++) {
      const k1 = (k + 1) % K;
      const p0 = rings[r][k], p1 = rings[r][k1], p2 = rings[r + 1][k1], p3 = rings[r + 1][k];
      const ctr = scl3(add3(add3(p0, p1), add3(p2, p3)), 0.25);
      const col = ff(r, k, ctr, false);
      const a = V(r, k, col), d = V(r, k1, col), c = V(r + 1, k1, col), bb = V(r + 1, k, col);
      b.index(a, d, c); b.index(a, c, bb);
    }
  }
  const cap = (ring, flip, r) => {
    const ctr = ring.reduce((s, p) => [s[0] + p[0] / K, s[1] + p[1] / K, s[2] + p[2] / K], [0, 0, 0]);
    for (let k = 0; k < kmax; k++) {
      const a = ring[k], c = ring[(k + 1) % K];
      const col = ff(r, k, ctr, true);
      if (flip) b.tri(ctr, c, a, col, col[3]); else b.tri(ctr, a, c, col, col[3]);
    }
  };
  if (capStart) cap(rings[0], false, 0);
  if (capEnd) cap(rings[R - 1], true, R - 1);
  return b;
}

// camo above / under below a boundary `deg` below the horizontal (by ring index)
const splitMat = (K, deg, capCol = null) => (r, k, p, isCap) => {
  if (isCap && capCol) return capCol;
  return Math.sin((TAU * (k + 0.5)) / K) < -Math.sin(deg * DEG) ? [1, 1, 1, MAT.UNDER] : [1, 1, 1, MAT.CAMO];
};
const solid = (col, mat) => [...col, mat];
const underMat = (capCol) => (r, k, p, isCap) => (isCap && capCol ? capCol : [1, 1, 1, MAT.UNDER]);

// ---------------------------------------------------------------- wings
// mesh.wing's `thick` produces total thickness 0.21 * thick * chord; this wrapper takes the real ratio.
const WTH = 0.21;
const thickAt = (t) => { const x = Math.max(t, 1e-4); return 2.4 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x); };
// Resample stations along the span with monotone cubics, so tip outlines, fin tops and gull bends come
// out as smooth curves instead of a few straight segments. Original stations are kept.
function smoothStations(st, step = 0.3, dmax = 0.08) {
  if (st.length < 3) return st;
  const xs = st.map((s) => s.x), f = {};
  for (const k of ['y', 'z', 'chord', 'thick', 'twist']) f[k] = mono(xs, st.map((s) => s[k]));
  const out = [];
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    const n = Math.max(1, Math.ceil(Math.max((b.x - a.x) / step, Math.abs(b.chord - a.chord) / dmax, Math.abs(b.z - a.z) / dmax)));
    out.push(a);
    for (let j = 1; j < n; j++) { const x = lerp(a.x, b.x, j / n); out.push({ x, y: f.y(x), z: f.z(x), chord: f.chord(x), thick: f.thick(x), twist: f.twist(x) }); }
  }
  out.push(st[st.length - 1]);
  return roundTip(out);
}
// Round off the last stretch of span (radius = half the tip chord) about the mid-chord line, so tips
// close in a curve instead of ending on a flat chord. The span is unchanged.
function roundTip(st) {
  const e = st[st.length - 1], rt = Math.min(0.5 * e.chord, 0.4);
  if (rt < 0.04 || st.length < 2) return st;
  const x0 = e.x - rt, at = (x) => { let i = 0; while (i < st.length - 2 && st[i + 1].x < x) i++; const a = st[i], b = st[i + 1], t = clamp((x - a.x) / (b.x - a.x), 0, 1); return { x, y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), chord: lerp(a.chord, b.chord, t), thick: lerp(a.thick, b.thick, t), twist: lerp(a.twist, b.twist, t) }; };
  const out = st.filter((s) => s.x < x0 - 1e-6);
  const N = 6;
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * (PI / 2), s = at(x0 + rt * Math.sin(a)), mid = s.z + s.chord / 2, c = Math.max(0.03, s.chord * Math.cos(a));
    out.push({ ...s, z: mid - c / 2, chord: c });
  }
  return out;
}
class Wing {
  constructor(st) { this.st = smoothStations(st.map((s) => ({ y: 0, twist: 0, ...s }))); }
  at(x) {
    const st = this.st;
    if (x <= st[0].x) return st[0];
    if (x >= st[st.length - 1].x) return st[st.length - 1];
    let i = 0; while (x > st[i + 1].x) i++;
    const a = st[i], b = st[i + 1], t = (x - a.x) / (b.x - a.x);
    return { x, y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), chord: lerp(a.chord, b.chord, t), thick: lerp(a.thick, b.thick, t), twist: lerp(a.twist, b.twist, t) };
  }
  pt(x, t, side) {
    const s = this.at(x), th = thickAt(t) * (s.thick / WTH) * s.chord * 0.5;
    const dy = s.twist ? -Math.sin(s.twist) * (t - 0.25) * s.chord : 0;
    return [x, s.y + dy + (side > 0 ? th : -0.75 * th), s.z + t * s.chord];
  }
  // point offset `off` along the outward airfoil normal
  ptN(x, t, side, off = 0) {
    const p = this.pt(x, t, side);
    if (!off) return p;
    const e = 0.01, pa = this.pt(x, Math.max(0, t - e), side), pb = this.pt(x, Math.min(1, t + e), side);
    let ny = -(pb[2] - pa[2]), nz = pb[1] - pa[1];
    const l = Math.hypot(ny, nz) || 1; ny /= l; nz /= l;
    const s = this.at(x), qy = s.y, qz = s.z + 0.35 * s.chord;
    if (ny * (p[1] - qy) + nz * (p[2] - qz) < 0) { ny = -ny; nz = -nz; }
    return [p[0], p[1] + ny * off, p[2] + nz * off];
  }
  surf(x, z, side, off = 0) { const s = this.at(x); return this.ptN(x, clamp((z - s.z) / s.chord, 0, 1), side, off); }
  tAt(x, z) { const s = this.at(x); return (z - s.z) / s.chord; }
  build(b, colUp = W, matUp = MAT.CAMO, colDn = W, matDn = MAT.UNDER, segs = 8) {
    b.wing(this.st.map((s) => ({ ...s, thick: s.thick / WTH })), colUp, matUp, colDn, matDn, { segs });
    return this;
  }
  // chart projection for markings: (u = x, v = z) -> surface point
  proj(side, off = 0.02) { return (u, v, o = 0) => this.surf(u, v, side, off + o); }
}

// wing overlay strip wrapping the leading edge (t <= tMax on both surfaces)
function wingLE(b, wing, x0, x1, tMax, col, mat, off = 0.012, nx = 6, nu = 6) {
  const P = (x, u) => wing.ptN(x, tMax * u * u, u < 0 ? -1 : 1, off);
  for (let i = 0; i < nx; i++) {
    const xa = lerp(x0, x1, i / nx), xb = lerp(x0, x1, (i + 1) / nx);
    for (let j = 0; j < nu; j++) {
      const ua = -1 + (2 * j) / nu, ub = -1 + (2 * (j + 1)) / nu;
      b.quad(P(xa, ua), P(xa, ub), P(xb, ub), P(xb, ua), col, mat);
    }
  }
}
// wing overlay patch over span [x0,x1] and chord fraction [t0,t1] on one side
function wingPatch(b, wing, x0, x1, t0, t1, side, col, mat = MAT.MARK, off = 0.012, nx = 4, nt = 3) {
  const P = (x, t) => wing.ptN(x, t, side, off);
  for (let i = 0; i < nx; i++) {
    const xa = lerp(x0, x1, i / nx), xb = lerp(x0, x1, (i + 1) / nx);
    for (let j = 0; j < nt; j++) {
      const ta = lerp(t0, t1, j / nt), tb = lerp(t0, t1, (j + 1) / nt);
      b.quad(P(xa, ta), P(xa, tb), P(xb, tb), P(xb, ta), col, mat);
    }
  }
}

// Concave fillet (right side) blending the upper wing surface into the fuselage side. It starts at chord
// fraction t0, reaches radius rMax by tFull, and runs `aft` metres past the trailing edge, where it
// fades into the fuselage side.
function wingFillet(b, fus, wing, { t0 = 0.04, tFull = 0.7, rMax = 0.3, aft = 0.6, n = 14, na = 5, m = 6, mat = MAT.CAMO } = {}) {
  const ss = (t) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
  const s0 = wing.at(0), zm = s0.z + 0.5 * s0.chord;
  const xr = fus.side(zm, s0.y, 1)[0], sw = wing.at(xr), zTE = sw.z + sw.chord;
  const rings = [], base = [];
  let xs = xr, yw = s0.y, rTE = rMax;
  for (let i = 0; i <= n + na; i++) {
    let z, r, B;
    if (i <= n) {
      const t = lerp(t0, 1, i / n);
      z = sw.z + t * sw.chord;
      for (let it = 0; it < 3; it++) { yw = wing.surf(xs, z, 1)[1]; xs = fus.side(z, yw, 1)[0]; }
      r = rTE = Math.max(0.01, rMax * ss((t - t0) / (tFull - t0)));
      B = wing.surf(xs + r, z, 1, -0.004);
    } else {
      // past the trailing edge: no wing below, so the fillet rides on the trailing-edge height and shrinks away
      const u = (i - n) / na;
      z = zTE + aft * u;
      xs = fus.side(z, yw, 1)[0];
      r = Math.max(0.01, rTE * (1 - ss(u)));
      B = [xs + r, yw, z];
    }
    const A = fus.side(z, yw + r, 1, -0.004), C = [xs, yw, z];
    const ring = [];
    for (let j = 0; j <= m; j++) {
      const u = j / m, a = (1 - u) * (1 - u), c = 2 * u * (1 - u), d = u * u;
      ring.push([a * A[0] + c * C[0] + d * B[0], a * A[1] + c * C[1] + d * B[1], z]);
    }
    rings.push(ring);
    if (i >= n) base.push([C, B]);
  }
  loftM(b, rings, solid(W, mat), { closed: false });
  // underside of the part behind the trailing edge
  loftM(b, base, solid(W, MAT.UNDER), { closed: false });
}

// ---------------------------------------------------------------- markings (2D chart -> surface)
function mRect(b, proj, u0, v0, u1, v1, col, o = 0, nu = 1, nv = 1) {
  if (u0 > u1) [u0, u1] = [u1, u0];
  if (v0 > v1) [v0, v1] = [v1, v0];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const ua = lerp(u0, u1, i / nu), ub = lerp(u0, u1, (i + 1) / nu), va = lerp(v0, v1, j / nv), vb = lerp(v0, v1, (j + 1) / nv);
    b.quad(proj(ua, va, o), proj(ub, va, o), proj(ub, vb, o), proj(ua, vb, o), col, MAT.MARK);
  }
}
function mAnnulus(b, proj, cu, cv, r0, r1, col, o = 0, n = 16) {
  const nr = Math.max(1, Math.ceil((r1 - r0) / 0.26));   // radial subdivisions so marks follow curved surfaces
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * TAU, a1 = ((k + 1) / n) * TAU;
    const P = (r, a) => proj(cu + Math.cos(a) * r, cv + Math.sin(a) * r, o);
    for (let j = 0; j < nr; j++) {
      const ra = lerp(r0, r1, j / nr), rb = lerp(r0, r1, (j + 1) / nr);
      if (ra <= 0) b.tri(proj(cu, cv, o), P(rb, a0), P(rb, a1), col, MAT.MARK);
      else b.quad(P(ra, a0), P(rb, a0), P(rb, a1), P(ra, a1), col, MAT.MARK);
    }
  }
}
function roundelB(b, proj, u, v, r) { mAnnulus(b, proj, u, v, 0.4 * r, r, COL.rafBlue); mAnnulus(b, proj, u, v, 0, 0.4 * r, COL.rafRed, 0, 12); }
function roundelC1(b, proj, u, v, r) {
  mAnnulus(b, proj, u, v, 0.89 * r, r, COL.rafYellow, 0, 18);
  mAnnulus(b, proj, u, v, 0.45 * r, 0.89 * r, COL.rafBlue, 0, 18);
  mAnnulus(b, proj, u, v, 0.34 * r, 0.45 * r, COL.rafWhite, 0, 16);
  mAnnulus(b, proj, u, v, 0, 0.34 * r, COL.rafRed, 0, 12);
}
function balken(b, proj, u, v, s) {
  const a = s * 0.2, w = s * 0.085, h = s / 2;
  mRect(b, proj, u - h, v - a / 2 - w, u + h, v + a / 2 + w, COL.white, 0, 3, 1);
  mRect(b, proj, u - a / 2 - w, v - h, u + a / 2 + w, v + h, COL.white, 0, 1, 3);
  mRect(b, proj, u - h, v - a / 2, u + h, v + a / 2, COL.black, 0.006, 3, 1);
  mRect(b, proj, u - a / 2, v - h, u + a / 2, v + h, COL.black, 0.006, 1, 3);
}
const FONT = {
  A: ['010', '101', '111', '101', '101'], D: ['110', '101', '101', '101', '110'], E: ['111', '100', '110', '100', '111'],
  G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'], K: ['101', '101', '110', '101', '101'],
  T: ['111', '010', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'], N: ['101', '111', '111', '111', '101'],
};
// u advances in direction `dir` from u0 (reading left->right as the viewer sees it), v = vertical
function mText(b, proj, str, u0, vc, h, dir, col) {
  const ph = h / 5, pw = (h * 0.62) / 3, gap = h * 0.22;
  let u = u0;
  for (const ch of str) {
    const gl = FONT[ch];
    if (gl) {
      for (let r = 0; r < 5; r++) {
        const row = gl[r];
        let c = 0;
        while (c < 3) {
          if (row[c] !== '1') { c++; continue; }
          let c1 = c; while (c1 + 1 < 3 && row[c1 + 1] === '1') c1++;
          const va = vc + h / 2 - (r + 1) * ph;
          mRect(b, proj, u + dir * c * pw, va, u + dir * (c1 + 1) * pw, va + ph, col, 0, c1 - c + 1, 1);
          c = c1 + 1;
        }
      }
    }
    u += dir * (3 * pw + gap);
  }
}
const textWidth = (str, h) => str.length * h * 0.62 + (str.length - 1) * h * 0.22;
// fuselage side codes: "AB (roundel) C" read left->right on each side
function fuselageCodes(b, fus, zc, yc, rr, left, right, h, col, off = 0.016) {
  for (const side of [-1, 1]) {
    const proj = (u, v, o = 0) => fus.side(u, v, side, off + o);
    const dir = side < 0 ? 1 : -1;               // port side reads nose->tail (+z), starboard tail->nose
    const gap = 0.16;
    const wl = textWidth(left, h), wr = textWidth(right, h);
    mText(b, proj, left, zc - dir * (rr + gap + wl), yc, h, dir, col);
    mText(b, proj, right, zc + dir * (rr + gap), yc, h, dir, col);
  }
}

// ---------------------------------------------------------------- small parts
function bar(b, p0, p1, r, col, mat = MAT.PLAIN, n = 3) { b.cylinder(p0, p1, r, r, n, col, mat, false); }
function barPath(b, pts, r, col, mat) { for (let i = 0; i < pts.length - 1; i++) bar(b, pts[i], pts[i + 1], r, col, mat); }
function strut(g, p0, p1, r, col = COL.strut) { g.cylinder(p0, p1, r, r, 6, col, MAT.PLAIN, false); }
// flat plate (two triangles) from 4 corners
const plate = (b, a, c, d, e, col, mat) => b.quad(a, c, d, e, col, mat);

function wheel(g, c, r, w, hubCol = COL.hub, K = 14) {
  const prof = [[-0.5, 0.7], [-0.42, 0.92], [-0.18, 1], [0.18, 1], [0.42, 0.92], [0.5, 0.7]];
  const rings = prof.map(([fx, fr]) => {
    const out = [];
    for (let k = 0; k < K; k++) { const a = (k / K) * TAU; out.push([c[0] + fx * w, c[1] + Math.cos(a) * r * fr, c[2] + Math.sin(a) * r * fr]); }
    return out;
  });
  g.loft(rings, [...COL.tyre, MAT.PLAIN], { closed: true });
  g.disc([c[0] - w * 0.5, c[1], c[2]], [-1, 0, 0], r * 0.71, 10, hubCol, MAT.PLAIN);
  g.disc([c[0] + w * 0.5, c[1], c[2]], [1, 0, 0], r * 0.71, 10, hubCol, MAT.PLAIN);
}

// spinner along -z from base z0 (radius r) to tip z1; returns radius profile
function spinner(b, cx, cy, z0, z1, r, col, mat = MAT.PLAIN, K = 18, blunt = 0.6) {
  const prof = (t) => r * Math.pow(Math.max(0, 1 - t * t), blunt);
  const ts = [0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.82, 0.9, 0.95, 0.98, 1];
  const rings = ts.map((t) => {
    const rr = t >= 1 ? 0 : prof(t), z = lerp(z0, z1, t), out = [];
    for (let k = 0; k < K; k++) { const a = (k / K) * TAU; out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z]); }
    return out;
  });
  loftM(b, rings, solid(col, mat), { capStart: true });
  return prof;
}
// white spiral painted on a spinner
function spinnerSpiral(b, cx, cy, z0, z1, prof, col = COL.white, turns = 0.85, wid = 0.9) {
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * 0.97, t1 = ((i + 1) / n) * 0.97;
    const P = (t, a) => { const rr = prof(t) + 0.008, ang = a + t * turns * TAU; return [cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, lerp(z0, z1, t)]; };
    const w0 = wid * (1 - t0 * 0.8), w1 = wid * (1 - t1 * 0.8);
    b.quad(P(t0, 0), P(t1, 0), P(t1, w1), P(t0, w0), col, MAT.MARK);
  }
}
// exhaust stub on the right side; x = fuselage surface
function stub(b, x, y, z, sx = 0.09, sy = 0.08, sz = 0.14, angle = 0) {
  b.push(chain(T(x + sx / 2 - 0.02, y, z), RY(angle)));
  const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2, z0 = -sz / 2, z1 = sz / 2, c = COL.exhaust, m = MAT.METAL;
  b.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], c, m);
  b.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], c, m);
  b.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], c, m);
  b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], c, m);
  b.quad([sx / 2 + 0.003, -sy * 0.3, sz * 0.35], [sx / 2 + 0.003, -sy * 0.3, -sz * 0.35], [sx / 2 + 0.003, sy * 0.3, -sz * 0.35], [sx / 2 + 0.003, sy * 0.3, sz * 0.35], COL.glow, MAT.EMIT);
  b.pop();
}
function canopyFrames(b, can, zRings, thBars, z0, z1, r = 0.018, off = 0.01, col = W, mat = MAT.CAMO) {
  for (const z of zRings) {
    const pts = [];
    for (let i = 0; i <= 6; i++) pts.push(can.pt(z, -0.06 + ((PI + 0.12) * i) / 6, off));
    barPath(b, pts, r, col, mat);
  }
  for (const th of thBars) {
    const pts = [];
    const nz = Math.max(2, Math.min(7, Math.round((z1 - z0) / 0.35)));
    for (let i = 0; i <= nz; i++) pts.push(can.pt(lerp(z0, z1, i / nz), th, off));
    barPath(b, pts, r, col, mat);
  }
}
const canopyLoft = (b, can, step, z0, z1, K = 11, ext = 0.14) =>
  loftM(b, can.rings(step, K, { th0: -ext, th1: PI + ext, closed: false, z0, z1 }), solid(W, MAT.GLASS));
const fairing = (b, body, step, K = 9, ext = 0.12) =>
  loftM(b, body.rings(step, K, { th0: -ext, th1: PI + ext, closed: false }), solid(W, MAT.CAMO));

function bboxOf(mesh) {
  const f = new Float32Array(mesh.data);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let v = 0; v < mesh.vcount; v++) for (let j = 0; j < 3; j++) { const x = f[v * 5 + j]; if (x < lo[j]) lo[j] = x; if (x > hi[j]) hi[j] = x; }
  return { lo, hi };
}
function finish(b, g, def) {
  const body = b.build(), gear = g.build();
  const bb = bboxOf(body);
  return { body, gear, span: +(bb.hi[0] - bb.lo[0]).toFixed(2), length: +(bb.hi[2] - bb.lo[2]).toFixed(2), ...def };
}
const mirrorPts = (arr) => arr.flatMap((p) => (Math.abs(p.x) < 1e-6 ? [p] : [p, { ...p, x: -p.x }]));

// ==================================================================== SPITFIRE Mk IX
function spitfire() {
  const b = new MeshBuilder(), g = new MeshBuilder(), K = 24;
  const fus = new Body([
    [-2.62, 0.40, 0.40, 0.44, 0, 2.3], [-2.2, 0.44, 0.47, 0.53, 0, 2.3], [-1.4, 0.47, 0.52, 0.63, 0, 2.3],
    [-0.4, 0.50, 0.55, 0.72, 0, 2.3], [0.6, 0.50, 0.53, 0.75, 0, 2.3], [1.6, 0.45, 0.47, 0.70, 0, 2.2],
    [2.8, 0.36, 0.40, 0.58, 0.03, 2.1], [4.0, 0.25, 0.33, 0.45, 0.06, 2.0], [5.0, 0.16, 0.27, 0.32, 0.10, 2.0],
    [5.8, 0.09, 0.21, 0.20, 0.14, 2.0], [6.25, 0.02, 0.08, 0.05, 0.18, 2.0],
  ]);
  const semi = 5.615;
  const wing = new Wing([0, 0.6, 1.3, 2.0, 2.7, 3.4, 4.0, 4.5, 4.9, 5.2, 5.42, 5.56, semi].map((x) => {
    const c = Math.max(0.2, 2.54 * Math.sqrt(Math.max(0, 1 - (x / 5.68) ** 2)));
    return { x, y: -0.42 + x * 0.105, z: -0.3 * c, chord: c, thick: lerp(0.135, 0.075, x / semi), twist: -0.035 * (x / semi) };
  }));
  const tail = new Wing([0, 0.4, 0.8, 1.15, 1.4, 1.55, 1.62].map((x) => {
    const c = Math.max(0.2, 1.08 * Math.sqrt(Math.max(0, 1 - (x / 1.66) ** 2)));
    return { x, y: 0.12, z: 5.07 - 0.3 * c, chord: c, thick: 0.1 };
  }));
  const fin = new Wing([
    { x: 0.1, z: 4.55, chord: 1.7, thick: 0.1 }, { x: 0.5, z: 4.62, chord: 1.62, thick: 0.1 }, { x: 0.9, z: 4.8, chord: 1.42, thick: 0.1 },
    { x: 1.2, z: 5.0, chord: 1.16, thick: 0.1 }, { x: 1.42, z: 5.24, chord: 0.86, thick: 0.1 }, { x: 1.56, z: 5.5, chord: 0.52, thick: 0.1 },
    { x: 1.63, z: 5.74, chord: 0.2, thick: 0.1 },
  ]);
  const m0 = b.mark();
  // ---- right half, mirrored
  wing.build(b);
  wingFillet(b, fus, wing, { rMax: 0.34 });
  tail.build(b);
  const wzc = (x, f = 0.45) => wing.at(x).z + f * wing.at(x).chord;
  roundelB(b, wing.proj(1), 3.25, wzc(3.25), 0.7);
  wingLE(b, wing, 2.9, 5.35, 0.07, COL.yellow, MAT.MARK);
  // radiator under each wing
  const rad = new Body([[-0.28, 0.17, 0.06, 0.1, -0.4, 3], [-0.05, 0.2, 0.08, 0.2, -0.42, 3], [0.6, 0.21, 0.08, 0.22, -0.42, 3], [1.15, 0.19, 0.08, 0.1, -0.38, 3]]);
  b.push(T(1.6, 0, 0));
  loftM(b, rad.rings(0.4, 8), underMat(solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  b.pop();
  // cannon barrels (Mk IX c-wing)
  const cx = 2.05, cle = wing.at(cx);
  bar(b, [cx, cle.y - 0.02, cle.z + 0.2], [cx, cle.y - 0.02, cle.z - 0.25], 0.06, W, MAT.CAMO, 8);
  bar(b, [cx, cle.y - 0.02, cle.z - 0.2], [cx, cle.y - 0.02, cle.z - 0.62], 0.028, COL.gun, MAT.METAL, 6);
  // exhaust stubs (6 per side)
  for (let i = 0; i < 6; i++) { const z = -2.3 + i * 0.2, y = 0.1; stub(b, fus.side(z, y, 1)[0], y, z, 0.09, 0.075, 0.13, 0.15); }
  b.mirrorX(m0.v, m0.i);
  // ---- centre parts
  loftM(b, fus.rings(0.3, K), splitMat(K, 22, solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  // carb intake under nose
  const chin = new Body([[-1.95, 0.11, 0.06, 0.1, -0.5, 2.5], [-1.7, 0.13, 0.1, 0.16, -0.52, 2.5], [-0.9, 0.11, 0.08, 0.06, -0.58, 2.5]]);
  loftM(b, chin.rings(0.4, 8), underMat(solid(COL.intake, MAT.PLAIN)), { capStart: true });
  // canopy
  const can = new Body([[-0.5, 0.25, 0.02, 0.12, 0.4, 2.2], [-0.1, 0.31, 0.3, 0.1, 0.4, 2.4], [0.4, 0.34, 0.39, 0.1, 0.4, 2.2], [0.9, 0.32, 0.36, 0.1, 0.4, 2.2], [1.15, 0.27, 0.27, 0.1, 0.4, 2.2]]);
  canopyLoft(b, can, 0.22);
  canopyFrames(b, can, [-0.1, 1.12], [0.02, PI - 0.02], -0.5, 1.12, 0.02);
  const fair = new Body([[1.05, 0.29, 0.3, 0.08, 0.4, 2.2], [1.7, 0.24, 0.17, 0.08, 0.42, 2.2], [2.6, 0.13, 0.06, 0.08, 0.43, 2.2], [3.3, 0.05, 0.0, 0.08, 0.40, 2.2]]);
  fairing(b, fair, 0.35);
  // fin
  b.push(RZ(PI / 2));
  fin.build(b, W, MAT.CAMO, W, MAT.CAMO);
  for (const side of [-1, 1]) {
    const P = (h, z) => fin.surf(h, z, side, 0.013);
    const flash = (z0, z1, col) => { for (let i = 0; i < 2; i++) { const h0 = lerp(0.55, 1.15, i / 2), h1 = lerp(0.55, 1.15, (i + 1) / 2); b.quad(P(h0, z0), P(h0, z1), P(h1, z1), P(h1, z0), col, MAT.MARK); } };
    flash(4.85, 5.12, COL.rafRed); flash(5.12, 5.18, COL.rafWhite); flash(5.18, 5.46, COL.rafBlue);
  }
  b.pop();
  // fuselage markings: C1 roundel, Sky band, codes
  for (const side of [-1, 1]) roundelC1(b, (u, v, o = 0) => fus.side(u, v, side, 0.015 + o), 2.5, -0.06, 0.42);
  loftM(b, fus.rings(0.25, K, { z0: 4.05, z1: 4.5, off: 0.014 }), solid(COL.sky, MAT.MARK));
  fuselageCodes(b, fus, 2.5, -0.06, 0.42, 'ZD', 'H', 0.46, COL.codes);
  // spinner (Sky)
  spinner(b, 0, 0, -2.6, -3.3, 0.4, COL.sky, MAT.MARK, 18, 0.78);
  // aerial mast behind canopy
  b.push(chain(T(0, 0.55, 2.0), RX(-0.25)));
  b.box(0, 0.22, 0, 0.03, 0.46, 0.12, W, MAT.CAMO);
  b.pop();
  // ---- gear
  const mg = g.mark();
  const wc = [0.88, -1.75, -0.62], wr = 0.34;
  strut(g, [0.66, -0.4, -0.42], [0.8, -1.72, -0.62], 0.055);
  plate(g, [0.72, -0.42, -0.25], [0.86, -1.5, -0.42], [0.86, -1.5, -0.82], [0.72, -0.42, -0.65], W, MAT.UNDER);
  wheel(g, wc, wr, 0.16);
  g.mirrorX(mg.v, mg.i);
  strut(g, [0, -0.08, 5.35], [0, -0.42, 5.55], 0.035);
  wheel(g, [0, -0.43, 5.55], 0.1, 0.07, COL.hub, 10);
  return finish(b, g, {
    fixedGear: false,
    camo: { a: [0.24, 0.29, 0.18], b: [0.43, 0.34, 0.22], under: [0.70, 0.76, 0.66], scale: 2.2 },
    props: [{ x: 0, y: 0, z: -2.92, r: 1.63, blades: 4, dir: 1 }],
    guns: mirrorPts([{ x: 2.05, y: wing.at(2.05).y - 0.02, z: wing.at(2.05).z - 0.62, kind: 'cannon' }, { x: 2.6, y: wing.at(2.6).y, z: wing.at(2.6).z - 0.02, kind: 'mg' }, { x: 3.05, y: wing.at(3.05).y, z: wing.at(3.05).z - 0.02, kind: 'mg' }]),
    gunners: [], hardpoints: [],
    mainWheel: [wc[0], wc[1] - wr, wc[2]], tailWheel: [0, -0.53, 5.55],
    cockpit: [0, 0.72, 0.38],
    exhausts: mirrorPts([{ x: 0.5, y: 0.1, z: -2.25 }, { x: 0.5, y: 0.1, z: -1.85 }, { x: 0.5, y: 0.1, z: -1.4 }]),
    engines: [{ x: 0, y: 0, z: -1.6 }],
  });
}

// ==================================================================== MOSQUITO FB.VI
function mosquito() {
  const b = new MeshBuilder(), g = new MeshBuilder(), K = 24;
  const fus = new Body([
    [-5.32, 0.04, 0.04, 0.04, -0.1, 2], [-5.12, 0.28, 0.27, 0.3, -0.08, 2], [-4.6, 0.47, 0.47, 0.52, -0.06, 2],
    [-3.6, 0.57, 0.6, 0.64, -0.05, 2.1], [-2.4, 0.6, 0.66, 0.68, -0.05, 2.1], [-1.0, 0.6, 0.6, 0.68, -0.05, 2.1],
    [0.5, 0.56, 0.54, 0.62, -0.04, 2.1], [2.0, 0.47, 0.47, 0.5, 0, 2], [4.0, 0.35, 0.37, 0.37, 0.05, 2],
    [5.8, 0.24, 0.29, 0.26, 0.1, 2], [6.8, 0.12, 0.19, 0.14, 0.14, 2], [7.18, 0.03, 0.06, 0.04, 0.16, 2],
  ]);
  const wy = (x) => -0.12 + x * 0.05;
  // straight-tapered panel out to 7.3 m, then an elliptical tip about the mid-chord line
  const tipPts = [1, 2, 3, 4, 5, 6].map((k) => { const a = (k / 6) * (PI / 2), x = 7.3 + 0.98 * Math.sin(a), c = Math.max(0.03, 1.534 * Math.cos(a)); return [x, c, 0.287 - 0.05 * (x - 7.3) - c / 2]; });
  const wing = new Wing([
    [0, 3.6], [0.7, 3.5], [1.6, 3.33], [2.45, 3.15], [3.4, 2.8], [5.0, 2.25], [6.5, 1.75], [7.3, 1.534], ...tipPts,
  ].map(([x, c, z]) => ({ x, y: wy(x), z: z ?? -1.1 + (3.6 - c) * 0.3, chord: c, thick: lerp(0.15, 0.09, x / 8.28), twist: -0.03 * (x / 8.28) })));
  const tail = new Wing([[0, 1.62, 5.5], [1.6, 1.4, 5.62], [2.3, 1.15, 5.78], [2.62, 0.8, 5.98], [2.75, 0.38, 6.2]].map(([x, c, z]) => ({ x, y: 0.12, z, chord: c, thick: 0.1 })));
  const fin = new Wing([[0.2, 4.85, 2.3], [0.55, 5.0, 2.12], [1.1, 5.35, 1.78], [1.6, 5.7, 1.4], [2.0, 6.02, 1.03], [2.25, 6.3, 0.7], [2.37, 6.55, 0.35]].map(([x, z, c]) => ({ x, z, chord: c, thick: 0.1 })));
  const nac = new Body([
    [-3.12, 0.36, 0.36, 0.38, -0.1, 2], [-2.8, 0.45, 0.45, 0.5, -0.1, 2.1], [-1.9, 0.48, 0.48, 0.58, -0.12, 2.1],
    [-0.7, 0.47, 0.42, 0.66, -0.15, 2.2], [0.9, 0.42, 0.34, 0.66, -0.18, 2.2], [2.2, 0.28, 0.2, 0.42, -0.15, 2], [3.25, 0.06, 0.05, 0.08, -0.08, 2],
  ]);
  const NX = 2.45;
  const m0 = b.mark();
  wing.build(b);
  tail.build(b);
  roundelB(b, wing.proj(1), 5.4, wing.at(5.4).z + 0.45 * wing.at(5.4).chord, 0.9);
  // radiator intakes in inner wing leading edge
  wingLE(b, wing, 0.75, 1.95, 0.025, COL.intake, MAT.PLAIN, 0.01, 2, 4);
  b.push(T(NX, 0, 0));
  loftM(b, nac.rings(0.35, 18), splitMat(18, 15, solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  b.pop();
  spinner(b, NX, -0.1, -3.1, -3.8, 0.36, COL.black, MAT.PLAIN, 18, 0.72);
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) {
    const z = -2.75 + i * 0.2, y = 0.02;
    b.push(T(NX, 0, 0));
    const p = nac.side(z, y, side);
    if (side > 0) stub(b, p[0], y, z, 0.08, 0.07, 0.12, 0.12);
    else { b.push(RY(PI)); stub(b, -p[0], y, -z, 0.08, 0.07, 0.12, 0.12); b.pop(); }
    b.pop();
  }
  // underwing bomb rack
  const hx = 4.0, ha = wing.at(hx);
  b.box(hx, ha.y - 0.17, ha.z + 0.45 * ha.chord, 0.08, 0.16, 0.6, W, MAT.UNDER);
  b.mirrorX(m0.v, m0.i);
  // ---- centre
  loftM(b, fus.rings(0.3, K), splitMat(K, 15));
  // canopy (side-by-side, framed)
  const can = new Body([[-3.55, 0.4, 0.02, 0.12, 0.38, 2.4], [-3.05, 0.5, 0.44, 0.1, 0.38, 2.6], [-2.45, 0.55, 0.58, 0.1, 0.38, 2.4], [-1.85, 0.48, 0.5, 0.1, 0.38, 2.2], [-1.4, 0.3, 0.24, 0.1, 0.38, 2.2]]);
  canopyLoft(b, can, 0.2);
  canopyFrames(b, can, [-3.05, -2.45, -1.85], [0.05, 0.75, PI - 0.75, PI - 0.05], -3.55, -1.5, 0.02);
  canopyFrames(b, can, [], [PI / 2], -3.55, -3.05, 0.02);
  const fair = new Body([[-1.6, 0.42, 0.4, 0.1, 0.38, 2.2], [-0.6, 0.36, 0.2, 0.1, 0.38, 2.2], [0.6, 0.24, 0.05, 0.1, 0.4, 2.2], [1.2, 0.15, 0.0, 0.1, 0.38, 2.2]]);
  fairing(b, fair, 0.4);
  // nose guns: 4 x .303 on top, 4 x 20mm cannon ports under the nose
  for (const x of [-0.17, -0.06, 0.06, 0.17]) {
    const y = 0.2 - Math.abs(x) * 0.4;
    bar(b, [x, y, -4.95], [x, y, -5.38], 0.018, COL.gun, MAT.METAL, 5);
  }
  for (const x of [-0.3, -0.1, 0.1, 0.3]) {
    bar(b, [x, -0.55, -2.8], [x, -0.55, -3.6], 0.045, W, MAT.UNDER, 6);
    bar(b, [x, -0.55, -3.5], [x, -0.55, -3.75], 0.025, COL.gun, MAT.METAL, 5);
  }
  // fin
  b.push(RZ(PI / 2));
  fin.build(b, W, MAT.CAMO, W, MAT.CAMO);
  for (const side of [-1, 1]) {
    const P = (h, z) => fin.surf(h, z, side, 0.013);
    const flash = (z0, z1, col) => { for (let i = 0; i < 2; i++) { const h0 = lerp(0.6, 1.4, i / 2), h1 = lerp(0.6, 1.4, (i + 1) / 2); b.quad(P(h0, z0), P(h0, z1), P(h1, z1), P(h1, z0), col, MAT.MARK); } };
    flash(5.6, 5.95, COL.rafRed); flash(5.95, 6.03, COL.rafWhite); flash(6.03, 6.38, COL.rafBlue);
  }
  b.pop();
  for (const side of [-1, 1]) roundelC1(b, (u, v, o = 0) => fus.side(u, v, side, 0.015 + o), 3.75, 0.02, 0.36);
  fuselageCodes(b, fus, 3.75, 0.02, 0.36, 'EG', 'T', 0.42, COL.codes);
  // aerial mast
  b.box(0, 0.62, -0.3, 0.03, 0.3, 0.1, W, MAT.CAMO);
  // ---- gear
  const mg = g.mark();
  const wc = [NX, -2.02, -0.55], wr = 0.48;
  for (const dx of [-0.2, 0.2]) strut(g, [NX + dx, -0.6, -0.35], [NX + dx, -2.0, -0.55], 0.05);
  g.box(NX, -1.35, -0.42, 0.42, 0.06, 0.1, COL.strut, MAT.PLAIN);
  for (const dx of [-0.45, 0.45]) plate(g, [NX + dx, -0.7, -0.9], [NX + dx, -0.7, 0.6], [NX + dx * 1.05, -1.45, 0.5], [NX + dx * 1.05, -1.45, -0.8], W, MAT.UNDER);
  wheel(g, wc, wr, 0.22);
  g.mirrorX(mg.v, mg.i);
  strut(g, [0, 0.0, 6.15], [0, -0.42, 6.3], 0.04);
  wheel(g, [0, -0.42, 6.3], 0.14, 0.09, COL.hub, 10);
  const ha2 = wing.at(4.0);
  return finish(b, g, {
    fixedGear: false,
    camo: { a: [0.36, 0.38, 0.41], b: [0.22, 0.27, 0.17], under: [0.55, 0.57, 0.57], scale: 3.0 },
    props: [{ x: NX, y: -0.1, z: -3.4, r: 1.65, blades: 3, dir: 1 }, { x: -NX, y: -0.1, z: -3.4, r: 1.65, blades: 3, dir: 1 }],
    guns: [
      ...[-0.17, -0.06, 0.06, 0.17].map((x) => ({ x, y: 0.2 - Math.abs(x) * 0.4, z: -5.38, kind: 'mg' })),
      ...[-0.3, -0.1, 0.1, 0.3].map((x) => ({ x, y: -0.55, z: -3.75, kind: 'cannon' })),
    ],
    gunners: [],
    hardpoints: [
      { x: -0.22, y: -0.42, z: 0.6, kind: 'bomb500' }, { x: 0.22, y: -0.42, z: 0.6, kind: 'bomb500' },
      { x: -4.0, y: ha2.y - 0.45, z: ha2.z + 0.45 * ha2.chord, kind: 'bomb500' }, { x: 4.0, y: ha2.y - 0.45, z: ha2.z + 0.45 * ha2.chord, kind: 'bomb500' },
    ],
    mainWheel: [wc[0], wc[1] - wr, wc[2]], tailWheel: [0, -0.56, 6.3],
    cockpit: [-0.24, 0.86, -2.55],
    exhausts: mirrorPts([{ x: NX + 0.5, y: 0.02, z: -2.7 }, { x: NX + 0.5, y: 0.02, z: -2.0 }, { x: NX - 0.5, y: 0.02, z: -2.7 }, { x: NX - 0.5, y: 0.02, z: -2.0 }]),
    engines: [{ x: NX, y: -0.1, z: -2.0 }, { x: -NX, y: -0.1, z: -2.0 }],
  });
}

// ==================================================================== Bf 109 G
function bf109() {
  const b = new MeshBuilder(), g = new MeshBuilder(), K = 24;
  const fus = new Body([
    [-2.55, 0.36, 0.38, 0.40, 0, 2.2], [-2.1, 0.40, 0.43, 0.48, 0, 2.3], [-1.2, 0.42, 0.44, 0.56, -0.02, 2.4],
    [-0.3, 0.43, 0.42, 0.6, -0.04, 2.4], [0.6, 0.41, 0.4, 0.6, -0.05, 2.4], [1.6, 0.36, 0.38, 0.55, -0.03, 2.3],
    [2.8, 0.27, 0.33, 0.45, 0.02, 2.2], [4.0, 0.17, 0.28, 0.34, 0.08, 2.1], [5.0, 0.10, 0.22, 0.22, 0.14, 2.0],
    [5.6, 0.05, 0.14, 0.12, 0.19, 2.0], [5.82, 0.015, 0.05, 0.03, 0.22, 2.0],
  ]);
  const wy = (x) => -0.42 + x * 0.114;
  const wing = new Wing([
    [0, -0.55, 2.05, 0.14], [0.6, -0.53, 2.0, 0.14], [2.0, -0.45, 1.75, 0.13], [3.5, -0.36, 1.47, 0.12], [4.2, -0.32, 1.3, 0.11],
    [4.55, -0.25, 1.1, 0.1], [4.8, -0.13, 0.82, 0.1], [4.93, 0.0, 0.52, 0.1], [4.98, 0.12, 0.26, 0.1],
  ].map(([x, z, c, th]) => ({ x, y: wy(x), z, chord: c, thick: th, twist: -0.03 * (x / 5) })));
  const tail = new Wing([[0, 4.75, 0.98], [1.15, 4.86, 0.78], [1.4, 4.98, 0.58], [1.52, 5.12, 0.32]].map(([x, z, c]) => ({ x, y: 0.3, z, chord: c, thick: 0.1 })));
  const fin = new Wing([[0.15, 4.58, 1.24], [0.7, 4.72, 1.08], [1.05, 4.9, 0.86], [1.22, 5.08, 0.6], [1.31, 5.3, 0.3]].map(([x, z, c]) => ({ x, z, chord: c, thick: 0.1 })));
  const m0 = b.mark();
  wing.build(b);
  wingFillet(b, fus, wing, { rMax: 0.2 });
  tail.build(b);
  const wz = (x, f = 0.45) => wing.at(x).z + f * wing.at(x).chord;
  balken(b, wing.proj(1), 3.7, wz(3.7), 0.85);
  balken(b, wing.proj(-1), 3.6, wz(3.6), 0.95);
  // underwing radiators
  const rad = new Body([[-0.05, 0.28, 0.06, 0.05, -0.38, 3.5], [0.2, 0.31, 0.06, 0.13, -0.4, 3.5], [0.85, 0.31, 0.06, 0.12, -0.39, 3.5], [1.15, 0.28, 0.06, 0.04, -0.36, 3.5]]);
  b.push(T(1.4, 0, 0));
  loftM(b, rad.rings(0.4, 8), underMat(solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  b.pop();
  for (let i = 0; i < 6; i++) { const z = -2.05 + i * 0.17, y = -0.06; stub(b, fus.side(z, y, 1)[0], y, z, 0.08, 0.07, 0.12, 0.2); }
  b.mirrorX(m0.v, m0.i);
  loftM(b, fus.rings(0.3, K), splitMat(K, 0, solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  // yellow cowling band
  loftM(b, fus.rings(0.25, K, { z0: -2.55, z1: -1.55, off: 0.013 }), solid(COL.yellow, MAT.MARK));
  // oil cooler chin + supercharger intake (left)
  const chin = new Body([[-1.95, 0.15, 0.06, 0.08, -0.45, 3], [-1.7, 0.17, 0.08, 0.13, -0.48, 3], [-1.0, 0.15, 0.08, 0.04, -0.55, 3]]);
  loftM(b, chin.rings(0.4, 8), underMat(solid(COL.intake, MAT.PLAIN)), { capStart: true });
  const sc = new Body([[-1.75, 0.07, 0.08, 0.08, 0.06, 2.4], [-1.55, 0.1, 0.1, 0.1, 0.06, 2.4], [-0.95, 0.04, 0.05, 0.05, 0.03, 2.4]]);
  b.push(T(-0.44, 0, 0));
  loftM(b, sc.rings(0.3, 10), solid(W, MAT.CAMO), { capStart: true });
  b.disc([0, 0.06, -1.752], [0, 0, -1], 0.06, 8, COL.intake, MAT.PLAIN);
  b.pop();
  // canopy (angular, framed)
  const can = new Body([[-0.5, 0.2, 0.02, 0.12, 0.28, 3.2], [-0.12, 0.25, 0.36, 0.1, 0.28, 3.5], [0.5, 0.26, 0.42, 0.1, 0.28, 3.5], [0.95, 0.24, 0.38, 0.1, 0.28, 3.2], [1.08, 0.21, 0.3, 0.1, 0.28, 3]]);
  canopyLoft(b, can, 0.2, undefined, undefined, 9);
  canopyFrames(b, can, [-0.12, 0.55, 1.02], [0.02, 0.7, PI - 0.7, PI - 0.02], -0.45, 1.05, 0.022);
  const fair = new Body([[0.95, 0.24, 0.38, 0.08, 0.28, 3], [1.6, 0.19, 0.22, 0.08, 0.3, 2.6], [2.6, 0.1, 0.08, 0.08, 0.32, 2.2], [3.1, 0.05, 0.0, 0.08, 0.32, 2.2]]);
  fairing(b, fair, 0.35);
  // cowl gun troughs (13mm) and hub cannon barrel
  for (const x of [-0.12, 0.12]) bar(b, [x, 0.38, -1.6], [x, 0.36, -2.25], 0.022, COL.gun, MAT.METAL, 5);
  b.push(RZ(PI / 2));
  fin.build(b, W, MAT.CAMO, W, MAT.CAMO);
  // yellow rudder (aft of the hinge line)
  for (const side of [-1, 1]) {
    const P = (h, z) => fin.surf(h, z, side, 0.012);
    const hz = (h) => 5.28 + (h - 0.15) * 0.05;
    for (let i = 0; i < 4; i++) {
      const h0 = lerp(0.15, 1.28, i / 4), h1 = lerp(0.15, 1.28, (i + 1) / 4);
      const te0 = fin.at(h0).z + fin.at(h0).chord - 0.01, te1 = fin.at(h1).z + fin.at(h1).chord - 0.01;
      b.quad(P(h0, hz(h0)), P(h0, te0), P(h1, te1), P(h1, Math.min(hz(h1), te1 - 0.02)), COL.yellow, MAT.MARK);
    }
  }
  b.pop();
  for (const side of [-1, 1]) balken(b, (u, v, o = 0) => fus.side(u, v, side, 0.015 + o), 2.75, 0.0, 0.7);
  const prof = spinner(b, 0, 0, -2.53, -3.2, 0.37, COL.spinGer, MAT.PLAIN, 18, 0.72);
  spinnerSpiral(b, 0, 0, -2.53, -3.2, prof);
  bar(b, [0, 0, -3.14], [0, 0, -3.28], 0.03, COL.gun, MAT.METAL, 6);
  b.box(0, 0.5, 1.5, 0.025, 0.25, 0.08, W, MAT.CAMO);
  // ---- gear (narrow track, splayed)
  const mg = g.mark();
  const wc = [1.03, -1.58, -0.78], wr = 0.33;
  strut(g, [0.42, -0.55, -0.62], [0.95, -1.56, -0.78], 0.055);
  plate(g, [0.5, -0.55, -0.5], [0.97, -1.38, -0.62], [0.97, -1.38, -0.92], [0.5, -0.55, -0.78], W, MAT.UNDER);
  wheel(g, wc, wr, 0.15);
  g.mirrorX(mg.v, mg.i);
  strut(g, [0, -0.05, 5.0], [0, -0.42, 5.15], 0.035);
  wheel(g, [0, -0.43, 5.15], 0.12, 0.08, COL.hub, 10);
  return finish(b, g, {
    fixedGear: false,
    camo: { a: [0.29, 0.31, 0.32], b: [0.42, 0.42, 0.44], under: [0.66, 0.73, 0.78], scale: 1.6 },
    props: [{ x: 0, y: 0, z: -2.85, r: 1.5, blades: 3, dir: 1 }],
    guns: [{ x: 0, y: 0, z: -3.28, kind: 'cannon' }, { x: -0.12, y: 0.36, z: -2.25, kind: 'hmg' }, { x: 0.12, y: 0.36, z: -2.25, kind: 'hmg' }],
    gunners: [], hardpoints: [],
    mainWheel: [wc[0], wc[1] - wr, wc[2]], tailWheel: [0, -0.55, 5.15],
    cockpit: [0, 0.6, 0.4],
    exhausts: mirrorPts([{ x: 0.47, y: -0.06, z: -2.0 }, { x: 0.47, y: -0.06, z: -1.6 }, { x: 0.47, y: -0.06, z: -1.2 }]),
    engines: [{ x: 0, y: 0, z: -1.6 }],
  });
}

// ==================================================================== Fw 190 A
function fw190() {
  const b = new MeshBuilder(), g = new MeshBuilder(), K = 24;
  const fus = new Body([
    [-2.78, 0.6, 0.6, 0.6, 0, 2], [-2.5, 0.67, 0.67, 0.67, 0, 2], [-1.75, 0.67, 0.67, 0.67, 0, 2],
    [-1.1, 0.58, 0.58, 0.6, -0.02, 2.1], [-0.2, 0.5, 0.54, 0.6, -0.04, 2.2], [0.6, 0.46, 0.5, 0.58, -0.04, 2.2],
    [1.6, 0.39, 0.45, 0.5, -0.02, 2.2], [2.8, 0.3, 0.37, 0.41, 0.02, 2.1], [4.0, 0.2, 0.3, 0.32, 0.07, 2],
    [5.0, 0.11, 0.22, 0.24, 0.12, 2], [5.65, 0.025, 0.07, 0.04, 0.16, 2],
  ]);
  const wy = (x) => -0.42 + x * 0.087;
  const wing = new Wing([
    [0, -0.68, 2.3, 0.155], [1.0, -0.62, 2.2, 0.15], [2.5, -0.43, 1.85, 0.13], [4.6, -0.22, 1.4, 0.1],
    [5.0, -0.13, 1.18, 0.1], [5.18, 0.0, 0.86, 0.1], [5.26, 0.18, 0.44, 0.1],
  ].map(([x, z, c, th]) => ({ x, y: wy(x), z, chord: c, thick: th, twist: -0.03 * (x / 5.25) })));
  const tail = new Wing([[0, 4.55, 1.0], [1.3, 4.68, 0.82], [1.55, 4.8, 0.62], [1.68, 4.98, 0.32]].map(([x, z, c]) => ({ x, y: 0.18, z, chord: c, thick: 0.1 })));
  const fin = new Wing([[0.15, 4.35, 1.3], [0.7, 4.5, 1.12], [1.05, 4.66, 0.9], [1.25, 4.85, 0.62], [1.34, 5.05, 0.3]].map(([x, z, c]) => ({ x, z, chord: c, thick: 0.1 })));
  const m0 = b.mark();
  wing.build(b);
  wingFillet(b, fus, wing, { rMax: 0.24 });
  tail.build(b);
  const wz = (x, f = 0.45) => wing.at(x).z + f * wing.at(x).chord;
  balken(b, wing.proj(1), 3.8, wz(3.8), 0.9);
  balken(b, wing.proj(-1), 3.7, wz(3.7), 1.0);
  for (const x of [0.95, 2.3]) { const a = wing.at(x); bar(b, [x, a.y - 0.02, a.z + 0.1], [x, a.y - 0.02, a.z - (x > 2 ? 0.35 : 0.08)], 0.025, COL.gun, MAT.METAL, 5); }
  for (let i = 0; i < 4; i++) { const y = -0.15 - i * 0.1, z = -0.95; stub(b, fus.side(z, y, 1)[0], y, z, 0.08, 0.06, 0.18, 0.3); }
  b.mirrorX(m0.v, m0.i);
  loftM(b, fus.rings(0.3, K), splitMat(K, 0, solid(COL.intake, MAT.METAL)), { capStart: true, capEnd: true });
  // cowl front lip ring
  loftM(b, [fus.ring(-2.76, K, 0, TAU, true, 0.005), fus.ring(-2.76, K, 0, TAU, true, -0.06), fus.ring(-2.66, K, 0, TAU, true, -0.07)], solid(COL.spinGer, MAT.PLAIN));
  // cooling fan blades behind the cowl opening
  for (let i = 0; i < 12; i++) { b.push(chain(T(0, 0, -2.72), RZ((i / 12) * TAU), RY(0.5))); b.box(0, 0.45, 0, 0.12, 0.26, 0.01, COL.intake, MAT.METAL); b.pop(); }
  // yellow under-cowl band
  loftM(b, fus.rings(0.25, 10, { z0: -2.6, z1: -1.3, th0: PI + 0.45, th1: TAU - 0.45, closed: false, off: 0.012 }), solid(COL.yellow, MAT.MARK));
  const can = new Body([[-0.65, 0.26, 0.02, 0.12, 0.4, 2.2], [-0.25, 0.3, 0.36, 0.1, 0.4, 2.4], [0.45, 0.32, 0.5, 0.1, 0.4, 2.2], [1.05, 0.3, 0.46, 0.1, 0.4, 2.1], [1.45, 0.21, 0.3, 0.1, 0.4, 2.1], [1.6, 0.1, 0.08, 0.1, 0.4, 2]]);
  canopyLoft(b, can, 0.2);
  canopyFrames(b, can, [-0.25], [0.02, PI - 0.02], -0.65, -0.25, 0.022);
  canopyFrames(b, can, [], [0.02, PI - 0.02], -0.25, 1.5, 0.016);
  const fair = new Body([[1.2, 0.27, 0.4, 0.08, 0.4, 2.1], [2.0, 0.2, 0.22, 0.08, 0.4, 2.1], [3.2, 0.08, 0.04, 0.08, 0.38, 2], [3.6, 0.05, 0.0, 0.08, 0.36, 2]]);
  fairing(b, fair, 0.35);
  for (const x of [-0.13, 0.13]) bar(b, [x, 0.6, -1.25], [x, 0.57, -1.85], 0.022, COL.gun, MAT.METAL, 5);
  b.push(RZ(PI / 2));
  fin.build(b, W, MAT.CAMO, W, MAT.CAMO);
  b.pop();
  for (const side of [-1, 1]) balken(b, (u, v, o = 0) => fus.side(u, v, side, 0.015 + o), 2.55, 0.02, 0.75);
  const prof = spinner(b, 0, 0, -2.7, -3.3, 0.4, COL.spinGer, MAT.PLAIN, 18, 0.42);
  spinnerSpiral(b, 0, 0, -2.7, -3.3, prof);
  b.box(0, 0.55, 2.0, 0.025, 0.3, 0.08, W, MAT.CAMO);
  // ---- gear (wide track)
  const mg = g.mark();
  const wc = [1.75, -1.6, -0.78], wr = 0.35;
  strut(g, [1.68, -0.38, -0.55], [1.68, -1.58, -0.78], 0.055);
  plate(g, [1.6, -0.3, -0.35], [1.6, -1.35, -0.55], [1.6, -1.35, -0.98], [1.6, -0.3, -0.78], W, MAT.UNDER);
  wheel(g, wc, wr, 0.16);
  g.mirrorX(mg.v, mg.i);
  strut(g, [0, -0.02, 4.95], [0, -0.42, 5.08], 0.035);
  wheel(g, [0, -0.43, 5.08], 0.13, 0.08, COL.hub, 10);
  return finish(b, g, {
    fixedGear: false,
    camo: { a: [0.29, 0.31, 0.32], b: [0.42, 0.42, 0.44], under: [0.66, 0.73, 0.78], scale: 1.8 },
    props: [{ x: 0, y: 0, z: -2.95, r: 1.65, blades: 3, dir: 1 }],
    guns: [
      ...mirrorPts([{ x: 0.95, y: wing.at(0.95).y - 0.02, z: wing.at(0.95).z - 0.08, kind: 'cannon' }, { x: 2.3, y: wing.at(2.3).y - 0.02, z: wing.at(2.3).z - 0.35, kind: 'cannon' }]),
      { x: -0.13, y: 0.57, z: -1.85, kind: 'hmg' }, { x: 0.13, y: 0.57, z: -1.85, kind: 'hmg' },
    ],
    gunners: [], hardpoints: [],
    mainWheel: [wc[0], wc[1] - wr, wc[2]], tailWheel: [0, -0.56, 5.08],
    cockpit: [0, 0.78, 0.2],
    exhausts: mirrorPts([{ x: 0.6, y: -0.2, z: -0.95 }, { x: 0.58, y: -0.4, z: -0.95 }]),
    engines: [{ x: 0, y: 0, z: -2.0 }],
  });
}

// ==================================================================== Ju 87 B Stuka
function ju87() {
  const b = new MeshBuilder(), g = new MeshBuilder(), K = 24;
  const fus = new Body([
    [-3.95, 0.36, 0.36, 0.4, 0.1, 2.2], [-3.5, 0.45, 0.5, 0.58, 0.05, 2.4], [-2.6, 0.5, 0.58, 0.74, 0.0, 2.6],
    [-1.6, 0.52, 0.6, 0.78, 0, 2.7], [-0.6, 0.52, 0.62, 0.8, 0, 2.7], [0.8, 0.5, 0.6, 0.78, 0, 2.7],
    [2.0, 0.45, 0.55, 0.7, 0, 2.6], [3.4, 0.35, 0.47, 0.58, 0.05, 2.4], [4.8, 0.24, 0.38, 0.42, 0.12, 2.2],
    [5.9, 0.13, 0.28, 0.26, 0.22, 2.1], [6.5, 0.06, 0.15, 0.1, 0.3, 2], [6.75, 0.02, 0.05, 0.03, 0.32, 2],
  ]);
  const gy = (x) => (x <= 2.1 ? -0.62 - x * 0.229 : -1.1 + (x - 2.1) * 0.123);
  const wing = new Wing([
    [0, -0.75, 2.75, 0.15], [1.0, -0.72, 2.7, 0.15], [2.1, -0.68, 2.6, 0.14], [3.0, -0.6, 2.38, 0.13], [4.5, -0.46, 2.0, 0.12],
    [6.0, -0.33, 1.62, 0.1], [6.45, -0.25, 1.42, 0.1], [6.72, -0.12, 1.12, 0.1], [6.86, 0.06, 0.72, 0.1], [6.92, 0.3, 0.32, 0.1],
  ].map(([x, z, c, th]) => ({ x, y: gy(x), z, chord: c, thick: th, twist: -0.03 * (x / 6.9) })));
  const tail = new Wing([[0, 5.28, 1.38], [2.05, 5.42, 1.05], [2.33, 5.58, 0.8], [2.46, 5.8, 0.42]].map(([x, z, c]) => ({ x, y: 0.36, z, chord: c, thick: 0.1 })));
  const fin = new Wing([[0.3, 5.22, 1.52], [1.2, 5.34, 1.36], [1.7, 5.5, 1.12], [1.9, 5.72, 0.76], [1.98, 5.96, 0.36]].map(([x, z, c]) => ({ x, z, chord: c, thick: 0.1 })));
  const m0 = b.mark();
  wing.build(b);
  tail.build(b);
  const wz = (x, f = 0.45) => wing.at(x).z + f * wing.at(x).chord;
  balken(b, wing.proj(1), 5.0, wz(5.0), 1.1);
  balken(b, wing.proj(-1), 5.0, wz(5.0), 1.2);
  // yellow wing tips (underside)
  wingPatch(b, wing, 6.25, 6.88, 0.05, 0.95, -1, COL.yellow, MAT.MARK, 0.012, 3, 3);
  // dive brakes under the outer wings
  {
    const x0 = 2.6, x1 = 5.6, pts = [];
    for (const x of [x0, x1]) { const a = wing.at(x); pts.push([x, a.y - 0.32, a.z + 0.12 * a.chord]); }
    b.push(T(0, 0, 0));
    bar(b, pts[0], pts[1], 0.035, W, MAT.UNDER, 4);
    bar(b, [pts[0][0], pts[0][1] + 0.08, pts[0][2] + 0.05], [pts[1][0], pts[1][1] + 0.08, pts[1][2] + 0.05], 0.03, W, MAT.UNDER, 4);
    for (const x of [x0 + 0.3, (x0 + x1) / 2, x1 - 0.3]) { const a = wing.at(x); b.box(x, a.y - 0.2, a.z + 0.14 * a.chord, 0.04, 0.26, 0.06, W, MAT.UNDER); }
    b.pop();
  }
  // wing MG barrel & bomb rack
  { const a = wing.at(2.4); bar(b, [2.4, a.y, a.z + 0.05], [2.4, a.y, a.z - 0.18], 0.018, COL.gun, MAT.METAL, 5); }
  { const a = wing.at(3.4); b.box(3.4, a.y - 0.16, a.z + 0.42 * a.chord, 0.08, 0.14, 0.55, W, MAT.UNDER); }
  for (let i = 0; i < 6; i++) { const z = -3.45 + i * 0.18, y = 0.18; stub(b, fus.side(z, y, 1)[0], y, z, 0.09, 0.07, 0.12, 0.25); }
  b.mirrorX(m0.v, m0.i);
  loftM(b, fus.rings(0.3, K), splitMat(K, 15, solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  // chin radiator
  const rad = new Body([[-3.7, 0.3, 0.2, 0.3, -0.42, 3], [-3.4, 0.36, 0.2, 0.5, -0.5, 3], [-2.6, 0.38, 0.2, 0.48, -0.6, 3], [-1.9, 0.32, 0.2, 0.1, -0.7, 3]]);
  loftM(b, rad.rings(0.4, 8), underMat(solid(COL.intake, MAT.PLAIN)), { capStart: true });
  for (let i = 0; i < 5; i++) b.box(-0.24 + i * 0.12, -0.72, -3.69, 0.02, 0.3, 0.04, COL.gun, MAT.METAL);
  // long greenhouse canopy
  const can = new Body([[-1.05, 0.3, 0.02, 0.12, 0.5, 2.6], [-0.65, 0.36, 0.36, 0.1, 0.5, 2.6], [0.6, 0.38, 0.45, 0.1, 0.5, 2.6], [1.8, 0.37, 0.42, 0.1, 0.5, 2.5], [2.35, 0.32, 0.33, 0.1, 0.5, 2.4], [2.6, 0.18, 0.1, 0.1, 0.5, 2.2]]);
  canopyLoft(b, can, 0.25);
  canopyFrames(b, can, [-0.65, -0.1, 0.5, 1.15, 1.8, 2.35], [0.03, 0.8, PI - 0.8, PI - 0.03], -1.0, 2.5, 0.02);
  canopyFrames(b, can, [], [PI / 2], -0.65, 2.5, 0.02);
  // rear gun
  bar(b, [0, 0.82, 2.3], [0, 1.05, 3.15], 0.022, COL.gun, MAT.METAL, 5);
  b.box(0, 0.8, 2.25, 0.16, 0.14, 0.22, COL.gun, MAT.METAL);
  b.push(RZ(PI / 2));
  fin.build(b, W, MAT.CAMO, W, MAT.CAMO);
  b.pop();
  // tailplane struts
  for (const s of [-1, 1]) bar(b, [s * 0.95, 0.32, 5.85], [s * 0.18, -0.12, 5.6], 0.025, W, MAT.UNDER, 4);
  for (const side of [-1, 1]) balken(b, (u, v, o = 0) => fus.side(u, v, side, 0.015 + o), 3.3, 0.1, 0.85);
  const prof = spinner(b, 0, 0.1, -3.93, -4.4, 0.33, COL.spinGer, MAT.PLAIN, 18, 0.55);
  b.box(0, 0.75, 2.75, 0.025, 0.3, 0.08, W, MAT.CAMO);
  // ---- fixed spatted gear (in `gear`)
  const mg = g.mark();
  const SX = 2.1, wc = [SX, -2.35, -0.6], wr = 0.42;
  {
    const ys = [-1.0, -1.45, -1.9, -2.25, -2.36];
    const sec = [[0.2, 0.62, -0.3], [0.19, 0.56, -0.42], [0.21, 0.56, -0.53], [0.23, 0.58, -0.6], [0.16, 0.42, -0.6]];
    const rings = ys.map((y, i) => { const [w, a, zc] = sec[i], out = []; for (let k = 0; k < 12; k++) { const t = (k / 12) * TAU; const c = Math.cos(t), s = Math.sin(t); out.push([SX + w * s, y, zc - a * sgnpow(c, 0.8) * (c > 0 ? 0.8 : 1.15)]); } return out; });
    loftM(g, rings, solid(W, MAT.CAMO), { capEnd: true });
  }
  wheel(g, wc, wr, 0.17);
  g.mirrorX(mg.v, mg.i);
  strut(g, [0, 0.0, 5.95], [0, -0.62, 6.1], 0.04);
  wheel(g, [0, -0.62, 6.1], 0.15, 0.09, COL.hub, 10);
  return finish(b, g, {
    fixedGear: true,
    camo: { a: [0.17, 0.21, 0.16], b: [0.26, 0.3, 0.19], under: [0.56, 0.67, 0.74], scale: 2.5 },
    props: [{ x: 0, y: 0.1, z: -4.12, r: 1.7, blades: 3, dir: 1 }],
    guns: mirrorPts([{ x: 2.4, y: wing.at(2.4).y, z: wing.at(2.4).z - 0.18, kind: 'mg' }]),
    gunners: [{ x: 0, y: 0.95, z: 2.6, arc: 'rear' }],
    hardpoints: [
      { x: 0, y: -1.0, z: 0.15, kind: 'bomb500' },
      { x: -3.4, y: wing.at(3.4).y - 0.42, z: wing.at(3.4).z + 0.42 * wing.at(3.4).chord, kind: 'bomb250' },
      { x: 3.4, y: wing.at(3.4).y - 0.42, z: wing.at(3.4).z + 0.42 * wing.at(3.4).chord, kind: 'bomb250' },
    ],
    mainWheel: [wc[0], wc[1] - wr, wc[2]], tailWheel: [0, -0.77, 6.1],
    cockpit: [0, 0.98, -0.3],
    exhausts: mirrorPts([{ x: 0.55, y: 0.18, z: -3.4 }, { x: 0.55, y: 0.18, z: -2.9 }, { x: 0.55, y: 0.18, z: -2.5 }]),
    engines: [{ x: 0, y: 0.05, z: -2.9 }],
  });
}

// ==================================================================== Ju 88 A
function ju88() {
  const b = new MeshBuilder(), g = new MeshBuilder(), K = 24;
  const fus = new Body([
    [-5.3, 0.06, 0.05, 0.06, 0.05, 2], [-5.15, 0.45, 0.42, 0.45, 0.02, 2], [-4.85, 0.66, 0.58, 0.63, 0, 2], [-4.5, 0.77, 0.67, 0.72, 0, 2.05], [-4.0, 0.81, 0.72, 0.77, 0, 2.1],
    [-3.5, 0.82, 0.74, 0.8, 0, 2.1], [-2.0, 0.8, 0.72, 0.8, 0, 2.1], [-0.5, 0.75, 0.65, 0.78, 0, 2.1], [1.5, 0.62, 0.58, 0.68, 0.02, 2.1],
    [3.5, 0.5, 0.5, 0.55, 0.05, 2], [5.5, 0.38, 0.42, 0.42, 0.1, 2], [7.3, 0.26, 0.34, 0.3, 0.18, 2], [8.5, 0.15, 0.25, 0.18, 0.25, 2], [9.06, 0.04, 0.08, 0.04, 0.3, 2],
  ]);
  const wy = (x) => -0.25 + x * 0.096;
  const wing = new Wing([
    [0, 3.3], [1.2, 3.25], [2.85, 3.1], [4.5, 2.75], [7.0, 2.2], [9.0, 1.72], [9.6, 1.42], [9.9, 1.05], [10.04, 0.55],
  ].map(([x, c]) => ({ x, y: wy(x), z: -1.0 + (3.3 - c) * (x > 9.2 ? 0.55 : 0.4), chord: c, thick: lerp(0.15, 0.1, x / 10), twist: -0.03 * (x / 10) })));
  const tail = new Wing([[0, 7.15, 1.7], [2.6, 7.35, 1.3], [3.05, 7.55, 1.0], [3.3, 7.85, 0.5]].map(([x, z, c]) => ({ x, y: 0.25, z, chord: c, thick: 0.1 })));
  const fin = new Wing([[0.3, 6.9, 2.15], [1.0, 7.0, 1.98], [2.0, 7.25, 1.6], [2.5, 7.48, 1.22], [2.72, 7.7, 0.82], [2.82, 7.95, 0.4]].map(([x, z, c]) => ({ x, z, chord: c, thick: 0.1 })));
  const NX = 2.85, NY = -0.05;
  const nac = new Body([
    [-3.62, 0.6, 0.6, 0.6, NY, 2], [-3.35, 0.7, 0.7, 0.7, NY, 2], [-2.3, 0.69, 0.69, 0.7, NY, 2], [-1.1, 0.62, 0.58, 0.7, NY - 0.05, 2],
    [0.5, 0.56, 0.48, 0.74, NY - 0.1, 2.2], [2.0, 0.4, 0.32, 0.55, NY - 0.08, 2.1], [3.6, 0.08, 0.06, 0.1, NY, 2],
  ]);
  const m0 = b.mark();
  wing.build(b);
  tail.build(b);
  const wz = (x, f = 0.45) => wing.at(x).z + f * wing.at(x).chord;
  balken(b, wing.proj(1), 7.4, wz(7.4), 1.35);
  balken(b, wing.proj(-1), 7.2, wz(7.2), 1.5);
  b.push(T(NX, 0, 0));
  loftM(b, nac.rings(0.35, 18), splitMat(18, 10, solid(COL.intake, MAT.PLAIN)), { capStart: true, capEnd: true });
  // annular radiator lip
  loftM(b, [nac.ring(-3.63, 18, 0, TAU, true, 0.005), nac.ring(-3.63, 18, 0, TAU, true, -0.12), nac.ring(-3.5, 18, 0, TAU, true, -0.14)], solid([0.2, 0.21, 0.2], MAT.PLAIN));
  b.pop();
  spinner(b, NX, NY, -3.6, -4.25, 0.3, COL.spinGer, MAT.PLAIN, 18, 0.5);
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const z = -2.95 + i * 0.24, y = NY + 0.15;
    const p = nac.side(z, y, side);
    if (side > 0) stub(b, NX + p[0], y, z, 0.09, 0.08, 0.14, 0.2);
    else { b.push(RY(PI)); stub(b, -(NX + p[0]), y, -z, 0.09, 0.08, 0.14, 0.2); b.pop(); }
  }
  // bomb racks (ETC) under inner wing
  for (const x of [1.45, 4.25]) { const a = wing.at(x); b.box(x, a.y - 0.2, a.z + 0.4 * a.chord, 0.09, 0.2, 0.75, W, MAT.UNDER); }
  b.mirrorX(m0.v, m0.i);
  // fuselage with glazed "beetle eye" nose
  loftM(b, fus.rings(0.3, K), (r, k, p, cap) => (p[2] < -4.5 ? [1, 1, 1, MAT.GLASS] : splitMat(K, 10)(r, k, p, cap)), { capEnd: true });
  for (let i = 0; i < 8; i++) {
    const th = (i / 8) * TAU + PI / 8, pts = [];
    for (let j = 0; j <= 3; j++) pts.push(fus.pt(lerp(-4.5, -5.25, j / 3), th, 0.012));
    barPath(b, pts, 0.02, W, MAT.CAMO);
  }
  for (const z of [-4.5, -4.95]) { const r = fus.ring(z, 12, 0, TAU, true, 0.012); r.push(r[0]); barPath(b, r, 0.02, W, MAT.CAMO); }
  // cockpit greenhouse
  const can = new Body([[-4.65, 0.55, 0.02, 0.12, 0.42, 2.2], [-4.2, 0.7, 0.45, 0.1, 0.42, 2.2], [-3.2, 0.72, 0.6, 0.1, 0.42, 2.2], [-2.4, 0.64, 0.54, 0.1, 0.42, 2.2], [-1.75, 0.42, 0.34, 0.1, 0.42, 2.2], [-1.45, 0.2, 0.1, 0.1, 0.42, 2.2]]);
  canopyLoft(b, can, 0.35);
  canopyFrames(b, can, [-4.2, -3.6, -2.95, -2.3, -1.75], [0.03, 0.75, PI / 2, PI - 0.75, PI - 0.03], -4.6, -1.55, 0.02);
  // rear dorsal MG
  bar(b, [0, 0.95, -1.75], [0, 1.15, -0.9], 0.022, COL.gun, MAT.METAL, 5);
  // ventral gondola (offset to the right) with rear MG
  const gon = new Body([[-4.4, 0.15, 0.1, 0.1, -0.62, 2.4], [-4.05, 0.32, 0.3, 0.42, -0.74, 2.6], [-2.6, 0.34, 0.3, 0.52, -0.76, 2.6], [-1.6, 0.28, 0.3, 0.36, -0.74, 2.4], [-1.2, 0.18, 0.25, 0.08, -0.66, 2.2]]);
  b.push(T(0.22, 0, 0));
  loftM(b, gon.rings(0.45, 12), (r, k, p, cap) => (p[2] < -3.7 && p[1] < -0.55 ? [1, 1, 1, MAT.GLASS] : splitMat(12, 0)(r, k, p, cap)), { capEnd: true });
  b.pop();
  bar(b, [0.22, -0.9, -1.4], [0.22, -1.1, -0.6], 0.022, COL.gun, MAT.METAL, 5);
  bar(b, [0.18, -0.1, -5.1], [0.18, -0.1, -5.6], 0.022, COL.gun, MAT.METAL, 5);
  b.push(RZ(PI / 2));
  fin.build(b, W, MAT.CAMO, W, MAT.CAMO);
  b.pop();
  for (const side of [-1, 1]) balken(b, (u, v, o = 0) => fus.side(u, v, side, 0.015 + o), 4.4, 0.08, 0.85);
  b.box(0, 0.75, 0.6, 0.025, 0.36, 0.1, W, MAT.CAMO);
  // ---- gear
  const mg = g.mark();
  const wc = [NX, -2.1, 0.25], wr = 0.58;
  for (const dx of [-0.32, 0.32]) strut(g, [NX + dx, -0.7, 0.0], [NX + dx, -2.1, 0.25], 0.065);
  g.box(NX, -1.2, 0.08, 0.7, 0.07, 0.1, COL.strut, MAT.PLAIN);
  for (const dx of [-0.6, 0.6]) plate(g, [NX + dx, -0.8, -0.8], [NX + dx, -0.8, 1.2], [NX + dx * 1.05, -1.65, 1.1], [NX + dx * 1.05, -1.65, -0.7], W, MAT.UNDER);
  wheel(g, wc, wr, 0.26);
  g.mirrorX(mg.v, mg.i);
  strut(g, [0, 0.0, 7.6], [0, -0.42, 7.8], 0.045);
  wheel(g, [0, -0.42, 7.8], 0.2, 0.12, COL.hub, 10);
  return finish(b, g, {
    fixedGear: false,
    camo: { a: [0.17, 0.21, 0.16], b: [0.26, 0.3, 0.19], under: [0.56, 0.67, 0.74], scale: 3.2 },
    props: [{ x: NX, y: NY, z: -3.92, r: 1.75, blades: 3, dir: 1 }, { x: -NX, y: NY, z: -3.92, r: 1.75, blades: 3, dir: 1 }],
    guns: [{ x: 0.18, y: -0.1, z: -5.6, kind: 'mg' }],
    gunners: [{ x: 0, y: 1.0, z: -1.6, arc: 'top' }, { x: 0.22, y: -0.95, z: -1.3, arc: 'bottom' }, { x: 0.18, y: -0.1, z: -5.3, arc: 'front' }],
    hardpoints: [1.45, 4.25, -1.45, -4.25].map((x) => { const a = wing.at(Math.abs(x)); return { x, y: a.y - 0.48, z: a.z + 0.4 * a.chord, kind: 'bomb500' }; }),
    mainWheel: [wc[0], wc[1] - wr, wc[2]], tailWheel: [0, -0.62, 7.8],
    cockpit: [-0.22, 0.95, -3.7],
    exhausts: mirrorPts([{ x: NX + 0.68, y: NY + 0.15, z: -2.8 }, { x: NX - 0.68, y: NY + 0.15, z: -2.8 }, { x: NX + 0.68, y: NY + 0.15, z: -2.3 }, { x: NX - 0.68, y: NY + 0.15, z: -2.3 }]),
    engines: [{ x: NX, y: NY, z: -2.5 }, { x: -NX, y: NY, z: -2.5 }],
  });
}

// ==================================================================== propellers (unit radius)
function propeller(nb) {
  const blade = new MeshBuilder();
  const R = [0.1, 0.18, 0.3, 0.45, 0.6, 0.75, 0.88, 0.9, 0.95, 0.985, 1.0];
  const C = [0.07, 0.12, 0.165, 0.185, 0.18, 0.165, 0.14, 0.135, 0.115, 0.08, 0.03];
  const ring = (i) => {
    const r = R[i], c = C[i], t = lerp(0.055, 0.014, (r - 0.1) / 0.9), beta = Math.atan2(0.32, r * 1.15);
    const sec = [[-0.42 * c, 0], [0.0, t / 2], [0.58 * c, 0], [0.0, -t / 2]];
    return sec.map(([cx, ct]) => [cx * Math.cos(beta) - ct * Math.sin(beta), r, cx * Math.sin(beta) + ct * Math.cos(beta)]);
  };
  const rings = R.map((_, i) => ring(i));
  loftM(blade, rings.slice(0, 8), solid(COL.blade, MAT.PLAIN), { capStart: true });
  loftM(blade, rings.slice(7), solid(COL.yellow, MAT.MARK), { capEnd: true });
  const b = new MeshBuilder();
  for (let i = 0; i < nb; i++) { b.push(RZ((i / nb) * TAU)); b.append(blade); b.pop(); }
  return b.build();
}

// ==================================================================== statics
export const STATIC_CAMO = { a: [0.31, 0.35, 0.23], b: [0.42, 0.38, 0.27], under: [0.5, 0.5, 0.45] };

const SC = {
  concrete: [0.55, 0.54, 0.5], darkConc: [0.4, 0.39, 0.36], door: [0.27, 0.3, 0.26], window: [0.1, 0.13, 0.17], char: [0.12, 0.11, 0.1],
  char2: [0.2, 0.18, 0.16], rubble: [0.36, 0.33, 0.3], sandbag: [0.58, 0.52, 0.37], sandbag2: [0.47, 0.42, 0.3], canvas: [0.56, 0.53, 0.4],
  brick: [0.56, 0.3, 0.22], slate: [0.26, 0.28, 0.31], tile: [0.6, 0.3, 0.2], white: [0.86, 0.84, 0.78], stone: [0.62, 0.6, 0.53],
  render: [0.8, 0.78, 0.7], green: [0.2, 0.32, 0.15], pine: [0.12, 0.24, 0.13], trunk: [0.3, 0.22, 0.15], earth: [0.36, 0.28, 0.2],
  scorch: [0.09, 0.08, 0.07], lattice: [0.3, 0.31, 0.32], gunGrey: [0.3, 0.32, 0.27], red: [0.68, 0.14, 0.12], wood: [0.36, 0.27, 0.18],
};

// arch profile of a curved-roof hangar
const hangarArc = (n, W2 = 25, Hw = 8, Hr = 14) => { const out = []; for (let i = 0; i <= n; i++) { const a = PI - (PI * i) / n; out.push([W2 * Math.cos(a), Hw + (Hr - Hw) * Math.sin(a)]); } return out; };

function hangar() {
  const b = new MeshBuilder();
  const arc = hangarArc(12), D2 = 30;
  // roof
  loftM(b, [arc.map(([x, y]) => [x, y, -D2]), arc.map(([x, y]) => [x, y, D2])], solid(W, MAT.CAMO), { closed: false });
  // roof ribs
  for (const z of [-30, -20, -10, 0, 10, 20, 30]) barPath(b, arc.map(([x, y]) => [x * 1.003, y + 0.12, z]), 0.18, SC.darkConc, MAT.PLAIN);
  // side walls with buttresses and window strips
  for (const s of [-1, 1]) {
    const x = 25 * s;
    b.quad([x, 0, -D2], [x, 0, D2], [x, 8, D2], [x, 8, -D2], W, MAT.CAMO);
    b.quad([x + s * 0.05, 5.4, -D2 + 2], [x + s * 0.05, 5.4, D2 - 2], [x + s * 0.05, 6.8, D2 - 2], [x + s * 0.05, 6.8, -D2 + 2], SC.window, MAT.PLAIN);
    for (let z = -D2; z <= D2; z += 7.5) b.box(x + s * 0.3, 4, z, 0.6, 8, 0.8, SC.darkConc, MAT.PLAIN);
  }
  // back wall
  b.poly([[-25, 0, -D2], ...arc.map(([x, y]) => [x, y, -D2]), [25, 0, -D2]].reverse(), W, MAT.CAMO);
  // front: gable above the doors, door posts, sliding doors
  const top = arc.filter(([, y]) => y >= 9.5);
  b.poly([[-25, 8, D2], [-25, 9.5, D2], ...top.map(([x, y]) => [x, y, D2]), [25, 9.5, D2], [25, 8, D2]], W, MAT.CAMO);
  b.quad([-25, 8, D2], [25, 8, D2], [25, 9.5, D2], [-25, 9.5, D2], W, MAT.CAMO);
  for (const s of [-1, 1]) b.box(s * 24, 4, D2, 2, 8, 1, SC.concrete, MAT.PLAIN);
  for (let i = 0; i < 6; i++) {
    const x0 = -23 + (46 * i) / 6, x1 = -23 + (46 * (i + 1)) / 6, z = D2 + (i % 2 ? 0.25 : 0.55);
    b.quad([x0 + 0.08, 0, z], [x1 - 0.08, 0, z], [x1 - 0.08, 8, z], [x0 + 0.08, 8, z], SC.door, MAT.PLAIN);
    b.quad([x0 + 0.6, 6, z + 0.02], [x1 - 0.6, 6, z + 0.02], [x1 - 0.6, 7.2, z + 0.02], [x0 + 0.6, 7.2, z + 0.02], SC.window, MAT.PLAIN);
  }
  b.box(0, 8.4, D2 + 0.3, 50, 0.8, 1.2, SC.darkConc, MAT.PLAIN);
  return b.build();
}

const ruinCol = (rnd, pChar = 0.5, char = SC.char) => (rnd() < pChar ? [char, MAT.PLAIN] : [[0.6, 0.58, 0.55], MAT.CAMO]);
function hangarRuin() {
  const b = new MeshBuilder(), rnd = rng(1944);
  const arc = hangarArc(12), D2 = 30, nz = 6;
  // surviving roof panels (rear part), charred
  for (let j = 0; j < nz; j++) {
    const z0 = -D2 + (60 * j) / nz, z1 = -D2 + (60 * (j + 1)) / nz;
    for (let i = 0; i < arc.length - 1; i++) {
      const keep = (j === 0 && rnd() < 0.85) || (j === 1 && rnd() < 0.5) || (j === 4 && (i < 2 || i > 9) && rnd() < 0.6);
      if (!keep) continue;
      const [xa, ya] = arc[i], [xb, yb] = arc[i + 1];
      const sag = j > 0 ? rnd() * 0.8 : 0;
      const cm = ruinCol(rnd);
      b.quad([xa, ya, z0], [xb, yb, z0], [xb, yb - sag, z1], [xa, ya - sag, z1], cm[0], cm[1]);
    }
  }
  // ribs: some intact, some broken off and bent
  for (const z of [-30, -20, -10, 0, 10, 20, 30]) {
    const n = z <= -20 ? arc.length : 3 + Math.floor(rnd() * 8);
    const pts = arc.slice(0, n).map(([x, y]) => [x, y + 0.1, z]);
    if (n < arc.length) { const l = pts[pts.length - 1]; pts.push([l[0] + 2 + rnd() * 2, l[1] - 3 - rnd() * 4, z + (rnd() - 0.5) * 3]); }
    barPath(b, pts, 0.2, SC.char2, MAT.PLAIN);
    if (z > -20 && rnd() < 0.7) { const pts2 = arc.slice(arc.length - 2 - Math.floor(rnd() * 3)).map(([x, y]) => [x, y + 0.1, z]); pts2.unshift([pts2[0][0] - 2, pts2[0][1] - 4, z + 1]); barPath(b, pts2, 0.2, SC.char2, MAT.PLAIN); }
  }
  // jagged side walls
  for (const s of [-1, 1]) {
    const x = 25 * s, n = 10;
    for (let i = 0; i < n; i++) {
      const z0 = -D2 + (60 * i) / n, z1 = -D2 + (60 * (i + 1)) / n;
      const h0 = i < 2 ? 8 : 2 + rnd() * 6, h1 = i < 2 ? 8 : 1.5 + rnd() * 6;
      const cm = ruinCol(rnd, 0.6, SC.char2);
      b.quad([x, 0, z0], [x, 0, z1], [x, h1, z1], [x, h0, z0], cm[0], cm[1]);
    }
    for (let z = -D2; z <= D2; z += 7.5) b.box(x + s * 0.3, 3.5, z, 0.6, 7, 0.8, SC.darkConc, MAT.PLAIN);
  }
  b.poly([[-25, 0, -D2], ...arc.map(([x, y]) => [x, y, -D2]), [25, 0, -D2]].reverse(), SC.char2, MAT.PLAIN);
  // fallen roof sections leaning down to the floor
  for (let i = 0; i < 6; i++) {
    const x = (rnd() - 0.5) * 36, z = -8 + rnd() * 34, w = 6 + rnd() * 6, l = 8 + rnd() * 6, a = rnd() * TAU, h = 1 + rnd() * 6;
    b.push(chain(T(x, 0, z), RY(a)));
    const cm = ruinCol(rnd);
    b.quad([-w / 2, 0.1, -l / 2], [w / 2, 0.1, -l / 2], [w / 2, h, l / 2], [-w / 2, h * 0.8, l / 2], cm[0], cm[1]);
    b.pop();
  }
  // twisted door panels
  for (let i = 0; i < 4; i++) { b.push(chain(T(-18 + i * 12 + rnd() * 3, 0, D2 + 1 + rnd() * 3), RY((rnd() - 0.5) * 0.8), RX(-1.2 - rnd() * 0.35))); b.quad([-3.5, 0, 0], [3.5, 0, 0], [3.5, 8, 0], [-3.5, 8, 0], SC.door, MAT.PLAIN); b.pop(); }
  // rubble heaps
  for (let i = 0; i < 46; i++) {
    const x = (rnd() - 0.5) * 48, z = (rnd() - 0.5) * 58, s = 0.6 + rnd() * 2.2;
    b.push(chain(T(x, s * 0.3, z), RY(rnd() * TAU), RX((rnd() - 0.5) * 0.6)));
    b.box(0, 0, 0, s * (1 + rnd()), s * 0.7, s, rnd() < 0.5 ? SC.rubble : SC.char2, MAT.PLAIN);
    b.pop();
  }
  // scorched floor patches
  for (let i = 0; i < 5; i++) b.disc([(rnd() - 0.5) * 36, 0.04 + i * 0.005, (rnd() - 0.5) * 46], [0, 1, 0], 5 + rnd() * 5, 10, SC.scorch, MAT.PLAIN);
  return b.build();
}

function tower() {
  const b = new MeshBuilder();
  b.box(0, 1.8, 0, 10, 3.6, 8, SC.render, MAT.PLAIN);
  b.box(0, 5.4, -0.5, 10, 3.6, 7, SC.render, MAT.PLAIN);
  b.box(0, 7.35, -0.5, 10.4, 0.3, 7.4, SC.darkConc, MAT.PLAIN);
  // balcony + railings
  b.box(0, 3.7, 3.5, 10.6, 0.2, 2.0, SC.darkConc, MAT.PLAIN);
  const rail = (x0, z0, x1, z1, y) => { bar(b, [x0, y + 1.0, z0], [x1, y + 1.0, z1], 0.04, SC.lattice); for (let t = 0; t <= 1.0001; t += 0.125) bar(b, [lerp(x0, x1, t), y, lerp(z0, z1, t)], [lerp(x0, x1, t), y + 1.0, lerp(z0, z1, t)], 0.03, SC.lattice); };
  rail(-5.2, 4.45, 5.2, 4.45, 3.8); rail(-5.2, 2.6, -5.2, 4.45, 3.8); rail(5.2, 2.6, 5.2, 4.45, 3.8);
  rail(-5.1, 3.1, 5.1, 3.1, 7.5); rail(-5.1, -4.1, -5.1, 3.1, 7.5); rail(5.1, -4.1, 5.1, 3.1, 7.5);
  // windows
  const win = (x0, x1, y0, y1, z) => b.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], SC.window, MAT.PLAIN);
  win(-4.6, -1.0, 1.2, 2.8, 4.02); win(1.0, 4.6, 1.2, 2.8, 4.02); b.quad([-0.5, 0, 4.02], [0.5, 0, 4.02], [0.5, 2.3, 4.02], [-0.5, 2.3, 4.02], SC.door, MAT.PLAIN);
  win(-4.7, 4.7, 4.4, 6.6, 3.02);
  for (const s of [-1, 1]) { const x = s * 5.02; b.quad([x, 4.4, 2.6], [x, 4.4, -1.5], [x, 6.6, -1.5], [x, 6.6, 2.6], SC.window, MAT.PLAIN); b.quad([x, 1.2, 2.5], [x, 1.2, -2.5], [x, 2.8, -2.5], [x, 2.8, 2.5], SC.window, MAT.PLAIN); }
  // roof control cabin + mast
  b.box(0, 8.6, -1.5, 3.2, 2.2, 3.0, SC.render, MAT.PLAIN);
  b.box(0, 8.9, -1.5, 3.25, 1.1, 3.05, SC.window, MAT.PLAIN);
  bar(b, [3.5, 7.5, -3.5], [3.5, 12.5, -3.5], 0.06, SC.lattice, MAT.PLAIN, 5);
  return b.build();
}

function fuelTank() {
  const b = new MeshBuilder();
  b.cylinder([0, 0, 0], [0, 6, 0], 4, 4, 20, [0.6, 0.62, 0.6], MAT.PLAIN, false);
  b.cylinder([0, 6, 0], [0, 6.9, 0], 4.05, 0.4, 20, [0.52, 0.54, 0.52], MAT.PLAIN, true);
  b.cylinder([0, 2.9, 0], [0, 3.3, 0], 4.03, 4.03, 20, [0.42, 0.44, 0.42], MAT.PLAIN, false);
  for (const a of [0.3, 0.42]) bar(b, [Math.cos(a) * 4.1, 0, Math.sin(a) * 4.1], [Math.cos(a) * 4.1, 6.2, Math.sin(a) * 4.1], 0.04, SC.lattice);
  for (let y = 0.3; y < 6; y += 0.45) bar(b, [Math.cos(0.3) * 4.1, y, Math.sin(0.3) * 4.1], [Math.cos(0.42) * 4.1, y, Math.sin(0.42) * 4.1], 0.025, SC.lattice);
  b.cylinder([0, 0, 0], [0, 0.3, 0], 4.6, 4.6, 20, SC.concrete, MAT.PLAIN, true);
  return b.build();
}

// ring of sandbags: arc from a0 to a1 (radians) of radius R, wall height h
function sandbagArc(b, cx, cz, R, a0, a1, h, th, nSeg, courses = 3) {
  const prof = [];
  const lay = h / courses;
  prof.push([R + th / 2, 0, 0]);
  for (let c = 0; c < courses; c++) { const y0 = c * lay; prof.push([R + th / 2 + 0.07, y0 + lay * 0.5, 1], [R + th / 2 - 0.03, y0 + lay, 0]); }
  prof.push([R, h + 0.08, 1], [R - th / 2 + 0.03, h, 0]);
  for (let c = courses - 1; c >= 0; c--) { const y0 = c * lay; prof.push([R - th / 2 - 0.07, y0 + lay * 0.5, 1], [R - th / 2, y0, 0]); }
  const rings = [];
  for (let i = 0; i <= nSeg; i++) {
    const a = lerp(a0, a1, i / nSeg);
    rings.push(prof.map(([r, y]) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]));
  }
  // per-face colours: bulging bag faces lighter
  loftM(b, rings, (r, k) => [...(prof[k][2] || prof[(k + 1) % prof.length][2] ? SC.sandbag : SC.sandbag2), MAT.PLAIN], { closed: false, capStart: true, capEnd: true });
}

function flakBase() {
  const b = new MeshBuilder();
  sandbagArc(b, 0, 0, 3.7, 0.35, TAU - 0.35, 1.5, 0.8, 24);
  b.cylinder([0, 0, 0], [0, 0.08, 0], 3.3, 3.3, 16, SC.concrete, MAT.PLAIN, true);
  // cruciform platform + pedestal (trunnion of flakGun sits at y = 1.6)
  for (const a of [0, PI / 2]) { b.push(RY(a + PI / 4)); b.box(0, 0.25, 0, 5.6, 0.3, 0.45, SC.gunGrey, MAT.PLAIN); b.pop(); }
  b.cylinder([0, 0.3, 0], [0, 1.2, 0], 0.55, 0.45, 10, SC.gunGrey, MAT.PLAIN, true);
  // ammo boxes
  for (const a of [1.2, 2.0, 4.4]) b.box(Math.cos(a) * 2.9, 0.3, Math.sin(a) * 2.9, 0.8, 0.45, 0.5, [0.3, 0.33, 0.24], MAT.PLAIN);
  return b.build();
}

function flakGun() {
  const b = new MeshBuilder(), c = SC.gunGrey;
  b.cylinder([0, 0.05, 1.2], [0, 0.05, -5.0], 0.085, 0.07, 8, c, MAT.PLAIN, false);
  b.cylinder([0, 0.05, -4.85], [0, 0.05, -5.15], 0.1, 0.1, 8, c, MAT.PLAIN, true);
  b.cylinder([0, 0.28, 1.0], [0, 0.28, -2.0], 0.13, 0.13, 8, c, MAT.PLAIN, true);
  b.cylinder([0, -0.18, 0.8], [0, -0.18, -1.4], 0.1, 0.1, 6, c, MAT.PLAIN, true);
  b.box(0, 0.05, 0.1, 0.62, 0.55, 1.6, c, MAT.PLAIN);
  b.box(0, 0.05, 1.45, 0.48, 0.5, 0.8, [0.24, 0.25, 0.22], MAT.PLAIN);
  b.cylinder([-0.6, 0, 0], [0.6, 0, 0], 0.12, 0.12, 8, c, MAT.PLAIN, true);
  for (const s of [-1, 1]) b.box(s * 0.42, -0.05, 0.1, 0.08, 0.7, 1.1, c, MAT.PLAIN);
  // equilibrators
  for (const s of [-1, 1]) b.cylinder([s * 0.5, 0.1, -0.6], [s * 0.5, -0.7, 0.5], 0.08, 0.08, 6, c, MAT.PLAIN, false);
  // shield
  const z = -0.75;
  b.quad([-1.2, -0.6, z], [-0.15, -0.6, z], [-0.15, 0.9, z], [-1.2, 0.9, z], c, MAT.PLAIN);
  b.quad([0.15, -0.6, z], [1.2, -0.6, z], [1.2, 0.9, z], [0.15, 0.9, z], c, MAT.PLAIN);
  b.quad([-0.15, 0.25, z], [0.15, 0.25, z], [0.15, 0.9, z], [-0.15, 0.9, z], c, MAT.PLAIN);
  for (const s of [-1, 1]) b.quad([s * 1.2, -0.6, z], [s * 1.6, -0.6, z + 0.55], [s * 1.6, 0.9, z + 0.55], [s * 1.2, 0.9, z], c, MAT.PLAIN);
  b.box(0.75, 0.35, 0.6, 0.2, 0.3, 0.35, [0.2, 0.2, 0.2], MAT.PLAIN);
  return b.build();
}

function lightAA() {
  const b = new MeshBuilder(), c = SC.gunGrey;
  b.cylinder([0, 0.1, 0.4], [0, 0.1, -2.6], 0.045, 0.04, 6, c, MAT.PLAIN, false);
  b.cylinder([0, 0.1, -2.55], [0, 0.1, -2.95], 0.055, 0.09, 6, [0.18, 0.18, 0.18], MAT.METAL, false);
  b.cylinder([0, 0.1, -0.15], [0, 0.1, -1.1], 0.09, 0.09, 6, c, MAT.PLAIN, true);
  b.box(0, 0.1, 0.35, 0.34, 0.42, 1.1, c, MAT.PLAIN);
  b.box(0, 0.48, 0.15, 0.16, 0.42, 0.34, [0.42, 0.36, 0.2], MAT.PLAIN);
  b.cylinder([-0.45, 0, 0.1], [0.45, 0, 0.1], 0.08, 0.08, 6, c, MAT.PLAIN, true);
  for (const s of [-1, 1]) { b.box(s * 0.3, -0.05, 0.2, 0.06, 0.55, 0.9, c, MAT.PLAIN); b.box(s * 0.72, 0.3, 0.05, 0.08, 0.4, 0.08, [0.2, 0.2, 0.2], MAT.PLAIN); bar(b, [s * 0.34, 0.25, 0.05], [s * 0.72, 0.3, 0.05], 0.02, [0.2, 0.2, 0.2]); }
  // side shields
  for (const s of [-1, 1]) b.quad([s * 0.5, -0.4, -0.5], [s * 0.85, -0.4, 0.3], [s * 0.85, 0.5, 0.3], [s * 0.5, 0.5, -0.5], c, MAT.PLAIN);
  return b.build();
}

function tent() {
  const b = new MeshBuilder();
  b.cylinder([0, 0, 0], [0, 0.75, 0], 2.5, 2.5, 12, SC.canvas, MAT.PLAIN, false);
  b.cylinder([0, 0.75, 0], [0, 3.3, 0], 2.62, 0.12, 12, [0.6, 0.57, 0.44], MAT.PLAIN, false);
  b.cylinder([0, 3.3, 0], [0, 3.6, 0], 0.04, 0.04, 4, SC.wood, MAT.PLAIN, false);
  b.quad([-0.5, 0.0, 2.52], [0.5, 0.0, 2.52], [0.2, 1.7, 2.52], [-0.2, 1.7, 2.52], [0.32, 0.3, 0.22], MAT.PLAIN);
  return b.build();
}

function hut() {
  const b = new MeshBuilder(), R = 4, L = 8, n = 12;
  const arc = []; for (let i = 0; i <= n; i++) { const a = PI - (PI * i) / n; arc.push([Math.cos(a) * R, Math.sin(a) * R]); }
  loftM(b, [arc.map(([x, y]) => [x, y, -L]), arc.map(([x, y]) => [x, y, L])], (r, k) => [...(k % 2 ? [0.29, 0.31, 0.27] : [0.24, 0.26, 0.22]), MAT.PLAIN], { closed: false });
  for (const s of [-1, 1]) {
    const z = s * L;
    const pts = [[-R, 0, z], ...arc.slice(1, n).map(([x, y]) => [x, y, z]), [R, 0, z]];
    b.poly(s > 0 ? pts : pts.slice().reverse(), [0.36, 0.3, 0.24], MAT.PLAIN);
    const zz = z + s * 0.03;
    b.quad([-0.6, 0, zz], [0.6, 0, zz], [0.6, 2.1, zz], [-0.6, 2.1, zz], SC.door, MAT.PLAIN);
    for (const x of [-2.2, 2.2]) b.quad([x - 0.5, 1.2, zz], [x + 0.5, 1.2, zz], [x + 0.5, 2.1, zz], [x - 0.5, 2.1, zz], SC.window, MAT.PLAIN);
  }
  b.cylinder([1.5, 3.5, 4], [1.5, 5.2, 4], 0.1, 0.1, 5, [0.1, 0.1, 0.1], MAT.PLAIN, false);
  return b.build();
}

// gabled / hipped house. Box w (x) by d (z), walls h, roof rise rh.
function house(b, { x = 0, z = 0, w, d, h, rh, wall, roof, hip = false, chimneys = [], ry = 0, door = true, storeys = 1 }) {
  b.push(chain(T(x, 0, z), RY(ry)));
  const hw = w / 2, hd = d / 2, o = 0.35;
  b.box(0, h / 2, 0, w, h, d, wall, MAT.PLAIN);
  if (hip) {
    const r = hw * 0.45;
    const A = [-hw - o, h - 0.2, -hd - o], B = [hw + o, h - 0.2, -hd - o], C = [hw + o, h - 0.2, hd + o], D = [-hw - o, h - 0.2, hd + o];
    const P = [-hw + r, h + rh, 0], Q = [hw - r, h + rh, 0];
    b.quad(D, C, Q, P, roof, MAT.PLAIN); b.quad(B, A, P, Q, roof, MAT.PLAIN);
    b.tri(A, D, P, roof, MAT.PLAIN); b.tri(C, B, Q, roof, MAT.PLAIN);
  } else {
    const yE = h - 0.2;
    b.quad([-hw - o, yE, hd + o], [hw + o, yE, hd + o], [hw + o, h + rh, 0], [-hw - o, h + rh, 0], roof, MAT.PLAIN);
    b.quad([hw + o, yE, -hd - o], [-hw - o, yE, -hd - o], [-hw - o, h + rh, 0], [hw + o, h + rh, 0], roof, MAT.PLAIN);
    for (const s of [-1, 1]) b.tri([s * hw, h, -hd], [s * hw, h, hd], [s * hw, h + rh - 0.1, 0], wall, MAT.PLAIN);
  }
  for (const [cx, cz] of chimneys) b.box(cx, h + rh * 0.7, cz, 0.7, rh * 1.1 + 0.6, 0.9, [0.45, 0.25, 0.2], MAT.PLAIN);
  // windows on the long sides
  const nW = Math.max(2, Math.floor(w / 2.6));
  for (const s of [-1, 1]) {
    const zz = s * (hd + 0.02);
    for (let st = 0; st < storeys; st++) {
      for (let i = 0; i < nW; i++) {
        const cx = -hw + ((i + 0.5) * w) / nW;
        if (door && st === 0 && s > 0 && i === Math.floor(nW / 2)) { b.quad([cx - 0.5, 0, zz], [cx + 0.5, 0, zz], [cx + 0.5, 2.2, zz], [cx - 0.5, 2.2, zz], [0.25, 0.18, 0.12], MAT.PLAIN); continue; }
        const y0 = 1.0 + st * (h / storeys), y1 = y0 + 1.25;
        const q = s > 0 ? [[cx - 0.5, y0, zz], [cx + 0.5, y0, zz], [cx + 0.5, y1, zz], [cx - 0.5, y1, zz]] : [[cx + 0.5, y0, zz], [cx - 0.5, y0, zz], [cx - 0.5, y1, zz], [cx + 0.5, y1, zz]];
        b.quad(...q, SC.window, MAT.PLAIN);
      }
    }
  }
  b.pop();
}

function house1() { const b = new MeshBuilder(); house(b, { w: 9, d: 6.5, h: 5.2, rh: 3.4, wall: SC.brick, roof: SC.slate, chimneys: [[-4.0, 0], [4.0, 0]], storeys: 2 }); return b.build(); }
function house2() {
  const b = new MeshBuilder();
  house(b, { w: 12, d: 7, h: 5.0, rh: 3.0, wall: SC.white, roof: SC.tile, hip: true, chimneys: [[2.5, 0.5]], storeys: 2 });
  house(b, { x: 8.2, z: 0.8, w: 4.6, d: 5.0, h: 3.0, rh: 1.6, wall: [0.78, 0.74, 0.64], roof: SC.tile, door: false });
  return b.build();
}
function house3() {
  const b = new MeshBuilder();
  house(b, { w: 10, d: 7, h: 6.5, rh: 4.0, wall: SC.stone, roof: [0.36, 0.24, 0.2], chimneys: [[-4.5, 0]], storeys: 2 });
  house(b, { x: 3, z: 5.5, w: 5, d: 5.5, h: 5.5, rh: 3.0, wall: SC.stone, roof: [0.36, 0.24, 0.2], ry: PI / 2, door: false, storeys: 2 });
  return b.build();
}

function church() {
  const b = new MeshBuilder();
  const wall = SC.stone, roof = SC.slate;
  // nave (z -5..11), chancel (11..16), tower (-10.5..-5)
  house(b, { z: 3, w: 9, d: 16, h: 8, rh: 5.5, wall, roof, ry: PI / 2, door: false });
  house(b, { z: 13.5, w: 6.5, d: 5, h: 6.5, rh: 4, wall, roof, ry: PI / 2, door: false });
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
    const z = -3 + i * 3.6, x = s * 4.52;
    const pts = [[x, 2.5, z - 0.5], [x, 2.5, z + 0.5], [x, 5.2, z + 0.5], [x, 5.9, z], [x, 5.2, z - 0.5]];
    b.poly(s > 0 ? pts.slice().reverse() : pts, SC.window, MAT.PLAIN);
  }
  b.box(0, 9, -7.75, 5.5, 18, 5.5, [0.58, 0.56, 0.5], MAT.PLAIN);
  b.box(0, 18.4, -7.75, 6.0, 0.8, 6.0, [0.52, 0.5, 0.45], MAT.PLAIN);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cylinder([sx * 2.6, 18.8, -7.75 + sz * 2.6], [sx * 2.6, 20.8, -7.75 + sz * 2.6], 0.35, 0.02, 4, [0.52, 0.5, 0.45], MAT.PLAIN, true);
  for (const [dx, dz, nx] of [[0, -2.77, 0], [0, 2.77, 0], [-2.77, 0, 1], [2.77, 0, 1]]) {
    const cx = dx, cz = -7.75 + dz;
    if (nx) b.quad([cx, 14, cz - 0.6], [cx, 14, cz + 0.6], [cx, 16.5, cz + 0.6], [cx, 16.5, cz - 0.6], SC.window, MAT.PLAIN);
    else b.quad([cx - 0.6, 14, cz], [cx + 0.6, 14, cz], [cx + 0.6, 16.5, cz], [cx - 0.6, 16.5, cz], SC.window, MAT.PLAIN);
  }
  b.quad([-0.8, 0, -10.52], [0.8, 0, -10.52], [0.8, 3, -10.52], [-0.8, 3, -10.52], [0.25, 0.18, 0.12], MAT.PLAIN);
  return b.build();
}

function windmill() {
  const b = new MeshBuilder();
  b.cylinder([0, 0, 0], [0, 8.5, 0], 3.2, 2.3, 12, SC.white, MAT.PLAIN, false);
  loftM(b, [0, 0.35, 0.65, 0.88, 1].map((t) => { const r = 2.55 * Math.sqrt(1 - t * t * 0.96), y = 8.5 + t * 2.6, out = []; for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; out.push([Math.cos(a) * r, y, Math.sin(a) * r * 1.15]); } return out; }), solid([0.3, 0.24, 0.18], MAT.PLAIN), { capStart: true });
  b.cylinder([0, 9.8, -1.8], [0, 9.8, -3.2], 0.3, 0.25, 8, SC.wood, MAT.PLAIN, true);
  b.push(T(0, 9.8, -3.1));
  for (let i = 0; i < 4; i++) {
    b.push(RZ(PI / 4 + (i * PI) / 2));
    b.box(0, 3.4, 0, 0.22, 6.8, 0.22, SC.wood, MAT.PLAIN);
    b.quad([0.15, 1.3, 0.05], [1.6, 1.3, 0.12], [1.6, 6.7, 0.12], [0.15, 6.7, 0.05], [0.8, 0.76, 0.66], MAT.PLAIN);
    for (let y = 1.3; y <= 6.8; y += 1.1) b.box(0.88, y, 0.16, 1.5, 0.06, 0.05, SC.wood, MAT.PLAIN);
    b.box(1.62, 4.0, 0.16, 0.06, 5.4, 0.05, SC.wood, MAT.PLAIN);
    b.pop();
  }
  b.pop();
  b.quad([-0.6, 0, -3.18], [0.6, 0, -3.18], [0.6, 2.2, -3.13], [-0.6, 2.2, -3.13], [0.25, 0.18, 0.12], MAT.PLAIN);
  for (const y of [3.5, 6.2]) b.quad([-0.35, y, 3.05 - y * 0.1], [0.35, y, 3.05 - y * 0.1], [0.35, y + 0.9, 3.0 - (y + 0.9) * 0.1], [-0.35, y + 0.9, 3.0 - (y + 0.9) * 0.1], SC.window, MAT.PLAIN);
  return b.build();
}

function lighthouse() {
  const b = new MeshBuilder();
  const segs = [[0, 6, SC.white], [6, 9, SC.red], [9, 14, SC.white], [14, 17, SC.red], [17, 19, SC.white]];
  const rAt = (y) => lerp(2.6, 1.6, y / 19);
  for (const [y0, y1, c] of segs) b.cylinder([0, y0, 0], [0, y1, 0], rAt(y0), rAt(y1), 14, c, MAT.PLAIN, false);
  b.cylinder([0, 19, 0], [0, 19.35, 0], 2.4, 2.4, 14, [0.15, 0.15, 0.15], MAT.PLAIN, true);
  b.cylinder([0, 20.2, 0], [0, 20.3, 0], 2.3, 2.3, 14, [0.15, 0.15, 0.15], MAT.PLAIN, false);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; bar(b, [Math.cos(a) * 2.3, 19.35, Math.sin(a) * 2.3], [Math.cos(a) * 2.3, 20.3, Math.sin(a) * 2.3], 0.03, [0.15, 0.15, 0.15]); }
  b.cylinder([0, 19.35, 0], [0, 21.9, 0], 1.3, 1.3, 12, W, MAT.GLASS, false);
  b.cylinder([0, 19.8, 0], [0, 21.0, 0], 0.5, 0.5, 8, [1.0, 0.9, 0.55], MAT.EMIT, true);
  b.cylinder([0, 21.9, 0], [0, 23.4, 0], 1.6, 0.15, 12, SC.red, MAT.PLAIN, true);
  b.cylinder([0, 23.4, 0], [0, 24.6, 0], 0.05, 0.05, 4, [0.1, 0.1, 0.1], MAT.PLAIN, false);
  b.quad([-0.6, 0, -2.62], [0.6, 0, -2.62], [0.6, 2.2, -2.62], [-0.6, 2.2, -2.62], [0.2, 0.25, 0.3], MAT.PLAIN);
  house(b, { x: 5.5, w: 6, d: 5, h: 3.5, rh: 2, wall: SC.white, roof: SC.slate, ry: PI / 2 });
  return b.build();
}

function radarMast() {
  const b = new MeshBuilder(), c = SC.lattice;
  const H = 100, rb = 5, rt = 1.3;
  const corner = (y, sx, sz) => { const r = lerp(rb, rt, y / H); return [sx * r, y, sz * r]; };
  const lbar = (p, q, w = 0.35) => {
    // two crossed flat strips (visible from any angle, 4 tris)
    const d = norm(sub(q, p));
    const u = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), v = cross(d, u);
    for (const s of [u, v]) { const o = scl3(s, w / 2); b.quad(sub(p, o), add3(p, o), add3(q, o), sub(q, o), c, MAT.PLAIN); }
  };
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of C) b.cylinder(corner(0, sx, sz), corner(H, sx, sz), 0.35, 0.2, 4, c, MAT.PLAIN, false);
  const levels = [0.5, 16, 32, 48, 64, 80, 96];
  for (let li = 0; li < levels.length; li++) {
    const y = levels[li];
    for (let f = 0; f < 4; f++) {
      const [ax, az] = C[f], [bx, bz] = C[(f + 1) % 4];
      lbar(corner(y, ax, az), corner(y, bx, bz));
      if (li < levels.length - 1) { const y2 = levels[li + 1]; if ((li + f) % 2) lbar(corner(y, ax, az), corner(y2, bx, bz)); else lbar(corner(y, bx, bz), corner(y2, ax, az)); }
    }
  }
  for (const y of [32, 64, 99]) { const r = lerp(rb, rt, y / H); b.box(0, y, 0, r * 2 + 3, 0.4, r * 2 + 1.5, c, MAT.PLAIN); b.box(0, y + 0.3, 0, 0.5, 0.3, r * 2 + 9, c, MAT.PLAIN); }
  b.box(0, 100.4, 0, 0.5, 0.5, 0.5, [1, 0.1, 0.05], MAT.EMIT);
  return b.build();
}

function treePine() {
  const b = new MeshBuilder();
  b.cylinder([0, 0, 0], [0, 3, 0], 0.28, 0.16, 5, SC.trunk, MAT.PLAIN, false);
  b.cylinder([0, 2.2, 0], [0, 8.4, 0], 3.0, 0, 6, [0.11, 0.22, 0.12], MAT.PLAIN, true);
  b.cylinder([0, 5.4, 0], [0, 11.4, 0], 2.3, 0, 6, [0.13, 0.25, 0.13], MAT.PLAIN, true);
  b.cylinder([0, 8.6, 0], [0, 14.2, 0], 1.5, 0, 6, [0.15, 0.28, 0.15], MAT.PLAIN, false);
  return b.build();
}

function icosa(b, c, rx, ry, rz, col, rnd, jit = 0.18) {
  const t = (1 + Math.sqrt(5)) / 2;
  const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => {
    const n = norm(v), j = 1 + (rnd() - 0.5) * 2 * jit; return [c[0] + n[0] * rx * j, c[1] + n[1] * ry * j, c[2] + n[2] * rz * j];
  });
  const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (const [a, bb, cc] of F) { const s = 0.85 + rnd() * 0.3; b.tri(V[a], V[bb], V[cc], [col[0] * s, col[1] * s, col[2] * s], MAT.PLAIN); }
}
function treeOak() {
  const b = new MeshBuilder(), rnd = rng(77);
  b.cylinder([0, 0, 0], [0, 4.5, 0], 0.45, 0.3, 5, SC.trunk, MAT.PLAIN, false);
  icosa(b, [0, 7.4, 0], 4.4, 3.4, 4.2, [0.2, 0.31, 0.13], rnd);
  icosa(b, [1.2, 9.6, -0.6], 2.6, 2.0, 2.6, [0.23, 0.35, 0.15], rnd);
  return b.build();
}

function sandbags() {
  const b = new MeshBuilder();
  sandbagArc(b, 0, 4, 4, -PI / 2 - 0.5, -PI / 2 + 0.5, 1.1, 0.6, 6, 3);
  return b.build();
}

function crater() {
  const b = new MeshBuilder(), rnd = rng(9), n = 18;
  const prof = [[0, 0.12, SC.scorch], [2.6, 0.13, SC.scorch], [4.0, 0.32, [0.17, 0.14, 0.11]], [4.9, 0.78, SC.earth], [5.6, 0.6, [0.4, 0.32, 0.23]], [6.4, 0.08, [0.42, 0.35, 0.25]]];
  const noise = []; for (let k = 0; k < n; k++) noise.push(0.75 + rnd() * 0.5);
  const rings = prof.map(([r, y], i) => { const out = []; for (let k = 0; k < n; k++) { const a = (k / n) * TAU, rr = r * (i ? 0.92 + rnd() * 0.16 : 1), yy = i >= 2 && i <= 4 ? y * noise[k] : y; out.push([Math.cos(a) * rr, yy, Math.sin(a) * rr]); } return out; });
  // per-ring colours (faces take the colour of their inner ring)
  loftM(b, rings, (r) => [...prof[r][2], MAT.PLAIN]);
  for (let i = 0; i < 8; i++) { const a = rnd() * TAU, r = 5 + rnd() * 2.5; b.push(chain(T(Math.cos(a) * r, 0.25, Math.sin(a) * r), RY(rnd() * 3), RX(rnd() * 0.5))); b.box(0, 0, 0, 0.6 + rnd(), 0.4, 0.5 + rnd() * 0.6, SC.earth, MAT.PLAIN); b.pop(); }
  return b.build();
}

function windsock() {
  const b = new MeshBuilder();
  b.cylinder([0, 0, 0], [0, 6.3, 0], 0.07, 0.05, 6, [0.85, 0.85, 0.82], MAT.PLAIN, false);
  const n = 5, L = 3.4;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const p0 = [0, 6.0 - 0.35 * t0 * t0, -0.15 - L * t0], p1 = [0, 6.0 - 0.35 * t1 * t1, -0.15 - L * t1];
    b.cylinder(p0, p1, lerp(0.45, 0.22, t0), lerp(0.45, 0.22, t1), 8, i % 2 ? [0.95, 0.95, 0.92] : [0.98, 0.42, 0.08], MAT.PLAIN, false);
  }
  return b.build();
}

function bomb(kind) {
  const b = new MeshBuilder();
  const brit = kind === 500;
  const L = brit ? 1.5 : 1.64, R = brit ? 0.175 : 0.185, col = brit ? [0.3, 0.33, 0.22] : [0.34, 0.36, 0.28];
  const prof = brit
    ? [[-0.75, 0.0], [-0.72, 0.06], [-0.64, 0.12], [-0.5, 0.16], [-0.35, R], [0.15, R], [0.32, 0.13], [0.45, 0.075], [0.55, 0.06]]
    : [[-0.82, 0.0], [-0.79, 0.08], [-0.7, 0.14], [-0.55, R], [0.12, R], [0.3, 0.14], [0.42, 0.09], [0.5, 0.07]];
  const rings = prof.map(([z, r]) => { const out = []; for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; out.push([Math.cos(a) * r, Math.sin(a) * r, z]); } return out; });
  loftM(b, rings, solid(col, MAT.PLAIN), { capEnd: true });
  const fz0 = brit ? 0.3 : 0.28, fz1 = L / 2;
  for (let i = 0; i < 4; i++) {
    b.push(RZ((i * PI) / 2 + PI / 4));
    b.quad([0, 0.06, fz0], [0, 0.06, fz1], [0, 0.22, fz1], [0, 0.18, fz0], col, MAT.PLAIN);
    b.pop();
  }
  if (brit) b.cylinder([0, 0, fz1 - 0.2], [0, 0, fz1], 0.2, 0.2, 8, col, MAT.PLAIN, false);
  else for (let i = 0; i < 4; i++) { b.push(RZ((i * PI) / 2 + PI / 4)); b.box(0.11, 0.11, fz1 - 0.12, 0.2, 0.02, 0.05, col, MAT.PLAIN); b.pop(); }
  b.cylinder([0, 0, -0.42], [0, 0, -0.36], R + 0.004, R + 0.004, 10, brit ? [0.75, 0.2, 0.15] : [0.85, 0.7, 0.15], MAT.MARK, false);
  return b.build();
}

function parachute() {
  const b = new MeshBuilder(), n = 14, R = 3.5;
  const rings = [];
  for (const t of [0.02, 0.25, 0.5, 0.75, 1.0]) {
    const a = t * 1.2, out = [];
    for (let k = 0; k < n; k++) { const ang = (k / n) * TAU, r = Math.sin(a) * R * (t === 1 ? 1.03 : 1); out.push([Math.cos(ang) * r, 8.6 - (1 - Math.cos(a)) * R * 0.75, Math.sin(ang) * r]); }
    rings.push(out);
  }
  loftM(b, rings, (r, k) => [...(k % 2 ? [0.93, 0.92, 0.86] : [0.78, 0.74, 0.6]), MAT.PLAIN], { capStart: true });
  const rim = rings[rings.length - 1];
  for (let k = 0; k < n; k += 1) { const p = rim[k], q = [p[0] * 0.04, 0.75, p[2] * 0.04]; const d = norm(sub(q, p)), u = norm(cross(d, [0, 1, 0])); b.quad(p, add3(p, scl3(u, 0.025)), add3(q, scl3(u, 0.025)), q, [0.85, 0.83, 0.75], MAT.PLAIN); }
  const suit = [0.35, 0.33, 0.25];
  b.box(0, 0.32, 0, 0.42, 0.62, 0.26, suit, MAT.PLAIN);
  b.ellipsoid([0, 0.78, 0], 0.13, 0.15, 0.14, [0.3, 0.22, 0.15], MAT.PLAIN, 8, 5);
  for (const s of [-1, 1]) { b.box(s * 0.12, -0.4, 0.04, 0.15, 0.85, 0.17, suit, MAT.PLAIN); b.box(s * 0.29, 0.62, 0, 0.11, 0.6, 0.12, suit, MAT.PLAIN); }
  return b.build();
}

function debris() {
  const b = new MeshBuilder(), rnd = rng(31);
  const P = [];
  for (let i = 0; i <= 3; i++) { const row = []; for (let j = 0; j <= 2; j++) { const u = i / 3 - 0.5, v = j / 2 - 0.5, tw = u * 1.4; row.push([u * 1.1 + (rnd() - 0.5) * 0.12, Math.sin(tw) * v * 0.6 + (rnd() - 0.5) * 0.12, Math.cos(tw) * v * 0.6 + (rnd() - 0.5) * 0.1]); } P.push(row); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { if (i === 2 && j === 1) continue; const c = rnd() < 0.5 ? SC.char : SC.char2; b.quad(P[i][j], P[i + 1][j], P[i + 1][j + 1], P[i][j + 1], c, rnd() < 0.3 ? MAT.METAL : MAT.PLAIN); }
  b.tri(P[2][1], P[3][1], P[3][2], SC.char, MAT.PLAIN);
  bar(b, [-0.55, -0.05, 0.05], [0.6, 0.12, -0.1], 0.04, [0.25, 0.24, 0.22], MAT.METAL);
  b.push(chain(T(0.2, -0.15, 0.25), RY(0.7), RX(0.9)));
  b.quad([-0.25, 0, -0.15], [0.3, 0.05, -0.2], [0.2, 0, 0.2], [-0.2, -0.05, 0.25], SC.char2, MAT.PLAIN);
  b.pop();
  return b.build();
}

function wreck() {
  const b = new MeshBuilder(), rnd = rng(5);
  const fus = new Body([[-3.6, 0.42, 0.45, 0.5, 0, 2.2], [-2.0, 0.5, 0.55, 0.7, 0, 2.3], [0, 0.5, 0.52, 0.72, 0, 2.3], [2.0, 0.38, 0.42, 0.55, 0.03, 2.1], [4.0, 0.2, 0.3, 0.32, 0.1, 2], [4.6, 0.05, 0.1, 0.06, 0.15, 2]]);
  const K = 14;
  const burnt = (r, k, p) => { const v = Math.sin(p[2] * 1.1 + Math.sin(k * 0.9) * 1.5) + 0.4 * Math.sin(p[0] * 3 + p[1] * 2); return v > 0.45 ? [1, 1, 1, MAT.CAMO] : v > -0.3 ? [...SC.char, MAT.PLAIN] : [...SC.char2, MAT.PLAIN]; };
  // front section, nose dug in
  b.push(chain(T(-0.6, 0.45, -0.4), RX(0.12), RZ(0.35)));
  loftM(b, fus.rings(0.5, K, { z0: -3.6, z1: 0.3 }), burnt, { capStart: true, capEnd: true });
  b.box(0, 0.1, -3.9, 0.6, 0.55, 0.5, [0.1, 0.1, 0.1], MAT.METAL);
  b.pop();
  // rear section, broken off and yawed
  b.push(chain(T(0.9, 0.35, 3.6), RY(0.55), RZ(-0.25), T(0, 0, -1.0)));
  loftM(b, fus.rings(0.5, K, { z0: 1.0, z1: 4.6 }), burnt, { capStart: true, capEnd: true });
  b.push(RZ(PI / 2));
  new Wing([{ x: 0.1, z: 3.7, chord: 0.95, thick: 0.1 }, { x: 0.9, z: 4.0, chord: 0.62, thick: 0.1 }, { x: 1.25, z: 4.3, chord: 0.3, thick: 0.1 }]).build(b, W, MAT.CAMO, SC.char, MAT.PLAIN, 3);
  b.pop();
  new Wing([{ x: 0, y: 0.1, z: 3.9, chord: 0.7, thick: 0.1 }, { x: 1.3, y: 0.1, z: 4.05, chord: 0.45, thick: 0.1 }]).build(b, SC.char2, MAT.PLAIN, SC.char, MAT.PLAIN, 3);
  b.pop();
  // left wing lying flat, broken; right wing stub bent up
  b.push(chain(T(-0.8, 0.12, -1.0), RZ(0.04), RY(0.1)));
  b.push(RY(PI));
  new Wing([{ x: 0.3, y: 0, z: -1.6, chord: 2.1, thick: 0.12 }, { x: 2.5, y: 0.05, z: -1.4, chord: 1.8, thick: 0.11 }, { x: 4.1, y: 0.0, z: -1.0, chord: 1.1, thick: 0.1 }]).build(b, W, MAT.CAMO, SC.char, MAT.PLAIN, 4);
  b.pop();
  b.pop();
  b.push(chain(T(0.5, 0.3, -0.9), RZ(0.55)));
  new Wing([{ x: 0.2, y: 0, z: -0.6, chord: 2.0, thick: 0.12 }, { x: 1.4, y: 0.05, z: -0.5, chord: 1.8, thick: 0.11 }, { x: 2.1, y: 0.25, z: -0.2, chord: 1.1, thick: 0.08 }]).build(b, SC.char2, MAT.PLAIN, SC.char, MAT.PLAIN, 4);
  b.pop();
  // scattered panels and an engine block
  for (let i = 0; i < 9; i++) {
    const x = (rnd() - 0.5) * 9, z = (rnd() - 0.5) * 10, s = 0.4 + rnd() * 0.8;
    b.push(chain(T(x, 0.08, z), RY(rnd() * TAU), RX((rnd() - 0.5) * 0.6)));
    b.quad([-s, 0, -s * 0.6], [s, 0.1, -s * 0.5], [s * 0.8, 0.05, s * 0.6], [-s * 0.9, 0.12, s * 0.5], rnd() < 0.5 ? SC.char : SC.char2, MAT.PLAIN);
    b.pop();
  }
  b.box(-2.2, 0.35, -4.4, 0.7, 0.7, 1.2, [0.14, 0.13, 0.12], MAT.METAL);
  b.disc([0, 0.03, 0], [0, 1, 0], 6.0, 12, SC.scorch, MAT.PLAIN);
  return b.build();
}

// ==================================================================== export
export function buildModels() {
  return {
    aircraft: { spitfire: spitfire(), mosquito: mosquito(), bf109: bf109(), fw190: fw190(), ju87: ju87(), ju88: ju88() },
    props: { prop3: propeller(3), prop4: propeller(4) },
    statics: {
      hangar: hangar(), hangarRuin: hangarRuin(), tower: tower(), fuelTank: fuelTank(), flakBase: flakBase(), flakGun: flakGun(),
      lightAA: lightAA(), tent: tent(), hut: hut(), house1: house1(), house2: house2(), house3: house3(), church: church(),
      windmill: windmill(), lighthouse: lighthouse(), radarMast: radarMast(), treePine: treePine(), treeOak: treeOak(),
      sandbags: sandbags(), crater: crater(), windsock: windsock(), bomb500: bomb(500), bomb250: bomb(250),
      parachute: parachute(), debris: debris(), wreck: wreck(),
    },
  };
}
