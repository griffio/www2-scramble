// Builds the sound effects in audio/sfx/ from real recordings on Freesound (needs ffmpeg).
//   node tools/make-sfx.mjs
// Each effect is cut from a CC0 / CC BY recording (public HQ preview MP3), processed with ffmpeg
// (high-pass, EQ, light compression), given a short fade-in / fade-out, peak-normalised to -1 dBFS and
// written as a 16-bit mono 44.1 kHz WAV (WAV, not MP3: compressed formats pad the start, which would
// smear gun attacks and click when looped). Start times / lengths were picked from loudness envelopes
// (shot onsets, decay times, gaps) of each recording. The air-raid siren is a seamless loop (equal-power
// tail->head crossfade, as in make-engine-loops.mjs); the bomb whistle is flattened to a constant pitch
// (time-varying resampling along its measured glide) and looped, so the game can drive its pitch.
// Also rewrites the sound-effects section of audio/CREDITS.txt (the engine credits are kept).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BY4 = 'CC BY 4.0', CC0 = 'CC0';
const SOURCES = {
  autocannon: { id: 854186, user: 'qubodup', uid: 71257, title: 'Autocannon Three Shot Burst', lic: CC0 },
  avenger50: { id: 160355, user: 'qubodup', uid: 71257, title: 'Air Defense Artillery Avenger Training .50cal (tH4YBTw8vk8).flac', lic: CC0, note: 'US Army training video, public domain' },
  mgburst: { id: 482122, user: 'qubodup', uid: 71257, title: 'Clean Machine Gun Burst', lic: CC0, note: 'US military video, public domain' },
  nearExp: { id: 108641, user: 'juskiddink', uid: 649468, title: 'Nearby explosion with debris.wav', lic: BY4 },
  pdExp: { id: 182429, user: 'qubodup', uid: 71257, title: 'Explosion', lic: CC0, note: 'US government video, public domain' },
  mortarShell: { id: 554289, user: 'klankbeeld', uid: 1648170, title: 'mortar  grenade shell 006.wav', lic: BY4 },
  bigBomb: { id: 665092, user: 'tgerginov', uid: 4898018, title: 'Explosion', lic: CC0 },
  forestBlast: { id: 530163, user: 'wyskoj', uid: 8338966, title: 'Heavy explosion in forest debris tree falling.flac', lic: CC0 },
  distantExp: { id: 108640, user: 'juskiddink', uid: 649468, title: 'Distant explosion.wav', lic: BY4 },
  quarry: { id: 82682, user: 'juskiddink', uid: 649468, title: 'Quarry blasting.wav', lic: BY4 },
  airBurst: { id: 871382, user: 'KVV_Audio', uid: 12846320, title: 'EXPLReal_Air Explosion Medium Distance_KVV AUDIO_FREE', lic: BY4 },
  mortarBomb: { id: 840902, user: 'klankbeeld', uid: 1648170, title: 'mortar bomb fireworks New Year Netherlands 918 pm 251231_0059', lic: BY4 },
  metalHit: { id: 182263, user: 'martian', uid: 84709, title: 'Foley bullet hit metal 02.wav', lic: CC0 },
  planeHit: { id: 116645, user: 'Woodingp', uid: 596857, title: 'bullets hit EDIT.aif', lic: CC0 },
  dirtHit: { id: 675944, user: 'craigsmith', uid: 2524442, title: 'S20-47 50 cal Browning machine gun bullet impacts.wav', lic: CC0 },
  dirtThud: { id: 319229, user: 'worthahep88', uid: 3443504, title: 'Single Rock hit dirt 2.wav', lic: CC0 },
  waterHit: { id: 675947, user: 'craigsmith', uid: 2524442, title: 'S31-17 Bullets hitting water.wav', lic: CC0 },
  siren: { id: 336640, user: 'audiojacked', uid: 3281519, title: 'Alarm, Air Raid Siren, Test, Devonport, Sony PCM M-10.wav', lic: CC0 },
  whistle: { id: 434739, user: 'SvennSound', uid: 5106556, title: 'Whizzbang Drop.mp3', lic: CC0 },
};
for (const s of Object.values(SOURCES)) {
  s.page = `https://freesound.org/people/${s.user}/sounds/${s.id}/`;
  s.url = `https://cdn.freesound.org/previews/${Math.floor(s.id / 1000)}/${s.id}_${s.uid}-hq.mp3`;
}

