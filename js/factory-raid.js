// Playable low-level sortie. The player and wingmen use the shared flight model;
// mission state follows actual flight, manual releases and delayed bomb impacts.
import { V3, Quat, qrot, smoothstep, clamp, G, DEG } from './math.js';
import { fieldToWorld, coastS } from './world.js';
import { BOMBS } from './types.js';

export class FactoryRaid {
  constructor(sim, { start = 'runway', populate = true } = {}) {
    this.sim = sim;
    this.target = sim.world.factory || sim.world.operationTarget || { name: 'RENDEZVOUS', x: 6000, z: 11000, y: 0, halls: [], guns: [] };
    this.orderKeys = ['suppress', 'cover', 'bomb'];
    this.releaseTime = null; this.lastDrop = null; this.lastImpact = null;
    this.playerHits = 0; this.airborne = false;
    this.stage = ''; this.shot = 'takeoff'; this.complete = false;
    this.flight = []; this.offset = new V3(); this.jitter = new Quat();
    this.wingLaunchTime = null; this.failureTime = null; this.reason = '';
    this.defencesAlerted = false; this.underFireUntil = 0; this.lastFireWarning = -30;
    this.lastHeightWarning = -30; this.playerDrops = 0; this.interceptAt = null;
    this.interceptors = []; this.interceptorsLaunched = false;
    this.attackComplete = false; this.escaped = false; this.returnHome = false; this.landed = false;
    this.escapeIndex = 0; this.homeIndex = 0; this.returnedWingmen = new Set();
    this.zoneTime = 0; this.lowTime = 0; this.debrief = null;
    this.waypointIndex = 0;
    this.quickStart = start === 'coast';
    this.route = [
      { name: 'ENGLISH COAST', x: -1800, z: -4200, agl: 100 },
      { name: 'CHANNEL CROSSING', x: -1800, z: 1800, agl: 25 },
      { name: 'DUTCH COUNTRYSIDE', x: -1800, z: 8000, agl: 55 },
      { name: 'WIRELESS & VALVE WORKS', x: this.target.x, z: this.target.z, agl: 80 },
    ];
    const exitX = this.target.x - 4500;
    this.escapeRoute = [
      { name: 'CLEAR THE WORKS — TURN WEST', x: this.target.x - 2600, z: this.target.z + 1000, agl: 70 },
      { name: 'DUTCH COAST — ESCAPE TO SEA', x: exitX, z: coastS(exitX) - 300, agl: 40 },
    ];
    const home = sim.world.fields[0], [approachX, approachZ] = fieldToWorld(home, -2800, 0);
    this.homeRoute = [
      { name: 'ENGLISH COAST — HOMEWARD', x: home.x, z: -4400, agl: 180 },
      { name: 'HAWKINGE — NORTHERN APPROACH', x: approachX, z: approachZ, agl: 180 },
      { name: 'TURN SOUTH · LAND AND STOP', x: home.x, z: home.z, agl: 0 },
    ];
    if (!populate) return;
    const group = sim.newGroup(0, 'flight', { name: 'STRIKE', order: 'cover', cruiseAlt: 80, wide: 2 });
    sim.playerGroup = group; sim.playerType = 'beaufighter';
    const field = sim.world.fields[0];
    for (let i = 0; i < 4; i++) {
      const ac = sim.spawn(0, 'beaufighter', group, { player: i === 0 });
      const [x, z] = fieldToWorld(field, -680 - i * 60, i % 2 ? -10 : 10);
      ac.placeOnRunway(x, z, field.hdg, sim.world.groundAt(x, z));
      this.flight.push(ac);
    }
    if (this.quickStart) {
      const x = field.x, z = coastS(x) + 900, speed = 130;
      const height = sim.world.groundAt(x, z) + 65;
      for (let i = 0; i < this.flight.length; i++) {
        const ac = this.flight[i], slot = i ? group.slotOf(ac.pilot) : [0, 0, 0];
        ac.placeInAir(x - slot[0], height + slot[1], z - slot[2], Math.PI, speed);
        // Level velocity with the small angle of attack needed to support the aircraft.
        ac.q.setHPR(Math.PI, 16 * DEG * (ac.type.vs / speed) ** 2, 0); ac.updateBasis();
        ac.agl = ac.pos.y - sim.world.groundAt(ac.pos.x, ac.pos.z);
        if (ac.pilot) ac.pilot.state = 'mission';
      }
      this.airborne = true; this.wingLaunchTime = 0; this.waypointIndex = 2;
      this.stage = 'country'; this.shot = 'air-starboard';
      sim.radio(0, 'NAVIGATOR: Dutch coast behind us. Fresh aircraft, full bombs. Follow the waypoint inland.', 'control', 'factory_coast_start');
    }
  }

