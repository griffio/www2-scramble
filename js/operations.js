// Objective-driven sorties; all aircraft, guns, bombs and torpedoes use the shared simulation.
import { FactoryRaid } from './factory-raid.js';
import { SCENARIOS } from './scenarios.js';
import { clamp, DEG, G } from './math.js';
import { coastN, coastS } from './world.js';
import { BOMBS } from './types.js';

export class OperationsMission extends FactoryRaid {
  constructor(sim, { start = 'runway' } = {}) {
    super(sim, { start, populate: false });
    this.key = sim.world.scenario; this.spec = SCENARIOS[this.key];
    this.title = this.spec.title; this.orderKeys = this.spec.orders;
    this.orderHelp = {norway:'1 SUPPRESS · 2 COVER · 3 ROCKET ATTACK',convoy:'1 SUPPRESS · 2 COVER · 3 TORPEDO',precision:'1 SUPPRESS · 2 COVER · 3 HOLD',intercept:'1 BOMBERS · 2 ESCORTS · 3 FORM'}[this.key] || '1 ENGAGE · 2 ESCORT · 3 STRAGGLER';
    this.bombers = []; this.enemyEscort = []; this.recovered = new Set(); this.aborted = new Set(); this.delivered = new Set();
    this.wave = 0; this.approached = false; this.passComplete = false; this.collateral = 0; this.hits = 0;
    this.phaseText = 'FORM UP — FOLLOW YOUR WAYPOINT'; this.airborne = true; this.stage = 'operation';
    sim.playerTeam = this.key === 'intercept' ? 1 : 0;
    if(this.key==='fortress') sim.teams[0].name='USAAF';
    const norway = ['norway','fjord'].includes(this.key), strike = ['convoy', 'precision', 'norway', 'fjord'].includes(this.key), fortress = this.key === 'fortress';
    const group = sim.newGroup(sim.playerTeam, 'flight', { order: this.orderKeys[1], cruiseAlt: strike ? 90 : fortress ? 2700 : 1100, wide: 2 });
    sim.playerGroup = group; sim.playerType = this.spec.type;
    let x = strike ? this.target.x - (['convoy','norway','fjord'].includes(this.key)?(this.quickStart?3500:8000):0) : -6700;
    let z = strike ? (['convoy','norway','fjord'].includes(this.key)?this.target.z:this.target.z-(this.quickStart?3300:11000)) : this.quickStart?3800:-3000;
    let alt = strike ? ['convoy','norway','fjord'].includes(this.key)?35:100 : fortress?2800:1150;
    let hdg = ['convoy','norway','fjord'].includes(this.key)?Math.PI/2:Math.PI, speed = this.key==='convoy'?95:norway?125:strike?135:150;
    if(this.key==='intercept') { x=this.quickStart?-3200:-3000; z=this.quickStart?7800:3500; hdg=-Math.PI/2; alt=1450; }
    if(this.key==='rescue') { x=-6800; z=this.quickStart?3400:6000; hdg=0; alt=550; speed=105; }
    for(let i=0;i<4;i++) {
      const ac=this.aircraft(sim.playerTeam,this.spec.type,group,x+i*85,alt+i*(this.key==='convoy'?3:20),z-i*100,hdg,speed,i===0);
      this.flight.push(ac); ac.opRole='wing';
    }
    if(!strike) this.populateBombers(fortress);
    this.route = strike ? [{name:this.target.name,x:this.target.x,z:this.target.z,agl:['convoy','norway','fjord'].includes(this.key)?30:85}] : this.bomberRoute;
    this.escapeRoute = [{ name: ['convoy','norway','fjord'].includes(this.key)?'ESCAPE WEST — CLEAR THE SHIPPING':'CLEAR THE COAST — RETURN NORTH',
      x:['convoy','norway','fjord'].includes(this.key)?this.target.x-5500:-11000,z:['convoy','norway','fjord'].includes(this.key)?800:1200,agl:60 }];
    this.shot='air-starboard';
    sim.radio(sim.playerTeam, `${this.title}: ${this.spec.brief}`, 'control', `${this.key}_intro`);
  }

