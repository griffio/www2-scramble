// Aircraft and weapon definitions (arcade-tuned, historically flavoured).
import { TEAM } from './world.js';

// projectile kinds: muzzle velocity (m/s), damage per projectile, life (s), tracer colour, width
export const GUNS = {
  cannon: { v: 860, dmg: 10, life: 1.7, col: [1.0, 0.75, 0.35], w: 0.55, structDmg: 0.5 },
  mg: { v: 760, dmg: 2.4, life: 1.5, col: [1.0, 0.9, 0.6], w: 0.35, structDmg: 0.08 },
  hmg: { v: 760, dmg: 4.5, life: 1.6, col: [1.0, 0.85, 0.5], w: 0.42, structDmg: 0.15 },
  gunner: { v: 740, dmg: 2.0, life: 1.4, col: [1.0, 0.6, 0.3], w: 0.35, structDmg: 0 },
  aa: { v: 820, dmg: 5, life: 3.2, col: [1.0, 0.35, 0.2], w: 0.7, structDmg: 0 },
};
export const BOMBS = {
  bomb500: { radius: 32, dmg: 75, mass: 227 },
  bomb250: { radius: 24, dmg: 45, mass: 113 },
};

// vs: stall speed (1 g, clean) m/s; vmax: level max speed; gmax: structural/pilot limit;
// roll: max roll rate rad/s; power: thrust accel numerator (a = power*throttle / V);
// hp: hit points; volleys: [{ kind, rate (volleys/s), perVolley (projectiles, alternating muzzles), ammo (volleys) }]
export const TYPES = {
  spitfire: {
    name: 'SPITFIRE MK IX', short: 'SPITFIRE', team: TEAM.RAF, role: 'fighter', vs: 41, vmax: 186, gmax: 7.5, roll: 2.9, yaw: 0.5,
    power: 245, hp: 100, boost: 1.18,
    volleys: [{ kind: 'cannon', rate: 10, perVolley: 2, ammo: 150 }, { kind: 'mg', rate: 16, perVolley: 2, ammo: 450 }],
    converge: 260, bombs: 0,
  },
  mosquito: {
    name: 'MOSQUITO FB.VI', short: 'MOSQUITO', team: TEAM.RAF, role: 'fighterbomber', vs: 47, vmax: 178, gmax: 5.5, roll: 1.9, yaw: 0.4,
    power: 250, hp: 165, boost: 1.12,
    volleys: [{ kind: 'cannon', rate: 10, perVolley: 4, ammo: 150 }, { kind: 'mg', rate: 16, perVolley: 2, ammo: 500 }],
    converge: 350, bombs: 4, bombKind: 'bomb500', twin: true,
  },
  bf109: {
    name: 'BF 109 G-6', short: 'BF 109', team: TEAM.LW, role: 'fighter', vs: 43, vmax: 182, gmax: 7, roll: 2.4, yaw: 0.5,
    power: 245, hp: 92, boost: 1.15,
    volleys: [{ kind: 'cannon', rate: 11, perVolley: 1, ammo: 150 }, { kind: 'hmg', rate: 15, perVolley: 2, ammo: 300 }],
    converge: 300, bombs: 0,
  },
  fw190: {
    name: 'FW 190 A-8', short: 'FW 190', team: TEAM.LW, role: 'fighter', vs: 49, vmax: 186, gmax: 7, roll: 3.5, yaw: 0.45,
    power: 245, hp: 120, boost: 1.12,
    volleys: [{ kind: 'cannon', rate: 11, perVolley: 4, ammo: 130 }, { kind: 'hmg', rate: 15, perVolley: 2, ammo: 300 }],
    converge: 300, bombs: 0,
  },
  ju87: {
    name: 'JU 87 B STUKA', short: 'STUKA', team: TEAM.LW, role: 'divebomber', vs: 35, vmax: 112, gmax: 6, roll: 1.4, yaw: 0.35,
    power: 100, hp: 140, boost: 1.05,
    volleys: [{ kind: 'mg', rate: 14, perVolley: 2, ammo: 300 }],
    converge: 300, bombs: 3, bombKind: 'bomb500', gunners: true,
  },
  ju88: {
    name: 'JU 88 A-4', short: 'JU 88', team: TEAM.LW, role: 'bomber', vs: 46, vmax: 132, gmax: 3.5, roll: 0.9, yaw: 0.25,
    power: 130, hp: 270, boost: 1.05,
    volleys: [{ kind: 'mg', rate: 12, perVolley: 1, ammo: 200 }],
    converge: 400, bombs: 4, bombKind: 'bomb500', gunners: true, twin: true,
  },
};
for (const k in TYPES) {
  const t = TYPES[k];
  t.key = k;
  t.ki = 0.6 * t.vs * t.vs;                                   // induced drag factor
  t.cd0 = (t.power / t.vmax - t.ki / (t.vmax * t.vmax)) / (t.vmax * t.vmax);
}
