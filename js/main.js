// SCRAMBLE! - WW2 arcade air combat over the Strait of Dover.
// Fixed-step simulation (60 Hz) + presentation at display rate: aircraft are drawn where they are
// *now* (advanced through the leftover sub-step) so nothing judders against the camera.
import { V3, Quat, qrot, qrotInv, clamp, lerp, damp, smoothstep, DEG, G, mulberry32 } from './math.js';
import { World, FIELDS, TEAM, fieldToWorld, worldToField, MAP_HALF } from './world.js';
import { TYPES, GUNS } from './types.js';
import { Sim, SIM_DT } from './sim.js';
import { steer, leadPoint, Pilot } from './ai.js';
import { buildModels, STATIC_CAMO } from './models.js';
import { MeshBuilder, MAT } from './mesh.js';
import { Renderer } from './render.js';
import { Particles, P, explosion, flakBurst, impact, hitSparks } from './particles.js';
import { HUD } from './hud.js';
import { Input, PAD } from './input.js';
import { GameAudio } from './audio.js';
import { LINES } from './voicelines.js';

const $ = (s) => document.querySelector(s);
const rnd = Math.random;
const GUN_KINDS = ['cannon', 'mg', 'hmg', 'gunner', 'aa'];
const SUN = (() => { const az = 232 * DEG, el = 33 * DEG; return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]; })();
const ENV = {
  sunDir: SUN, sunCol: [1.08, 0.98, 0.86], zen: [0.20, 0.38, 0.70], hor: [0.70, 0.77, 0.86],
  fogDensity: 1 / 26000, fogFall: 1 / 2200, ambient: 0.52, cloudShadow: 0.42, cloudOff: [0, 0], time: 0,
};
const WIND = [4.5, 1.5];      // cloud drift m/s
const CLOUD_BASE = 1150;

const _v = new V3(), _w = new V3(), _q = new Quat(), _q2 = new Quat();
const NOSE_ENGINE = [{ x: 0, y: 0, z: -2 }];

class Game {
  constructor() {
    this.canvas = $('#gl'); this.hudCanvas = $('#hud');
    this.state = 'boot';
    this.acc = 0; this.last = 0; this.paused = false;
    this.camMode = 'chase'; this.mouseAim = localStorage.getItem('scramble.mouseAim') === 'on'; this.newsreel = false; this.showPerf = false; this.bigMap = false;
    this.aimYaw = 0; this.aimPitch = 0; this.zoom = 1;
    this.throttle = 1;
    this.cam = { pos: new V3(0, 200, 0), q: new Quat(), fov: 62 * DEG, vel: new V3() };
    this.camSmooth = new Quat();
    this.shake = 0; this.flash = 0; this.score = 0;
    this.rum = { s: 0, w: 0 };     // controller rumble levels, decaying
    this.perf = { fps: 60, sim: 0, render: 0 };
    this.dyn = { avg: 1 / 60, cool: 3 };
    this.wingOrder = 'engage';
    this.voice = localStorage.getItem('scramble.voice') !== 'off';
    this.selType = localStorage.getItem('scramble.type') || 'spitfire';
    this.selDiff = localStorage.getItem('scramble.diff') || 'normal';
  }

  async boot() {
    const status = (t) => { $('#loading .msg').textContent = t; };
    status('SURVEYING THE CHANNEL');
    await frame();
    this.world = new World();
    status('ASSEMBLING AIRCRAFT');
    await frame();
    this.models = buildModels();
    for (const k in TYPES) TYPES[k].geom = this.models.aircraft[k];
    status('STARTING ENGINES');
    await frame();
    this.R = new Renderer(this.canvas);
    this.R.initTerrain(this.world);
    this.registerMeshes();
    this.buildClouds();
    this.ps = new Particles(14000);
    this.hud = new HUD(this.hudCanvas, this.world, { lowRes: this.R.integrated });
    this.input = new Input(this.canvas);
    this.audio = new GameAudio();
    this.tracerData = new Float32Array(8192 * 12);
    this.cloudData = new Float32Array(4096 * 8);
    this.startAttract();
    this.setupUI();
    $('#loading').style.display = 'none';
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- meshes
  registerMeshes() {
    const R = this.R, M = this.models;
    this.acMesh = {};
    for (const k in M.aircraft) {
      const a = M.aircraft[k];
      this.acMesh[k] = { body: R.addMesh('body:' + k, a.body, 48), gear: R.addMesh('gear:' + k, a.gear, 48), camo: a.camo };
    }
    for (const k in M.props) R.addMesh('prop:' + k, M.props[k], 96);
    // propeller blur disc (unit radius, faces -z)
    const b = new MeshBuilder();
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      for (const [r0, r1, col] of [[0.12, 0.86, [0.16, 0.15, 0.13]], [0.86, 1.0, [0.75, 0.62, 0.15]]]) {
        b.quad([Math.cos(a0) * r0, Math.sin(a0) * r0, 0], [Math.cos(a0) * r1, Math.sin(a0) * r1, 0], [Math.cos(a1) * r1, Math.sin(a1) * r1, 0], [Math.cos(a1) * r0, Math.sin(a1) * r0, 0], col, MAT.PLAIN);
      }
    }
    R.addMesh('propdisc', b.build(), 96);
    for (const k in M.statics) {
      const dyn = ['bomb500', 'bomb250', 'parachute', 'debris', 'hangar', 'hangarRuin', 'tower', 'fuelTank', 'flakGun', 'lightAA', 'crater', 'wreck'].includes(k);
      R.addMesh('s:' + k, M.statics[k], dyn ? 64 : 512, !dyn);
    }
    // permanent static scenery (landmarks, airfield clutter): uploaded once
    const STREAM = new Set(['house1', 'house2', 'house3']);
    for (const [k, list] of Object.entries(this.world.scenery)) {
      const mesh = R.meshes['s:' + k];
      if (!mesh || STREAM.has(k)) continue;
      const d = new Float32Array(list.length * 8);
      list.forEach(([x, y, z, yaw, s], i) => { _q.setAxisAngle(0, 1, 0, yaw); d.set([x, y, z, s, _q.x, _q.y, _q.z, _q.w], i * 8); });
      R.setInstances(mesh, d, list.length);
    }
    // far-LOD trees: a 5-sided cone and a squat blob (a few triangles each)
    const lod = (pine) => {
      const b = new MeshBuilder();
      if (pine) b.cylinder([0, 2.2, 0], [0, 13, 0], 2.6, 0, 5, [0.11, 0.2, 0.08], MAT.PLAIN, false);
      else b.ellipsoid([0, 7.5, 0], 4.6, 4.2, 4.6, [0.17, 0.26, 0.1], MAT.PLAIN, 5, 3);
      return b.build();
    };
    R.addMesh('far:treePine', lod(true), 4096, true);
    R.addMesh('far:treeOak', lod(false), 4096, true);
    // streamed scenery: houses + trees bucketed into 2 km chunks
    const CH = 2000;
    this.chunks = new Map();
    const put = (name, x, y, z, yaw, s) => {
      const key = Math.floor(x / CH) * 1000 + Math.floor(z / CH);
      let c = this.chunks.get(key);
      if (!c) this.chunks.set(key, (c = { x: (Math.floor(x / CH) + 0.5) * CH, z: (Math.floor(z / CH) + 0.5) * CH, lists: {} }));
      _q.setAxisAngle(0, 1, 0, yaw);
      (c.lists[name] || (c.lists[name] = [])).push(x, y, z, s, _q.x, _q.y, _q.z, _q.w);
    };
    for (const k of STREAM) for (const [x, y, z, yaw, sc] of this.world.scenery[k] || []) put(k, x, y, z, yaw, sc);
    for (const t of this.world.trees) put(t[5] ? 'treeOak' : 'treePine', t[0], t[1] - 0.3, t[2], t[3], t[4]);
    for (const c of this.chunks.values()) for (const k in c.lists) c.lists[k] = new Float32Array(c.lists[k]);
    this.streamBuf = {};
    this.streamT = 0;
  }