// ffmpeg filter chains per class (applied to each cut after a 2 ms fade-in)
const AF = {
  // 20 mm cannon: weight in the low end ("boom"), compression brings up the body after the crack
  cannon: 'highpass=f=32,bass=g=6:f=100:w=0.9,acompressor=threshold=-18dB:ratio=3:attack=4:release=60:makeup=1.5',
  hmg: 'highpass=f=45,bass=g=3:f=120:w=0.9,acompressor=threshold=-18dB:ratio=3:attack=3:release=45:makeup=1.5',
  mg: 'highpass=f=70,acompressor=threshold=-18dB:ratio=2.5:attack=2:release=40:makeup=1.3',
  boom: 'highpass=f=24,acompressor=threshold=-22dB:ratio=2.5:attack=12:release=300:makeup=1.6',
  far: 'highpass=f=22,lowpass=f=2400,acompressor=threshold=-24dB:ratio=2.5:attack=20:release=400:makeup=1.6',
  flak: 'highpass=f=30,bass=g=3:f=90:w=1,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=250:makeup=1.5',
  metal: 'highpass=f=180,acompressor=threshold=-20dB:ratio=2:attack=2:release=80:makeup=1.2',
  clang: 'highpass=f=90,acompressor=threshold=-20dB:ratio=2:attack=3:release=120:makeup=1.2',
  ground: 'highpass=f=55',
  water: 'highpass=f=110',
  siren: 'highpass=f=150,lowpass=f=5000',
  whistle: 'highpass=f=900',
};
// [output name, source, start (s), length (s), filter, fade-out (s)]
const CUTS = [
  // single shots: onset - ~3 ms, up to just before the next round (tails 60..300 ms)
  ['cannon_1', 'autocannon', 0.0, 0.272, 'cannon', 0.12],
  ['cannon_2', 'autocannon', 0.279, 0.265, 'cannon', 0.12],
  ['cannon_3', 'autocannon', 0.555, 0.290, 'cannon', 0.14],
  ['hmg_1', 'avenger50', 0.630, 0.088, 'hmg', 0.03],
  ['hmg_2', 'avenger50', 0.722, 0.088, 'hmg', 0.03],
  ['hmg_3', 'avenger50', 1.163, 0.068, 'hmg', 0.025],
  ['hmg_4', 'avenger50', 1.701, 0.065, 'hmg', 0.025],
  ['hmg_5', 'avenger50', 2.278, 0.115, 'hmg', 0.05],
  ['mg_1', 'mgburst', 0.110, 0.085, 'mg', 0.03],
  ['mg_2', 'mgburst', 0.376, 0.086, 'mg', 0.03],
  ['mg_3', 'mgburst', 0.639, 0.084, 'mg', 0.03],
  ['mg_4', 'mgburst', 0.905, 0.083, 'mg', 0.03],
  ['mg_5', 'mgburst', 1.166, 0.086, 'mg', 0.03],
  // explosions
  ['exp_close_1', 'nearExp', 0.07, 3.3, 'boom', 1.2],
  ['exp_close_2', 'pdExp', 0.0, 2.0, 'boom', 0.6],
  ['exp_close_3', 'mortarShell', 0.0, 2.2, 'boom', 0.8],
  ['exp_big_1', 'bigBomb', 0.02, 3.9, 'boom', 1.4],
  ['exp_big_2', 'forestBlast', 0.0, 3.2, 'boom', 1.4],
  ['exp_far_1', 'distantExp', 0.13, 3.7, 'far', 1.2],
  ['exp_far_2', 'quarry', 3.82, 3.0, 'far', 1.0],
  ['exp_far_3', 'quarry', 6.86, 3.4, 'far', 1.2],
  ['flak_1', 'airBurst', 0.0, 3.0, 'flak', 1.2],
  ['flak_2', 'mortarBomb', 0.02, 2.0, 'flak', 0.9],
  ['flak_3', 'mortarShell', 0.0, 1.8, 'flak', 0.7],
  // bullet impacts
  ['hit_metal_1', 'metalHit', 4.468, 0.26, 'metal', 0.1],
  ['hit_metal_2', 'metalHit', 7.298, 0.22, 'metal', 0.08],
  ['hit_metal_3', 'metalHit', 10.584, 0.26, 'metal', 0.1],
  ['hit_metal_4', 'metalHit', 12.437, 0.26, 'metal', 0.1],
  ['hit_plane_1', 'planeHit', 0.675, 0.32, 'clang', 0.12],
  ['hit_plane_2', 'planeHit', 3.428, 0.30, 'clang', 0.12],
  ['hit_plane_3', 'planeHit', 5.900, 0.40, 'clang', 0.15],
  ['hit_plane_4', 'planeHit', 7.434, 0.25, 'clang', 0.1],
  ['hit_ground_1', 'dirtHit', 0.854, 0.17, 'ground', 0.07],
  ['hit_ground_2', 'dirtHit', 1.155, 0.13, 'ground', 0.05],
  ['hit_ground_3', 'dirtHit', 1.290, 0.17, 'ground', 0.07],
  ['hit_ground_4', 'dirtThud', 0.333, 0.30, 'ground', 0.12],
  ['hit_water_1', 'waterHit', 0.952, 0.44, 'water', 0.15],
  ['hit_water_2', 'waterHit', 2.795, 0.30, 'water', 0.1],
  ['hit_water_3', 'waterHit', 4.240, 0.33, 'water', 0.12],
  ['hit_water_4', 'waterHit', 6.913, 0.40, 'water', 0.15],
];
// Air-raid siren: one full wail cycle (trough -> trough, matched pitch 447 Hz), crossfaded into itself
const SIREN = { name: 'siren_loop', src: 'siren', start: 23.3, len: 11.75, xf: 0.5 };
// Bomb whistle: measured glide f(t) = f0 * exp(-k (t - t0)) between t0 and t1; flattened to WHISTLE_HZ
const WHISTLE_HZ = 3000;
const WHISTLE = { name: 'bomb_whistle', src: 'whistle', t0: 0.75, t1: 6.3, f0: 4080, k: 0.114, xf: 0.3 };

