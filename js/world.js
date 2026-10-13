// The map: a compressed Strait of Dover. England (Kent) to the north (-z), France (Pas-de-Calais)
// to the south (+z), the Channel between. Heights, land-use masks, airfields, towns and targets
// are all generated deterministically here. Pure JS (runs in Node for headless tests).
import { fbm, vnoise, mulberry32, clamp, smoothstep, lerp } from './math.js';

export const HM_N = 1024;            // heightmap samples per side
export const HM_CELL = 48;           // metres between samples
export const HM_X0 = -(HM_N - 1) * HM_CELL / 2;
export const MAP_HALF = 22000;       // playable area half-size (soft boundary)

export const TEAM = { RAF: 0, LW: 1 };

// ---------------------------------------------------------------- coastlines (depend on x only)
const noiseRow = (x, f, seed) => fbm(x * f + seed, seed * 0.37, 4) * 2 - 1;
export function coastN(x) { return -3300 + 900 * noiseRow(x, 1 / 9000, 11.3) + 260 * noiseRow(x, 1 / 1700, 3.7); }
export function coastS(x) { return 3100 + 800 * noiseRow(x, 1 / 8500, 27.1) + 220 * noiseRow(x, 1 / 1900, 8.9); }
// the White Cliffs: Folkestone Warren to Dover, broken by Dover harbour, and on to South Foreland
const cliffN = (x) => smoothstep(-2600, -1200, x) * (1 - smoothstep(10500, 12000, x)) * (1 - 0.9 * Math.exp(-(((x - 6200) / 450) ** 2)));
const cliffS = (x) => smoothstep(-6000, -3500, x) * (1 - smoothstep(2500, 5000, x));

// ---------------------------------------------------------------- airfields
// u = along the runway (take-off direction), v = right of it.
function makeField(team, name, x, z, hdg, elev) {
  const ux = Math.sin(hdg), uz = -Math.cos(hdg);
  return { team, name, x, z, hdg, elev, ux, uz, vx: Math.cos(hdg), vz: Math.sin(hdg), rwyLen: 1500, rwyW: 46 };
}
export const FIELDS = [
  makeField(TEAM.RAF, 'RAF HAWKINGE', -1800, -9200, 195 * Math.PI / 180, 62),
  makeField(TEAM.LW, 'JG 26 AUDEMBERT', 2600, 9000, 12 * Math.PI / 180, 38),
];
export function fieldToWorld(f, u, v) { return [f.x + f.ux * u + f.vx * v, f.z + f.uz * u + f.vz * v]; }
export function worldToField(f, x, z) { const dx = x - f.x, dz = z - f.z; return [dx * f.ux + dz * f.uz, dx * f.vx + dz * f.vz]; }

// ---------------------------------------------------------------- towns
const TOWNS = [
  // England
  { name: 'FOLKESTONE', x: -6500, z: -3900, r: 900, n: 260, side: 0, church: 2 },
  { name: 'DOVER', x: 6200, z: -3800, r: 1000, n: 300, side: 0, church: 2 },
  { name: 'HYTHE', x: -12500, z: -3500, r: 600, n: 120, side: 0, church: 1 },
  { name: 'CANTERBURY', x: 1500, z: -17500, r: 1300, n: 380, side: 0, church: 3 },
  { name: 'ELHAM', x: -5500, z: -12000, r: 350, n: 45, side: 0, church: 1 },
  { name: 'LYMINGE', x: -9000, z: -9000, r: 350, n: 50, side: 0, church: 1 },
  { name: 'BARHAM', x: 3500, z: -12500, r: 300, n: 40, side: 0, church: 1 },
  { name: 'WOOTTON', x: 6500, z: -9000, r: 280, n: 35, side: 0, church: 1 },
  { name: 'ASHFORD', x: -16500, z: -11000, r: 900, n: 240, side: 0, church: 2 },
  { name: 'DEAL', x: 13500, z: -7000, r: 700, n: 160, side: 0, church: 1 },
  // France
  { name: 'CALAIS', x: 11000, z: 4400, r: 1300, n: 420, side: 1, church: 3 },
  { name: 'BOULOGNE', x: -11000, z: 4600, r: 1200, n: 380, side: 1, church: 3 },
  { name: 'WISSANT', x: -1500, z: 3900, r: 400, n: 70, side: 1, church: 1 },
  { name: 'MARQUISE', x: -5000, z: 9500, r: 500, n: 90, side: 1, church: 1 },
  { name: 'GUINES', x: 8500, z: 10500, r: 500, n: 90, side: 1, church: 1 },
  { name: 'LICQUES', x: 3500, z: 15000, r: 350, n: 50, side: 1, church: 1 },
  { name: 'DESVRES', x: -9000, z: 15000, r: 500, n: 90, side: 1, church: 1 },
  { name: 'ARDRES', x: 13500, z: 12500, r: 450, n: 80, side: 1, church: 1 },
  { name: 'AUDRESSELLES', x: -7500, z: 5000, r: 300, n: 40, side: 1, church: 1 },
  { name: 'HERMELINGHEN', x: 400, z: 13500, r: 280, n: 35, side: 1, church: 1 },
];

