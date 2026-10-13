// AI pilots. Every AI aircraft is flown through the same stick/throttle inputs as the
// player's, by a bank-to-turn steering controller. Behaviours pick a desired direction and
// throttle; a safety layer (terrain, stall, map edge) overrides them.
import { V3, qrotInv, clamp, lerp, smoothstep, G, DEG } from './math.js';
import { GUNS } from './types.js';
import { MAP_HALF } from './world.js';

const _b = new V3(), _d = new V3(), _p = new V3(), _t = new V3(), _u = new V3();
const rnd = Math.random;

// Steer an aircraft toward world direction (dx,dy,dz). gUse limits the pull (0..1).
export function steer(ac, dx, dy, dz, gUse = 1, precise = false) {
  const l = Math.hypot(dx, dy, dz) || 1;
  qrotInv(ac.q, dx / l, dy / l, dz / l, _b);
  const ahead = -_b.z;
  const off = Math.acos(clamp(ahead, -1, 1));
  const rollErr = Math.atan2(_b.x, _b.y);
  const w = smoothstep(precise ? 0.06 : 0.035, precise ? 0.35 : 0.22, off);
  const bank = ac.bankAngle;
  const ctl = ac.ctl;
  // large errors: roll the target into the lift plane; small: hold wings near the bank a
  // co-ordinated turn toward it needs and fine-aim with pitch and rudder
  const levelRoll = clamp(-bank * 1.6 + clamp(_b.x / Math.max(ahead, 0.3), -0.5, 0.5) * 3.0, -1, 1);
  ctl.roll = clamp(w * rollErr * 2.8 + (1 - w) * levelRoll, -1, 1);
  const pe = Math.atan2(_b.y, Math.max(ahead, 0.05));
  let pc = pe * (precise ? 9 : 6);
  if (w > 0.3) pc = Math.max(pc, 0) * Math.max(0, Math.cos(rollErr)) ** 0.7 + (off > 1.2 && Math.abs(rollErr) < 0.5 ? 1 : 0);
  ctl.pitch = clamp(pc, -0.6, gUse);
  ctl.yaw = clamp((_b.x / Math.max(ahead, 0.25)) * (precise ? 8 : 3), -1, 1) * (1 - w * 0.8);
  // rate damping
  ctl.pitch -= ac.w.x * 0.25;
  return off;
}

// Gun lead: where to point so a bullet (muzzle velocity relative to the shooter) meets the
// target. Solved in the shooter's frame with the target's relative velocity; adds bullet drop.
export const BULLET_GF = 0.35;
export function leadPoint(shooter, target, muzzle, out) {
  const sv = shooter.vel;
  const rvx = target.vel.x - (sv ? sv.x : 0), rvy = target.vel.y - (sv ? sv.y : 0), rvz = target.vel.z - (sv ? sv.z : 0);
  let t = shooter.pos.dist(target.pos) / muzzle;
  for (let i = 0; i < 3; i++) {
    out.set(target.pos.x + rvx * t, target.pos.y + rvy * t + 0.5 * G * BULLET_GF * t * t, target.pos.z + rvz * t);
    t = shooter.pos.dist(out) / muzzle;
  }
  return t;
}

export class Pilot {
  constructor(sim, ac, { skill = 0.5, group = null } = {}) {
    this.sim = sim; this.ac = ac; this.skill = skill; this.group = group;
    this.state = ac.state === 'ground' ? 'takeoff' : 'mission';
    this.target = null; this.gtarget = null;
    this.thinkT = rnd() * 0.3;
    this.wobX = 0; this.wobY = 0;
    this.evadeT = 0; this.evadeDir = 1; this.extendT = 0; this.burst = 0;
    this.want = new V3(0, 0, -1); this.thr = 1; this.gUse = 1; this.precise = false;
    this.aimErr = lerp(2.6, 0.5, skill) * DEG;
    this.fireRange = lerp(420, 650, skill);
    this.reaction = lerp(1.4, 0.35, skill);
    this.threat = null; this.threatSeen = 0;
    this.bombT = 0; this.dropped = 0;
    this.patrolA = rnd() * 6.28;
  }

