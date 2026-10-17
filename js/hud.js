// 2D overlay: gunsight, target markers + lead indicator, instruments, minimap, radio log.
import { clamp, V3 } from './math.js';
import { TYPES } from './types.js';
import { HM_N, HM_CELL, HM_X0, MAP_HALF } from './world.js';

const FONT = '"Gill Sans", "Gill Sans MT", "Trebuchet MS", Calibri, sans-serif';
const AMBER = 'rgba(255, 196, 92, 0.95)', AMBER_D = 'rgba(255, 170, 60, 0.55)';
const RED = 'rgba(255, 80, 60, 0.95)', BLUE = 'rgba(120, 190, 255, 0.95)';
const HITX = [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]];

export class HUD {
  constructor(canvas, world, { lowRes = false } = {}) {
    this.maxDpr = lowRes ? 1.5 : 2;   // the HUD is a full-screen layer composited every frame
    this.c = canvas; this.g = canvas.getContext('2d');
    this.world = world;
    this.msgs = []; this.feed = []; this.center = null;
    this.mapCanvas = this.buildMap(world);
    this.dpr = 1;
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    this.dpr = dpr; this.W = window.innerWidth; this.H = window.innerHeight;
  }
  buildMap(world) {
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), img = g.createImageData(S, S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = -MAP_HALF + (i + 0.5) / S * 2 * MAP_HALF, z = -MAP_HALF + (j + 0.5) / S * 2 * MAP_HALF;
      const h = world.heightAt(x, z), o = (j * S + i) * 4;
      let r, gg, b;
      if (h <= 0) { r = 26; gg = 52; b = 70; }
      else { const k = clamp(h / 160, 0, 1); r = 64 + 50 * k; gg = 82 + 30 * k; b = 44 + 20 * k; if (world.matAt(x, z, 0) > 0.5) { r *= 0.75; gg *= 0.8; b *= 0.7; } if (world.matAt(x, z, 1) > 0.4) { r = 110; gg = 100; b = 90; } }
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 230;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  radio(text, cls) {
    this.msgs.push({ text, cls, t: 0 });
    if (this.msgs.length > 7) this.msgs.shift();
  }
  popup(text, pts) { this.feed.push({ text, pts, t: 0 }); if (this.feed.length > 5) this.feed.shift(); }
  big(text, sub = '', dur = 3, col = AMBER) { this.center = { text, sub, t: 0, dur, col }; }

  // project a camera-relative point to CSS pixels; returns null if behind
  proj(vp, x, y, z, out) {
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.1) { out.behind = true; out.x = cx; out.y = cy; return false; }
    out.behind = false;
    out.x = (cx / cw * 0.5 + 0.5) * this.W; out.y = (1 - (cy / cw * 0.5 + 0.5)) * this.H;
    return true;
  }

  draw(S, dt) {
    const g = this.g, W = this.W, H = this.H;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    this.msgs.forEach((m) => (m.t += dt)); this.msgs = this.msgs.filter((m) => m.t < 12);
    this.feed.forEach((m) => (m.t += dt)); this.feed = this.feed.filter((m) => m.t < 4);
    if (this.center) { this.center.t += dt; if (this.center.t > this.center.dur) this.center = null; }
    if (!S.hidden) {
      if (S.player && S.player.alive) this.flightHud(S);
      this.markers(S);
      this.homeField(S);
      this.statusBar(S);
      this.minimap(S);
    }
    if (!S.hidden) { this.radioLog(); this.centerText(); }
    if (S.needClick) {
      g.textAlign = 'center'; g.font = `700 18px ${FONT}`;
      g.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(g, W / 2 - 190, H * 0.62 - 22, 380, 34, 6); g.fill();
      g.fillStyle = AMBER; g.fillText('CLICK TO TAKE CONTROL (MOUSE AIM)', W / 2, H * 0.62);
    }
    if (S.perf) this.perf(S.perf);
  }

