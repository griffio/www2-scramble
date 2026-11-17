// Playable raid regression: real take-off/flight inputs, manual weapons, fuzes and mission outcomes.
import assert from 'node:assert/strict';
import { World, fieldToWorld, worldToField } from '../js/world.js';
import { TYPES } from '../js/types.js';
import { buildModels } from '../js/models.js';
import { V3, Quat, clamp, DEG, G, mulberry32, wrapPi } from '../js/math.js';

// Seed combat randomness before importing the simulator's random helpers.
Math.random = mulberry32(Number(process.env.RAID_TEST_SEED || 1942));
const { Sim, SIM_DT } = await import('../js/sim.js');

const models = buildModels();
for (const key in TYPES) TYPES[key].geom = models.aircraft[key];
const world = new World({ scenario: 'factory' });
const fresh = (options = {}) => { world.resetTargets(); return new Sim(world, { headless: true, ...options }); };
const tick = (sim, n = 1) => { for (let i = 0; i < n; i++) { sim.step(SIM_DT); sim.events.length = 0; } };

// Time alone never moves the player's aircraft, releases weapons or completes the mission.
const idle = fresh(), origin = idle.player.pos.clone();
Object.assign(idle.player.ctl, { throttle: 0, brake: true });
tick(idle, 210 * 60);
assert.equal(idle.player.state, 'ground');
assert.ok(idle.player.pos.dist(origin) < 0.01);
assert.equal(idle.player.bombs, 2);
assert.equal(idle.mission.releaseTime, null);
assert.equal(idle.result, null);
assert.ok(idle.aircraft.every((a) => a.state === 'ground'), 'wingmen wait for the player');

// Pilot a full sortie using stick/throttle/gear/bomb inputs, without changing position or velocity.
const sim = fresh(), p = sim.player;
assert.equal(p.type.key, 'beaufighter');
assert.equal(sim.pilots.has(p), false, 'the player has no AI pilot');
assert.equal(sim.pilots.size, 3);
const stages = new Set(), impacts = new Map();
let drops = 0, detonations = 0, liftedOff = false, aaShots = 0, flakBursts = 0;
const cam = { pos: new V3(), q: new Quat(), vel: new V3() };
while (!sim.result && sim.time < 420) {
  p.ctl.throttle = 1;
  if (p.state === 'ground') p.ctl.pitch = p.speed > p.type.vs ? 0.6 : 0;
  else {
    liftedOff = true;
    if (p.agl > 10) p.gearUp = true;
    const ahead = world.groundAt(p.pos.x, p.pos.z + 600);
    let desiredHeight = p.pos.z < -3000 ? Math.max(210, ahead + 75) : Math.max(35, ahead + 80);
    if (sim.mission.playerHits > 0) {
      const exit = sim.mission.waypoint;
      const heading = Math.atan2(exit.x - p.pos.x, -(exit.z - p.pos.z));
      const error = wrapPi(heading - p.compass), bank = clamp(error * 1.4, -45 * DEG, 45 * DEG);
      p.ctl.roll = clamp((bank - p.bankAngle) * 1.8, -0.7, 0.7);
      p.ctl.yaw = clamp(error * 0.6, -0.35, 0.35);
      desiredHeight = world.groundAt(p.pos.x + p.vel.x * 3, p.pos.z + p.vel.z * 3) + 65;
    }
    const trim = 16 * DEG * (p.type.vs / Math.max(p.speed, p.type.vs)) ** 2 / Math.max(0.5, Math.cos(p.bankAngle));
    const wantedPitch = trim + Math.atan2(clamp((desiredHeight - p.pos.y) * 0.18, -12, 15), Math.max(45, p.speed));
    p.ctl.pitch = clamp((wantedPitch - p.pitchAngle) * 4 - p.w.x * 0.25, -0.5, 0.6);
    // The test pilot chooses when to press B using the ballistic impact point.
    let y = p.pos.y - 0.6, z = p.pos.z, vy = p.vel.y - 1;
    for (let n = 0; n < 400 && y > world.groundAt(p.pos.x, z); n++) {
      vy -= G * 0.05; y += vy * 0.05; z += p.vel.z * 0.05;
    }
    p.ctl.bomb = z > world.factory.z - 30 && p.pos.z < world.factory.z;
  }
  sim.step(SIM_DT);
  stages.add(sim.mission.stage);
  assert.ok(p.alive, 'player survives a physically flown sortie');
  for (const b of sim.bombs) if (b.owner === p && b.landed && !impacts.has(b)) impacts.set(b, sim.time);
  for (const [b, at] of impacts) if (!sim.bombs.includes(b)) {
    assert.ok(sim.time - at >= 8 && sim.time - at < 8 + SIM_DT * 2, 'eight-second fuze starts on impact');
    impacts.delete(b); detonations++;
  }
  sim.mission.camera(p, cam, sim.time);
  assert.ok([cam.pos.x, cam.pos.y, cam.pos.z, cam.q.w, cam.fov].every(Number.isFinite));
  drops += sim.events.filter((e) => e.t === 'bombdrop' && e.ac === p).length;
  aaShots += sim.events.filter((e) => e.t === 'gun' && e.kind === 'aa').length;
  flakBursts += sim.events.filter((e) => e.t === 'flak').length;
  sim.events.length = 0;
}
assert.ok(liftedOff);
assert.deepEqual([...stages], ['takeoff', 'coast', 'channel', 'country', 'approach', 'release', 'egress', 'escape']);
assert.equal(drops, 2); assert.equal(detonations, 2);
assert.equal(sim.mission.playerHits, 2);
assert.equal(sim.result?.winner, 0);
assert.ok(sim.mission.escaped);
assert.ok(world.heightAt(p.pos.x, p.pos.z) <= 0, 'the escape reaches the sea');
assert.equal(sim.mission.interceptors.length, 2, 'one finite fighter pair intercepts the escape');
assert.ok(sim.mission.canContinueHome);
assert.equal(sim.mission.debrief.accuracy, 100);
assert.ok(sim.mission.debrief.totalScore > 0);
assert.ok(world.factory.halls.some((h) => !h.alive));
assert.ok(aaShots > 0 && flakBursts > 0, 'factory guns engage the flight with tracers and flak');
assert.ok(sim.mission.defencesAlerted, 'the factory raises the alarm');
console.log(`Playable sortie passed: ${sim.time.toFixed(1)}s, ${aaShots} AA shots, ${flakBursts} flak bursts, ${Math.round(p.hp)} HP remaining.`);

