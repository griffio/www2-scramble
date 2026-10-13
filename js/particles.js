// CPU particle system in flat typed arrays (no per-particle objects, no GC churn).
// Rendering takes premultiplied colour; alpha 0 means purely additive (fire, flashes, sparks).
const TILE = { SMOKE: 0, GLOW: 1, DOT: 2, CHUNK: 3 };

export const P = {
  // tile, life, size0, size1, rgba0, rgba1 (straight alpha; a = 0 -> additive), drag, buoyancy, gravity
  smoke: { tile: 0, life: 3.5, s0: 2.5, s1: 11, c0: [0.5, 0.5, 0.5, 0.45], c1: [0.6, 0.6, 0.62, 0], drag: 1.2, buoy: 1.2, g: 0 },
  blackSmoke: { tile: 0, life: 5, s0: 3, s1: 16, c0: [0.08, 0.08, 0.08, 0.7], c1: [0.25, 0.25, 0.26, 0], drag: 1.0, buoy: 1.5, g: 0 },
  lightSmoke: { tile: 0, life: 2.2, s0: 1.5, s1: 6, c0: [0.75, 0.75, 0.75, 0.25], c1: [0.85, 0.85, 0.85, 0], drag: 1.5, buoy: 0.6, g: 0 },
  fire: { tile: 1, life: 0.45, s0: 2.6, s1: 1.2, c0: [1.0, 0.62, 0.22, 0], c1: [0.6, 0.12, 0.02, 0], drag: 2, buoy: 2, g: 0 },
  fireball: { tile: 1, life: 0.9, s0: 6, s1: 18, c0: [1.0, 0.75, 0.35, 0], c1: [0.5, 0.1, 0.0, 0], drag: 2.5, buoy: 4, g: 0 },
  flash: { tile: 1, life: 0.12, s0: 8, s1: 14, c0: [1.0, 0.95, 0.8, 0], c1: [1.0, 0.6, 0.2, 0], drag: 0, buoy: 0, g: 0 },
  muzzle: { tile: 1, life: 0.05, s0: 1.4, s1: 0.8, c0: [1.0, 0.85, 0.5, 0], c1: [1.0, 0.5, 0.1, 0], drag: 0, buoy: 0, g: 0 },
  spark: { tile: 2, life: 0.45, s0: 0.35, s1: 0.1, c0: [1.0, 0.85, 0.5, 0], c1: [1.0, 0.4, 0.1, 0], drag: 0.6, buoy: 0, g: 9.8 },
  dust: { tile: 0, life: 1.6, s0: 1.2, s1: 5, c0: [0.45, 0.38, 0.28, 0.55], c1: [0.55, 0.5, 0.4, 0], drag: 2.5, buoy: 0.5, g: 0 },
  bigDust: { tile: 0, life: 5, s0: 8, s1: 30, c0: [0.35, 0.3, 0.24, 0.75], c1: [0.5, 0.46, 0.4, 0], drag: 1.2, buoy: 2.5, g: 0 },
  splash: { tile: 0, life: 1.4, s0: 1.0, s1: 4, c0: [0.85, 0.9, 0.95, 0.6], c1: [0.9, 0.95, 1.0, 0], drag: 0.8, buoy: 0, g: 9.8 },
  spray: { tile: 0, life: 3, s0: 4, s1: 18, c0: [0.85, 0.9, 0.95, 0.7], c1: [0.9, 0.95, 1.0, 0], drag: 0.6, buoy: 0, g: 9.8 },
  flak: { tile: 0, life: 7, s0: 5, s1: 15, c0: [0.06, 0.06, 0.06, 0.85], c1: [0.2, 0.2, 0.2, 0], drag: 1.5, buoy: 0.2, g: 0 },
  debris: { tile: 3, life: 3.5, s0: 0.9, s1: 0.9, c0: [0.25, 0.24, 0.22, 1], c1: [0.2, 0.2, 0.2, 1], drag: 0.3, buoy: 0, g: 9.8 },
  vapour: { tile: 0, life: 0.5, s0: 0.25, s1: 0.9, c0: [0.95, 0.97, 1.0, 0.35], c1: [1, 1, 1, 0], drag: 3, buoy: 0, g: 0 },
  exhaust: { tile: 0, life: 0.6, s0: 0.3, s1: 1.2, c0: [0.3, 0.3, 0.3, 0.18], c1: [0.4, 0.4, 0.4, 0], drag: 2, buoy: 0.3, g: 0 },
};

