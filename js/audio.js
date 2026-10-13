// Audio engine — raw Web Audio API, no dependencies.
// Every sound is first synthesized at init(): engine loops and one-shots are rendered into AudioBuffers with
// plain JS DSP (seamless loops: pulse tails wrap around, IIR filters are run two-pass so the state at the
// seam matches); sirens and fanfares are built live from oscillators. Real recordings then replace what
// they can (engines: audio/*.wav, tools/make-engine-loops.mjs; guns, explosions, impacts, air-raid siren,
// bomb whistle: audio/sfx/*.wav, tools/make-sfx.mjs). Any recording that fails to load (e.g. page opened
// from file://) just leaves the synthesized version in its slot.
// World: x = east, y = up, z = south; metres, m/s.

const C = 343;                 // speed of sound, m/s
const TAU = Math.PI * 2;
const MAX_ENGINE_VOICES = 7;   // audible positional engines
const ENGINE_POOL = 10;        // voices (extra ones let leaving voices fade out while new ones fade in)
const ENGINE_MAX_DIST = 4500;
const ONESHOT_POOL = 32;
const LO_RATIO = 0.4;          // idle loop is rendered at 40% of max-continuous firing rate
const BOMB_VOICES = 4;         // falling-bomb whistles
const BOMB_MAX_DIST = 2200;
const WHISTLE_HZ = 3000;       // pitch of the whistle loop (the recording is flattened to this by make-sfx)
// recorded sound effects (audio/sfx/<file>.wav) -> this.buf slots; each file is optional
const SFX = {
  cannon: ['cannon_1', 'cannon_2', 'cannon_3'],
  hmg: ['hmg_1', 'hmg_2', 'hmg_3', 'hmg_4', 'hmg_5'],
  mg: ['mg_1', 'mg_2', 'mg_3', 'mg_4', 'mg_5'],
  expClose: ['exp_close_1', 'exp_close_2', 'exp_close_3'],
  expBig: ['exp_big_1', 'exp_big_2'],
  expFar: ['exp_far_1', 'exp_far_2', 'exp_far_3'],
  flak: ['flak_1', 'flak_2', 'flak_3'],
  metal: ['hit_metal_1', 'hit_metal_2', 'hit_metal_3', 'hit_metal_4'],
  clang: ['hit_plane_1', 'hit_plane_2', 'hit_plane_3', 'hit_plane_4'],
  ground: ['hit_ground_1', 'hit_ground_2', 'hit_ground_3', 'hit_ground_4'],
  water: ['hit_water_1', 'hit_water_2', 'hit_water_3', 'hit_water_4'],
  sirenLoop: ['siren_loop'],
  whistle: ['bomb_whistle'],
};
// level trims for the recordings (peak-normalised, less dense than the driven synthesized one-shots)
const SFX_TRIM = { cannon: 1.45, hmg: 1.7, mg: 1.05, expClose: 1.35, expBig: 1.4, expFar: 1.5, flak: 1.6, metal: 1.15, clang: 1.6, ground: 1.1, water: 1.2 };

const fin = (v, d) => (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------------------------
// Offline DSP toolkit
// ---------------------------------------------------------------------------------------------
class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  next() {
    let t = (this.s += 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  norm() { return (this.next() + this.next() + this.next() - 1.5) * 2; } // ~N(0,1), bounded ±3
  int(n) { return (this.next() * n) | 0; }
}
const RNG = new Rng(0x5eed1940); // runtime randomness (variant choice, detune) — deterministic is fine

class Biquad {
  constructor(sr) { this.sr = sr; this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; }
  set(type, f, q = 0.7071, db = 0) {
    const w0 = TAU * clamp(f, 5, this.sr * 0.49) / this.sr, cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(0.05, q)), A = Math.pow(10, db / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; // lp
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  // In place. periodic=true: warm the state with one silent pass so the loop seam is continuous.
  run(buf, periodic = false) {
    const { b0, b1, b2, a1, a2 } = this, n = buf.length;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    if (periodic) { // warm the state on the loop's tail (IIR memory is short) so the seam is continuous
      for (let i = Math.max(0, n - Math.round(this.sr * 0.35)); i < n; i++) { const x = buf[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; }
    }
    for (let i = 0; i < n; i++) {
      const x = buf[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
    }
    return buf;
  }
}

class Synth {
  constructor(sr) { this.sr = sr; this.bq = new Biquad(sr); }
  n(sec) { return Math.max(1, Math.round(sec * this.sr)); }
  buf(sec) { return new Float32Array(this.n(sec)); }
  noise(sec, rng) { const b = this.buf(sec); for (let i = 0; i < b.length; i++) b[i] = rng.next() * 2 - 1; return b; }
  filt(b, type, f, q, db, periodic) { return this.bq.set(type, f, q, db).run(b, periodic); }
  // multiply by attack/decay envelope starting at t0 (silence before)
  env(b, atk, tau, t0 = 0) {
    const sr = this.sr, s0 = Math.max(0, Math.ceil(t0 * sr));
    for (let i = 0; i < s0 && i < b.length; i++) b[i] = 0;
    const ka = Math.exp(-1 / (atk * sr)), kd = Math.exp(-1 / (tau * sr));
    let ea = 1, ed = 1;                                  // exp(-t/atk), exp(-t/tau) by recurrence
    for (let i = s0; i < b.length; i++) { b[i] *= (1 - ea) * ed; ea *= ka; ed *= kd; }
    return b;
  }
  // time-varying filter: cutoff glides f0 -> f1 with time constant tau
  tv(b, type, f0, f1, tau, q = 0.7071) {
    const bq = this.bq, sr = this.sr;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < b.length; i += 32) {
      bq.set(type, f1 + (f0 - f1) * Math.exp(-(i / sr) / tau), q);
      const { b0, b1, b2, a1, a2 } = bq, e = Math.min(b.length, i + 32);
      for (let j = i; j < e; j++) { const x = b[j], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; b[j] = y; }
    }
    return b;
  }
  // decaying sine with exponential pitch glide f0 -> f1
  sweep(sec, f0, f1, sweepTau, ampTau, atk = 0.001, t0 = 0) {
    const b = this.buf(sec), sr = this.sr, s0 = Math.max(0, Math.round(t0 * sr));
    const ks = Math.exp(-1 / (sweepTau * sr)), ka = Math.exp(-1 / (atk * sr)), kd = Math.exp(-1 / (ampTau * sr));
    let es = 1, ea = 1, ed = 1, ph = 0;
    for (let i = s0; i < b.length; i++) {
      ph += TAU * (f1 + (f0 - f1) * es) / sr;
      b[i] = Math.sin(ph) * (1 - ea) * ed;
      es *= ks; ea *= ka; ed *= kd;
      if (ed < 1e-5) break;
    }
    return b;
  }
  // sum of damped partials [[f, tau, amp], ...] starting at t0
  modal(b, partials, t0 = 0, gain = 1) {
    const sr = this.sr, s = Math.max(0, Math.round(t0 * sr));
    for (const [f, tau, a] of partials) {
      // damped sine by complex-phasor recurrence
      const w = TAU * f / sr, k = Math.exp(-1 / (tau * sr)), cr = Math.cos(w) * k, ci = Math.sin(w) * k;
      const len = Math.min(b.length - s, Math.round(tau * 7 * sr));
      let re = 1, im = 0;
      for (let i = 0; i < len; i++) {
        b[s + i] += gain * a * im * (i < 8 ? i / 8 : 1);
        const r2 = re * cr - im * ci; im = re * ci + im * cr; re = r2;
      }
    }
    return b;
  }
  // N-wave (shock front) : +amp -> -amp linear over dur, starting at t0
  nwave(b, t0, dur, amp) {
    const s = Math.round(t0 * this.sr), m = Math.max(2, Math.round(dur * this.sr));
    for (let i = 0; i < m && s + i < b.length; i++) b[s + i] += amp * (1 - 2 * i / m);
    return b;
  }
  mix(dst, src, g = 1, off = 0) {
    const o = Math.round(off * this.sr), n = Math.min(src.length, dst.length - o);
    for (let i = 0; i < n; i++) dst[o + i] += src[i] * g;
    return dst;
  }
  drive(b, d) { const k = 1 / Math.tanh(d); for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i] * d) * k; return b; }
  peak(b) { let p = 0; for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > p) p = a; } return p; }
  rms(b) { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); }
  norm(b, target = 0.92) { const p = this.peak(b); if (p > 1e-9) { const k = target / p; for (let i = 0; i < b.length; i++) b[i] *= k; } return b; }
  fadeOut(b, sec = 0.01) { const m = Math.min(b.length, this.n(sec)); for (let i = 0; i < m; i++) b[b.length - 1 - i] *= i / m; return b; }
}

// ---------------------------------------------------------------------------------------------
// Engine loop synthesis
// ---------------------------------------------------------------------------------------------
const ENGINES = {
  // Rolls-Royce Merlin: 60° V12, short ejector stubs. Lumpy, growling, crackly; two-stage supercharger whine.
  merlin: {
    cyl: 12, fireHz: 285, loopSec: 2.2,
    cylVar: 0.17, cylTime: 0.035, fireVar: 0.11, jitter: 0.025, drift: 0.09, misfire: 0,
    atk: 0.00006, t1: 0.00035, t2: 0.0012, neg: 0.55, noise: 0.42, tn: 0.0019, ring: 0.32, ringHz: 520, ringTau: 0.003, klen: 2.4,
    peaks: [[105, 6.5, 0.9], [470, 3, 1.4], [1500, 3.5, 2.0]], lp: 5200, hp: 26,
    crackle: 5, crackleAmp: 0.35, sub1: 0.06, sub2: 0.10, prop: 0.16, propHz: 95, whineHz: 3600, whine: 0.018, fanHz: 0, fan: 0, drive: 2.0,
  },
  // Daimler-Benz DB 605 (and close enough for the Jumo 211): inverted V12, direct injection — smoother,
  // buzzier and higher, prominent hydraulic-coupled supercharger whine.
  db605: {
    cyl: 12, fireHz: 275, loopSec: 2.2,
    cylVar: 0.09, cylTime: 0.015, fireVar: 0.07, jitter: 0.015, drift: 0.06, misfire: 0,
    atk: 0.00006, t1: 0.0003, t2: 0.001, neg: 0.5, noise: 0.34, tn: 0.0015, ring: 0.38, ringHz: 760, ringTau: 0.0028, klen: 2.2,
    peaks: [[150, 4.5, 1.0], [820, 5, 1.6], [2300, 3, 2.5]], lp: 6500, hp: 30,
    crackle: 2, crackleAmp: 0.25, sub1: 0.035, sub2: 0.07, prop: 0.12, propHz: 80, whineHz: 2900, whine: 0.045, fanHz: 0, fan: 0, drive: 1.7,
  },
  // BMW 801: 14-cylinder two-row radial — throaty, rough, deep, with the geared 12-blade cooling-fan whine.
  bmw801: {
    cyl: 14, fireHz: 300, loopSec: 2.2,
    cylVar: 0.26, cylTime: 0.05, fireVar: 0.2, jitter: 0.045, drift: 0.14, misfire: 0,
    atk: 0.0001, t1: 0.0005, t2: 0.0017, neg: 0.6, noise: 0.6, tn: 0.0028, ring: 0.26, ringHz: 330, ringTau: 0.004, klen: 2.8,
    peaks: [[85, 7, 0.9], [300, 5, 1.1], [900, 3, 1.4]], lp: 3600, hp: 24,
    crackle: 9, crackleAmp: 0.45, sub1: 0.11, sub2: 0.12, prop: 0.2, propHz: 85, whineHz: 0, whine: 0, fanHz: 1700, fan: 0.022, drive: 2.6,
  },
};
function loVariant(P) {
  return Object.assign({}, P, {
    fireHz: P.fireHz * LO_RATIO, propHz: P.propHz * LO_RATIO, whineHz: P.whineHz * LO_RATIO, fanHz: P.fanHz * LO_RATIO,
    fireVar: P.fireVar * 1.9, cylVar: P.cylVar * 1.3, jitter: P.jitter * 1.6, misfire: 0.02, drift: P.drift * 1.5,
    crackle: P.crackle * 2.5 + 6, crackleAmp: P.crackleAmp * 1.3, whine: P.whine * 0.25, fan: P.fan * 0.4,
    drive: P.drive * 1.15, ringTau: P.ringTau * 1.3, tn: P.tn * 1.3,
  });
}