  aircraft(team,type,group,x,y,z,hdg,speed,player=false) {
    const ac=this.sim.spawn(team,type,group,{player,air:{x,y,z,hdg,speed}});
    ac.q.setHPR(hdg,16*DEG*(ac.type.vs/speed)**2,0); ac.updateBasis();
    ac.agl=y-this.sim.world.groundAt(x,z); if(ac.pilot) ac.pilot.state='navigate';
    return ac;
  }

  populateBombers(fortress) {
    const sim=this.sim, rescue=this.key==='rescue', n=rescue?1:6;
    const altitude=fortress?2500:rescue?480:950;
    const g=sim.newGroup(0,'raid',{cruiseAlt:altitude,wide:2,gtarget:this.target.halls[0]});
    this.bomberRoute=rescue?[
      {name:'DAMAGED BOSTON — COVER ITS TAIL',x:-7200,z:1500,agl:400},
      {name:'ENGLISH COAST — BRING THE CREW HOME',x:-7200,z:coastN(-7200)-500,agl:400},
    ]:[
      {name:'RENDEZVOUS — STAY WITH THE BOMBERS',x:-7000,z:5000,agl:altitude},
      {name:'BOMB RUN — PROTECT THE FORMATION',x:this.target.x,z:this.target.z,agl:altitude},
      {name:'CLEAR THE TARGET',x:-7000,z:14500,agl:altitude},
      {name:'TURN FOR HOME',x:-11500,z:14500,agl:altitude},
      {name:'HOMEWARD — PROTECT THE STRAGGLER',x:-11500,z:3500,agl:altitude},
      {name:fortress?'WESTERN HANDOVER — ESCORT COMPLETE':'ENGLISH COAST — BOMBERS RECOVERED',x:-11500,z:coastN(-11500)-650,agl:altitude},
    ];
    for(let i=0;i<n;i++) {
      const z=rescue?(this.quickStart?2700:5300):this.quickStart?4400:-2400;
      const ac=this.aircraft(0,fortress?'b17':'boston',g,-7000+(i%3-1)*100,altitude+Math.floor(i/3)*35,z-Math.floor(i/3)*160,rescue?0:Math.PI,rescue?88:105);
      ac.opRole='bomber'; ac.routeIndex=0; ac.opOffset=(i%3-1)*95; this.bombers.push(ac);
      if(rescue) { ac.hp=ac.type.hp*.48; ac.engineDmg=.32; ac.smoke=.5; ac.bombs=0; }
    }
    if(this.key==='intercept') {
      const eg=sim.newGroup(0,'escort',{escortOf:g,cruiseAlt:1300});
      for(let i=0;i<2;i++) {const ac=this.aircraft(0,'spitfire',eg,-7400-i*180,1300,4050,Math.PI,155); ac.opRole='enemyEscort'; this.enemyEscort.push(ac);}
    }
  }

  holdWingman() { return false; }
  get canContinueHome() { return false; }
  get wingOrderLabel() { return this.sim.playerGroup.order.toUpperCase(); }
  get groundTargets() { return [...this.target.halls,...this.target.guns,...this.target.protected]; }
  get waypoint() {
    if(['convoy','precision','norway'].includes(this.key)) return this.escaped||this.hits>0?this.escapeRoute[0]:this.route[0];
    if(this.key==='intercept') return {name:'INTERCEPT THE BOMBERS BEFORE RELEASE',x:this.leadBomber?.pos.x??this.target.x,z:this.leadBomber?.pos.z??this.target.z,agl:1100};
    const b=this.guardBomber;
    return b?{name:this.bomberRoute[Math.min(b.routeIndex,this.bomberRoute.length-1)].name,x:b.pos.x,z:b.pos.z,agl:Math.max(100,b.agl)}:this.bomberRoute.at(-1);
  }
  get leadBomber() { return this.bombers.find(b=>b.alive&&!this.recovered.has(b)); }
  get guardBomber() { const b=this.bombers.filter(b=>b.alive&&!this.recovered.has(b)); return b.sort((a,b)=>a.hp/a.type.hp-b.hp/b.type.hp)[0]; }
  get defenceState() { return this.sim.time<this.underFireUntil?'INCOMING FIRE — BREAK!':`${this.interceptors.filter(a=>a.alive).length} INTERCEPTORS · ${this.activeGuns} AA GUNS`; }
  get statusText() {
    if(this.key==='convoy') return `${this.target.halls.filter(t=>!t.alive&&!t.escort).length}/2 SUNK · ${this.torpedoReleaseStatus(this.sim.player)}`;
    if(this.key==='norway') return `${this.target.halls.filter(t=>!t.alive&&!t.escort).length}/${this.target.halls.filter(t=>!t.escort).length} MERCHANTS SUNK · ${this.sim.player.bombs} ROCKETS`;
    if(this.key==='precision') return `${this.playerHits} BOMB HITS · HOUSING ${this.collateral?'HIT':'CLEAR'} · B RELEASE`;
    if(this.key==='intercept') return `${this.stoppedBombers}/3 BOMBERS STOPPED · ${this.delivered.size} RELEASED`;
    return `${this.bombers.filter(b=>b.alive||this.recovered.has(b)).length}/${this.bombers.length} BOMBERS · ${this.recovered.size} RECOVERED`;
  }
  get stoppedBombers() { return this.bombers.filter(b=>(!b.alive||this.aborted.has(b))&&!this.delivered.has(b)).length; }