export class Particles {
  constructor(max = 14000) {
    this.max = max; this.n = 0;
    const F = (k) => new Float32Array(max);
    this.x = new Float64Array(max); this.y = new Float64Array(max); this.z = new Float64Array(max);
    this.vx = F(); this.vy = F(); this.vz = F(); this.age = F(); this.life = F(); this.rot = F(); this.rv = F(); this.sz = F();
    this.pre = new Array(max).fill(null);
    this.out = new Float32Array(max * 12);
  }
  emit(preset, x, y, z, vx = 0, vy = 0, vz = 0, scale = 1, lifeMul = 1) {
    let i;
    if (this.n < this.max) i = this.n++;
    else i = (Math.random() * this.max) | 0;     // full: recycle a random one
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = preset.life * lifeMul * (0.8 + Math.random() * 0.4);
    this.rot[i] = Math.random() * 6.28; this.rv[i] = (Math.random() - 0.5) * (preset.tile === 3 ? 12 : 0.6);
    this.sz[i] = scale; this.pre[i] = preset;
  }
  update(dt, wx = 0, wz = 0) {
    let i = 0;
    while (i < this.n) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        const j = --this.n;
        if (i !== j) {
          this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.z[i] = this.z[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
          this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.rot[i] = this.rot[j]; this.rv[i] = this.rv[j]; this.sz[i] = this.sz[j]; this.pre[i] = this.pre[j];
        }
        continue;
      }
      const p = this.pre[i], k = Math.exp(-p.drag * dt);
      this.vx[i] = (this.vx[i] - wx) * k + wx; this.vz[i] = (this.vz[i] - wz) * k + wz;
      this.vy[i] = this.vy[i] * k + (p.buoy - p.g) * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      this.rot[i] += this.rv[i] * dt;
      i++;
    }
  }
  // write instance data relative to the camera; returns count
  fill(cx, cy, cz) {
    const o = this.out;
    let n = 0;
    for (let i = 0; i < this.n; i++) {
      const p = this.pre[i], t = this.age[i] / this.life[i];
      const rx = this.x[i] - cx, ry = this.y[i] - cy, rz = this.z[i] - cz;
      if (rx * rx + ry * ry + rz * rz > 1.6e9) continue;   // > 40 km
      const c0 = p.c0, c1 = p.c1;
      const fadeIn = Math.min(1, this.age[i] * 12);
      const r = c0[0] + (c1[0] - c0[0]) * t, g = c0[1] + (c1[1] - c0[1]) * t, b = c0[2] + (c1[2] - c0[2]) * t;
      let a = c0[3] + (c1[3] - c0[3]) * t;
      const add = c0[3] === 0;
      const k = n * 12;
      o[k] = rx; o[k + 1] = ry; o[k + 2] = rz; o[k + 3] = (p.s0 + (p.s1 - p.s0) * Math.sqrt(t)) * this.sz[i];
      if (add) { const e = (1 - t) * fadeIn; o[k + 4] = r * e; o[k + 5] = g * e; o[k + 6] = b * e; o[k + 7] = 0; }
      else { a *= fadeIn; o[k + 4] = r * a; o[k + 5] = g * a; o[k + 6] = b * a; o[k + 7] = a; }
      o[k + 8] = this.rot[i]; o[k + 9] = p.tile; o[k + 10] = 0; o[k + 11] = 0;
      n++;
    }
    return n;
  }
}

const rnd = Math.random, rs = (s) => (rnd() - 0.5) * 2 * s;