// Optional return keeps the same aircraft and mission, then awards an actual damaged landing once.
const savedPlayer = p, savedHp = p.hp, initialScore = sim.mission.debrief.totalScore;
assert.equal(sim.mission.continueHome(), true);
assert.equal(sim.player, savedPlayer);
assert.equal(p.hp, savedHp);
assert.equal(sim.result, null);
assert.equal(sim.mission.continueHome(), false, 'return can only be selected once');
assert.equal(sim.mission.returnHome, true);
const home = world.fields[0], aim = -500;
const [lx, lz] = fieldToWorld(home, aim - 3000, 0);
p.placeInAir(lx, home.elev + 250, lz, home.hdg, 80);
p.hp = 85; p.engineDmg = 0.2; p.ctl.fire = p.ctl.bomb = false;
p.gearUp = false; p.flapDown = true; p.gearAuto = false;
for (let i = 0; i < 120 * 60 && !sim.result; i++) {
  const [u, v] = worldToField(home, p.pos.x, p.pos.z), agl = p.pos.y - world.groundAt(p.pos.x, p.pos.z);
  p.ctl.throttle = 0;
  if (p.state === 'air') {
    const du = aim - u;
    let wantVy = du > 0 ? -agl / Math.max(du / Math.max(p.speed, 1), 1) : -1.5;
    if (agl < 12) wantVy = Math.max(wantVy, -1 - agl * 0.1);
    p.ctl.pitch = clamp((Math.max(-8, wantVy) - p.vel.y) * 0.08 - (p.pitchAngle + 2 * DEG) * 0.1, -1, 1);
    p.ctl.roll = clamp(-p.bankAngle * 2 - v * 0.002, -0.5, 0.5); p.ctl.yaw = 0;
  } else { p.ctl.pitch = p.ctl.roll = p.ctl.yaw = 0; p.ctl.brake = true; }
  sim.step(SIM_DT); sim.events.length = 0;
}
assert.equal(sim.result?.winner, 0);
assert.equal(sim.mission.landed, true, `bonus requires a real landing and stop: ${JSON.stringify({ reason: sim.mission.reason, state: p.state, pos: p.pos, speed: p.speed, agl: p.agl, gear: p.gear, pitch: p.pitchAngle })}`);
assert.equal(sim.mission.debrief.landingBonus, 1250);
assert.equal(sim.mission.debrief.damagedLanding, true);
assert.equal(p.hp, 85, 'bonus is recorded before ground servicing repairs the aircraft');
assert.ok(sim.mission.debrief.totalScore > initialScore);
const landingScore = sim.mission.debrief.totalScore;
sim.mission.finish(true, 'repeat');
assert.equal(sim.mission.debrief.totalScore, landingScore, 'landing bonus never stacks');
assert.equal(sim.mission.canContinueHome, false);
console.log('Optional return passed: same aircraft and damage, physical landing, +1250 damaged landing bonus, no duplicate award.');