  orderWingmen(order) {
    if(!this.orderKeys.includes(order)) return false;
    this.sim.playerGroup.order=order;
    for(const a of this.flight) if(a.pilot) { a.pilot.thinkT=0; a.pilot.target=null; a.pilot.gtarget=null; a.pilot.state='navigate'; }
    this.sim.radio(this.sim.playerTeam,`LEADER: ${order.toUpperCase()}.`, 'control', this.key==='norway'&&order==='strike'?'norway_order_strike':`mission_order_${order}`); return true;
  }

  thinkPilot(pilot) {
    const a=pilot.ac, order=this.sim.playerGroup.order;
    if(a.opRole==='bomber') {pilot.state='navigate'; return;}
    if(a.opRole==='raider'||a.opRole==='enemyEscort') {
      if(a.hp<a.type.hp*.2 || this.sim.time > (a.attackUntil ?? Infinity)) {pilot.state='rtb'; return;}
      let targets=['intercept','fjord'].includes(this.key)?this.flight:this.bombers.filter(b=>!this.recovered.has(b));
      if(a.opRole==='enemyEscort') targets=this.flight;
      const candidates=targets.filter(b=>b.alive);
      candidates.sort((b,c)=>a.pos.dist(b.pos)-a.pos.dist(c.pos));
      pilot.target=candidates[0]||this.sim.player; pilot.state=pilot.target?.alive?'attack':'rtb'; return;
    }
    if(a.opRole==='wing') {
      if(a.hp<a.type.hp*.22) {pilot.state='rtb';return;}
      if(order==='suppress') {
        if(pilot.state==='strafe'&&(pilot.strafePhase==='off'||pilot.gtarget?.alive)) return;
        const t=this.pickSuppressionTarget(pilot);
        if(t) {pilot.gtarget=t;pilot.state='strafe';pilot.strafePhase='in';pilot.strafeT=0;pilot.strafeEntry={x:t.x-1300,z:t.z-800};return;}
      }
      if(order==='strike'&&a.bombs) {pilot.state='navigate';return;}
      let targets=[];
      if(this.key==='intercept'&&order==='bombers') targets=this.bombers.filter(b=>!this.aborted.has(b)&&!this.delivered.has(b));
      else if(this.key==='intercept'&&order==='escorts') targets=this.enemyEscort;
      else if(order==='engage'||order==='cover'||order==='straggler'||order==='close') targets=this.interceptors;
      const guard=order==='straggler'?this.guardBomber:order==='close'?this.leadBomber:this.sim.player;
      targets=targets.filter(b=>b.alive&&(this.key==='intercept'||b.pos.dist(guard?.pos||a.pos)<(order==='engage'?6000:2200)));
      targets.sort((b,c)=>a.pos.dist(b.pos)-a.pos.dist(c.pos));
      if(targets[0]) {pilot.target=targets[0];pilot.state='attack';return;}
      pilot.state='navigate';pilot.target=null;return;
    }
  }