  // gather the scenery chunks around (and in front of) the camera; trees switch to a cheap
  // far mesh beyond ~2.5 km, houses drop out beyond ~6 km (the terrain shader paints towns)
  streamScenery() {
    if (--this.streamT > 0) return;
    this.streamT = 4;
    const R = this.R, cam = this.cam, CH = 2000;
    qrot(cam.q, 0, 0, -1, _v);
    const cosLim = Math.cos(Math.min(Math.PI, cam.fov * 0.5 * Math.hypot(1, R.W / R.H) + 0.6));
    const out = {};
    let sig = '';
    const add = (name, arr) => { (out[name] || (out[name] = [])).push(arr); };
    const cx = Math.floor(cam.pos.x / CH), cz = Math.floor(cam.pos.z / CH), rad = 4;
    for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      const c = this.chunks.get((cx + dx) * 1000 + (cz + dz));
      if (!c) continue;
      const rx = c.x - cam.pos.x, rz = c.z - cam.pos.z, ry = -cam.pos.y * 0.5;
      const d = Math.hypot(rx, ry, rz);
      if (d > 8200) continue;
      if (d > CH * 1.5 && (rx * _v.x + ry * _v.y + rz * _v.z) / d < cosLim) continue;
      sig += `${dx},${dz}${d < 2600 ? 'n' : d < 6000 ? 'm' : 'f'};`;
      for (const k in c.lists) {
        if (k.startsWith('tree')) add(d < 2600 ? 's:' + k : 'far:' + k, c.lists[k]);
        else if (d < 6000) add('s:' + k, c.lists[k]);
      }
    }
    sig = `${cx},${cz}|${sig}`;
    if (sig === this.streamSig) return;
    this.streamSig = sig;
    for (const name of ['s:treePine', 's:treeOak', 'far:treePine', 'far:treeOak', 's:house1', 's:house2', 's:house3']) {
      const mesh = R.meshes[name];
      if (!mesh) continue;
      const parts = out[name] || [];
      let n = 0; for (const p of parts) n += p.length;
      let buf = this.streamBuf[name];
      if (!buf || buf.length < n) buf = this.streamBuf[name] = new Float32Array(Math.ceil(n * 1.3) + 8);
      let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      R.setInstances(mesh, buf, n / 8);
    }
  }

  buildClouds() {
    // cumulus clusters where the cloud-shadow noise is dense (so shadows on the ground line up)
    const N = this.R.noise, r = mulberry32(77);
    const puffs = [];
    for (let z = -30000; z < 30000; z += 900) for (let x = -30000; x < 30000; x += 900) {
      const jx = x + (r() - 0.5) * 800, jz = z + (r() - 0.5) * 800;
      const n = N.at(jx / 11000, jz / 11000, 0);
      if (n < 0.62 || r() > 0.7) continue;
      const k = smoothstep(0.62, 0.74, n);
      const size = 280 + k * 520;                       // cluster radius
      const np = 7 + Math.round(k * 16);
      for (let i = 0; i < np; i++) {
        const a = r() * 6.28, d = Math.sqrt(r()) * size * 0.85;
        const top = size * (0.35 + k * 0.6) * (1 - d / size * 0.7);
        const h = Math.pow(r(), 0.8) * top;
        const ps = (180 + r() * 220) * (0.6 + k * 0.6) * (1 - h / (top * 2.5 + 1));
        puffs.push([jx + Math.cos(a) * d, CLOUD_BASE + ps * 0.35 + h, jz + Math.sin(a) * d * 0.8, ps, clamp(h / (top + 1), 0, 1), r() * 6.28, 0.8 + r() * 0.2, r() < 0.5 ? 0 : 1]);
      }
    }
    this.clouds = puffs;
  }

  // ---------------------------------------------------------------- game flow
  hideOverlays() {
    clearTimeout(this.endTimer);
    for (const id of ['#end', '#respawn', '#pause']) $(id).classList.add('hidden');
    if (window.speechSynthesis) { window.speechSynthesis.cancel(); this.speakQ = 0; }
  }
  startAttract() {
    this.hideOverlays();
    this.paused = false;
    this.world.resetTargets();
    this.sim = new Sim(this.world, { difficulty: 'normal', noPlayer: true });
    this.state = 'title';
    this.attractT = 0; this.attractTarget = null; this.spectate = null;
    this.camMode = 'cinematic';
  }
  startGame() {
    this.hideOverlays();
    this.paused = false;
    this.world.resetTargets();
    this.ps.n = 0;
    this.sim = new Sim(this.world, { difficulty: this.selDiff, playerType: this.selType });
    this.state = 'play';
    this.score = 0; this.dead = false; this.respawnShown = false;
    this.spectate = null; this.wingOrder = 'engage';   // per-battle state (the new Sim's flight starts on "engage")
    this.camMode = 'chase';
    const f = this.world.fields[0];
    this.aimYaw = f.hdg; this.aimPitch = 11 * DEG;
    this.throttle = 1;
    this.hud.msgs = [];
    this.hud.big('SCRAMBLE!', `${TYPES[this.selType].name} - ${f.name}`, 4);
    this.audio.ui('start');
    $('#title').classList.add('hidden'); $('#end').classList.add('hidden'); $('#respawn').classList.add('hidden');
    if (this.mouseAim) this.input.lock();
  }
  endGame(winner) {
    this.state = 'end';
    const won = winner === this.sim.playerTeam;
    const st = this.sim.playerStats;
    $('#end h1').textContent = won ? 'VICTORY' : 'DEFEAT';
    $('#end .sub').textContent = won ? 'The Luftwaffe airfield is in ruins and their squadrons are destroyed.' : 'Hawkinge has been knocked out. The Luftwaffe rules the Channel skies today.';
    $('#end .stats').innerHTML = `
      <div><b>${st.kills}</b>AIR KILLS</div><div><b>${st.groundKills}</b>GROUND TARGETS</div>
      <div><b>${st.sorties}</b>SORTIES</div><div><b>${this.score}</b>SCORE</div>
      <div><b>${this.sim.teams[1].losses}</b>LUFTWAFFE LOSSES</div><div><b>${this.sim.teams[0].losses}</b>RAF LOSSES</div>
      <div><b>${Math.floor(this.sim.time / 60)}:${String(Math.floor(this.sim.time % 60)).padStart(2, '0')}</b>BATTLE TIME</div>`;
    $('#end').classList.remove('hidden'); $('#respawn').classList.add('hidden');
    this.audio.ui(won ? 'victory' : 'defeat');
    this.input.unlock();
  }

  setupUI() {
    const sel = () => {
      document.querySelectorAll('.plane').forEach((e) => e.classList.toggle('on', e.dataset.type === this.selType));
      document.querySelectorAll('.diff button').forEach((e) => e.classList.toggle('on', e.dataset.diff === this.selDiff));
    };
    document.querySelectorAll('.plane').forEach((e) => e.addEventListener('click', () => { this.selType = e.dataset.type; localStorage.setItem('scramble.type', this.selType); sel(); this.audio.ui('select'); }));
    document.querySelectorAll('.diff button').forEach((e) => e.addEventListener('click', () => { this.selDiff = e.dataset.diff; localStorage.setItem('scramble.diff', this.selDiff); sel(); this.audio.ui('select'); }));
    sel();
    const go = async () => {
      if (this.starting || (this.state !== 'title' && this.state !== 'end')) return;
      this.starting = true;
      try { await this.audio.init(); this.startGame(); } finally { this.starting = false; }
    };
    $('#go').addEventListener('click', go);
    $('#again').addEventListener('click', go);
    $('#menu').addEventListener('click', () => { $('#end').classList.add('hidden'); $('#title').classList.remove('hidden'); this.startAttract(); });
    $('#resume').addEventListener('click', () => this.setPaused(false));
    $('#quit').addEventListener('click', () => { this.setPaused(false); $('#title').classList.remove('hidden'); this.startAttract(); });
    document.querySelectorAll('#respawn .plane2').forEach((e) => e.addEventListener('click', () => this.respawn(e.dataset.type)));
    $('#title').addEventListener('click', () => this.audio.init(), { once: true });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'play' && !this.dead && this.mouseAim && !this.paused) this.setPaused(true);
    });
    this.canvas.addEventListener('click', () => { if (this.state === 'play' && !this.paused && this.mouseAim) this.input.lock(); });
    window.addEventListener('keydown', (e) => { if (e.code === 'Enter' && this.state === 'title') go(); });
    // a controller press doesn't count as a user gesture: started from the pad, the sound stays
    // suspended until the first click or key press
    const wake = () => { if (this.audio.ctx && this.audio.ctx.state === 'suspended') this.audio.init(); };
    window.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake);
    // the mouse takes over from the controller's menu focus ring
    document.addEventListener('mousemove', (e) => { if (this.navEl && (e.movementX || e.movementY) && !this.input.mouse.locked) this.navFocus(null); });
  }
  setPaused(p) {
    this.paused = p;
    $('#pause').classList.toggle('hidden', !p);
    if (!p) { if (this.mouseAim) this.input.lock(); } else this.input.unlock();
  }
  respawn(type) {
    if (this.sim.respawnPlayer(type)) {
      this.dead = false; this.respawnShown = false;
      $('#respawn').classList.add('hidden');
      const f = this.world.fields[0];
      this.aimYaw = f.hdg; this.aimPitch = 11 * DEG; this.throttle = 1;
      this.camMode = 'chase';
      this.hud.big('SCRAMBLE!', TYPES[type].name, 2.5);
      this.say('scramble_again');
      if (this.mouseAim) this.input.lock();
    }
  }

  // ---------------------------------------------------------------- input
  handleKeys() {
    const inp = this.input;
    for (const n of inp.padNotes) this.padNotice(n);
    inp.padNotes.length = 0;
    // a menu opening with a controller in hand starts with its default button focused
    const nav = inp.pad && this.navItems();
    if (nav && nav.key !== this.navKey) this.navFocus(nav.def);
    this.navKey = nav ? nav.key : null;
    for (const k of inp.consume()) {
      if (k === 'Backquote') this.showPerf = !this.showPerf;
      if (k === 'KeyN') this.newsreel = !this.newsreel;
      if (k.startsWith('Pad') && this.menuNav(k)) continue;
      if (this.state !== 'play') continue;
      if (k === 'KeyP' || k === 'Pad' + PAD.OPTIONS) this.setPaused(!this.paused);
      if (k === 'Escape' && !this.paused) this.setPaused(true);
      if (this.paused) continue;
      if (k === 'KeyC' || k === 'Pad' + PAD.CIRCLE) this.camMode = { chase: 'cockpit', cockpit: 'cinematic', cinematic: 'chase' }[this.camMode] || 'chase';
      if (k === 'KeyM') { this.mouseAim = !this.mouseAim; localStorage.setItem('scramble.mouseAim', this.mouseAim ? 'on' : 'off'); this.hud.radio(this.mouseAim ? 'CONTROLS: MOUSE AIM' : 'CONTROLS: ARROW KEYS / JOYSTICK', 'info'); if (this.mouseAim) { this.resetAim(); this.input.lock(); } else this.input.unlock(); }
      if (k === 'KeyT' || k === 'Pad' + PAD.SQUARE) this.cycleTarget();
      if ((k === 'KeyG' || k === 'Pad' + PAD.SHARE) && this.sim.player) {
        const p = this.sim.player; p.gearUp = !p.gearUp; p.gearAuto = false;
        if (p.state === 'air') { p.landing = false; p.flapDown = !p.gearUp; }   // flaps come down with the gear
        this.hud.radio(`GEAR${p.state === 'air' ? ' AND FLAPS' : ''} ${p.gearUp ? 'UP' : 'DOWN'} (MANUAL)`, 'info');
      }
      if (k === 'Tab' || k === 'Pad' + PAD.TOUCHPAD) this.bigMap = !this.bigMap;
      if (k === 'KeyR') { this.voice = !this.voice; localStorage.setItem('scramble.voice', this.voice ? 'on' : 'off'); this.hud.radio(`RADIO VOICE ${this.voice ? 'ON' : 'OFF'}`, 'info'); }
      if (k === 'KeyO') { this.audio.setMuted(!this.audio.muted); }
      if (k === 'Digit1' || k === 'Digit2' || k === 'Digit3') this.orderWingmen({ Digit1: 'attack', Digit2: 'cover', Digit3: 'engage' }[k]);
      // D-pad left / right: step through the wingman orders (every order is one press away)
      if (k === 'Pad' + PAD.LEFT || k === 'Pad' + PAD.RIGHT) {
        const O = ['attack', 'cover', 'engage'], i = O.indexOf(this.wingOrder);
        this.orderWingmen(O[(i + (k === 'Pad' + PAD.RIGHT ? 1 : 2)) % 3]);
      }
    }
  }
  orderWingmen(o) {
    this.wingOrder = o;
    if (this.sim.playerGroup) this.sim.playerGroup.order = o;
    const txt = { attack: 'RED SECTION, ATTACK MY TARGET!', cover: 'RED SECTION, FORM UP ON ME!', engage: 'RED SECTION, ENGAGE AT WILL!' }[o];
    this.hud.radio(`YOU: ${txt}`, 'wing');
    this.say(`order_${o}`);
    setTimeout(() => { this.hud.radio(`${o === 'cover' ? 'RED 2: FORMING UP, LEADER' : 'RED 2: WILCO, LEADER!'}`, 'wing'); this.say(o === 'cover' ? 'forming_up' : 'wilco'); }, 900);
  }
  padNotice(n) {
    const g = n.kind === 'ps'
      ? { a: '\u2715', b: '\u25CB', x: '\u25A1', y: '\u25B3', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L3', rs: 'R3', view: 'SHARE', menu: 'OPTIONS', pad: 'TOUCHPAD' }
      : { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', ls: 'L-STICK', rs: 'R-STICK', view: 'VIEW', menu: 'MENU', pad: '' };
    const el = $('#title .padctl');
    if (el) {
      el.classList.toggle('hidden', !n.on);
      el.innerHTML = `<b>${n.name}</b>: <b>LEFT STICK</b> fly &middot; <b>${g.lb}/${g.rb}</b> rudder &middot; <b>${g.rt}</b> guns &middot; <b>${g.lt}</b> or <b>${g.a}</b> bombs &middot; <b>D-PAD &uarr;/&darr;</b> throttle &middot; <b>${g.ls}</b> boost`
        + `<br><b>RIGHT STICK</b> look around &middot; <b>${g.rs}</b> check six &middot; <b>${g.y}</b> (hold) look at target &middot; <b>${g.x}</b> next target &middot; <b>${g.b}</b> camera &middot; <b>D-PAD &larr;/&rarr;</b> wingmen orders`
        + `<br><b>${g.view}</b> gear &middot; ${g.pad ? `<b>${g.pad}</b> map &middot; ` : ''}<b>${g.menu}</b> pause &middot; menus: <b>D-PAD</b> / stick + <b>${g.a}</b>, <b>${g.menu}</b> scramble`;
    }
    if (this.state === 'play') this.hud.radio(`${n.name} ${n.on ? 'CONNECTED' : 'DISCONNECTED'}`, 'info');
    if (!n.on && this.state === 'play' && !this.paused && !this.dead) this.setPaused(true);
  }

  // Menus with a controller: D-pad / left stick moves a focus ring between the visible overlay's
  // buttons, Cross / A presses, Circle / B backs out of the pause menu, Options / Menu starts.
  // Returns true when the press was used by a menu.
  navItems() {
    const vis = (id) => !$(id).classList.contains('hidden');
    let sel, def;
    if (vis('#pause')) { sel = '#pause button'; def = '#resume'; }
    else if (vis('#end')) { sel = '#end button'; def = '#again'; }
    else if (vis('#respawn')) { sel = '#respawn .plane2:not(.dis)'; def = `#respawn .plane2[data-type=${this.selType}]:not(.dis)`; }
    else if (this.state === 'title' && vis('#title')) { sel = '#title .plane, #title .diff button, #go'; def = '#go'; }
    else return null;
    const items = [...document.querySelectorAll(sel)];
    return { key: sel, items, def: $(def) || items[0] };
  }
  navFocus(el) {
    if (this.navEl) this.navEl.classList.remove('padfocus');
    this.navEl = el;
    if (el) { el.classList.add('padfocus'); el.scrollIntoView?.({ block: 'nearest' }); }
  }
  menuNav(k) {
    const nav = this.navItems();
    if (!nav) return false;
    const { items, def } = nav;
    let cur = items.includes(this.navEl) ? this.navEl : null;
    const dir = { [PAD.UP]: 'Up', [PAD.DOWN]: 'Down', [PAD.LEFT]: 'Left', [PAD.RIGHT]: 'Right' }[k.slice(3)] || (k.startsWith('PadNav') ? k.slice(6) : null);
    const focus = (el) => this.navFocus(el);
    if (dir) {
      if (!cur) { focus(def); return true; }
      // spatial: nearest item in that direction, off-axis distance weighted
      const r = cur.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      let best = null, bs = 1e9;
      for (const el of items) {
        if (el === cur) continue;
        const q = el.getBoundingClientRect(), dx = q.x + q.width / 2 - cx, dy = q.y + q.height / 2 - cy;
        const along = { Up: -dy, Down: dy, Left: -dx, Right: dx }[dir], off = dir === 'Up' || dir === 'Down' ? Math.abs(dx) : Math.abs(dy);
        if (along <= 1) continue;
        const sc = along + off * 2;
        if (sc < bs) { bs = sc; best = el; }
      }
      if (best) { focus(best); this.audio.ui('select'); }
      return true;
    }
    if (k === 'Pad' + PAD.CROSS) { (cur || def)?.click(); return true; }
    if (k === 'Pad' + PAD.CIRCLE && !$('#pause').classList.contains('hidden')) { this.setPaused(false); return true; }
    if (k === 'Pad' + PAD.OPTIONS && this.state !== 'play') { (this.state === 'title' ? $('#go') : $('#again')).click(); return true; }
    return k.startsWith('PadNav');   // other buttons fall through (Options still unpauses)
  }
  resetAim() { const p = this.sim.player; if (!p) return; this.aimYaw = p.compass; this.aimPitch = p.pitchAngle; }

  cycleTarget() {
    const p = this.sim.player; if (!p) return;
    // nearest enemy closest to the centre of view, prefer ones in front
    let best = null, bs = 1e9;
    const fwd = _v.set(0, 0, -1); qrot(this.cam.q, 0, 0, -1, fwd);
    for (const a of this.sim.aircraft) {
      if (a.team === p.team || !a.alive || a === this.sim.playerTarget) continue;
      _w.subVectors(a.pos, p.pos); const d = _w.len();
      if (d > 8000) continue;
      const ang = Math.acos(clamp(_w.dot(fwd) / d, -1, 1));
      const s = ang * 2500 + d;
      if (s < bs) { bs = s; best = a; }
    }
    if (best) this.sim.playerTarget = best;
  }
  autoTarget() {
    const p = this.sim.player, t = this.sim.playerTarget;
    if (t && t.alive && t.pos.dist(p.pos) < 9000) return;
    this.sim.playerTarget = null;
    let best = null, bs = 1e9;
    for (const a of this.sim.aircraft) {
      if (a.team === p.team || !a.alive) continue;
      _w.subVectors(a.pos, p.pos); const d = _w.len();
      if (d > 6000) continue;
      const s = d - _w.dot(p.fwd) / d * 1500;
      if (s < bs) { bs = s; best = a; }
    }
    this.sim.playerTarget = best;
  }

  controlPlayer(dt) {
    const p = this.sim.player;
    if (!p || !p.alive || this.paused) return;
    if (this.autopilot) {   // debug / demo: an AI pilot flies the player's aircraft
      if (!p.pilot) { p.pilot = new Pilot(this.sim, p, { skill: 0.9, group: this.sim.playerGroup }); this.sim.pilots.set(p, p.pilot); }
      return;
    }
    const ctl = p.ctl, inp = this.input, ax = this.axes;
    if (this.mouseAim) {
      const ca = Math.cos(this.aimPitch);
      steer(p, Math.sin(this.aimYaw) * ca, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * ca, 1, true);
      if (p.state === 'ground') ctl.yaw = clamp(ctl.yaw + ctl.roll, -1, 1);
    } else { ctl.pitch = 0; ctl.roll = 0; ctl.yaw = 0; }
    if (ax.active.pitch) ctl.pitch = ax.pitch;
    if (ax.active.roll) ctl.roll = ax.roll;
    if (ax.active.yaw) ctl.yaw = ax.yaw;
    // throttle
    if (inp.down('KeyW') || inp.padBtn(PAD.UP)) this.throttle = Math.min(1, this.throttle + dt * 0.7);
    if (inp.down('KeyS') || inp.padBtn(PAD.DOWN)) this.throttle = Math.max(0, this.throttle - dt * 0.7);
    ctl.throttle = this.throttle;
    ctl.boost = inp.down('ShiftLeft', 'ShiftRight') || inp.padBtn(PAD.L3);
    ctl.fire = (inp.mouse.buttons & 1) !== 0 || inp.down('Space', 'ControlLeft') || inp.padVal(PAD.R2) > 0.4;
    ctl.bomb = (inp.mouse.buttons & 4) !== 0 || inp.down('KeyB') || inp.padBtn(PAD.CROSS) || inp.padVal(PAD.L2) > 0.4;
    // wheel brakes: throttle closed (bar near empty), or S / D-pad down held while on the ground
    ctl.brake = this.throttle < 0.12 || (p.state === 'ground' && (inp.down('KeyS') || inp.padBtn(PAD.DOWN)));
  }

  // ---------------------------------------------------------------- main loop
  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.1, (t - (this.last || t)) / 1000);
    this.last = t;
    this.hud.resize();
    const dev = devSize(this.canvas, this.R.pixelCap);
    this.R.resize(dev.w, dev.h);
    this.axes = this.input.axes(dt);
    this.handleKeys();
    const [mdx, mdy, wheel] = this.input.takeMouse();
    if (wheel) this.zoom = clamp(this.zoom * (1 + wheel * 0.1), 0.5, 3);
    if (this.mouseAim && this.state === 'play' && !this.paused) {
      this.aimYaw += mdx * 0.0022 * this.cam.fov / (62 * DEG);
      this.aimPitch = clamp(this.aimPitch - mdy * 0.0022 * this.cam.fov / (62 * DEG), -1.45, 1.45);
    }
    // simulation
    const t0 = performance.now();
    const sim = this.sim;
    if (!this.paused && this.state !== 'end') {
      this.acc += dt;
      let n = 0;
      while (this.acc >= SIM_DT && n < 8) {
        this.controlPlayer(SIM_DT);
        sim.step(SIM_DT);
        this.acc -= SIM_DT; n++;
      }
      if (n >= 8) this.acc = 0;
      ENV.time += dt;
      ENV.cloudOff[0] += WIND[0] * dt; ENV.cloudOff[1] += WIND[1] * dt;
    }
    this.perf.sim = lerp(this.perf.sim, performance.now() - t0, 0.05);
    if (this.state === 'play' && sim.player && sim.player.alive) this.autoTarget();
    this.processEvents();
    if (!this.paused) {
      this.emitters(dt);
      this.ps.update(dt, WIND[0], WIND[1]);
    }
    this.present();
    this.updateCamera(dt);
    const t1 = performance.now();
    this.render(dt);
    this.perf.render = lerp(this.perf.render, performance.now() - t1, 0.05);
    this.perf.fps = lerp(this.perf.fps, dt > 0 ? 1 / dt : 60, 0.05);
    this.drawHud(dt);
    this.updateAudio(dt);
    this.updateRumble(dt);
    this.dynamicResolution(dt);
    if (this.state === 'play') this.gameFlow(dt);
  }

  updateRumble(dt) {
    const R = this.rum, p = this.sim.player;
    // a constant light buzz from the engine on emergency boost and in a stall buffet
    let s = R.s, w = R.w;
    if (this.state === 'play' && !this.paused && p && p.alive) {
      if (p.ctl.boost) w = Math.max(w, 0.12);
      if (p.stall > 0.2) { s = Math.max(s, p.stall * 0.35); w = Math.max(w, p.stall * 0.5); }
    } else if (this.paused || this.state !== 'play') s = w = 0;
    this.input.rumble(s, w, dt);
    R.s *= Math.exp(-dt * 9); R.w *= Math.exp(-dt * 14);
  }

  gameFlow(dt) {
    const sim = this.sim;
    if (sim.result && this.state === 'play') { this.endTimer = setTimeout(() => this.endGame(sim.result.winner), 2500); this.state = 'ending'; this.hud.big(sim.result.winner === sim.playerTeam ? 'VICTORY!' : 'DEFEAT', '', 3); this.say(sim.result.winner === sim.playerTeam ? 'victory' : 'defeat'); return; }
    const p = sim.player, tm = sim.teams[sim.playerTeam];
    const queued = !!tm && tm.launchQ.some((q) => q.player);
    if (p && p.alive) {
      if (this.dead || this.respawnShown) { this.dead = false; this.respawnShown = false; $('#respawn').classList.add('hidden'); }   // the replacement has launched
    } else if (!queued) {
      if (!this.dead) { this.dead = true; this.deadT = 0; this.input.unlock(); }
      this.deadT += dt;
      if (this.deadT > 3.5 && !this.respawnShown) {
        this.respawnShown = true;
        const open = sim.runwayOpen(sim.teams[0].field);
        const sp = sim.stockOf(0, 'spitfire'), mo = sim.stockOf(0, 'mosquito');
        $('#respawn .n-spitfire').textContent = `${sp} IN RESERVE`;
        $('#respawn .n-mosquito').textContent = `${mo} IN RESERVE`;
        document.querySelector('#respawn [data-type=spitfire]').classList.toggle('dis', !open || sp <= 0);
        document.querySelector('#respawn [data-type=mosquito]').classList.toggle('dis', !open || mo <= 0);
        $('#respawn .note').textContent = !open ? 'THE RUNWAY IS DESTROYED - NO AIRCRAFT CAN TAKE OFF. WATCH YOUR SQUADRON FIGHT ON.' : sp + mo <= 0 ? 'NO AIRCRAFT LEFT IN RESERVE.' : 'CHOOSE YOUR NEXT AIRCRAFT';
        $('#respawn').classList.remove('hidden');
      }
    }
  }

  processEvents() {
    const sim = this.sim, ps = this.ps, A = this.audio, p = sim.player;
    const near = (x, y, z, r) => { const dx = x - this.cam.pos.x, dy = y - this.cam.pos.y, dz = z - this.cam.pos.z; return dx * dx + dy * dy + dz * dz < r * r; };
    const play = this.state === 'play' || this.state === 'ending';
    for (const e of sim.events) {
      switch (e.t) {
        case 'gun': {
          const isP = e.ac && e.ac === p;
          if (e.ac && near(e.x, e.y, e.z, 3000)) {
            const a = e.ac;
            if (!e.gunner) {
              const g = a.type.geom, ms = g ? g.guns : [];
              for (const m of ms) { if (rnd() < 0.5) continue; qrot(a.q, m.x, m.y, m.z - 0.5, _v); ps.emit(P.muzzle, a.pos.x + _v.x, a.pos.y + _v.y, a.pos.z + _v.z, a.vel.x, a.vel.y, a.vel.z, m.kind === 'cannon' ? 1.2 : 0.8); }
            } else ps.emit(P.muzzle, e.x, e.y, e.z, a.vel.x, a.vel.y, a.vel.z, 0.7);
          } else if (!e.ac && near(e.x, e.y, e.z, 4000)) ps.emit(P.muzzle, e.x, e.y + 1, e.z, 0, 0, 0, 2);
          if (play || near(e.x, e.y, e.z, 2000)) A.gun(e.kind === 'aa' ? 'cannon' : e.kind === 'gunner' ? 'mg' : e.kind, e, isP);
          if (isP && play) { if (e.kind === 'cannon') this.rum.s = Math.max(this.rum.s, 0.3); this.rum.w = Math.max(this.rum.w, 0.35); }
          break;
        }
        case 'hit': {
          const big = e.kind === 'cannon' || e.kind === 'aa';
          const vx = e.ac ? e.ac.vel.x : 0, vy = e.ac ? e.ac.vel.y : 0, vz = e.ac ? e.ac.vel.z : 0;
          if (near(e.x, e.y, e.z, 4000)) hitSparks(ps, e.x, e.y, e.z, vx, vy, vz, big);
          if (e.ac && e.ac === p) { A.playerHit(big ? 0.8 : 0.4); this.shake = Math.max(this.shake, big ? 0.35 : 0.15); this.rum.s = Math.max(this.rum.s, big ? 0.9 : 0.55); }
          else if (near(e.x, e.y, e.z, 400)) A.impact(e, 'metal');
          if (e.ac && e.ac !== p && sim.playerTarget === e.ac) this.hitMarker = 0.15;
          break;
        }
        case 'impact':
          if (near(e.x, e.y, e.z, 3500)) impact(ps, e.x, e.y, e.z, e.water, e.kind === 'cannon' || e.kind === 'aa');
          if (near(e.x, e.y, e.z, 300)) A.impact(e, e.water ? 'water' : 'ground');
          break;
        case 'explode':
          if (near(e.x, e.y, e.z, 9000)) explosion(ps, e.x, e.y, e.z, e.size, e.kind, e.vx || 0, e.vy || 0, e.vz || 0);
          A.explosion(e, e.size);
          { const d = Math.hypot(e.x - this.cam.pos.x, e.y - this.cam.pos.y, e.z - this.cam.pos.z); this.shake = Math.max(this.shake, clamp(e.size * 120 / (d + 50), 0, 1)); if (play) this.rum.s = Math.max(this.rum.s, clamp(e.size * 150 / (d + 50), 0, 1)); this.flash = Math.max(this.flash, clamp(e.size * 60 / (d + 40), 0, 0.5)); }
          break;
        case 'debris':
          for (let k = 0; k < 6; k++) ps.emit(P.debris, e.x, e.y, e.z, e.vx * 0.6 + (rnd() - 0.5) * 50, e.vy * 0.6 + rnd() * 30, e.vz * 0.6 + (rnd() - 0.5) * 50, 1 + rnd(), 2);
          break;
        case 'flak': flakBurst(ps, e.x, e.y, e.z); A.flak(e); if (play) { const d = Math.hypot(e.x - this.cam.pos.x, e.y - this.cam.pos.y, e.z - this.cam.pos.z); this.rum.s = Math.max(this.rum.s, clamp(60 / (d + 20), 0, 0.7)); } break;
        case 'flakfire': if (near(e.x, e.y, e.z, 5000)) { ps.emit(P.flash, e.x, e.y + 2, e.z, 0, 0, 0, 0.6); ps.emit(P.smoke, e.x, e.y + 3, e.z, 0, 4, 0, 1); } break;
        case 'bombdrop': if (e.ac === p) { A.bombRelease(); this.rum.s = Math.max(this.rum.s, 0.5); } break;
        case 'kill': {
          if (!play) break;
          if (e.killer && e.killer === p) { A.ui('kill'); }
          if (e.victim === sim.playerTarget) sim.playerTarget = null;
          break;
        }
        case 'score': this.score += e.pts; this.hud.popup(e.text, e.pts); break;
        case 'msg':
          if (!play) break;
          this.hud.radio(e.text, e.cls);
          this.say(e.voice, e.text, e.cls);
          break;
        case 'fade': this.fade(); break;
        case 'towed': if (play) { this.chaseInit = false; this.hud.radio('TOWED TO THE RUNWAY - CLEARED FOR TAKE-OFF', 'good'); } break;
        case 'playerhit': this.dmgFlash = Math.min(0.8, (this.dmgFlash || 0) + e.dmg * 0.04); break;
        case 'playerdown': if (play) { this.hud.big('SHOT DOWN', 'You bail out over the Channel...', 3, 'rgba(255,90,60,0.95)'); A.ui('defeat'); this.say('player_down'); } break;
      }
    }
    sim.events.length = 0;
  }

  // radio speech: the recorded R/T line when there is one (falls back to the browser's speech
  // synthesis if the clip can't load), otherwise just the squelch for control / alert messages
  say(key, text = '', cls = 'control') {
    const A = this.audio, important = cls === 'control' || cls === 'alert';
    if (!this.voice) { if (important) A.radio(); return; }
    const urgent = !!LINES[key] && LINES[key][0] !== 'control' && LINES[key][0] !== 'crew';
    if (key) A.voice(key, () => { if (important && text) this.speak(text); }, urgent);
    else if (important) { A.radio(); if (text) this.speak(text); }
  }

  speak(text) {
    if (!window.speechSynthesis) return;
    const ss = window.speechSynthesis;
    if (ss.pending || ss.speaking) { if (this.speakQ > 1) return; }
    const clean = text.replace(/^[A-Z ]+: /, '').toLowerCase().replace(/\bjg\b/g, 'J G').replace(/!/g, '.');
    const u = new SpeechSynthesisUtterance(clean);
    if (!this.voices || !this.voices.length) this.voices = ss.getVoices().filter((v) => /en-GB/i.test(v.lang));
    if (this.voices.length) u.voice = this.voices[0];
    u.rate = 1.12; u.pitch = 0.9; u.volume = 0.8;
    this.speakQ = (this.speakQ || 0) + 1;
    u.onend = u.onerror = () => { this.speakQ = Math.max(0, (this.speakQ || 0) - 1); };   // cancelled / interrupted ones end with an error
    ss.speak(u);
  }

  // continuous effects: smoke trails, fire, exhaust, wingtip vapour, parachutes
  emitters(dt) {
    const ps = this.ps;
    for (const a of this.sim.aircraft) {
      const d2 = a.pos.distSq(this.cam.pos);
      if (d2 > 9000 * 9000) continue;
      const g = a.type.geom;
      const eng = g && g.engines.length ? g.engines : NOSE_ENGINE;
      a.emitT = (a.emitT || 0) + dt;
      const rate = d2 < 1500 * 1500 ? 0.03 : 0.07;
      if (a.emitT < rate) continue;
      const k = a.emitT; a.emitT = 0;
      if (a.smoke > 0.35 || a.state === 'down') {
        for (const e of eng) {
          qrot(a.q, e.x, e.y, e.z + 1, _v);
          const heavy = a.smoke > 0.7 || a.state === 'down';
          ps.emit(heavy ? P.blackSmoke : P.smoke, a.pos.x + _v.x, a.pos.y + _v.y, a.pos.z + _v.z, a.vel.x * 0.1, a.vel.y * 0.1, a.vel.z * 0.1, heavy ? 0.9 : 0.6);
          if (a.fire > 0 || a.state === 'down') {
            ps.emit(P.fire, a.pos.x + _v.x, a.pos.y + _v.y, a.pos.z + _v.z, a.vel.x * 0.8, a.vel.y * 0.8, a.vel.z * 0.8, 1.3);
            ps.emit(P.fire, a.pos.x + _v.x - a.vel.x * k * 0.5, a.pos.y + _v.y - a.vel.y * k * 0.5, a.pos.z + _v.z - a.vel.z * k * 0.5, a.vel.x * 0.8, a.vel.y * 0.8, a.vel.z * 0.8, 1.1);
          }
        }
      }
      // exhaust haze on take-off / at low speed near the camera
      if (d2 < 400 * 400 && g && a.rpm > 0.5 && a.state !== 'down') {
        const ex = g.exhausts[(Math.random() * g.exhausts.length) | 0];
        if (ex) { qrot(a.q, ex.x, ex.y, ex.z, _v); ps.emit(P.exhaust, a.pos.x + _v.x, a.pos.y + _v.y, a.pos.z + _v.z, a.vel.x * 0.85, a.vel.y * 0.85, a.vel.z * 0.85, 1); }
      }
      // wingtip vapour in hard turns
      if (a.nz > 4.2 && a.speed > 100 && d2 < 800 * 800 && g) {
        for (let s = -1; s <= 1; s += 2) { qrot(a.q, s * g.span * 0.48, 0, 0.3, _v); ps.emit(P.vapour, a.pos.x + _v.x, a.pos.y + _v.y, a.pos.z + _v.z, a.vel.x * 0.92, a.vel.y * 0.92, a.vel.z * 0.92, 0.8); }
      }
      // dust on the take-off roll
      if (a.state === 'ground' && a.speed > 15 && d2 < 1500 * 1500 && rnd() < 0.5) {
        ps.emit(P.dust, a.pos.x - a.fwd.x * 6, a.pos.y - 2, a.pos.z - a.fwd.z * 6, (rnd() - 0.5) * 4, 1, (rnd() - 0.5) * 4, 1.5);
      }
    }
    // burning wrecks and destroyed buildings (the timers always run; only nearby ones get particles)
    this.wreckT = (this.wreckT || 0) + dt;
    if (this.wreckT > 0.12) {
      this.wreckT = 0;
      const cx = this.cam.pos.x, cz = this.cam.pos.z, farSq = 9000 * 9000;
      for (const w of this.sim.wrecks) {
        w.t += 0.12;
        if (w.t > 90 || (w.x - cx) * (w.x - cx) + (w.z - cz) * (w.z - cz) > farSq) continue;
        if (rnd() < 0.5) ps.emit(P.blackSmoke, w.x + (rnd() - 0.5) * 4, w.y + 2, w.z + (rnd() - 0.5) * 4, 0, 3, 0, 1.2, 1.5);
        if (w.t < 25 && rnd() < 0.6) ps.emit(P.fire, w.x + (rnd() - 0.5) * 5, w.y + 1.5, w.z + (rnd() - 0.5) * 5, 0, 3, 0, 1.8);
      }
      for (const t of this.world.targets) {
        if (t.alive || (t.kind !== 'hangar' && t.kind !== 'fuel' && t.kind !== 'tower')) continue;
        t.burnT = (t.burnT || 0) + 0.12;
        if (t.burnT > 150 || (t.x - cx) * (t.x - cx) + (t.z - cz) * (t.z - cz) > farSq * 2) continue;
        const r = t.kind === 'hangar' ? 20 : 5;
        ps.emit(P.blackSmoke, t.x + (rnd() - 0.5) * r, t.y + 6, t.z + (rnd() - 0.5) * r, 0, 4, 0, t.kind === 'hangar' ? 2.2 : 1.3, 2);
        if (t.burnT < 60) ps.emit(P.fire, t.x + (rnd() - 0.5) * r, t.y + 3, t.z + (rnd() - 0.5) * r, 0, 4, 0, 3);
      }
    }
  }

  // positions for drawing: physics state advanced to "now"
  present() {
    const lead = this.paused ? 0 : this.acc;
    for (const a of this.sim.aircraft) {
      if (!a.rp) { a.rp = new V3(); a.rq = new Quat(); }
      a.rp.copy(a.pos).addScaled(a.vel, lead);
      a.rq.copy(a.q);
      if (lead > 0 && a.state !== 'ground') a.rq.integrate(a.w.x, a.w.y, a.w.z, lead);
    }
  }

  // ---------------------------------------------------------------- cameras
  updateCamera(dt) {
    const cam = this.cam, sim = this.sim, p = sim.player;
    let follow = p && (p.alive || p.state === 'down') && sim.aircraft.includes(p) ? p : null;
    if (this.debugCam) {   // tools / screenshots: { pos: [x,y,z], look: [x,y,z], fov }
      const d = this.debugCam;
      if (d.follow !== undefined) { const a = d.follow === 'player' ? p : typeof d.follow === 'object' ? d.follow : sim.aircraft[d.follow]; if (a) { cam.pos.set(a.rp.x + d.off[0], a.rp.y + d.off[1], a.rp.z + d.off[2]); _w.set(a.rp.x - cam.pos.x, a.rp.y - cam.pos.y, a.rp.z - cam.pos.z); cam.q.lookDir(_w.x, _w.y, _w.z); cam.fov = (d.fov || 50) * DEG; return; } }
      if (!d.pos) return;
      cam.pos.set(...d.pos); cam.q.lookDir(d.look[0] - d.pos[0], d.look[1] - d.pos[1], d.look[2] - d.pos[2]); cam.fov = (d.fov || 60) * DEG;
      return;
    }
    if (this.state === 'title' || this.state === 'end') return this.attractCamera(dt);
    if (!follow) {
      // spectate: the last aircraft of our flight / any friendly
      if (!this.spectate || !this.spectate.alive) this.spectate = sim.aircraft.find((a) => a.team === sim.playerTeam && a.alive && a.group === sim.playerGroup) || sim.aircraft.find((a) => a.team === sim.playerTeam && a.alive) || sim.aircraft[0];
      follow = this.spectate;
      if (!follow) return;
      return this.chaseCam(follow, dt, false);
    }
    const lookTarget = this.camMode !== 'cockpit' && (this.input.down('KeyV') || this.input.padBtn(PAD.TRIANGLE)) && sim.playerTarget && sim.playerTarget.alive;
    if (lookTarget) return this.targetCam(follow, sim.playerTarget, dt);
    if (this.camMode === 'cockpit') return this.cockpitCam(follow, dt);
    if (this.camMode === 'cinematic') return this.flybyCam(follow, dt);
    return this.chaseCam(follow, dt, this.mouseAim && follow === p && p.alive);
  }
  chaseCam(a, dt, mouseAim) {
    const cam = this.cam, g = a.type.geom;
    const dist = ((g ? g.span : 11) * 1.25 + 9) * this.zoom;
    this.inCockpit = false;
    let q;
    if (mouseAim) {
      q = _q.setHPR(this.aimYaw, this.aimPitch, 0);
      cam.q.copy(q);
    } else {
      // lagged aircraft orientation, keeps the horizon a little steadier than the aircraft
      if (!this.chaseInit) { this.camSmooth.copy(a.rq); this.chaseInit = true; }
      this.camSmooth.slerp(a.rq, 1 - Math.exp(-dt * 6));
      cam.q.copy(this.camSmooth);
      // right stick orbits the camera around the aircraft (R3: look back); springs back when released
      const O = this.orbit || (this.orbit = { yaw: 0, pitch: 0 }), lk = this.input.look;
      let oy = -lk.x * 170 * DEG, op = -lk.y * 60 * DEG;
      if (this.input.padBtn(PAD.R3)) { oy = 180 * DEG; op = -10 * DEG; }
      if (a !== this.sim.player || this.paused) oy = op = 0;
      O.yaw = damp(O.yaw, oy, 6, dt); O.pitch = damp(O.pitch, op, 6, dt);
      if (Math.abs(O.yaw) + Math.abs(O.pitch) > 1e-3) {
        _q2.setAxisAngle(0, 1, 0, O.yaw); _q.setAxisAngle(1, 0, 0, O.pitch);
        _q2.multiply(_q2.clone(), _q);
        cam.q.multiply(this.camSmooth, _q2);
      }
    }
    qrot(cam.q, 0, dist * 0.2 + 1.5, dist, _v);
    const tx = a.rp.x + _v.x, ty = a.rp.y + _v.y, tz = a.rp.z + _v.z;
    cam.vel.copy(a.vel);
    cam.pos.set(tx, ty, tz);
    // keep above the ground
    const gy = this.world.groundAt(cam.pos.x, cam.pos.z) + 2;
    if (cam.pos.y < gy) cam.pos.y = gy;
    cam.fov = lerp(cam.fov, (62 + clamp((a.speed - 120) * 0.08, 0, 6)) * DEG, 1 - Math.exp(-dt * 2));
    this.applyShake(dt);
  }
  // Cockpit: raised eye point, wide field of view, no canopy frame around the head. Head look:
  // mouse position over the window (edges = look along the wings / up) or the right stick, Z / X look
  // left / right, F / R3 check six, V / Triangle padlock the current target.
  cockpitCam(a, dt) {
    const cam = this.cam, g = a.type.geom, inp = this.input;
    const e = g ? g.cockpit : [0, 0.9, 0.5];
    const H = this.head || (this.head = { yaw: 0, pitch: 0 });
    let ty = 0, tp = 0;
    if (!this.mouseAim && inp.mouse.inside && !this.paused) {
      const dz = (v) => Math.max(0, (Math.abs(v) - 0.2) / 0.8);
      ty = -Math.sign(inp.mouse.nx) * Math.pow(dz(inp.mouse.nx), 1.25) * 165 * DEG;
      tp = inp.mouse.ny < 0 ? Math.pow(dz(inp.mouse.ny), 1.2) * 80 * DEG : -dz(inp.mouse.ny) * 35 * DEG;
    }
    const lk = inp.look;
    if ((lk.x || lk.y) && !this.paused) {   // right stick: same reach as the mouse edges
      ty = -Math.sign(lk.x) * Math.pow(Math.abs(lk.x), 1.25) * 165 * DEG;
      tp = lk.y < 0 ? Math.pow(-lk.y, 1.2) * 80 * DEG : -lk.y * 35 * DEG;
    }
    if (inp.padBtn(PAD.R3)) { ty = (H.yaw < 0 ? -1 : 1) * 168 * DEG; tp = 8 * DEG; }
    if (inp.down('KeyZ')) { ty = 95 * DEG; tp = -8 * DEG; }
    if (inp.down('KeyX')) { ty = -95 * DEG; tp = -8 * DEG; }
    if (inp.down('KeyF')) { ty = (H.yaw < 0 ? -1 : 1) * 168 * DEG; tp = 8 * DEG; }
    const t = this.sim.playerTarget;
    if ((inp.down('KeyV') || inp.padBtn(PAD.TRIANGLE)) && t && t.alive && a === this.sim.player) {
      qrotInv(a.rq, t.pos.x - a.pos.x, t.pos.y - a.pos.y, t.pos.z - a.pos.z, _v);
      ty = clamp(Math.atan2(-_v.x, -_v.z), -170 * DEG, 170 * DEG);
      tp = clamp(Math.atan2(_v.y, Math.hypot(_v.x, _v.z)), -40 * DEG, 88 * DEG);
    }
    H.yaw = damp(H.yaw, ty, 7, dt); H.pitch = damp(H.pitch, tp, 7, dt);
    // lean out to see past the head armour when looking back
    const back = smoothstep(1.3, 2.7, Math.abs(H.yaw));
    const lean = -Math.sign(H.yaw) * 0.14 * back;
    const ex = e[0] + lean, ey = e[1] + 0.2 + 0.06 * back, ez = e[2] + 0.05;
    this.eye = this.eyeArr || (this.eyeArr = [0, 0, 0, 0]);
    this.eye[0] = ex; this.eye[1] = ey; this.eye[2] = ez; this.eye[3] = 1.75;
    qrot(a.rq, ex, ey, ez, _v);
    cam.pos.set(a.rp.x + _v.x, a.rp.y + _v.y, a.rp.z + _v.z);
    cam.vel.copy(a.vel);
    _q2.setAxisAngle(0, 1, 0, H.yaw);
    _q.setAxisAngle(1, 0, 0, H.pitch);
    _q2.multiply(_q2.clone(), _q);
    cam.q.multiply(a.rq, _q2);
    cam.fov = 76 * DEG;
    this.inCockpit = true;
    this.applyShake(dt);
  }
  targetCam(a, t, dt) {
    const cam = this.cam;
    _v.subVectors(a.rp, t.rp || t.pos).normalize();
    const dist = 22 * this.zoom;
    cam.pos.set(a.rp.x + _v.x * dist, a.rp.y + _v.y * dist + 5, a.rp.z + _v.z * dist);
    _w.subVectors(t.rp || t.pos, cam.pos);
    cam.q.lookDir(_w.x, _w.y, _w.z);
    cam.vel.copy(a.vel);
    cam.fov = 60 * DEG; this.inCockpit = false;
  }
  flybyCam(a, dt) {
    const cam = this.cam;
    const fb = this.fb || (this.fb = { pos: new V3(), t: 99 });
    fb.t += dt;
    const d = fb.pos.dist(a.rp);
    if (fb.t > 7 || d > 700 || fb.a !== a) {
      fb.a = a; fb.t = 0;
      const side = rnd() < 0.5 ? -1 : 1;
      fb.pos.copy(a.pos).addScaled(a.vel, 2.5 + rnd()).addScaled(a.right, side * (20 + rnd() * 30)).addScaled(a.up, (rnd() - 0.3) * 15);
      const gy = this.world.groundAt(fb.pos.x, fb.pos.z) + 3;
      if (fb.pos.y < gy) fb.pos.y = gy;
    }
    cam.pos.copy(fb.pos);
    cam.vel.set(0, 0, 0);
    _w.subVectors(a.rp, cam.pos);
    cam.q.lookDir(_w.x, _w.y, _w.z);
    cam.fov = clamp(2 * Math.atan(18 / Math.max(_w.len(), 1)), 14 * DEG, 60 * DEG);
    this.inCockpit = false;
  }
  attractCamera(dt) {
    // cinematic tour of the battle on the title screen
    const sim = this.sim;
    this.attractT -= dt;
    let a = this.attractTarget;
    if (!a || !a.alive || this.attractT <= 0) {
      const cands = sim.aircraft.filter((x) => x.alive);
      const busy = cands.filter((x) => x.pilot && (x.pilot.state === 'attack' || x.pilot.state === 'dive' || x.pilot.state === 'bombrun'));
      const pool = busy.length ? busy : cands;
      a = pool[(rnd() * pool.length) | 0];
      this.attractTarget = a; this.attractT = 9 + rnd() * 5;
      this.attractMode = rnd() < 0.55 ? 'flyby' : 'chase';
      this.fb = null; this.chaseInit = false;
    }
    if (!a) {
      const f = this.world.fields[0];
      this.cam.pos.set(f.x + 300, f.elev + 80, f.z + 300);
      this.cam.q.lookDir(-300, -60, -300);
      return;
    }
    if (this.attractMode === 'flyby') this.flybyCam(a, dt); else this.chaseCam(a, dt, false);
  }
  applyShake(dt) {
    if (this.shake <= 0.001) return;
    const s = this.shake;
    _q2.setHPR((rnd() - 0.5) * s * 0.03, (rnd() - 0.5) * s * 0.03, (rnd() - 0.5) * s * 0.02);
    this.cam.q.multiply(_q.copy(this.cam.q), _q2);
    this.shake *= Math.exp(-dt * 6);
  }

  // ---------------------------------------------------------------- render
  // reusable per-mesh instance buffers: 16 floats per instance, written in place every frame
  batch(mesh) {
    let b = this.batches.get(mesh);
    if (!b) this.batches.set(mesh, (b = { mesh, data: new Float32Array(32 * 16), n: 0, shadow: false, eye: null, camo: null }));
    if (b.frame !== this.frameNo) { b.frame = this.frameNo; b.n = 0; b.shadow = false; b.eye = null; }
    return b;
  }
  put(b, x, y, z, s, qx, qy, qz, qw, e0 = 0, e1 = 0, e2 = 0, e3 = 0, f0 = 0, f1 = 0) {
    if ((b.n + 1) * 16 > b.data.length) { const d = new Float32Array(b.data.length * 2); d.set(b.data); b.data = d; }
    const D = b.data, o = b.n++ * 16;
    D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = s; D[o + 4] = qx; D[o + 5] = qy; D[o + 6] = qz; D[o + 7] = qw;
    D[o + 8] = e0; D[o + 9] = e1; D[o + 10] = e2; D[o + 11] = e3; D[o + 12] = f0; D[o + 13] = f1; D[o + 14] = 0; D[o + 15] = 0;
    if (f1 > 0) b.shadow = true;
  }
  drawBatch(b, opts) {
    if (b.frame !== this.frameNo || !b.n) return;
    this.R.setInstances(b.mesh, b.data, b.n);
    this.R.drawMesh(b.mesh, opts);
  }

  render(dt) {
    const R = this.R, cam = this.cam, sim = this.sim, world = this.world;
    this.frameNo = (this.frameNo || 0) + 1;
    if (!this.batches) this.batches = new Map();
    R.beginFrame(cam, ENV);
    this.streamScenery();
    const cx = cam.pos.x, cy = cam.pos.y, cz = cam.pos.z;
    // ---- aircraft
    const used = this.usedAc || (this.usedAc = []);
    used.length = 0;
    const acBatch = (key, which) => {
      const b = this.batch(this.acMesh[key][which]);
      if (b.n === 0) { b.camo = this.acMesh[key].camo; used.push(b); }
      return b;
    };
    const P3 = this.batch(R.meshes['prop:prop3']), P4 = this.batch(R.meshes['prop:prop4']), PD = this.batch(R.meshes.propdisc);
    const p = sim.player;
    for (const a of sim.aircraft) {
      const rx = a.rp.x - cx, ry = a.rp.y - cy, rz = a.rp.z - cz;
      const d = Math.hypot(rx, ry, rz);
      const scale = 1 + clamp((d - 500) / 2500, 0, 1.6);   // distant aircraft drawn a little larger (spotting)
      if (a !== p && !this.sphereVisible(rx, ry, rz, (a.type.geom ? a.type.geom.span : 10) * 0.6 * scale)) continue;
      const gy = world.groundAt(a.rp.x, a.rp.z);
      const shadow = d < 3000 ? clamp(1 - (a.rp.y - gy) / 250, 0, 1) : 0;
      const cockpit = a === p && this.inCockpit && this.camMode === 'cockpit' ? 1 : 0;
      const key = a.type.key, q = a.rq;
      const soot = a.smoke * 0.8 + (a.state === 'down' ? 0.3 : 0), flash = a.hitFlash > 0 ? 0.6 : 0, seed = (a.id % 7) * 0.13;
      const body = acBatch(key, 'body');
      this.put(body, rx, ry, rz, scale, q.x, q.y, q.z, q.w, soot, cockpit, flash, seed, gy - cy, shadow);
      if (cockpit) body.eye = this.eye;
      if (a.gear > 0.05 || this.models.aircraft[key].fixedGear) this.put(acBatch(key, 'gear'), rx, ry, rz, scale, q.x, q.y, q.z, q.w, soot, cockpit, flash, seed, gy - cy, shadow);
      if (d < 2500 && a.type.geom) {
        for (const pr of a.type.geom.props) {
          qrot(q, pr.x, pr.y, pr.z, _v);
          if (a.rpm < 0.35 || (a.state === 'down' && a.rpm < 0.4)) {
            _q2.setAxisAngle(0, 0, 1, a.propAngle * (pr.dir || 1));
            _q.multiply(q, _q2);
            this.put(pr.blades === 4 ? P4 : P3, rx + _v.x, ry + _v.y, rz + _v.z, pr.r, _q.x, _q.y, _q.z, _q.w);
          } else if (!cockpit) this.put(PD, rx + _v.x, ry + _v.y, rz + _v.z, pr.r, q.x, q.y, q.z, q.w);
        }
      }
    }
    // parked aircraft on the dispersals
    for (const f of world.fields) {
      for (const slot of f.parking) {
        if (!slot.plane) continue;
        const pk = slot.pose || (slot.pose = {});
        if (pk.type !== slot.plane) {   // cached resting pose for this slot + type
          const [x, z] = fieldToWorld(f, slot.u, slot.v);
          const geom = TYPES[slot.plane].geom, mw = geom.mainWheel, tw = geom.tailWheel;
          const gp = Math.atan((mw[1] - tw[1]) / (mw[2] - tw[2]));
          const gy = world.groundAt(x, z);
          const qq = new Quat().setHPR(f.hdg - Math.PI / 2, gp, 0);   // nose toward the runway
          Object.assign(pk, { type: slot.plane, x, z, gy, y: gy - (Math.cos(gp) * mw[1] - Math.sin(gp) * mw[2]), q: qq });
        }
        const rx = pk.x - cx, ry = pk.y - cy, rz = pk.z - cz;
        if (rx * rx + rz * rz > 9000 * 9000 || !this.sphereVisible(rx, ry, rz, 10)) continue;
        const q = pk.q;
        this.put(acBatch(slot.plane, 'body'), rx, ry, rz, 1, q.x, q.y, q.z, q.w, 0, 0, 0, slot.u * 0.01, pk.gy - cy, 0.9);
        this.put(acBatch(slot.plane, 'gear'), rx, ry, rz, 1, q.x, q.y, q.z, q.w, 0, 0, 0, slot.u * 0.01, pk.gy - cy, 0.9);
      }
    }
    for (const b of used) this.drawBatch(b, { camo: b.camo, eye: b.eye });
    this.drawBatch(P3); this.drawBatch(P4);
    // ---- airfield structures, guns, craters, wrecks, bombs, parachutes
    const M = (k) => this.batch(R.meshes['s:' + k]);
    const sx = (b, x, y, z, s, q) => this.put(b, x - cx, y - cy, z - cz, s, q.x, q.y, q.z, q.w);
    const statics = this.dynStatics || (this.dynStatics = ['hangar', 'hangarRuin', 'tower', 'fuelTank', 'flakGun', 'lightAA', 'crater', 'wreck', 'bomb500', 'bomb250', 'parachute']);
    for (const t of world.targets) {
      if (t.kind === 'runway') continue;
      _q.setAxisAngle(0, 1, 0, t.yaw);
      if (t.kind === 'hangar') sx(M(t.alive ? 'hangar' : 'hangarRuin'), t.x, t.y, t.z, 1, _q);
      else if (t.kind === 'tower') { if (t.alive) sx(M('tower'), t.x, t.y, t.z, 1, _q); else sx(M('hangarRuin'), t.x, t.y, t.z, 0.22, _q); }
      else if (t.kind === 'fuel') { if (t.alive) sx(M('fuelTank'), t.x, t.y, t.z, 1, _q); else sx(M('crater'), t.x, t.y, t.z, 0.8, _q); }
      else if (t.kind === 'flak' || t.kind === 'lightAA') {
        if (!t.alive) { sx(M('crater'), t.x, t.y, t.z, 0.5, _q); continue; }
        // traverse + elevation toward the current aim
        t.dYaw = lerp(t.dYaw ?? t.aimYaw, t.aimYaw, 0.08); t.dPitch = lerp(t.dPitch ?? t.aimPitch, t.aimPitch, 0.08);
        _q.setHPR(t.dYaw, clamp(t.dPitch, 0.05, 1.45), 0);
        sx(M(t.kind === 'flak' ? 'flakGun' : 'lightAA'), t.x, t.y + (t.kind === 'flak' ? 1.6 : 1.2), t.z, 1, _q);
      }
    }
    for (const c of sim.craters) { _q.setAxisAngle(0, 1, 0, (c.x * 7.1) % 6.28); sx(M('crater'), c.x, c.y, c.z, c.r, _q); }
    for (const w of sim.wrecks) { _q.setAxisAngle(0, 1, 0, w.yaw); sx(M('wreck'), w.x, w.y, w.z, 1, _q); }
    for (const b of sim.bombs) { _q.lookDir(b.vx, b.vy, b.vz); sx(M(b.kind === 'bomb250' ? 'bomb250' : 'bomb500'), b.x, b.y, b.z, 1, _q); }
    for (const c of sim.chutes) { _q.setAxisAngle(0, 1, 0, c.t * 0.3); sx(M('parachute'), c.x, c.y, c.z, clamp(c.t / 1.5, 0.2, 1), _q); }
    // bombs still on the racks
    for (const a of sim.aircraft) {
      const g = a.type.geom;
      if (!g || !a.bombs || a.pos.distSq(cam.pos) > 2500 * 2500) continue;
      for (let k = a.type.bombs - a.bombs; k < a.type.bombs; k++) {
        const hp = g.hardpoints[k % g.hardpoints.length];
        if (!hp) continue;
        qrot(a.rq, hp.x, hp.y, hp.z, _v);
        this.put(M(hp.kind === 'bomb250' ? 'bomb250' : 'bomb500'), a.rp.x + _v.x - cx, a.rp.y + _v.y - cy, a.rp.z + _v.z - cz, 1, a.rq.x, a.rq.y, a.rq.z, a.rq.w);
      }
    }
    for (const k of statics) this.drawBatch(M(k), { camo: STATIC_CAMO });
    // static scenery
    if (!this.staticMeshes) this.staticMeshes = Object.values(R.meshes).filter((m) => m.stat);
    for (const m of this.staticMeshes) R.drawMesh(m, { camo: STATIC_CAMO });
    // terrain, then shadows on it
    R.selectTerrain(cam.pos);
    R.drawTerrain(world.fields);
    R.beginShadows();
    for (const b of used) if (b.shadow) R.drawMesh(b.mesh, { camo: b.camo, shadow: true });
    R.endShadows();
    R.drawSky();
    // ---- transparent
    R.beginTransparent();
    this.drawBatch(PD, { alpha: 0.28 });
    // clouds are sorted far -> near: those beyond 1.5 km go behind the smoke and tracers, the rest in front
    const nc = this.fillClouds(), nf = this.cloudFar;
    R.drawClouds(this.cloudData, nf);
    R.drawParticles(this.ps.out, this.ps.fill(cx, cy, cz));
    R.drawTracers(this.tracerData, this.fillTracers());
    if (nc > nf) R.drawClouds(this.cloudData.subarray(nf * 8), nc - nf, true);
    R.endTransparent();
    // post
    this.flash *= Math.exp(-dt * 8);
    this.dmgFlash = (this.dmgFlash || 0) * Math.exp(-dt * 3);
    const pl = sim.player && sim.player.alive && !this.debugCam ? sim.player : null;   // no player screen effects on debug views
    const gl = pl ? pl.nz : 1;
    this.blackout = clamp((this.blackout || 0) + (gl > 6.2 ? (gl - 6.2) * 0.35 * dt : -0.6 * dt), 0, 0.85);
    this.redout = clamp((this.redout || 0) + (gl < -2.2 ? 0.4 * dt : -0.8 * dt), 0, 0.5);
    R.endFrame({
      time: ENV.time, newsreel: this.newsreel, damage: (this.dmgFlash || 0) + (pl && pl.hp < pl.type.hp * 0.25 ? 0.12 + 0.08 * Math.sin(ENV.time * 6) : 0),
      blackout: this.blackout, whiteout: this.cloudWhite(), bloom: 0.45 + this.flash, grain: 0.035, redout: this.redout * 0.6,
    });
  }
  sphereVisible(x, y, z, r) {
    const P = this.R.planes;
    for (let i = 0; i < 5; i++) if (P[i * 4] * x + P[i * 4 + 1] * y + P[i * 4 + 2] * z + P[i * 4 + 3] < -r) return false;
    return true;
  }
  cloudWhite() {
    const c = this.cam.pos;
    if (c.y < CLOUD_BASE - 50 || c.y > CLOUD_BASE + 800) return (this.whiteout = damp(this.whiteout || 0, 0, 3, 1 / 60));
    let w = 0;
    const ox = ENV.cloudOff[0], oz = ENV.cloudOff[1];
    for (const p of this.clouds) {
      let dx = p[0] - ox - c.x, dz = p[2] - oz - c.z;
      dx -= Math.round(dx / 60000) * 60000; dz -= Math.round(dz / 60000) * 60000;
      const dy = p[1] - c.y, r = p[3] * 0.55;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r * r) w = Math.max(w, 1 - Math.sqrt(d2) / r);
    }
    this.whiteout = damp(this.whiteout || 0, clamp(w * 1.6, 0, 0.85), 4, 1 / 60);
    return this.whiteout;
  }
  // visible puffs sorted far -> near; the sort key packs distance and index into one float64
  fillClouds() {
    const c = this.cam.pos, ox = ENV.cloudOff[0], oz = ENV.cloudOff[1];
    const P = this.clouds, D = this.cloudData;
    const keys = this.cloudSort || (this.cloudSort = new Float64Array(P.length));
    let n = 0;
    for (let i = 0; i < P.length; i++) {
      // the 60 km cloud field wraps around the camera so the sky never runs out
      let x = P[i][0] - ox - c.x, z = P[i][2] - oz - c.z;
      x -= Math.round(x / 60000) * 60000; z -= Math.round(z / 60000) * 60000;
      const y = P[i][1] - c.y;
      const d2 = x * x + y * y + z * z;
      const sz = P[i][3];
      if (d2 > 28000 * 28000 || d2 < 0.09 * sz * sz || !this.sphereVisible(x, y, z, sz)) continue;
      keys[n++] = Math.floor(d2) * 65536 + i;
    }
    const sorted = keys.subarray(0, n).sort();
    const m = Math.min(n, 4096);
    this.cloudFar = 0;
    for (let k = 0; k < m; k++) {
      const key = sorted[n - 1 - k];
      if (key >= 1500 * 1500 * 65536) this.cloudFar = k + 1;
      const p = P[key % 65536];
      let x = p[0] - ox - c.x, z = p[2] - oz - c.z;
      x -= Math.round(x / 60000) * 60000; z -= Math.round(z / 60000) * 60000;
      const o = k * 8;
      D[o] = x; D[o + 1] = p[1] - c.y; D[o + 2] = z; D[o + 3] = p[3]; D[o + 4] = p[4]; D[o + 5] = p[5]; D[o + 6] = p[6]; D[o + 7] = p[7];
    }
    return m;
  }
  fillTracers() {
    const B = this.sim.bullets, D = this.tracerData, c = this.cam.pos, lead = this.paused ? 0 : this.acc;
    let n = 0;
    for (let i = 0; i < B.n && n < 8192; i++) {
      const g = GUNS[GUN_KINDS[B.kind[i]]];
      const hx = B.px[i] + B.vx[i] * lead - c.x, hy = B.py[i] + B.vy[i] * lead - c.y, hz = B.pz[i] + B.vz[i] * lead - c.z;
      const age = g.life - B.life[i];
      const len = Math.min(0.016, age + lead);
      const o = n * 12;
      D[o] = hx; D[o + 1] = hy; D[o + 2] = hz; D[o + 3] = g.w * 0.5;
      D[o + 4] = hx - B.vx[i] * len; D[o + 5] = hy - B.vy[i] * len; D[o + 6] = hz - B.vz[i] * len; D[o + 7] = 1;
      D[o + 8] = g.col[0]; D[o + 9] = g.col[1]; D[o + 10] = g.col[2]; D[o + 11] = 1;
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- HUD + audio
  drawHud(dt) {
    const sim = this.sim, p = sim.player, cam = this.cam;
    const S = this.hudState || (this.hudState = { relP: new V3(), aimDir: new V3(), lead: new V3(), camRight: new V3(), camUp: new V3() });
    S.hidden = (this.state !== 'play' && this.state !== 'ending') || !!this.debugCam;   // debug camera: clean shots
    S.vp = this.R.vp; S.cam = cam.pos; S.aircraft = sim.aircraft; S.team = sim.playerTeam;
    S.player = this.state === 'play' || this.state === 'ending' ? p : null;
    // rearm prompt: low on ammo or bombs, or damaged -> point the player at the home field
    S.home = null;
    if (S.player && p.alive) {
      const T = p.type, f = sim.teams[sim.playerTeam].field;
      const low = p.ammo[0] < T.volleys[0].ammo * 0.25 || (T.bombs && !p.bombs) || p.hp < T.hp * 0.6 || p.engineDmg > 0.3;
      const onHome = this.world.inField(p.pos.x, p.pos.z) === f;
      if (low && !(p.state === 'ground' && onHome && p.speed < 3)) {
        const H = S.homeV || (S.homeV = {});
        H.x = f.x; H.z = f.z; H.y = this.world.groundAt(f.x, f.z); H.name = f.name;
        if (p.state === 'ground' && onHome) { H.stage = 'roll'; H.text = `HOLD ${this.input.pad ? 'D-PAD DOWN' : 'S'} TO BRAKE - STOP ON THE AIRFIELD TO REARM`; }
        else if (onHome || Math.hypot(p.pos.x - f.x, p.pos.z - f.z) < 3000) { H.stage = 'near'; H.text = 'LAND AND STOP ON THE AIRFIELD TO REARM'; }
        else { H.stage = 'far'; H.text = `RETURN TO ${f.name} TO REARM`; }
        S.home = H;
      }
    }
    // landing checklist: airborne with the gear coming down (or landing mode latched) near the home field
    S.approach = null;
    // shown with the gear down or coming down, in landing mode, or when low, slow and descending near home (why no gear yet)
    if (S.player && p.alive && p.state === 'air' && p.agl < 500 && (p.landing || (p.gear > 0.05 && !p.gearUp) || (p.agl < 300 && p.speed < p.type.vs * 2.6 && p.vel.y < 1))) {
      const f = sim.teams[sim.playerTeam].field;
      const [u, v] = worldToField(f, p.pos.x, p.pos.z);
      if (Math.abs(u) < 4500 && Math.abs(v) < 2500) {
        const A = S.approachV || (S.approachV = { items: [], thr: new V3() });
        const vs = p.type.vs, bank = Math.abs(p.bankAngle) / DEG, sink = -p.vel.y, mph = Math.round(p.speed * 2.237);
        const it = A.items; it.length = 0;
        it.push({ t: p.gear > 0.95 ? (p.flap > 0.95 ? 'GEAR + FLAPS DOWN' : 'GEAR DOWN') : p.gear > 0.05 ? `GEAR COMING ${p.gearUp ? 'UP' : 'DOWN'}` : 'GEAR UP', ok: p.gear > 0.95 });
        it.push({ t: p.speed < vs * 2.0 ? `${mph} MPH` : `${mph} MPH - SLOW TO ${Math.round(vs * 1.4 * 2.237)}`, ok: p.speed < vs * 2.0 });
        it.push({ t: `SINK ${Math.max(0, Math.round(sink * 3.281 * 60 / 100) * 100)} FT/MIN${sink > 6 ? ' - TOO STEEP' : ''}`, ok: sink < 6 });
        it.push({ t: bank > 18 ? 'LEVEL THE WINGS' : 'WINGS LEVEL', ok: bank <= 18 });
        // the near end of the runway as an aim point (until over the runway itself)
        A.hasThr = Math.abs(u) > 650;
        if (A.hasThr) { const [tx, tz] = fieldToWorld(f, u < 0 ? 100 - f.rwyLen / 2 : f.rwyLen / 2 - 100, 0); A.thr.set(tx, this.world.groundAt(tx, tz), tz); }
        S.approach = A;
      }
    }
    qrot(cam.q, 1, 0, 0, S.camRight); qrot(cam.q, 0, 1, 0, S.camUp);
    S.mouseAim = this.mouseAim;
    S.needClick = this.state === 'play' && this.mouseAim && !this.input.mouse.locked && !this.paused && !!p && p.alive && !this.autopilot;
    if (p && p.alive) {
      S.relP.set(p.rp.x - cam.pos.x, p.rp.y - cam.pos.y, p.rp.z - cam.pos.z);
      const ca = Math.cos(this.aimPitch);
      S.aimDir.set(Math.sin(this.aimYaw) * ca, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * ca);
      const t = sim.playerTarget;
      S.target = t;
      if (t && t.alive) { leadPoint(p, t, GUNS[p.type.volleys[0].kind].v, S.lead); S.targetDist = p.pos.dist(t.pos); } else S.target = null;
      // bomb impact predictor
      if (p.bombs > 0 && p.state === 'air') {
        let x = p.pos.x, y = p.pos.y, z = p.pos.z, vy = p.vel.y - 1;
        const vx = p.vel.x, vz = p.vel.z;
        for (let i = 0; i < 400; i++) { const dt2 = 0.05; vy -= G * dt2; x += vx * dt2; y += vy * dt2; z += vz * dt2; if (y < this.world.groundAt(x, z)) break; }
        S.ccip = S.ccipV || (S.ccipV = new V3()); S.ccip.set(x, this.world.groundAt(x, z), z);
      } else S.ccip = null;
      S.serviceT = p.state === 'ground' && p.speed < 3 && p.landedAt !== undefined ? p.serviceT || 0 : 0;
      S.towWait = p.towWait;
      S.outOfBounds = Math.abs(p.pos.x) > MAP_HALF || Math.abs(p.pos.z) > MAP_HALF;
    }
    S.groundTargets = [];
    if (p && p.alive && p.type.bombs) for (const t of this.world.targets) if (t.team !== p.team && t.alive && (t.kind === 'hangar' || t.kind === 'runway')) S.groundTargets.push(t);
    S.status = [sim.teamStatus(0), sim.teamStatus(1)];
    S.raid = sim.raidWarning; S.time = sim.time; S.score = this.score; S.stats = sim.playerStats;
    S.wingOrder = this.wingOrder; S.bigMap = this.bigMap;
    this.hitMarker = Math.max(0, (this.hitMarker || 0) - dt); S.hitMarker = this.hitMarker;
    S.perf = this.showPerf ? { FPS: this.perf.fps.toFixed(0), 'SIM MS': this.perf.sim.toFixed(2), 'RENDER CPU MS': this.perf.render.toFixed(2), 'DRAW CALLS': this.R.drawCalls, GPU: this.R.gpu.replace(/^ANGLE \(|\)$/g, '').slice(0, 26), TRIANGLES: (this.R.tris / 1000).toFixed(0) + 'k', RES: `${this.R.W}x${this.R.H} (${Math.round(this.R.resScale * 100)}%)`, AIRCRAFT: sim.aircraft.length, BULLETS: sim.bullets.n, PARTICLES: this.ps.n } : null;
    this.hud.draw(S, dt);
  }

  updateAudio(dt) {
    const A = this.audio;
    if (!A.ready) return;
    const cam = this.cam, sim = this.sim, p = sim.player;
    const L = this.listener || (this.listener = { pos: new V3(), vel: new V3(), fwd: new V3(), up: new V3(), inCockpit: false });
    L.pos.copy(cam.pos); L.vel.copy(cam.vel); qrot(cam.q, 0, 0, -1, L.fwd); qrot(cam.q, 0, 1, 0, L.up); L.inCockpit = !!this.inCockpit;
    A.update(dt, L);
    const playing = (this.state === 'play' || this.state === 'ending') && !this.paused;
    A.setPlayerEngine({ active: playing && !!p && p.alive, type: p ? p.type.key : 'spitfire', rpm: p ? p.rpm : 0, throttle: p ? p.ctl.throttle : 0, speed: p ? p.speed : 0, damage: p ? 1 - p.hp / p.type.hp : 0, onGround: p ? p.state === 'ground' : false, gForce: p ? p.nz : 1 });
    const list = this.engList || (this.engList = []), pool = this.engPool || (this.engPool = []);
    list.length = 0;
    if (!this.paused) for (const a of sim.aircraft) {
      if (a === p && playing) continue;
      if (a.pos.distSq(cam.pos) > 4500 * 4500) continue;   // = ENGINE_MAX_DIST in audio.js
      const e = pool[list.length] || (pool[list.length] = {});
      e.id = a.id; e.type = a.type.key; e.x = a.rp.x; e.y = a.rp.y; e.z = a.rp.z; e.vx = a.vel.x; e.vy = a.vel.y; e.vz = a.vel.z; e.rpm = a.rpm;
      e.siren = a.type.key === 'ju87' && a.pilot && a.pilot.state === 'dive' ? clamp((a.speed - 60) / 80, 0, 1) : 0;
      list.push(e);
    }
    A.setEngines(list);
    A.setBombs(this.paused ? [] : sim.bombs);
    A.siren(playing && !!sim.sirenOn);
    // enemy rounds passing within a few metres of the listener this frame: whiz-bys
    if (playing && p && p.alive) {
      const B = sim.bullets, lx = L.pos.x, ly = L.pos.y, lz = L.pos.z;
      for (let i = 0; i < B.n; i++) {
        if (B.team[i] === p.team) continue;
        const rx = B.px[i] - lx, ry = B.py[i] - ly, rz = B.pz[i] - lz;
        if (rx * rx + ry * ry + rz * rz > 160000) continue;
        const vx = B.vx[i] - L.vel.x, vy = B.vy[i] - L.vel.y, vz = B.vz[i] - L.vel.z, rv = rx * vx + ry * vy + rz * vz;
        if (rv >= 0) continue;   // already past
        const t = -rv / (vx * vx + vy * vy + vz * vz);
        if (t > dt) continue;    // closest approach is not in this frame
        const mx = rx + vx * t, my = ry + vy * t, mz = rz + vz * t, miss = Math.hypot(mx, my, mz);
        if (miss > 12) continue;
        const k = GUN_KINDS[B.kind[i]], w = this._whizPos || (this._whizPos = { x: 0, y: 0, z: 0 });
        w.x = lx + mx; w.y = ly + my; w.z = lz + mz;
        A.whiz(w, k === 'cannon' || k === 'aa', miss);
      }
    }
  }

  // brief fade to black and back (covers jumps such as the tow to the runway)
  fade() {
    const el = $('#fade');
    el.classList.add('on');
    clearTimeout(this.fadeT); this.fadeT = setTimeout(() => el.classList.remove('on'), 750);
  }

  dynamicResolution(dt) {
    const d = this.dyn;
    if (dt <= 0 || this.paused) return;
    d.avg = d.avg * 0.96 + Math.min(dt, 1 / 20) * 0.04;
    d.cool -= dt;
    if (d.cool > 0) return;
    const R = this.R;
    if (d.avg > 1 / 50 && R.resScale > 0.5) { R.resScale = Math.max(0.5, R.resScale * 0.88); d.cool = 2.5; }
    else if (d.avg < 1 / 58 && R.resScale < 1) { R.resScale = Math.min(1, R.resScale * 1.08); d.cool = 5; }
  }
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
// canvas size in device pixels, capped at ~4K worth of pixels
function devSize(canvas, cap = 8.3e6) {
  const dpr = window.devicePixelRatio || 1;
  let w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (w * h > cap) { const s = Math.sqrt(cap / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
  return { w, h };
}

const game = new Game();
window.game = game;
game.boot().catch((e) => {
  console.error(e);
  $('#loading .msg').textContent = 'ERROR: ' + e.message;
});
