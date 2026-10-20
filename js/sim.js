// The battle: aircraft, weapons, damage, airfields, AA and the two commanders that scramble
// fighters and send raids. Pure JS (no DOM) so it also runs headless in Node (tools/battle.mjs).
// Presentation (particles, audio, HUD) reads `sim.events`, which is cleared each frame by the host.
import { V3, qrot, clamp, lerp, G, DEG } from './math.js';
import { Aircraft } from './flight.js';
import { Pilot, leadPoint } from './ai.js';
import { TYPES, GUNS, BOMBS } from './types.js';
import { TEAM, worldToField, fieldToWorld } from './world.js';

export const SIM_DT = 1 / 60;
export const BULLET_G = G * 0.35;
const GUN_KINDS = ['cannon', 'mg', 'hmg', 'gunner', 'aa'];
const GUN_IDX = Object.fromEntries(GUN_KINDS.map((k, i) => [k, i]));
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3();
const rnd = Math.random;

export const DIFFICULTY = {
  easy: { enemySkill: [0.15, 0.4], friendSkill: [0.55, 0.85], playerDmg: 0.45, flakErr: 1.6, raidEvery: 170 },
  normal: { enemySkill: [0.38, 0.72], friendSkill: [0.45, 0.78], playerDmg: 0.7, flakErr: 1.15, raidEvery: 140 },
  ace: { enemySkill: [0.6, 0.95], friendSkill: [0.4, 0.7], playerDmg: 1.0, flakErr: 0.85, raidEvery: 110 },
};

// ------------------------------------------------------------------ bullets (SoA pool)
class Bullets {
  constructor(max) {
    this.max = max; this.n = 0;
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.dmg = new Float32Array(max);
    this.team = new Int8Array(max); this.kind = new Uint8Array(max);
    this.owner = new Array(max).fill(null);
  }
  add(x, y, z, vx, vy, vz, kind, team, owner, dmgMul = 1) {
    if (this.n >= this.max) return;
    const i = this.n++, g = GUNS[GUN_KINDS[kind]];
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = g.life; this.dmg[i] = g.dmg * dmgMul; this.team[i] = team; this.kind[i] = kind; this.owner[i] = owner;
  }
  remove(i) {
    const j = --this.n;
    if (i !== j) {
      this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
      this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
      this.life[i] = this.life[j]; this.dmg[i] = this.dmg[j]; this.team[i] = this.team[j]; this.kind[i] = this.kind[j]; this.owner[i] = this.owner[j];
    }
    this.owner[j] = null;
  }
}

// ------------------------------------------------------------------ groups (flights, raids, CAP)
let GROUP_ID = 1;
class Group {
  constructor(team, kind, opts = {}) {
    this.id = GROUP_ID++; this.team = team; this.kind = kind; this.members = [];
    this.gtarget = opts.gtarget || null; this.escortOf = opts.escortOf || null;
    this.cruiseAlt = opts.cruiseAlt || 1400; this.order = opts.order || 'engage';
    this.name = opts.name || ''; this.wide = opts.wide || 1;
  }
  get leader() { for (const m of this.members) if (m.alive) return m; return null; }
  get alive() { return this.members.some((m) => m.alive || m.state === 'ground'); }
  slotOf(pilot) {
    let i = 0;
    for (const m of this.members) { if (!m.alive) continue; if (m === pilot.ac) break; i++; }
    const side = i % 2 ? -1 : 1, rank = Math.ceil(i / 2);
    return [side * rank * 32 * this.wide, -rank * 4, rank * 26 * this.wide];
  }
}

const CALLSIGNS = { 0: ['RED', 'BLUE', 'YELLOW', 'GREEN', 'WHITE'], 1: ['ROT', 'BLAU', 'GELB', 'SCHWARZ'] };

export class Sim {
  constructor(world, { playerType = 'spitfire', difficulty = 'normal', headless = false, noPlayer = false } = {}) {
    this.world = world; this.time = 0;
    this.diff = DIFFICULTY[difficulty] || DIFFICULTY.normal; this.difficulty = difficulty;
    this.aircraft = []; this.pilots = new Map(); this.groups = [];
    this.bullets = new Bullets(6000);
    this.bombs = []; this.shells = []; this.chutes = []; this.craters = []; this.wrecks = [];
    this.events = [];
    this.headless = headless;
    this.playerTeam = TEAM.RAF;
    this.player = null; this.playerType = playerType; this.playerTarget = null;
    this.playerStats = { kills: 0, groundKills: 0, deaths: 0, sorties: 0, bombsHit: 0 };
    this.result = null;
    this.teams = [
      { id: 0, name: 'RAF', field: world.fields[0], kills: 0, losses: 0, launchQ: [], launchT: 0, raidT: 70, icptT: 0, cs: 0 },
      { id: 1, name: 'LUFTWAFFE', field: world.fields[1], kills: 0, losses: 0, launchQ: [], launchT: 0, raidT: 0, icptT: 0, cs: 0 },
    ];
    // reserves in the hangars
    const raf = world.fields[0].hangars, lw = world.fields[1].hangars;
    raf[0].stock = { spitfire: 7, mosquito: 2 }; raf[1].stock = { spitfire: 6, mosquito: 3 }; raf[2].stock = { spitfire: 5, mosquito: 3 };
    lw[0].stock = { bf109: 4, fw190: 2, ju87: 2, ju88: 2 }; lw[1].stock = { bf109: 4, fw190: 2, ju87: 2, ju88: 2 }; lw[2].stock = { bf109: 3, fw190: 2, ju87: 2, ju88: 2 };
    this.noPlayer = noPlayer;
    this.opening();
  }

  // ---------------------------------------------------------------- setup
  opening() {
    // RAF: the player's flight scrambles first, then a CAP pair
    const raf = this.teams[0], lw = this.teams[1];
    if (!this.noPlayer) this.newPlayerFlight(this.playerType, 3);
    else { const g = this.newGroup(0, 'flight', { cruiseAlt: 1500, name: 'RED' }); for (let k = 0; k < 4; k++) this.queue(0, 'spitfire', g); }
    const cap = this.newGroup(0, 'cap', { cruiseAlt: 1600 });
    this.queue(0, 'spitfire', cap); this.queue(0, 'spitfire', cap);
    // Luftwaffe: an opening raid of Ju 88s with a 109 escort, plus 190s on CAP
    this.launchRaid(1, 'ju88', 3, 'bf109', 3);
    const lcap = this.newGroup(1, 'cap', { cruiseAlt: 1500 });
    this.queue(1, 'fw190', lcap); this.queue(1, 'fw190', lcap);
    this.radio(0, 'SECTOR CONTROL: SCRAMBLE! SCRAMBLE! BANDITS FORMING UP OVER CAP GRIS-NEZ', 'control', 'scramble');
  }

  newGroup(team, kind, opts) { const g = new Group(team, kind, opts); this.groups.push(g); return g; }