// Roll, pitch and gun controls also pass through during the mission.
const controls = fresh(), cp = controls.player;
cp.placeInAir(0, 300, 0, Math.PI, 110);
Object.assign(cp.ctl, { throttle: 0.8, roll: 0.6, pitch: 0.1, fire: true });
tick(controls, 45);
assert.ok(Math.abs(cp.bankAngle) > 0.1, 'stick input rolls the player');
assert.ok(cp.ammo[0] < cp.type.volleys[0].ammo, 'guns fire');
assert.equal(cp.bombs, 2, 'bombs stay aboard without bomb input');
// Wingmen destroying the target cannot finish the raid for an inactive player.
for (const h of world.factory.halls) h.alive = false;
tick(controls);
assert.equal(controls.result, null);

// A missed manual release ends in failure after the bombs resolve; player losses also end the sortie.
const miss = fresh(), mp = miss.player;
mp.placeInAir(0, 200, 0, Math.PI, 120);
mp.ctl.bomb = true;
tick(miss, 13);
assert.equal(mp.bombs, 0);
mp.ctl.bomb = false;
for (let i = 0; i < 25 * 60 && !miss.result; i++) {
  mp.ctl.pitch = clamp((4 * DEG - mp.pitchAngle) * 4, -0.3, 0.3);
  tick(miss);
}
assert.equal(miss.result?.winner, 1);
assert.match(miss.mission.reason, /missed/);
const crash = fresh();
crash.player.crash('ground');
tick(crash, 4 * 60);
assert.equal(crash.result?.winner, 1);
assert.match(crash.mission.reason, /lost/);

// Ordinary bombs retain their contact fuze; water never arms the delayed fuze.
const fuzes = fresh();
for (const [x, z, delay] of [[0, 0, 8], [-1800, 11500, 0]]) {
  fuzes.events.length = 0;
  fuzes.bombs.push({ x, y: world.groundAt(x, z), z, vx: 0, vy: 0, vz: 0, t: 0, delay, kind: 'bomb500', team: 0 });
  fuzes.stepBombs(SIM_DT);
  assert.equal(fuzes.bombs.length, 0);
  assert.ok(fuzes.events.some((e) => e.t === 'explode'));
}
const replay = fresh();
assert.equal(world.factory.halls.filter((h) => h.alive).length, 15);
assert.equal(world.targets.filter((t) => t.kind === 'factory').length, 15);
assert.equal(replay.player.bombs, 2);
assert.equal(replay.mission.playerHits, 0);
console.log('Control, missed-target, crash, fuze and replay checks passed.');

