// Offline ElevenLabs production tool. No API key is ever included in the website.
// node tools/voices/make-voices.mjs [plan|voices|generate|check] [--pack=british|american] [key ...]
// Generation is resumable: exact request hashes cache the original audio before radio mastering.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { LINES, SPEAKERS, AMERICAN_KEYS, AMERICAN_TEXT } from '../../js/voicelines.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const outDir=path.join(root,'audio/voice'),cacheDir=path.join(root,'tools/voices/cache');
const manifestFile=path.join(outDir,'manifest.json');
const args=process.argv.slice(2),command=args[0]&&!args[0].startsWith('--')?args.shift():'generate';
const packFilter=args.find(a=>a.startsWith('--pack='))?.slice(7);
const only=args.filter(a=>!a.startsWith('--'));
const MODEL='eleven_multilingual_v2',FORMAT='mp3_44100_128';
const RADIO='silenceremove=start_periods=1:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_threshold=-48dB,areverse,highpass=f=280,lowpass=f=3500,equalizer=f=1600:t=q:w=1:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=90:makeup=1.5,acrusher=bits=14:mix=0.035,apad=pad_dur=0.12,loudnorm=I=-17:TP=-2:LRA=7';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const readJSON=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
const manifest=readJSON(manifestFile,{provider:'ElevenLabs',model:MODEL,clips:{}});
let secret;
function apiKey() {
  if(secret)return secret;
  // Prefer the file the user updated to a stale inherited environment variable.
  const envFile=path.join(root,'.env');
  if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)) {
    const m=line.match(/^\s*(?:export\s+)?(?:ELEVEN_LABS_API_KEY|ELEVENLABS_API_KEY)\s*=\s*(.*)$/);
    if(m) {const value=m[1].trim();secret=/^['"]/.test(value)?value.slice(1,value.lastIndexOf(value[0])):value.replace(/\s+#.*$/,'').trim();}
  }
  secret ||= process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
  if(!secret)throw new Error('Set ELEVEN_LABS_API_KEY in .env (or the environment).');
  return secret;
}
// Some development hosts point at an unavailable local DNS stub. Resolve this API only
// through public DNS if the system lookup fails; HTTPS still verifies api.elevenlabs.io.
const resolver=new dns.Resolver({timeout:2500,tries:1});resolver.setServers(['1.1.1.1','8.8.8.8']);
let fallbackReported=false;
const agent=new https.Agent({keepAlive:true,lookup(host,options,callback) {
  dns.lookup(host,options,(error,address,family)=>{
    if(!error||host!=='api.elevenlabs.io')return callback(error,address,family);
    resolver.resolve4(host,(err,addresses)=>{
      if(err)return callback(error);
      if(!fallbackReported){console.log('System DNS unavailable; using public DNS for ElevenLabs requests only.');fallbackReported=true;}
      if(options.all)callback(null,addresses.map(address=>({address,family:4})));
      else callback(null,addresses[0],4);
    });
  });
}});
async function api(endpoint,body) {
  let response;
  try {
    response=await new Promise((resolve,reject)=>{
      const encoded=body?JSON.stringify(body):null;
      const req=https.request('https://api.elevenlabs.io'+endpoint,{agent,method:body?'POST':'GET',headers:{'xi-api-key':apiKey(),...(encoded?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}:{})}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
        res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))})));
      });
      req.setTimeout(60000,()=>req.destroy(new Error('request timed out')));req.on('error',reject);
      if(encoded)req.write(encoded);req.end();
    });
  } catch(e){throw new Error(`ElevenLabs connection failed (${e.code||e.message}). Check internet/DNS access, then rerun; completed clips remain cached.`);}
  if(!response.ok) {
    const raw=(await response.text()).replaceAll(apiKey(),'[redacted]');
    let detail;try{const d=JSON.parse(raw).detail;detail=typeof d==='string'?d:d?.message||d?.status;}catch{}
    throw new Error(`ElevenLabs HTTP ${response.status}: ${String(detail||'request rejected').slice(0,220)}`);
  }
  return response;
}
async function voices() {
  let token,all=[];
  do {
    const q=new URLSearchParams({page_size:'100'});if(token)q.set('next_page_token',token);
    const data=await(await api('/v2/voices?'+q)).json();all.push(...(data.voices||[]));token=data.has_more?data.next_page_token:null;
  }while(token);
  return all;
}
function chooseVoice(all,pack,role) {
  const wanted=pack==='american'?'american':'british';
  const override=process.env[`ELEVENLABS_${pack.toUpperCase()}_${role.toUpperCase()}_VOICE_ID`]||process.env[`ELEVENLABS_${pack.toUpperCase()}_VOICE_ID`];
  // Voice labels are verified on the account, rather than assuming an old default ID still exists.
  const candidates=all.filter(v=>String(v.labels?.gender).toLowerCase()==='male'&&String(v.labels?.accent).toLowerCase().includes(wanted));
  if(override) {const v=candidates.find(v=>v.voice_id===override);if(!v)throw new Error(`${pack}/${role} override must identify an available male ${wanted} voice.`);return v;}
  const preferred=pack==='british'?{control:['Daniel','George'],wing:['Charlie','Harry','George'],crew:['George','Daniel'],you:['Daniel','George']}:{control:['Bill','Adam','Eric'],wing:['Chris','Josh','Adam'],crew:['Eric','Bill'],you:['Adam','Chris']};
  candidates.sort((a,b)=>{
    const score=v=>{const i=preferred[role].findIndex(n=>v.name.toLowerCase().split(/\W+/).includes(n.toLowerCase()));return i<0?100:i;};
    return score(a)-score(b)||a.name.localeCompare(b.name);
  });
  if(!candidates.length)throw new Error(`No available male ${wanted} voice. Enable one in ElevenLabs and rerun, or set an ELEVENLABS_${pack.toUpperCase()}_VOICE_ID override.`);
  return candidates[0];
}
const jobs=[];
if(packFilter&&!['british','american'].includes(packFilter))throw new Error('Unknown --pack. Use british or american.');
for(const key of only)if(!LINES[key])throw new Error(`Unknown line: ${key}`);
for(const pack of ['british','american'])for(const [key,[speaker,britishText]]of Object.entries(LINES)) {
  if(packFilter&&pack!==packFilter||pack==='american'&&!AMERICAN_KEYS.has(key)||only.length&&!only.includes(key))continue;
  jobs.push({pack,key,speaker,text:pack==='american'?AMERICAN_TEXT[key]||britishText:britishText});
}
function publishManifest() {
  fs.mkdirSync(outDir,{recursive:true});
  const entries=Object.entries(manifest.clips).filter(([,c])=>c.provider==='ElevenLabs'&&fs.existsSync(path.join(outDir,c.file)));
  const assets=Object.fromEntries(entries.map(([key,c])=>[key,`${c.file}?v=${c.audioHash.slice(0,12)}`]));
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync(path.join(root,'js/voice-assets.js'),'// Generated ElevenLabs recordings. Do not edit by hand. No credentials.\nexport const VOICE_ASSETS = '+JSON.stringify(assets,null,2)+';\n');
  fs.writeFileSync(path.join(outDir,'CREDITS.txt'),`Radio dialogue generated with ElevenLabs (${MODEL}).\nOriginal game dialogue: js/voicelines.js. Offline generator: tools/voices/make-voices.mjs.\nBritish and American male voices; lightly band-limited, compressed and levelled for period R/T.\nVoice names, IDs, accents, scripts and audio hashes: manifest.json.\nNo live voice generation or browser speech is used during play.\n`);
}
function check() {
  const errors=[];
  for(const j of jobs) {
    const c=manifest.clips[`${j.pack}/${j.key}`];
    if(!c||c.provider!=='ElevenLabs') {errors.push(`${j.pack}/${j.key}: recording missing`);continue;}
    if(c.text!==j.text)errors.push(`${j.pack}/${j.key}: script changed`);
    if(c.mastering!==RADIO)errors.push(`${j.pack}/${j.key}: radio mastering changed`);
    const file=path.join(outDir,c.file);
    if(!fs.existsSync(file)||hash(fs.readFileSync(file))!==c.audioHash)errors.push(`${j.pack}/${j.key}: file missing or hash mismatch`);
    if(c.gender!=='male'||!c.accent.toLowerCase().includes(j.pack==='american'?'american':'british'))errors.push(`${j.pack}/${j.key}: wrong voice labels`);
  }
  if(errors.length)throw new Error(`${errors.length} recording checks failed:\n${errors.slice(0,12).join('\n')}`);
  console.log(`PASS: ${jobs.length} ElevenLabs clips, scripts, hashes and male British/American assignments verified.`);
}
async function generate() {
  execFileSync('ffmpeg',['-version'],{stdio:'ignore'});
  const all=await voices(),selected={};
  for(const j of jobs)selected[`${j.pack}/${j.speaker}`]??=chooseVoice(all,j.pack,j.speaker);
  for(const [role,v]of Object.entries(selected))console.log(`${role}: ${v.name} (${v.labels.accent}, male)`);
  fs.mkdirSync(cacheDir,{recursive:true});
  let generated=0,characters=0;
  for(let i=0;i<jobs.length;i++) {
    const j=jobs[i],v=selected[`${j.pack}/${j.speaker}`],s=SPEAKERS[j.speaker];
    const body={text:j.text,model_id:MODEL,seed:1943,voice_settings:{stability:s.stability,similarity_boost:.8,style:s.style,speed:s.speed,use_speaker_boost:true}};
    const requestHash=hash({voice:v.voice_id,format:FORMAT,body});
    const rawFile=path.join(cacheDir,requestHash+'.mp3'),file=`${j.pack}/${j.key}.mp3`,out=path.join(outDir,file);
    const current=manifest.clips[`${j.pack}/${j.key}`];
    if(current?.requestHash===requestHash&&current.mastering===RADIO&&fs.existsSync(out)&&hash(fs.readFileSync(out))===current.audioHash)continue;
    if(!fs.existsSync(rawFile)) {
      const response=await api(`/v1/text-to-speech/${encodeURIComponent(v.voice_id)}?output_format=${FORMAT}`,body);
      const audio=Buffer.from(await response.arrayBuffer());if(audio.length<1000||!(response.headers.get('content-type')||'').includes('audio'))throw new Error(`${j.key}: invalid audio response`);
      fs.writeFileSync(rawFile,audio);generated++;characters+=j.text.length;
    }
    fs.mkdirSync(path.dirname(out),{recursive:true});
    const tmp=out+'.tmp.mp3';
    execFileSync('ffmpeg',['-v','error','-y','-i',rawFile,'-af',RADIO,'-ac','1','-ar','22050','-c:a','libmp3lame','-b:a','64k',tmp],{stdio:['ignore','ignore','pipe']});
    if(fs.statSync(tmp).size<1000)throw new Error(`${j.key}: mastering produced empty audio`);
    fs.renameSync(tmp,out);
    manifest.clips[`${j.pack}/${j.key}`]={provider:'ElevenLabs',voiceName:v.name,voiceId:v.voice_id,gender:'male',accent:v.labels.accent,speaker:j.speaker,text:j.text,file,model:MODEL,requestHash,mastering:RADIO,audioHash:hash(fs.readFileSync(out))};
    publishManifest();console.log(`[${i+1}/${jobs.length}] ${j.pack}/${j.key} — ${fs.statSync(out).size} bytes`);
  }
  publishManifest();check();
  console.log(`Generated ${generated} new clips (${characters} text characters); remaining audio was reused from cache.`);
  // Superseded Kokoro files are removed only once the complete replacement catalog has passed checks.
  if(!packFilter&&!only.length)for(const name of fs.readdirSync(outDir))if(name.endsWith('.mp3')&&LINES[name.slice(0,-4)])fs.unlinkSync(path.join(outDir,name));
}
try {
  if(command==='plan') {console.log(JSON.stringify({model:MODEL,jobs:jobs.length,characters:jobs.reduce((n,j)=>n+j.text.length,0),packs:Object.fromEntries(['british','american'].map(p=>[p,jobs.filter(j=>j.pack===p).length])),scripts:jobs.map(j=>({pack:j.pack,key:j.key,speaker:j.speaker,text:j.text}))},null,2));}
  else if(command==='voices') {console.log(JSON.stringify((await voices()).filter(v=>v.labels?.gender==='male').map(v=>({id:v.voice_id,name:v.name,labels:v.labels})),null,2));}
  else if(command==='check')check();
  else if(command==='generate')await generate();
  else throw new Error('Use plan, voices, generate or check.');
} catch(e) {console.error(e.message?.replaceAll(secret||'\0','[redacted]'));process.exitCode=1;}
