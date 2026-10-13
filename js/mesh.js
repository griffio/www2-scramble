// Mesh builder for procedural low-poly models.
// Vertex format (interleaved, 20 bytes): position f32x3 | normal i8x4 (normalised) | colour u8x4
// Colour alpha carries the material id (see MAT). Models are rendered double-sided and the
// shader flips the normal on back faces, so a triangle's winding only has to agree with
// the normal stored for it (the builder computes normals from the winding).
//
// Model axes: x = right, y = up, -z = forward (nose), metres.

export const MAT = {
  PLAIN: 0,     // lit vertex colour
  CAMO: 1,      // upper-surface camouflage: per-model colours camo.a / camo.b blended by a noise pattern
  UNDER: 2,     // underside colour camo.under
  GLASS: 3,     // canopy glazing: dark, sky reflection + strong specular
  METAL: 4,     // bare / dark metal: specular
  EMIT: 5,      // unlit (exhaust glow, lights)
  MARK: 6,      // markings (roundels, crosses, codes): lit like PLAIN but never camouflaged or sooted
};

export class MeshBuilder {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.i = [];
    this.mstack = [];
    this.m = null;   // current affine transform [3x4 row-major] or null
  }
  get vcount() { return this.p.length / 3; }

  // ----- transform stack (applied to everything added while pushed) -----
  push(m) { this.mstack.push(this.m); this.m = this.m ? mulAff(this.m, m) : m; return this; }
  pop() { this.m = this.mstack.pop(); return this; }
  _tp(x, y, z) {
    const m = this.m;
    if (!m) return [x, y, z];
    return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
  }
  _tn(x, y, z) {
    const m = this.m;
    if (!m) return [x, y, z];
    // normal transform: inverse-transpose of the linear part
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], k = m[10];
    const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
    const D = -(b * k - c * h), E = a * k - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), K = a * e - b * d;
    let nx = A * x + B * y + C * z, ny = D * x + E * y + F * z, nz = G * x + H * y + K * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }
  _flip() { const m = this.m; if (!m) return false; const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]); return det < 0; }

  // raw vertex (already in model space unless transformed); returns index
  vertex(x, y, z, nx, ny, nz, col, mat = 0) {
    const p = this._tp(x, y, z), n = this._tn(nx, ny, nz);
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]);
    this.c.push(c255(col[0]), c255(col[1]), c255(col[2]), mat);
    return this.vcount - 1;
  }
  index(a, b, c) { if (this._flip()) this.i.push(a, c, b); else this.i.push(a, b, c); }

  // flat-shaded triangle / quad (points are [x,y,z]); normal from winding a->b->c (CCW = front)
  tri(a, b, c, col, mat = 0) {
    const n = faceNormal(a, b, c);
    const i0 = this.vertex(a[0], a[1], a[2], n[0], n[1], n[2], col, mat);
    const i1 = this.vertex(b[0], b[1], b[2], n[0], n[1], n[2], col, mat);
    const i2 = this.vertex(c[0], c[1], c[2], n[0], n[1], n[2], col, mat);
    this.index(i0, i1, i2);
    return this;
  }
  quad(a, b, c, d, col, mat = 0) { this.tri(a, b, c, col, mat); this.tri(a, c, d, col, mat); return this; }
  poly(pts, col, mat = 0) { for (let k = 1; k < pts.length - 1; k++) this.tri(pts[0], pts[k], pts[k + 1], col, mat); return this; }

  // Smooth lofted surface through rings of points. rings[r][k] = [x,y,z].
  // colFn(r, k, p) -> [r,g,b, mat]  (or a constant colour + mat)
  // closed: ring wraps around. capStart/capEnd: fan caps (flat).
  loft(rings, colFn, { closed = true, capStart = false, capEnd = false, mat = 0 } = {}) {
    const R = rings.length, K = rings[0].length;
    const cf = typeof colFn === 'function' ? colFn : () => colFn;
    // smooth normals from the grid (central differences)
    const base = this.vcount;
    for (let r = 0; r < R; r++) {
      for (let k = 0; k < K; k++) {
        const p = rings[r][k];
        const pr0 = rings[Math.max(0, r - 1)][k], pr1 = rings[Math.min(R - 1, r + 1)][k];
        const kk0 = closed ? (k - 1 + K) % K : Math.max(0, k - 1), kk1 = closed ? (k + 1) % K : Math.min(K - 1, k + 1);
        const pk0 = rings[r][kk0], pk1 = rings[r][kk1];
        const du = sub(pr1, pr0), dv = sub(pk1, pk0);
        let n = cross(dv, du);   // so that CCW winding (r,k)->(r+1,k)->(r+1,k+1) faces along n
        const l = Math.hypot(n[0], n[1], n[2]);
        if (l < 1e-9) {   // collapsed ring (a pole): point the normal along the surface axis, away from the next ring
          const ax = r === 0 ? sub(rings[0][k], rings[Math.min(1, R - 1)][k]) : sub(rings[R - 1][k], rings[Math.max(0, R - 2)][k]);
          const al = Math.hypot(ax[0], ax[1], ax[2]);
          n = al > 1e-9 ? [ax[0] / al, ax[1] / al, ax[2] / al] : [0, 1, 0];
          if (r !== 0 && r !== R - 1) n = [0, 1, 0];
        } else n = [n[0] / l, n[1] / l, n[2] / l];
        const c = cf(r, k, p);
        this.vertex(p[0], p[1], p[2], n[0], n[1], n[2], c, c[3] ?? mat);
      }
    }
    const kmax = closed ? K : K - 1;
    for (let r = 0; r < R - 1; r++) {
      for (let k = 0; k < kmax; k++) {
        const k1 = (k + 1) % K;
        const a = base + r * K + k, b = base + (r + 1) * K + k, c = base + (r + 1) * K + k1, d = base + r * K + k1;
        this.index(a, d, c); this.index(a, c, b);
      }
    }
    const cap = (ring, flip, r) => {
      const ctr = ring.reduce((s, p) => [s[0] + p[0] / K, s[1] + p[1] / K, s[2] + p[2] / K], [0, 0, 0]);
      for (let k = 0; k < K; k++) {
        const a = ring[k], b = ring[(k + 1) % K];
        const c = cf(r, k, a);
        if (flip) this.tri(ctr, b, a, c, c[3] ?? mat); else this.tri(ctr, a, b, c, c[3] ?? mat);
      }
    };
    if (capStart) cap(rings[0], false, 0);
    if (capEnd) cap(rings[R - 1], true, R - 1);
    return this;
  }

  // box centred at (cx,cy,cz), size (sx,sy,sz), flat
  box(cx, cy, cz, sx, sy, sz, col, mat = 0) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, mat);   // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col, mat);   // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col, mat);   // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col, mat);   // -x
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], col, mat);   // +y
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, mat);   // -y
    return this;
  }

  // cylinder / cone frustum from p0 to p1 with radii r0, r1, n sides, smooth sides
  cylinder(p0, p1, r0, r1, n, col, mat = 0, caps = true) {
    const ax = norm(sub(p1, p0));
    const [u, v] = basis(ax);
    const ring = (p, r) => { const out = []; for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; out.push([p[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r, p[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r, p[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r]); } return out; };
    return this.loft([ring(p0, r0), ring(p1, r1)], [...col, mat], { capStart: caps && r0 > 0, capEnd: caps && r1 > 0, mat });
  }

  // ellipsoid centred at c with radii (rx, ry, rz)
  ellipsoid(c, rx, ry, rz, col, mat = 0, seg = 10, rings = 7) {
    const R = [];
    for (let r = 0; r <= rings; r++) {
      const th = (r / rings) * Math.PI, y = Math.cos(th), s = Math.sin(th);
      const ring = [];
      for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; ring.push([c[0] + Math.cos(a) * s * rx, c[1] + Math.sin(a) * s * ry, c[2] - y * rz]); }
      R.push(ring);
    }
    return this.loft(R, [...col, mat], { mat });
  }

  // flat disc (for roundels): centre, normal, radius
  disc(c, nrm, r, n, col, mat = MAT.MARK) {
    const [u, v] = basis(norm(nrm));
    const pts = [];
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; pts.push([c[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r, c[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r, c[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r]); }
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const fn = faceNormal(c, a, b);
      if (fn[0] * nrm[0] + fn[1] * nrm[1] + fn[2] * nrm[2] < 0) this.tri(c, b, a, col, mat); else this.tri(c, a, b, col, mat);
    }
    return this;
  }

  // Wing / tailplane panel. Spanwise stations: [{x, y, z (leading edge), chord, thick, twist?}], from
  // root to tip. Builds a smooth upper surface (matUp), lower surface (matDn) and a tip cap.
  // Airfoil: rounded leading edge, max thickness ~30% chord, sharp trailing edge.
  wing(stations, colUp, matUp, colDn, matDn, { segs = 6 } = {}) {
    const prof = [];   // chordwise [t (0=LE..1=TE), upper y fraction]
    for (let s = 0; s <= segs; s++) { const t = s / segs; const tt = t * t; prof.push([tt, 1]); }
    const thickAt = (t) => { const x = Math.max(t, 1e-4); return 2.4 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x); };
    const ringsUp = [], ringsDn = [];
    for (const st of stations) {
      const up = [], dn = [];
      for (const [t] of prof) {
        const th = thickAt(t) * st.thick * st.chord * 0.5;
        const z = st.z + t * st.chord;
        const dyTw = st.twist ? -Math.sin(st.twist) * (t - 0.25) * st.chord : 0;
        up.push([st.x, st.y + th + dyTw, z]);
        dn.push([st.x, st.y - th * 0.75 + dyTw, z]);
      }
      ringsUp.push(up); ringsDn.push(dn);
    }
    const cu = typeof colUp === 'function' ? colUp : () => [...colUp, matUp];
    const cd = typeof colDn === 'function' ? colDn : () => [...colDn, matDn];
    this.loft(ringsUp, cu, { closed: false, mat: matUp });
    this.loft(ringsDn.map((r) => r.slice()), cd, { closed: false, mat: matDn });
    // tip cap (flat) joining last upper and lower rings
    const lu = ringsUp[ringsUp.length - 1], ld = ringsDn[ringsDn.length - 1];
    const tipCol = cu(stations.length - 1, 0, lu[0]);
    for (let k = 0; k < lu.length - 1; k++) this.quad(lu[k], lu[k + 1], ld[k + 1], ld[k], tipCol, tipCol[3] ?? matUp);
    return this;
  }

  // append another builder's output (optionally transformed by the current stack)
  append(other) {
    const base = this.vcount;
    for (let v = 0; v < other.vcount; v++) {
      const col = [other.c[v * 4] / 255, other.c[v * 4 + 1] / 255, other.c[v * 4 + 2] / 255];
      this.vertex(other.p[v * 3], other.p[v * 3 + 1], other.p[v * 3 + 2], other.n[v * 3], other.n[v * 3 + 1], other.n[v * 3 + 2], col, other.c[v * 4 + 3]);
    }
    for (let k = 0; k < other.i.length; k += 3) this.index(base + other.i[k], base + other.i[k + 1], base + other.i[k + 2]);
    return this;
  }

  // mirror geometry added since `fromVertex`/`fromIndex` across the x = 0 plane
  mirrorX(fromVertex, fromIndex) {
    const vEnd = this.vcount, iEnd = this.i.length, off = vEnd - fromVertex;
    for (let v = fromVertex; v < vEnd; v++) {
      this.p.push(-this.p[v * 3], this.p[v * 3 + 1], this.p[v * 3 + 2]);
      this.n.push(-this.n[v * 3], this.n[v * 3 + 1], this.n[v * 3 + 2]);
      this.c.push(this.c[v * 4], this.c[v * 4 + 1], this.c[v * 4 + 2], this.c[v * 4 + 3]);
    }
    for (let k = fromIndex; k < iEnd; k += 3) this.i.push(this.i[k] + off, this.i[k + 2] + off, this.i[k + 1] + off);
    return this;
  }
  mark() { return { v: this.vcount, i: this.i.length }; }

  build() {
    const nv = this.vcount;
    const buf = new ArrayBuffer(nv * 20);
    const f = new Float32Array(buf), b = new Int8Array(buf), u = new Uint8Array(buf);
    let r = 0;
    for (let v = 0; v < nv; v++) {
      const o = v * 5;
      const x = this.p[v * 3], y = this.p[v * 3 + 1], z = this.p[v * 3 + 2];
      f[o] = x; f[o + 1] = y; f[o + 2] = z;
      r = Math.max(r, Math.hypot(x, y, z));
      b[o * 4 + 12] = Math.round(this.n[v * 3] * 127); b[o * 4 + 13] = Math.round(this.n[v * 3 + 1] * 127); b[o * 4 + 14] = Math.round(this.n[v * 3 + 2] * 127); b[o * 4 + 15] = 0;
      u[o * 4 + 16] = this.c[v * 4]; u[o * 4 + 17] = this.c[v * 4 + 1]; u[o * 4 + 18] = this.c[v * 4 + 2]; u[o * 4 + 19] = this.c[v * 4 + 3];
    }
    const idx = nv > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i);
    return { data: buf, index: idx, vcount: nv, count: this.i.length, radius: r };
  }
}

// ---------------------------------------------------------------- helpers
const c255 = (v) => (v <= 1 ? Math.round(v * 255) : Math.round(v)) & 255;
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const faceNormal = (a, b, c) => norm(cross(sub(b, a), sub(c, a)));
export function basis(ax) {
  const t = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(ax, t)), v = cross(ax, u);
  return [u, v];
}
// affine helpers: 3x4 row-major
export const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
export const S = (x, y = x, z = x) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
export const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; };
export const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
export const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; };
export function mulAff(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
    }
  }
  return o;
}
export const chain = (...ms) => ms.reduce((acc, m) => mulAff(acc, m));
