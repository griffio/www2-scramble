// Small, allocation-free vector / quaternion / matrix helpers.
// World: x = east, y = up, z = south (north is -z). Body frame: x = right, y = up, -z = forward
// (the same as a camera, so a cockpit camera is just the aircraft orientation).
export const DEG = Math.PI / 180, RAD = 180 / Math.PI, G = 9.81;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);

export class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  crossVectors(a, b) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lenSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  len() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  normalize() { const l = this.len(); if (l > 1e-9) { this.x /= l; this.y /= l; this.z /= l; } return this; }
  distSq(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  dist(v) { return Math.sqrt(this.distSq(v)); }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quat(this.x, this.y, this.z, this.w); }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l; return this;
  }
  // this = a * b
  multiply(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w, bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  setAxisAngle(ax, ay, az, ang) {
    const s = Math.sin(ang / 2);
    this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(ang / 2); return this;
  }
  // compass heading (clockwise from north), pitch (nose up +), roll (right wing down +)
  setHPR(h, p, r) {
    const qh = _q1.setAxisAngle(0, 1, 0, -h), qp = _q2.setAxisAngle(1, 0, 0, p), qr = _q3.setAxisAngle(0, 0, 1, -r);
    return this.multiply(qh, _q4.multiply(qp, qr));
  }
  // rotate by body angular velocity (rad/s) over dt
  integrate(wx, wy, wz, dt) {
    const a = Math.sqrt(wx * wx + wy * wy + wz * wz) * dt;
    if (a < 1e-12) return this;
    const s = Math.sin(a / 2) / (a / dt);
    _q1.set(wx * s, wy * s, wz * s, Math.cos(a / 2));
    return this.multiply(_q4.copy(this), _q1).normalize();
  }
  slerp(q, t) {
    let cx = q.x, cy = q.y, cz = q.z, cw = q.w;
    let d = this.x * cx + this.y * cy + this.z * cz + this.w * cw;
    if (d < 0) { d = -d; cx = -cx; cy = -cy; cz = -cz; cw = -cw; }
    let k0, k1;
    if (d > 0.9995) { k0 = 1 - t; k1 = t; } else {
      const th = Math.acos(d), s = Math.sin(th);
      k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s;
    }
    this.x = this.x * k0 + cx * k1; this.y = this.y * k0 + cy * k1; this.z = this.z * k0 + cz * k1; this.w = this.w * k0 + cw * k1;
    return this.normalize();
  }
  // orientation whose -z looks along dir with y as close to up as possible
  lookDir(dx, dy, dz, ux = 0, uy = 1, uz = 0) {
    const fl = Math.hypot(dx, dy, dz) || 1;
    const zx = -dx / fl, zy = -dy / fl, zz = -dz / fl;               // body +z = backwards
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    let xl = Math.hypot(xx, xy, xz);
    if (xl < 1e-6) { xx = 1; xy = 0; xz = 0; xl = 1; }
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return this.fromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz);
  }
  fromBasis(m00, m10, m20, m01, m11, m21, m02, m12, m22) {   // columns = body x, y, z in world
    const tr = m00 + m11 + m22;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      this.w = 0.25 / s; this.x = (m21 - m12) * s; this.y = (m02 - m20) * s; this.z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = 0.25 * s; this.y = (m01 + m10) / s; this.z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      this.w = (m02 - m20) / s; this.x = (m01 + m10) / s; this.y = 0.25 * s; this.z = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      this.w = (m10 - m01) / s; this.x = (m02 + m20) / s; this.y = (m12 + m21) / s; this.z = 0.25 * s;
    }
    return this.normalize();
  }
}
const _q1 = new Quat(), _q2 = new Quat(), _q3 = new Quat(), _q4 = new Quat();

// out = q * v * q^-1
export function qrot(q, x, y, z, out) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + qy * tz - qz * ty;
  out.y = y + qw * ty + qz * tx - qx * tz;
  out.z = z + qw * tz + qx * ty - qy * tx;
  return out;
}
// out = q^-1 * v * q (world -> body)
export function qrotInv(q, x, y, z, out) {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + qy * tz - qz * ty;
  out.y = y + qw * ty + qz * tx - qx * tz;
  out.z = z + qw * tz + qx * ty - qy * tx;
  return out;
}

// ---------------------------------------------------------------- mat4 (column-major Float32Array)
export const m4 = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export function m4perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far); out[11] = -1; out[14] = 2 * far * near / (near - far);
  return out;
}
// view rotation (camera at origin) from camera orientation quaternion
export function m4viewFromQuat(out, q) {
  const x = -q.x, y = -q.y, z = -q.z, w = q.w;   // inverse rotation
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}
export function m4mul(out, a, b) {
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[i * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[i * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[i * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

// ---------------------------------------------------------------- deterministic RNG + noise
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// smooth value noise in [0,1]
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10); fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, oct = 5) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); n += a; a *= 0.5; x = x * 2.03 + 17.1; y = y * 2.03 - 9.7; }
  return s / n;
}
export const noise1 = (x) => vnoise(x, 0.5);
