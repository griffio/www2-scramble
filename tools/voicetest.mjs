// Voice integration: mission coverage, male accent packs and asynchronous playback cancellation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LINES, AMERICAN_KEYS, voicePackFor } from '../js/voicelines.js';
import { VOICE_ASSETS } from '../js/voice-assets.js';
import { SCENARIOS } from '../js/scenarios.js';
import { World } from '../js/world.js';
import { Sim } from '../js/sim.js';
import { GameAudio } from '../js/audio.js';
process.on('uncaughtException',e=>{console.error(e.name+': '+e.message);console.error((e.stack||'').split('\n').filter(l=>!l.includes('data:text/')).slice(1).join('\n'));process.exit(1);});
let source=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
assert.ok(!source.includes('speechSynthesis')&&!source.includes('SpeechSynthesisUtterance'),'browser voices are removed');
source=source.slice(0,source.indexOf('const game = new Game();'))+'\nexport { Game };';
source=source.replaceAll(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL('../js/'+p.slice(2),import.meta.url).href}'`);
const {Game}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const played=[],g=Object.create(Game.prototype);
g.voice=true;g.audio={voice:asset=>played.push(asset),radio(){}};
globalThis.window={get speechSynthesis(){throw new Error('browser speech must never run');}};
function verifyKey(key,scenario) {
  assert.ok(LINES[key],`${scenario}: script for ${key}`);
  const pack=voicePackFor(scenario),asset=VOICE_ASSETS[`${pack}/${key}`];
  assert.ok(asset,`${scenario}: ${pack} recording for ${key}`);
  assert.ok(asset.startsWith(pack+'/')&&/\.mp3\?v=[a-f0-9]{12}$/.test(asset));
  g.sim={world:{scenario}};g.say(key);assert.equal(played.at(-1),asset);
}
for(const [scenario,spec]of Object.entries(SCENARIOS)) {
  const s=new Sim(new World({scenario}),{raidStart:'coast',headless:true});
  for(const e of s.events.filter(e=>e.t==='msg'))if(e.voice)verifyKey(e.voice,scenario);
  if(s.mission) {
    assert.ok(s.events.some(e=>e.voice),`${scenario} has a voiced introduction`);
    for(const order of s.mission.orderKeys)s.mission.orderWingmen(order);
    s.mission.defenceSpotted(s.player);s.mission.defenceFired(s.player);
    if(s.mission.launchWave)s.mission.launchWave();
    for(const e of s.events.filter(e=>e.voice))verifyKey(e.voice,scenario);
    s.mission.finish(false,'Test failure.');verifyKey(s.mission.resultVoice,scenario);
    if(scenario!=='factory') {s.result={winner:s.playerTeam};verifyKey(s.mission.resultVoice,scenario);}
  }
}
for(const key of AMERICAN_KEYS)verifyKey(key,'fortress');
for(const stage of ['takeoff','coast','channel','country','approach','release','egress','escape','homeward','landing'])verifyKey('factory_'+stage,'factory');
const before=played.length;g.say(null,'Uncatalogued message');g.say('not_a_recording','Missing message');g.voice=false;g.say('fortress_intro');assert.equal(played.length,before,'missing/disabled lines cannot synthesize browser speech');
console.log('PASS: all mission intros, orders, warnings, outcomes and shared US calls use recorded clips in the correct accent');

// A late British fetch must not interrupt or play over the next American sortie.
const waits=new Map(),sources=[],duck={cancelScheduledValues(){},setTargetAtTime(){}};
const a=Object.assign(Object.create(GameAudio.prototype),{_ok:()=>true,_muted:false,_voiceBus:{},_duck:{gain:duck},radio(){},_fail:e=>{throw e;},
 ctx:{currentTime:0,state:'running',createBufferSource(){const src={connect(){},start(){sources.push(src);},stop(){this.stopped=true;},disconnect(){},onended:null};return src;}},
 _voiceBuf:key=>{if(!waits.has(key))waits.set(key,{});const w=waits.get(key);return w.promise??=(new Promise(resolve=>{w.resolve=resolve;}));}});
a.voice('british/intro.mp3');assert.equal(a._voiceBusy,true);a.stopVoice();
a.voice('american/intro.mp3');waits.get('british/intro.mp3').resolve({duration:4,pack:'british'});await Promise.resolve();await Promise.resolve();
assert.equal(sources.length,0);assert.equal(a._voiceBusy,true,'old pending load does not clear the new voice lock');
waits.get('american/intro.mp3').resolve({duration:4,pack:'american'});await Promise.resolve();await Promise.resolve();
assert.equal(sources.length,1);assert.equal(sources[0].buffer.pack,'american');
a.voice('american/queued.mp3');a.stopVoice();assert.equal(sources[0].stopped,true);assert.equal(sources[0].onended,null);assert.equal(a._voiceQ.length,0);
waits.get('american/queued.mp3').resolve({duration:4,pack:'american'});await Promise.resolve();assert.equal(sources.length,1);
let missing=0;a.voice('american/missing.mp3',()=>missing++);waits.get('american/missing.mp3').resolve(null);await Promise.resolve();await Promise.resolve();assert.equal(missing,1);assert.equal(sources.length,1);a.stopVoice();
console.log('PASS: mission changes/voice toggle cancel playing and pending audio; missing clips retain squelch without browser speech');
