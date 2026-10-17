// Generates sound effects with the ElevenLabs text-to-sound-effects API and builds them into audio/.
//   node tools/make-ai-sfx.mjs gen [job...]   request candidates (cached in tools/ai-sfx/, never re-billed)
//   node tools/make-ai-sfx.mjs build          cut / loop / normalise the picked candidates into audio/
// Needs ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) in the environment or in .env, and ffmpeg for `build`.
// Candidates are requested as raw PCM (stereo, 16-bit little-endian, 44.1 kHz): compressed formats pad the
// start and click when looped. Billing: 11 credits per second of requested duration.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cache = path.join(root, 'tools', 'ai-sfx');
const SR = 44100, PEAK = 0.891; // -1 dBFS

// [job, candidates, duration (s), loop, prompt influence, prompt]
const NO = 'No music, no voices.';
const JOBS = {
  bmw801_power: [4, 8, true, 0.6, `Close recording of a WWII Focke-Wulf Fw 190 BMW 801 fourteen-cylinder radial aircraft engine running at full power at a constant RPM: deep, throaty, rough rumbling radial engine roar with uneven firing and a cooling-fan whine. Steady, no change in pitch or volume. ${NO}`],
  bmw801_idle: [4, 8, true, 0.6, `Close recording of a WWII Focke-Wulf Fw 190 BMW 801 fourteen-cylinder radial aircraft engine idling at a constant low RPM: lumpy, loping, popping radial engine idle. Steady, no change in pitch or volume. ${NO}`],
  flyby_fighter: [4, 4, false, 0.55, `A WWII single-engine piston fighter plane flies past very fast and very low, right overhead: rising V12 engine roar, a loud whoosh as it passes, then the Doppler pitch drop as it races away. ${NO}`],
  flyby_twin: [3, 5, false, 0.55, `A WWII twin-engine piston bomber flies past fast and low, right overhead: two droning engines beating against each other rise to a thundering roar, then the Doppler pitch drop as it passes and fades away. ${NO}`],
  jericho: [4, 6, true, 0.65, `Ju 87 Stuka Jericho trumpet: a propeller-driven air siren wailing at a constant pitch, a loud, screaming, sustained howl. Steady, no rise or fall in pitch. No engine. ${NO}`],
  whiz_bullet: [4, 1.5, false, 0.6, `A single rifle-calibre machine-gun bullet whizzing past very close to the ear: a sharp supersonic snap and a short zip. Only one bullet, silence afterwards. ${NO}`],
  whiz_zip: [4, 1, false, 0.6, `Close bullet fly-by: the short, high-pitched "zzip" whine of a single bullet passing just past the listener's head. Only one bullet, silence afterwards. ${NO}`],
  whiz_cannon: [3, 1.5, false, 0.6, `A single 20 mm cannon shell passing very close overhead: a heavy supersonic crack followed by a short tearing whoosh. Only one shell, silence afterwards. ${NO}`],
};

function apiKey() {
  let k = process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
  const envFile = path.join(root, '.env');
  if (!k && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*(ELEVEN_?LABS_API_KEY)\s*=\s*"?([^"\s]+)"?/);
      if (m) k = m[2];
    }
  }
  if (!k) throw new Error('ELEVEN_LABS_API_KEY not set (environment or .env)');
  return k;
}