function renderEngine(S, P, seed) {
  const sr = S.sr, rng = new Rng(seed);
  const fpc = P.cyl;                                         // 4-stroke: every cylinder fires once per 2 revs
  const cycleLen = Math.max(fpc * 4, Math.round(sr * fpc / P.fireHz));
  const nCyc = Math.max(4, Math.round(P.loopSec * sr / cycleLen));
  const N = cycleLen * nCyc;                                  // loop = whole number of engine cycles
  const interval = cycleLen / fpc;
  const out = new Float32Array(N);

  // firing-pulse kernels (exhaust pressure pop: sharp positive spike, slower negative lobe, combustion
  // noise, exhaust stack ring) — a few variants picked at random per firing
  const KL = Math.max(16, Math.ceil(interval * P.klen)), NK = 8, kernels = [];
  for (let k = 0; k < NK; k++) {
    const K = new Float32Array(KL), rh = P.ringHz * (1 + rng.norm() * 0.05), rp = rng.next() * 0.6;
    for (let i = 0; i < KL; i++) {
      const t = i / sr, atk = 1 - Math.exp(-t / P.atk);
      const pos = (t / P.t1) * Math.exp(1 - t / P.t1), neg = (t / P.t2) * Math.exp(1 - t / P.t2);
      K[i] = atk * (pos - P.neg * neg + P.noise * rng.norm() * Math.exp(-t / P.tn) + P.ring * Math.sin(TAU * rh * t + rp) * Math.exp(-t / P.ringTau));
    }
    const tp = (KL * 0.3) | 0;
    for (let i = 0; i < tp; i++) { const w = i / tp; K[KL - 1 - i] *= w * w; }
    kernels.push(K);
  }
  const cylAmp = [], cylOff = [];
  for (let c = 0; c < fpc; c++) { cylAmp.push(Math.max(0.3, 1 + rng.norm() * P.cylVar)); cylOff.push(rng.norm() * P.cylTime * interval); }
  const dA = [], dP = [];
  for (let k = 0; k < 6; k++) { dA.push(P.drift * rng.norm() / Math.sqrt(k + 1)); dP.push(rng.next() * TAU); }

  for (let c = 0; c < nCyc; c++) {
    for (let j = 0; j < fpc; j++) {
      const t0 = c * cycleLen + j * interval + cylOff[j] + rng.norm() * P.jitter * interval;
      let drift = 0; for (let k = 0; k < 6; k++) drift += dA[k] * Math.sin(TAU * (k + 1) * t0 / N + dP[k]);
      let amp = cylAmp[j] * (1 + P.fireVar * rng.norm()) * (1 + drift);
      if (P.misfire && rng.next() < P.misfire) amp *= 0.12;
      if (amp < 0.05) amp = 0.05;
      const K = kernels[rng.int(NK)];
      let p = Math.round(t0) % N; if (p < 0) p += N;
      for (let i = 0; i < KL; i++) { out[p] += amp * K[i]; if (++p >= N) p = 0; }
    }
  }
  // exhaust / stack / cowling resonances (two-pass => periodic)
  S.filt(out, 'hp', P.hp, 0.7, 0, true);
  for (const [f, db, q] of P.peaks) S.filt(out, 'peak', f, q, db, true);
  S.filt(out, 'lp', P.lp, 0.7, 0, true);
  S.filt(out, 'lp', P.lp * 1.6, 0.6, 0, true);
  let r = S.rms(out) || 1;
  for (let i = 0; i < N; i++) out[i] *= 0.25 / r;

  // exhaust crackle: sparse sharp pops (wrapping)
  const nCr = Math.round(P.crackle * N / sr);
  for (let k = 0; k < nCr; k++) {
    const p0 = rng.int(N), len = Math.max(8, Math.round(sr * rng.range(0.0004, 0.0028)));
    const a = P.crackleAmp * Math.pow(rng.next(), 2) * (rng.next() < 0.5 ? -1 : 1);
    let prev = 0;
    for (let i = 0; i < len; i++) { const w = rng.next() * 2 - 1, v = w - 0.7 * prev; prev = w; out[(p0 + i) % N] += a * v * Math.exp(-i / (len * 0.35)); }
  }
  // crank-order tones (sub-harmonics), propeller blade-pass AM + thrum, supercharger / fan whine.
  // All are integer multiples of the cycle frequency, so they loop seamlessly.
  const cycleHz = sr / cycleLen;
  const kProp = Math.max(1, Math.round(P.propHz / cycleHz));
  const kW = Math.max(1, Math.round(P.whineHz / cycleHz)), kF = Math.max(1, Math.round(P.fanHz / cycleHz));
  const tone = new Float32Array(cycleLen), am = new Float32Array(cycleLen), wh = new Float32Array(cycleLen);
  const p1 = rng.next() * TAU, p2 = rng.next() * TAU, pp = rng.next() * TAU;
  for (let i = 0; i < cycleLen; i++) {
    const ph = TAU * i / cycleLen;
    tone[i] = P.sub1 * Math.sin(ph + p1) + P.sub2 * Math.sin(2 * ph + p2) + P.prop * 0.3 * Math.sin(kProp * ph + pp);
    am[i] = 1 + P.prop * Math.sin(kProp * ph + pp);
    wh[i] = P.whine * Math.sin(kW * ph) + P.fan * Math.sin(kF * ph + 1);
  }
  let wAm = 1;
  for (let i = 0, j = 0; i < N; i++) {
    if ((i & 63) === 0) wAm = 0.7 + 0.3 * Math.sin(TAU * 2 * i / N) * Math.sin(TAU * 3 * i / N + 1);
    out[i] = out[i] * am[j] + tone[j] + wh[j] * wAm;
    if (++j >= cycleLen) j = 0;
  }
  S.drive(out, P.drive);
  S.filt(out, 'hp', 18, 0.7, 0, true);
  S.norm(out, 0.9);
  return { data: out, rms: S.rms(out), fireHz: fpc * sr / cycleLen };
}

function pinkNoise(S, sec, rng) {
  const b = S.noise(sec, rng);
  // Paul Kellet's economy pink filter, run twice so the loop is seamless
  let b0 = 0, b1 = 0, b2 = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < b.length; i++) {
      const w = pass ? b[i] : b[i];
      b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
      if (pass) b[i] = b0 + b1 + b2 + w * 0.1848;
    }
  }
  return S.norm(b, 0.8);
}