  // Wingmen wait for the player's take-off roll, then launch at intervals using their AI pilots.
  holdWingman(ac) {
    if (!this.flight.includes(ac)) return false;
    const p = this.sim.player;
    if (this.wingLaunchTime === null && (p.speed > 15 || p.state === 'air')) this.wingLaunchTime = this.sim.time;
    const index = this.flight.indexOf(ac);
    const hold = ac.state === 'ground' && (this.wingLaunchTime === null || this.sim.time < this.wingLaunchTime + index * 2);
    if (hold) Object.assign(ac.ctl, { throttle: 0, brake: true, pitch: 0, roll: 0, yaw: 0, fire: false, bomb: false });
    return hold;
  }

  get wingOrderLabel() {
    return { suppress: 'SUPPRESS AA', cover: 'COVER / FORMATION', bomb: 'BOMB THE FACTORY' }[this.sim.playerGroup.order];
  }

  orderWingmen(order) {
    if (!['suppress', 'cover', 'bomb'].includes(order)) return false;
    const sim = this.sim;
    if (!this.flight.some((ac) => ac.pilot && ac.alive)) {
      sim.radio(0, 'NAVIGATOR: No wingmen available. We are on our own.', 'control', 'factory_no_wingmen');
      return false;
    }
    sim.playerGroup.order = order;
    for (const ac of this.flight) {
      const pilot = ac.pilot;
      if (!pilot || !ac.alive) continue;
      pilot.thinkT = 0; pilot.gtarget = null; pilot.target = null;
      if (ac.state === 'air') pilot.state = 'mission';
      ac.ctl.fire = ac.ctl.bomb = false;
    }
    const text = { suppress: 'STRIKE LEADER: Suppress the AA! Spread out and strafe the gun positions.',
      cover: 'STRIKE LEADER: Break off your attacks. Form up and cover my escape.',
      bomb: 'STRIKE LEADER: Attack the wireless works. Make your own bombing runs.' }[order];
    sim.radio(0, text, 'control', `factory_order_${order}`);
    return true;
  }

  pickSuppressionTarget(pilot) {
    const leader = this.sim.player;
    if (Math.hypot(leader.pos.x - this.target.x, leader.pos.z - this.target.z) > 6500) return null;
    let best = null, score = Infinity;
    for (const gun of this.target.guns) {
      if (!gun.alive) continue;
      const d = Math.hypot(gun.x - pilot.ac.pos.x, gun.z - pilot.ac.pos.z);
      if (d > 6500) continue;
      const assigned = [...this.sim.pilots.values()].filter((p) => p !== pilot && p.gtarget === gun).length;
      const s = d + assigned * 2200 + (gun.heavy ? 500 : 0);
      if (s < score) { best = gun; score = s; }
    }
    return best;
  }