  flightHud(S) {
    const g = this.g, W = this.W, H = this.H, p = S.player, vp = S.vp;
    const o = { x: 0, y: 0 };
    const T = p.type;
    // gunsight: where the guns are pointing (boresight at convergence range)
    const R = T.converge;
    const bx = p.fwd.x * R + S.relP.x, by = p.fwd.y * R + S.relP.y, bz = p.fwd.z * R + S.relP.z;
    let sx = W / 2, sy = H / 2;
    if (this.proj(vp, bx, by, bz, o)) { sx = o.x; sy = o.y; }
    const k = Math.min(W, H) / 900;
    g.lineWidth = 1.6; g.strokeStyle = AMBER; g.fillStyle = AMBER;
    g.shadowColor = 'rgba(255,160,40,0.8)'; g.shadowBlur = 6;
    g.beginPath(); g.arc(sx, sy, 34 * k, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(sx, sy, 2.2 * k, 0, Math.PI * 2); g.fill();
    // hit marker: a brief X around the sight when your rounds land on the selected target
    if (S.hitMarker > 0) {
      const r0 = 10 * k, r1 = 20 * k;
      g.save(); g.strokeStyle = `rgba(255,255,255,${Math.min(1, S.hitMarker * 7)})`; g.lineWidth = 2;
      g.beginPath();
      for (const [dx, dy] of HITX) { g.moveTo(sx + dx * r0, sy + dy * r0); g.lineTo(sx + dx * r1, sy + dy * r1); }
      g.stroke(); g.restore();
    }
    for (let a = 0; a < 4; a++) {
      const ang = a * Math.PI / 2, c = Math.cos(ang), s = Math.sin(ang);
      g.beginPath(); g.moveTo(sx + c * 40 * k, sy + s * 40 * k); g.lineTo(sx + c * (a % 2 ? 52 : 58) * k, sy + s * (a % 2 ? 52 : 58) * k); g.stroke();
    }
    g.beginPath(); g.moveTo(sx - 12 * k, sy); g.lineTo(sx - 6 * k, sy); g.moveTo(sx + 6 * k, sy); g.lineTo(sx + 12 * k, sy); g.stroke();
    // mouse-aim cursor
    if (S.aimDir && S.mouseAim) {
      if (this.proj(vp, S.aimDir.x * 1000, S.aimDir.y * 1000, S.aimDir.z * 1000, o)) {
        g.strokeStyle = 'rgba(255,255,255,0.85)'; g.shadowBlur = 3; g.shadowColor = '#000';
        g.beginPath(); g.arc(o.x, o.y, 7, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(o.x - 13, o.y); g.lineTo(o.x - 9, o.y); g.moveTo(o.x + 9, o.y); g.lineTo(o.x + 13, o.y); g.moveTo(o.x, o.y - 13); g.lineTo(o.x, o.y - 9); g.stroke();
      }
    }
    g.shadowBlur = 0;
    // lead indicator for the selected target
    const t = S.target;
    if (t && t.alive && S.lead) {
      const lx = S.lead.x - S.cam.x, ly = S.lead.y - S.cam.y, lz = S.lead.z - S.cam.z;
      if (this.proj(vp, lx, ly, lz, o)) {
        const dist = S.targetDist;
        const inRange = dist < 700;
        g.strokeStyle = inRange ? 'rgba(255,90,60,0.95)' : 'rgba(255,140,90,0.6)';
        g.lineWidth = inRange ? 2 : 1.3;
        const r = 7;
        g.beginPath(); g.moveTo(o.x, o.y - r); g.lineTo(o.x + r, o.y); g.lineTo(o.x, o.y + r); g.lineTo(o.x - r, o.y); g.closePath(); g.stroke();
        if (inRange) { g.beginPath(); g.arc(o.x, o.y, 1.8, 0, 6.3); g.fillStyle = g.strokeStyle; g.fill(); }
      }
    }
    // bomb impact predictor (Mosquito)
    if (S.ccip) {
      if (this.proj(vp, S.ccip.x - S.cam.x, S.ccip.y - S.cam.y, S.ccip.z - S.cam.z, o)) {
        g.strokeStyle = 'rgba(255,230,120,0.9)'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(o.x, o.y, 12, 0, 6.3); g.stroke();
        g.beginPath(); g.moveTo(o.x - 20, o.y); g.lineTo(o.x - 14, o.y); g.moveTo(o.x + 14, o.y); g.lineTo(o.x + 20, o.y); g.moveTo(o.x, o.y + 14); g.lineTo(o.x, o.y + 22); g.stroke();
        g.font = `11px ${FONT}`; g.fillStyle = 'rgba(255,230,120,0.9)'; g.textAlign = 'center'; g.fillText('BOMBS', o.x, o.y - 18);
      }
    }
    this.instruments(S);
    this.warnings(S);
  }

  instruments(S) {
    const g = this.g, H = this.H, W = this.W, p = S.player, T = p.type;
    const x0 = 18, y0 = H - 150;
    g.fillStyle = 'rgba(12,14,10,0.55)'; roundRect(g, x0, y0, 236, 132, 8); g.fill();
    g.strokeStyle = 'rgba(255,196,92,0.25)'; g.lineWidth = 1; g.stroke();
    g.font = `600 12px ${FONT}`; g.textAlign = 'left'; g.fillStyle = AMBER_D;
    g.fillText('AIRSPEED', x0 + 12, y0 + 20); g.fillText('ALTITUDE', x0 + 126, y0 + 20);
    g.font = `600 30px ${FONT}`; g.fillStyle = AMBER;
    g.fillText(`${Math.round(p.speed * 2.237)}`, x0 + 12, y0 + 52);
    g.fillText(`${Math.round(Math.max(0, p.pos.y) * 3.281 / 10) * 10}`, x0 + 126, y0 + 52);
    g.font = `600 12px ${FONT}`; g.fillStyle = AMBER_D;
    g.fillText('MPH', x0 + 80, y0 + 52); g.fillText('FT', x0 + 208, y0 + 52);
    // throttle / boost
    const th = clamp(p.rpm, 0, 1.2);
    g.fillText('THROTTLE', x0 + 12, y0 + 76);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x0 + 80, y0 + 67, 140, 9);
    g.fillStyle = th > 1.01 ? 'rgba(255,90,60,0.9)' : AMBER; g.fillRect(x0 + 80, y0 + 67, 140 * Math.min(th, 1.2) / 1.2, 9);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x0 + 80 + 140 / 1.2, y0 + 64, 1.5, 15);
    if (p.boostHeat > 0.05) { g.fillStyle = AMBER_D; g.fillText(p.boostHeat > 0.85 ? 'ENGINE HOT!' : 'BOOST', x0 + 12, y0 + 94); g.fillStyle = p.boostHeat > 0.85 ? RED : 'rgba(255,140,60,0.8)'; g.fillRect(x0 + 80, y0 + 86, 140 * p.boostHeat, 5); }
    // heading + g
    g.fillStyle = AMBER_D; g.font = `600 12px ${FONT}`;
    g.fillText(`HDG ${String(Math.round(p.compass * 57.2958) % 360).padStart(3, '0')}`, x0 + 12, y0 + 118);
    g.fillText(`G ${p.nz.toFixed(1)}`, x0 + 90, y0 + 118);
    g.fillText(p.gear > 0.5 ? 'GEAR DN' : '', x0 + 150, y0 + 118);
    // damage + weapons panel (bottom centre)
    const cx = W / 2, by = H - 64;
    const hp = clamp(p.hp / T.hp, 0, 1);
    g.fillStyle = 'rgba(12,14,10,0.55)'; roundRect(g, cx - 190, by - 8, 380, 54, 8); g.fill();
    g.font = `600 11px ${FONT}`; g.fillStyle = AMBER_D; g.textAlign = 'left';
    g.fillText(T.short, cx - 178, by + 8);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(cx - 178, by + 14, 120, 8);
    g.fillStyle = hp > 0.6 ? 'rgba(130,220,110,0.9)' : hp > 0.3 ? 'rgba(255,200,80,0.95)' : RED;
    g.fillRect(cx - 178, by + 14, 120 * hp, 8);
    if (p.fire > 0) { g.fillStyle = RED; g.fillText('ENGINE FIRE', cx - 178, by + 38); }
    else if (p.engineDmg > 0.3) { g.fillStyle = 'rgba(255,200,80,0.95)'; g.fillText('ENGINE DAMAGED', cx - 178, by + 38); }
    let wx = cx - 40;
    T.volleys.forEach((v, i) => {
      const left = p.ammo[i], frac = left / v.ammo;
      g.fillStyle = AMBER_D; g.fillText(v.kind === 'cannon' ? '20MM' : v.kind === 'hmg' ? '13MM' : '.303', wx, by + 8);
      g.font = `600 20px ${FONT}`; g.fillStyle = frac > 0.2 ? AMBER : RED;
      g.fillText(String(left * v.perVolley), wx, by + 32);
      g.font = `600 11px ${FONT}`;
      wx += 70;
    });
    if (T.bombs) { g.fillStyle = AMBER_D; g.fillText('BOMBS', wx, by + 8); g.font = `600 20px ${FONT}`; g.fillStyle = p.bombs ? AMBER : RED; g.fillText(String(p.bombs), wx, by + 32); g.font = `600 11px ${FONT}`; }
  }

