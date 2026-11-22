// Black Friday-inspired strike: a physical rocket attack, then a voluntary withdrawal.
import { OperationsMission } from './operations.js';
import { fjordCentre } from './world.js';
import { clamp, DEG } from './math.js';

export class FjordMission extends OperationsMission {
  constructor(sim, options = {}) {
    super(sim, options);
    this.orderHelp = '1 SUPPRESS · 2 REGROUP · 3 ATTACK Z33';
    this.attackAt = null; this.crippled = false; this.primaryRocketHits = 0;
    this.exitIndex = 0; this.ingressIndex = 0; this.lowTime = 0; this.zoneTime = 0;
    this.route = [-4800, -1900, 1800].map((x,i)=>({name:['FJORD MOUTH — STAY OVER WATER','THE DOGLEG — GUNS AHEAD','Z33 — ROCKETS AT 300–900 M'][i],x,z:fjordCentre(x),agl:40}));
    this.escapeRoute = [-1500,-4200,-7000].map((x,i)=>({name:['BREAK WEST — RECALL YOUR FLIGHT','FOLLOW THE WATER — KEEP LOW','OPEN SEA — BRING THEM HOME'][i],x,z:fjordCentre(x),agl:50}));
    const x=this.quickStart?-1800:-6800;
    this.ingressIndex=this.quickStart?2:0;
    for(const [i,a] of this.flight.entries()) {
      a.placeInAir(x-i*130,45+i*12,fjordCentre(x)+(i%2?110:-110),Math.PI/2,120);
      a.q.setHPR(Math.PI/2,16*DEG*(a.type.vs/120)**2,0);a.updateBasis();
      if(a.pilot)a.pilot.state='navigate';
    }
    this.phaseText='FOLLOW THE WATER · SUPPRESS GUNS BEFORE YOUR ROCKET RUN';
  }
  get primary() { return this.target.halls.find(t=>t.primary); }
  get waypoint() { return this.crippled?this.escapeRoute[this.exitIndex]:this.route[this.ingressIndex]; }
  get wingOrderLabel() { return {suppress:'SUPPRESS GUNS',cover:'REGROUP / COVER',strike:'ATTACK Z33'}[this.sim.playerGroup.order]; }
  get statusText() {
    const damage=Math.round((1-this.primary.hp/this.primary.maxHp)*100);
    return `Z33 ${!this.primary.alive?'SUNK':this.crippled?'CRIPPLED':damage+'% DAMAGE'} · ${this.sim.player.bombs} ROCKETS`;
  }
  get defenceState() {
    const fighters=this.interceptors.filter(a=>a.alive&&this.sim.time<a.attackUntil).length;
    if(this.attackAt!==null&&this.wave===0)return `FIGHTERS IN ${Math.max(0,Math.ceil(this.attackAt+24-this.sim.time))} SEC · ${this.activeGuns} GUNS`;
    return `${fighters} FIGHTERS · ${this.activeGuns} GUNS · STAY LOW`;
  }
  get resultVoice() { return this.sim.player.alive?`fjord_${this.escaped?'success':'failed'}`:'mission_aircraft_lost'; }
  rocketHit(target, owner) {
    // Only solid-shot hull impacts qualify; cannon remains useful against the guns.
    if(target.primary&&owner?.team===this.sim.playerTeam)this.primaryRocketHits++;
  }
  bombDropped(a) {
    if(a.team===this.sim.playerTeam)this.attackAt??=this.sim.time;
    if(!a.isPlayer)return;
    this.playerDrops++; this.lastDrop=this.sim.time; this.releaseTime??=this.sim.time;
    if(this.playerDrops===1)this.sim.radio(0,'NAVIGATOR: Rockets away. Watch the waterline, then break clear!', 'wing','fjord_rockets');
  }
  orderWingmen(order) {
    if(!this.orderKeys.includes(order))return false;
    this.sim.playerGroup.order=order;
    for(const a of this.flight)if(a.pilot){a.pilot.thinkT=0;a.pilot.target=null;a.pilot.gtarget=null;a.pilot.state='navigate';a.ctl.fire=a.ctl.bomb=false;}
    this.sim.radio(0,{suppress:'LEADER: Suppress the deck guns. Keep your rockets.',cover:'LEADER: Break off. Regroup and cover the withdrawal.',strike:'LEADER: Section, attack the destroyer. Rockets into the hull.'}[order],'control', {suppress:'mission_order_suppress',cover:'mission_order_cover',strike:'order_attack'}[order]);
    return true;
  }
  launchWave() {
    const sim=this.sim,p=sim.player;
    const g=sim.newGroup(1,'intercept',{cruiseAlt:850});
    for(let i=0;i<2;i++){
      const x=p.pos.x-2600-i*200;
      const a=this.aircraft(1,'fw190',g,x,850+i*80,fjordCentre(x),Math.PI/2,150);
      a.opRole='raider';a.attackUntil=sim.time+65;this.interceptors.push(a);
    }
    this.wave++;
    sim.radio(0,this.wave===1?'CONTROL: Focke-Wulfs entering the fjord. Finish your run and get clear!':'CONTROL: More fighters inbound. Bring the section out now!', 'alert','fjord_fighters');
  }
  step(dt) {
    if(this.complete)return;
    const sim=this.sim,p=sim.player,t=sim.time;
    if(!p.alive){this.failureTime??=t;if(t-this.failureTime>3)this.finish(false,'Your aircraft was lost inside the fjord. Retry from the approach.');return;}
    this.zoneTime+=dt;if(p.agl<90&&sim.world.heightAt(p.pos.x,p.pos.z)<0)this.lowTime+=dt;
    const d=Math.hypot(p.pos.x-this.primary.x,p.pos.z-this.primary.z);
    if(d<2200&&!this.approached){
      this.approached=true;this.attackAt??=t;
      sim.radio(0,'NAVIGATOR: Destroyer ahead. Two good rocket hits will cripple her. Suppress those guns!', 'control','fjord_target');
    }
    if(!this.crippled&&this.primaryRocketHits>=2&&this.primary.hp<=this.primary.maxHp*.5){
      this.crippled=true;this.hits=1;
      sim.radio(0,'NAVIGATOR: She is crippled! We can leave now. Another pass might sink her — your call, skipper.', 'good','fjord_crippled');
      sim.ev({t:'score',text:'Z33 CRIPPLED · ESCAPE OR PRESS THE ATTACK',pts:0});
    }
    if(!this.primary.alive&&!this.sunkAnnounced){this.sunkAnnounced=true;sim.radio(0,'NAVIGATOR: Destroyer sinking! Recall the section. West to open water!', 'good','fjord_sunk');}
    if(this.attackAt!==null){
      if(this.wave===0&&t>=this.attackAt+24)this.launchWave();
      else if(this.wave===1&&t>=this.attackAt+90&&p.pos.x>-4200)this.launchWave();
    }
    if(!this.crippled){
      const w=this.route[this.ingressIndex];
      if(this.ingressIndex<2&&(Math.hypot(p.pos.x-w.x,p.pos.z-w.z)<850||p.pos.x>w.x+300))this.ingressIndex++;
    }else{
      const w=this.escapeRoute[this.exitIndex];
      if(this.exitIndex<2&&(Math.hypot(p.pos.x-w.x,p.pos.z-w.z)<800||p.pos.x<w.x-250))this.exitIndex++;
    }
    this.phaseText=this.crippled?'Z33 CRIPPLED · ESCAPE WEST OR RISK ANOTHER PASS':'CRIPPLE Z33 · CANNON FOR GUNS · ROCKETS INTO THE HULL';
    if(this.crippled&&this.sim.playerGroup.order!=='cover')this.phaseText+=' · 2 RECALLS WINGMEN';
    const withdrawn=this.approached&&p.pos.x<-6500&&sim.world.heightAt(p.pos.x,p.pos.z)<0;
    const pending=sim.bombs.some(b=>b.team===0);
    if(withdrawn&&!pending){
      this.escaped=this.crippled;
      this.finish(this.crippled,this.crippled?`${this.primary.alive?'Z33 crippled':'Z33 sunk'}. Your aircraft reached open sea. ${this.flight.filter(a=>a.alive&&!a.isPlayer).length} wingmen survived.`:'The flight withdrew before crippling Z33. Land two rocket hits on the destroyer.');return;
    }
    if(!this.crippled&&!pending&&!this.flight.some(a=>a.alive&&a.bombs)&&t-(this.lastDrop??this.attackAt??t)>8){this.finish(false,'Rockets expended before Z33 was crippled. Suppress the guns, then aim for the hull.');return;}
    if(t>600)this.finish(false,'The strike window has closed. Retry and keep the attack moving.');
    this.shot=Math.floor(t/12)%2?'air-port':'air-starboard';
  }
  makeDebrief(won) {
    const p=this.sim.player,integrity=Math.round(clamp(p.hp/p.type.hp,0,1)*100);
    const wingmen=this.flight.filter(a=>!a.isPlayer&&a.alive).length;
    const guns=this.target.guns.filter(g=>!g.alive).length;
    const lowLevel=this.zoneTime?Math.round(this.lowTime/this.zoneTime*100):0;
    const sunk=!this.primary.alive;
    const rating=Math.round(clamp((won?45:0)+(sunk?15:0)+wingmen*8+integrity*.1+lowLevel*.06,0,100));
    const totalScore=Math.round((won?1800:0)+(sunk?1200:0)+wingmen*450+integrity*4+guns*100+this.sim.playerStats.kills*150+lowLevel*5);
    return {totalScore,rating,integrity,wingmen,grade:!won?'D':rating>=90?'S':rating>=75?'A':rating>=60?'B':'C',
      rows:[['Z33',sunk?'SUNK':this.crippled?'CRIPPLED':'OPERATIONAL'],['SECTION ROCKET HITS ON Z33',this.primaryRocketHits],['YOUR ROCKET HITS / FIRED',`${this.playerHits}/${this.playerDrops}`],['GUNS SILENCED',guns],['WINGMEN SURVIVING',`${wingmen}/3`],['LOW OVER WATER',`${lowLevel}%`],['AIR KILLS',this.sim.playerStats.kills],['AIRCRAFT REMAINING',`${integrity}%`],['OPEN SEA REACHED',this.escaped?'YES':'NO']]};
  }
}
