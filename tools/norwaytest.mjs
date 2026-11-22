// Regression coverage for moving deck guns, solid-shot hull impacts, orders and sortie outcomes.
import assert from 'node:assert/strict';
import { World } from '../js/world.js';
import { TYPES } from '../js/types.js';
import { buildModels } from '../js/models.js';
import { Sim, SIM_DT } from '../js/sim.js';
import { DEG, clamp, mulberry32 } from '../js/math.js';
Math.random=mulberry32(1944);
const models=buildModels();for(const [k,t] of Object.entries(TYPES))t.geom=models.aircraft[k];
const w=new World({scenario:'norway'});
const fresh=(start='coast')=>{w.resetTargets();return new Sim(w,{headless:true,raidStart:start});};
// Firing during the inbound leg must not count as withdrawing from the convoy.
for(const start of ['runway','coast']) {
 const s=fresh(start),m=s.mission,p=s.player;
 p.ctl.bomb=true;s.step(SIM_DT);p.ctl.bomb=false;
 assert.equal(m.playerDrops,1);assert.equal(s.result,null,`${start}: an early rocket must not end the sortie`);
 for(let i=0;i<120;i++)s.step(SIM_DT);
 assert.equal(s.result,null,`${start}: the inbound leg continues after firing`);
}
// Only an actual westward withdrawal after reaching the convoy ends the attack.
{
 const s=fresh(),m=s.mission,p=s.player;
 p.pos.set(m.target.x-1000,35,m.target.z);m.step(SIM_DT);assert.ok(m.approached);
 p.pos.x=m.target.x+6000;m.step(SIM_DT);assert.equal(s.result,null,'overshooting east allows another pass');
 p.pos.x=m.target.x-4500;
 s.bombs.push({team:0});m.step(SIM_DT);assert.equal(s.result,null,'wait for weapons still in flight');
 s.bombs.length=0;m.step(SIM_DT);assert.equal(s.result?.winner,1,'withdrawing west without a merchant kill fails');
}
{
 const s=fresh('runway'),m=s.mission;
 m.target.halls[0].alive=false;m.step(SIM_DT);
 assert.equal(s.result,null,'a wingman kill cannot win while the player is still inbound');
}
{
 const s=fresh(),m=s.mission,p=s.player;
 assert.equal(p.bombs,8);assert.equal(p.type.bombKind,'rocket25');
 assert.equal(p.type.geom.hardpoints.length,8);
 for(let i=0;i<120;i++)s.step(SIM_DT);
 assert.ok(p.alive);assert.ok(m.target.guns.every(g=>g.vessel&&Math.abs(g.x-g.vessel.x-Math.cos(g.vessel.yaw)*g.mountX-Math.sin(g.vessel.yaw)*g.mountZ)<1e-6));
 assert.ok(m.flight.every(a=>a.bombs===8),'cover order cannot fire rockets');
 m.orderWingmen('strike');
 for(const a of m.flight.slice(1)){m.navigatePilot(a.pilot,SIM_DT);assert.ok(a.pilot.want.len()>0);}
 m.orderWingmen('cover');
 assert.equal(m.orderHelp,'1 SUPPRESS · 2 COVER · 3 ROCKET ATTACK');
}
// The larger convoy has a distinct destroyer with working light AA and heavy flak.
{
 const s=fresh(),m=s.mission,p=s.player,d=m.target.halls.find(t=>t.destroyer);
 assert.equal(m.target.halls.filter(t=>!t.escort).length,6);
 assert.equal(m.target.halls.length,8);assert.ok(models.statics.destroyer);
 assert.ok(m.statusText.includes('/6 MERCHANTS SUNK'));
 const guns=m.target.guns.filter(g=>g.vessel===d);
 assert.equal(guns.filter(g=>g.heavy).length,2);assert.equal(guns.filter(g=>!g.heavy).length,2);
 for(const g of m.target.guns)if(g.vessel!==d)g.alive=false;
 p.pos.set(d.x+250,35,d.z+400);p.vel.set(125,0,0);
 let lowAA=0,lowFlak=0;
 for(let i=0;i<900;i++){s.time+=SIM_DT;s.airDefence(SIM_DT);lowAA+=s.events.filter(e=>e.t==='gun'&&e.kind==='aa').length;lowFlak+=s.events.filter(e=>e.t==='flakfire').length;s.events.length=0;}
 assert.ok(lowAA>0);assert.equal(lowFlak,0,'heavy flak leaves a low attack window');
 p.pos.y=300;let highFlak=0;
 for(let i=0;i<900;i++){s.time+=SIM_DT;s.airDefence(SIM_DT);highFlak+=s.events.filter(e=>e.t==='flakfire').length;s.events.length=0;}
 assert.ok(highFlak>0,'destroyer fires actual flak shells at high aircraft');
 d.yaw=-.7;m.beforeStep(1);
 for(const g of guns){assert.ok(Number.isFinite(g.x+g.y+g.z));assert.ok(Math.abs(g.z-d.z+Math.sin(d.yaw)*g.mountX-Math.cos(d.yaw)*g.mountZ)<1e-6);}
 s.damageStructure(d,d.hp,p);m.beforeStep(SIM_DT);assert.ok(guns.every(g=>!g.alive));
 m.step(SIM_DT);assert.equal(m.hits,0,'destroyer is a bonus, not a merchant objective');
 console.log('PASS: six merchants, destroyer AA/flak, rotating deck mounts and sinking gun shutdown');
}
// Fire an aimed pair through normal weapon release and ballistic integration.
{
 const s=fresh(),m=s.mission,p=s.player,t=m.target.halls[0];
 p.pos.set(t.x-650,32,t.z);p.vel.set(125,0,0);p.speed=125;
 const travel=650/(445-t.speed),pitch=Math.atan2(8+.75+.5*9.81*travel*travel-32,650);
 p.q.setHPR(Math.PI/2,pitch,0);p.updateBasis();p.ctl.bomb=true;
 for(let i=0;i<20;i++){s.weapons(p,SIM_DT);s.stepBombs(SIM_DT);m.beforeStep(SIM_DT);}
 p.ctl.bomb=false;for(let i=0;i<240;i++){s.stepBombs(SIM_DT);m.beforeStep(SIM_DT);}
 assert.equal(p.bombs,5);assert.ok(!t.alive,'aimed rocket salvo sinks a moving merchant');
 assert.ok(m.playerHits>=2);assert.ok(s.playerStats.bombsHit>=2);
 m.step(SIM_DT);assert.ok(!s.result,'sinking alone requires an escape');
 p.pos.x=m.target.x-4500;m.step(SIM_DT);assert.equal(s.result?.winner,0);
 assert.ok(m.debrief.rows.some(([label])=>label==='ROCKET HITS / FIRED'));
}
// Swept collision catches a crossed hull; high and sideways misses cannot proximity-kill.
{
 const s=fresh(),m=s.mission,p=s.player,t=m.target.halls[0];
 const shot=(y,z)=>({x:t.x-200,y,z,vx:1000,vy:0,vz:0,team:0,owner:p,kind:'rocket25',rocket:true,t:0});
 s.bombs.push(shot(80,t.z));s.stepBombs(.4);assert.equal(t.hp,t.maxHp);
 s.bombs.length=0;s.bombs.push(shot(8,t.z+25));s.stepBombs(.4);assert.equal(t.hp,t.maxHp);
 s.bombs.length=0;s.bombs.push(shot(8,t.z));s.stepBombs(.4);assert.ok(t.hp<t.maxHp);
 s.bombs.length=0;
 for(const a of m.flight)a.bombs=0;m.playerDrops=8;m.lastDrop=0;s.time=10;m.step(SIM_DT);
 assert.equal(s.result?.winner,1,'empty flight without a kill ends in failure');
}
// Wingmen must physically steer, aim and hit on strike order.
{
 const s=fresh(),m=s.mission,p=s.player;
 m.launchWave=()=>{m.wave++;};for(const gun of m.target.guns)gun.alive=false;
 m.orderWingmen('strike');let fired=0;
 while(s.time<130&&!m.target.halls.some(t=>!t.alive&&!t.escort)) {
   const trim=16*DEG*(p.type.vs/Math.max(p.speed,45))**2;
   p.ctl.pitch=clamp((trim+Math.atan2((80-p.pos.y)*.15,p.speed)-p.pitchAngle)*4,-.5,.5);
   p.ctl.throttle=clamp(.3+(125-p.speed)*.04,.1,.8);
   s.step(SIM_DT);fired+=s.events.filter(e=>e.t==='bombdrop'&&!e.ac.isPlayer).length;s.events.length=0;
 }
 assert.ok(fired>0,'wingmen fire during physically flown attacks');
 assert.ok(m.target.halls.some(t=>!t.alive&&!t.escort),'wing rockets hit a moving merchant');
 assert.equal(m.playerDrops,0);
 console.log(`PASS: wingmen sink shipping with ${fired} rocket releases in ${s.time.toFixed(1)}s`);
}
console.log('PASS: Norway starts, moving AA mounts, orders, ballistic hits/misses, swept collisions, score, escape and failure');