  newPlayerFlight(type, wingmen) {
    const g = this.newGroup(0, 'flight', { cruiseAlt: type === 'mosquito' ? 300 : 1500, name: 'RED', order: 'engage' });
    this.playerGroup = g;
    this.queue(0, type, g, { player: true });
    const avail = this.stockOf(0, type);
    for (let k = 0; k < Math.min(wingmen, Math.max(0, avail - 1)); k++) this.queue(0, type, g);
    return g;
  }

  launchRaid(team, btype, nb, ftype, nf) {
    const enemy = this.teams[1 - team].field;
    const tgt = this.pickBombTarget(team, null, null);
    if (!tgt) return false;
    const n1 = Math.min(nb, this.stockOf(team, btype));
    if (n1 <= 0) return false;
    const alt = btype === 'ju87' ? 1500 : btype === 'mosquito' ? 280 : 1700;
    const raid = this.newGroup(team, 'raid', { gtarget: tgt, cruiseAlt: alt, wide: btype === 'ju88' ? 1.5 : 1.2 });
    for (let k = 0; k < n1; k++) this.queue(team, btype, raid);
    const esc = this.newGroup(team, 'escort', { escortOf: raid, cruiseAlt: alt + 350 });
    const n2 = Math.min(nf, this.stockOf(team, ftype));
    for (let k = 0; k < n2; k++) this.queue(team, ftype, esc);
    return true;
  }

  stockOf(team, type) {
    let n = 0;
    for (const h of this.teams[team].field.hangars) if (h.alive) n += h.stock[type] || 0;
    // planes already queued for launch are spoken for
    for (const q of this.teams[team].launchQ) if (q.type === type) n--;
    return n;
  }
  takeStock(team, type) {
    for (const h of this.teams[team].field.hangars) if (h.alive && h.stock[type] > 0) { h.stock[type]--; return h; }
    return null;
  }
  returnStock(team, type) {
    const hs = this.teams[team].field.hangars.filter((h) => h.alive);
    if (!hs.length) return false;
    const h = hs[(rnd() * hs.length) | 0];
    h.stock[type] = (h.stock[type] || 0) + 1;
    return true;
  }
  totalStock(team) { let n = 0; for (const h of this.teams[team].field.hangars) if (h.alive) for (const k in h.stock) n += h.stock[k]; return n; }

  queue(team, type, group, opts = {}) { this.teams[team].launchQ.push({ type, group, ...opts }); }

  runwayStart(f) {
    // take off from the first intact segment
    const segs = f.runway;
    for (let s = 0; s < 3; s++) if (segs[s].alive) return -f.rwyLen / 2 + s * 500 + 50;
    return null;
  }
  runwayOpen(f) { return f.runway.filter((s) => s.alive).length >= 1 && this.runwayStart(f) !== null && this.runwayStart(f) < 300; }

  // ---------------------------------------------------------------- spawning
  spawn(team, typeKey, group, { player = false, air = null } = {}) {
    const T = TYPES[typeKey];
    const ac = new Aircraft(T, team);
    const tm = this.teams[team], f = tm.field;
    if (air) ac.placeInAir(air.x, air.y, air.z, air.hdg, air.speed);
    else {
      const u = this.runwayStart(f);
      const side = (tm.cs++ % 2) ? -11 : 11;
      const [x, z] = fieldToWorld(f, u, side);
      ac.placeOnRunway(x, z, f.hdg, this.world.groundAt(x, z));
    }
    ac.group = group;
    if (group) { if (player) group.members.unshift(ac); else group.members.push(ac); }
    const cs = CALLSIGNS[team][(group ? group.id : 0) % CALLSIGNS[team].length];
    const name = group && group.kind === 'flight' ? group.name : cs;
    let n = 1;
    if (group) while (group.members.some((m) => m !== ac && m.alive && m.callsign === `${name} ${n}`)) n++;
    ac.callsign = `${name} ${n}`;
    this.aircraft.push(ac);
    if (player) {
      this.player = ac; ac.isPlayer = true; ac.gearAuto = true;
      this.playerStats.sorties++;
    } else {
      const sk = team === this.playerTeam ? this.diff.friendSkill : this.diff.enemySkill;
      const p = new Pilot(this, ac, { skill: lerp(sk[0], sk[1], rnd()), group });
      ac.pilot = p;
      this.pilots.set(ac, p);
    }
    return ac;
  }

  // AI aircraft that make it home "land" and go back into the reserves
  landAI(ac) {
    if (!ac.alive) return;
    this.removeAircraft(ac);
    if (this.returnStock(ac.team, ac.type.key) && ac.team === this.playerTeam && ac.group === this.playerGroup) {
      this.radio(ac.team, `${ac.callsign}: LANDING, REARMING`, 'wing', this.redVoice(ac, 'landing'));
    }
  }
  removeAircraft(ac) {
    ac.state = 'gone';
    const i = this.aircraft.indexOf(ac);
    if (i >= 0) this.aircraft.splice(i, 1);
    this.pilots.delete(ac);
    if (ac.group) { const k = ac.group.members.indexOf(ac); if (k >= 0) ac.group.members.splice(k, 1); }
  }

  targetedBy(e, except) { let n = 0; for (const p of this.pilots.values()) if (p.target === e && p.ac !== except) n++; return n; }

  pickBombTarget(team, near, pilot) {
    const f = this.teams[1 - team].field;
    const cands = [];
    for (const h of f.hangars) if (h.alive) cands.push(h);
    for (const s of f.runway) if (s.alive) cands.push(s);
    if (!cands.length) { for (const t of this.world.targets) if (t.team !== team && t.alive && t.kind !== 'runway') cands.push(t); }
    if (!cands.length) return null;
    // spread bombers: prefer targets fewer pilots are already on, near the group target
    let best = null, bs = 1e12;
    for (const c of cands) {
      let s = rnd() * 400;
      if (near) s += Math.hypot(c.x - near.x, c.z - near.z) * 0.5;
      for (const p of this.pilots.values()) if (p.gtarget === c && p !== pilot) s += 350;
      if (pilot && pilot.ac.type.role === 'divebomber' && c.kind === 'hangar') s -= 300;
      if (s < bs) { bs = s; best = c; }
    }
    return best;
  }