const SR = 44100, PEAK = 0.891; // -1 dBFS
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'audio', 'sfx');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));

const decode = (file, af) => {
  const args = ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR)];
  if (af) args.push('-af', af);
  const raw = execFileSync('ffmpeg', [...args, '-f', 'f32le', '-'], { maxBuffer: 1 << 29 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
};
// run an ffmpeg filter chain over a float buffer
const filter = (x, af) => {
  const inF = path.join(tmp, 'in.f32');
  fs.writeFileSync(inF, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', inF, '-af', af, '-f', 'f32le', '-'], { maxBuffer: 1 << 29 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
};
const fadeIn = (y, sec) => { const m = Math.min(y.length, Math.round(sec * SR)); for (let i = 0; i < m; i++) y[i] *= Math.sin((i / m) * Math.PI / 2) ** 2; };
const fadeOut = (y, sec) => { const m = Math.min(y.length, Math.round(sec * SR)); for (let i = 0; i < m; i++) y[y.length - 1 - i] *= Math.sin((i / m) * Math.PI / 2) ** 2; };
const peak = (y) => { let p = 0; for (const v of y) p = Math.max(p, Math.abs(v)); return p; };
function writeWav(name, y) {
  const N = y.length, g = PEAK / (peak(y) || 1);
  const wav = Buffer.alloc(44 + N * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(N * 2, 40);
  let e = 0;
  for (let i = 0; i < N; i++) { const v = Math.max(-1, Math.min(1, y[i] * g)); e += v * v; wav.writeInt16LE(Math.round(v * 32767), 44 + i * 2); }
  fs.writeFileSync(path.join(outDir, name + '.wav'), wav);
  console.log(`${(name + '.wav').padEnd(20)} ${(N / SR).toFixed(3)}s  rms ${(10 * Math.log10(e / N)).toFixed(1)} dB  ${(wav.length / 1024).toFixed(0)} KB`);
  return wav.length;
}
// equal-power crossfade of the stretch after the loop end into the loop start
function loopXF(x, N, X) {
  const y = x.slice(0, N);
  for (let i = 0; i < X; i++) { const a = i / X; y[i] = x[i] * Math.sin(a * Math.PI / 2) + x[N + i] * Math.cos(a * Math.PI / 2); }
  return y;
}

// download
const used = new Set([...CUTS.map((c) => c[1]), SIREN.src, WHISTLE.src]);
const pcm = {};
for (const k of used) {
  const s = SOURCES[k], f = path.join(tmp, k + '.mp3');
  console.log('downloading', s.page);
  execFileSync('curl', ['-sfL', '--retry', '4', '--retry-delay', '5', '-m', '300', '-o', f, s.url]);
  pcm[k] = decode(f);
}
// all downloads succeeded: now clear stale variants (a failed download leaves the old files in place)
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.wav')) fs.rmSync(path.join(outDir, f));
let total = 0;
// Short cuts are aligned to the actual attack: the steepest 2 ms energy rise within -15..+30 ms of the
// given start; the cut then starts 3 ms before it (the end stays where it was).
function align(x, t) {
  const fr = SR / 1000, a = Math.max(0, Math.round((t - 0.015) * SR)), nF = 45, e = [];
  for (let k = 0; k < nF; k++) { let s = 1e-12; for (let i = a + k * fr; i < a + (k + 1) * fr; i++) s += (x[i] || 0) ** 2; e.push(10 * Math.log10(s)); }
  let best = 2, bd = -1e9;
  for (let k = 2; k < nF; k++) if (e[k] - e[k - 2] > bd) { bd = e[k] - e[k - 2]; best = k; }
  return Math.max(0, (a + (best - 2) * fr) / SR - 0.003);
}
for (const [name, src, t, len, af, fo] of CUTS) {
  const x = pcm[src], t1 = len < 0.5 ? align(x, t) : t, s0 = Math.round(t1 * SR);
  const y = x.slice(s0, s0 + Math.round((t + len - t1) * SR));
  fadeIn(y, 0.002);
  const z = filter(y, AF[af]).slice(0, y.length);
  fadeOut(z, fo);
  total += writeWav(name, z);
}
{ // siren loop
  const { name, src, start, len, xf } = SIREN, x = pcm[src], s0 = Math.round(start * SR);
  const N = Math.round(len * SR), X = Math.round(xf * SR);
  const z = filter(x.slice(s0, s0 + N + X), AF.siren);
  total += writeWav(name, loopXF(z, N, X));
}
{ // bomb whistle: read the recording along its pitch glide so the output pitch is constant, even out the
  // level with a slow AGC, then loop it
  const { name, src, t0, t1, f0, k, xf } = WHISTLE, x = filter(pcm[src], AF.whistle);
  const out = [];
  for (let p = t0 * SR; p < t1 * SR - 2;) {
    const i = Math.floor(p), u = p - i, a = x[i - 1] || 0, b = x[i], c = x[i + 1], d = x[i + 2];
    out.push(b + 0.5 * u * (c - a + u * (2 * a - 5 * b + 4 * c - d + u * (3 * (b - c) + d - a)))); // cubic Hermite
    p += WHISTLE_HZ / (f0 * Math.exp(-k * (p / SR - t0)));
  }
  const y = Float32Array.from(out), W = Math.round(0.15 * SR);
  const env = new Float32Array(y.length);
  let acc = 0, cnt = 0;
  for (let i = 0; i < y.length + W; i++) {
    if (i < y.length) { acc += y[i] * y[i]; cnt++; }
    if (i >= 2 * W) { acc -= y[i - 2 * W] * y[i - 2 * W]; cnt--; }
    if (i >= W) env[i - W] = Math.sqrt(Math.max(acc, 1e-12) / cnt);
  }
  for (let i = 0; i < y.length; i++) y[i] /= Math.max(env[i], 1e-4);
  const X = Math.round(xf * SR);
  total += writeWav(name, loopXF(y, y.length - X, X));
}
console.log(`total ${(total / 1048576).toFixed(2)} MB`);

// credits: keep the engine section of audio/CREDITS.txt, rewrite the sound-effects section
const credF = path.join(root, 'audio', 'CREDITS.txt'), MARK = 'Sound effects in audio/sfx/';
let cred = fs.existsSync(credF) ? fs.readFileSync(credF, 'utf8') : '';
// the AI-generated section (tools/make-ai-sfx.mjs) at the end is kept
const AI_MARK = 'AI-generated sound effects', aiCred = cred.includes(AI_MARK) ? cred.slice(cred.indexOf(AI_MARK)) : '';
if (cred.includes(MARK)) cred = cred.slice(0, cred.indexOf(MARK));
cred = cred.replace(/\s*$/, '\n\n');
const licUrl = (l) => (l === CC0 ? 'https://creativecommons.org/publicdomain/zero/1.0/' : 'https://creativecommons.org/licenses/by/4.0/');
cred += `${MARK} were cut from these recordings on freesound.org (see tools/make-sfx.mjs).\n` +
  'Changes: segments cut out, filtered / EQ-ed, compressed, faded and normalised; the siren is looped and the bomb\n' +
  'whistle flattened to a constant pitch and looped.\n\n' +
  [...used].map((k) => {
    const s = SOURCES[k], files = CUTS.filter((c) => c[1] === k).map((c) => c[0]);
    if (k === SIREN.src) files.push(SIREN.name);
    if (k === WHISTLE.src) files.push(WHISTLE.name);
    return `"${s.title}" by ${s.user} - ${s.lic}${s.note ? ` (${s.note})` : ''}\n  ${s.page}\n  licence: ${licUrl(s.lic)}\n  used for: ${files.join(', ')}`;
  }).join('\n') + '\n';
fs.writeFileSync(credF, aiCred ? cred.replace(/\s*$/, '\n\n') + aiCred : cred);
fs.rmSync(tmp, { recursive: true, force: true });