  flyLevel(pilot,x,y,z,speed) {
    const a=pilot.ac, dx=x-a.pos.x,dz=z-a.pos.z,d=Math.hypot(dx,dz)||1;
    const slope=clamp((y-a.pos.y)/Math.max(500,Math.min(d,1500)),-.2,.25);
    const trim=16*DEG*(a.type.vs/Math.max(a.speed,45))**2;
    pilot.want.set(dx/d,slope+trim,dz/d); pilot.thr=clamp(.65+(speed-a.speed)*.025,.18,1);
  }

  navigatePilot(pilot,dt) {
    const a=pilot.ac;
    if(a.opRole==='bomber') {
      const route=this.bomberRoute, w=route[Math.min(a.routeIndex,route.length-1)];
      const d=Math.hypot(w.x-a.pos.x,w.z-a.pos.z);
      if(d<650) {
        if(a.routeIndex===route.length-1) { this.recovered.add(a); this.sim.removeAircraft(a); return; }
        a.routeIndex++;
      }
      const next=route[Math.min(a.routeIndex,route.length-1)];
      const speed=this.key==='rescue'?88:a.hp<a.type.hp*.65?92:105;
      this.flyLevel(pilot,next.x+a.opOffset,next.agl+this.sim.world.groundAt(next.x,next.z),next.z,speed);
      if(this.key!=='rescue'&&!this.aborted.has(a)&&a.routeIndex<=2&&a.bombs) {
        const t=this.target.halls[this.bombers.indexOf(a)%this.target.halls.length];
        const fall=Math.sqrt(2*Math.max(1,a.pos.y-t.y)/G);
        const along=(t.x-a.pos.x)*a.fwd.x+(t.z-a.pos.z)*a.fwd.z;
        const cross=Math.abs((t.x-a.pos.x)*a.fwd.z-(t.z-a.pos.z)*a.fwd.x);
        if(along>0&&along<a.speed*fall+50&&cross<230) a.ctl.bomb=true;
      }
      return;
    }
    if(this.key==='convoy'&&this.sim.playerGroup.order==='strike'&&a.bombs) {
      const t=this.target.halls.find(t=>t.alive&&!t.escort);
      if(t) {
        const d=Math.hypot(t.x-a.pos.x,t.z-a.pos.z), time=d/45;
        const x=t.x-Math.sin(t.yaw)*t.speed*time,z=t.z-Math.cos(t.yaw)*t.speed*time;
        this.flyLevel(pilot,x,28,z,95);
        const dot=((x-a.pos.x)*a.fwd.x+(z-a.pos.z)*a.fwd.z)/(Math.hypot(x-a.pos.x,z-a.pos.z)||1);
        if(d<1400&&d>450&&dot>.995&&this.torpedoEnvelope(a)) a.ctl.bomb=true;
        return;
      }
    }
    if(['norway','fjord'].includes(this.key)&&this.sim.playerGroup.order==='strike'&&a.bombs) {
      const targets=this.target.halls.filter(t=>t.alive&&(this.key==='fjord'?t.primary:!t.escort));
      const t=targets[(this.flight.indexOf(a)-1)%targets.length];
      if(t) {
        const d=Math.hypot(t.x-a.pos.x,t.z-a.pos.z),travel=d/(a.speed+BOMBS.rocket25.velocity);
        const x=t.x-Math.sin(t.yaw)*t.speed*travel,z=t.z-Math.cos(t.yaw)*t.speed*travel;
        // Complete the run and turn clear before lining up for another pass.
        if(a.rocketBreakUntil>this.sim.time) {
          this.flyLevel(pilot,a.pos.x+a.fwd.x*1200,80,a.pos.z+a.fwd.z*1200,125);return;
        }
        if(d<180){a.rocketBreakUntil=this.sim.time+9;return;}
        this.flyLevel(pilot,x,32,z,125);
        const aimY=8+.5*G*travel*travel+.75;
        const pitch=Math.atan2(aimY-a.pos.y,Math.max(1,d));
        const yawDot=((x-a.pos.x)*a.fwd.x+(z-a.pos.z)*a.fwd.z)/(Math.hypot(x-a.pos.x,z-a.pos.z)||1);
        if(d<900&&d>250&&yawDot>.999&&Math.abs(a.pitchAngle-pitch)<.025) a.ctl.bomb=true;
        // Aim the aircraft at the compensated impact point during the firing run.
        if(d<1000){pilot.want.set((x-a.pos.x)/d,(aimY-a.pos.y)/d,(z-a.pos.z)/d);}
        return;
      }
    }
    let lead=this.sim.player;
    if(['escort','rescue','fortress'].includes(this.key)) lead=this.sim.playerGroup.order==='straggler'?this.guardBomber:this.leadBomber;
    if(!lead?.alive) lead=this.sim.player;
    const index=this.flight.indexOf(a), slot=150+index*65;
    this.flyLevel(pilot,lead.pos.x+lead.fwd.x*300+lead.right.x*(index%2?slot:-slot),lead.pos.y+80,lead.pos.z+lead.fwd.z*300+lead.right.z*(index%2?slot:-slot),clamp(lead.speed+clamp(a.pos.dist(lead.pos)*.03-15,-15,45),80,175));
  }