// composite effects
export function explosion(ps, x, y, z, size, kind, vx = 0, vy = 0, vz = 0) {
  const s = size;
  ps.emit(P.flash, x, y, z, 0, 0, 0, s * 1.2);
  const nf = Math.round(6 + 10 * s);
  for (let k = 0; k < nf; k++) ps.emit(P.fireball, x + rs(3 * s), y + rs(3 * s), z + rs(3 * s), vx * 0.3 + rs(12 * s), vy * 0.3 + rs(12 * s) + 4, vz * 0.3 + rs(12 * s), s * (0.5 + rnd() * 0.5));
  for (let k = 0; k < nf; k++) ps.emit(kind === 'air' ? P.blackSmoke : P.blackSmoke, x + rs(4 * s), y + rs(3 * s), z + rs(4 * s), vx * 0.2 + rs(6 * s), vy * 0.2 + rs(5 * s) + 2, vz * 0.2 + rs(6 * s), s * (0.7 + rnd() * 0.6), 1 + s * 0.4);
  for (let k = 0; k < 10 + 14 * s; k++) ps.emit(P.spark, x, y, z, vx * 0.5 + rs(60), vy * 0.5 + rs(50) + 20, vz * 0.5 + rs(60), 1.5 + rnd(), 1.5);
  if (kind === 'air' || kind === 'crash') for (let k = 0; k < 12; k++) ps.emit(P.debris, x, y, z, vx * 0.5 + rs(40), vy * 0.5 + rs(35) + 10, vz * 0.5 + rs(40), 0.6 + rnd() * 1.2, 1.5);
  if (kind === 'bomb' || kind === 'crash' || kind === 'ground' || kind === 'fuel') {
    for (let k = 0; k < 10 * s; k++) ps.emit(P.bigDust, x + rs(6 * s), y + 2, z + rs(6 * s), rs(14 * s), 8 + rnd() * 18 * s, rs(14 * s), s * 0.6);
    for (let k = 0; k < 20 * s; k++) ps.emit(P.debris, x, y + 1, z, rs(30), 15 + rnd() * 35, rs(30), 0.8 + rnd(), 1);
  }
  if (kind === 'fuel') for (let k = 0; k < 30; k++) ps.emit(P.fireball, x + rs(8), y + rnd() * 10, z + rs(8), rs(8), 10 + rnd() * 25, rs(8), 2 + rnd() * 1.5, 2.5);
  if (kind === 'water') {
    for (let k = 0; k < 18 * s; k++) ps.emit(P.spray, x + rs(4 * s), 0.5, z + rs(4 * s), rs(8 * s), 15 + rnd() * 30 * s, rs(8 * s), s * 0.7, 1.4);
  }
}
export function flakBurst(ps, x, y, z) {
  ps.emit(P.flash, x, y, z, 0, 0, 0, 1.1);
  for (let k = 0; k < 5; k++) ps.emit(P.flak, x + rs(3), y + rs(3), z + rs(3), rs(3), rs(2), rs(3), 0.8 + rnd() * 0.5);
  for (let k = 0; k < 6; k++) ps.emit(P.spark, x, y, z, rs(80), rs(80), rs(80), 1.2);
}
export function impact(ps, x, y, z, water, big) {
  if (water) { for (let k = 0; k < (big ? 4 : 2); k++) ps.emit(P.splash, x, 0.2, z, rs(1.5), 5 + rnd() * (big ? 12 : 6), rs(1.5), big ? 1.4 : 0.8); return; }
  ps.emit(P.dust, x, y + 0.3, z, rs(2), 2 + rnd() * 4, rs(2), big ? 1.4 : 0.8);
  if (big || rnd() < 0.3) ps.emit(P.spark, x, y + 0.2, z, rs(10), 4 + rnd() * 8, rs(10), 1);
}
export function hitSparks(ps, x, y, z, vx, vy, vz, big) {
  ps.emit(P.flash, x, y, z, vx, vy, vz, big ? 0.35 : 0.2);
  for (let k = 0; k < (big ? 6 : 3); k++) ps.emit(P.spark, x, y, z, vx + rs(25), vy + rs(25), vz + rs(25), 1);
  if (big) ps.emit(P.smoke, x, y, z, vx * 0.9, vy * 0.9, vz * 0.9, 0.4);
}