  warnings(S) {
    const g = this.g, p = S.player, W = this.W, H = this.H;
    const w = [];
    if (p.state === 'air' && p.agl < 120 && p.vel.y < -12 && p.agl / -p.vel.y < 4) w.push('PULL UP!');
    if (p.state === 'air' && p.speed < p.type.vs * 1.1) w.push('STALL');
    if (p.boostHeat > 0.92) w.push('OVERHEAT');
    if (S.outOfBounds) w.push('RETURN TO THE BATTLE AREA');
    if (S.serviceT > 0) w.push(S.serviceT < 4 ? `GROUND CREW REARMING ${Math.ceil(4 - S.serviceT)}` : S.towWait === 'traffic' ? 'REARMED - WAITING FOR TAKE-OFF TRAFFIC' : S.towWait === 'runway' ? 'REARMED - RUNWAY UNSERVICEABLE' : 'REARMED - READY');
    if (!w.length) return;
    const blink = Math.sin(performance.now() / 120) > -0.3;
    g.font = `700 22px ${FONT}`; g.textAlign = 'center';
    w.forEach((t, i) => {
      if (!blink && !t.startsWith('REARMED') && !t.startsWith('GROUND')) return;
      g.fillStyle = t.startsWith('GROUND') || t.startsWith('REARMED') ? 'rgba(150,230,140,0.95)' : RED;
      g.fillText(t, W / 2, H * 0.3 + i * 28);
    });
  }