  launchWave() {
    const sim=this.sim, target=this.guardBomber||sim.player;
    const g=sim.newGroup(1,'intercept',{cruiseAlt:target.pos.y+250});
    for(let i=0;i<(this.key==='rescue'?1:2);i++) {
      const a=this.aircraft(1,this.wave%2?'fw190':'bf109',g,target.pos.x+2400+i*180,target.pos.y+300,target.pos.z-500-i*180,-Math.PI/2,155);
      a.opRole='raider'; a.attackUntil=sim.time+(this.key==='rescue'?32:65); this.interceptors.push(a);
    }
    this.wave++;sim.radio(sim.playerTeam,`CONTROL: ${this.wave===1?'Inbound':'Final'} fighter attack! ${['precision','norway'].includes(this.key) ? 'Cover the withdrawal.' : 'Stay with the bombers.'}`, 'alert', ['precision','norway'].includes(this.key)?'precision_fighters':this.wave===1?'fighters_inbound':'fighters_final');
  }

  beforeStep(dt) {
    if(!['convoy','norway','fjord'].includes(this.key)) return;
    for(const t of this.target.halls) {
      if(t.alive) { t.x-=Math.sin(t.yaw)*t.speed*dt;t.z-=Math.cos(t.yaw)*t.speed*dt; }
      else t.sink=Math.min(24,t.sink+dt*.3);
    }
    for(const g of this.target.guns) {
      const v=g.vessel;if(!v)continue;const sin=Math.sin(v.yaw),cos=Math.cos(v.yaw);
      g.x=v.x+cos*(g.mountX??0)+sin*(g.mountZ??0);
      g.z=v.z-sin*(g.mountX??0)+cos*(g.mountZ??0);
      g.y=(g.mountY??10)-v.sink;if(!v.alive)g.alive=false;
    }
    this.target.x=this.target.halls[0].x;this.target.z=this.target.halls[0].z;
  }
  torpedoEnvelope(a) {return a.agl>=15&&a.agl<=45&&a.speed>=70&&a.speed<=115&&Math.abs(a.bankAngle)<12*DEG&&Math.abs(a.vel.y)<6&&this.sim.world.heightAt(a.pos.x,a.pos.z)<=0;}
  torpedoReleaseStatus(a) {
    if (!a.bombs) return 'TORPEDO EXPENDED';
    if (a.state !== 'air') return 'GET AIRBORNE';
    if (this.sim.world.heightAt(a.pos.x,a.pos.z)>0) return 'GET OVER WATER';
    if (a.agl<15) return 'CLIMB · AIM 100 FT';
    if (a.agl>45) return 'DESCEND · AIM 100 FT';
    if (a.speed<70) return 'SPEED UP · AIM 210 MPH';
    if (a.speed>115) return 'SLOW DOWN · AIM 210 MPH';
    if (Math.abs(a.bankAngle)>=12*DEG) return 'LEVEL THE WINGS';
    if (Math.abs(a.vel.y)>=6) return 'STEADY THE HEIGHT';
    return 'RELEASE READY · B / RMB';
  }
  canReleaseWeapon(a) {
    if(this.key==='norway') return true;
    if(a.type.bombKind!=='torpedo18'||this.torpedoEnvelope(a)) return true;
    if(a.isPlayer&&this.sim.time-(this.lastReleaseWarning??-10)>4) {this.lastReleaseWarning=this.sim.time;this.sim.radio(a.team,'OBSERVER: Hold release. Aim for 100 feet and 210 mph over water. Wings level, steady height.','alert','torpedo_hold');}
    return false;
  }
  stepTorpedo(b,dt) {
    if(!b.running) return false;
    const ox=b.x,oz=b.z;b.x+=b.vx*dt;b.z+=b.vz*dt;
    if(this.sim.world.heightAt(b.x,b.z)>0||b.t>100) return true;
    for(const t of this.target.halls) {
      if(!t.alive) continue;
      // Sweep the whole frame in each ship's heading frame, including the hull's beam.
      const sin=Math.sin(t.yaw),cos=Math.cos(t.yaw), dx=b.x-ox,dz=b.z-oz;
      let lo=0,hi=1;
      const axes=[[cos*(ox-t.x)-sin*(oz-t.z),cos*dx-sin*dz,t.beam/2+1],[-sin*(ox-t.x)-cos*(oz-t.z),-sin*dx-cos*dz,t.length/2+1]];
      for(const [p,v,r] of axes) {if(Math.abs(v)<1e-9){if(Math.abs(p)>r)hi=-1;}else{let a=(-r-p)/v,c=(r-p)/v;if(a>c)[a,c]=[c,a];lo=Math.max(lo,a);hi=Math.min(hi,c);}}
      if(lo<=hi&&hi>=0&&lo<=1) {
        b.x=ox+dx*clamp(lo,0,1);b.z=oz+dz*clamp(lo,0,1);
        this.sim.damageStructure(t,240,b.owner);this.hits++;if(b.owner?.isPlayer)this.playerHits++;
        this.sim.ev({t:'explode',x:b.x,y:1,z:b.z,size:4,kind:'water'});return true;
      }
    }
    return false;
  }
  bombDropped(a) {
    if(a.opRole==='bomber') {
      if(!this.delivered.size&&this.key!=='intercept') this.sim.radio(this.sim.playerTeam,'BOMBER LEADER: Bombs away. Keep formation.', 'wing', 'bomber_bombs_away');
      this.delivered.add(a);return;
    }
    if(a.isPlayer) {
      this.playerDrops++;this.lastDrop=this.sim.time;this.releaseTime??=this.sim.time;
      if(this.playerDrops===1) this.sim.radio(a.team,this.key==='convoy'?'OBSERVER: Torpedo away! Break clear of the ship.':this.key==='norway'?'NAVIGATOR: Rockets away! Keep firing into the merchant.':'NAVIGATOR: Bombs away! Clear the target.', 'wing', this.key==='convoy'?'torpedo_away':this.key==='norway'?'norway_rockets_away':'precision_bombs_away');
    }
  }
  bombDetonated(b) {
    super.bombDetonated(b);
    if(this.key!=='precision') return;
    for(const t of this.target.protected) if(t.alive&&Math.hypot(t.x-b.x,t.z-b.z)<t.r+BOMBS.bomb500.radius) {
      this.sim.damageStructure(t,100,b.owner);
    }
  }

