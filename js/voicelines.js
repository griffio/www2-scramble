// Radio voice lines. Pre-recorded with Kokoro TTS (Apache-2.0, runs locally) by
// tools/voices/make-voices.mjs into audio/voice/<key>.mp3; the game plays them through the radio.
// Each line: [speaker, text]. Speakers map to Kokoro voices (British English).
export const SPEAKERS = {
  control: { voice: 'bm_george', speed: 0.92 },   // Sector Control: measured, authoritative
  wing: { voice: 'bm_lewis', speed: 1.05 },       // your wingmen
  crew: { voice: 'bm_fable', speed: 1.0 },        // ground crew
  you: { voice: 'bm_daniel', speed: 1.0 },        // the player's own orders
};

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

export const LINES = {
  scramble: ['control', 'Scramble! Scramble! Bandits forming up over Cap Gris-Nez. Good luck, Red Section.'],
  scramble_again: ['control', 'Red Leader, you are clear for take-off. Scramble!'],
  raid_forming: ['control', 'Sector Control. Radar reports a new raid forming over France.'],
  mosquito_strike: ['control', 'Sector Control. Mosquito squadron taking off for a low-level strike.'],
  sweep: ['control', 'Sector Control. Fighters going over for a sweep and strafe.'],
  enemy_sweep: ['control', 'Sector Control. Enemy fighters heading for Hawkinge. Expect strafing.'],
  air_raid: ['control', 'Hawkinge. Air raid warning red! Bombers overhead! Take cover!'],
  hangar_lost: ['control', 'Hawkinge here. A hangar has been destroyed!'],
  hangar_kill: ['control', 'Enemy hangar destroyed. Good show!'],
  runway_hit: ['control', 'Hawkinge here. The runway has been hit, but we can still get aircraft off.'],
  runway_closed: ['control', 'Hawkinge here. The runway is closed. No more take-offs!'],
  runway_unserviceable: ['control', 'Hawkinge here. The runway is unserviceable.'],
  enemy_runway_hit: ['control', 'Enemy runway cratered. Keep it up!'],
  enemy_runway_closed: ['control', 'Enemy runway closed. They can no longer take off!'],
  parked_lost: ['control', 'Hawkinge here. Aircraft destroyed on the ground!'],
  parked_kill: ['control', 'Parked enemy aircraft destroyed. Well done!'],
  kill_flak: ['control', 'Enemy flak battery destroyed.'],
  kill_lightAA: ['control', 'Enemy anti-aircraft gun destroyed.'],
  kill_fuel: ['control', 'Enemy fuel store destroyed. That will burn for hours.'],
  kill_tower: ['control', 'Enemy control tower destroyed.'],
  kill_target: ['control', 'Enemy target destroyed.'],
  collision: ['wing', 'Mid-air collision!'],
  rearmed: ['crew', 'Rearmed, refuelled and patched up. Good hunting, sir!'],
  victory: ['control', 'All aircraft, all aircraft. The enemy airfield is finished. Magnificent work. Come on home.'],
  defeat: ['control', 'All aircraft. Hawkinge is lost. I say again, Hawkinge is lost.'],
  break_left: ['wing', 'Breaking left!'],
  break_right: ['wing', 'Breaking right!'],
  order_attack: ['you', 'Red Section, attack my target!'],
  order_cover: ['you', 'Red Section, form up on me!'],
  order_engage: ['you', 'Red Section, engage at will!'],
  wilco: ['wing', 'Wilco, leader!'],
  forming_up: ['wing', 'Forming up, leader.'],
  player_down: ['wing', 'Red Leader is hit! Get out, sir, get out!'],
};
for (let n = 2; n <= 4; n++) {
  LINES[`red${n}_down`] = ['wing', `Red ${NUM[n]} is going down!`];
  LINES[`red${n}_landing`] = ['wing', `Red ${NUM[n]}, landing to rearm.`];
}
for (let n = 1; n <= 20; n++) {
  const s = n === 1 ? 'bandit' : 'bandits';
  LINES[`bandits_${n}`] = ['control', `Sector Control. ${NUM[n]} ${s} inbound. Scrambling another section.`];
  LINES[`bandits_${n}_b`] = ['control', `Sector Control. ${NUM[n]} ${s} inbound, with bombers. Scrambling another section.`];
}
