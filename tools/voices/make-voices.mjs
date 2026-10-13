// Generates the radio voice lines (js/voicelines.js) into audio/voice/<key>.mp3 with Kokoro-82M
// (Apache-2.0 open-weights TTS, runs locally on the CPU; the model downloads from Hugging Face once).
//   cd tools/voices && npm i && node make-voices.mjs [--force] [key ...]
// Each line: Kokoro (24 kHz) -> trim silence -> 1940s R/T radio band-pass + compression + a little grit
// -> mono 22.05 kHz MP3 (one-shots, so MP3 padding doesn't matter). Needs ffmpeg.
import { KokoroTTS } from 'kokoro-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LINES, SPEAKERS } from '../../js/voicelines.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const outDir = path.join(root, 'audio', 'voice');
fs.mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2), force = args.includes('--force'), only = args.filter((a) => !a.startsWith('--'));
const keys = Object.keys(LINES).filter((k) => (only.length ? only.includes(k) : true) && (force || only.length || !fs.existsSync(path.join(outDir, k + '.mp3'))));
if (!keys.length) { console.log('all voice lines exist (use --force to regenerate)'); process.exit(0); }

const RADIO = [
  'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.25',
  'highpass=f=300', 'highpass=f=300', 'lowpass=f=3300', 'lowpass=f=3300',
  'equalizer=f=1800:t=q:w=1.2:g=4',
  'acompressor=threshold=-22dB:ratio=5:attack=3:release=80:makeup=3',
  'acrusher=bits=12:mix=0.15:mode=log:aa=1',
  'apad=pad_dur=0.12', 'alimiter=limit=0.89',
].join(',');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'));
console.log('loading Kokoro-82M...');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
for (const k of keys) {
  const [who, text] = LINES[k], sp = SPEAKERS[who];
  const audio = await tts.generate(text, { voice: sp.voice, speed: sp.speed });
  const wav = path.join(tmp, k + '.wav');
  await audio.save(wav);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', RADIO, '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k', path.join(outDir, k + '.mp3')]);
  console.log(`${k.padEnd(22)} ${sp.voice}  "${text}"`);
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(outDir, 'CREDITS.txt'),
  'Radio voice lines generated with Kokoro-82M (https://huggingface.co/hexgrad/Kokoro-82M, Apache-2.0)\n' +
  'via kokoro-js, voices: ' + [...new Set(Object.values(SPEAKERS).map((s) => s.voice))].join(', ') + '.\n' +
  'Text and voice assignments: js/voicelines.js; generator: tools/voices/make-voices.mjs.\n');
