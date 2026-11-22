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

// Actual ballistic impacts distinguish ship hits, water misses and ground misses.
const {World}=await import('../js/world.js');
const {Sim}=await import('../js/sim.js');
const {P,rocketImpact}=await import('../js/particles.js');
const world=new World({scenario:'norway'}),sim=new Sim(world,{headless:true,raidStart:'coast'}),ship=sim.mission.target.halls[0];
const shot=(x,y,z,vx=0,vy=-100)=>({x,y,z,vx,vy,vz:0,t:0,rocket:true,kind:'rocket25',team:0,owner:sim.player});
sim.events.length=0;sim.bombs.push(shot(-6000,1,800));sim.stepBombs(.05);
assert.equal(sim.events.find(e=>e.t==='rocketimpact')?.surface,'water');
sim.events.length=0;const ground=world.groundAt(2000,11000);assert.ok(ground>0);
sim.bombs.push(shot(2000,ground+1,11000));sim.stepBombs(.05);
assert.equal(sim.events.find(e=>e.t==='rocketimpact')?.surface,'ground');
sim.events.length=0;const hp=ship.hp,neighbourHP=sim.mission.target.halls[1].hp;
sim.bombs.push(shot(ship.x-200,8,ship.z,1000,0));sim.stepBombs(.4);
assert.equal(sim.events.find(e=>e.t==='rocketimpact')?.surface,'ship');
assert.equal(hp-ship.hp,115);assert.equal(sim.mission.target.halls[1].hp,neighbourHP,'presentation adds no blast damage');
assert.equal(sim.mission.playerHits,1);

// Misses have a white plume/mist at sea and a substantial dirt plume on land.
const particles=[],ps={emit:(...args)=>particles.push(args)};
rocketImpact(ps,0,0,0,'water');
assert.ok(particles.filter(c=>c[0]===P.spray&&c[5]>=35).length>=20);
assert.ok(particles.some(c=>c[0]===P.waterMist));
assert.ok(!particles.some(c=>c[0]===P.fireball),'sea impacts use spray rather than a fireball');
particles.length=0;rocketImpact(ps,0,10,0,'ground');assert.ok(particles.filter(c=>c[0]===P.bigDust).length>10);
particles.length=0;rocketImpact(ps,0,8,0,'ship');assert.ok(particles.filter(c=>c[0]===P.fireball).length>=25);

const boom=[],spatial=[],fx=Object.assign(Object.create(GameAudio.prototype),{
 _ok:()=>true,_muted:false,buf:{water:['water'],expFar:['echo']},bus:{fx:'fx'},
 explosion:(_,size)=>boom.push(size),_playAt:(...args)=>spatial.push(args),_fail:e=>{throw e;}
});
fx.rocketImpact({x:0,y:0,z:0},'water',true);
assert.equal(boom[0],1.9);assert.equal(spatial[0][5],6500);assert.equal(spatial[1][10],.35);
fx.rocketImpact({x:0,y:8,z:0},'ship');assert.equal(boom[1],2.3);
fx._muted=true;fx.rocketImpact({x:0,y:0,z:0},'ground');assert.equal(boom.length,2);
const routed=[],vfx=[];
const impactGame=Object.assign(Object.create(Game.prototype),{
 sim:{player:{},mission:{key:'fjord'},events:['ship','water','ground'].map(surface=>({t:'rocketimpact',surface,x:600,y:8,z:0}))},
 state:'play',cam:{pos:{x:0,y:40,z:0}},ps:{emit:(...args)=>vfx.push(args)},rum:{s:0},shake:0,
 audio:{rocketImpact:(_,surface,fjord)=>routed.push([surface,fjord])}
});
impactGame.processEvents();assert.deepEqual(routed,[['ship',true],['water',true],['ground',true]]);assert.ok(vfx.length>150);
console.log('PASS: ballistic rocket hit/miss events, unchanged damage, large surface-specific particles, distant impact audio, echo, mute and real event dispatch');