  // ground targets for strafing: AA first, then parked aircraft, then buildings
  pickStrafeTarget(team, pilot) {
    const f = this.teams[1 - team].field;
    const cands = [];
    for (const g of f.guns) if (g.alive) cands.push([g, g.heavy ? 0 : 200]);
    for (const p of f.parking) if (p.plane) {
      if (!p.proxy) { const [x, z] = fieldToWorld(f, p.u, p.v); p.proxy = { kind: 'parked', x, z, y: this.world.heightAt(x, z), h: 3, r: 6, get alive() { return !!p.plane; } }; }
      cands.push([p.proxy, 400]);
    }
    for (const t of [...f.hangars, ...f.fuel, f.tower]) if (t.alive) cands.push([t, 900]);
    let best = null, bs = 1e12;
    for (const [c, pri] of cands) {
      let s = pri + rnd() * 600 + (pilot ? Math.hypot(c.x - pilot.ac.pos.x, c.z - pilot.ac.pos.z) * 0.15 : 0);
      for (const p of this.pilots.values()) if (p.gtarget === c && p !== pilot) s += 300;
      if (s < bs) { bs = s; best = c; }
    }
    return best;
  }

  // ---------------------------------------------------------------- messages
  // voice: a key into js/voicelines.js (recorded R/T line), optional
  radio(team, text, cls = 'info', voice = null) {
    if (team !== this.playerTeam && team !== -1) return;
    this.events.push({ t: 'msg', text, cls, voice });
  }
  ev(e) { this.events.push(e); }
  // voice line for a member of the player's flight ("RED 3" -> red3_down)
  redVoice(ac, what) {
    const m = /^RED (\d)$/.exec(ac.callsign || '');
    return m && +m[1] >= 2 && +m[1] <= 4 && ac.group === this.playerGroup ? `red${m[1]}_${what}` : null;
  }

  // ---------------------------------------------------------------- main step
  step(dt = SIM_DT) {
    this.time += dt;
    this.director(dt);
    // AI decisions + controls
    for (const p of this.pilots.values()) p.update(dt);
    // physics + weapons
    const list = this.aircraft;
    for (let i = 0; i < list.length; i++) {
      const ac = list[i];
      ac.step(dt, this.world);
      if (ac.alive) this.weapons(ac, dt);
      if (ac.fire > 0 && ac.state !== 'dead') { ac.hp -= dt * 4; if (ac.hp <= 0 && ac.alive) this.kill(ac, ac.lastHitBy); }
      if (ac.state === 'dead') { this.crashed(ac); i--; continue; }
    }
    this.collisions();
    this.gunners(dt);
    this.airDefence(dt);
    this.stepBullets(dt);
    this.stepBombs(dt);
    this.stepShells(dt);
    for (const c of this.chutes) { c.y -= 5.5 * dt; c.x += c.vx * dt; c.z += c.vz * dt; c.vx *= 0.99; c.vz *= 0.99; c.t += dt; }
    for (let i = this.chutes.length - 1; i >= 0; i--) {
      const c = this.chutes[i];
      if (c.y < this.world.groundAt(c.x, c.z) + 0.5) { this.chutes[i] = this.chutes[this.chutes.length - 1]; this.chutes.pop(); }
    }
    this.playerServices(dt);
  }

  weapons(ac, dt) {
    const T = ac.type, ctl = ac.ctl, geom = T.geom;
    for (let k = 0; k < T.volleys.length; k++) {
      ac.gunCool[k] = Math.max(ac.gunCool[k] - dt, -dt);
      if (!ctl.fire || ac.ammo[k] <= 0 || ac.state !== 'air' || ac.gunCool[k] > 0) continue;
      const vd = T.volleys[k];
      ac.gunCool[k] += 1 / vd.rate;
      if (ac.gunCool[k] < 0) ac.gunCool[k] = 0;
      ac.ammo[k]--;
      const g = GUNS[vd.kind];
      const muzzles = (T._muzzles || (T._muzzles = T.volleys.map((v) => (geom ? geom.guns.filter((m) => m.kind === v.kind || (v.kind === 'hmg' && m.kind === 'mg') || (v.kind === 'mg' && m.kind === 'hmg')) : []))))[k];
      // projectiles converge on the boresight at the harmonisation range
      for (let j = 0; j < vd.perVolley; j++) {
        let mx = 0, my = -0.3, mz = -2;
        if (muzzles.length) { const m = muzzles[(ac.muzzle[k]++) % muzzles.length]; mx = m.x; my = m.y; mz = m.z; }
        qrot(ac.q, mx, my, mz, _a);
        const ox = ac.pos.x + _a.x, oy = ac.pos.y + _a.y, oz = ac.pos.z + _a.z;
        // direction to the convergence point, plus a little dispersion
        const R = T.converge;
        qrot(ac.q, (rnd() - 0.5) * R * 0.006, (rnd() - 0.5) * R * 0.006 + 0.5 * BULLET_G * (R / g.v) ** 2, -R, _b);
        _b.x += ac.pos.x - ox; _b.y += ac.pos.y - oy; _b.z += ac.pos.z - oz;
        _b.normalize();
        const dmul = vd.perVolley > 1 && muzzles.length > vd.perVolley ? muzzles.length / vd.perVolley : 1;
        this.bullets.add(ox, oy, oz, ac.vel.x + _b.x * g.v, ac.vel.y + _b.y * g.v, ac.vel.z + _b.z * g.v, GUN_IDX[vd.kind], ac.team, ac, dmul);
      }
      this.ev({ t: 'gun', ac, kind: vd.kind, x: ac.pos.x, y: ac.pos.y, z: ac.pos.z });
    }
    ac.bombCool -= dt;
    if (ctl.bomb && ac.bombs > 0 && ac.bombCool <= 0 && ac.state === 'air') {
      ac.bombCool = 0.18;
      const hp = geom && geom.hardpoints.length ? geom.hardpoints[(T.bombs - ac.bombs) % geom.hardpoints.length] : { x: 0, y: -1, z: 0, kind: T.bombKind };
      ac.bombs--;
      qrot(ac.q, hp.x, hp.y - 0.3, hp.z, _a);
      this.bombs.push({ x: ac.pos.x + _a.x, y: ac.pos.y + _a.y, z: ac.pos.z + _a.z, vx: ac.vel.x, vy: ac.vel.y - 1, vz: ac.vel.z, kind: hp.kind || T.bombKind, team: ac.team, owner: ac, t: 0 });
      this.ev({ t: 'bombdrop', ac });
    }
  }