// Exposed deck guns take shell hits before the hull, using their actual mount elevation.
{
 const s=fresh(),m=s.mission,p=s.player,ship=m.target.halls.find(t=>t.destroyer);
 for(const heavy of [false,true]) {
  const gun=m.target.guns.find(g=>g.vessel===ship&&g.heavy===heavy),hullHP=ship.hp;
  const rounds=Math.ceil(gun.maxHp/6);
  for(let i=0;i<rounds;i++) {
   s.bullets.add(gun.x-860*SIM_DT,gun.y+1,gun.z,860,0,0,0,0,p);
   s.stepBullets(SIM_DT);
  }
  assert.equal(gun.alive,false,'physical cannon rounds destroy the elevated deck mount');
  assert.equal(ship.hp,hullHP,'the hull cannot absorb a deck-gun hit');
 }
 const hp=ship.hp;
 for(let i=0;i<40;i++)assert.ok(s.bulletStructures(ship.x,ship.z,0,'cannon',p,8));
 assert.ok(Math.abs(ship.hp-(hp-20))<1e-8,'one second of four-cannon hits deals 20 hull HP');
 const before=ship.hp;s.bulletStructures(ship.x,ship.z,0,'mg',p,8);
 assert.ok(Math.abs(ship.hp-(before-.004))<1e-8,'rifle-calibre penetration is unchanged');
 console.log('PASS: physical cannon strikes destroy light/heavy deck AA, hull hits deal 0.5 HP, and MG penetration is unchanged');
}