  thinkWingman(pilot) {
    const ac = pilot.ac, sim = this.sim, order = sim.playerGroup.order;
    if (!sim.player.alive || ac.hp < ac.type.hp * 0.25) { pilot.state = 'rtb'; return; }
    const home = sim.world.fields[0];
    if (this.returnHome && Math.hypot(ac.pos.x - home.x, ac.pos.z - home.z) < 3000) { pilot.state = 'rtb'; return; }
    if (order === 'cover' && ac.ammo.some((n) => n > 0)) {
      const threats = this.interceptors.filter((e) => e.alive && e.hp >= e.type.hp * 0.25 && e.pilot?.state !== 'rtb' && e.pos.dist(sim.player.pos) < 3200);
      threats.sort((a, b) => a.pos.dist(ac.pos) - b.pos.dist(ac.pos));
      if (threats[0] && !this.escaped) { pilot.target = threats[0]; pilot.state = 'attack'; return; }
    }
    if (order === 'suppress' && ac.ammo.some((n) => n > 0)) {
      if (pilot.state === 'strafe' && (pilot.strafePhase === 'off' || pilot.gtarget?.alive)) return;
      const gun = this.pickSuppressionTarget(pilot);
      if (gun) {
        pilot.gtarget = gun; pilot.state = 'strafe'; pilot.strafePhase = 'in'; pilot.strafeT = 0;
        const lead = sim.player, length = Math.hypot(lead.fwd.x, lead.fwd.z) || 1;
        pilot.strafeEntry = { x: gun.x - lead.fwd.x / length * 1500, z: gun.z - lead.fwd.z / length * 1500 };
        return;
      }
    }
    if (order === 'bomb' && ac.bombs > 0 && Math.hypot(ac.pos.x - this.target.x, ac.pos.z - this.target.z) < 6500) {
      if (!pilot.gtarget?.alive || pilot.gtarget.kind !== 'factory') pilot.gtarget = sim.pickBombTarget(ac.team, null, pilot);
      if (pilot.gtarget) { pilot.state = 'bombrun'; return; }
    }
    pilot.state = 'mission'; pilot.gtarget = null; pilot.target = null;
  }

  // A low strafing pass using the pilot's normal steering and real cannon projectiles.
  suppressGun(pilot, dt) {
    const ac = pilot.ac, gun = pilot.gtarget;
    if (!gun) { pilot.state = 'mission'; return; }
    pilot.strafeT += dt;
    const dx = gun.x - ac.pos.x, dz = gun.z - ac.pos.z, dh = Math.hypot(dx, dz) || 1;
    const ahead = (dx * ac.fwd.x + dz * ac.fwd.z) / dh;
    if (!gun.alive && pilot.strafePhase !== 'off') pilot.strafePhase = 'off', pilot.strafeT = 0;
    if (pilot.strafePhase === 'in') {
      const entry = pilot.strafeEntry;
      pilot.flyTo(entry.x, Math.max(gun.y, this.sim.world.groundAt(entry.x, entry.z)) + 130, entry.z, 1);
      if (Math.hypot(entry.x - ac.pos.x, entry.z - ac.pos.z) < 350 || (dh > 800 && ahead > 0.97)) {
        pilot.strafePhase = 'run'; pilot.strafeT = 0;
      }
      if (pilot.strafeT > 35) { pilot.state = 'mission'; pilot.gtarget = null; }
      return;
    }
    if (pilot.strafePhase === 'run') {
      const dy = gun.y + 1.1 - ac.pos.y;
      let tof = Math.hypot(dx, dy, dz) / 860;
      for (let i = 0; i < 3; i++) {
        pilot.want.set(dx - ac.vel.x * tof, dy + 0.56 - ac.vel.y * tof + 0.5 * G * 0.35 * tof * tof, dz - ac.vel.z * tof);
        tof = pilot.want.len() / 860;
      }
      pilot.precise = true; pilot.thr = 0.9;
      const distance = Math.hypot(dx, dy, dz), aimed = pilot.want.dot(ac.fwd) / pilot.want.len();
      ac.ctl.fire = distance < 1050 && aimed > Math.cos(1.25 * DEG);
      if (dh < 260 || ac.agl < 38 || ahead < 0.4 || pilot.strafeT > 18) {
        pilot.strafePhase = 'off'; pilot.strafeT = 0; ac.ctl.fire = false;
      }
      return;
    }
    // Extend along the current heading and climb clear before choosing the next live gun.
    pilot.want.set(ac.fwd.x, 0.22, ac.fwd.z); pilot.thr = 1;
    if (pilot.strafeT > 7) { pilot.state = 'mission'; pilot.gtarget = null; }
  }

