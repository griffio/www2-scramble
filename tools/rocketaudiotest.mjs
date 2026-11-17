// Render the launch DSP and check actual release-event dispatch without an audio device.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
let source=await readFile(new URL('../js/audio.js',import.meta.url),'utf8');
const { Synth,Rng,synthRocket,synthBomb,GameAudio }=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport { Synth,Rng,synthRocket,synthBomb };').toString('base64'));
for(const sr of [22050,44100,48000]) {
 const synth=new Synth(sr),rocket=synthRocket(synth,new Rng(231)),bomb=synthBomb(synth,new Rng(151));
 assert.ok(rocket.every(Number.isFinite));
 let peak=0,energy=0,motor=0;
 for(let i=0;i<rocket.length;i++){peak=Math.max(peak,Math.abs(rocket[i]));energy+=rocket[i]**2;if(i>sr*.05&&i<sr*.2)motor+=rocket[i]**2;}
 assert.ok(peak>.5&&peak<1);assert.ok(Math.sqrt(energy/rocket.length)>.02);
 assert.ok(motor>sr*.0001,'motor rush continues after ignition');
 assert.equal(Math.abs(rocket.at(-1)),0,'tail fades to silence');
 assert.notDeepEqual(rocket,bomb);
}
const calls=[],audio=Object.create(GameAudio.prototype);
Object.assign(audio,{_ok:()=>true,_muted:false,buf:{rocket:['launch']},bus:{playerGun:'player',fx:'world'},
 _play:(...args)=>calls.push(['local',...args]),_playAt:(...args)=>calls.push(['spatial',...args]),_fail:e=>{throw e;}});
audio.rocketLaunch(null,true);audio.rocketLaunch(null,true);
assert.equal(calls[0][2],'player');assert.equal(calls[0][7],-calls[1][7],'alternate wing launch position');
audio.rocketLaunch({x:100,y:50,z:0});assert.equal(calls.at(-1)[0],'spatial');
audio._muted=true;const count=calls.length;audio.rocketLaunch(null,true);assert.equal(calls.length,count);
source=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
source=source.slice(0,source.indexOf('const game = new Game();'))+'\nexport { Game };';
source=source.replaceAll(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL('../js/'+p.slice(2),import.meta.url).href}'`);
const {Game}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const g=Object.create(Game.prototype),played=[];
const p={type:{bombKind:'rocket25'},pos:{x:0,y:30,z:0}},wing={type:p.type,pos:{x:50,y:30,z:0}};
Object.assign(g,{sim:{player:p,events:[]},state:'play',rum:{s:0},audio:{rocketLaunch:(pos,player)=>played.push(player?'player rocket':'wing rocket'),bombRelease:()=>played.push('bomb')}});
g.sim.events.push({t:'bombdrop',ac:p},{t:'bombdrop',ac:wing});g.processEvents();
assert.deepEqual(played,['player rocket','wing rocket']);
p.type={bombKind:'bomb500'};g.sim.events.push({t:'bombdrop',ac:p});g.processEvents();
p.type={bombKind:'torpedo18'};g.sim.events.push({t:'bombdrop',ac:p});g.processEvents();
assert.deepEqual(played,['player rocket','wing rocket','bomb','bomb']);
console.log('PASS: rocket waveform at three sample rates, local/spatial playback, mute, wing panning and rocket/bomb event routing');
