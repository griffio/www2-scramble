// Scenario regressions: shared physics, finite attacks, actual weapon impacts and objective outcomes.
import assert from 'node:assert/strict';
import { World, coastN } from '../js/world.js';
import { TYPES } from '../js/types.js';
import { SCENARIOS, OPERATIONS } from '../js/scenarios.js';
import { buildModels } from '../js/models.js';
import { V3, Quat, DEG, G, clamp, wrapPi, mulberry32 } from '../js/math.js';
Math.random=mulberry32(Number(process.env.OP_TEST_SEED||1944));
const {Sim,SIM_DT}=await import('../js/sim.js');
const models=buildModels();
for(const [k,t] of Object.entries(TYPES)) {assert.ok(models.aircraft[k],`model for ${k}`);t.geom=models.aircraft[k];}
const worlds=new Map();
const fresh=(key,start='coast')=>{
  if(!worlds.has(key))worlds.set(key,new World({scenario:key}));
  const w=worlds.get(key);w.resetTargets();return new Sim(w,{headless:true,raidStart:start});
};
const tick=(s,n=1)=>{for(let i=0;i<n;i++){s.step(SIM_DT);s.events.length=0;}};
const disableDefences=s=>{s.mission.launchWave=()=>{s.mission.wave++};for(const t of s.world.targets)if(t.kind==='flak'||t.kind==='lightAA')t.alive=false;};
function flyEscort(s) {
  const p=s.player,b=s.mission.guardBomber||s.mission.leadBomber;
  if(!b)return;
  const tx=b.pos.x+b.right.x*550+b.fwd.x*250,tz=b.pos.z+b.right.z*550+b.fwd.z*250;
  const dx=tx-p.pos.x,dz=tz-p.pos.z;
  const heading=Math.atan2(b.vel.x+dx*.15,-(b.vel.z+dz*.15));
  const err=wrapPi(heading-p.compass),bank=clamp(err*1.2,-35*DEG,35*DEG);
  p.ctl.roll=clamp((bank-p.bankAngle)*1.8,-.7,.7);p.ctl.yaw=clamp(err*.5,-.3,.3);
  const targetY=b.pos.y+180;
  const trim=16*DEG*(p.type.vs/Math.max(p.speed,p.type.vs))**2/Math.max(.5,Math.cos(p.bankAngle));
  const pitch=trim+Math.atan2(clamp((targetY-p.pos.y)*.18,-10,14),Math.max(45,p.speed));
  p.ctl.pitch=clamp((pitch-p.pitchAngle)*4-p.w.x*.25,-.5,.6);
  const along=dx*b.fwd.x+dz*b.fwd.z;
  const speed=b.speed+clamp(along*.04,-18,30);
  p.ctl.throttle=clamp(.4+(speed-p.speed)*.035,.08,1);
}

for(const key of OPERATIONS) {
  const s=fresh(key),m=s.mission,p=s.player;
  assert.equal(p.type.key,SCENARIOS[key].type);assert.equal(p.team,key==='intercept'?1:0);
  assert.equal(s.pilots.has(p),false,'player stays under manual control');
  assert.equal(m.flight.length,4);assert.equal(m.orderKeys.length,3);
  for(const order of m.orderKeys)assert.equal(m.orderWingmen(order),true);
  assert.equal(m.orderWingmen('invalid'),false);m.orderWingmen(m.orderKeys[1]);
  const origin=p.pos.clone();tick(s,120);
  assert.ok(p.pos.dist(origin)>100,'airborne start moves through physics');assert.equal(m.playerDrops,0);
  const cam={pos:new V3(),q:new Quat(),vel:new V3()};m.camera(p,cam,s.time);
  assert.ok([cam.pos.x,cam.pos.y,cam.pos.z,cam.q.w,cam.fov,m.waypoint.x,m.waypoint.z].every(Number.isFinite));
  const full=fresh(key,'runway');assert.equal(full.mission.quickStart,false);
  assert.ok(full.player.pos.dist(origin)>500||key==='intercept','full sortie has its own lead-in');
}
console.log('PASS: six selectable missions, manual aircraft, orders, cameras and fresh starts');