  get resultVoice() {
    if(!this.sim.player.alive) return 'mission_aircraft_lost';
    if(this.key==='precision'&&this.collateral) return 'precision_collateral';
    const won=this.sim.result?.winner===this.sim.playerTeam;
    return `${this.key}_${won?'success':'failed'}`;
  }

  structureHit(target, damage) { if(this.key==='precision' && target.kind==='housing' && damage>0) this.collateral++; }

  makeDebrief(won) {
    const p=this.sim.player, living=this.bombers.filter(b=>b.alive||this.recovered.has(b)).length;
    const integrity=Math.round(Math.max(0,p.hp/p.type.hp)*100), wingmen=this.flight.filter(a=>a!==p&&a.alive).length;
    const rating=clamp(Math.round((won?40:0)+(this.bombers.length?(['intercept'].includes(this.key)?this.stoppedBombers/6:living/this.bombers.length)*40:Math.min(1,this.hits||this.playerHits)*40)+integrity*.1+wingmen/3*10),0,100);
    const totalScore=Math.round((won?1000:0)+(this.key==='intercept'?this.stoppedBombers*1000:this.recovered.size*1200)+this.target.halls.filter(t=>!t.alive).length*600+this.sim.playerStats.kills*150+wingmen*200+integrity*3);
    return {totalScore,grade:!won?'D':rating>=90?'S':rating>=75?'A':rating>=60?'B':'C',rating,integrity,wingmen,
      rows:[['BOMBERS RECOVERED',`${this.recovered.size}/${this.bombers.length}`],['BOMBERS STOPPED',this.stoppedBombers],['BOMBERS RELEASED',this.delivered.size],['TARGETS DESTROYED',this.target.halls.filter(t=>!t.alive).length],[this.key==='norway'?'ROCKET HITS / FIRED':'BOMB / TORPEDO HITS',`${this.playerHits}/${this.playerDrops}`],['HOUSING HIT',this.collateral],['WINGMEN SURVIVING',`${wingmen}/3`],['AIR KILLS',this.sim.playerStats.kills],['AIRCRAFT REMAINING',`${integrity}%`]].filter(([label])=>this.bombers.length?!['TARGETS DESTROYED','BOMB / TORPEDO HITS','HOUSING HIT'].includes(label):!label.startsWith('BOMBERS')&&(this.key==='precision'||label!=='HOUSING HIT'))};
  }

