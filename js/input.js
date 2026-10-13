// Keyboard / mouse / gamepad. Keyboard axes ramp (digital keys give smooth inputs).
// Mouse: with pointer lock, mouse movement steers the aim direction (mouse-aim flying).
import { clamp } from './math.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = [];
    this.ax = { pitch: 0, roll: 0, yaw: 0 };
    this.mouse = { dx: 0, dy: 0, wheel: 0, buttons: 0, locked: false, nx: 0, ny: 0, inside: false };
    this.pad = null; this.padPrev = [];
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
    // gamepad (standard mapping)
    this.padButtons = [];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    this.pad = pad;
    if (!pad) this.padPrev.length = 0;
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.1 ? 0 : (v - Math.sign(v) * 0.1) / 0.9);
      const cv = (v) => v * (0.35 + 0.65 * v * v);
      const lx = cv(dz(pad.axes[0] || 0)), ly = cv(dz(pad.axes[1] || 0)), rx = dz(pad.axes[2] || 0);
      if (lx) { roll = clamp(roll + lx, -1, 1); active.roll = true; }
      if (ly) { pitch = clamp(pitch + ly, -1, 1); active.pitch = true; }
      if (rx) { yaw = clamp(yaw + rx, -1, 1); active.yaw = true; }
      pad.buttons.forEach((b, i) => { if (b.pressed && !this.padPrev[i]) this.pressed.push('Pad' + i); this.padPrev[i] = b.pressed; });
    }
    return { pitch, roll, yaw, active };
  }
  padBtn(i) { return !!(this.pad && this.pad.buttons[i] && this.pad.buttons[i].pressed); }
  padVal(i) { return this.pad && this.pad.buttons[i] ? this.pad.buttons[i].value : 0; }
}