// Cannon impacts identify hard surfaces without changing their existing damage multiplier.
sim.events.length=0;const cannonHP=ship.hp;
assert.ok(sim.bulletStructures(ship.x,ship.z,0,'cannon',sim.player,8));
const shellHit=sim.events.find(e=>e.t==='hit');assert.equal(shellHit.targetKind,'ship');
assert.ok(Math.abs(cannonHP-ship.hp-.5)<1e-8);
const {cannonImpact}=await import('../js/particles.js');particles.length=0;
cannonImpact(ps,0,8,0,'ship');assert.equal(particles.filter(c=>c[0]===P.fireball).length,3);
assert.ok(particles.some(c=>c[0]===P.blackSmoke)&&particles.some(c=>c[0]===P.debris));
assert.ok(!particles.some(c=>c[0]===P.dust),'ship shell strikes show metal fragments rather than dirt');
const shellAudio=[],shellFx=Object.assign(Object.create(GameAudio.prototype),{
 _ok:()=>true,_muted:false,ctx:{currentTime:0},buf:{expClose:['shell'],metal:['metal']},bus:{fx:'fx'},
 _spatial:()=>({d:600}),_playAt:(...args)=>shellAudio.push(args),_fail:e=>{throw e;}
});
shellFx.cannonImpact({x:600,y:8,z:0});assert.equal(shellAudio.length,2,'cannon impacts audible beyond old 400m cutoff');
shellFx.ctx.currentTime=.01;shellFx.cannonImpact({x:600,y:8,z:0});assert.equal(shellAudio.length,2,'simultaneous hits share one report');
shellFx.ctx.currentTime=.1;shellFx.cannonImpact({x:600,y:8,z:0});assert.equal(shellAudio.length,4);
shellFx._muted=true;shellFx.ctx.currentTime=.2;shellFx.cannonImpact({x:600,y:8,z:0});assert.equal(shellAudio.length,4);
const shellCalls=[];
impactGame.sim.events=[{...shellHit,x:600,y:8,z:0}];impactGame.audio={cannonImpact:()=>shellCalls.push('shell'),impact:()=>shellCalls.push('generic')};
impactGame.processEvents();assert.deepEqual(shellCalls,['shell'],'hard cannon strikes route to the shell burst and report');
console.log('PASS: cannon ship-hit metadata, 0.5 HP hull damage, shell-burst particles, distant reports, volley limiting, mute and event routing');

const {rocketTrail}=await import('../js/particles.js');
const trailCounts=[];
for(const fps of [30,60,144]) {
 const samples=[],trailPS={emit:(...args)=>samples.push(args)},r={x:0,y:1000,z:0,vx:450,vy:0,vz:0,t:0};
 for(let frame=1;frame<=fps*3;frame++) {
  r.t=frame/fps;r.x=450*r.t;r.y=1000-4.905*r.t*r.t;r.vy=-9.81*r.t;
  rocketTrail(trailPS,r,1/fps);
 }
 assert.ok(samples.length>440&&samples.length<470,'dense trail along the entire three-second trajectory');
 for(let i=1;i<samples.length;i++) {
  const a=samples[i-1],b=samples[i];
  assert.ok(Math.hypot(b[1]-a[1],b[2]-a[2],b[3]-a[3])<=3.01,'neighbouring trail particles overlap');
  assert.ok(Math.abs(b[2]-(1000-4.905*(b[1]/450)**2))<.1,'trail follows ballistic drop');
 }
 const before=samples.length;rocketTrail(trailPS,r,0);assert.equal(samples.length,before,'no extra particles without movement');
 assert.ok(samples.at(-1)[1]>1300,'trail continues beyond the old motor puff cutoff');
 trailCounts.push(samples.length);
}
assert.ok(Math.max(...trailCounts)-Math.min(...trailCounts)<=1,'trail density is independent of frame rate');
const trailSamples=[],testRocket={rocket:true,x:15,y:100,z:0,vx:450,vy:0,vz:0,t:1};
const trailGame=Object.assign(Object.create(Game.prototype),{
 sim:{aircraft:[],bombs:[testRocket],wrecks:[]},ps:{emit:(...args)=>trailSamples.push(args)},
 cam:{pos:{x:0,y:100,z:0}},world:{targets:[]},wreckT:0
});
trailGame.emitters(1/60);assert.ok(trailSamples.some(c=>c[0]===P.rocketTrail),'real emitter runs outside the wreck timer');
assert.ok(trailGame.wreckT<.12);
console.log('PASS: continuous full-flight rocket trails, ballistic paths, overlapping samples, no stationary emission, frame-rate-independent density and emitter integration');