  step(dt) {
    if(this.complete)return;
    const sim=this.sim,p=sim.player,t=sim.time;
    if(!p.alive) {this.failureTime??=t;if(t-this.failureTime>3)this.finish(false,'Your aircraft was lost. Retry the sortie.');return;}
    this.shot=this.key==='precision'&&this.lastDrop!==null&&t-this.lastDrop<18?'rear':Math.floor(t/12)%2?'air-port':'air-starboard';
    if(['convoy','precision','norway'].includes(this.key)) {
      const d=Math.hypot(p.pos.x-this.target.x,p.pos.z-this.target.z);
      if(d<1900&&!this.approached) {
        this.approached=true;sim.radio(sim.playerTeam,this.key==='convoy'?'OBSERVER: Convoy in sight. Line up a merchant.':this.key==='norway'?'NAVIGATOR: Shipping in sight. Close to rocket range.':'NAVIGATOR: Headquarters ahead. Keep the houses clear.', 'control',this.key==='convoy'?'convoy_approach':this.key==='norway'?'norway_approach':'precision_target');
      }
      this.hits=this.target.halls.filter(t=>!t.alive&&!t.escort).length;
      if(this.key==='precision'&&!this.playerHits)this.hits=0;
      const pending=sim.bombs.some(b=>b.team===sim.playerTeam);
      // The full sortie starts west of the escape boundary. A release on the
      // inbound leg is not a retreat; first reach the convoy, then leave west.
      const norwayWithdrawn=this.key==='norway'&&this.approached&&p.pos.x<this.target.x-4000;
      if(norwayWithdrawn&&!this.hits&&!pending){this.finish(false,'The flight withdrew without sinking a merchant ship.');return;}
      if(this.key==='precision') {
        this.phaseText=this.playerHits?'BOMBS ON TARGET — ESCAPE NORTH':'ONE PASS — HIT HEADQUARTERS · KEEP HOUSING CLEAR';
        if(this.lastDrop!==null&&this.wave===0&&t>this.lastDrop+12)this.launchWave();
        if(this.collateral) {this.finish(false,'The occupied housing was hit. Precision objective failed.');return;}
        if(this.approached&&d>2000&&!pending) {this.passComplete=true;if(!this.hits){this.finish(false,'The single bombing pass failed to destroy the headquarters.');return;}}
      } else if(this.key==='convoy') {
        this.phaseText=this.hits?'SHIP HIT — ESCAPE WEST OR PRESS THE ATTACK':'SUPPRESS THE GUNS · LEAD THE SHIP · B RELEASES TORPEDO';
        if(!p.bombs&&!pending&&!this.hits&&!this.flight.some(a=>a.alive&&a.bombs)&&t-(this.lastDrop??t)>12){this.finish(false,'All torpedoes expended without sinking a merchant.');return;}
      } else {
        this.phaseText=this.hits?'SHIPPING HIT — BREAK WEST':'CLOSE TO ROCKET RANGE · FIRE B INTO MERCHANT HULLS';
        if(this.playerDrops>0&&this.wave===0&&t>(this.releaseTime??t)+12)this.launchWave();
        if(!p.bombs&&!pending&&!this.hits&&!this.flight.some(a=>a.alive&&a.bombs)&&t-(this.lastDrop??t)>5){this.finish(false,'The rocket attack failed to sink a merchant ship.');return;}
      }
      const escaped=this.key==='norway'?norwayWithdrawn:this.key==='convoy'?p.pos.x<this.target.x-4000:p.pos.z<coastS(p.pos.x)-200;
      if(this.hits&&escaped) {this.escaped=true;this.finish(true,this.key==='convoy'?`${this.hits} merchant ship(s) sunk. Strike flight clear of the convoy.`:this.key==='norway'?`${this.hits} German merchant ship(s) sunk with armour-piercing rockets. The flight escaped west.`:'Headquarters destroyed, housing spared. You escaped to the Channel.');}
      return;
    }
    for(const b of this.bombers) if(b.alive&&!this.delivered.has(b)&&b.hp<b.type.hp*.4&&!this.aborted.has(b)&&this.key!=='rescue') {
      this.aborted.add(b);b.routeIndex=Math.max(b.routeIndex,3);b.bombs=0;sim.radio(sim.playerTeam,`${b.callsign}: Too badly damaged. Aborting the bomb run.`, 'alert', 'bomber_abort');
    }
    if(this.key==='intercept') {
      this.phaseText='BREAK UP THE BOMBER FORMATION BEFORE RELEASE';
      if(this.stoppedBombers>=3) {this.finish(true,'Three bombers stopped before release. The raid has been broken up.');return;}
      if(this.delivered.size>=4||this.bombers.every(b=>!b.alive||this.recovered.has(b)||this.delivered.has(b)||this.aborted.has(b)))this.finish(false,'Too many bombers delivered their loads. The depot was hit.');
      return;
    }
    const homeward=this.bombers.some(b=>b.routeIndex>=4), rescue=this.key==='rescue';
    if(!rescue&&!this.bombRunCalled&&this.bombers.some(b=>b.alive&&b.routeIndex===1&&Math.hypot(b.pos.x-this.target.x,b.pos.z-this.target.z)<3500)) {
      this.bombRunCalled=true;sim.radio(sim.playerTeam,'BOMBER LEADER: Starting the bomb run. Hold formation.', 'wing','bomber_bomb_run');
    }
    if(homeward&&!this.homewardCalled) {
      this.homewardCalled=true;sim.radio(sim.playerTeam,'CONTROL: Formation turning for home. Stay with the stragglers.', 'control','escort_homeward');
    }
    this.phaseText=rescue?'STAY WITH THE DAMAGED BOSTON — COVER ITS TAIL':homeward?'HOMEWARD — GUARD THE DAMAGED STRAGGLER':'CLOSE ESCORT — WATCH FOR DIVING FIGHTERS';
    if(this.wave===0&&t>(this.quickStart||rescue?10:35))this.launchWave();
    else if(this.wave===1&&(rescue?t>(this.quickStart?38:58):homeward))this.launchWave();
    if(!this.stragglerAnnounced&&homeward&&!rescue&&this.guardBomber) {
      const b=this.guardBomber;b.hp=Math.min(b.hp,b.type.hp*.58);b.engineDmg=Math.max(b.engineDmg,.15); b.smoke=Math.max(b.smoke,.45);
      this.stragglerAnnounced=true;sim.radio(0,`${b.callsign}: Engine trouble. Falling behind. Three orders your wingmen to protect the straggler.`, 'alert', 'bomber_straggler');
    }
    const remaining=this.bombers.filter(b=>b.alive&&!this.recovered.has(b));
    if(!remaining.length) this.finish(this.recovered.size>=(rescue?1:4),`${this.recovered.size} of ${this.bombers.length} bombers recovered. ${rescue?'The damaged crew needed your protection.':'Four recovered bombers required for success.'}`);
    if(t>850)this.finish(false,'Escort time expired before the formation reached safety.');
  }
}