// Full bomber routes, releases and recovery use normal AI controls and flight physics.
for(const key of ['escort','rescue','fortress']) {
  const s=fresh(key);disableDefences(s);let released=0;
  while(!s.result&&s.time<440) {flyEscort(s);s.step(SIM_DT);released+=s.events.filter(e=>e.t==='bombdrop'&&e.ac.opRole==='bomber').length;s.events.length=0;}
  assert.equal(s.result?.winner,0,`${key} route recovers bombers: ${s.mission.reason}`);
  assert.equal(s.mission.recovered.size,s.mission.bombers.length);
  assert.ok(s.player.alive,'test escort survives the route');
  if(key!=='rescue') {assert.ok(released>=20,'bombers physically release loads');assert.ok(s.mission.stragglerAnnounced);assert.ok(s.mission.guardBomber===undefined);}
  assert.ok(s.mission.debrief.totalScore>1000);
  console.log(`PASS: ${key} physically flown and recovered in ${s.time.toFixed(1)}s (${released} bomb releases)`);
}

// Interception success counts only aircraft stopped before release, including damage-forced aborts.
{
  const s=fresh('intercept'),m=s.mission;
  for(const b of m.bombers.slice(0,3))b.hp=b.type.hp*.35;
  m.step(SIM_DT);assert.equal(m.aborted.size,3);assert.equal(s.result.winner,1,'German player victory uses their team');
  assert.ok(m.bombers.slice(0,3).every(b=>b.bombs===0&&b.routeIndex>=3));
  const f=fresh('intercept');for(const b of f.mission.bombers.slice(0,4))f.mission.bombDropped(b);
  f.mission.step(SIM_DT);assert.equal(f.result.winner,0,'four delivered loads defeat interception');
}

// Two finite fighter attacks; they use armed AI and break off rather than chase indefinitely.
{
  const s=fresh('escort'),m=s.mission;m.launchWave();m.launchWave();
  assert.equal(m.interceptors.length,4);
  for(const a of m.interceptors) {assert.ok(a.ammo.some(n=>n>0));assert.ok(a.pilot);s.time=a.attackUntil+1;m.thinkPilot(a.pilot);assert.equal(a.pilot.state,'rtb');}
  s.time=400;for(const b of m.bombers)b.routeIndex=4;m.step(SIM_DT);assert.equal(m.interceptors.length,4);
  const r=fresh('rescue');assert.ok(r.mission.bombers[0].hp<TYPES.boston.hp*.5);assert.ok(r.mission.bombers[0].engineDmg>.3);
}
console.log('PASS: interception abort/delivery outcomes, damaged bomber and finite enemy attacks');

