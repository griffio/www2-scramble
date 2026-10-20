// Offline check of landing: scripted straight-in approaches to RAF Hawkinge at idle, with a simple pilot
// that lowers the gear (and so the flaps), glides to an aim point and flares. Every case should end
// STOPPED (no bounce): exercises the flaps, propeller and gear drag, ground effect, the touchdown
// tolerances and the no-bounce rule.
// usage: node tools/landtest.mjs [-v]
import { World, FIELDS, fieldToWorld, worldToField } from '../js/world.js';
import { Aircraft } from '../js/flight.js';
import { TYPES } from '../js/types.js';
import { DEG } from '../js/math.js';
try { const m = (await import('../js/models.js')).buildModels(); for (const k in TYPES) TYPES[k].geom = m.aircraft[k]; } catch (e) { console.log('(no models: ' + e.message + ')'); }
const world = new World(), f = FIELDS[0], DT = 1 / 60, verbose = process.argv.includes('-v');
const mph = (v) => (v * 2.237).toFixed(0);

// one approach: start `dist` m short of the aim point (a third of the way down the runway), `h` m above
// the field at `v0` m/s; glide to the aim point at throttle `thr`, press G (gear + flaps) `gearAt` m from
// the aim point, flare below 12 m (unless `flare` is off)
function approach(typeKey, { dist = 3000, h = 150, v0 = 65, thr = 0, flare = true, gearAt = 1e9 } = {}) {
  const a = new Aircraft(TYPES[typeKey], 0), uAim = -500;
  const [x, z] = fieldToWorld(f, uAim - dist, 0);
  a.placeInAir(x, f.elev + h, z, f.hdg, v0);
  a.gearAuto = false;   // the player's gear is manual
  let t = 0, bounces = 0, outcome = 'TIMEOUT', td = null;
  const log = [];
  while (t < 120) {
    const [u, v] = worldToField(f, a.pos.x, a.pos.z), agl = a.pos.y - world.groundAt(a.pos.x, a.pos.z);
    const was = a.state, vy = a.vel.y, V = a.speed, gear = a.gear, pitch = a.pitchAngle;
    a.ctl.throttle = thr;
    if (a.state === 'air' && a.gearUp && uAim - u < gearAt) { a.gearUp = false; a.flapDown = true; }   // "G"
    if (a.state === 'air') {
      const du = uAim - u;
      let wantVy = du > 0 ? -agl / Math.max(du / Math.max(V, 1), 1) : -1.5;
      if (flare && agl < 12) wantVy = Math.max(wantVy, -1 - agl * 0.1);
      wantVy = Math.max(wantVy, -8);
      a.ctl.pitch = Math.max(-1, Math.min(1, (wantVy - vy) * 0.08 - (pitch + 2 * DEG) * 0.1));
      a.ctl.roll = Math.max(-0.5, Math.min(0.5, -a.bankAngle * 2 - v * 0.002));
      a.ctl.yaw = 0;
    } else { a.ctl.pitch = a.ctl.roll = a.ctl.yaw = 0; a.ctl.brake = true; }
    a.step(DT, world); t += DT;
    if (verbose && a.state === 'air' && (t * 2) % 1 < DT * 2) log.push(`${t.toFixed(0)}s u=${u.toFixed(0)} agl=${agl.toFixed(0)} ${mph(V)}mph vy=${vy.toFixed(1)} gear=${gear.toFixed(2)} flap=${a.flap.toFixed(2)}`);
    if (was === 'air' && a.state === 'ground') td = `touchdown u=${u.toFixed(0)} ${mph(V)} mph, sink ${(-vy).toFixed(1)} m/s, pitch ${(pitch / DEG).toFixed(1)}°`;
    if (was === 'ground' && a.state === 'air') bounces++;
    if (a.state === 'dead') { outcome = `CRASH (${a.crashKind}) t=${t.toFixed(1)} u=${u.toFixed(0)} ${mph(V)} mph sink ${(-vy).toFixed(1)} gear ${gear.toFixed(2)}`; break; }
    if (a.state === 'ground' && a.speed < 1) { outcome = `STOPPED t=${t.toFixed(1)} u=${u.toFixed(0)}${world.inField(a.pos.x, a.pos.z) ? '' : ' (off the field)'}`; break; }
  }
  return { outcome, td, bounces, log };
}
let bad = 0;
for (const typeKey of ['spitfire', 'mosquito']) {
  for (const c of [
    { dist: 3000, h: 150, v0: 65 }, { dist: 3000, h: 150, v0: 80 }, { dist: 3000, h: 250, v0: 65 }, { dist: 2000, h: 150, v0: 65 },
    { dist: 3000, h: 150, v0: 65, flare: false }, { dist: 3000, h: 150, v0: 65, thr: 0.3 }, { dist: 3000, h: 100, v0: 55 },
    { dist: 4000, h: 200, v0: 90, gearAt: 2000 }, { dist: 3000, h: 150, v0: 75, gearAt: 1200 },
  ]) {
    const r = approach(typeKey, c);
    if (!r.outcome.startsWith('STOPPED') || r.bounces) bad++;
    console.log(`${typeKey.padEnd(9)} ${JSON.stringify(c).padEnd(62)} ${r.outcome}  ${r.td || ''}${r.bounces ? `  BOUNCED x${r.bounces}` : ''}`);
    if (verbose) console.log('   ' + r.log.join('\n   '));
  }
}
console.log(bad ? `${bad} approach(es) did not end stopped on the wheels` : 'all approaches landed and stopped');
process.exitCode = bad ? 1 : 0;
