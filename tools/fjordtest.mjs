import assert from 'node:assert/strict';
import { World, fjordCentre, fjordWidth } from '../js/world.js';
import { Sim, SIM_DT } from '../js/sim.js';
import { TYPES } from '../js/types.js';
import { buildModels } from '../js/models.js';
import { DEG, clamp, mulberry32 } from '../js/math.js';
Math.random=mulberry32(1945);
const models=buildModels();for(const [key,type] of Object.entries(TYPES))type.geom=models.aircraft[key];
const w=new World({scenario:'fjord'});
const fresh=(start='coast',difficulty='normal')=>{w.resetTargets();return new Sim(w,{headless:true,raidStart:start,difficulty});};
for(let x=-7000;x<=3500;x+=200){assert.ok(w.heightAt(x,fjordCentre(x))<0,'water corridor');assert.ok(w.heightAt(x,fjordCentre(x)+fjordWidth(x)+1500)>350,'steep walls');}
for(const start of ['runway','coast']){
 const s=fresh(start),m=s.mission,p=s.player;
 assert.equal(p.type.key,'rocketbeau');assert.equal(p.bombs,8);assert.equal(p.type.geom.hardpoints.length,8);
 for(let i=0;i<120;i++)s.step(SIM_DT);
 assert.ok(p.alive);assert.ok(m.flight.every(a=>a.alive));assert.equal(s.result,null);
 assert.ok(m.target.halls.every(t=>w.heightAt(t.x,t.z)<0));
 assert.ok(m.target.guns.filter(g=>!g.vessel).every(g=>g.y>0));
 p.ctl.bomb=true;s.step(SIM_DT);assert.equal(m.playerDrops,1);assert.equal(s.result,null,'early firing cannot win or fail');
}
// Real weapon release and ballistic hull impact on Z33, then a physical exit boundary.
{
 const s=fresh(),m=s.mission,p=s.player,t=m.primary;
 p.placeInAir(t.x-650,32,t.z,Math.PI/2,120);
 const travel=650/440,pitch=Math.atan2(8+.75+.5*9.81*travel*travel-32,650);
 p.q.setHPR(Math.PI/2,pitch,0);p.updateBasis();p.ctl.bomb=true;
 for(let i=0;i<12;i++){s.weapons(p,SIM_DT);s.stepBombs(SIM_DT);}
 p.ctl.bomb=false;for(let i=0;i<240;i++)s.stepBombs(SIM_DT);
 assert.ok(m.primaryRocketHits>=2,'physical rockets strike the primary');
 m.step(SIM_DT);assert.ok(m.crippled);assert.ok(t.alive,'crippling does not require sinking');assert.equal(s.result,null);
 p.pos.set(-7000,45,fjordCentre(-7000));m.step(SIM_DT);
 assert.equal(s.result?.winner,0);assert.ok(m.escaped);assert.equal(m.debrief.rows.at(-1)[1],'YES');
 assert.ok(m.debrief.totalScore>2500);
}
// Secondary targets and cannon damage cannot satisfy the primary rocket objective.
{
 const s=fresh(),m=s.mission,p=s.player;
 for(const t of m.target.halls.slice(1))s.damageStructure(t,1000,p);
 s.damageStructure(m.primary,230,p);m.step(SIM_DT);assert.equal(m.crippled,false);
 p.pos.set(m.primary.x-500,40,m.primary.z);m.step(SIM_DT);
 p.pos.set(-7000,45,fjordCentre(-7000));m.step(SIM_DT);assert.equal(s.result?.winner,1);
}
// Fighter response is finite and a late second wave rewards an early withdrawal.
{
 const s=fresh(),m=s.mission,p=s.player;
 p.pos.set(m.primary.x-1500,45,m.primary.z);m.step(SIM_DT);
 assert.ok(m.defenceState.includes('24 SEC'));s.time=23;m.step(SIM_DT);assert.equal(m.wave,0);
 s.time=24;m.step(SIM_DT);assert.equal(m.wave,1);assert.equal(m.interceptors.length,2);
 assert.ok(m.interceptors.every(a=>a.type.key==='fw190'&&a.attackUntil===89));
 s.time=90;m.step(SIM_DT);assert.equal(m.wave,2);s.time=160;m.step(SIM_DT);assert.equal(m.wave,2);
}
// Wingmen must steer, fire and land rockets using normal flight and shared weapons.
{
 const s=fresh(),m=s.mission,p=s.player;
 for(const g of m.target.guns)g.alive=false;m.launchWave=()=>{m.wave++;};
 m.orderWingmen('suppress');assert.ok(m.flight.slice(1).every(a=>a.bombs===8));m.orderWingmen('strike');
 let fired=0;
 while(s.time<95&&!m.crippled){
   const trim=16*DEG*(p.type.vs/Math.max(p.speed,45))**2;
   p.ctl.pitch=clamp((trim+Math.atan2((80-p.pos.y)*.15,p.speed)-p.pitchAngle)*4,-.5,.5);
   p.ctl.throttle=clamp(.3+(120-p.speed)*.04,.1,.8);
   s.step(SIM_DT);fired+=s.events.filter(e=>e.t==='bombdrop'&&!e.ac.isPlayer).length;s.events.length=0;
 }
 assert.ok(fired>0,'wingmen release rockets');assert.ok(m.crippled,'wingmen hit Z33');assert.equal(m.playerDrops,0);
 m.orderWingmen('cover');assert.ok(m.flight.slice(1).every(a=>!a.ctl.bomb));
 console.log(`PASS: physical wingman strike cripples Z33 in ${s.time.toFixed(1)}s with ${fired} releases`);
}
{
 const s=fresh(),m=s.mission;for(const a of m.flight)a.bombs=0;m.lastDrop=0;s.time=10;m.step(SIM_DT);assert.equal(s.result?.winner,1);
}
console.log('PASS: fjord terrain, starts, real rocket hits, primary objective, escape, finite response, orders and failures');