  markers(S) {
    const g = this.g, vp = S.vp, W = this.W, H = this.H;
    const o = { x: 0, y: 0 };
    g.font = `600 11px ${FONT}`; g.textAlign = 'center';
    const offscreen = [];
    for (const a of S.aircraft) {
      if (a === S.player || !a.alive) continue;
      const rx = a.rp.x - S.cam.x, ry = a.rp.y - S.cam.y, rz = a.rp.z - S.cam.z;
      const d = Math.hypot(rx, ry, rz);
      const enemy = a.team !== S.team;
      if (d > (enemy ? 9000 : 2500)) continue;
      const on = this.proj(vp, rx, ry, rz, o) && o.x > 0 && o.x < W && o.y > 0 && o.y < H;
      if (!on) { if (enemy && d < 5000) offscreen.push([a, rx, ry, rz, d]); continue; }
      const col = enemy ? RED : BLUE;
      const sel = a === S.target;
      const s = clamp(900 / d, 6, 26) * (sel ? 1.25 : 1);
      g.strokeStyle = col; g.lineWidth = sel ? 2 : 1.2; g.fillStyle = col;
      if (enemy) {
        const c = s * 0.45;
        g.beginPath();
        g.moveTo(o.x - s, o.y - s + c); g.lineTo(o.x - s, o.y - s); g.lineTo(o.x - s + c, o.y - s);
        g.moveTo(o.x + s - c, o.y - s); g.lineTo(o.x + s, o.y - s); g.lineTo(o.x + s, o.y - s + c);
        g.moveTo(o.x - s, o.y + s - c); g.lineTo(o.x - s, o.y + s); g.lineTo(o.x - s + c, o.y + s);
        g.moveTo(o.x + s - c, o.y + s); g.lineTo(o.x + s, o.y + s); g.lineTo(o.x + s, o.y + s - c);
        g.stroke();
        if (d < 3000 || sel) g.fillText(`${a.type.short} ${d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(1) + 'km'}`, o.x, o.y - s - 5);
        if (sel && a.type.hp) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(o.x - 16, o.y + s + 4, 32, 4); g.fillStyle = col; g.fillRect(o.x - 16, o.y + s + 4, 32 * clamp(a.hp / a.type.hp, 0, 1), 4); }
      } else {
        g.beginPath(); g.moveTo(o.x, o.y - 6 - s * 0.3); g.lineTo(o.x + 5, o.y - 13 - s * 0.3); g.lineTo(o.x - 5, o.y - 13 - s * 0.3); g.closePath(); g.fill();
        if (d < 1200) g.fillText(a.callsign || '', o.x, o.y - 17 - s * 0.3);
      }
    }
    // edge arrows for the nearest off-screen bandits
    offscreen.sort((a, b) => a[4] - b[4]);
    for (const [a, rx, ry, rz, d] of offscreen.slice(0, 6)) {
      // direction in screen space using the view matrix rows (camera right/up)
      const sxv = rx * S.camRight.x + ry * S.camRight.y + rz * S.camRight.z;
      const syv = rx * S.camUp.x + ry * S.camUp.y + rz * S.camUp.z;
      const ang = Math.atan2(-syv, sxv);
      const R = Math.min(W, H) * 0.42;
      const x = W / 2 + Math.cos(ang) * R, y = H / 2 + Math.sin(ang) * R;
      g.save(); g.translate(x, y); g.rotate(ang);
      g.fillStyle = a === S.target ? 'rgba(255,90,60,1)' : 'rgba(255,90,60,0.7)';
      g.beginPath(); g.moveTo(12, 0); g.lineTo(-6, -8); g.lineTo(-2, 0); g.lineTo(-6, 8); g.closePath(); g.fill();
      g.restore();
      if (a === S.target) { g.fillStyle = RED; g.fillText(`${(d / 1000).toFixed(1)}km`, x, y + 20); }
    }
    // ground targets (Mosquito) / enemy airfield marker
    for (const t of S.groundTargets) {
      const rx = t.x - S.cam.x, ry = t.y + 8 - S.cam.y, rz = t.z - S.cam.z;
      const d = Math.hypot(rx, ry, rz);
      if (d > 9000 || !this.proj(vp, rx, ry, rz, o)) continue;
      g.strokeStyle = 'rgba(255,200,90,0.8)'; g.lineWidth = 1.2;
      const s = clamp(2500 / d, 4, 10);
      g.beginPath(); g.moveTo(o.x, o.y - s); g.lineTo(o.x + s, o.y); g.lineTo(o.x, o.y + s); g.lineTo(o.x - s, o.y); g.closePath(); g.stroke();
      if (d < 4000) { g.fillStyle = 'rgba(255,200,90,0.8)'; g.fillText(t.kind === 'hangar' ? 'HANGAR' : 'RUNWAY', o.x, o.y - s - 4); }
    }
  }

  // rearm prompt and a marker on the home airfield (only while low on ammo / bombs, or damaged)
  homeField(S) {
    const h = S.home;
    if (!h || !S.player) return;
    const g = this.g, W = this.W, H = this.H, o = { x: 0, y: 0 }, col = 'rgba(140,200,255,0.95)';
    g.textAlign = 'center'; g.font = `700 14px ${FONT}`; g.fillStyle = col;
    g.fillText(h.text, W / 2, 104);
    if (h.stage === 'roll') return;
    const rx = h.x - S.cam.x, ry = h.y + 10 - S.cam.y, rz = h.z - S.cam.z, d = Math.hypot(rx, ry, rz);
    const label = `${h.name} ${d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(1) + 'km'}`;
    g.font = `600 11px ${FONT}`; g.strokeStyle = col; g.lineWidth = 1.5;
    if (this.proj(S.vp, rx, ry, rz, o) && o.x > 0 && o.x < W && o.y > 0 && o.y < H) {
      const s = clamp(4000 / d, 7, 14);
      g.beginPath(); g.arc(o.x, o.y, s, 0, Math.PI * 2); g.moveTo(o.x - s * 1.6, o.y); g.lineTo(o.x + s * 1.6, o.y); g.stroke();
      g.fillText(label, o.x, o.y - s - 6);
    } else {
      // edge arrow toward the field
      const sxv = rx * S.camRight.x + ry * S.camRight.y + rz * S.camRight.z;
      const syv = rx * S.camUp.x + ry * S.camUp.y + rz * S.camUp.z;
      const ang = Math.atan2(-syv, sxv), R = Math.min(W, H) * 0.42;
      const x = W / 2 + Math.cos(ang) * R, y = H / 2 + Math.sin(ang) * R;
      g.save(); g.translate(x, y); g.rotate(ang);
      g.fillStyle = col; g.beginPath(); g.moveTo(14, 0); g.lineTo(-6, -9); g.lineTo(-2, 0); g.lineTo(-6, 9); g.closePath(); g.fill();
      g.restore();
      g.fillText(label, x, y + 22);
    }
  }

  statusBar(S) {
    const g = this.g, W = this.W;
    const [a, b] = S.status;
    const box = (x, s, name, col, mine) => {
      g.textAlign = 'center';
      g.font = `700 12px ${FONT}`; g.fillStyle = col; g.fillText(name, x, 22);
      g.font = `600 11px ${FONT}`; g.fillStyle = 'rgba(240,230,210,0.9)';
      g.fillText(`HANGARS ${'■'.repeat(s.hangars)}${'□'.repeat(3 - s.hangars)}   RUNWAY ${'■'.repeat(s.runway)}${'□'.repeat(3 - s.runway)}`, x, 38);
      g.fillText(`AIRBORNE ${s.airborne}   RESERVES ${s.stock}`, x, 53);
    };
    g.fillStyle = 'rgba(12,14,10,0.5)'; roundRect(g, W / 2 - 250, 6, 500, 56, 8); g.fill();
    box(W / 2 - 125, a, 'ROYAL AIR FORCE', 'rgba(140,190,255,1)');
    box(W / 2 + 125, b, 'LUFTWAFFE', 'rgba(255,120,100,1)');
    g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(W / 2 - 0.5, 12, 1, 44);
    if (S.raid && Math.sin(performance.now() / 250) > 0) {
      g.font = `700 13px ${FONT}`; g.fillStyle = RED; g.fillText('AIR RAID WARNING RED', W / 2, 80);
    }
    // time + score
    g.textAlign = 'right'; g.font = `600 12px ${FONT}`; g.fillStyle = 'rgba(240,230,210,0.85)';
    const m = Math.floor(S.time / 60), s = Math.floor(S.time % 60);
    g.fillText(`${m}:${String(s).padStart(2, '0')}   SCORE ${S.score}   KILLS ${S.stats.kills}`, W - 18, 22);
    if (S.wingOrder) g.fillText(`WINGMEN: ${S.wingOrder.toUpperCase()}`, W - 18, 38);
    this.feed.forEach((f, i) => {
      g.fillStyle = `rgba(255,220,140,${clamp(2 - f.t / 2, 0, 1)})`;
      g.font = `700 15px ${FONT}`;
      g.fillText(`${f.text}  +${f.pts}`, W - 18, 66 + i * 20 - f.t * 6);
    });
  }

  minimap(S) {
    const g = this.g, W = this.W, H = this.H;
    const size = S.bigMap ? Math.min(W, H) * 0.8 : 190;
    const x0 = S.bigMap ? (W - size) / 2 : W - size - 18, y0 = S.bigMap ? (H - size) / 2 : H - size - 18;
    g.save();
    g.globalAlpha = S.bigMap ? 0.95 : 0.85;
    roundRect(g, x0, y0, size, size, 8); g.clip();
    g.drawImage(this.mapCanvas, x0, y0, size, size);
    const toMap = (x, z) => [x0 + (x + MAP_HALF) / (2 * MAP_HALF) * size, y0 + (z + MAP_HALF) / (2 * MAP_HALF) * size];
    for (const f of this.world.fields) {
      const [mx, my] = toMap(f.x, f.z);
      g.strokeStyle = f.team === 0 ? BLUE : RED; g.lineWidth = 3;
      const L = f.rwyLen / (2 * MAP_HALF) * size;
      g.beginPath(); g.moveTo(mx - f.ux * L / 2, my - f.uz * L / 2); g.lineTo(mx + f.ux * L / 2, my + f.uz * L / 2); g.stroke();
      if (S.bigMap) { g.font = `600 12px ${FONT}`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(f.name, mx, my + 22); }
    }
    for (const a of S.aircraft) {
      if (!a.alive || a === S.player) continue;
      const [mx, my] = toMap(a.pos.x, a.pos.z);
      g.fillStyle = a.team === S.team ? BLUE : RED;
      const r = a.type.role === 'fighter' ? 2.2 : 3;
      g.fillRect(mx - r, my - r, r * 2, r * 2);
    }
    if (S.player && S.player.alive) {
      const p = S.player, [mx, my] = toMap(p.pos.x, p.pos.z), hd = p.compass;
      g.save(); g.translate(mx, my); g.rotate(hd);
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2); g.lineTo(-5, 5); g.closePath(); g.fill();
      g.restore();
    }
    g.restore();
    g.strokeStyle = 'rgba(255,196,92,0.35)'; g.lineWidth = 1; roundRect(g, x0, y0, size, size, 8); g.stroke();
    g.font = `600 10px ${FONT}`; g.fillStyle = 'rgba(240,230,210,0.7)'; g.textAlign = 'center';
    g.fillText('N', x0 + size / 2, y0 + 12);
  }

  radioLog() {
    const g = this.g;
    g.textAlign = 'left';
    this.msgs.forEach((m, i) => {
      const a = clamp(12 - m.t, 0, 1) * clamp(m.t * 6, 0, 1);
      const col = m.cls === 'alert' ? `rgba(255,110,90,${a})` : m.cls === 'good' ? `rgba(150,230,140,${a})` : m.cls === 'control' ? `rgba(160,200,255,${a})` : m.cls === 'wing' ? `rgba(220,220,200,${a})` : `rgba(255,220,150,${a})`;
      g.font = `600 13px ${FONT}`;
      g.fillStyle = `rgba(10,12,10,${0.45 * a})`;
      const w = m.w ?? (m.w = g.measureText(m.text).width);
      g.fillRect(14, 74 + i * 22 - 14, w + 16, 20);
      g.fillStyle = col; g.fillText(m.text, 22, 74 + i * 22);
    });
  }

  centerText() {
    const c = this.center;
    if (!c) return;
    const g = this.g, W = this.W, H = this.H;
    const a = clamp(c.t * 4, 0, 1) * clamp((c.dur - c.t) * 2, 0, 1);
    g.textAlign = 'center';
    g.font = `700 ${Math.round(Math.min(W / 14, 56))}px ${FONT}`;
    g.fillStyle = `rgba(0,0,0,${0.5 * a})`; g.fillText(c.text, W / 2 + 2, H * 0.36 + 2);
    g.fillStyle = c.col.replace(/[\d.]+\)$/, `${a})`); g.fillText(c.text, W / 2, H * 0.36);
    if (c.sub) { g.font = `600 18px ${FONT}`; g.fillStyle = `rgba(240,230,210,${a})`; g.fillText(c.sub, W / 2, H * 0.36 + 34); }
  }

  perf(p) {
    const g = this.g;
    g.font = `12px ui-monospace, Menlo, monospace`; g.textAlign = 'left';
    const lines = Object.entries(p).map(([k, v]) => `${k} ${v}`);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(this.W - 220, 90, 205, lines.length * 15 + 10);
    g.fillStyle = 'rgba(160,255,170,0.95)';
    lines.forEach((t, i) => g.fillText(t, this.W - 212, 106 + i * 15));
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