// ---------------------------------------------------------------------------------------------
// One-shot synthesis
// ---------------------------------------------------------------------------------------------
function synthCannon(S, rng) {
  const b = S.buf(0.5);
  S.nwave(b, 0, 0.0012, 0.8);
  S.mix(b, S.env(S.filt(S.noise(0.05, rng), 'hp', 1800), 0.00005, 0.0025), 1.0);
  S.mix(b, S.env(S.filt(S.noise(0.3, rng), 'lp', 1400 * rng.range(0.85, 1.15)), 0.0003, 0.03), 0.9);
  S.mix(b, S.sweep(0.45, rng.range(140, 165), rng.range(44, 52), 0.03, 0.09, 0.001), 1.0);
  const cl = S.buf(0.15); S.modal(cl, [[1850 * rng.range(0.9, 1.1), 0.02, 1], [2710 * rng.range(0.9, 1.1), 0.014, 0.7], [4130, 0.01, 0.4]]);
  S.mix(b, cl, 0.12, rng.range(0.03, 0.045));
  S.mix(b, S.env(S.filt(S.noise(0.5, rng), 'lp', 350), 0.005, 0.12), 0.35);
  S.drive(b, 1.6); S.filt(b, 'hp', 30); S.fadeOut(b, 0.05);
  return S.norm(b, 0.95);
}
function synthMG(S, rng) {
  const b = S.buf(0.14), n = 1 + rng.int(3);
  for (let k = 0; k < n; k++) {
    const t0 = k === 0 ? 0 : rng.range(0.004, 0.016) * k, a = k === 0 ? 1 : rng.range(0.45, 0.8);
    const c = S.buf(0.1);
    S.nwave(c, 0, 0.0005, 0.5);
    S.mix(c, S.env(S.filt(S.noise(0.03, rng), 'bp', rng.range(2200, 3200), 0.7), 0.00003, 0.0018), 1.2);
    S.mix(c, S.sweep(0.06, rng.range(300, 360), 140, 0.008, 0.012), 0.45);
    S.mix(c, S.env(S.filt(S.noise(0.08, rng), 'lp', 2200), 0.0002, 0.012), 0.4);
    S.mix(b, c, a, t0);
  }
  const tick = S.buf(0.04); S.modal(tick, [[3200 * rng.range(0.9, 1.1), 0.006, 1], [4700, 0.004, 0.6]]);
  S.mix(b, tick, 0.08, 0.02);
  S.drive(b, 1.3); S.filt(b, 'hp', 60); S.fadeOut(b, 0.03);
  return S.norm(b, 0.9);
}
function synthHMG(S, rng) {
  const b = S.buf(0.25);
  S.nwave(b, 0, 0.0008, 0.7);
  S.mix(b, S.env(S.filt(S.noise(0.04, rng), 'hp', 1500), 0.00004, 0.0022), 1.0);
  S.mix(b, S.env(S.filt(S.noise(0.15, rng), 'lp', 1800 * rng.range(0.85, 1.15)), 0.0002, 0.018), 0.7);
  S.mix(b, S.sweep(0.2, rng.range(200, 225), 75, 0.02, 0.045), 0.85);
  S.mix(b, S.env(S.filt(S.noise(0.25, rng), 'lp', 400), 0.003, 0.06), 0.2);
  const tick = S.buf(0.05); S.modal(tick, [[2600 * rng.range(0.9, 1.1), 0.01, 1], [3900, 0.007, 0.5]]);
  S.mix(b, tick, 0.1, 0.025);
  S.drive(b, 1.5); S.filt(b, 'hp', 40); S.fadeOut(b, 0.04);
  return S.norm(b, 0.93);
}
function synthExpClose(S, rng) {
  const len = 2.6, b = S.buf(len);
  S.nwave(b, 0, 0.002, 1.0);
  S.mix(b, S.env(S.filt(S.noise(0.05, rng), 'hp', 1200), 0.00005, 0.004), 0.8);
  S.mix(b, S.env(S.tv(S.noise(len, rng), 'lp', 4500, 180, 0.25), 0.002, 0.35), 1.6);
  S.mix(b, S.sweep(len, rng.range(85, 105), 32, 0.15, 0.45, 0.004), 0.9);
  S.mix(b, S.env(S.filt(S.noise(len, rng), 'lp', 150), 0.05, 0.8), 0.6);
  // debris rattle: metal tinks and dirt clatter, density falling with time
  for (let k = 0; k < 45; k++) {
    const t = 0.08 + Math.min(2.1, -Math.log(1 - rng.next() * 0.98) * 0.45), a = 0.18 * Math.exp(-t / 0.9) * rng.range(0.3, 1);
    const g = S.buf(0.12);
    if (rng.next() < 0.5) S.modal(g, [[rng.range(1500, 6000), rng.range(0.01, 0.04), 1], [rng.range(2500, 8000), rng.range(0.006, 0.02), 0.6]]);
    else S.mix(g, S.env(S.filt(S.noise(0.05, rng), 'hp', 2000), 0.0002, 0.005), 1.0);
    S.mix(b, g, a, t);
  }
  // fire crackle
  for (let k = 0; k < 30; k++) {
    const t = rng.range(0.2, 2.3), g = S.env(S.filt(S.noise(0.01, rng), 'hp', 3000), 0.0001, 0.0015);
    S.mix(b, g, 0.08 * rng.next() * Math.exp(-t / 1.2), t);
  }
  S.drive(b, 1.8); S.filt(b, 'hp', 22); S.fadeOut(b, 0.3);
  return S.norm(b, 0.95);
}
function synthExpFar(S, rng) {
  const len = 5, b = S.buf(len), n = b.length, sr = S.sr;
  S.mix(b, S.env(S.filt(S.filt(S.noise(len, rng), 'lp', 220), 'lp', 300), 0.025, 0.5), 2.2);
  S.mix(b, S.sweep(len, rng.range(55, 65), 28, 0.3, 0.8, 0.02), 0.8);
  // rolling rumble: echoes off ground/terrain/clouds as swells over lowpassed noise
  const e = new Float32Array(n), ka = Math.exp(-1 / (0.09 * sr)), kd = Math.exp(-1 / (0.5 * sr));
  for (let k = 0; k < 10; k++) {
    const t0 = 0.25 + rng.next() * 3.6, a = rng.range(0.3, 0.75) * Math.exp(-t0 / 1.6);
    let ea = 1, ed = 1;
    for (let i = Math.round(t0 * sr); i < n; i++) { e[i] += a * (1 - ea) * ed; ea *= ka; ed *= kd; }
  }
  const rum = S.filt(S.filt(S.noise(len, rng), 'lp', 110), 'lp', 160);
  for (let i = 0; i < n; i++) rum[i] *= e[i];
  S.mix(b, rum, 4.0);
  S.filt(b, 'lp', 420); S.drive(b, 1.3); S.filt(b, 'hp', 20); S.fadeOut(b, 0.6);
  return S.norm(b, 0.95);
}
function synthSubDrop(S, rng) {
  const b = S.sweep(2.4, rng.range(70, 80), 24, 0.5, 0.7, 0.01);
  S.drive(b, 2.0); S.filt(b, 'lp', 180); S.fadeOut(b, 0.4);
  return S.norm(b, 0.95);
}
function synthFlak(S, rng) {
  const len = 1.6, b = S.buf(len);
  S.nwave(b, 0, 0.0015, 0.9);
  S.mix(b, S.env(S.filt(S.noise(0.04, rng), 'hp', 1500), 0.00005, 0.003), 0.6);
  S.mix(b, S.env(S.filt(S.noise(0.5, rng), 'lp', 700 * rng.range(0.85, 1.2)), 0.001, 0.07), 1.3);
  S.mix(b, S.env(S.filt(S.noise(0.9, rng), 'lp', 300), 0.004, 0.18), 1.0);
  S.mix(b, S.sweep(0.8, rng.range(100, 120), 45, 0.04, 0.14), 0.9);
  S.mix(b, S.env(S.filt(S.noise(len, rng), 'lp', 160), 0.03, 0.5), 0.45);
  S.drive(b, 1.7); S.filt(b, 'hp', 25); S.fadeOut(b, 0.2);
  return S.norm(b, 0.95);
}
function synthImpactMetal(S, rng) {
  const b = S.buf(0.3);
  S.mix(b, S.env(S.filt(S.noise(0.02, rng), 'hp', 3000), 0.00005, 0.001), 0.6);
  const parts = []; for (let k = 0; k < 4; k++) parts.push([rng.range(1200, 6500), rng.range(0.015, 0.08), rng.range(0.3, 1)]);
  S.modal(b, parts, 0, 0.5);
  S.fadeOut(b, 0.05);
  return S.norm(b, 0.9);
}
function synthImpactGround(S, rng) {
  const b = S.buf(0.4);
  S.mix(b, S.sweep(0.2, rng.range(130, 160), 60, 0.02, 0.04), 0.7);
  S.mix(b, S.env(S.filt(S.noise(0.2, rng), 'lp', 900), 0.0005, 0.03), 0.8);
  S.mix(b, S.env(S.filt(S.noise(0.4, rng), 'hp', 2500), 0.01, 0.08), 0.25);
  S.fadeOut(b, 0.05);
  return S.norm(b, 0.9);
}
function synthImpactWater(S, rng) {
  const b = S.buf(0.55), sr = S.sr;
  S.mix(b, S.sweep(0.1, 500, 1400, -0.03, 0.03, 0.002), 0.25); // rising "plip"
  const sp = S.env(S.filt(S.noise(0.55, rng), 'bp', 1800, 0.8), 0.003, 0.12);
  let g = 1; for (let i = 0; i < sp.length; i++) { if (i % 160 === 0) g = 0.4 + 0.6 * rng.next(); sp[i] *= g; }
  S.mix(b, sp, 1.0);
  S.mix(b, S.env(S.filt(S.noise(0.2, rng), 'lp', 300), 0.002, 0.04), 0.5);
  void sr; S.fadeOut(b, 0.08);
  return S.norm(b, 0.9);
}
function synthClang(S, rng) {
  const b = S.buf(0.45), f0 = rng.range(350, 720);
  S.mix(b, S.env(S.filt(S.noise(0.02, rng), 'hp', 2000), 0.00005, 0.0015), 0.7);
  const R = [1, 1.59, 2.14, 2.65, 3.42, 4.9], parts = [];
  for (let k = 0; k < R.length; k++) parts.push([f0 * R[k] * rng.range(0.97, 1.03), 0.25 / (1 + k * 0.6) * rng.range(0.6, 1.2), rng.range(0.4, 1) / (1 + k * 0.3)]);
  S.modal(b, parts, 0, 0.6);
  S.mix(b, S.env(S.filt(S.noise(0.1, rng), 'bp', 3000, 1.2), 0.001, 0.02), 0.5);
  S.drive(b, 1.5); S.fadeOut(b, 0.08);
  return S.norm(b, 0.9);
}
function synthCrunch(S, rng) {
  const b = S.buf(0.6);
  const t = S.filt(S.noise(0.6, rng), 'bp', 1200, 2);
  let g = 1; for (let i = 0; i < t.length; i++) { if (i % 240 === 0) g = rng.next() < 0.4 ? rng.next() : 0.1; t[i] *= g; }
  S.mix(b, S.env(t, 0.002, 0.15), 1.4);
  S.modal(b, [[rng.range(250, 400), 0.15, 1], [rng.range(600, 900), 0.08, 0.6], [rng.range(1300, 2000), 0.05, 0.5]], 0, 0.5);
  S.mix(b, S.sweep(0.3, 120, 50, 0.03, 0.08), 0.7);
  S.drive(b, 2.0); S.fadeOut(b, 0.1);
  return S.norm(b, 0.9);
}
function synthBackfire(S, rng) {
  const b = S.buf(0.25);
  S.nwave(b, 0, 0.001, 0.8);
  S.mix(b, S.env(S.filt(S.noise(0.15, rng), 'lp', 1500), 0.0003, 0.02), 1.0);
  S.mix(b, S.sweep(0.2, 180, 70, 0.03, 0.05), 0.8);
  S.drive(b, 1.8); S.fadeOut(b, 0.05);
  return S.norm(b, 0.9);
}
function synthBomb(S, rng) {
  const b = S.buf(0.6);
  S.modal(b, [[1150, 0.02, 1], [2380, 0.015, 0.7], [3510, 0.01, 0.5]], 0, 0.6);
  S.mix(b, S.sweep(0.3, 120, 55, 0.02, 0.06), 1.0);
  S.mix(b, S.env(S.filt(S.noise(0.2, rng), 'lp', 600), 0.0005, 0.04), 0.6);
  S.modal(b, [[1420, 0.015, 1], [2900, 0.01, 0.6]], 0.07, 0.3);
  S.mix(b, S.env(S.filt(S.noise(0.5, rng), 'bp', 700, 0.8), 0.08, 0.15), 0.15, 0.05);
  S.drive(b, 1.4); S.fadeOut(b, 0.1);
  return S.norm(b, 0.9);
}
function synthRadio(S, rng) {
  const len = 0.5, b = S.buf(len), sr = S.sr;
  S.nwave(b, 0, 0.0015, 0.7);
  const nz = S.filt(S.noise(len, rng), 'bp', 1800, 0.9);
  let g = 1;
  for (let i = 0; i < nz.length; i++) {
    if (i % 220 === 0) g = rng.next() < 0.25 ? 0.15 : 0.6 + 0.4 * rng.next();
    const t = i / sr; nz[i] *= g * (t < 0.36 ? 1 : Math.exp(-(t - 0.36) / 0.015));
  }
  S.mix(b, nz, 1.2);
  let ph = 0;
  for (let i = 0; i < b.length; i++) { const t = i / sr; ph += TAU * (900 + 500 * t) / sr; if (t < 0.36) b[i] += 0.07 * Math.sin(ph); }
  const tsk = S.env(S.filt(S.noise(0.04, rng), 'hp', 3000), 0.0005, 0.008);
  S.mix(b, tsk, 0.8, 0.37);
  S.drive(b, 3); S.filt(b, 'hp', 300); S.filt(b, 'lp', 3500); S.fadeOut(b, 0.02);
  return S.norm(b, 0.85);
}
function synthClick(S, rng) {
  const b = S.buf(0.03);
  S.mix(b, S.env(S.filt(S.noise(0.02, rng), 'hp', 3000), 0.00005, 0.0012), 0.6);
  S.modal(b, [[2200, 0.003, 1]], 0, 0.5);
  S.fadeOut(b, 0.005);
  return S.norm(b, 0.7);
}
function blip(S, b, f, t0, dur, amp, harmonics = [1, 0.15]) {
  const sr = S.sr, s = Math.round(t0 * sr), m = Math.round(dur * sr);
  for (let i = 0; i < m && s + i < b.length; i++) {
    const t = i / sr, e = Math.min(1, t / 0.003) * Math.min(1, (dur - t) / 0.012);
    let v = 0; for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin(TAU * f * (h + 1) * t);
    b[s + i] += amp * e * v;
  }
}
function synthSelect(S) { const b = S.buf(0.2); blip(S, b, 660, 0, 0.07, 0.6); blip(S, b, 990, 0.075, 0.1, 0.6); return S.norm(b, 0.7); }
function synthWarn(S) {
  const b = S.buf(0.45), sq = [1, 0, 0.33, 0, 0.2, 0, 0.14];
  blip(S, b, 880, 0, 0.13, 0.5, sq); blip(S, b, 880, 0.2, 0.13, 0.5, sq);
  S.filt(b, 'lp', 4000);
  return S.norm(b, 0.75);
}
function synthKill(S) {
  const b = S.buf(1.0);
  S.mix(b, S.sweep(0.4, 150, 55, 0.03, 0.09), 0.9);
  const f = 1046.5, R = [1, 2.0, 2.76, 4.07, 5.4], A = [1, 0.5, 0.35, 0.2, 0.12], T = [0.6, 0.35, 0.25, 0.15, 0.1];
  S.modal(b, R.map((r, i) => [f * r, T[i], A[i]]), 0.005, 0.45);
  S.modal(b, R.map((r, i) => [f * 1.5 * r, T[i] * 0.9, A[i]]), 0.09, 0.35);
  S.fadeOut(b, 0.1);
  return S.norm(b, 0.85);
}
// falling-bomb whistle fallback: a loop at WHISTLE_HZ (whole number of cycles) with breathy noise
function synthWhistle(S, rng) {
  const sec = 1, n = S.n(sec), b = new Float32Array(n), sr = S.sr;
  const nz = S.filt(S.filt(S.noise(sec, rng), 'bp', WHISTLE_HZ, 6, 0, true), 'bp', WHISTLE_HZ, 6, 0, true);
  S.norm(nz, 1);
  for (let i = 0; i < n; i++) {
    const t = i / sr, ph = TAU * WHISTLE_HZ * t;
    b[i] = 0.6 * Math.sin(ph + 0.02 * Math.sin(TAU * 5 * t)) + 0.1 * Math.sin(2 * ph) + 0.35 * nz[i];
  }
  return S.norm(b, 0.85);
}
function synthReverbIR(ctx, sec, rng) {
  const sr = ctx.sampleRate, n = Math.round(sec * sr), ir = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, a = 0.25 + 0.7 * Math.exp(-t / 0.5);            // darker as it decays
      lp += (rng.next() * 2 - 1 - lp) * a;
      d[i] = lp * Math.exp(-t / 0.55) * Math.min(1, t / 0.01) * (i < 64 ? i / 64 : 1);
    }
  }
  return ir;
}

// ---------------------------------------------------------------------------------------------
// Aircraft types for positional engine voices
// ---------------------------------------------------------------------------------------------
const TYPES = {
  spitfire: { eng: 'merlin', rate: 1.0, twin: false, gain: 1.0, cut: 1.0 },
  mosquito: { eng: 'merlin', rate: 0.95, twin: true, gain: 1.25, cut: 0.85 },
  bf109: { eng: 'db605', rate: 1.0, twin: false, gain: 1.0, cut: 1.0 },
  fw190: { eng: 'bmw801', rate: 1.0, twin: false, gain: 1.1, cut: 0.95 },
  ju87: { eng: 'db605', rate: 0.86, twin: false, gain: 1.05, cut: 0.8 },
  ju88: { eng: 'db605', rate: 0.8, twin: true, gain: 1.3, cut: 0.72 },
};
// rpm (0..1.2, 1 = max continuous) -> firing frequency factor relative to max continuous
const rpmFactor = (rpm) => 0.3 + 0.7 * clamp(fin(rpm, 0.8), 0, 1.3);

function makePanner(ctx) {
  if (ctx.createStereoPanner) return ctx.createStereoPanner();
  const g = ctx.createGain(); // fallback: no panning
  g.pan = { value: 0, setTargetAtTime() {}, setValueAtTime() {}, cancelScheduledValues() {} };
  return g;
}

