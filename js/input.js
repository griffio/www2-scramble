// Keyboard / mouse / gamepad. Keyboard axes ramp (digital keys give smooth inputs).
// Mouse: with pointer lock, mouse movement steers the aim direction (mouse-aim flying).
// Gamepad: W3C standard mapping (DualShock 4 / DualSense / Xbox / most others in Chrome, Edge, Firefox,
// Safari). Button presses arrive as 'Pad<i>' codes alongside the keys; the left stick also sends
// 'PadNav*' flicks (with auto-repeat) for menus; the right stick is exposed as `look`.
import { clamp } from './math.js';

// standard-mapping button indices (PlayStation names; Xbox: A B X Y, LB RB, LT RT, View Menu)
export const PAD = { CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7, SHARE: 8, OPTIONS: 9,
  L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16, TOUCHPAD: 17 };
const SONY = /054c|sony|playstation|dualshock|dualsense|wireless controller/i;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = [];
    this.ax = { pitch: 0, roll: 0, yaw: 0 };
    this.mouse = { dx: 0, dy: 0, wheel: 0, buttons: 0, locked: false, nx: 0, ny: 0, inside: false };
    this.pad = null; this.padPrev = []; this.padKind = null;
    this.look = { x: 0, y: 0 };            // right stick, deadzoned (-1..1)
    this.padNotes = [];                    // connect / disconnect notices for the game to show
    this.nav = { dir: null, t: 0 };        // left-stick menu flicks
    this.rumbleT = 0; this.rumbleLast = [0, 0];
    window.addEventListener('gamepadconnected', (e) => this.padNotes.push({ on: true, name: padName(e.gamepad), kind: padKind(e.gamepad) }));
    window.addEventListener('gamepaddisconnected', (e) => this.padNotes.push({ on: false, name: padName(e.gamepad), kind: padKind(e.gamepad) }));
    window.addEventListener('keydown', (e) => {
      if (['Tab', 'Space', 'KeyZ', 'KeyX', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1', 'Backquote'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.push(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.buttons = 0; });
    document.addEventListener('mousemove', (e) => {
      // pointer-lock deltas can spike in Chromium: clamp each event
      if (this.mouse.locked) { this.mouse.dx += clamp(e.movementX, -200, 200); this.mouse.dy += clamp(e.movementY, -200, 200); }
      // normalised position over the window (-1..1), for cockpit head look
      this.mouse.nx = e.clientX / window.innerWidth * 2 - 1; this.mouse.ny = e.clientY / window.innerHeight * 2 - 1; this.mouse.inside = true;
    });
    document.documentElement.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    canvas.addEventListener('mousedown', (e) => { this.mouse.buttons |= 1 << e.button; this.pressed.push('Mouse' + e.button); });
    window.addEventListener('mouseup', (e) => { this.mouse.buttons &= ~(1 << e.button); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // wheel: proportional to the delta (trackpads send many small deltas per frame)
    canvas.addEventListener('wheel', (e) => { this.mouse.wheel += clamp(e.deltaY / (e.deltaMode === 1 ? 3 : 100), -3, 3); e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerlockchange', () => { this.mouse.locked = document.pointerLockElement === canvas; if (!this.mouse.locked) this.mouse.buttons = 0; });
  }
  lock() { if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock?.()?.catch?.(() => {}); }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  consume() { const p = this.pressed; this.pressed = []; return p; }
  down(...codes) { for (const c of codes) if (this.keys.has(c)) return true; return false; }
  takeMouse() { const d = [this.mouse.dx, this.mouse.dy, this.mouse.wheel]; this.mouse.dx = this.mouse.dy = this.mouse.wheel = 0; return d; }

  // manual stick axes from keys + gamepad; `active` flags whether the human is touching them
  axes(dt) {
    const k = (a, b) => (this.down(a, b) ? 1 : 0);
    const ramp = (cur, tgt, up, back) => {
      const r = tgt === 0 ? back : Math.sign(tgt) !== Math.sign(cur) && cur !== 0 ? back + up : up;
      return cur + clamp(tgt - cur, -r * dt, r * dt);
    };
    const tp = k('ArrowDown') - k('ArrowUp');
    const tr = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
    const ty = k('KeyE') - k('KeyQ');
    this.ax.pitch = ramp(this.ax.pitch, tp, 2.2, 6);
    this.ax.roll = ramp(this.ax.roll, tr, 4, 8);
    this.ax.yaw = ramp(this.ax.yaw, ty, 3, 6);
    let pitch = this.ax.pitch, roll = this.ax.roll, yaw = this.ax.yaw;
    let active = { pitch: tp !== 0 || Math.abs(pitch) > 0.05, roll: tr !== 0 || Math.abs(roll) > 0.05, yaw: ty !== 0 };
    // gamepad (standard mapping): left stick flies, L1 / R1 rudder (ramped like the keys)
    this.padButtons = [];
    const pad = this.pollPad();
    this.look.x = this.look.y = 0;
    if (!pad) this.padPrev.length = 0;
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.1 ? 0 : (v - Math.sign(v) * 0.1) / 0.9);
      const cv = (v) => v * (0.35 + 0.65 * v * v);
      const rawX = pad.axes[0] || 0, rawY = pad.axes[1] || 0;
      const lx = cv(dz(rawX)), ly = cv(dz(rawY));
      if (lx) { roll = clamp(roll + lx, -1, 1); active.roll = true; }
      if (ly) { pitch = clamp(pitch + ly, -1, 1); active.pitch = true; }
      const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      const pr = (b(PAD.R1) ? 1 : 0) - (b(PAD.L1) ? 1 : 0);
      this.ax.padYaw = ramp(this.ax.padYaw || 0, pr, 3, 6);
      if (pr || Math.abs(this.ax.padYaw) > 0.05) { yaw = clamp(yaw + this.ax.padYaw, -1, 1); active.yaw = true; }
      this.look.x = dz(pad.axes[2] || 0); this.look.y = dz(pad.axes[3] || 0);
      pad.buttons.forEach((bt, i) => { if (bt.pressed && !this.padPrev[i]) this.pressed.push('Pad' + i); this.padPrev[i] = bt.pressed; });
      // menu flicks from the left stick: edge, then auto-repeat while held
      const m = Math.hypot(rawX, rawY);
      const dir = m < 0.6 ? null : Math.abs(rawX) > Math.abs(rawY) ? (rawX > 0 ? 'Right' : 'Left') : (rawY > 0 ? 'Down' : 'Up');
      if (dir !== this.nav.dir) { this.nav.dir = dir; this.nav.t = 0.4; if (dir) this.pressed.push('PadNav' + dir); }
      else if (dir && (this.nav.t -= dt) <= 0) { this.nav.t = 0.14; this.pressed.push('PadNav' + dir); }
    } else this.ax.padYaw = 0;
    return { pitch, roll, yaw, active };
  }
  // the controller in use: the most recently touched one if several are connected
  pollPad() {
    let pads = [];
    try { pads = (navigator.getGamepads && navigator.getGamepads()) || []; }   // throws where the gamepad permissions policy forbids it (some iframes)
    catch (e) { if (!this.padErr) { this.padErr = true; console.warn('[input] gamepad API unavailable: ' + e.message); } }
    let pad = null;
    for (const p of pads) if (p && p.connected && (!pad || p.timestamp > pad.timestamp)) pad = p;
    if (pad && pad.mapping !== 'standard' && !this.warned) { this.warned = true; console.warn(`[input] gamepad "${pad.id}" has no standard mapping; buttons may be mixed up`); }
    this.pad = pad;
    this.padKind = pad ? padKind(pad) : null;
    return pad;
  }
  padBtn(i) { return !!(this.pad && this.pad.buttons[i] && this.pad.buttons[i].pressed); }
  padVal(i) { return this.pad && this.pad.buttons[i] ? this.pad.buttons[i].value : 0; }
  // rumble (Chrome / Edge / Safari: DualShock 4, DualSense, Xbox). Called every frame with the wanted
  // motor levels (0..1); effects are re-issued in short overlapping slices so they stop on their own.
  rumble(strong, weak, dt) {
    const act = this.pad && this.pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    strong = clamp(strong, 0, 1); weak = clamp(weak, 0, 1);
    const [ls, lw] = this.rumbleLast;
    this.rumbleT -= dt;
    const off = strong < 0.02 && weak < 0.02;
    if (off && ls === 0 && lw === 0) return;
    if (this.rumbleT > 0 && Math.abs(strong - ls) < 0.1 && Math.abs(weak - lw) < 0.1 && !(off && (ls || lw))) return;
    this.rumbleT = 0.08;
    this.rumbleLast = off ? [0, 0] : [strong, weak];
    try {
      if (off) act.reset?.().catch?.(() => {});
      else act.playEffect('dual-rumble', { duration: 120, strongMagnitude: strong, weakMagnitude: weak }).catch?.(() => {});
    } catch (e) { /* not supported */ }
  }
}

export function padKind(p) { return SONY.test(p.id) ? 'ps' : 'xbox'; }
function padName(p) {
  if (/dualsense|0ce6|0df2/i.test(p.id)) return 'DUALSENSE';
  if (SONY.test(p.id)) return 'DUALSHOCK 4';
  if (/xbox|xinput|045e/i.test(p.id)) return 'XBOX CONTROLLER';
  return 'GAMEPAD';
}
