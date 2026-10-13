// Headless AI-vs-AI battle: checks the sim runs, the commanders scramble and raid, and a side wins.
// usage: node tools/battle.mjs [difficulty] [maxMinutes] [seedRuns]
import { World } from '../js/world.js';
import { Sim, SIM_DT } from '../js/sim.js';
import { TYPES } from '../js/types.js';
let models = null;
try { models = (await import('../js/models.js')).buildModels(); for (const k in TYPES) TYPES[k].geom = models.aircraft[k]; } catch (e) { console.log('(no models: ' + e.message + ')'); }
const diff = process.argv[2] || 'normal', maxMin = +(process.argv[3] || 30), runs = +(process.argv[4] || 1);
const world = new World();
console.log('world gen', world.genTime, 'ms');
for (let r = 0; r < runs; r++) {
  // fresh world state per run (targets are mutated)
  const w = r === 0 ? world : new World();
  const sim = new Sim(w, { difficulty: diff, headless: true, noPlayer: true });
  let lastLog = 0, kills = [0, 0];
  const t0 = Date.now();
  let msgs = []; const killStats = {}; const drops = [0, 0];
  while (!sim.result && sim.time < maxMin * 60) {
    sim.step(SIM_DT);
    for (const e of sim.events) {
      if (e.t === 'kill') { kills[e.victim.team]++; const k = `${e.killer ? e.killer.type.key : (e.crash ? 'crash' : 'flak/none')}>${e.victim.type.key}`; killStats[k] = (killStats[k] || 0) + 1; }
      if (e.t === 'bombdrop') drops[e.ac.team]++;
      if (e.t === 'msg' && runs === 1) msgs.push(`${(sim.time / 60).toFixed(1)}m ${e.text}`);
    }
    sim.events.length = 0;
    if (sim.time - lastLog > 60) {
      lastLog = sim.time;
      const st = [0, 1].map((id) => sim.teamStatus(id));
      const states = {};
      for (const p of sim.pilots.values()) states[p.state] = (states[p.state] || 0) + 1;
      if (runs === 1) console.log(`t=${(sim.time / 60).toFixed(0)}m  RAF air ${st[0].airborne} stock ${st[0].stock} hang ${st[0].hangars} rwy ${st[0].runway} lost ${kills[0]} | LW air ${st[1].airborne} stock ${st[1].stock} hang ${st[1].hangars} rwy ${st[1].runway} lost ${kills[1]} | bullets ${sim.bullets.n} ${JSON.stringify(states)}`);
    }
  }
  const ms = Date.now() - t0;
  if (!sim.result) console.log('  unresolved:', sim.aircraft.map((a) => `${a.type.key}/${a.team}/${a.pilot ? a.pilot.state : '-'}/${a.group ? a.group.kind : ''}/ammo${a.ammo.join(',')}/b${a.bombs}`).join(' '));
  console.log('  kills', JSON.stringify(Object.entries(killStats).sort((a, b) => b[1] - a[1]).slice(0, 14)), 'bomb drops RAF/LW', drops.join('/'), 'status', JSON.stringify([0, 1].map((i) => sim.teamStatus(i))));
  if (runs === 1) console.log(msgs.slice(0, 60).join('\n'));
  console.log(`run ${r}: result ${sim.result ? ['RAF', 'LW'][sim.result.winner] + ' wins' : 'none'} at ${(sim.time / 60).toFixed(1)} min; losses RAF ${kills[0]} LW ${kills[1]}; sim speed ${(sim.time * 1000 / ms).toFixed(0)}x realtime (${(ms / (sim.time / SIM_DT)).toFixed(3)} ms/step)`);
}
