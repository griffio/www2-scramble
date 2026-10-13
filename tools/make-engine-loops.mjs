// Builds the engine loops in audio/ from real recordings on Freesound (needs ffmpeg).
//   node tools/make-engine-loops.mjs
// Each loop: cut a steady stretch, high-pass + low-shelf boost + gentle compression (more roar),
// equal-power crossfade of the tail into the head (seamless loop), normalise, 16-bit mono WAV.
// WAV rather than MP3/AAC: compressed formats pad the start/end and click when looped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOURCES = {
  merlin: {
    url: 'https://cdn.freesound.org/previews/276/276597_1149179-hq.mp3',
    page: 'https://freesound.org/people/squashy555/sounds/276597/',
    credit: '"merlin engine.wav" by squashy555 (Rolls-Royce Merlin from a Spitfire, static engine run) - CC0',
  },
  db605: {
    url: 'https://cdn.freesound.org/previews/142/142898_2579915-hq.mp3',
    page: 'https://freesound.org/people/Fight2FlyPhoto/sounds/142898/',
    credit: '"Bf-109 - Daimler-Benz Run-Up" by Fight2FlyPhoto - CC BY 3.0',
  },
};
// [output name, source, start (s), loop length (s)] - picked from the loudness envelopes:
// steady idle and the steadiest full-power stretches of each run-up
const LOOPS = [
  ['merlin_idle', 'merlin', 170.4, 7.5],
  ['merlin_power', 'merlin', 116.1, 3.6],
  ['merlin_power2', 'merlin', 189.1, 3.4],
  ['db605_idle', 'db605', 6.0, 8.0],
  ['db605_power', 'db605', 40.0, 10.0],
];
const XF = 0.3, SR = 44100;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'audio');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-'));

for (const [k, s] of Object.entries(SOURCES)) {
  const f = path.join(tmp, k + '.mp3');
  console.log('downloading', s.page);
  execFileSync('curl', ['-sfL', '-m', '300', '-o', f, s.url]);
  s.file = f;
}
for (const [name, src, t, len] of LOOPS) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-t', String(len + XF), '-i', SOURCES[src].file, '-ac', '1', '-ar', String(SR),
    '-af', 'highpass=f=28,bass=g=4:f=110:w=0.8,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=150:makeup=1.5', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length >> 2);
  const N = Math.round(len * SR), X = Math.round(XF * SR);
  const y = new Float32Array(N);
  for (let i = 0; i < N; i++) y[i] = x[i];
  // the stretch after the loop end fades out over the loop start (equal power)
  for (let i = 0; i < X; i++) { const a = i / X; y[i] = x[i] * Math.sin(a * Math.PI / 2) + x[N + i] * Math.cos(a * Math.PI / 2); }
  let pk = 0, e = 0;
  for (const v of y) { pk = Math.max(pk, Math.abs(v)); e += v * v; }
  const g = 0.95 / pk;
  const wav = Buffer.alloc(44 + N * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, y[i] * g)) * 32767), 44 + i * 2);
  fs.writeFileSync(path.join(outDir, name + '.wav'), wav);
  console.log(`${name}.wav  ${len}s  rms ${(Math.sqrt(e / N) * g).toFixed(3)}`);
}
// rewrite only the engine section of CREDITS.txt; keep the sound-effects section (tools/make-sfx.mjs)
const credF = path.join(outDir, 'CREDITS.txt'), MARK = 'Sound effects in audio/sfx/';
const old = fs.existsSync(credF) ? fs.readFileSync(credF, 'utf8') : '';
fs.writeFileSync(credF, 'Engine loops cut from these recordings on freesound.org (see tools/make-engine-loops.mjs):\n\n' +
  Object.values(SOURCES).map((s) => `${s.credit}\n  ${s.page}`).join('\n') + '\n' + (old.includes(MARK) ? '\n' + old.slice(old.indexOf(MARK)) : ''));
fs.rmSync(tmp, { recursive: true, force: true });