// Isolate one battery to check its reaction, altitude envelope and live weapon effects.
function batteryScene(heavy, height) {
  const scene = fresh(), plane = scene.player;
  for (const ac of [...scene.aircraft]) if (ac !== plane) scene.removeAircraft(ac);
  const gun = world.factory.guns.find((g) => g.heavy === heavy);
  for (const t of world.targets) if (t.kind === 'flak' || t.kind === 'lightAA') t.alive = t === gun;
  plane.placeInAir(gun.x, gun.y + height, gun.z - 900, Math.PI, 110);
  gun.cool = 0;
  return { scene, plane, gun };
}
function fireFor(scene, seconds) {
  for (let i = 0; i < seconds * 60; i++) {
    scene.time += SIM_DT; scene.airDefence(SIM_DT); scene.stepBullets(SIM_DT); scene.stepShells(SIM_DT);
  }
}
const heavy = batteryScene(true, 120);
heavy.scene.airDefence(SIM_DT);
assert.equal(heavy.scene.shells.length, 0, 'crew reacts before firing');
assert.ok(heavy.scene.mission.defencesAlerted);
fireFor(heavy.scene, 8);
assert.ok(heavy.scene.events.some((e) => e.t === 'flakfire'));
assert.ok(heavy.scene.events.some((e) => e.t === 'flak'), 'time-fused shells produce real airbursts');
const low = batteryScene(true, 40);
fireFor(low.scene, 8);
assert.equal(low.scene.events.filter((e) => e.t === 'flakfire').length, 0, 'low approach avoids heavy flak');
const light = batteryScene(false, 40);
fireFor(light.scene, 6);
assert.ok(light.scene.events.some((e) => e.t === 'gun' && e.kind === 'aa'), 'light AA covers the low approach');
const before = light.plane.hp;
light.scene.shells.push({ x: light.plane.pos.x, y: light.plane.pos.y, z: light.plane.pos.z, t: 0, team: 1, damageScale: 0.8 });
light.scene.stepShells(SIM_DT);
assert.ok(light.plane.hp < before, 'close bursts damage the aircraft');

// Players can strafe factory guns even though they are outside the enemy airfield.
for (let n = 0; n < 10 && light.gun.alive; n++) {
  assert.ok(light.scene.bulletStructures(light.gun.x, light.gun.z, 0, 'cannon', light.plane, 1));
}
assert.equal(light.gun.alive, false);
assert.equal(light.scene.mission.activeGuns, 0);
assert.equal(light.scene.mission.defenceState, 'DEFENCES SILENCED');
light.scene.events.length = 0; light.scene.shells.length = 0; light.scene.bullets.n = 0;
fireFor(light.scene, 5);
assert.equal(light.scene.events.filter((e) => e.t === 'gun' || e.t === 'flakfire').length, 0, 'destroyed guns stop firing');

// Intact roofs block a gun's view; a high aircraft clears the roofline.
const cover = fresh(), front = world.factory.guns[2], target = world.factory;
cover.player.placeInAir(target.x + 360, target.y + 10, target.z + 320, Math.PI, 110);
assert.equal(cover.gunCanSee(front, cover.player), false);
cover.player.pos.y = target.y + 200;
assert.equal(cover.gunCanSee(front, cover.player), true);
const reset = fresh();
assert.equal(reset.mission.activeGuns, 8);
assert.ok(world.factory.guns.every((g) => g.alive && g.hp === g.maxHp && g.trackingId === undefined));
console.log('AA checks passed: reaction, altitude, airbursts, damage, strafing, cover and defence reset.');

function altitudeProfile(heavy, height) {
  const { scene, gun } = batteryScene(heavy, height);
  scene.airDefence(SIM_DT);
  const reaction = gun.cool;
  let maxDamage = 0;
  for (let i = 0; i < 8 * 60; i++) {
    scene.time += SIM_DT; scene.airDefence(SIM_DT);
    for (const shell of scene.shells) maxDamage = Math.max(maxDamage, shell.damageScale);
    for (let k = 0; k < scene.bullets.n; k++) maxDamage = Math.max(maxDamage, scene.bullets.dmg[k]);
    scene.stepShells(SIM_DT);
  }
  return { reaction, maxDamage, shots: scene.events.filter((e) => e.t === (heavy ? 'flakfire' : 'gun')).length };
}
for (const heavy of [false, true]) {
  const low = altitudeProfile(heavy, 120), high = altitudeProfile(heavy, 600);
  assert.ok(high.reaction < low.reaction, 'high targets are acquired faster');
  assert.ok(high.shots > low.shots * 1.5, 'high targets receive more frequent fire');
  assert.ok(high.maxDamage > low.maxDamage * 2.5, 'high-altitude projectiles carry about triple damage');
}
console.log('Altitude danger passed: faster acquisition, denser fire and stronger live weapons for high targets.');