async function gen(names) {
  const key = apiKey();
  fs.mkdirSync(cache, { recursive: true });
  let secs = 0;
  for (const name of names.length ? names : Object.keys(JOBS)) {
    const job = JOBS[name];
    if (!job) throw new Error(`unknown job ${name}`);
    const [n, duration, loop, influence, text] = job;
    for (let i = 1; i <= n; i++) {
      const file = path.join(cache, `${name}_${i}.pcm`);
      if (fs.existsSync(file)) { console.log(`${name}_${i}: cached`); continue; }
      const r = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=pcm_44100', {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, duration_seconds: duration, prompt_influence: influence, loop, model_id: 'eleven_text_to_sound_v2' }),
      });
      if (!r.ok) throw new Error(`${name}_${i}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(file, buf);
      secs += duration;
      console.log(`${name}_${i}: ${(buf.length / 4 / SR).toFixed(2)} s`);
    }
  }
  console.log(`requested ${secs.toFixed(1)} s (~${Math.round(secs * 11)} credits)`);
}

// ------------------------------------------------------------------ build
// Picked candidates (by level / pitch measurements and spectrograms: steady pitch and level for the loops, a clear
// Doppler sweep for the fly-bys, one clean event for the whiz-bys).
// [output (relative to audio/), candidate, kind]
const PICKS = [
  ['bmw801_idle', 'bmw801_idle_3', 'engine'],
  ['bmw801_power', 'bmw801_power_3', 'engine'],
  ['bmw801_power2', 'bmw801_power_2', 'engine'],
  ['sfx/jericho_loop', 'jericho_1', 'siren'],
  ['sfx/flyby_1', 'flyby_fighter_3', 'flyby'],
  ['sfx/flyby_2', 'flyby_fighter_2', 'flyby'],
  ['sfx/flyby_twin_1', 'flyby_twin_3', 'flyby'],
  ['sfx/flyby_twin_2', 'flyby_twin_1', 'flyby'],
  ['sfx/whiz_1', 'whiz_zip_1', 'whiz'],
  ['sfx/whiz_2', 'whiz_zip_3', 'whiz'],
  ['sfx/whiz_3', 'whiz_zip_4', 'whiz'],
  ['sfx/whiz_cannon_1', 'whiz_cannon_1', 'whiz'],
  ['sfx/whiz_cannon_2', 'whiz_cannon_2', 'whiz'],
  ['sfx/whiz_cannon_3', 'whiz_cannon_3', 'whiz'],
];
const AF = {
  engine: 'highpass=f=28,bass=g=4:f=110:w=0.8,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=150:makeup=1.5',
  siren: 'highpass=f=150,lowpass=f=9000',
  flyby: 'highpass=f=30',
  whiz: 'highpass=f=80',
};
const XF = 0.3; // loop crossfade (s)

function decode(name, af) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', String(SR), '-ac', '2', '-i', path.join(cache, name + '.pcm'),
    '-ac', '1', '-af', af, '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}
function writeWav(file, y) {
  let pk = 0;
  for (const v of y) pk = Math.max(pk, Math.abs(v));
  const g = PEAK / (pk || 1), N = y.length, wav = Buffer.alloc(44 + N * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, y[i] * g)) * 32767), 44 + i * 2);
  fs.writeFileSync(file, wav);
}
// seamless loop: the last XF seconds fade out over the start (equal power)
function loopify(x) {
  const X = Math.round(XF * SR), N = x.length - X, y = x.slice(0, N);
  for (let i = 0; i < X; i++) { const a = (i / X) * Math.PI / 2; y[i] = x[i] * Math.sin(a) + x[N + i] * Math.cos(a); }
  return y;
}
// RMS envelope in 10 ms frames
const envelope = (x) => { const w = 441, out = []; for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += x[j] * x[j]; out.push(Math.sqrt(e / w)); } return out; };
const fadeOut = (y, sec) => { const n = Math.min(y.length, Math.round(sec * SR)); for (let i = 0; i < n; i++) y[y.length - n + i] *= Math.cos((i / n) * Math.PI / 2); return y; };
const fadeIn = (y, sec) => { const n = Math.min(y.length, Math.round(sec * SR)); for (let i = 0; i < n; i++) y[i] *= Math.sin((i / n) * Math.PI / 2); return y; };
// fundamental of a steady tone (autocorrelation peak, 200..1500 Hz)
function fundamental(x) {
  const n = Math.min(x.length, SR), lo = Math.floor(SR / 1500), hi = Math.ceil(SR / 200);
  let best = 0, bl = lo;
  for (let l = lo; l <= hi; l++) { let s = 0; for (let i = 0; i < n - hi; i++) s += x[i] * x[i + l]; if (s > best) { best = s; bl = l; } }
  return SR / bl;
}

function build() {
  for (const [out, cand, kind] of PICKS) {
    let y = decode(cand, AF[kind]);
    let note = '';
    if (kind === 'engine' || kind === 'siren') {
      y = loopify(y);
      if (kind === 'siren') note = `fundamental ${fundamental(y).toFixed(0)} Hz`;
    } else {
      // trim to the sound (from 5 ms before the first frame above -20 dB of the peak to the last above -36 dB)
      const env = envelope(y), top = Math.max(...env);
      const a = env.findIndex((e) => e > top * 0.1), b = env.length - 1 - [...env].reverse().findIndex((e) => e > top * 0.016);
      const s0 = Math.max(0, a * 441 - 220), s1 = Math.min(y.length, (b + 1) * 441 + Math.round((kind === 'whiz' ? 0.05 : 0.2) * SR));
      y = fadeOut(fadeIn(y.slice(s0, s1), 0.002), kind === 'whiz' ? 0.04 : 0.4);
      const e2 = envelope(y); note = `loudest at ${(e2.indexOf(Math.max(...e2)) * 0.01).toFixed(2)} s`;
    }
    writeWav(path.join(root, 'audio', out + '.wav'), y);
    console.log(`${out}.wav  ${(y.length / SR).toFixed(2)} s  <- ${cand}  ${note}`);
  }
  // credits: replace this tool's section at the end of audio/CREDITS.txt
  const credF = path.join(root, 'audio', 'CREDITS.txt'), MARK = 'AI-generated sound effects';
  let cred = fs.existsSync(credF) ? fs.readFileSync(credF, 'utf8') : '';
  if (cred.includes(MARK)) cred = cred.slice(0, cred.indexOf(MARK));
  cred = cred.replace(/\s*$/, '\n\n') + `${MARK} (see tools/make-ai-sfx.mjs): generated with ElevenLabs text-to-sound-effects
(eleven_text_to_sound_v2), then mixed to mono, filtered, looped or trimmed, faded and normalised.

` + PICKS.map(([out, cand]) => `  ${out}.wav <- ${cand}: "${JOBS[cand.replace(/_\d+$/, '')][4]}"`).join('\n') + '\n';
  fs.writeFileSync(credF, cred);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'gen') await gen(rest);
else if (cmd === 'build') build();
else { console.log('usage: node tools/make-ai-sfx.mjs gen [job...] | build'); process.exit(1); }