  // defensive gunners on bombers
  gunners(dt) {
    for (const ac of this.aircraft) {
      const T = ac.type;
      if (!T.gunners || !ac.alive || ac.state !== 'air') continue;
      ac.gunnerCool = (ac.gunnerCool || rnd() * 0.3) - dt;
      if (ac.gunnerCool > 0) continue;
      ac.gunnerCool = 1 / 6;
      const gs = T.geom && T.geom.gunners.length ? T.geom.gunners : [{ x: 0, y: 0.8, z: 2, arc: 'rear' }];
      const gp = gs[(ac.gunnerIdx = ((ac.gunnerIdx || 0) + 1)) % gs.length];
      // nearest enemy in this gunner's arc
      let best = null, bd = 600;
      for (const e of this.aircraft) {
        if (e.team === ac.team || !e.alive) continue;
        _d.subVectors(e.pos, ac.pos);
        const d = _d.len();
        if (d > bd) continue;
        const bz = -(_d.x * ac.fwd.x + _d.y * ac.fwd.y + _d.z * ac.fwd.z) / d;   // + = behind
        const by = (_d.x * ac.up.x + _d.y * ac.up.y + _d.z * ac.up.z) / d;
        const ok = gp.arc === 'rear' ? bz > 0.2 : gp.arc === 'top' ? by > -0.1 && bz > -0.3 : gp.arc === 'bottom' ? by < 0.1 && bz > -0.2 : bz < -0.3;
        if (ok) { bd = d; best = e; }
      }
      if (!best) continue;
      qrot(ac.q, gp.x, gp.y, gp.z, _a);
      _a.add(ac.pos);
      leadPoint({ pos: _a, vel: ac.vel }, best, GUNS.gunner.v, _b);
      const sk = ac.team === this.playerTeam ? 0.6 : (this.diff.enemySkill[0] + this.diff.enemySkill[1]) / 2;
      const spread = lerp(0.07, 0.035, sk) * (best === this.player ? 1.3 : 1);
      _b.sub(_a).normalize();
      _b.x += (rnd() - 0.5) * spread * 2; _b.y += (rnd() - 0.5) * spread * 2; _b.z += (rnd() - 0.5) * spread * 2;
      _b.normalize();
      const v = GUNS.gunner.v;
      this.bullets.add(_a.x, _a.y, _a.z, ac.vel.x + _b.x * v, ac.vel.y + _b.y * v, ac.vel.z + _b.z * v, GUN_IDX.gunner, ac.team, ac);
      this.ev({ t: 'gun', ac, kind: 'gunner', x: _a.x, y: _a.y, z: _a.z, gunner: true });
    }
  }

  // airfield flak and light AA
  airDefence(dt) {
    for (const t of this.world.targets) {
      if ((t.kind !== 'flak' && t.kind !== 'lightAA') || !t.alive) continue;
      t.cool -= dt;
      if (t.cool > 0) continue;
      const heavy = t.kind === 'flak';
      const range = heavy ? 4500 : 2000;
      let best = null, bd = range;
      for (const e of this.aircraft) {
        if (e.team === t.team || !e.alive || e.state !== 'air') continue;
        const d = Math.hypot(e.pos.x - t.x, e.pos.y - t.y, e.pos.z - t.z);
        if (heavy && e.pos.y - t.y < 250) continue;
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) { t.cool = 0.5 + rnd() * 0.5; continue; }
      if (heavy) {
        t.cool = 1.8 + rnd() * 1.2;
        const tof = bd / 620;
        const err = (25 + bd * 0.022) * this.diff.flakErr * (best === this.player ? 1.2 : 1);
        _a.copy(best.pos).addScaled(best.vel, tof);
        _a.x += (rnd() - 0.5) * 2 * err; _a.y += (rnd() - 0.5) * 2 * err; _a.z += (rnd() - 0.5) * 2 * err;
        this.shells.push({ x: _a.x, y: _a.y, z: _a.z, t: tof, team: t.team });
        t.aimYaw = Math.atan2(_a.x - t.x, -(_a.z - t.z)); t.aimPitch = Math.atan2(_a.y - t.y, Math.hypot(_a.x - t.x, _a.z - t.z));
        this.ev({ t: 'flakfire', x: t.x, y: t.y + 3, z: t.z, gun: t });
      } else {
        // bursts of 40 mm tracer with lead
        t.burst = (t.burst || 0) + 1;
        t.cool = t.burst % 5 === 0 ? 1.4 + rnd() : 0.28;
        const o = _c.set(t.x, t.y + 2.5, t.z);
        leadPoint({ pos: o, vel: null }, best, GUNS.aa.v, _b);
        const spread = 0.02 * this.diff.flakErr;
        _b.sub(o).normalize();
        _b.x += (rnd() - 0.5) * spread * 2; _b.y += (rnd() - 0.5) * spread * 2; _b.z += (rnd() - 0.5) * spread * 2;
        _b.normalize();
        t.aimYaw = Math.atan2(_b.x, -_b.z); t.aimPitch = Math.asin(clamp(_b.y, -1, 1));
        this.bullets.add(o.x, o.y, o.z, _b.x * GUNS.aa.v, _b.y * GUNS.aa.v, _b.z * GUNS.aa.v, GUN_IDX.aa, t.team, null);
        this.ev({ t: 'gun', ac: null, kind: 'aa', x: o.x, y: o.y, z: o.z });
      }
    }
  }