  bombDropped(ac) {
    if (!ac.isPlayer) return;
    this.playerDrops++;
    this.releaseTime ??= this.sim.time;
    this.lastDrop = this.sim.time;
    if (Math.hypot(ac.pos.x - this.target.x, ac.pos.z - this.target.z) < 4000) this.interceptAt ??= this.sim.time + 14;
  }

  bombDetonated(b) {
    if (!b.owner?.isPlayer) return;
    const radius = (BOMBS[b.kind] || BOMBS.bomb500).radius;
    if (this.target.halls.some((h) => Math.hypot(h.x - b.x, h.z - b.z) < h.r + radius)) {
      this.playerHits++;
      this.lastImpact = this.sim.time;
    }
  }

  get waypoint() {
    if (this.returnHome) return this.homeRoute[this.homeIndex];
    return this.playerHits > 0 ? this.escapeRoute[this.escapeIndex] : this.route[this.waypointIndex];
  }

  launchInterceptors() {
    if (this.interceptorsLaunched) return;
    this.interceptorsLaunched = true;
    const sim = this.sim, p = sim.player;
    const group = sim.newGroup(1, 'intercept', { cruiseAlt: 350 });
    for (let i = 0; i < 2; i++) {
      if (!sim.takeStock(1, 'bf109')) break;
      const x = p.pos.x + 3000 + i * 170, z = p.pos.z + 650 + i * 100;
      const hdg = Math.atan2(p.pos.x - x, -(p.pos.z - z));
      const ac = sim.spawn(1, 'bf109', group, { air: { x, z, y: sim.world.groundAt(x, z) + 150 + i * 25, hdg, speed: 155 } });
      ac.raidInterceptor = true; ac.pilot.thinkT = 0;
      this.interceptors.push(ac);
    }
    sim.radio(0, 'OBSERVER: Two enemy fighters, coming in from the east! Turn for the coast. Order two gives us fighter cover.', 'alert', 'factory_interceptors');
  }

  thinkInterceptor(pilot) {
    const ac = pilot.ac;
    if (this.escaped || !this.sim.player.alive || ac.hp < ac.type.hp * 0.25) {
      pilot.state = 'rtb'; pilot.target = null; return;
    }
    let target = this.sim.player, score = Infinity;
    for (const candidate of this.flight) {
      if (!candidate.alive) continue;
      const distance = ac.pos.dist(candidate.pos);
      const challenging = candidate.pilot?.target === ac && distance < 1700;
      const priority = distance * (challenging ? 0.5 : candidate.isPlayer ? 0.9 : 1);
      if (priority < score) { score = priority; target = candidate; }
    }
    pilot.target = target; pilot.state = 'attack';
  }

  wingmanLanded(ac) {
    if (this.flight.includes(ac) && !ac.isPlayer) this.returnedWingmen.add(ac.id);
  }

  get canContinueHome() { return this.complete && this.escaped && !this.returnHome && this.sim.player.alive; }

  continueHome() {
    if (!this.canContinueHome) return false;
    this.complete = false; this.sim.result = null; this.returnHome = true;
    this.stage = 'homeward'; this.debrief = null;
    this.orderWingmen('cover');
    this.sim.radio(0, 'NAVIGATOR: Optional return to Hawkinge. Aircraft damage carries over. Land on our runway and stop for the bonus.', 'control', 'factory_return');
    return true;
  }