// Torpedo release interlock, ballistic entry, running weapon, swept collision and moving hulls.
{
  const s=fresh('convoy'),m=s.mission,p=s.player,t=m.target.halls[0];
  p.pos.set(t.x-900,35,t.z);p.agl=35;
  assert.equal(s.gunCanSee(m.target.guns[0],p),true,'a ship does not block its own deck gun');
  let aaShots=0;for(let i=0;i<300;i++){s.time+=SIM_DT;s.airDefence(SIM_DT);aaShots+=s.events.filter(e=>e.t==='gun'&&e.kind==='aa').length;s.events.length=0;}
  assert.ok(aaShots>0,'shipboard AA fires real projectiles');
  const initial=t.x;m.beforeStep(10);assert.ok(t.x>initial+40);assert.equal(m.target.guns[0].x,t.x);
  p.pos.y=150;p.agl=150;p.ctl.bomb=true;s.weapons(p,SIM_DT);assert.equal(p.bombs,1);assert.equal(s.bombs.length,0);
  p.pos.y=30;p.agl=30;p.vel.set(95,0,0);p.speed=95;p.q.setHPR(Math.PI/2,0,0);p.updateBasis();
  s.weapons(p,SIM_DT);assert.equal(p.bombs,0);assert.equal(s.bombs[0].kind,'torpedo18');
  let n=0;while(!s.bombs[0]?.running&&n++<200)s.stepBombs(SIM_DT);
  assert.ok(s.bombs[0].running);assert.ok(Math.abs(Math.hypot(s.bombs[0].vx,s.bombs[0].vz)-45)<1e-6);
  const weapon=s.bombs[0];weapon.x=t.x-200;weapon.z=t.z;weapon.vx=1000;weapon.vz=0;
  assert.equal(m.stepTorpedo(weapon,.4),true,'sweep catches a hull crossed within one frame');
  assert.equal(t.alive,false);assert.equal(m.playerHits,1);m.beforeStep(5);assert.ok(t.sink>0);assert.equal(m.target.guns[0].alive,false);
  p.pos.x=m.target.x-4500;p.pos.z=800;m.step(SIM_DT);assert.equal(s.result.winner,0);
  const failed=fresh('convoy');failed.player.bombs=0;for(const a of failed.mission.flight)a.bombs=0;failed.mission.lastDrop=0;failed.time=20;failed.mission.step(SIM_DT);assert.equal(failed.result.winner,1);
}
// Wingmen fly the low torpedo approach and release their own weapons; time alone cannot sink a ship.
{
  const s=fresh('convoy'),p=s.player,m=s.mission;for(const g of m.target.guns)g.alive=false;
  m.orderWingmen('strike');let releases=0;
  while(s.time<65) {
    const trim=16*DEG*(p.type.vs/Math.max(p.speed,p.type.vs))**2;
    p.ctl.pitch=clamp((trim+Math.atan2((100-p.pos.y)*.15,p.speed)-p.pitchAngle)*4-p.w.x*.25,-.5,.6);
    p.ctl.throttle=clamp(.3+(100-p.speed)*.04,.1,.7);
    s.step(SIM_DT);releases+=s.events.filter(e=>e.t==='bombdrop'&&!e.ac.isPlayer).length;s.events.length=0;
  }
  assert.equal(releases,3);assert.ok(m.target.halls.some(t=>!t.alive&&!t.escort),'physical wing torpedoes hit a moving merchant');
  assert.equal(m.playerDrops,0);
}
console.log('PASS: torpedo envelope, moving ships, water run, swept impacts, sinking and escape');

// Precision bombing damages the actual objective and explicitly checks nearby protected housing.
{
  const s=fresh('precision'),m=s.mission,t=m.target.halls[0];
  s.bombImpact({x:t.x,y:t.y,z:t.z,kind:'bomb500',team:0,owner:s.player},t.y);
  assert.equal(t.alive,false);assert.equal(m.collateral,0);assert.equal(m.playerHits,1);
  s.player.pos.z=1000;m.step(SIM_DT);assert.equal(s.result.winner,0);
  const bad=fresh('precision'),h=bad.mission.target.protected[1];
  bad.bombImpact({x:h.x,y:h.y,z:h.z,kind:'bomb500',team:0,owner:bad.player},h.y);bad.mission.step(SIM_DT);
  assert.ok(bad.mission.collateral>0);assert.equal(bad.result.winner,1);
  const strafe=fresh('precision'),house=strafe.mission.target.protected[1];
  assert.equal(strafe.bulletStructures(house.x,house.z,0,'cannon',strafe.player,5),true);strafe.mission.step(SIM_DT);assert.equal(strafe.result.winner,1);
  const miss=fresh('precision');miss.mission.approached=true;miss.player.pos.z=7000;miss.mission.step(SIM_DT);assert.equal(miss.result.winner,1);
}
console.log('PASS: precise hit/escape, protected housing and single-pass failure');
console.log('ALL OPERATION TESTS PASSED');