// ---------------------------------------------------------------- terrain generation
function fieldMask(x, z) {
  let m = 0, e = 0;
  for (const f of FIELDS) {
    const [u, v] = worldToField(f, x, z);
    const d = Math.max(Math.abs(u) - 1150, Math.abs(v) - 650, 0);
    const k = 1 - smoothstep(0, 700, d);
    if (k > m) { m = k; e = f.elev; }
  }
  return [m, e];
}

export class World {
  constructor() {
    const t0 = Date.now();
    const N = HM_N;
    this.N = N; this.cell = HM_CELL; this.x0 = HM_X0;
    this.h = new Float32Array(N * N);
    this.mat = new Uint8Array(N * N * 4);     // r forest, g town, b airfield, a chalk
    this.nrm = new Uint8Array(N * N * 4);
    const cN = new Float32Array(N), cS = new Float32Array(N), clN = new Float32Array(N), clS = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = HM_X0 + i * HM_CELL; cN[i] = coastN(x); cS[i] = coastS(x); clN[i] = cliffN(x); clS[i] = cliffS(x); }
    const townMaskAt = (x, z) => {
      let m = 0;
      for (const t of TOWNS) { const d2 = ((x - t.x) ** 2 + (z - t.z) ** 2) / (t.r * t.r); if (d2 < 2.5) m = Math.max(m, Math.exp(-d2 * 1.6)); }
      return m;
    };
    for (let j = 0; j < N; j++) {
      const z = HM_X0 + j * HM_CELL;
      for (let i = 0; i < N; i++) {
        const x = HM_X0 + i * HM_CELL;
        const north = z < (cN[i] + cS[i]) / 2;
        const d = north ? cN[i] - z : z - cS[i];        // distance inland (negative = at sea)
        const cliff = north ? clN[i] : clS[i];
        // rolling downland: England higher and hillier
        const hn = fbm(x / 5200, z / 5200, 5);
        let land = north
          ? 50 + (hn - 0.42) * 260 + 70 * Math.exp(-(((z + 6200 + 900 * Math.sin(x / 4300)) / 1700) ** 2))
          : 32 + (hn - 0.45) * 170 + 45 * Math.exp(-(((z - 7000 - 700 * Math.sin(x / 3900 + 1)) / 2200) ** 2));
        land += (fbm(x / 900, z / 900, 3) - 0.5) * 18;
        land = Math.max(land, 6);
        if (cliff > 0) land = Math.max(land, lerp(land, 78 + 40 * vnoise(x / 1500, 7.7), cliff));
        let h;
        if (d < 0) {
          h = -2.5 - 38 * smoothstep(0, 2200, -d) - 4 * vnoise(x / 700, z / 700);
          if (cliff > 0.3) h = Math.min(h, -1.5 - 10 * smoothstep(0, 120, -d));
        } else {
          const L = lerp(650, 30, cliff);
          const s = Math.pow(smoothstep(0, L, d), cliff > 0.5 ? 0.35 : 0.8);
          h = 1.2 + (land - 1.2) * s;
          if (d < 60 && cliff < 0.4) h = Math.min(h, 1.2 + d * 0.03);   // beaches
        }
        const [fm, fe] = fieldMask(x, z);
        if (fm > 0 && h > 0) h = lerp(h, fe, fm);
        const k = j * N + i;
        this.h[k] = h;
        // land use
        const tm = townMaskAt(x, z);
        const forestN = fbm(x / 2600 + 50, z / 2600 - 20, 4);
        let forest = smoothstep(0.6, 0.66, forestN) * (h > 4 ? 1 : 0) * (1 - fm) * (1 - smoothstep(0.15, 0.4, tm));
        this.mat[k * 4] = Math.round(forest * 255);
        this.mat[k * 4 + 1] = Math.round(tm * 255 * (h > 1 ? 1 : 0));
        this.mat[k * 4 + 2] = Math.round(fm * 255);
        this.mat[k * 4 + 3] = Math.round(cliff * 255 * (h > 0 ? 1 : 0) * (1 - smoothstep(30, 160, d)));
      }
    }
    // normals
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const hl = this.h[j * N + Math.max(0, i - 1)], hr = this.h[j * N + Math.min(N - 1, i + 1)];
        const hd = this.h[Math.max(0, j - 1) * N + i], hu = this.h[Math.min(N - 1, j + 1) * N + i];
        let nx = (hl - hr), ny = 2 * HM_CELL, nz = (hd - hu);
        const l = Math.hypot(nx, ny, nz);
        const k = (j * N + i) * 4;
        this.nrm[k] = Math.round((nx / l * 0.5 + 0.5) * 255);
        this.nrm[k + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
        this.nrm[k + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
        this.nrm[k + 3] = 255;
      }
    }
    this.genTime = Date.now() - t0;
    this.fields = FIELDS;
    this.towns = TOWNS;
    this.placeObjects();
  }

  // bilinear terrain height (sea floor is negative; water surface is y = 0)
  heightAt(x, z) {
    const N = this.N;
    let fx = (x - HM_X0) / HM_CELL, fz = (z - HM_X0) / HM_CELL;
    fx = fx < 0 ? 0 : fx > N - 1.001 ? N - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > N - 1.001 ? N - 1.001 : fz;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * N + i, h = this.h;
    const a = h[k], b = h[k + 1], c = h[k + N], d = h[k + N + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }
  // surface the aircraft can hit: max(terrain, water)
  groundAt(x, z) { const h = this.heightAt(x, z); return h > 0 ? h : 0; }
  matAt(x, z, ch) {
    const i = clamp(Math.round((x - HM_X0) / HM_CELL), 0, this.N - 1), j = clamp(Math.round((z - HM_X0) / HM_CELL), 0, this.N - 1);
    return this.mat[(j * this.N + i) * 4 + ch] / 255;
  }
  slopeAt(x, z) {
    const i = clamp(Math.round((x - HM_X0) / HM_CELL), 0, this.N - 1), j = clamp(Math.round((z - HM_X0) / HM_CELL), 0, this.N - 1);
    return this.nrm[(j * this.N + i) * 4 + 1] / 127.5 - 1;
  }

  // -------------------------------------------------------------- static objects + targets
  placeObjects() {
    const rnd = mulberry32(1940);
    // scenery instances by mesh key: arrays of [x, y, z, yaw, scale]
    const S = this.scenery = {};
    const add = (key, x, z, yaw = 0, scale = 1, y) => {
      (S[key] || (S[key] = [])).push([x, y ?? this.heightAt(x, z), z, yaw, scale]);
    };
    this.add = add;
    const nearField = (x, z, m = 0) => this.fields.some((f) => { const [u, v] = worldToField(f, x, z); return Math.abs(u) < 1250 + m && Math.abs(v) < 760 + m; });
    // houses
    for (const t of TOWNS) {
      let placed = 0, tries = 0;
      // a few streets: houses line up along random directions through the centre
      const streets = [];
      for (let s = 0; s < 3 + (t.n > 200 ? 4 : 0); s++) streets.push(rnd() * Math.PI);
      while (placed < t.n && tries < t.n * 8) {
        tries++;
        const st = streets[(rnd() * streets.length) | 0];
        const along = (rnd() * 2 - 1) * t.r * 1.2, off = (rnd() < 0.5 ? -1 : 1) * (14 + rnd() * 10) + (rnd() - 0.5) * t.r * 0.6 * rnd();
        const x = t.x + Math.cos(st) * along - Math.sin(st) * off, z = t.z + Math.sin(st) * along + Math.cos(st) * off;
        const h = this.heightAt(x, z);
        if (h < 2 || this.slopeAt(x, z) < 0.93 || nearField(x, z, 100)) continue;
        const r = rnd();
        add(r < 0.45 ? 'house1' : r < 0.8 ? 'house2' : 'house3', x, z, -st + (rnd() < 0.5 ? 0 : Math.PI), 0.85 + rnd() * 0.35);
        placed++;
      }
      for (let c = 0; c < t.church; c++) {
        const x = t.x + (rnd() - 0.5) * t.r * 0.4, z = t.z + (rnd() - 0.5) * t.r * 0.4;
        if (this.heightAt(x, z) > 2) add('church', x, z, rnd() * 6.28, 1);
      }
      if (t.side === 1 && rnd() < 0.8) {
        const a = rnd() * 6.28, x = t.x + Math.cos(a) * t.r * 1.3, z = t.z + Math.sin(a) * t.r * 1.3;
        if (this.heightAt(x, z) > 3) add('windmill', x, z, rnd() * 6.28, 1);
      }
    }
    // isolated farms and windmills
    for (let k = 0; k < 420; k++) {
      const x = (rnd() * 2 - 1) * 21000, z = (rnd() * 2 - 1) * 21000;
      const h = this.heightAt(x, z);
      if (h < 3 || this.slopeAt(x, z) < 0.95 || nearField(x, z, 200) || this.matAt(x, z, 0) > 0.3) continue;
      const yaw = rnd() * 6.28;
      add(rnd() < 0.5 ? 'house1' : 'house2', x, z, yaw, 1);
      if (rnd() < 0.6) add('house3', x + Math.cos(yaw) * 22, z + Math.sin(yaw) * 22, yaw + 1.57, 0.8);
      if (z > 0 && rnd() < 0.15) add('windmill', x + 60, z - 40, rnd() * 6.28, 1);
    }
    // trees: forests (dense) + scattered hedgerow trees, kept in 2 km chunks for streaming
    const trees = [];
    for (let z = -21000; z < 21000; z += 62) {
      for (let x = -21000; x < 21000; x += 62) {
        const jx = x + (rnd() - 0.5) * 56, jz = z + (rnd() - 0.5) * 56;
        const f = this.matAt(jx, jz, 0);
        const p = f > 0.5 ? 0.8 : 0.008;
        if (rnd() > p) continue;
        const h = this.heightAt(jx, jz);
        if (h < 3 || nearField(jx, jz) || this.matAt(jx, jz, 1) > 0.25 || this.slopeAt(jx, jz) < 0.8) continue;
        trees.push([jx, h, jz, rnd() * 6.28, 0.75 + rnd() * 0.6, rnd() < (z < 0 ? 0.35 : 0.55) ? 1 : 0]);
      }
    }
    this.trees = trees;
    // coastal landmarks
    add('lighthouse', 4300, coastN(4300) - 120, 0, 1);
    add('lighthouse', -500, coastS(-500) + 90, 0, 1);
    // Chain Home radar station (four tall masts) on the English cliffs
    for (let k = 0; k < 4; k++) add('radarMast', 9000 + k * 160, coastN(9000) - 700 - (k % 2) * 90, 0, 1);
    this.masts = (S.radarMast || []).map((m) => ({ x: m[0], z: m[2], y: m[1], h: 100, r: 9 }));

    // ---------------------------------------------------------- airfields
    this.targets = [];
    for (const f of this.fields) this.buildField(f, rnd, true);
  }
  // fresh airfield targets for a new battle (the decorative scenery stays)
  resetTargets() {
    const rnd = mulberry32(1941);
    this.targets = [];
    for (const f of this.fields) this.buildField(f, rnd, false);
  }

  buildField(f, rnd, decor) {
    const T = (kind, u, v, extra = {}) => {
      const [x, z] = fieldToWorld(f, u, v);
      const t = { kind, team: f.team, field: f, x, z, y: this.heightAt(x, z), u, v, yaw: -f.hdg, alive: true, ...extra };
      t.maxHp = t.hp;
      this.targets.push(t);
      return t;
    };
    f.hangars = [];
    for (const u of [-330, 0, 330]) f.hangars.push(T('hangar', u, 290, { hp: 260, r: 30, h: 14, stock: {} }));
    // the runway as three segments
    f.runway = [];
    for (let s = 0; s < 3; s++) f.runway.push(T('runway', -500 + s * 500, 0, { hp: 100, r: 250, h: 1, seg: s, craters: [] }));
    f.tower = T('tower', 560, 230, { hp: 50, r: 9, h: 9, yaw: -f.hdg + Math.PI });
    f.fuel = [];
    for (let k = 0; k < 3; k++) f.fuel.push(T('fuel', 660 + k * 26, 420 + (k % 2) * 18, { hp: 25, r: 6, h: 6 }));
    f.guns = [];
    for (const [u, v, heavy] of [[-850, -380, 1], [850, -380, 1], [-850, 420, 1], [850, 430, 1], [-420, -170, 0], [420, -170, 0], [0, 520, 0], [-620, 170, 0], [700, 170, 0]]) {
      f.guns.push(T(heavy ? 'flak' : 'lightAA', u, v, { hp: heavy ? 30 : 20, r: heavy ? 5 : 3, h: 2.5, heavy: !!heavy, aimYaw: rnd() * 6.28, aimPitch: 0.6, cool: rnd() * 2 }));
    }
    // parking slots in front of each hangar (filled from the hangar's stock by the sim)
    f.parking = [];
    for (const hg of f.hangars) for (const du of [-22, 22]) f.parking.push({ u: hg.u + du, v: 225, hangar: hg, plane: null });
    if (!decor) return;
    // decorative: huts, tents, sandbags, windsock
    for (let k = 0; k < 6; k++) { const [x, z] = fieldToWorld(f, -700 + k * 70, 470); this.add('hut', x, z, -f.hdg + Math.PI / 2, 1); }
    for (let k = 0; k < 8; k++) { const [x, z] = fieldToWorld(f, -300 + k * 18 + rnd() * 6, 520 + rnd() * 20); this.add('tent', x, z, rnd() * 6.28, 1); }
    for (const g of f.guns) {
      const [x, z] = [g.x, g.z];
      this.add(g.heavy ? 'flakBase' : 'sandbags', x, z, rnd() * 6.28, g.heavy ? 1 : 1.2);
    }
    { const [x, z] = fieldToWorld(f, -780, 60); this.add('windsock', x, z, 0, 1); }
  }

  // is a point on a field's runway (for landing / take-off)? returns {field, u, v} or null
  onRunway(x, z, margin = 0) {
    for (const f of this.fields) {
      const [u, v] = worldToField(f, x, z);
      if (Math.abs(u) < f.rwyLen / 2 + 60 + margin && Math.abs(v) < f.rwyW / 2 + 30 + margin) return { field: f, u, v };
    }
    return null;
  }
  inField(x, z) {
    for (const f of this.fields) { const [u, v] = worldToField(f, x, z); if (Math.abs(u) < 1150 && Math.abs(v) < 650) return f; }
    return null;
  }
}