  makeDebrief(won) {
    const p = this.sim.player;
    const accuracy = this.playerDrops ? clamp(this.playerHits / this.playerDrops, 0, 1) : 0;
    const damage = this.target.halls.reduce((n, h) => n + (h.maxHp - h.hp) / h.maxHp, 0);
    const wingmen = this.flight.filter((ac) => !ac.isPlayer && (ac.alive || this.returnedWingmen.has(ac.id))).length;
    const integrity = p.alive ? clamp(p.hp / p.type.hp, 0, 1) : 0;
    const lowLevel = this.zoneTime > 0 ? this.lowTime / this.zoneTime : 0;
    const damagedLanding = this.landed && (p.hp < p.type.hp * 0.85 || p.engineDmg > 0.15);
    const landingBonus = this.landed ? 750 + (damagedLanding ? 500 : 0) : 0;
    const guns = this.target.guns.filter((g) => !g.alive).length;
    const rating = Math.round(accuracy * 30 + Math.min(1, damage / 4) * 25 + wingmen / 3 * 20 + (this.escaped ? 15 : 0) + integrity * 10);
    const grade = !won ? 'D' : rating >= 90 ? 'S' : rating >= 75 ? 'A' : rating >= 60 ? 'B' : rating >= 40 ? 'C' : 'D';
    const totalScore = Math.round(accuracy * 1000 + damage * 600 + wingmen * 250 + lowLevel * 500 + guns * 100 +
      this.sim.playerStats.kills * 250 + (this.escaped ? 500 : 0) + landingBonus);
    return { accuracy: Math.round(accuracy * 100), hits: this.playerHits, drops: this.playerDrops,
      halls: this.target.halls.filter((h) => !h.alive).length, damage: Math.round(damage * 100 / this.target.halls.length),
      wingmen, integrity: Math.round(integrity * 100), lowLevel: Math.round(lowLevel * 100), guns,
      kills: this.sim.playerStats.kills, landingBonus, damagedLanding, grade, rating, totalScore };
  }

  get activeGuns() { return this.target.guns.filter((g) => g.alive).length; }
  get defenceState() {
    if (!this.activeGuns) return 'DEFENCES SILENCED';
    if (this.sim.time < this.underFireUntil) return 'UNDER AA FIRE — CHANGE HEADING';
    return this.defencesAlerted ? `DEFENCES ALERTED · ${this.activeGuns} GUNS` : 'DEFENCES UNAWARE';
  }

  defenceSpotted(aircraft) {
    if (aircraft.team !== this.sim.playerTeam || this.defencesAlerted) return;
    this.defencesAlerted = true;
    this.sim.radio(0, 'NAVIGATOR: Enemy guns are waking up! Stay low, vary your heading. Cannon can silence the light AA.', 'alert', 'aa_spotted');
  }

  defenceFired(aircraft) {
    if (!aircraft.isPlayer) return;
    this.underFireUntil = this.sim.time + 3;
    if (this.sim.time - this.lastFireWarning > 18) {
      this.lastFireWarning = this.sim.time;
      this.sim.radio(0, 'OBSERVER: Tracers coming up! Break off the straight line; heavy flak covers the higher approach.', 'alert', 'aa_incoming');
    }
  }

  get resultVoice() {
    return !this.sim.player.alive ? 'mission_aircraft_lost' : this.landed ? 'factory_landed' : this.escaped ? 'factory_success' : 'factory_failed';
  }

  finish(won, reason) {
    if (this.complete) return;
    this.complete = true; this.reason = reason;
    this.debrief = this.makeDebrief(won);
    this.sim.result = { winner: won ? this.sim.playerTeam : 1 - this.sim.playerTeam, time: this.sim.time };
  }