const fighters = fresh({ raidStart: 'coast' });
fighters.mission.launchInterceptors(); fighters.mission.launchInterceptors();
assert.equal(fighters.mission.interceptors.length, 2, 'interception is a single finite pair');
const wingPilot = fighters.mission.flight[1].pilot, attacker = fighters.mission.interceptors[0];
attacker.pos.set(fighters.player.pos.x + 600, fighters.player.pos.y + 30, fighters.player.pos.z);
attacker.pilot.state = 'attack';
fighters.mission.thinkWingman(wingPilot);
assert.equal(wingPilot.state, 'attack');
assert.equal(wingPilot.target, attacker, 'cover order engages approaching fighters');
fighters.mission.thinkInterceptor(attacker.pilot);
assert.equal(attacker.pilot.target, wingPilot.ac, 'wingman challenge can draw a fighter off the player');
for (const ac of [...fighters.aircraft]) if (ac !== fighters.player && ac !== attacker) fighters.removeAircraft(ac);
fighters.player.placeInAir(0, 150, 0, Math.PI, 120);
attacker.placeInAir(0, 150, -450, Math.PI, 150);
let fighterShots = 0;
for (let i = 0; i < 2 * 60; i++) {
  fighters.step(SIM_DT);
  fighterShots += fighters.events.filter((e) => e.t === 'gun' && e.ac === attacker).length;
  fighters.events.length = 0;
}
assert.ok(fighterShots > 0, 'interceptors use the real aircraft weapons');
fighters.mission.escaped = true;
fighters.mission.thinkInterceptor(attacker.pilot);
assert.equal(attacker.pilot.state, 'rtb', 'interceptors disengage after the coast escape');
console.log('Interception passed: finite pair, armed pursuit, wingman fighter cover and coast disengagement.');

// Quick retry starts a completely fresh, controllable formation just inland of the Dutch coast.
const quick = fresh({ raidStart: 'coast' });
assert.equal(quick.time, 0);
assert.equal(quick.player.state, 'air');
assert.equal(quick.player.speed, 130);
assert.equal(quick.player.agl, 65);
assert.equal(quick.mission.waypointIndex, 2);
assert.equal(quick.mission.stage, 'country');
assert.equal(quick.mission.defencesAlerted, false);
assert.equal(quick.mission.activeGuns, 8);
assert.equal(quick.mission.playerHits, 0);
assert.equal(quick.mission.releaseTime, null);
assert.equal(quick.result, null);
assert.equal(quick.bombs.length, 0);
assert.equal(quick.shells.length, 0);
assert.equal(quick.bullets.n, 0);
assert.ok(quick.aircraft.every((a) => a.state === 'air' && a.gearUp && a.gear === 0 && a.bombs === 2 && a.hp === a.type.hp));
assert.ok([...quick.pilots.values()].every((pilot) => pilot.state === 'mission'));
const qz = quick.player.pos.z;
tick(quick);
assert.ok(quick.player.pos.z > qz, 'quick start flies immediately under normal physics');

function levelInput(plane, height = 100) {
  plane.ctl.throttle = 1;
  const trim = 16 * DEG * (plane.type.vs / plane.speed) ** 2;
  const pitch = trim + Math.atan2(clamp((height - plane.pos.y) * 0.18, -12, 15), plane.speed);
  plane.ctl.pitch = clamp((pitch - plane.pitchAngle) * 4 - plane.w.x * 0.25, -0.5, 0.6);
}

quick.mission.orderWingmen('suppress');
tick(quick);
assert.ok([...quick.pilots.values()].every((pilot) => pilot.state === 'mission'), 'distant orders wait until near the factory');
let wingShots = 0, gunKills = 0;
for (let i = 0; i < 75 * 60; i++) {
  levelInput(quick.player);
  quick.step(SIM_DT);
  wingShots += quick.events.filter((e) => e.t === 'gun' && e.ac?.pilot).length;
  gunKills += quick.events.filter((e) => e.t === 'struct' && e.target.raidGun).length;
  quick.events.length = 0;
}
assert.ok(wingShots > 0, 'suppression fires actual aircraft weapons');
assert.ok(gunKills > 0, 'wingman projectiles destroy gun positions');
assert.ok(quick.mission.activeGuns < 8);
assert.equal(quick.player.bombs, 2, 'the player still chooses when to drop');
assert.equal(quick.result, null, 'wingman suppression cannot complete the mission');
quick.mission.orderWingmen('cover');
assert.ok([...quick.pilots.values()].filter((pilot) => pilot.ac.alive).every((pilot) => !pilot.ac.ctl.fire && !pilot.ac.ctl.bomb && pilot.gtarget === null));
tick(quick);
assert.ok([...quick.pilots.values()].filter((pilot) => pilot.ac.alive && pilot.ac.hp >= pilot.ac.type.hp * 0.25).every((pilot) => pilot.state === 'mission'), 'recall returns healthy wingmen to formation');

