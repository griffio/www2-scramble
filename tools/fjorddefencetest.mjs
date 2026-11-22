// Live batteries and spatial audio: a dense approach with room below the barrage.
import assert from 'node:assert/strict';
import { World, fjordCentre } from '../js/world.js';
import { Sim, SIM_DT } from '../js/sim.js';
import { GameAudio } from '../js/audio.js';
const w=new World({scenario:'fjord'});
const s=new Sim(w,{headless:true,raidStart:'runway'}),m=s.mission,p=s.player;
s.aircraft=[p];p.pos.set(-4800,45,fjordCentre(-4800));p.vel.set(120,0,0);
const barrage=m.target.guns.filter(g=>g.barrage);
assert.equal(barrage.length,2);
let tracers=0,reports=0,bursts=0;
for(let i=0;i<1800;i++){
 s.time+=SIM_DT;s.airDefence(SIM_DT);
 for(const shell of s.shells)assert.ok(shell.y>=140,'overhead barrage leaves the low-level corridor open');
 s.stepShells(SIM_DT);
 tracers+=s.events.filter(e=>e.t==='gun'&&e.kind==='aa').length;
 reports+=s.events.filter(e=>e.t==='flakfire').length;
 bursts+=s.events.filter(e=>e.t==='flak').length;
 s.events.length=0;
}
assert.ok(tracers>=20,'approach guns provide sustained tracer bursts before the anchorage');
assert.ok(reports>=5&&bursts>=5,'real time-fused barrage fires and explodes on the ingress');
assert.equal(p.hp,p.type.hp,'overhead shells do not damage a low aircraft');
for(const gun of m.target.guns)gun.alive=false;
s.shells.length=0;s.events.length=0;
for(let i=0;i<300;i++){s.airDefence(SIM_DT);s.stepShells(SIM_DT);}
assert.equal(s.events.length,0,'destroying the batteries stops the barrage');
console.log(`PASS: low approach has ${tracers} tracer rounds and ${bursts} overhead bursts in 30s; silencing guns stops fire`);

const calls=[],a=Object.assign(Object.create(GameAudio.prototype),{
 _ok:()=>true,_muted:false,buf:{flak:['burst'],cannon:['report']},bus:{fx:'world'},
 _playAt:(...args)=>calls.push(args),_fail:e=>{throw e;}
});
const pos={x:0,y:140,z:0};
a.flak(pos);assert.equal(calls.length,1);const base=calls[0];
calls.length=0;a.flak(pos,true);
assert.equal(calls.length,3);assert.ok(calls[0][3]>base[3],'stronger direct crack');
assert.ok(calls[1][3]<calls[0][3]&&calls[2][3]<calls[1][3],'reflections fade');
assert.deepEqual(calls.slice(1).map(c=>c[10]),[.28,.57]);
calls.length=0;a.flakGun(pos);assert.equal(calls.length,2);assert.equal(calls[1][10],.32);
a._muted=true;a.flak(pos,true);a.flakGun(pos);assert.equal(calls.length,2,'mute covers reports and reflections');
// Reflection delay is scheduled after the direct sound's physical propagation delay.
let playback;
const b=Object.assign(Object.create(GameAudio.prototype),{_spatial:()=>({d:343,front:1,pan:.4}),_play:(...args)=>{playback=args;}});
b._playAt('sample','bus',pos,1,95,7000,1,.2,1,.65,.28);
assert.equal(playback[4],1.28);assert.equal(playback[6],.4);
console.log('PASS: fjord reports, spatial burst/reflection mix, fading echoes, propagation delay, mute and ordinary flak audio');

// Real event dispatch enables the new mix only in the fjord mission.
const { readFile }=await import('node:fs/promises');
let source=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
source=source.slice(0,source.indexOf('const game = new Game();'))+'\nexport { Game };';
source=source.replaceAll(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL('../js/'+p.slice(2),import.meta.url).href}'`);
const {Game}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const routed=[],game=Object.assign(Object.create(Game.prototype),{
 sim:{mission:{key:'fjord'},player:{},events:[{t:'flak',x:0,y:140,z:0},{t:'flakfire',x:100,y:10,z:50}]},
 state:'play',ps:{emit(){}},cam:{pos:{x:0,y:45,z:0}},rum:{s:0},shake:0,
 audio:{flak:(_,fjord)=>routed.push(['burst',fjord]),flakGun:()=>routed.push(['report'])}
});
game.processEvents();assert.deepEqual(routed,[['burst',true],['report']]);
routed.length=0;game.sim.mission.key='norway';game.sim.events=[{t:'flak',x:0,y:140,z:0},{t:'flakfire',x:100,y:10,z:50}];game.processEvents();assert.deepEqual(routed,[['burst',false]]);
console.log('PASS: actual event dispatch scopes the stronger mix and heavy gun reports to the fjord');