  step(dt) {
    const sim = this.sim, p = sim.player, t = sim.time;
    if (this.complete) return;
    if (!p?.alive) {
      this.failureTime ??= t;
      if (t - this.failureTime >= 3) this.finish(this.escaped, this.escaped
        ? 'Target hit and coast reached. The aircraft was lost on the optional return; no landing bonus.'
        : 'Your Beaufighter was lost. Retry from the Dutch coast to try the raid again.');
      return;
    }
    this.airborne ||= p.state === 'air';
    while (this.waypointIndex < this.route.length - 1) {
      const w = this.route[this.waypointIndex];
      if (Math.hypot(w.x - p.pos.x, w.z - p.pos.z) > 650 && !(p.pos.z > w.z && Math.abs(p.pos.x - w.x) < 2000)) break;
      this.waypointIndex++;
    }
    const distance = Math.hypot(p.pos.x - this.target.x, p.pos.z - this.target.z);
    sim.sirenOn = this.defencesAlerted && this.activeGuns > 0 && distance < 4200;
    if (!this.escaped && p.state === 'air' && distance < 6500) {
      this.zoneTime += dt;
      if (p.agl <= 120) this.lowTime += dt;
      if (p.agl > 125 && this.activeGuns > 0 && t - this.lastHeightWarning > 20) {
        this.lastHeightWarning = t;
        sim.radio(0, 'NAVIGATOR: Too high! Above four hundred feet the guns track us much better. Get back down.', 'alert', 'altitude_warning');
      }
    }
    const sinceDrop = this.lastDrop === null ? Infinity : t - this.lastDrop;
    const pending = sim.bombs.some((b) => b.owner === p);
    if (this.playerHits > 0 && !pending && distance > 1800 && sinceDrop > 12 && t - this.lastImpact >= 6) {
      this.attackComplete = true;
    } else if (!p.bombs && !pending && !this.playerHits && sinceDrop > 15) {
      this.finish(false, 'Your bombs missed the wireless and valve works. Fly again to retry the raid.');
    }
    if (!this.escaped && this.playerHits > 0 && this.interceptAt !== null && t >= this.interceptAt) this.launchInterceptors();
    if (this.playerHits > 0 && this.escapeIndex === 0) {
      const exit = this.escapeRoute[0];
      if (Math.hypot(p.pos.x - exit.x, p.pos.z - exit.z) < 650 || (distance > 5000 && p.pos.z < this.target.z)) this.escapeIndex = 1;
    }
    if (!this.escaped && this.attackComplete && sim.world.heightAt(p.pos.x, p.pos.z) <= 0 &&
        p.pos.z < coastS(p.pos.x) - 150 && distance > 5500) {
      this.escaped = true;
      this.finish(true, `${this.playerHits} of your bombs hit the wireless works. You escaped to the Channel. Debrief now, or continue home for a landing bonus.`);
    }
    const home = sim.world.fields[0];
    if (this.returnHome) {
      const waypoint = this.homeRoute[this.homeIndex];
      if (this.homeIndex < this.homeRoute.length - 1 && Math.hypot(p.pos.x - waypoint.x, p.pos.z - waypoint.z) < 650) {
        this.homeIndex++;
        if (this.homeIndex === 2) sim.radio(0, 'GROUND CONTROL: Turn south for the runway. Lower gear, reduce speed, land and brake to a stop.', 'control', 'factory_final_approach');
      }
      if (p.state === 'ground' && p.landedAt !== undefined && p.speed < 3 && sim.world.onRunway(p.pos.x, p.pos.z)?.field === home) {
        this.landed = true;
        this.finish(true, 'Back at RAF Hawkinge. Aircraft and crew recovered; landing bonus awarded.');
      }
    }
    const stage = this.returnHome ? (this.homeIndex === 2 ? 'landing' : 'homeward')
      : !this.airborne ? 'takeoff' : sinceDrop < 3 ? 'release' : this.attackComplete ? 'escape'
      : this.playerHits || (!p.bombs && distance < 4000) ? 'egress' : distance < 2500 ? 'approach'
      : this.waypointIndex === 0 ? 'coast' : this.waypointIndex === 1 ? 'channel' : 'country';
    if (stage !== this.stage) {
      this.stage = stage;
      const lines = {
        takeoff: 'NAVIGATOR: Open the throttle. Pull back above 100 mph, then raise the gear with G.',
        coast: 'NAVIGATOR: Follow the coast waypoint. Descend gradually towards the Channel.',
        channel: 'NAVIGATOR: Cross at wave-top height. You have control; watch your altitude.',
        country: 'NAVIGATOR: Follow the canals inland. Factory waypoint ahead.',
        approach: 'NAVIGATOR: Wireless works ahead. Line up the yellow impact circle and press B to release.',
        release: 'STRIKE LEADER: Bombs away! Eight-second delay. Keep flying and clear the works.',
        egress: 'OBSERVER: Keep clear of the target. F checks six in the cockpit; C selects the raid camera.',
        escape: 'NAVIGATOR: Bombing complete. Follow the escape waypoints west, then north to the sea. Two gives us cover.',
        homeward: 'NAVIGATOR: Homeward across the Channel. Follow the approach waypoints; keep your damaged aircraft steady.',
        landing: 'GROUND CONTROL: Hawkinge runway ahead. Gear down, slow approach, land and stop for the bonus.',
      };
      sim.radio(0, lines[stage], 'control', `factory_${stage}`);
    }
    this.shot = stage === 'approach' || stage === 'release' ? 'onboard' : stage === 'egress' ? 'rear'
      : stage === 'takeoff' ? 'takeoff' : Math.floor(t / 11) % 2 ? 'air-port' : 'air-starboard';
  }