// Factory attack is a distinct order: wingmen release their own bombs while the player keeps theirs.
const attack = fresh({ raidStart: 'coast' });
attack.mission.orderWingmen('bomb');
let wingDrops = 0;
for (let i = 0; i < 80 * 60 && attack.player.alive; i++) {
  levelInput(attack.player);
  attack.step(SIM_DT);
  wingDrops += attack.events.filter((e) => e.t === 'bombdrop' && e.ac?.pilot).length;
  attack.events.length = 0;
}
assert.ok(wingDrops > 0, 'attack order produces real bomb releases');
assert.equal(attack.player.bombs, 2);
assert.equal(attack.mission.playerHits, 0);
assert.equal(attack.result, null, 'the player must still hit the works');
attack.mission.orderWingmen('cover');
assert.ok([...attack.pilots.values()].filter((pilot) => pilot.ac.alive).every((pilot) => pilot.gtarget === null));
const nextTry = fresh({ raidStart: 'coast' });
assert.equal(nextTry.mission.activeGuns, 8);
assert.equal(world.factory.halls.filter((h) => h.alive).length, 15);
assert.ok(nextTry.aircraft.every((a) => a.hp === a.type.hp && a.bombs === 2));
assert.equal(nextTry.playerGroup.order, 'cover');
const fullSortie = fresh();
assert.equal(fullSortie.player.state, 'ground', 'full sortie still starts in Britain');
console.log(`Coast retry and orders passed: ${gunKills} guns destroyed by strafing, ${wingDrops} wingman bomb releases, recall and fresh restarts.`);

// Scoring handles empty attempts, excellent raids, returned crew, and optional-return failure.
const empty = fresh(); empty.mission.finish(false, 'No attack');
assert.equal(empty.mission.debrief.accuracy, 0);
assert.equal(empty.mission.debrief.grade, 'D');
assert.ok(Number.isFinite(empty.mission.debrief.totalScore));
const excellent = fresh(), em = excellent.mission;
em.playerDrops = em.playerHits = 2; em.escaped = true; em.zoneTime = em.lowTime = 30;
for (const hall of world.factory.halls.slice(0, 4)) excellent.damageStructure(hall, hall.hp, excellent.player);
const returningWingman = em.flight[1]; excellent.landAI(returningWingman);
em.finish(true, 'Successful raid');
assert.equal(em.debrief.wingmen, 3, 'AI crew returned to base count as survivors');
assert.equal(em.debrief.accuracy, 100); assert.equal(em.debrief.grade, 'S');
assert.ok(em.debrief.totalScore > empty.mission.debrief.totalScore);
assert.ok(em.continueHome());
excellent.player.placeOnRunway(world.fields[0].x, world.fields[0].z, world.fields[0].hdg, world.fields[0].elev);
excellent.player.landedAt = 1;
em.step(SIM_DT);
assert.equal(em.debrief.landingBonus, 750, 'healthy landing receives the basic bonus');
const lostReturn = fresh(), lm = lostReturn.mission;
lm.escaped = true; lm.finish(true, 'Coast reached'); assert.ok(lm.continueHome());
lostReturn.player.crash('ground'); tick(lostReturn, 4 * 60);
assert.equal(lostReturn.result?.winner, 0, 'optional return loss preserves the already-completed raid');
assert.equal(lm.debrief.landingBonus, 0);
assert.equal(lm.canContinueHome, false);
console.log('Debrief checks passed: accuracy, grades, returned crew, healthy/damaged landing rewards and return loss.');