  stepShells(dt) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t -= dt;
      if (s.t > 0) continue;
      this.shells.splice(i, 1);
      this.ev({ t: 'flak', x: s.x, y: s.y, z: s.z });
      for (const e of this.aircraft) {
        if (e.team === s.team || !e.alive) continue;
        const d = Math.hypot(e.pos.x - s.x, e.pos.y - s.y, e.pos.z - s.z);
        if (d < 32) this.damage(e, 32 * (1 - d / 32) ** 1.5 + 2, null, s);
      }
    }
  }

  stepBullets(dt) {
    const B = this.bullets, list = this.aircraft, world = this.world;
    for (let i = B.n - 1; i >= 0; i--) {
      B.life[i] -= dt;
      if (B.life[i] <= 0) { B.remove(i); continue; }
      const x0 = B.px[i], y0 = B.py[i], z0 = B.pz[i];
      B.vy[i] -= BULLET_G * dt;
      const sx = B.vx[i] * dt, sy = B.vy[i] * dt, sz = B.vz[i] * dt;
      const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
      B.px[i] = x1; B.py[i] = y1; B.pz[i] = z1;
      const team = B.team[i];
      let hit = false;
      // vs aircraft: swept segment vs sphere
      for (let k = 0; k < list.length; k++) {
        const ac = list[k];
        if (ac.team === team || ac.state === 'dead') continue;
        const r = ac.hitR || (ac.hitR = (ac.type.geom ? ac.type.geom.span * 0.36 : 4.5));
        // target position at the start of this step, and the bullet's motion relative to it
        const avx = ac.vel.x * dt, avy = ac.vel.y * dt, avz = ac.vel.z * dt;
        const ex = ac.pos.x - avx - x0;
        if (ex > 60 + r || ex < -60 - r) continue;
        const ez = ac.pos.z - avz - z0;
        if (ez > 60 + r || ez < -60 - r) continue;
        const ey = ac.pos.y - avy - y0;
        if (ey > 60 + r || ey < -60 - r) continue;
        const rx = sx - avx, ry = sy - avy, rz = sz - avz;
        const ss = rx * rx + ry * ry + rz * rz || 1e-9;
        let t = (ex * rx + ey * ry + ez * rz) / ss;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = ex - rx * t, dy = ey - ry * t, dz = ez - rz * t;
        if (dx * dx + dy * dy + dz * dz < r * r) {
          const kind = GUN_KINDS[B.kind[i]];
          this.damage(ac, B.dmg[i], B.owner[i], null, kind);
          this.ev({ t: 'hit', x: x0 + sx * t, y: y0 + sy * t, z: z0 + sz * t, ac, kind });
          hit = true; break;
        }
      }
      if (hit) { B.remove(i); continue; }
      // vs ground / water / structures
      if (y1 < 260) {
        const gh = world.heightAt(x1, z1);
        if (y1 < (gh > 0 ? gh : 0) + 0.5) {
          const kind = GUN_KINDS[B.kind[i]];
          const water = gh <= 0;
          this.ev({ t: 'impact', x: x1, y: water ? 0 : gh, z: z1, water, kind });
          if (!water && GUNS[kind].structDmg > 0) this.bulletStructures(x1, z1, team, kind, B.owner[i]);
          B.remove(i); continue;
        }
        if (y1 < gh + 16 && GUNS[GUN_KINDS[B.kind[i]]].structDmg > 0) {
          // walls of buildings / parked aircraft above ground
          if (this.bulletStructures(x1, z1, team, GUN_KINDS[B.kind[i]], B.owner[i], y1 - gh)) { B.remove(i); continue; }
        }
      }
    }
  }

  bulletStructures(x, z, team, kind, owner, hAbove = 0) {
    const f = this.world.inField(x, z);
    if (!f || f.team === team) return false;
    const sd = GUNS[kind].structDmg;
    for (const t of this.world.targets) {
      if (t.field !== f || !t.alive || t.kind === 'runway') continue;
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < t.r && hAbove < t.h) {
        this.damageStructure(t, sd * (t.kind === 'hangar' ? 1 : 12), owner);
        this.ev({ t: 'hit', x, y: t.y + Math.min(hAbove, t.h * 0.7), z, struct: true, kind });
        return true;
      }
    }
    // parked aircraft
    for (const p of f.parking) {
      if (!p.plane) continue;
      const [px, pz] = fieldToWorld(f, p.u, p.v);
      if (Math.hypot(px - x, pz - z) < 6 && hAbove < 4) {
        p.hp = (p.hp ?? 14) - sd * 14;
        this.ev({ t: 'hit', x, y: this.world.heightAt(px, pz) + 1.5, z, struct: true, kind });
        if (p.hp <= 0) this.destroyParked(f, p, owner);
        return true;
      }
    }
    return false;
  }

  destroyParked(f, p, owner) {
    const h = p.hangar, type = p.plane;
    if (h.stock[type] > 0) h.stock[type]--;
    p.hp = 14;
    const [x, z] = fieldToWorld(f, p.u, p.v);
    const y = this.world.heightAt(x, z);
    this.ev({ t: 'explode', x, y: y + 1.5, z, size: 1.1, kind: 'ground' });
    this.addWreck(x, y, z, rnd() * 6.28);
    if (owner && owner.isPlayer) { this.playerStats.groundKills++; this.ev({ t: 'score', text: `PARKED ${TYPES[type].short} DESTROYED`, pts: 50 }); }
    this.radio(f.team, `${f.name}: AIRCRAFT DESTROYED ON THE GROUND`, 'alert', 'parked_lost');
    this.radio(1 - f.team, `PARKED ${TYPES[type].short} DESTROYED AT ${f.name}`, 'good', 'parked_kill');
  }

  stepBombs(dt) {
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.t += dt;
      b.vy -= G * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      const gh = this.world.heightAt(b.x, b.z);
      if (b.y <= Math.max(gh, 0)) {
        this.bombs.splice(i, 1);
        this.bombImpact(b, gh);
      }
    }
  }

  bombImpact(b, gh) {
    const water = gh <= 0;
    const B = BOMBS[b.kind] || BOMBS.bomb500;
    const y = Math.max(gh, 0);
    this.ev({ t: 'explode', x: b.x, y, z: b.z, size: 2.4, kind: water ? 'water' : 'bomb' });
    if (water) return;
    const f = this.world.inField(b.x, b.z);
    let hitAny = false;
    // structures
    for (const t of this.world.targets) {
      if (!t.alive || t.team === b.team) continue;
      if (t.kind === 'runway') {
        const [u, v] = worldToField(t.field, b.x, b.z);
        if (Math.abs(v) < t.field.rwyW / 2 + 8 && Math.abs(u - t.u) < 250) {
          t.craters.push([b.x, b.z]);
          this.addCrater(b.x, gh, b.z, 1);
          this.damageStructure(t, 30, b.owner);
          hitAny = true;
        }
        continue;
      }
      const d = Math.hypot(t.x - b.x, t.z - b.z) - t.r;
      if (d < B.radius) { this.damageStructure(t, B.dmg * (1 - Math.max(0, d) / B.radius), b.owner); hitAny = true; }
    }
    if (f && f.team !== b.team) {
      for (const p of f.parking) {
        if (!p.plane) continue;
        const [px, pz] = fieldToWorld(f, p.u, p.v);
        if (Math.hypot(px - b.x, pz - b.z) < B.radius * 0.8) this.destroyParked(f, p, b.owner);
      }
    }
    if (!f || !this.world.onRunway(b.x, b.z)) this.addCrater(b.x, gh, b.z, 0.8);
    // aircraft on / near the ground
    for (const e of this.aircraft) {
      if (!e.alive || e.team === b.team) continue;
      const d = Math.hypot(e.pos.x - b.x, e.pos.y - y, e.pos.z - b.z);
      if (d < B.radius * 1.2) this.damage(e, 80 * (1 - d / (B.radius * 1.2)), b.owner);
    }
    if (hitAny && b.owner && b.owner.isPlayer) this.playerStats.bombsHit++;
  }

  addCrater(x, y, z, r) { this.craters.push({ x, y, z, r }); if (this.craters.length > 300) this.craters.shift(); }
  addWreck(x, y, z, yaw) { this.wrecks.push({ x, y, z, yaw, t: 0 }); if (this.wrecks.length > 60) this.wrecks.shift(); }

  damageStructure(t, dmg, owner) {
    if (!t.alive) return;
    t.hp -= dmg;
    if (t.hp > 0) return;
    t.alive = false; t.hp = 0;
    const big = t.kind === 'hangar' || t.kind === 'fuel';
    this.ev({ t: 'explode', x: t.x, y: t.y + (t.h || 2) * 0.5, z: t.z, size: t.kind === 'fuel' ? 3 : big ? 2.6 : 1.2, kind: t.kind === 'fuel' ? 'fuel' : 'ground' });
    this.ev({ t: 'struct', target: t });
    const f = t.field, own = f.team, enemy = 1 - own;
    const names = { hangar: 'HANGAR', runway: 'RUNWAY SECTION', fuel: 'FUEL STORE', tower: 'CONTROL TOWER', flak: 'FLAK BATTERY', lightAA: 'AA GUN' };
    if (t.kind === 'hangar') {
      const lost = Object.entries(t.stock).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${TYPES[k].short}`).join(', ');
      t.stock = {};
      for (const p of f.parking) if (p.hangar === t) p.plane = null;
      this.radio(own, `${f.name}: HANGAR DESTROYED!${lost ? ' LOST ' + lost : ''}`, 'alert', 'hangar_lost');
      this.radio(enemy, `ENEMY HANGAR DESTROYED${lost ? ' - ' + lost + ' LOST' : ''}`, 'good', 'hangar_kill');
    } else if (t.kind === 'runway') {
      const left = f.runway.filter((s) => s.alive).length;
      const open = this.runwayOpen(f);
      this.radio(own, open ? `${f.name}: RUNWAY HIT - ${left}/3 SECTIONS USABLE` : `${f.name}: RUNWAY CLOSED - NO MORE TAKE-OFFS!`, 'alert', open ? 'runway_hit' : 'runway_closed');
      this.radio(enemy, open ? `ENEMY RUNWAY CRATERED (${3 - left}/3)` : 'ENEMY RUNWAY CLOSED - THEY CAN NO LONGER TAKE OFF!', 'good', open ? 'enemy_runway_hit' : 'enemy_runway_closed');
    } else {
      this.radio(enemy, `ENEMY ${names[t.kind] || 'TARGET'} DESTROYED`, 'good', names[t.kind] ? `kill_${t.kind}` : 'kill_target');
    }
    if (owner && owner.isPlayer) { this.playerStats.groundKills++; this.ev({ t: 'score', text: `${names[t.kind] || 'TARGET'} DESTROYED`, pts: t.kind === 'hangar' ? 300 : 100 }); }
  }

  damage(ac, dmg, attacker, shell, kind) {
    if (ac.state === 'dead' || ac.state === 'gone') return;
    if (ac.isPlayer) dmg *= this.diff.playerDmg;
    if (ac.state === 'down') {
      ac.downDmg = (ac.downDmg || 0) + dmg;
      if (ac.downDmg > 35) { ac.state = 'dead'; ac.crashKind = 'air'; }
      return;
    }
    ac.hp -= dmg;
    ac.hitFlash = 0.12;
    if (attacker) { ac.lastHitBy = attacker; ac.lastHitT = this.time; }
    const frac = ac.hp / ac.type.hp;
    if (rnd() < dmg * 0.02) ac.engineDmg = Math.min(1, ac.engineDmg + 0.25);
    ac.smoke = Math.max(ac.smoke, 1 - frac);
    if (frac < 0.4 && rnd() < dmg * 0.006) ac.fire = 1;
    if (ac.isPlayer) this.ev({ t: 'playerhit', dmg });
    if (ac.hp <= 0) this.kill(ac, attacker, dmg > 25 || rnd() < 0.25);
  }

  kill(ac, attacker, explode = false) {
    if (ac.state === 'down' || ac.state === 'dead') return;
    ac.state = explode ? 'dead' : 'down';
    ac.crashKind = 'air';
    ac.downSpin = (rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.7);
    ac.fire = Math.max(ac.fire, rnd() < 0.6 ? 1 : 0); ac.smoke = 1;
    ac.lossLogged = true;
    this.teams[ac.team].losses++;
    const enemyKill = attacker && attacker.team !== undefined && attacker.team !== ac.team;
    if (enemyKill) this.teams[attacker.team].kills++;
    this.ev({ t: 'kill', killer: attacker, victim: ac });
    if (enemyKill && attacker.isPlayer) { this.playerStats.kills++; this.ev({ t: 'score', text: `${ac.type.short} DESTROYED`, pts: ac.type.role === 'fighter' ? 100 : 150 }); }
    // the pilot bails out
    if (rnd() < 0.55 && !explode) this.chutes.push({ x: ac.pos.x, y: ac.pos.y - 3, z: ac.pos.z, vx: ac.vel.x * 0.15, vz: ac.vel.z * 0.15, t: 0, team: ac.team, delay: 1.5 });
    if (ac.team === this.playerTeam && !ac.isPlayer && ac.group === this.playerGroup) this.radio(ac.team, `${ac.callsign} IS GOING DOWN!`, 'alert', this.redVoice(ac, 'down'));
    if (ac.isPlayer) this.ev({ t: 'playerdown' });
  }

  crashed(ac) {
    const water = ac.crashKind === 'water' || (this.world.heightAt(ac.pos.x, ac.pos.z) <= 0 && ac.pos.y < 20);
    // a crash that wasn't a kill still costs the team an aircraft
    // (Aircraft.crash() zeroes hp, so the flag - not hp - says whether kill() already logged it)
    if (!ac.lossLogged) {
      ac.lossLogged = true;
      this.teams[ac.team].losses++;
      // credit whoever last hit it recently
      const killer = ac.lastHitBy && this.time - ac.lastHitT < 15 && ac.lastHitBy.team !== ac.team ? ac.lastHitBy : null;
      if (killer) this.teams[killer.team].kills++;
      this.ev({ t: 'kill', killer, victim: ac, crash: true });
      if (killer && killer.isPlayer) { this.playerStats.kills++; this.ev({ t: 'score', text: `${ac.type.short} DESTROYED`, pts: 100 }); }
      if (ac.isPlayer) this.ev({ t: 'playerdown' });
    }
    const gy = this.world.groundAt(ac.pos.x, ac.pos.z);
    const inAir = ac.pos.y - gy > 15;
    this.ev({ t: 'explode', x: ac.pos.x, y: inAir ? ac.pos.y : Math.max(gy, 0) + 1, z: ac.pos.z, size: inAir ? 1.4 : 1.6, kind: inAir ? 'air' : water ? 'water' : 'crash', vx: ac.vel.x, vy: ac.vel.y, vz: ac.vel.z, ac });
    if (!inAir && !water) this.addWreck(ac.pos.x, gy, ac.pos.z, Math.atan2(ac.vel.x, -ac.vel.z));
    if (inAir) this.ev({ t: 'debris', x: ac.pos.x, y: ac.pos.y, z: ac.pos.z, vx: ac.vel.x, vy: ac.vel.y, vz: ac.vel.z });
    if (ac.isPlayer) { this.playerStats.deaths++; this.playerDeadT = this.time; }
    this.removeAircraft(ac);
    ac.state = 'dead';
  }

  collisions() {
    const L = this.aircraft;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.state === 'dead') continue;
      // structures and masts at low level
      if (a.agl !== undefined && a.agl < 110) {
        for (const m of this.world.masts) {
          if (Math.hypot(a.pos.x - m.x, a.pos.z - m.z) < m.r && a.pos.y < m.y + m.h) { a.state = 'dead'; a.crashKind = 'ground'; }
        }
        if (a.agl < 22) {
          const f = this.world.inField(a.pos.x, a.pos.z);
          if (f) for (const t of this.world.targets) {
            if (t.field !== f || !t.alive || t.kind === 'runway' || t.kind === 'flak' || t.kind === 'lightAA') continue;
            if (Math.hypot(a.pos.x - t.x, a.pos.z - t.z) < t.r * 0.9 && a.pos.y - t.y < t.h) { a.state = 'dead'; a.crashKind = 'ground'; }
          }
        }
      }
      for (let j = i + 1; j < L.length; j++) {
        const b = L[j];
        if (b.state === 'dead' || (a.state === 'ground' && b.state === 'ground')) continue;
        if (a.team === b.team && !a.isPlayer && !b.isPlayer) continue;   // AI wingmen don't ram each other
        const dx = a.pos.x - b.pos.x;
        if (dx > 25 || dx < -25) continue;
        const dz = a.pos.z - b.pos.z;
        if (dz > 25 || dz < -25) continue;
        const dy = a.pos.y - b.pos.y;
        const r = (a.hitR || 5) * 0.75 + (b.hitR || 5) * 0.75;
        if (dx * dx + dy * dy + dz * dz < r * r) {
          a.state = 'dead'; b.state = 'dead'; a.crashKind = b.crashKind = 'air';
          if (a.isPlayer || b.isPlayer) this.radio(-1, 'MID-AIR COLLISION!', 'alert', 'collision');
        }
      }
    }
  }

  // landing back at base: rearm and repair the player's aircraft, then tow it to the take-off point
  playerServices(dt) {
    const p = this.player;
    if (!p) return;
    // moving again (or airborne): the next stop on a home field is a new service
    if (p.state !== 'ground' || p.speed > 5) p.serviced = p.towed = false;
    p.towWait = null;
    if (p.state !== 'ground') { p.serviceT = 0; return; }
    const f = this.world.inField(p.pos.x, p.pos.z);
    if (!f || f.team !== p.team || p.speed > 3 || p.landedAt === undefined) { p.serviceT = 0; return; }
    p.serviceT = (p.serviceT || 0) + dt;
    if (p.serviceT > 4 && !p.serviced) {
      p.serviced = true; p.towed = false; p.towT = 0;
      p.hp = p.type.hp; p.ammo = p.type.volleys.map((v) => v.ammo); p.bombs = p.type.bombs; p.engineDmg = 0; p.fire = 0; p.smoke = 0;
      this.radio(-1, 'GROUND CREW: REARMED, REFUELLED AND PATCHED UP. GOOD HUNTING, SIR!', 'good', 'rearmed');
    }
    // a moment later: towed onto the runway centreline at the take-off point, if the runway works and is clear
    if (p.serviced && !p.towed && p.serviceT > 5.2) {
      const u = this.runwayStart(f);
      if (u === null || !this.runwayOpen(f)) { p.towWait = 'runway'; return; }
      const [x, z] = fieldToWorld(f, u, 0);
      if (Math.hypot(p.pos.x - x, p.pos.z - z) < 60) { p.towed = true; return; }   // already there
      if (this.aircraft.some((a) => a !== p && a.state === 'ground' && Math.hypot(a.pos.x - x, a.pos.z - z) < 40)) { p.towWait = 'traffic'; return; }
      if (!p.towT) { p.towT = this.time; this.ev({ t: 'fade' }); }   // the screen fades out first
      else if (this.time - p.towT > 0.4) {
        p.placeOnRunway(x, z, f.hdg, this.world.groundAt(x, z));
        p.towed = true;
        this.ev({ t: 'towed' });
      }
    }
  }

  // ---------------------------------------------------------------- the commanders
  director(dt) {
    for (const tm of this.teams) {
      const f = tm.field;
      // launches
      tm.launchT -= dt;
      if (tm.launchQ.length && tm.launchT <= 0) {
        const open = this.runwayOpen(f);
        if (!open) {
          if (tm.launchQ.some((q) => q.player)) this.radio(tm.id, `${f.name}: RUNWAY UNSERVICEABLE`, 'alert', 'runway_unserviceable');
          tm.launchQ.length = 0;
        } else {
          // runway clear?
          const u0 = this.runwayStart(f);
          const [sx, sz] = fieldToWorld(f, u0, 0);
          const busy = this.aircraft.some((a) => a.state === 'ground' && a.team === tm.id && Math.hypot(a.pos.x - sx, a.pos.z - sz) < 140);
          if (!busy) {
            const q = tm.launchQ.shift();
            if (this.takeStock(tm.id, q.type)) {
              this.spawn(tm.id, q.type, q.group, { player: q.player });
              tm.launchT = q.player ? 1.2 : 2.2;
            }
          } else tm.launchT = 0.5;
        }
      }
    }
    // decisions once a second
    this.dirT = (this.dirT || 0) - dt;
    if (this.dirT > 0) return;
    this.dirT = 1;
    for (const tm of this.teams) { this.command(tm); this.refreshParking(tm.field); }
    if (!this.result) this.checkResult();
  }

  refreshParking(f) {
    for (const h of f.hangars) {
      const slots = f.parking.filter((p) => p.hangar === h);
      const types = [];
      if (h.alive) for (const k in h.stock) for (let n = 0; n < h.stock[k]; n++) types.push(k);
      // planes waiting in the launch queue are taxiing, not parked
      slots.forEach((p, i) => { p.plane = types[i + 1] || null; });
    }
  }

  command(tm) {
    const id = tm.id, enemy = 1 - id, f = tm.field;
    const mine = this.aircraft.filter((a) => a.team === id && a.alive);
    const airborne = mine.length + tm.launchQ.length;
    // enemies approaching our field
    const radar = id === 0 ? 14000 : 9000;     // Chain Home sees them coming
    const threats = this.aircraft.filter((a) => a.team === enemy && a.alive && Math.hypot(a.pos.x - f.x, a.pos.z - f.z) < radar);
    const defenders = mine.filter((a) => a.type.role === 'fighter' && Math.hypot(a.pos.x - f.x, a.pos.z - f.z) < radar + 3000).length;
    tm.icptT -= 1;
    if (threats.length && defenders < Math.min(threats.length + (id === 0 ? 2 : 1), id === 0 ? 7 : 6) && tm.icptT <= 0 && airborne < 16) {
      const ftype = id === 0 ? 'spitfire' : (this.stockOf(1, 'fw190') > 0 ? 'fw190' : 'bf109');
      const n = Math.min(2, this.stockOf(id, ftype));
      if (n > 0 && this.runwayOpen(f)) {
        const g = this.newGroup(id, 'intercept', { cruiseAlt: 1200 });
        for (let k = 0; k < n; k++) this.queue(id, ftype, g);
        tm.icptT = 35;
        const bombers = threats.filter((a) => a.type.role !== 'fighter').length;
        if (id === this.playerTeam) this.radio(id, `SECTOR CONTROL: ${threats.length} BANDITS${bombers ? ` (${bombers} BOMBERS)` : ''} INBOUND - SCRAMBLING ${n} MORE`, 'control', `bandits_${clamp(threats.length, 1, 20)}${bombers ? '_b' : ''}`);
        if (id !== this.playerTeam && !this.warnedRaid) { this.warnedRaid = true; }
      }
    }
    // air raid warning at the player's base
    if (id === this.playerTeam) {
      const bombersNear = threats.filter((a) => a.type.role !== 'fighter' && Math.hypot(a.pos.x - f.x, a.pos.z - f.z) < 7000).length;
      this.raidWarning = bombersNear > 0;
      if (bombersNear && !this.sirenOn) this.radio(id, `${f.name}: AIR RAID WARNING RED! BOMBERS OVERHEAD!`, 'alert', 'air_raid');
      this.sirenOn = bombersNear > 0;
    }
    // raids
    tm.raidT -= 1;
    const raidsAirborne = this.groups.filter((g) => g.team === id && g.kind === 'raid' && g.alive).length;
    if (tm.raidT <= 0 && raidsAirborne < 2 && airborne < 14 && this.runwayOpen(f)) {
      tm.raidT = this.diff.raidEvery * (id === 0 ? 1.5 : 1) * (0.8 + rnd() * 0.4);
      let ok;
      if (id === 1) {
        const bt = rnd() < 0.5 && this.stockOf(1, 'ju87') > 0 ? 'ju87' : this.stockOf(1, 'ju88') > 0 ? 'ju88' : 'ju87';
        const ft = this.stockOf(1, 'bf109') > 1 ? 'bf109' : 'fw190';
        ok = this.launchRaid(1, bt, 3, ft, 2 + (rnd() < 0.5 ? 1 : 0));
        if (ok) this.radio(0, `SECTOR CONTROL: RADAR REPORTS A NEW RAID FORMING OVER FRANCE`, 'control', 'raid_forming');
      } else {
        ok = this.launchRaid(0, 'mosquito', this.playerType === 'mosquito' ? 2 : 3, 'spitfire', 2);
        if (ok) this.radio(0, 'SECTOR CONTROL: MOSQUITO SQUADRON TAKING OFF FOR A LOW-LEVEL STRIKE', 'control', 'mosquito_strike');
      }
    }
    // late in the battle (or with no bombers left) the fighters go over to the offensive
    tm.sweepT = (tm.sweepT ?? 240) - 1;
    const bombersLeft = id === 1 ? this.stockOf(1, 'ju87') + this.stockOf(1, 'ju88') : this.stockOf(0, 'mosquito');
    if (tm.sweepT <= 0) {
      tm.sweepT = 120;
      const idle = (g) => g.team === id && g.members.some((m) => m.alive) &&
        (g.kind === 'cap' || g.kind === 'intercept' || (g.kind === 'escort' && !(g.escortOf && g.escortOf.alive)));
      const capG = this.groups.filter(idle);
      const fighters = capG.reduce((n, g) => n + g.members.filter((m) => m.alive).length, 0);
      const endgame = this.stockOf(id, id === 0 ? 'spitfire' : 'bf109') + this.stockOf(id, id === 0 ? 'mosquito' : 'fw190') === 0 || this.time > 1200;
      if (fighters >= 1 && (endgame || (fighters >= 2 && (bombersLeft === 0 || this.time > 540 || rnd() < 0.35)))) {
        for (const g of endgame ? capG : capG.slice(0, 1)) { g.kind = 'sweep'; g.cruiseAlt = 900; }
        if (id === this.playerTeam) this.radio(id, 'SECTOR CONTROL: FIGHTERS GOING OVER FOR A SWEEP AND STRAFE', 'control', 'sweep');
        else this.radio(this.playerTeam, 'SECTOR CONTROL: ENEMY FIGHTERS HEADING FOR HAWKINGE - EXPECT STRAFING', 'control', 'enemy_sweep');
      }
    }
    // CAP top-up
    let cap = 0;
    for (const a of mine) if (a.group && a.group.kind === 'cap') cap++;
    for (const q of tm.launchQ) if (q.group && q.group.kind === 'cap') cap++;
    if (cap === 0 && this.time > 60 && airborne < 12 && this.runwayOpen(f)) {
      const ftype = id === 0 ? 'spitfire' : 'bf109';
      if (this.stockOf(id, ftype) > 3) { const g = this.newGroup(id, 'cap', { cruiseAlt: 1500 }); this.queue(id, ftype, g); this.queue(id, ftype, g); }
    }
    // tidy empty groups
    if (this.groups.length > 60) {
      const queued = new Set();
      for (const t of this.teams) for (const q of t.launchQ) queued.add(q.group);
      this.groups = this.groups.filter((g) => g.alive || queued.has(g) || g === this.playerGroup);
    }
  }

  // player respawn (after being shot down)
  respawnPlayer(type) {
    if (this.player && this.player.alive) return false;
    const tm = this.teams[this.playerTeam];
    if (tm.launchQ.some((q) => q.player)) return false;   // already queued, waiting for the runway
    if (!this.runwayOpen(tm.field) || this.stockOf(this.playerTeam, type) <= 0) return false;
    this.playerType = type;
    const g = this.playerGroup;
    g.members = g.members.filter((m) => m.alive);
    const alive = g.members.length;
    tm.launchQ.unshift({ type, group: g, player: true });
    const extra = Math.max(0, Math.min(2 - alive, this.stockOf(this.playerTeam, type) - 2));
    for (let k = 0; k < extra; k++) tm.launchQ.splice(1, 0, { type, group: g });
    g.cruiseAlt = type === 'mosquito' ? 300 : 1500;
    return true;
  }

  // ---------------------------------------------------------------- victory
  teamStatus(id) {
    const tm = this.teams[id], f = tm.field;
    const hangars = f.hangars.filter((h) => h.alive).length;
    const runway = f.runway.filter((s) => s.alive).length;
    const airborne = this.aircraft.filter((a) => a.team === id && (a.alive)).length;
    const stock = this.totalStock(id);
    return { hangars, runway, airborne, stock, open: this.runwayOpen(f), queued: tm.launchQ.length };
  }
  checkResult() {
    for (const id of [0, 1]) {
      const s = this.teamStatus(id);
      const crippled = s.stock === 0 || !s.open;
      const based = s.hangars === 0 && s.runway === 0;
      const playerAlive = id === this.playerTeam && this.player && this.player.alive;
      const canRespawn = id === this.playerTeam && !this.noPlayer && s.open && s.stock > 0;
      if ((crippled || based) && s.airborne === 0 && s.queued === 0 && !playerAlive && !canRespawn) {
        this.result = { winner: 1 - id, time: this.time };
        this.events.push({ t: 'result', winner: 1 - id });
        return;
      }
    }
  }
}