  camera(a, cam, time) {
    const pos = a.rp || a.pos, q = a.rq || a.q;
    let offset, look, fov = 54, cockpit = false;
    if (this.shot === 'onboard') {
      offset = [-0.95, 1.35, -3.9]; cockpit = true; fov = 72;
      // Track the factory into a shallow downward view as we cross its roofs.
      look = [this.target.x + 20, this.target.y + 13, Math.max(this.target.z, pos.z + 35)];
    } else if (this.shot === 'rear') {
      offset = [0.85, 1.5, 1.4]; cockpit = true; fov = 48;
      look = [this.target.x, this.target.y + 22, this.target.z];
    } else if (this.shot === 'takeoff') {
      offset = [30, 7, 30]; look = [pos.x, pos.y + 1, pos.z]; fov = 58;
    } else {
      const port = this.shot === 'air-port';
      offset = [port ? -48 : 55, port ? 9 : 5, port ? -24 : 20];
      look = [pos.x + (port ? 18 : -28), pos.y - 1, pos.z - 15]; fov = 57;
    }
    const off = this.offset;
    qrot(q, ...offset, off);
    cam.pos.set(pos.x + off.x, pos.y + off.y, pos.z + off.z);
    cam.pos.y = Math.max(cam.pos.y, this.sim.world.groundAt(cam.pos.x, cam.pos.z) + 3);
    cam.vel.copy(a.vel);
    // Hand-held observer footage: persistent vibration, with a stronger buffet during the bursts.
    const since = this.releaseTime === null ? -100 : time - this.releaseTime;
    const shake = this.shot === 'rear' ? 0.8 + 1.4 * (1 - smoothstep(14, 21, since)) : 0.12;
    cam.q.lookDir(look[0] - cam.pos.x + Math.sin(time * 31) * shake,
      look[1] - cam.pos.y + Math.sin(time * 43) * shake * 0.65, look[2] - cam.pos.z);
    if (this.shot === 'rear') {
      const buffet = (0.18 + 0.28 * (1 - smoothstep(14, 21, since))) * DEG;
      this.jitter.setHPR(Math.sin(time * 29) * buffet, Math.sin(time * 37) * buffet, Math.sin(time * 19) * buffet * 0.5);
      cam.q.multiply(cam.q, this.jitter);
    }
    cam.fov = fov * DEG;
    return { cockpit, eye: [...offset, 2] };
  }
}