// ---------------------------------------------------------------------------------------------
export class GameAudio {
  constructor() {
    this.ctx = null;
    this._ready = false;
    this._initP = null;
    this._muted = false;
    this._volume = 0.8;
    this._sirenWanted = false;
    this._err = 0;
    this.synthMs = 0;
    // listener state (world)
    this._L = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0, inCockpit: true };
    this._sp = { d: 0, pan: 0, front: 1, ux: 0, uy: 0, uz: 0 };
    this._sel = [];
    for (let i = 0; i < MAX_ENGINE_VOICES; i++) this._sel.push({ id: null, type: null, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rpm: 0, siren: 0, d2: 0, done: false });
    this._nSel = 0;
    this._lastEngines = -1;
    this._lastResume = 0;
    this._gunSide = 1;
  }

  get ready() { return this._ready; }
  get muted() { return this._muted; }

  setMuted(b) {
    this._muted = !!b;
    if (!this._ready) return;
    try {
      const now = this.ctx.currentTime;
      this._mute.gain.cancelScheduledValues(now);
      this._mute.gain.setTargetAtTime(this._muted ? 0 : 1, now, 0.04);
      if (!this._muted && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { this._fail(e); }
  }
  setVolume(v) {
    this._volume = clamp(fin(v, this._volume), 0, 1);
    if (!this._ready) return;
    try { this._vol.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.03); } catch (e) { this._fail(e); }
  }

  init() {
    if (this._initP) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this._initP;
    }
    this._initP = this._init().catch((e) => {
      console.warn('[audio] init failed', e);
      try { if (this.ctx) this.ctx.close(); } catch (_) { /* */ }
      this.ctx = null; this._initP = null; return false;
    });
    return this._initP;
  }

  async _init() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) { console.warn('[audio] Web Audio not supported'); return false; }
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    this.ctx = ctx;
    const resumeP = ctx.state !== 'running' ? ctx.resume().catch(() => {}) : null;

    const t0 = performance.now();
    const haveP = this._fetchSamples();
    this._buildMaster();
    const have = await haveP;
    await this._synthesize(have);
    this._buildPlayer();
    this._buildVoices();
    this._buildOneShots();
    this._buildBombs();
    this.synthMs = performance.now() - t0 - this._yieldMs;   // pure DSP + graph time (excludes event-loop yields)
    console.log(`[audio] synthesized ${this._bufCount} buffers (${this._bufSeconds.toFixed(1)} s of audio) + graph in ${this.synthMs.toFixed(0)} ms @ ${ctx.sampleRate} Hz`);

    if (resumeP) await Promise.race([resumeP, new Promise((r) => setTimeout(r, 400))]);
    this._ready = true;
    this.setVolume(this._volume);
    this.setMuted(this._muted);
    if (this._sirenWanted) this.siren(true);
    // a hidden tab stops the game loop: silence everything instead of droning on
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else this.ctx.resume().catch(() => {});
    });
    return true;
  }

  // Real recordings replace the synthesized buffers when they load; the synthesized ones stay as the
  // fallback (e.g. opened from file://). Engines: audio/*.wav (tools/make-engine-loops.mjs); sound effects:
  // audio/sfx/*.wav (tools/make-sfx.mjs) - all fetched in parallel, each file optional: a slot takes
  // whichever of its variants loaded, and keeps its synthesized buffers if none did.
  async _fetchSamples() {
    const c = this.ctx;
    const load = async (name) => {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 8000);   // never hang the start button
      try {
        const r = await fetch(new URL(`../audio/${name}.wav`, import.meta.url), { signal: ac.signal });
        if (!r.ok) throw new Error(`${name}: ${r.status}`);
        return await c.decodeAudioData(await r.arrayBuffer());
      } finally { clearTimeout(to); }
    };
    const rms = (b) => { const d = b.getChannelData(0); let e = 0; for (let i = 0; i < d.length; i += 4) e += d[i] * d[i]; return Math.sqrt(e / (d.length / 4)); };
    const slots = Object.keys(SFX);
    const engP = Promise.all(['merlin_idle', 'merlin_power', 'merlin_power2', 'db605_idle', 'db605_power'].map(load))
      .catch((e) => { console.warn('[audio] engine recordings unavailable, using synthesized engines:', e.message); return null; });
    const sfxP = Promise.all(slots.map((k) => Promise.allSettled(SFX[k].map((f) => load('sfx/' + f)))));
    const [eng, res] = await Promise.all([engP, sfxP]);
    const have = { eng: {}, buf: {} };
    if (eng) {
      const [mi, mp, mp2, di, dp] = eng;
      // power loops play at their recorded pitch at ~90% rpm; idle loops at their pitch near idle (rpm ~0.4)
      const mk = (lo, hi, hiAlt, pitch) => ({ hi, lo, hiAlt, hiRate: 1.1 * pitch, loRate: 1.65 * pitch, comp: clamp(0.2 / rms(hi), 0.4, 2) * 1.45, sampled: true });
      have.eng.merlin = mk(mi, mp, mp2, 1);
      have.eng.db605 = mk(di, dp, null, 1.12);
      have.eng.bmw801 = mk(di, dp, null, 0.95);   // Fw 190: the Daimler-Benz recording, pitched down
      console.log('[audio] engine recordings loaded (Merlin, Daimler-Benz)');
    }
    this.sampled = {};
    const got = [], missing = [];
    slots.forEach((k, i) => {
      const ok = res[i].filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (ok.length) { have.buf[k] = ok; this.sampled[k] = ok.length; got.push(`${k}:${ok.length}`); } else missing.push(k);
      if (ok.length < SFX[k].length && ok.length) missing.push(`${k}(${SFX[k].length - ok.length} of ${SFX[k].length})`);
    });
    if (got.length) console.log(`[audio] recorded sound effects: ${got.join(' ')}`);
    if (missing.length) console.warn(`[audio] sound effects not loaded, synthesized fallback: ${missing.join(' ')}`);
    return have;
  }

  _fail(e) { if (this._err++ < 5) console.warn('[audio]', e); }
  _ok() { return this._ready; }

  // ------------------------------------------------------------------ graph
  _buildMaster() {
    const c = this.ctx;
    this._pre = c.createGain();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
    const makeup = c.createGain(); makeup.gain.value = 1.35;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    const pg = c.createGain(); pg.gain.value = 0.5;               // soft clipper (curve covers ±2)
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1) * 2 - 1) * 2, a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < 0.7 ? a : 0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28));
    }
    shaper.curve = curve; shaper.oversample = '2x';
    const pg2 = c.createGain(); pg2.gain.value = 1;
    this._vol = c.createGain(); this._vol.gain.value = this._volume;
    this._mute = c.createGain(); this._mute.gain.value = this._muted ? 0 : 1;
    this._pre.connect(comp); comp.connect(makeup); makeup.connect(lim); lim.connect(pg); pg.connect(shaper);
    shaper.connect(pg2); pg2.connect(this._vol); this._vol.connect(this._mute); this._mute.connect(c.destination);
    this._outNode = this._mute;

    // reverb (synthetic IR): distant explosions, siren, fanfares
    this._revIn = c.createGain(); this._revIn.gain.value = 1;
    const conv = c.createConvolver(); conv.normalize = true;
    conv.buffer = synthReverbIR(c, 2.4, new Rng(77));
    const revOut = c.createGain(); revOut.gain.value = 0.55;
    this._revIn.connect(conv); conv.connect(revOut); revOut.connect(this._pre);

    // external (positional) sounds go through a canopy filter when in the cockpit
    this._ext = c.createBiquadFilter(); this._ext.type = 'lowpass'; this._ext.frequency.value = 20000; this._ext.Q.value = 0;
    // the world (engines, wind, siren, everything positional) ducks under radio speech
    this._duck = c.createGain(); this._duck.connect(this._pre);
    this._extG = c.createGain(); this._ext.connect(this._extG); this._extG.connect(this._duck);
    this._voiceBus = c.createGain(); this._voiceBus.gain.value = 1.3; this._voiceBus.connect(this._pre);

    const bus = (g, dest) => { const n = c.createGain(); n.gain.value = g; n.connect(dest); return n; };
    this.bus = {
      playerEngine: bus(0.6, this._duck),
      wind: bus(0.5, this._duck),
      playerGun: bus(1.1, this._pre),
      inHead: bus(0.8, this._pre),
      engine: bus(0.6, this._ext),
      gun: bus(0.85, this._ext),
      fx: bus(1.0, this._ext),
      ui: bus(0.55, this._pre),
      siren: bus(0.4, this._duck),
    };
  }

  async _synthesize(have = { eng: {}, buf: {} }) {
    // yields between groups keep the page responsive while ~250 ms of DSP runs
    this._yieldMs = 0;
    const tick = () => { const t = performance.now(); return new Promise((r) => setTimeout(r, 0)).then(() => { this._yieldMs += performance.now() - t; }); };
    const c = this.ctx, S = new Synth(c.sampleRate);
    let count = 0, secs = 0;
    // low-frequency-only sounds are rendered at a reduced rate (the browser resamples on playback)
    const S2 = new Synth(c.sampleRate / 2), S4 = new Synth(c.sampleRate / 4);
    const B = (arr, sr = c.sampleRate) => { const b = c.createBuffer(1, arr.length, sr); b.getChannelData(0).set(arr); count++; secs += b.duration; return b; };
    const many = (fn, n, seed, SS = S) => { const out = []; for (let i = 0; i < n; i++) out.push(B(fn(SS, new Rng(seed + i * 7919)), SS.sr)); return out; };

    this.eng = {};
    let seed = 1000;
    for (const k of Object.keys(ENGINES)) {
      const P = ENGINES[k];
      seed += 2;
      if (have.eng[k]) { this.eng[k] = have.eng[k]; continue; }
      const hi = renderEngine(S, P, seed - 2), lo = renderEngine(S, loVariant(P), seed - 1);
      this.eng[k] = {
        hi: B(hi.data), lo: B(lo.data),
        hiRate: P.fireHz / hi.fireHz,                 // playbackRate at rpm factor 1
        loRate: P.fireHz / lo.fireHz,                 // (=> ~1/LO_RATIO)
        comp: clamp(0.2 / (hi.rms || 0.2), 0.5, 2),
      };
      await tick();
    }
    const H = have.buf, buf = this.buf = {};
    const add = (k, fn) => { buf[k] = H[k] || fn(); };
    add('cannon', () => many(synthCannon, 4, 11)); add('mg', () => many(synthMG, 5, 23)); add('hmg', () => many(synthHMG, 4, 37));
    await tick();
    add('expClose', () => many(synthExpClose, 3, 51, S2)); add('expFar', () => many(synthExpFar, 2, 61, S4));
    add('sub', () => many(synthSubDrop, 1, 71, S4)); add('flak', () => many(synthFlak, 3, 81, S2));
    await tick();
    add('metal', () => many(synthImpactMetal, 3, 91)); add('ground', () => many(synthImpactGround, 3, 101)); add('water', () => many(synthImpactWater, 3, 111));
    add('clang', () => many(synthClang, 4, 121)); add('crunch', () => many(synthCrunch, 2, 131)); add('backfire', () => many(synthBackfire, 3, 141));
    add('bomb', () => many(synthBomb, 1, 151)); add('radio', () => many(synthRadio, 3, 161));
    add('click', () => many(synthClick, 1, 171)); add('select', () => many(synthSelect, 1, 181)); add('warn', () => many(synthWarn, 1, 191)); add('kill', () => many(synthKill, 1, 201));
    add('wind', () => [B(pinkNoise(S2, 4, new Rng(211)), S2.sr)]); add('whistle', () => many(synthWhistle, 1, 221));
    for (const k in H) if (!buf[k]) buf[k] = H[k];      // recording-only slots (sirenLoop)
    if (!buf.expBig) buf.expBig = buf.expClose;         // fallback for the big (bomb) explosion
    this._bufCount = count; this._bufSeconds = secs;
  }

  // ------------------------------------------------------------------ player engine + wind
  _buildPlayer() {
    const c = this.ctx;
    const pe = this._pe = {
      srcs: null, gHi: [], gLo: [], pans: [],
      tone: c.createBiquadFilter(), shelf: c.createBiquadFilter(), rough: c.createGain(), cough: c.createGain(), out: c.createGain(),
      level: 0, activeT: -1, inactiveSince: 0, twin: false, nextCough: 0, sag: 0, sagUntil: 0, t: 0, lastT: 0, dmg: 0,
    };
    pe.tone.type = 'lowpass'; pe.tone.frequency.value = 4000; pe.tone.Q.value = 0;
    pe.shelf.type = 'lowshelf'; pe.shelf.frequency.value = 160; pe.shelf.gain.value = 3;
    pe.out.gain.value = 0;
    for (let i = 0; i < 2; i++) {
      const gh = c.createGain(), gl = c.createGain(), p = makePanner(c);
      gh.gain.value = 0; gl.gain.value = 0;
      gh.connect(p); gl.connect(p); p.connect(pe.tone);
      pe.gHi.push(gh); pe.gLo.push(gl); pe.pans.push(p);
    }
    pe.tone.connect(pe.shelf); pe.shelf.connect(pe.rough); pe.rough.connect(pe.cough); pe.cough.connect(pe.out); pe.out.connect(this.bus.playerEngine);

    // wind: bandpassed noise (rush / whistle) + lowpassed noise (buffet / ground roll)
    const w = this._wind = {
      a: c.createBufferSource(), b: c.createBufferSource(), bp: c.createBiquadFilter(), hs: c.createBiquadFilter(), lp: c.createBiquadFilter(), ga: c.createGain(), gb: c.createGain(),
    };
    w.a.buffer = this.buf.wind[0]; w.b.buffer = this.buf.wind[0]; w.a.loop = w.b.loop = true;
    w.bp.type = 'bandpass'; w.bp.frequency.value = 600; w.bp.Q.value = 0.8;
    w.hs.type = 'highshelf'; w.hs.frequency.value = 3000; w.hs.gain.value = -6;
    w.lp.type = 'lowpass'; w.lp.frequency.value = 150; w.lp.Q.value = 0;
    w.ga.gain.value = 0; w.gb.gain.value = 0;
    w.a.connect(w.bp); w.bp.connect(w.hs); w.hs.connect(w.ga); w.ga.connect(this.bus.wind);
    w.b.connect(w.lp); w.lp.connect(w.gb); w.gb.connect(this.bus.wind);
    w.a.start(0, 0); w.b.start(0, 1.7);
  }

  _startPlayerSources() {
    const c = this.ctx, pe = this._pe, E = this.eng.merlin;
    pe.srcs = [];
    for (let i = 0; i < 2; i++) {
      const hi = c.createBufferSource(), lo = c.createBufferSource();
      hi.buffer = E.hi; lo.buffer = E.lo; hi.loop = lo.loop = true;
      hi.connect(pe.gHi[i]); lo.connect(pe.gLo[i]);
      const off = i * 1.13 + RNG.next() * 0.5;
      hi.start(0, off % E.hi.duration); lo.start(0, (off * 1.7) % E.lo.duration);
      pe.srcs.push(hi, lo);
    }
  }
  _stopPlayerSources() {
    const pe = this._pe;
    if (!pe.srcs) return;
    for (const s of pe.srcs) { try { s.stop(); s.disconnect(); } catch (e) { /* */ } }
    pe.srcs = null;
  }

  setPlayerEngine(p) {
    if (!this._ok() || !p) return;
    try { this._setPlayerEngine(p); } catch (e) { this._fail(e); }
  }
  _setPlayerEngine(p) {
    const c = this.ctx, now = c.currentTime, pe = this._pe, w = this._wind, L = this._L;
    const dt = clamp(now - (pe.lastT || now), 0, 0.1); pe.lastT = now;
    const active = !!p.active;
    const twin = p.type === 'mosquito';
    const rpm = clamp(fin(p.rpm, 0.7), 0, 1.25), thr = sat(fin(p.throttle, 0.7));
    const speed = Math.max(0, fin(p.speed, 0)), dmg = sat(fin(p.damage, 0)), g = fin(p.gForce, 1);
    const onGround = !!p.onGround, cockpit = L.inCockpit;

    if (active) {
      pe.inactiveSince = 0;
      if (!pe.srcs) this._startPlayerSources();
    } else if (pe.srcs) {
      if (!pe.inactiveSince) pe.inactiveSince = now;
      else if (now - pe.inactiveSince > 1.5) this._stopPlayerSources();
    }
    if (pe.srcs) {
      const E = this.eng.merlin;
      // coughs / missing beats when damaged
      if (active && dmg > 0.5) {
        if (now >= pe.nextCough) {
          if (pe.nextCough > 0) {
            const dur = RNG.range(0.06, 0.09 + 0.25 * dmg);
            pe.cough.gain.cancelScheduledValues(now);
            pe.cough.gain.setTargetAtTime(RNG.range(0.05, 0.25), now, 0.012);
            pe.cough.gain.setTargetAtTime(1, now + dur, 0.035);
            pe.sag = RNG.range(0.04, 0.1); pe.sagUntil = now + dur + 0.1;
            if (RNG.next() < 0.6) this._play(this._pick(this.buf.backfire), this.bus.inHead, 0.35 + 0.3 * dmg, RNG.range(0.85, 1.15), dur * 0.7, null, RNG.range(-0.3, 0.3), 20000, 0, 3);
          }
          pe.nextCough = now + 0.15 - Math.log(1 - RNG.next() * 0.99) / ((dmg - 0.5) * 7 + 0.4);
        }
      } else { pe.nextCough = 0; }
      const sag = now < pe.sagUntil ? pe.sag : 0;
      const f = rpmFactor(rpm) * (1 - sag);
      const rHi = f * E.hiRate, rLo = f * E.loRate;
      // equal-power crossfade idle loop -> power loop
      const x = clamp((rpm - 0.42) / 0.38, 0, 1), wLo = Math.cos(x * Math.PI / 2), wHi = Math.sin(x * Math.PI / 2);
      const wob = 0.008 + 0.004 * Math.sin(now * 0.31) + 0.002 * Math.sin(now * 1.7);
      for (let i = 0; i < 2; i++) {
        const k = i === 0 ? 1 : 1 + wob;
        pe.srcs[i * 2].playbackRate.setTargetAtTime(rHi * k, now, 0.05);
        pe.srcs[i * 2 + 1].playbackRate.setTargetAtTime(rLo * k, now, 0.05);
        const eg = i === 0 ? (twin ? 0.78 : 1) : (twin ? 0.78 : 0);
        pe.gHi[i].gain.setTargetAtTime(wHi * eg, now, 0.06);
        pe.gLo[i].gain.setTargetAtTime(wLo * eg * 1.1, now, 0.06);
        pe.pans[i].pan.setTargetAtTime(twin ? (i === 0 ? -0.45 : 0.45) : 0, now, 0.1);
      }
      const boost = Math.max(0, rpm - 1) * 5;  // 0..1.25 in emergency boost
      const bright = cockpit ? 1600 + 2600 * thr + 1200 * boost : 3200 + 6000 * thr + 2000 * boost;
      pe.tone.frequency.setTargetAtTime(bright * (1 - 0.35 * dmg), now, 0.08);
      pe.shelf.gain.setTargetAtTime((cockpit ? 5 : 1.5) + 2 * boost, now, 0.1);
      const lvl = active ? (0.5 + 0.38 * thr + 0.12 * rpm + 0.1 * boost) * (cockpit ? 1 : 0.8) * (twin ? 1.12 : 1) * E.comp : 0;
      pe.out.gain.setTargetAtTime(lvl, now, active ? 0.12 : 0.35);
      // damage roughness: random flutter
      pe.rough.gain.setTargetAtTime(dmg > 0.15 ? 1 - RNG.next() * dmg * 0.45 : 1, now, 0.012);
      pe.dmg = dmg;
    }

    // airflow: rises with speed, a bit with g; ground roll rumble
    const s = clamp(speed / 200, 0, 1.4), ga = Math.min(1, Math.abs(g - 1) / 6);
    let rush = 0.55 * Math.pow(s, 1.7) * (1 + 0.35 * ga) * (cockpit ? 0.8 : 1);
    let buffet = 0.35 * s * s * 0.5 + 0.5 * ga * s + (onGround ? 0.45 * clamp(speed / 40, 0, 1) : 0);
    if (!active) rush = buffet = 0;
    buffet *= 0.75 + 0.5 * RNG.next() * (0.3 + ga);
    w.ga.gain.setTargetAtTime(rush, now, 0.1);
    w.gb.gain.setTargetAtTime(buffet, now, 0.05);
    w.bp.frequency.setTargetAtTime(300 + 1300 * s + 300 * ga, now, 0.15);
    w.bp.Q.setTargetAtTime(0.7 + 0.8 * s, now, 0.2);
    w.lp.frequency.setTargetAtTime(110 + 140 * s, now, 0.2);
    pe.called = now;
    void dt;
  }

  // ------------------------------------------------------------------ positional engine voices
  _buildVoices() {
    const c = this.ctx;
    this._voices = [];
    for (let i = 0; i < ENGINE_POOL; i++) {
      const v = {
        state: 0, id: null, type: null, T: null, srcs: [], fade: c.createGain(), lp: c.createBiquadFilter(), dist: c.createGain(), pan: makePanner(c),
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rpm: 0.8, siren: 0, t: 0, dop: 1, fresh: true, relStart: 0, relEnd: 0, sir: null, sirenOffAt: 0,
        rateOff: RNG.range(-0.015, 0.015),
      };
      v.fade.gain.value = 0; v.lp.type = 'lowpass'; v.lp.Q.value = 0; v.lp.frequency.value = 8000; v.dist.gain.value = 0;
      v.fade.connect(v.lp); v.lp.connect(v.dist); v.dist.connect(v.pan); v.pan.connect(this.bus.engine);
      this._voices.push(v);
    }
  }

  setEngines(list) {
    if (!this._ok()) return;
    try { this._setEngines(list); } catch (e) { this._fail(e); }
  }
  _setEngines(list) {
    const now = this.ctx.currentTime, L = this._L, sel = this._sel, V = this._voices;
    this._lastEngines = now;
    let ns = 0;
    const n = Array.isArray(list) ? Math.min(list.length, 128) : 0;
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (!e || typeof e !== 'object') continue;
      const x = fin(e.x, NaN), y = fin(e.y, NaN), z = fin(e.z, NaN);
      if (x !== x || y !== y || z !== z) continue;
      const id = e.id !== undefined && e.id !== null ? e.id : 'i' + i;
      const dx = x - L.x, dy = y - L.y, dz = z - L.z;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > ENGINE_MAX_DIST * ENGINE_MAX_DIST) continue;
      for (let k = 0; k < ENGINE_POOL; k++) if (V[k].state === 1 && V[k].id === id) { d2 *= 0.75; break; } // hysteresis
      if (ns === MAX_ENGINE_VOICES && d2 >= sel[ns - 1].d2) continue;
      // insertion into sorted fixed array
      let j = ns < MAX_ENGINE_VOICES ? ns++ : ns - 1;
      const slot = sel[j];
      while (j > 0 && sel[j - 1].d2 > d2) { sel[j] = sel[j - 1]; j--; }
      sel[j] = slot;
      slot.id = id; slot.type = TYPES[e.type] ? e.type : 'bf109';
      slot.x = x; slot.y = y; slot.z = z;
      slot.vx = clamp(fin(e.vx, 0), -400, 400); slot.vy = clamp(fin(e.vy, 0), -400, 400); slot.vz = clamp(fin(e.vz, 0), -400, 400);
      slot.rpm = clamp(fin(e.rpm, 0.85), 0, 1.25); slot.siren = sat(fin(e.siren, 0)); slot.d2 = d2; slot.done = false;
    }
    this._nSel = ns;
    // keep / revive voices whose id is still selected
    for (let k = 0; k < ENGINE_POOL; k++) V[k].keep = false;
    for (let s = 0; s < ns; s++) {
      const e = sel[s];
      for (let k = 0; k < ENGINE_POOL; k++) {
        const v = V[k];
        if (v.state !== 0 && v.id === e.id && v.type === e.type) {
          this._voiceData(v, e, now);
          if (v.state === 2) { v.state = 1; v.fade.gain.cancelScheduledValues(now); v.fade.gain.setTargetAtTime(v.T.twin ? 0.75 : 1, now, 0.1); }
          v.keep = true; e.done = true; break;
        }
      }
    }
    for (let k = 0; k < ENGINE_POOL; k++) { const v = V[k]; if (v.state === 1 && !v.keep) this._releaseVoice(v, now); }
    // new arrivals take idle voices (or long-faded releasing ones)
    for (let s = 0; s < ns; s++) {
      const e = sel[s];
      if (e.done) continue;
      let v = null;
      for (let k = 0; k < ENGINE_POOL; k++) if (V[k].state === 0) { v = V[k]; break; }
      if (!v) {
        let best = null;
        for (let k = 0; k < ENGINE_POOL; k++) { const u = V[k]; if (u.state === 2 && now - u.relStart > 0.4 && (!best || u.relStart < best.relStart)) best = u; }
        if (best) { this._stopVoice(best); v = best; }
      }
      if (!v) continue; // try again next frame
      this._startVoice(v, e, now);
    }
  }
  _voiceData(v, e, now) {
    v.x = e.x; v.y = e.y; v.z = e.z; v.vx = e.vx; v.vy = e.vy; v.vz = e.vz; v.rpm = e.rpm; v.siren = e.siren; v.t = now;
  }
  _startVoice(v, e, now) {
    const c = this.ctx, T = TYPES[e.type], E = this.eng[T.eng];
    v.id = e.id; v.type = e.type; v.T = T; v.E = E; v.state = 1; v.fresh = true; v.dop = 1;
    this._voiceData(v, e, now);
    const n = T.twin ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const s = c.createBufferSource();
      s.buffer = E.hiAlt && (v.id + i) % 2 ? E.hiAlt : E.hi; s.loop = true;
      s.playbackRate.value = rpmFactor(v.rpm) * E.hiRate * T.rate;
      s.connect(v.fade);
      s.start(now, RNG.next() * s.buffer.duration);
      v.srcs.push(s);
    }
    v.fade.gain.cancelScheduledValues(now);
    v.fade.gain.setValueAtTime(0, now);
    v.fade.gain.setTargetAtTime(T.twin ? 0.75 : 1, now, 0.1);
  }
  _releaseVoice(v, now) {
    v.state = 2; v.relStart = now; v.relEnd = now + 0.6;
    v.fade.gain.cancelScheduledValues(now);
    v.fade.gain.setTargetAtTime(0, now, 0.09);
  }
  _stopVoice(v) {
    for (const s of v.srcs) { try { s.stop(); s.disconnect(); } catch (e) { /* */ } }
    v.srcs.length = 0;
    if (v.sir) this._killSiren(v);
    v.state = 0; v.id = null; v.type = null;
  }
  _buildSiren(v) {
    // Jericho trumpet: propeller-driven siren, rotor-chopped howl
    const c = this.ctx, now = c.currentTime;
    const o1 = c.createOscillator(), o2 = c.createOscillator(), o3 = c.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square'; o3.type = 'triangle';
    const g1 = c.createGain(), g2 = c.createGain(), g3 = c.createGain();
    g1.gain.value = 0.45; g2.gain.value = 0.16; g3.gain.value = 0.5;
    const bp = c.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 2500; bp.Q.value = 4;
    const g = c.createGain(); g.gain.value = 0;
    o1.connect(g1); o2.connect(g2); o3.connect(g3); g1.connect(bp); g2.connect(bp); g3.connect(bp); bp.connect(g); g.connect(v.fade);
    for (const o of [o1, o2, o3]) { o.frequency.value = 300; o.start(now); }
    v.sir = { o1, o2, o3, bp, g, wob: 0 };
  }
  _killSiren(v) {
    const s = v.sir; v.sir = null;
    for (const o of [s.o1, s.o2, s.o3]) { try { o.stop(); } catch (e) { /* */ } }
    try { s.g.disconnect(); } catch (e) { /* */ }
  }

  // ------------------------------------------------------------------ falling-bomb whistles
  _buildBombs() {
    const c = this.ctx;
    this._bombV = []; this._bombSel = [];
    for (let i = 0; i < BOMB_VOICES; i++) {
      const v = { state: 0, key: null, src: null, g: c.createGain(), lp: c.createBiquadFilter(), pan: makePanner(c),
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fall: 0, t: 0, t0: 0, dop: 1, fresh: true, relEnd: 0, keep: false };
      v.g.gain.value = 0; v.lp.type = 'lowpass'; v.lp.Q.value = 0; v.lp.frequency.value = 12000;
      v.g.connect(v.lp); v.lp.connect(v.pan); v.pan.connect(this.bus.fx);
      this._bombV.push(v);
      this._bombSel.push({ key: null, e: null, d2: 0, done: false });
    }
    this._lastBombs = -1;
  }
  // Falling bombs, every frame: [{ x, y, z, vx, vy, vz, id?, t? }] - e.g. game.sim.bombs as it is (without an
  // id the object itself is the identity; t = seconds since release, else counted from when first seen).
  // The nearest BOMB_VOICES within BOMB_MAX_DIST whistle: pitch falling over the fall, Doppler, distance
  // filtering; a bomb that leaves the list (impact) fades out when its explosion's sound arrives (d / C).
  setBombs(list) {
    if (!this._ok()) return;
    try { this._setBombs(list); } catch (e) { this._fail(e); }
  }
  _setBombs(list) {
    const now = this.ctx.currentTime, L = this._L, sel = this._bombSel, V = this._bombV;
    this._lastBombs = now;
    let ns = 0;
    const n = Array.isArray(list) ? Math.min(list.length, 256) : 0;
    for (let k = 0; k < BOMB_VOICES; k++) V[k].seen = false;
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (!e || typeof e !== 'object') continue;
      const x = fin(e.x, NaN), y = fin(e.y, NaN), z = fin(e.z, NaN);
      if (x !== x || y !== y || z !== z) continue;
      const key = e.id !== undefined && e.id !== null ? e.id : e;
      // still falling (even if out of range / displaced): its whistle fades rather than waiting for an impact
      for (let k = 0; k < BOMB_VOICES; k++) if (V[k].key === key) V[k].seen = true;
      const dx = x - L.x, dy = y - L.y, dz = z - L.z;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > BOMB_MAX_DIST * BOMB_MAX_DIST) continue;
      for (let k = 0; k < BOMB_VOICES; k++) if (V[k].state === 1 && V[k].key === key) { d2 *= 0.75; break; } // hysteresis
      if (ns === BOMB_VOICES && d2 >= sel[ns - 1].d2) continue;
      let j = ns < BOMB_VOICES ? ns++ : ns - 1;
      const slot = sel[j];
      while (j > 0 && sel[j - 1].d2 > d2) { sel[j] = sel[j - 1]; j--; }
      sel[j] = slot;
      slot.key = key; slot.e = e; slot.d2 = d2; slot.done = false;
    }
    for (let k = 0; k < BOMB_VOICES; k++) V[k].keep = false;
    for (let s = 0; s < ns; s++) {
      const q = sel[s];
      for (let k = 0; k < BOMB_VOICES; k++) { const v = V[k]; if (v.state === 1 && v.key === q.key) { this._bombData(v, q.e, now); v.keep = true; q.done = true; break; } }
    }
    for (let k = 0; k < BOMB_VOICES; k++) { const v = V[k]; if (v.state === 1 && !v.keep) this._releaseBomb(v, now, !!list && !v.seen); }
    for (let s = 0; s < ns; s++) {
      const q = sel[s];
      if (!q.done) {
        let v = null;
        for (let k = 0; k < BOMB_VOICES; k++) if (V[k].state === 0) { v = V[k]; break; }
        if (!v) { // steal the fading voice that ends first
          for (let k = 0; k < BOMB_VOICES; k++) { const u = V[k]; if (u.state === 2 && (!v || u.relEnd < v.relEnd)) v = u; }
          if (v) this._stopBomb(v);
        }
        if (v) this._startBomb(v, q, now);
      }
      q.e = null; q.key = null;
    }
  }
  _bombData(v, e, now) {
    v.x = fin(e.x, v.x); v.y = fin(e.y, v.y); v.z = fin(e.z, v.z);
    v.vx = clamp(fin(e.vx, 0), -600, 600); v.vy = clamp(fin(e.vy, 0), -600, 600); v.vz = clamp(fin(e.vz, 0), -600, 600);
    v.t = now;
    const t = fin(e.t, NaN);
    v.fall = t === t ? clamp(t, 0, 600) : now - v.t0;
  }
  _startBomb(v, q, now) {
    const c = this.ctx;
    v.state = 1; v.key = q.key; v.fresh = true; v.dop = 1; v.t0 = now;
    this._bombData(v, q.e, now);
    const src = c.createBufferSource();
    src.buffer = this._pick(this.buf.whistle); src.loop = true;
    src.connect(v.g);
    src.start(now, RNG.next() * src.buffer.duration);
    v.src = src;
    v.g.gain.cancelScheduledValues(now); v.g.gain.setValueAtTime(0, now);
  }
  // impact (bomb gone from the list): hold until the explosion is heard, then a quick fade
  _releaseBomb(v, now, delayed) {
    v.state = 2;
    const at = delayed ? now + Math.min(4, this._spatial(v.x, v.y, v.z).d / C) : now;
    const g = v.g.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.setTargetAtTime(0, at, delayed ? 0.025 : 0.08);
    v.relEnd = at + 0.4;
  }
  _stopBomb(v) {
    if (v.src) { try { v.src.stop(); v.src.disconnect(); } catch (e) { /* */ } }
    v.src = null; v.state = 0; v.key = null;
  }
  // whistle pitch over the fall: ~2.5 kHz just after release, settling towards ~1.3 kHz
  _whistleRate(fall) { return (1250 + 1250 * Math.exp(-fall / 3.5)) / WHISTLE_HZ; }

  // listener-relative spatialisation into this._sp
  _spatial(x, y, z) {
    const L = this._L, sp = this._sp;
    let dx = x - L.x, dy = y - L.y, dz = z - L.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-3) { dx /= d; dy /= d; dz /= d; } else { dx = 0; dy = 0; dz = -1; }
    sp.d = d; sp.ux = dx; sp.uy = dy; sp.uz = dz;
    sp.pan = clamp(dx * L.rx + dy * L.ry + dz * L.rz, -1, 1) * 0.92;
    sp.front = dx * L.fx + dy * L.fy + dz * L.fz;
    return sp;
  }
  _airCut(d) { return clamp(22000 / (1 + d / 110), 140, 20000); }

  // ------------------------------------------------------------------ per frame
  update(dt, L) {
    if (L && typeof L === 'object') this._setListener(L);
    if (!this._ok()) return;
    try { this._update(clamp(fin(dt, 0.016), 0, 0.25)); } catch (e) { this._fail(e); }
  }
  _setListener(L) {
    const M = this._L;
    const p = L.pos, v = L.vel, f = L.fwd, u = L.up;
    if (p) { M.x = fin(p.x, M.x); M.y = fin(p.y, M.y); M.z = fin(p.z, M.z); }
    if (v) { M.vx = clamp(fin(v.x, 0), -500, 500); M.vy = clamp(fin(v.y, 0), -500, 500); M.vz = clamp(fin(v.z, 0), -500, 500); }
    if (f && u) {
      const fx = fin(f.x, NaN), fy = fin(f.y, NaN), fz = fin(f.z, NaN), ux = fin(u.x, NaN), uy = fin(u.y, NaN), uz = fin(u.z, NaN);
      let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux; // right = fwd x up
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz), fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (rl > 1e-6 && fl > 1e-6) {
        M.rx = rx / rl; M.ry = ry / rl; M.rz = rz / rl; M.fx = fx / fl; M.fy = fy / fl; M.fz = fz / fl;
      }
    }
    if (L.inCockpit !== undefined) M.inCockpit = !!L.inCockpit;
  }
  _update(dt) {
    const c = this.ctx, now = c.currentTime, L = this._L;
    if (c.state !== 'running' && !this._muted && performance.now() - (this._lastResumeWall || 0) > 1000) {
      this._lastResumeWall = performance.now(); c.resume().catch(() => {});
    }
    // canopy muffling
    this._ext.frequency.setTargetAtTime(L.inCockpit ? 5200 : 20000, now, 0.08);
    this._extG.gain.setTargetAtTime(L.inCockpit ? 0.85 : 1, now, 0.08);

    // player engine / wind: if the game stops calling setPlayerEngine, fade out
    const pe = this._pe;
    if (pe.called && now - pe.called > 0.5) { pe.called = 0; this._setPlayerEngine({ active: false, speed: 0 }); pe.called = 0; }
    // engines: if the game stops sending lists, fade everything out
    if (this._lastEngines >= 0 && now - this._lastEngines > 1.0) { this._lastEngines = -1; this._setEngines(null); }
    const kd = 1 - Math.exp(-dt / 0.08);
    for (let k = 0; k < ENGINE_POOL; k++) {
      const v = this._voices[k];
      if (v.state === 0) continue;
      if (v.state === 2 && now >= v.relEnd) { this._stopVoice(v); continue; }
      const age = clamp(now - v.t, 0, 0.5);
      const sp = this._spatial(v.x + v.vx * age, v.y + v.vy * age, v.z + v.vz * age);
      const d = Math.max(3, sp.d);
      // Doppler: u = unit vector listener -> source
      const vl = L.vx * sp.ux + L.vy * sp.uy + L.vz * sp.uz;
      const vs = v.vx * sp.ux + v.vy * sp.uy + v.vz * sp.uz;
      const dop = clamp((C + clamp(vl, -0.8 * C, 0.8 * C)) / Math.max(0.2 * C, C + clamp(vs, -0.8 * C, 0.8 * C)), 0.35, 2.6);
      v.dop = v.fresh ? dop : v.dop + (dop - v.dop) * kd;
      const T = v.T, E = v.E;
      const rate = rpmFactor(v.rpm) * E.hiRate * T.rate * (1 + v.rateOff) * v.dop;
      const gain = T.gain * E.comp * (0.45 + 0.55 * clamp(v.rpm, 0, 1.2)) * (45 / (45 + d));
      let cut = this._airCut(d) * T.cut * (0.55 + 0.45 * clamp(v.rpm, 0, 1));
      if (sp.front < 0) cut *= 1 + 0.45 * sp.front;          // muffled from behind
      cut = clamp(cut, 120, 20000);
      for (let i = 0; i < v.srcs.length; i++) {
        const r = rate * (i ? 1.013 : 1);
        if (v.fresh) v.srcs[i].playbackRate.setValueAtTime(r, now); else v.srcs[i].playbackRate.setTargetAtTime(r, now, 0.03);
      }
      if (v.fresh) {
        v.dist.gain.cancelScheduledValues(now); v.dist.gain.setValueAtTime(gain, now);
        v.pan.pan.cancelScheduledValues(now); v.pan.pan.setValueAtTime(sp.pan, now);
        v.lp.frequency.cancelScheduledValues(now); v.lp.frequency.setValueAtTime(cut, now);
        v.fresh = false;
      } else {
        v.dist.gain.setTargetAtTime(gain, now, 0.05);
        v.pan.pan.setTargetAtTime(sp.pan, now, 0.05);
        v.lp.frequency.setTargetAtTime(cut, now, 0.05);
      }
      // Ju 87 Jericho trumpet
      if (v.siren > 0.01 && v.state === 1) {
        if (!v.sir) this._buildSiren(v);
        const s = v.sir;
        s.wob += dt * (2 + 3 * RNG.next());
        const f = (230 + 620 * Math.pow(v.siren, 0.85)) * (1 + 0.012 * Math.sin(s.wob)) * v.dop;
        s.o1.frequency.setTargetAtTime(f, now, 0.05);
        s.o2.frequency.setTargetAtTime(f * 1.006, now, 0.05);
        s.o3.frequency.setTargetAtTime(f * 2.002, now, 0.05);
        s.bp.frequency.setTargetAtTime(clamp(f * 3.2, 400, 8000), now, 0.05);
        s.g.gain.setTargetAtTime(0.55 * Math.pow(v.siren, 0.7) / (T.gain * E.comp * 0.9), now, 0.08);
        v.sirenOffAt = 0;
      } else if (v.sir) {
        v.sir.g.gain.setTargetAtTime(0, now, 0.15);
        if (!v.sirenOffAt) v.sirenOffAt = now;
        else if (now - v.sirenOffAt > 1.5) this._killSiren(v);
      }
    }

    // falling-bomb whistles
    if (this._lastBombs >= 0 && now - this._lastBombs > 0.5) { this._lastBombs = -1; this._setBombs(null); }
    for (let k = 0; k < BOMB_VOICES; k++) {
      const v = this._bombV[k];
      if (v.state === 0) continue;
      if (v.state === 2) { if (now >= v.relEnd) this._stopBomb(v); continue; }
      const age = clamp(now - v.t, 0, 0.5), vy = v.vy - 9.81 * age;
      const sp = this._spatial(v.x + v.vx * age, v.y + v.vy * age - 4.9 * age * age, v.z + v.vz * age), d = Math.max(4, sp.d);
      const vl = L.vx * sp.ux + L.vy * sp.uy + L.vz * sp.uz;
      const vs = v.vx * sp.ux + vy * sp.uy + v.vz * sp.uz;
      const dop = clamp((C + clamp(vl, -0.8 * C, 0.8 * C)) / Math.max(0.2 * C, C + clamp(vs, -0.8 * C, 0.8 * C)), 0.4, 2.5);
      v.dop = v.fresh ? dop : v.dop + (dop - v.dop) * kd;
      const fall = v.fall + age, speed = Math.sqrt(v.vx * v.vx + vy * vy + v.vz * v.vz);
      const rate = clamp(this._whistleRate(fall) * v.dop, 0.25, 4);
      // louder as it picks up speed; fades in over the first seconds of the fall
      const gain = 0.75 * Math.pow(sat((speed - 40) / 160), 0.8) * sat(fall / 2) * (70 / (70 + d));
      let cut = this._airCut(d) * 1.4;
      if (sp.front < 0) cut *= 1 + 0.4 * sp.front;
      cut = clamp(cut, 250, 20000);
      if (v.fresh) {
        v.src.playbackRate.setValueAtTime(rate, now); v.g.gain.setTargetAtTime(gain, now, 0.05);
        v.pan.pan.setValueAtTime(sp.pan, now); v.lp.frequency.setValueAtTime(cut, now);
        v.fresh = false;
      } else {
        v.src.playbackRate.setTargetAtTime(rate, now, 0.04);
        v.g.gain.setTargetAtTime(gain, now, 0.05);
        v.pan.pan.setTargetAtTime(sp.pan, now, 0.05);
        v.lp.frequency.setTargetAtTime(cut, now, 0.05);
      }
    }

    // one-shots: keep panning listener-relative (sounds can arrive seconds after being emitted)
    for (let i = 0; i < ONESHOT_POOL; i++) {
      const ch = this._chains[i];
      if (!ch.positional || ch.end <= now) continue;
      const sp = this._spatial(ch.px, ch.py, ch.pz);
      if (now < ch.start) { ch.pan.pan.cancelScheduledValues(now); ch.pan.pan.setValueAtTime(sp.pan, ch.start); }
      else ch.pan.pan.setTargetAtTime(sp.pan, now, 0.04);
    }
  }

  // ------------------------------------------------------------------ one-shot voice pool
  _buildOneShots() {
    const c = this.ctx;
    this._chains = [];
    for (let i = 0; i < ONESHOT_POOL; i++) {
      const ch = { g: c.createGain(), lp: c.createBiquadFilter(), pan: makePanner(c), send: c.createGain(), bus: null, src: null, start: 0, end: 0, dur: 0, score: 0, positional: false, px: 0, py: 0, pz: 0 };
      ch.lp.type = 'lowpass'; ch.lp.Q.value = 0; ch.lp.frequency.value = 20000; ch.send.gain.value = 0;
      ch.g.connect(ch.lp); ch.lp.connect(ch.pan); ch.send.connect(this._revIn);
      this._chains.push(ch);
    }
  }
  _pick(arr) { return arr[(RNG.next() * arr.length) | 0]; }
  _trim(k) { return this.sampled && this.sampled[k] ? SFX_TRIM[k] || 1 : 1; }
  // buf, bus, gain, playbackRate, delay (s), pos (or null = in-head), pan, lowpass cutoff, reverb send, priority
  _play(buf, bus, gain, rate, delay, pos, pan, cut, send, prio) {
    // while suspended currentTime is frozen: queued shots would all fire together on resume
    if (this._muted || !buf || !(gain > 1e-4) || this.ctx.state !== 'running') return null;
    const c = this.ctx, now = c.currentTime;
    const start = now + 0.004 + clamp(fin(delay, 0), 0, 30);
    const dur = buf.duration / clamp(rate, 0.25, 4);
    const score = gain * prio;
    let ch = null, best = null, bestScore = Infinity;
    for (let i = 0; i < ONESHOT_POOL; i++) {
      const h = this._chains[i];
      if (h.end <= now) { ch = h; break; }
      const age = now - h.start;
      const s = h.score * (age < 0 ? 1 : Math.exp(-2 * age / Math.max(0.05, h.dur))) + (h.start > now ? 0.001 : 0);
      if (s < bestScore) { bestScore = s; best = h; }
    }
    let t0 = start;
    if (!ch) {
      if (!best || bestScore > score) return null; // everything playing is more important
      ch = best;
      // steal: quick fade of whatever is there, then start
      const g = ch.g.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.008);
      try { ch.src.stop(now + 0.01); } catch (e) { /* */ }
      t0 = Math.max(start, now + 0.012);
    }
    // drop automation left by the previous sound on this chain (delayed far sounds schedule filter/send changes)
    ch.lp.frequency.cancelScheduledValues(now); ch.send.gain.cancelScheduledValues(now);
    if (ch.bus !== bus) {
      try { ch.pan.disconnect(); } catch (e) { /* */ }
      ch.pan.connect(bus); ch.pan.connect(ch.send); ch.bus = bus;
    }
    const src = c.createBufferSource();
    src.buffer = buf; src.playbackRate.value = clamp(rate, 0.25, 4);
    src.connect(ch.g);
    ch.g.gain.setValueAtTime(gain, t0);
    ch.lp.frequency.setValueAtTime(clamp(cut, 60, 20000), t0);
    ch.send.gain.setValueAtTime(clamp(send, 0, 1), t0);
    ch.pan.pan.cancelScheduledValues(now);
    ch.pan.pan.setValueAtTime(clamp(pan, -1, 1), t0);
    src.start(t0);
    ch.src = src; ch.start = t0; ch.dur = dur; ch.end = t0 + dur + 0.02; ch.score = score;
    ch.positional = !!pos;
    if (pos) { ch.px = pos.x; ch.py = pos.y; ch.pz = pos.z; }
    return ch;
  }
  _pos(pos) {
    if (!pos || typeof pos !== 'object') return null;
    const x = fin(pos.x, NaN), y = fin(pos.y, NaN), z = fin(pos.z, NaN);
    if (x !== x || y !== y || z !== z) return null;
    const P = this._tmpPos || (this._tmpPos = { x: 0, y: 0, z: 0 });
    P.x = x; P.y = y; P.z = z;
    return P;
  }
  // positional one-shot: attenuation ref distance, cull distance
  _playAt(buf, bus, pos, gain, ref, maxD, rate, sendBase, prio, cutMul = 1) {
    const sp = this._spatial(pos.x, pos.y, pos.z);
    const d = sp.d;
    if (d > maxD) return null;
    const att = ref / (ref + d);
    let cut = this._airCut(d) * cutMul;
    if (sp.front < 0) cut *= 1 + 0.4 * sp.front;
    return this._play(buf, bus, gain * att, rate, d / C, pos, sp.pan, cut, clamp(sendBase + d / 4000, 0, 0.7), prio);
  }

  // ------------------------------------------------------------------ public one-shots
  gun(kind, pos, player) {
    if (!this._ok() || this._muted) return;
    try {
      const k = kind === 'cannon' || kind === 'hmg' ? kind : 'mg';
      const buf = this._pick(this.buf[k]);
      const lvl = (k === 'cannon' ? 1.0 : k === 'hmg' ? 0.8 : 0.62) * this._trim(k);
      if (player) {
        this._gunSide = -this._gunSide; // wing guns: alternate sides
        const rate = 1 + (RNG.next() - 0.5) * 0.09;
        this._play(buf, this.bus.playerGun, lvl * RNG.range(0.88, 1), rate, 0, null, this._gunSide * RNG.range(0.08, 0.3), 20000, k === 'cannon' ? 0.06 : 0.03, 4);
        // the guns dominate: duck the player's engine ~4 dB while firing, recover over ~0.5 s
        const now = this.ctx.currentTime, eg = this.bus.playerEngine.gain;
        eg.cancelScheduledValues(now); eg.setTargetAtTime(0.38, now, 0.03); eg.setTargetAtTime(0.6, now + 0.15, 0.2);
      } else {
        const p = this._pos(pos);
        if (!p) return;
        this._playAt(buf, this.bus.gun, p, lvl, 25, 2000, 1 + (RNG.next() - 0.5) * 0.12, 0.05, 1);
      }
    } catch (e) { this._fail(e); }
  }

  explosion(pos, size) {
    if (!this._ok() || this._muted) return;
    try {
      const p = this._pos(pos);
      if (!p) return;
      const sz = clamp(fin(size, 1), 0.1, 3);
      const sp = this._spatial(p.x, p.y, p.z), d = sp.d;
      if (d > 2500 + 3000 * sz) return;
      const S = this.sampled || {};
      // recordings: only a gentle pitch-down with size (they already sound big); synthesized: more
      const rate = RNG.range(0.94, 1.06) / (S.expClose ? Math.sqrt(0.8 + 0.2 * sz) : 0.75 + 0.25 * sz);
      const g = 0.35 + 0.45 * sz, ref = 30 + 50 * sz;
      const wClose = clamp(1 - (d - 120) / 650, 0, 1), wFar = clamp((d - 120) / 450, 0, 1);
      const prio = 2 + sz;
      const big = sz >= 1.9;   // bombs, fuel dumps, hangars: the big blast with the long rumble
      if (wClose > 0) this._playAt(this._pick(big ? this.buf.expBig : this.buf.expClose), this.bus.fx, p, g * wClose * this._trim(big ? 'expBig' : 'expClose'), ref, 1e9, rate, 0.12, prio);
      if (wFar > 0) this._playAt(this._pick(this.buf.expFar), this.bus.fx, p, g * wFar * 1.4 * this._trim('expFar'), ref * 1.5, 1e9, rate * RNG.range(0.92, 1.05), 0.25, prio, 0.7);
      if (sz >= 0.9) this._playAt(this.buf.sub[0], this.bus.fx, p, (sz - 0.7) * (S.expClose ? 0.4 : 0.55), ref * 3, 1e9, RNG.range(0.9, 1.05) / Math.sqrt(sz), 0, prio, 3);
    } catch (e) { this._fail(e); }
  }

  flak(pos) {
    if (!this._ok() || this._muted) return;
    try {
      const p = this._pos(pos);
      if (!p) return;
      this._playAt(this._pick(this.buf.flak), this.bus.fx, p, 0.9 * this._trim('flak'), 60, 7000, RNG.range(0.9, 1.1), 0.18, 2);
    } catch (e) { this._fail(e); }
  }

  impact(pos, kind) {
    if (!this._ok() || this._muted) return;
    try {
      const p = this._pos(pos);
      if (!p) return;
      const k = kind === 'ground' || kind === 'water' ? kind : 'metal';
      this._playAt(this._pick(this.buf[k]), this.bus.fx, p, (k === 'metal' ? 0.45 : 0.5) * this._trim(k), 10, 300, RNG.range(0.85, 1.2), 0.02, 0.5);
    } catch (e) { this._fail(e); }
  }

  playerHit(severity) {
    if (!this._ok() || this._muted) return;
    try {
      const s = sat(fin(severity, 0.5));
      const n = 1 + Math.round(s * 3 * RNG.next() + s);
      for (let i = 0; i < n; i++) {
        this._play(this._pick(this.buf.clang), this.bus.inHead, (0.35 + 0.5 * s) * RNG.range(0.6, 1) * this._trim('clang'), RNG.range(0.8, 1.25), i ? RNG.range(0.02, 0.15) : 0, null, RNG.range(-0.6, 0.6), 20000, 0.04, 3);
      }
      if (s > 0.55) this._play(this._pick(this.buf.crunch), this.bus.inHead, 0.3 + 0.4 * s, RNG.range(0.85, 1.1), 0.01, null, RNG.range(-0.3, 0.3), 20000, 0.05, 3);
    } catch (e) { this._fail(e); }
  }

  bombRelease() {
    if (!this._ok() || this._muted) return;
    try { this._play(this.buf.bomb[0], this.bus.inHead, 0.8, RNG.range(0.95, 1.05), 0, null, 0, 20000, 0.03, 3); } catch (e) { this._fail(e); }
  }

  // ------------------------------------------------------------------ radio voice
  // Pre-recorded R/T lines (audio/voice/<key>.mp3, see js/voicelines.js). Lines queue (max 3, stale
  // ones dropped), each opens with a squelch, and the world ducks ~5 dB while someone is talking.
  // onMissing() is called if the clip can't be loaded (the game then falls back to speechSynthesis).
  // urgent lines (the player's orders, wingmen) go ahead of queued controller announcements
  voice(key, onMissing, urgent = false) {
    if (!this._ok() || this._muted || !key) return;
    try {
      const Q = this._voiceQ = this._voiceQ || [];
      this._voiceBuf(key);   // start fetching now
      if (Q.length >= 3) { const i = Q.findIndex((q) => !q.urgent); Q.splice(i >= 0 ? i : 0, 1); }
      const item = { key, t: this.ctx.currentTime, onMissing, urgent };
      if (urgent) { const i = Q.findIndex((q) => !q.urgent); Q.splice(i >= 0 ? i : Q.length, 0, item); } else Q.push(item);
      this._pumpVoice();
    } catch (e) { this._fail(e); }
  }
  _voiceBuf(key) {
    const cache = this._voiceCache || (this._voiceCache = new Map());
    if (!cache.has(key)) {
      cache.set(key, fetch(new URL(`../audio/voice/${key}.mp3`, import.meta.url))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
        .then((b) => this.ctx.decodeAudioData(b))
        .catch(() => null));
    }
    return cache.get(key);
  }
  async _pumpVoice() {
    if (this._voiceBusy) return;
    const item = this._voiceQ && this._voiceQ.shift();
    if (!item) return;
    this._voiceBusy = true;
    let buf = null;
    try { buf = await this._voiceBuf(item.key); } catch (e) { /* */ }
    const c = this.ctx;
    if (!buf || this._muted || c.currentTime - item.t > 8 || c.state !== 'running') {
      this._voiceBusy = false;
      if (!buf && item.onMissing) item.onMissing();
      this._pumpVoice();
      return;
    }
    const now = c.currentTime, t0 = now + 0.14, end = t0 + buf.duration;
    this.radio();
    const src = c.createBufferSource();
    src.buffer = buf; src.connect(this._voiceBus); src.start(t0);
    const d = this._duck.gain;
    d.cancelScheduledValues(now); d.setTargetAtTime(0.55, now, 0.08); d.setTargetAtTime(1, end, 0.3);
    src.onended = () => {
      try { src.disconnect(); } catch (e) { /* */ }
      if (!this._muted) this._play(this._pick(this.buf.radio), this.bus.ui, 0.3, 1.1, 0, null, 0, 20000, 0, 3);   // release squelch
      setTimeout(() => { this._voiceBusy = false; this._pumpVoice(); }, 350);
    };
  }

  radio() {
    if (!this._ok() || this._muted) return;
    try { this._play(this._pick(this.buf.radio), this.bus.ui, 0.55, RNG.range(0.96, 1.04), 0, null, 0, 20000, 0, 3); } catch (e) { this._fail(e); }
  }

  ui(kind) {
    if (!this._ok() || this._muted) return;
    try {
      const b = this.buf;
      switch (kind) {
        case 'click': this._play(b.click[0], this.bus.ui, 0.6, 1, 0, null, 0, 20000, 0, 5); break;
        case 'select': this._play(b.select[0], this.bus.ui, 0.55, 1, 0, null, 0, 20000, 0.05, 5); break;
        case 'kill': this._play(b.kill[0], this.bus.ui, 0.75, 1, 0, null, 0, 20000, 0.12, 5); break;
        case 'warn': this._play(b.warn[0], this.bus.ui, 0.6, 1, 0, null, 0, 20000, 0, 5); break;
        case 'start': this._fanfare('start'); break;
        case 'victory': this._fanfare('victory'); break;
        case 'defeat': this._fanfare('defeat'); break;
        default: break;
      }
    } catch (e) { this._fail(e); }
  }

  // live-synth brass: detuned saws through an enveloped lowpass
  _brass(t0, f, dur, vel, bright) {
    const c = this.ctx;
    const o1 = c.createOscillator(), o2 = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
    o1.type = o2.type = 'sawtooth';
    o1.frequency.value = f; o2.frequency.value = f; o1.detune.value = -7; o2.detune.value = 8;
    lp.type = 'lowpass'; lp.Q.value = 2;
    const top = Math.min(14000, f * bright);
    lp.frequency.setValueAtTime(Math.min(14000, f * 1.2), t0);
    lp.frequency.exponentialRampToValueAtTime(top, t0 + 0.06);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.5, top * 0.45), t0 + 0.06 + dur * 0.8);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vel, t0 + 0.035);
    g.gain.setTargetAtTime(vel * 0.7, t0 + 0.035, 0.2);
    g.gain.setTargetAtTime(0, t0 + dur, 0.07);
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(this.bus.ui); g.connect(this._fanSend);
    o1.start(t0); o2.start(t0); o1.stop(t0 + dur + 0.6); o2.stop(t0 + dur + 0.6);
  }
  _fanfare(kind) {
    const c = this.ctx, t = c.currentTime + 0.02;
    if (!this._fanSend) { this._fanSend = c.createGain(); this._fanSend.gain.value = 0.25; this._fanSend.connect(this._revIn); }
    const N = { A2: 110, D3: 146.83, F3: 174.61, A3: 220, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, Bb3: 233.08, G3: 196 };
    const chord = (t0, notes, dur, vel, br) => { for (const n of notes) this._brass(t0, N[n], dur, vel, br); };
    if (kind === 'start') {
      chord(t, ['G3', 'D4', 'G4'], 0.09, 0.13, 6);
      chord(t + 0.12, ['C4', 'G4', 'C5', 'E5'], 0.55, 0.14, 7);
    } else if (kind === 'victory') {
      chord(t, ['G4', 'D4'], 0.11, 0.16, 6);
      chord(t + 0.15, ['G4', 'D4'], 0.11, 0.16, 6);
      chord(t + 0.3, ['G4', 'D4'], 0.11, 0.16, 6);
      chord(t + 0.45, ['C4', 'G4', 'C5', 'E5'], 0.5, 0.15, 7);
      chord(t + 1.0, ['D4', 'A4', 'D5'], 0.2, 0.14, 7);
      chord(t + 1.25, ['C4', 'E4', 'G4', 'C5', 'G5'], 1.3, 0.14, 8);
    } else {
      chord(t, ['A3', 'C4', 'E4'], 0.9, 0.11, 3);
      chord(t + 0.95, ['F3', 'A3', 'C4'], 0.9, 0.11, 3);
      chord(t + 1.9, ['D3', 'F3', 'A3'], 0.7, 0.11, 2.6);
      chord(t + 2.65, ['A2', 'E4', 'A3', 'C4'], 2.0, 0.11, 2.2);
    }
  }

  // ------------------------------------------------------------------ British air-raid siren
  _buildRaidSiren() {
    const c = this.ctx, now = c.currentTime;
    // rotor tone: odd-heavy harmonic series (ported rotor/stator chops air into near-square pulses)
    const H = 16, re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    for (let k = 1; k <= H; k++) im[k] = (k % 2 ? 1 : 0.35) / Math.pow(k, 1.1);
    const tone = c.createPeriodicWave(re, im);
    // wail LFO: 5 s period, rising for 40%, falling for 60% (shape built from Fourier series)
    const M = 256, K = 12, lre = new Float32Array(K + 1), lim = new Float32Array(K + 1), shape = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const p = i / M;
      const v = p < 0.4 ? 0.5 - 0.5 * Math.cos(Math.PI * p / 0.4) : 0.5 + 0.5 * Math.cos(Math.PI * (p - 0.4) / 0.6);
      shape[i] = v * 2 - 1;
    }
    for (let k = 1; k <= K; k++) {
      let a = 0, b = 0;
      for (let i = 0; i < M; i++) { a += shape[i] * Math.cos(TAU * k * i / M); b += shape[i] * Math.sin(TAU * k * i / M); }
      lre[k] = 2 * a / M; lim[k] = 2 * b / M;
    }
    const wail = c.createPeriodicWave(lre, lim, { disableNormalization: true });
    const lfo = c.createOscillator(); lfo.setPeriodicWave(wail); lfo.frequency.value = 0.2;
    const s = this._raid = { rotors: [], depths: [], on: false };
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600; lp.Q.value = 0;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150;
    const trem = c.createGain(); trem.gain.value = 0.72;                   // rotating horn sweep + louder at the top of the wail
    const tl = c.createOscillator(); tl.frequency.value = 0.13; const tg = c.createGain(); tg.gain.value = 0.18; tl.connect(tg); tg.connect(trem.gain);
    const wg = c.createGain(); wg.gain.value = 0.12; lfo.connect(wg); wg.connect(trem.gain);
    const onoff = c.createGain(); onoff.gain.value = 0;
    const centres = [330, 330 * 1.19], depth = 115;
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator(); o.setPeriodicWave(tone); o.frequency.value = 50;
      const dg = c.createGain(); dg.gain.value = 0; lfo.connect(dg); dg.connect(o.frequency);
      const og = c.createGain(); og.gain.value = i ? 0.38 : 0.5;
      o.connect(og); og.connect(lp); o.start(now);
      s.rotors.push(o); s.depths.push({ g: dg, d: depth * (i ? 1.19 : 1), c: centres[i] });
    }
    lp.connect(hp); hp.connect(trem); trem.connect(onoff); onoff.connect(this.bus.siren);
    // distance: slap echo off the hangars + big reverb send
    const dl = c.createDelay(1); dl.delayTime.value = 0.31; const fb = c.createGain(); fb.gain.value = 0.32;
    const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 1100;
    const dOut = c.createGain(); dOut.gain.value = 0.45;
    onoff.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(dOut); dOut.connect(this.bus.siren);
    const send = c.createGain(); send.gain.value = 0.9; onoff.connect(send); send.connect(this._revIn);
    lfo.start(now); tl.start(now);
    s.onoff = onoff;
  }
  // recorded siren (a real British wail, one cycle looped): same distance treatment as the synthesized one;
  // the playback rate ramps like the rotor spinning up / down
  _buildRecSiren() {
    const c = this.ctx, now = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.buf.sirenLoop[0]; src.loop = true; src.playbackRate.value = 0.5;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0;
    const onoff = c.createGain(); onoff.gain.value = 0;
    src.connect(lp); lp.connect(onoff); onoff.connect(this.bus.siren);
    const dl = c.createDelay(1); dl.delayTime.value = 0.31; const fb = c.createGain(); fb.gain.value = 0.3;
    const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 1100;
    const dOut = c.createGain(); dOut.gain.value = 0.4;
    onoff.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(dOut); dOut.connect(this.bus.siren);
    const send = c.createGain(); send.gain.value = 0.8; onoff.connect(send); send.connect(this._revIn);
    src.start(now, RNG.next() * src.buffer.duration);
    this._raid = { rec: true, src, onoff, on: false };
  }
  siren(on) {
    this._sirenWanted = !!on;
    if (!this._ok()) return;
    try {
      if (!this._raid) { if (!on) return; if (this.sampled && this.sampled.sirenLoop) this._buildRecSiren(); else this._buildRaidSiren(); }
      const s = this._raid, now = this.ctx.currentTime;
      if (s.on === !!on) return;
      s.on = !!on;
      if (s.rec) {
        const r = s.src.playbackRate, g = s.onoff.gain;
        r.cancelScheduledValues(now); r.setValueAtTime(r.value, now);
        g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
        if (on) { r.setTargetAtTime(1, now, 0.7); g.setTargetAtTime(1.25, now, 0.6); }   // ~2 s spin-up / fade-in
        else { r.setTargetAtTime(0.4, now, 1.6); g.setTargetAtTime(0, now, 0.7); }   // spin-down / fade-out
        return;
      }
      for (let i = 0; i < 2; i++) {
        const f = s.rotors[i].frequency, D = s.depths[i];
        f.cancelScheduledValues(now); f.setValueAtTime(f.value, now);
        D.g.gain.cancelScheduledValues(now); D.g.gain.setValueAtTime(D.g.gain.value, now);
        if (on) { f.setTargetAtTime(D.c, now, 0.9); D.g.gain.setTargetAtTime(D.d, now, 1.2); }   // motor spin-up
        else { f.setTargetAtTime(D.c * 0.25, now, 1.6); D.g.gain.setTargetAtTime(0, now, 1.5); } // spin-down
      }
      const g = s.onoff.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
      g.setTargetAtTime(on ? 1 : 0, now, on ? 0.6 : 0.7);
    } catch (e) { this._fail(e); }
  }

  // ------------------------------------------------------------------ debug (test page)
  debugInfo() {
    if (!this._ready) return null;
    const list = [];
    const add = (name, b) => {
      const d = b.getChannelData(0); let p = 0, s = 0;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; s += d[i] * d[i]; }
      list.push({ name, dur: +b.duration.toFixed(3), peak: +p.toFixed(4), rms: +Math.sqrt(s / d.length).toFixed(4) });
    };
    for (const k of Object.keys(this.eng)) { add(k + '.hi', this.eng[k].hi); add(k + '.lo', this.eng[k].lo); }
    for (const k of Object.keys(this.buf)) this.buf[k].forEach((b, i) => add(k + i, b));
    return {
      synthMs: +this.synthMs.toFixed(1), sampleRate: this.ctx.sampleRate, state: this.ctx.state, buffers: list,
      activeVoices: this._voices.filter((v) => v.state === 1).map((v) => v.id),
      bombWhistles: this._bombV.filter((v) => v.state !== 0).length,
      sampled: Object.assign({}, this.sampled),
      busyOneShots: this._chains.filter((c) => c.end > this.ctx.currentTime).length,
    };
  }
}
