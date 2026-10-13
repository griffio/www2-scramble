// Offline checks of the arcade flight model: level speed, climb, turn, stall, take-off.
import { Aircraft } from '../js/flight.js';
import { TYPES } from '../js/types.js';
import { DEG, RAD } from '../js/math.js';
const DT = 1 / 60;
const flat = { groundAt: () => 0.0 + 50, heightAt: () => 50, slopeAt: () => 1, onRunway: () => true };
const fmt = (v, d = 0) => v.toFixed(d);
for (const k of Object.keys(TYPES)) {
  const T = TYPES[k];
  // level max speed
  let a = new Aircraft(T, 0); a.placeInAir(0, 1500, 0, 0, 120); a.gearUp = true; a.gear = 0;
  // hold level with a simple pitch P-controller on vertical speed
  for (let i = 0; i < 60 * 120; i++) { a.ctl.throttle = 1; a.ctl.pitch = Math.max(-1, Math.min(1, -a.vel.y * 0.05 - a.pitchAngle * 0.5)); a.step(DT, null); }
  const vmax = a.speed;
  // climb rate at 1.6 vs
  a = new Aircraft(T, 0); a.placeInAir(0, 1500, 0, 0, T.vs * 1.6); a.gear = 0; a.gearUp = true;
  let best = 0;
  for (let i = 0; i < 60 * 30; i++) { a.ctl.throttle = 1; const e = (T.vs * 1.6 - a.speed) * -0.03; a.ctl.pitch = Math.max(-1, Math.min(1, e)); a.step(DT, null); if (i > 1200) best += a.vel.y / 600; }
  // max turn at 130 m/s: full pull + bank (measure heading change over 3 s and speed loss)
  a = new Aircraft(T, 0); a.placeInAir(0, 1500, 0, 0, 130); a.gear = 0; a.gearUp = true;
  for (let i = 0; i < 60; i++) { a.ctl.roll = 1; a.step(DT, null); if (Math.abs(a.bankAngle) > 75 * DEG) break; }
  const h0 = a.compass; let maxN = 0;
  for (let i = 0; i < 180; i++) { a.ctl.roll = (78 * DEG - a.bankAngle) * 3; a.ctl.pitch = 1; a.step(DT, null); maxN = Math.max(maxN, a.nz); }
  const turn = (((a.compass - h0) * RAD + 540) % 360) - 180;
  // takeoff run
  a = new Aircraft(T, 0); a.placeOnRunway(0, 0, 0, 50);
  let tko = -1, dist = 0;
  for (let i = 0; i < 60 * 60; i++) { a.ctl.throttle = 1; a.ctl.pitch = a.speed > T.vs * 0.95 ? 0.5 : 0; a.step(DT, flat); if (a.state === 'air' && tko < 0) { tko = i * DT; dist = -a.pos.z; break; } if (a.state === 'dead') break; }
  console.log(`${k.padEnd(9)} vmax ${fmt(vmax)} m/s (${fmt(vmax * 3.6)} km/h) climb ${fmt(best, 1)} m/s  3s turn ${fmt(Math.abs(turn))}° maxG ${fmt(maxN, 1)} v ${fmt(a.speed)}  takeoff ${fmt(tko, 1)} s ${fmt(dist)} m`);
}
