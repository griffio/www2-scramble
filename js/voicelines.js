// Prerecorded ElevenLabs radio performances. Scripts are shared by the game and offline generator.
// Role directions are production metadata; no credentials or live TTS calls are used in the game.
export const SPEAKERS = {
  control: { direction: 'measured sector controller', speed: .98, stability: .55, style: .18 },
  wing: { direction: 'alert combat pilot', speed: 1.04, stability: .42, style: .32 },
  crew: { direction: 'calm navigator or ground crew', speed: 1, stability: .5, style: .2 },
  you: { direction: 'decisive flight leader', speed: 1.02, stability: .48, style: .25 },
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

// Short R/T performances: control instructions stay in the captions, not in the spoken dialogue.
Object.assign(LINES, {
  factory_coast_start: ['crew', 'Dutch coast behind us. Aircraft ready, bombs aboard. Take us inland, skipper.'],
  factory_no_wingmen: ['crew', 'No wingmen answering. We are on our own, skipper.'],
  factory_order_suppress: ['you', 'Strike section, suppress those gun positions. Go in low.'],
  factory_order_cover: ['you', 'Strike section, break off. Form up and cover our withdrawal.'],
  factory_order_bomb: ['you', 'Strike section, attack the wireless works. Make your runs.'],
  factory_interceptors: ['wing', 'Two fighters coming in from the east! Turn for the coast. Watch our tail!'],
  factory_return: ['crew', 'Turning for Hawkinge. Steady as she goes, skipper. Let us get her home.'],
  aa_spotted: ['crew', 'Gun positions ahead. Keep down. We can silence the light guns with cannon.'],
  aa_incoming: ['wing', 'Tracers coming up! Break, break! Do not give them a steady target!'],
  altitude_warning: ['crew', 'We are too high, skipper. The guns have our height. Get her down!'],
  factory_final_approach: ['control', 'Hawkinge to Strike Leader. Turn south for the runway. Undercarriage down. You are clear to land.'],
  factory_takeoff: ['crew', 'Ready, skipper. Open her up. I will call the coast once we are airborne.'],
  factory_coast: ['crew', 'English coast ahead. Ease her down towards the water.'],
  factory_channel: ['crew', 'Over the Channel now. Keep her low. Watch those wave tops.'],
  factory_country: ['crew', 'Dutch countryside ahead. Follow the canals. The works are inland.'],
  factory_approach: ['crew', 'Wireless works ahead. Line her up. Steady, skipper.'],
  factory_release: ['you', 'Bombs gone! Eight second delay. Keep going, clear the works!'],
  factory_egress: ['crew', 'Keep her moving! I have got the works behind us. Stand by for the blast.'],
  factory_escape: ['crew', 'We have cleared the target. Turn west, then out to sea. Keep watching our tail.'],
  factory_homeward: ['crew', 'Homeward across the Channel. Easy on her, skipper. We will nurse her back.'],
  factory_landing: ['control', 'Strike Leader, Hawkinge. Runway ahead. Check your undercarriage. Bring her in.'],
  factory_success: ['control', 'Strike Leader, the works are hit and your section is clear. Good show. Bring them home.'],
  factory_landed: ['crew', 'We are down, skipper. Aircraft and crew home in one piece. Well flown.'],
  factory_failed: ['control', 'Strike Leader, the target is still standing. Break off and return to base.'],
  mission_aircraft_lost: ['wing', 'Leader is down! Break off. Return to base.'],
  escort_intro: ['control', 'Red Leader, six Bostons crossing the coast. Stay with them to the target and bring them home. Watch the sun. Bandits expected.'],
  convoy_intro: ['control', 'Strike Leader, convoy ahead. Two merchantmen with an armed escort. Go in low. Suppress the guns, then make your torpedo attack.'],
  precision_intro: ['control', 'Red Leader, the headquarters is your target. Occupied houses alongside. One accurate pass, then straight out to sea. Keep your bombs clear of the houses.'],
  intercept_intro: ['control', 'Formation ahead. Break up the bombers before they reach the depot. Watch their rear gunners. Escort fighters above.'],
  rescue_intro: ['control', 'Red Leader, damaged Boston ahead. He cannot keep up. Stay with him across the Channel. Bring that crew home.'],
  fortress_intro: ['control', 'Mustang Leader, you are with the Fortresses through the bomb run. Keep those fighters off the heavies. Get those crews to the handover.'],
  norway_intro: ['control', 'Coastal Command to Red Leader. Six German merchantmen ahead. Destroyer escort with heavy flak, and a surfaced U-boat. Close in low and use your solid shot rockets against the merchant hulls. Sink at least one, then clear west.'],
  norway_approach: ['crew', 'Ships ahead, skipper. Close to range. Aim for the waterline and keep her steady.'],
  norway_order_strike: ['you', 'Section, attack the merchantmen with rockets. Close to range and break clear after firing.'],
  norway_rockets_away: ['crew', 'Rockets away! Watch for strikes. Keep her steady, then break clear, skipper!'],
  mission_order_engage: ['you', 'Section, take those fighters. Keep them off the bombers.'],
  mission_order_close: ['you', 'Section, close escort. Stay with the bombers.'],
  mission_order_straggler: ['you', 'Cover the straggler. Stay with him. Watch his tail.'],
  mission_order_suppress: ['you', 'Section, suppress those guns. Give the strike aircraft a clear run.'],
  mission_order_cover: ['you', 'Section, break off. Form up and cover me.'],
  mission_order_strike: ['you', 'Strike section, torpedo attack. Take the merchantmen. Go in low.'],
  mission_order_hold: ['you', 'Section, hold formation. Leave the bombing to me.'],
  mission_order_bombers: ['you', 'Attack the bombers. Break up that formation before they release.'],
  mission_order_escorts: ['you', 'Take the escort fighters. Keep them clear of our attack.'],
  fighters_inbound: ['wing', 'Bandits coming in! Cover the bombers. Watch the high side!'],
  fighters_final: ['wing', 'Another attack coming in! Do not leave the bombers. Break into them!'],
  precision_fighters: ['wing', 'Fighters coming in! Cover the withdrawal. Keep going for the coast!'],
  torpedo_hold: ['crew', 'Hold release, skipper. Too far outside the dropping limits. Low and level. Steady her first.'],
  convoy_approach: ['crew', 'Convoy in sight. Guns on the escort. Line up a merchant and allow for her course.'],
  torpedo_away: ['crew', 'Torpedo away! Break clear of the ship. Watch for tracers!'],
  precision_target: ['crew', 'Headquarters ahead. Houses to the side. Steady on the run. Make this one count.'],
  precision_bombs_away: ['crew', 'Bombs away. Keep clear of the houses. Straight out, skipper!'],
  bomber_abort: ['wing', 'Taking too much damage. We have to turn back. Aborting the bomb run.'],
  bomber_straggler: ['wing', 'Engine trouble. I am falling behind. Stay with me, leader.'],
  bomber_bomb_run: ['wing', 'Starting the bomb run. Hold formation. Keep those fighters off us.'],
  bomber_bombs_away: ['wing', 'Bombs away. Keep formation. Stay with us for the turn.'],
  escort_homeward: ['control', 'Formation turning for home. Stay close. They may have another go at the stragglers.'],
  escort_success: ['control', 'Formation across the English coast. You are clear to break off. Good work, Red Leader. Come on home.'],
  escort_failed: ['control', 'Too few of the bombers made it through. Break off the escort and return to base.'],
  rescue_success: ['wing', 'English coast ahead! We are going to make it. Thank you, leader. You brought us home.'],
  rescue_failed: ['control', 'The Boston is gone. Break off, Red Leader. Return to base.'],
  fortress_success: ['control', 'The heavies are at the handover. You brought those crews through. You are clear to break off, Mustang Leader.'],
  fortress_failed: ['control', 'We have lost too many of the heavies. Break off the escort. Bring your flight home.'],
  convoy_success: ['control', 'Merchant shipping hit. Strike section clear of the convoy. Good show. Return to base.'],
  norway_success: ['control', 'Merchant sunk. Coastal Command confirms the strike. Clear the coast and return to base.'],
  norway_failed: ['control', 'No merchant ships sunk. Break off the attack and return to base.'],
  convoy_failed: ['control', 'The merchantmen are still afloat. Torpedoes expended. Break off and return to base.'],
  precision_success: ['control', 'Headquarters destroyed. The houses are clear. Good shooting, Red Leader. Return to base.'],
  precision_failed: ['control', 'The headquarters is still standing. Break off. Do not make another pass.'],
  precision_collateral: ['control', 'Abort the attack. The houses have been hit. Break off and return to base.'],
  intercept_success: ['control', 'The bomber formation is broken. Good work. Disengage and return to base.'],
  intercept_failed: ['control', 'The bombers have released over the depot. Break off the attack and return to base.'],
  kill_factory: ['wing', 'Good hits on the wireless works. Smoke rising from the halls.'],
  kill_ship: ['wing', 'Direct hit! Merchant going down. Watch those guns as we pull clear!'],
  kill_objective: ['wing', 'Good hits. The target is destroyed.'],
  kill_housing: ['control', 'Occupied housing has been hit. Abort the attack.'],
  wingman_down: ['wing', 'One of our section is going down! Watch out, leader!'],
  wingman_landing: ['wing', 'Returning to base. Landing to rearm.'],
});

// American sorties never fall back to a British performance. Shared calls get a US recording.
export const AMERICAN_KEYS = new Set([
  'fortress_intro', 'fortress_success', 'fortress_failed', 'mission_aircraft_lost',
  'mission_order_engage', 'mission_order_close', 'mission_order_straggler', 'mission_order_cover',
  'fighters_inbound', 'fighters_final', 'bomber_abort', 'bomber_straggler', 'bomber_bomb_run',
  'bomber_bombs_away', 'escort_homeward', 'aa_spotted', 'aa_incoming', 'altitude_warning',
  'kill_flak', 'kill_lightAA', 'kill_objective', 'kill_target', 'collision', 'rearmed',
  'wingman_down', 'wingman_landing', 'player_down',
]);
export const AMERICAN_TEXT = {
  aa_spotted: 'Flak positions ahead. Keep your eyes open. Watch for fighters coming through the bursts.',
  altitude_warning: 'They have got our altitude. Keep moving. Do not give those gunners a steady target.',
  escort_homeward: 'The heavies are turning for home. Stay with them. Watch the stragglers. Those fighters may come around again.',
  rearmed: 'Fuel topped off. Guns loaded. She is ready to go, Lieutenant.',
  player_down: 'Mustang Leader is hit! Bail out! Get out of there!',
};
export const voicePackFor = scenario => scenario === 'fortress' ? 'american' : 'british';

// New mission captions awaiting recordings: ElevenLabs quota is exhausted.
// Keep these outside the recorded catalog so audio verification stays strict.
export const CAPTION_ONLY_LINES = {
  fjord_intro: ['control', 'Coastal Command to Strike Leader. Enemy destroyer sheltering in the fjord. Go in low, suppress the guns and strike her hull with rockets. Cripple her, then bring your section back to open sea.'],
  fjord_target: ['crew', 'Destroyer ahead, skipper. Close to rocket range. Keep her steady and aim for the waterline.'],
  fjord_rockets: ['crew', 'Rockets away! Watch the waterline, then break clear!'],
  fjord_crippled: ['crew', 'She is crippled! We can leave now. Another pass might sink her. Your call, skipper.'],
  fjord_sunk: ['crew', 'Destroyer sinking! Recall the section. West to open water!'],
  fjord_fighters: ['control', 'Focke-Wulfs entering the fjord! Finish your run and bring the section out!'],
  fjord_order_suppress: ['you', 'Section, suppress the deck guns. Keep your rockets.'],
  fjord_order_cover: ['you', 'Break off. Regroup and cover the withdrawal.'],
  fjord_order_strike: ['you', 'Section, attack the destroyer. Rockets into the hull.'],
  fjord_success: ['control', 'Strike confirmed. Your aircraft is clear of the fjord. Good show. Bring them home.'],
  fjord_failed: ['control', 'The strike has failed. Break off and return to base.'],
};