  get home() { return this.sim.teams[this.ac.team].field; }

  update(dt) {
    const ac = this.ac, ctl = ac.ctl;
    if (!ac.alive) return;
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.25 + rnd() * 0.1; this.think(); }
    ctl.fire = false; ctl.bomb = false; ctl.boost = false; ctl.brake = false;
    ac.diveBrake = 0;
    this.precise = false; this.gUse = lerp(0.75, 1, this.skill);
    switch (this.state) {
      case 'takeoff': this.doTakeoff(dt); return;
      case 'evade': this.doEvade(dt); break;
      case 'attack': this.doAttack(dt); break;
      case 'bombrun': this.doBombRun(dt); break;
      case 'dive': this.doDive(dt); break;
      case 'pullout': this.doPullout(dt); break;
      case 'rtb': this.doRTB(dt); break;
      case 'strafe': this.doStrafe(dt); break;
      default: this.doMission(dt);
    }
    this.safety(dt);
    steer(ac, this.want.x, this.want.y, this.want.z, this.gUse, this.precise);
    ctl.throttle = this.thr;
  }

  // ---------------------------------------------------------------- decisions (4 Hz)
  think() {
    const ac = this.ac, sim = this.sim, T = ac.type;
    if (this.state === 'takeoff') return;
    if (this.target && !this.target.alive) { this.target = null; if (this.state === 'attack') this.state = 'mission'; }
    // threats: an enemy behind us pointing at us
    this.threat = null;
    let best = 1e9;
    for (const e of sim.aircraft) {
      if (e.team === ac.team || !e.alive || !e.type.volleys.length || e.type.role === 'bomber') continue;
      _d.subVectors(ac.pos, e.pos);
      const d = _d.len();
      if (d > 900 || d < 1) continue;
      const pointing = (e.fwd.x * _d.x + e.fwd.y * _d.y + e.fwd.z * _d.z) / d;
      const behind = -(ac.fwd.x * _d.x + ac.fwd.y * _d.y + ac.fwd.z * _d.z) / d;   // e is behind us -> _d (e->us) along our fwd
      if (pointing > 0.94 && behind > 0.2 && d < best) { best = d; this.threat = e; }
    }
    if (this.threat) this.threatSeen += 0.3; else this.threatSeen = 0;
    const canEvade = T.role === 'fighter' || T.key === 'mosquito';
    if (canEvade && this.threat && this.threatSeen >= this.reaction && this.state !== 'evade' && this.state !== 'dive' && this.state !== 'pullout' && rnd() < lerp(0.35, 0.85, this.skill)) {
      this.state = 'evade'; this.evadeT = 2 + rnd() * 2.5;
      _d.subVectors(this.threat.pos, ac.pos);
      this.evadeDir = (_d.x * ac.right.x + _d.z * ac.right.z) > 0 ? 1 : -1;    // break toward the attacker
      if (ac === sim.player) return;
      if (ac.team === sim.playerTeam && ac.group === sim.playerGroup && sim.time - (sim.lastBreakMsg || -99) > 25) sim.lastBreakMsg = sim.time, sim.radio(ac.team, `${this.callsign()}: BREAKING ${this.evadeDir > 0 ? 'RIGHT' : 'LEFT'}!`, 'wing', this.evadeDir > 0 ? 'break_right' : 'break_left');
      return;
    }
    // out of ammo / bombs and damaged -> home
    const noAmmo = ac.ammo.every((a) => a <= 0);
    if (this.state !== 'rtb' && this.state !== 'dive' && this.state !== 'pullout' && this.state !== 'bombrun' &&
        ((noAmmo && ac.bombs <= 0) || ac.hp < T.hp * 0.25 || (T.role !== 'fighter' && T.key !== 'mosquito' && ac.bombs <= 0))) {
      this.state = 'rtb'; this.target = null; return;
    }
    const g = this.group;
    if (this.state === 'mission' || this.state === 'attack') {
      // fighters: pick targets according to the group's mission
      if (T.role === 'fighter' || (T.key === 'mosquito' && (ac.bombs <= 0 || (g && g.kind === 'flight' && g.order !== 'cover')))) {
        if (!noAmmo) {
          const tgt = this.pickTarget();
          if (tgt) { if (tgt !== this.target) this.burst = 0; this.target = tgt; this.state = 'attack'; }
          else if (this.state === 'attack') { this.state = 'mission'; this.target = null; }
        }
      }
      // fighter sweeps over the enemy field strafe when the sky is clear
      if (this.state === 'mission' && g && g.kind === 'sweep' && !noAmmo && T.role !== 'bomber') {
        const ef = sim.teams[1 - ac.team].field;
        if (Math.hypot(ef.x - ac.pos.x, ef.z - ac.pos.z) < 4000) {
          const st = sim.pickStrafeTarget(ac.team, this);
          if (st) { this.gtarget = st; this.state = 'strafe'; this.strafePhase = 'in'; this.strafeT = 0; }
        }
      }
      // Mosquito wingmen bomb when their leader takes them over the enemy airfield
      if (this.state === 'mission' && g && g.kind === 'flight' && T.bombs && ac.bombs > 0 && g.leader && g.leader !== ac) {
        const ef = sim.teams[1 - ac.team].field;
        if (Math.hypot(ef.x - g.leader.pos.x, ef.z - g.leader.pos.z) < 4500) {
          this.gtarget = sim.pickBombTarget(ac.team, null, this);
          if (this.gtarget) this.state = 'bombrun';
        }
      }
      // bombers: start the run when near the target
      if ((T.bombs && ac.bombs > 0) && g && g.gtarget && this.state === 'mission') {
        const tg = this.gtarget || (this.gtarget = sim.pickBombTarget(ac.team, g.gtarget, this));
        if (tg) {
          const d = Math.hypot(tg.x - ac.pos.x, tg.z - ac.pos.z);
          if (T.role === 'divebomber' && d < 3500) this.state = 'bombrun';
          else if (T.role !== 'divebomber' && d < (T.key === 'mosquito' ? 3200 : 4500)) this.state = 'bombrun';
        }
      }
    }
    if (this.gtarget && !this.gtarget.alive && (this.state === 'bombrun' || this.state === 'mission')) this.gtarget = sim.pickBombTarget(ac.team, this.gtarget, this);
  }

  callsign() { return this.ac.callsign || 'RED'; }

  pickTarget() {
    const ac = this.ac, sim = this.sim, g = this.group;
    let anchor = ac.pos, radius = 4000;
    if (g) {
      if (g.kind === 'escort' && g.escortOf && g.escortOf.leader) { anchor = g.escortOf.leader.pos; radius = 2600; }
      else if (g.kind === 'cap' || g.kind === 'intercept') { radius = g.kind === 'cap' ? 7000 : 9000; anchor = _u.set(this.home.x, 500, this.home.z); }
      else if (g.kind === 'flight') {
        if (g.order === 'attack' && g.leader && sim.playerTarget && sim.playerTarget.alive) return sim.playerTarget;
        if (g.order === 'cover' && g.leader) { anchor = g.leader.pos; radius = 1200; }
        else if (g.leader) { anchor = g.leader.pos; radius = 3500; }
      } else if (g.kind === 'raid') { radius = 2000; }
      else if (g.kind === 'sweep') { const ef = sim.teams[1 - ac.team].field; anchor = _u.set(ef.x, 600, ef.z); radius = 7000; }
    }
    let best = null, bs = 1e12;
    const keep = this.target && this.target.alive ? this.target : null;
    for (const e of sim.aircraft) {
      if (e.team === ac.team || !e.alive) continue;
      const da = e.pos.dist(anchor);
      if (da > radius) continue;
      const d = e.pos.dist(ac.pos);
      let s = d;
      if (e.type.role !== 'fighter' && (g && (g.kind === 'cap' || g.kind === 'intercept'))) s -= 1500;   // go for the bombers
      if (e === keep) s -= 600;                                                   // stick with it
      if (e === this.threat) s -= 900;
      s += (sim.targetedBy(e, ac) * 500);
      if (s < bs) { bs = s; best = e; }
    }
    return best;
  }

  // ---------------------------------------------------------------- behaviours
  doTakeoff(dt) {
    const ac = this.ac, ctl = ac.ctl, T = ac.type;
    ctl.throttle = 1; ctl.boost = false;
    if (ac.state === 'ground') {
      // keep straight down the runway
      const f = this.home;
      const hErr = Math.atan2(Math.sin(f.hdg - ac.heading), Math.cos(f.hdg - ac.heading));
      ctl.yaw = clamp(hErr * 3, -1, 1); ctl.roll = 0;
      ctl.pitch = ac.speed > T.vs * 1.0 ? 0.6 : 0;
      return;
    }
    // climb out straight ahead
    _d.set(ac.fwd.x, 0, ac.fwd.z).normalize();
    this.want.set(_d.x, 0.2, _d.z);
    this.thr = 1;
    steer(ac, this.want.x, this.want.y, this.want.z, 0.5);
    ctl.throttle = 1;
    if (ac.agl > 70 || ac.age > 40) this.state = 'mission';
  }

  doMission(dt) {
    const ac = this.ac, g = this.group, sim = this.sim, T = ac.type;
    this.thr = 0.85;
    if (!g) { this.patrol(this.home.x, this.home.z, 1200, 2500); return; }
    const lead = g.leader;
    if (lead && lead !== ac && lead.state === 'air') { this.formOn(lead, g.slotOf(this)); return; }
    // I'm the leader
    if (g.kind === 'raid' || (g.kind === 'flight' && g.gtarget)) {
      const tg = this.gtarget || g.gtarget;
      if (!tg) { this.state = 'rtb'; return; }
      const alt = g.cruiseAlt;
      this.flyTo(tg.x, alt + tg.y, tg.z, g.kind === 'raid' ? 0.92 : 1);
      return;
    }
    if (g.kind === 'escort' && g.escortOf && g.escortOf.leader && g.escortOf.leader.alive) {
      const b = g.escortOf.leader;
      _p.copy(b.pos).addScaled(b.fwd, -150); _p.y += 350;
      this.formPoint(_p, b.vel, 1);
      return;
    }
    if (g.kind === 'sweep') {
      const ef = sim.teams[1 - ac.team].field;
      this.patrol(ef.x, ef.z, 900, 2200);
      return;
    }
    if (g.kind === 'cap' || g.kind === 'intercept' || g.kind === 'escort' || g.kind === 'flight') {
      // patrol between home and the coast
      const f = this.home;
      const cz = f.z + (f.team === 0 ? 3000 : -3000);
      this.patrol(f.x, cz, g.cruiseAlt || 1400, 3200);
    }
  }

  patrol(cx, cz, alt, r) {
    const ac = this.ac;
    this.patrolA += 0.004 * (150 / r) * 60 / 60;
    const tx = cx + Math.cos(this.patrolA) * r, tz = cz + Math.sin(this.patrolA) * r;
    const dx = tx - ac.pos.x, dz = tz - ac.pos.z;
    if (dx * dx + dz * dz < 400 * 400) this.patrolA += 0.3;
    this.flyTo(tx, alt + this.sim.world.groundAt(tx, tz) * 0.5, tz, 0.8);
  }

  flyTo(x, y, z, thr) {
    const ac = this.ac;
    _d.set(x - ac.pos.x, 0, z - ac.pos.z);
    const dh = _d.len() || 1;
    const climb = clamp((y - ac.pos.y) / Math.max(dh, 800), -0.35, 0.3);
    this.want.set(_d.x / dh, climb, _d.z / dh);
    this.thr = thr;
  }

  // formation keeping: velocity matching toward the slot (in the leader's heading frame)
  formOn(lead, slot) {
    const hx = lead.fwd.x, hz = lead.fwd.z, hl = Math.hypot(hx, hz) || 1;
    const fx = hx / hl, fz = hz / hl, rx = -fz, rz = fx;
    _p.set(lead.pos.x + rx * slot[0] - fx * slot[2], lead.pos.y + slot[1], lead.pos.z + rz * slot[0] - fz * slot[2]);
    this.formPoint(_p, lead.vel, 1);
  }
  formPoint(p, lvel, thrMax) {
    const ac = this.ac;
    _d.subVectors(p, ac.pos);
    const d = _d.len();
    if (d > 700) {   // catch up
      _t.copy(p).addScaled(lvel, 3);
      this.want.subVectors(_t, ac.pos);
      this.thr = thrMax; return;
    }
    // desired velocity = leader velocity + closure
    _t.copy(lvel).addScaled(_d, 0.25);
    if (_t.lenSq() < 1) _t.copy(ac.fwd);
    this.want.copy(_t);
    const along = _d.dot(ac.fwd);
    const vErr = lvel.len() + along * 0.2 - ac.speed;
    this.thr = clamp(0.75 + vErr * 0.08, 0.2, thrMax);
    this.precise = d < 120;
  }

  doAttack(dt) {
    const ac = this.ac, tgt = this.target, sim = this.sim, T = ac.type;
    if (!tgt || !tgt.alive) { this.state = 'mission'; return; }
    const muzzle = GUNS[T.volleys[0].kind].v;
    const tof = leadPoint(ac, tgt, muzzle, _p);
    // aim wobble (imperfect pilots)
    this.wobX += (rnd() - 0.5) * 0.4; this.wobY += (rnd() - 0.5) * 0.4;
    this.wobX *= 0.97; this.wobY *= 0.97;
    const dist = ac.pos.dist(tgt.pos);
    const err = this.aimErr * dist;
    _p.addScaled(ac.right, this.wobX * err * 0.6).addScaled(ac.up, this.wobY * err * 0.6);
    _d.subVectors(_p, ac.pos);
    // extend away after an overshoot / too close
    if (this.extendT > 0) {
      this.extendT -= dt;
      this.want.set(ac.fwd.x, Math.max(ac.fwd.y, 0.05), ac.fwd.z);
      this.thr = 1; this.ac.ctl.boost = true;
      return;
    }
    const closure = -((tgt.vel.x - ac.vel.x) * _d.x + (tgt.vel.y - ac.vel.y) * _d.y + (tgt.vel.z - ac.vel.z) * _d.z) / (_d.len() || 1);
    if (dist < 70 + Math.max(0, closure) * 0.8 && _d.dot(ac.fwd) > 0) { this.extendT = 1.5 + rnd(); return; }
    this.want.copy(_d);
    this.precise = dist < 900;
    // speed: match closure so we don't overshoot
    const closing = -(tgt.vel.x - ac.vel.x) * _d.x / dist - (tgt.vel.y - ac.vel.y) * _d.y / dist - (tgt.vel.z - ac.vel.z) * _d.z / dist;
    this.thr = dist < 300 && closing > 30 ? 0.6 : 1;
    if (dist > 1200) this.ac.ctl.boost = this.skill > 0.6;
    // fire?
    const cosOff = _d.dot(ac.fwd) / (_d.len() || 1);
    const tol = Math.max(Math.atan2(3.5, dist), 0.7 * DEG) * lerp(1.8, 1, this.skill);
    if (dist < this.fireRange && cosOff > Math.cos(tol)) { this.burst = 0.4 + rnd() * 0.6 * this.skill; }
    if (this.burst > 0) { this.burst -= dt; if (dist < this.fireRange * 1.15) this.ac.ctl.fire = true; }
  }

  doEvade(dt) {
    const ac = this.ac;
    this.evadeT -= dt;
    if (this.evadeT <= 0) { this.state = this.target ? 'attack' : 'mission'; return; }
    // hard break turn toward the attacker side, slightly nose-low to keep speed
    const s = this.evadeDir;
    this.want.set(ac.right.x * s * 1.4 + ac.fwd.x * 0.3, -0.12 + Math.sin(this.evadeT * 3) * 0.25, ac.right.z * s * 1.4 + ac.fwd.z * 0.3);
    if (this.evadeT < 0.8 && rnd() < 0.02) this.evadeDir = -s;   // reversal
    this.thr = 1; ac.ctl.boost = true; this.gUse = 1;
  }

  // level bombing (Ju 88, Mosquito): fly over the target, release when the predicted impact
  // point crosses it
  doBombRun(dt) {
    const ac = this.ac, sim = this.sim, T = ac.type;
    if (T.role === 'divebomber') { this.doStukaApproach(dt); return; }
    const tg = this.gtarget;
    if (!tg || ac.bombs <= 0) { this.state = ac.bombs > 0 ? 'mission' : 'rtb'; this.gtarget = null; return; }
    const h = Math.max(5, ac.pos.y - 0.3 - tg.y), vy0 = ac.vel.y - 1;
    const tf = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G * h)) / G;
    const vx = ac.vel.x, vz = ac.vel.z, vh = Math.hypot(vx, vz) || 1;
    const ix = ac.pos.x + vx * tf, iz = ac.pos.z + vz * tf;
    // aim the velocity so the impact point tracks the target
    const ex = tg.x - ix, ez = tg.z - iz;
    const along = (ex * vx + ez * vz) / vh, cross = (ez * vx - ex * vz) / vh;
    const dx = tg.x - ac.pos.x, dz = tg.z - ac.pos.z, dl = Math.hypot(dx, dz) || 1;
    const alt = T.key === 'mosquito' ? 160 : (this.group ? this.group.cruiseAlt : 1500);
    const climb = clamp((alt + tg.y - ac.pos.y) / 900, -0.25, 0.2);
    this.want.set(dx / dl, climb, dz / dl);
    this.precise = true; this.thr = 1;
    if (along < 30 && along > -60 && Math.abs(cross) < 45 + tg.r) {
      this.bombT -= dt;
      if (this.bombT <= 0) { ac.ctl.bomb = true; this.bombT = 0.22; }
    }
    if (along < -150) { this.gtarget = sim.pickBombTarget(ac.team, tg, this); if (!this.gtarget || ac.bombs <= 0) this.state = ac.bombs > 0 ? 'mission' : 'rtb'; }
  }

  // Stuka: approach high, roll over into a 70-80 degree dive with the brakes out
  doStukaApproach(dt) {
    const ac = this.ac, tg = this.gtarget;
    if (!tg || ac.bombs <= 0) { this.state = 'rtb'; return; }
    const dx = tg.x - ac.pos.x, dz = tg.z - ac.pos.z, dh = Math.hypot(dx, dz);
    const alt = ac.pos.y - tg.y;
    if (dh < Math.max(450, alt * 0.55) && alt > 700) { this.state = 'dive'; return; }   // roll in for a 60-70 degree dive
    this.flyTo(tg.x, tg.y + 1500, tg.z, 1);
  }
  doDive(dt) {
    const ac = this.ac, tg = this.gtarget;
    if (!tg) { this.state = 'pullout'; return; }
    ac.diveBrake = 1;
    this.want.set(tg.x - ac.pos.x, tg.y - ac.pos.y, tg.z - ac.pos.z);
    this.precise = true; this.thr = 0.3; this.gUse = 0.8;
    const alt = ac.pos.y - tg.y;
    const dx = tg.x - ac.pos.x, dz = tg.z - ac.pos.z;
    const aimed = (this.want.x * ac.fwd.x + this.want.y * ac.fwd.y + this.want.z * ac.fwd.z) / (this.want.len() || 1);
    if (alt < 620 || (alt < 900 && aimed > 0.995)) {
      ac.ctl.bomb = true; this.bombT = 0.1;
      this.state = 'pullout'; this.pullT = 0;
      if (ac.bombs > 1) this.dropAll = true;
    }
  }
  doPullout(dt) {
    const ac = this.ac;
    this.pullT += dt;
    if (this.dropAll && ac.bombs > 0) { this.bombT -= dt; if (this.bombT <= 0) { ac.ctl.bomb = true; this.bombT = 0.15; } }
    ac.diveBrake = ac.fwd.y < -0.4 ? 1 : 0;
    this.want.set(ac.fwd.x, 0.5, ac.fwd.z);
    this.gUse = 1; this.thr = 1;
    if (ac.fwd.y > 0.1 && this.pullT > 1.5) this.state = ac.bombs > 0 ? 'bombrun' : 'rtb';
  }

  // strafing run on a ground target: line up from ~2 km, shallow dive, fire, pull off and extend
  doStrafe(dt) {
    const ac = this.ac, t = this.gtarget, sim = this.sim;
    if (!t || !t.alive || ac.ammo.every((a) => a <= 0)) { this.state = 'mission'; this.gtarget = null; return; }
    this.strafeT += dt;
    _p.set(t.x, t.y + (t.h || 2) * 0.4, t.z);
    _d.subVectors(_p, ac.pos);
    const d = _d.len(), dh = Math.hypot(_d.x, _d.z);
    if (this.strafePhase === 'in') {
      // set up: 2.2 km out at ~350 m above the target, pointing at it
      if (dh < 2000) { this.flyTo(ac.pos.x - _d.x / dh * 1000, t.y + 380, ac.pos.z - _d.z / dh * 1000, 1); }
      else this.flyTo(t.x, t.y + 380, t.z, 1);
      if (dh > 1900 && dh < 2600 && (_d.x * ac.fwd.x + _d.z * ac.fwd.z) / dh > 0.9) this.strafePhase = 'run';
      if (this.strafeT > 40) { this.state = 'mission'; this.gtarget = null; }
      return;
    }
    if (this.strafePhase === 'run') {
      this.want.copy(_d); this.precise = true; this.thr = 0.85;
      const cosOff = _d.dot(ac.fwd) / d;
      if (d < 850 && cosOff > Math.cos(Math.max(Math.atan2(4, d), 1.2 * DEG) * lerp(1.8, 1, this.skill))) ac.ctl.fire = true;
      if (d < 260 || ac.agl < 45 || cosOff < 0.5) { this.strafePhase = 'off'; this.strafeT = 0; }
      return;
    }
    // pull off and extend, then come round again
    this.want.set(ac.fwd.x, 0.35, ac.fwd.z); this.thr = 1;
    if (this.strafeT > 5) { this.strafePhase = 'in'; this.strafeT = 0; this.gtarget = sim.pickStrafeTarget(ac.team, this) || t; }
  }

  doRTB(dt) {
    const ac = this.ac, f = this.home, sim = this.sim;
    const dx = f.x - ac.pos.x, dz = f.z - ac.pos.z, d = Math.hypot(dx, dz);
    this.flyTo(f.x, f.elev + clamp(d * 0.12, 150, 1200), f.z, 0.9);
    if (d < 1300 && ac.agl < 180 && !this.threat) sim.landAI(ac);
  }

  // ---------------------------------------------------------------- safety layer
  safety(dt) {
    const ac = this.ac, w = this.sim.world;
    const vy = ac.vel.y;
    // terrain ahead (look further when descending fast)
    let minClear = 1e9;
    for (let k = 1; k <= 4; k++) {
      const t = k * 1.1;
      const x = ac.pos.x + ac.vel.x * t, z = ac.pos.z + ac.vel.z * t, y = ac.pos.y + vy * t;
      minClear = Math.min(minClear, y - w.groundAt(x, z));
    }
    const floor = this.state === 'dive' ? 250 : this.state === 'pullout' ? 60 : this.state === 'strafe' ? 30 : (this.ac.type.key === 'mosquito' && this.state === 'bombrun' ? 55 : 90);
    const clear = Math.min(minClear, ac.agl ?? 1e9);
    if (clear < floor) {
      const k = clamp((floor - clear) / floor, 0, 1);
      // wings level, then pull
      _d.set(ac.fwd.x, 0, ac.fwd.z).normalize();
      this.want.lerp(_u.set(_d.x, 0.35 + k * 0.6, _d.z), clamp(0.5 + k, 0, 1));
      this.gUse = 1; this.thr = 1;
      if (this.state === 'dive') { this.state = 'pullout'; this.pullT = 0; }
    }
    // stall: lower the nose
    if (ac.speed < ac.type.vs * 1.18 && this.state !== 'takeoff') {
      this.want.y = Math.min(this.want.y, -0.15); this.thr = 1;
    }
    // map edge
    const half = MAP_HALF;
    if (Math.abs(ac.pos.x) > half || Math.abs(ac.pos.z) > half) {
      _d.set(-ac.pos.x, 0, -ac.pos.z).normalize();
      this.want.lerp(_d, 0.7);
    }
  }
}
