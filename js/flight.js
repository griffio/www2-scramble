// Arcade flight model. Rate-command handling (the stick commands body rates, released stick
// holds attitude) on top of a simple but physical point-mass: thrust from power (falls with
// speed), parasite + induced drag, lift from angle of attack with a stall, side force from
// sideslip. Corner speed, energy bleed in hard turns, zoom climbs and stalls all emerge.
// Landing: the gear and the split flaps (big drag, extra lift, lower stall speed) come down together
// (the player works them with one key; AI gear retracts by itself after take-off), the windmilling
// propeller brakes with the throttle closed, a little ground effect cushions the flare, and a landed
// aircraft stays on its wheels until the pilot asks for a go-around.
import { V3, Quat, qrot, qrotInv, clamp, lerp, smoothstep, G, DEG, wrapPi } from './math.js';

const ALPHA_STALL = 16 * DEG;
const _v = new V3(), _a = new V3(), _b = new V3(), _c = new V3(), _ld = new V3(), _sd = new V3();

let NEXT_ID = 1;
export class Aircraft {
  constructor(type, team) {
    this.id = NEXT_ID++;
    this.type = type; this.team = team;
    this.pos = new V3(); this.vel = new V3(); this.q = new Quat(); this.w = new V3();
    this.fwd = new V3(0, 0, -1); this.up = new V3(0, 1, 0); this.right = new V3(1, 0, 0);
    this.ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 1, fire: false, bomb: false, boost: false, brake: false, airbrake: false };
    this.rpm = 0.3; this.boostHeat = 0;
    this.hp = type.hp; this.state = 'air';
    this.gear = 1; this.gearAuto = true;
    this.flap = 0; this.flapDown = false;                        // flaps follow the gear down
    this.vsNow = type.vs;                                        // stall speed in the current configuration
    this.groundPitch = 0; this.heading = 0;
    this.alpha = 0; this.beta = 0; this.nz = 1; this.speed = 0; this.stall = 0;
    this.engineDmg = 0; this.fire = 0; this.smoke = 0;
    this.ammo = type.volleys.map((v) => v.ammo);
    this.gunCool = type.volleys.map(() => 0);
    this.muzzle = type.volleys.map(() => 0);
    this.bombs = type.bombs; this.bombCool = 0;
    this.downSpin = 0; this.lastHitBy = null; this.lastHitT = -99; this.hitFlash = 0;
    this.age = 0; this.propAngle = Math.random() * 6; this.diveBrake = 0;
    const g = type.geom;
    // gear geometry: tail-down attitude and origin height above the contact plane
    const mw = g ? g.mainWheel : [1.7, -2.2, -0.5], tw = g ? g.tailWheel : [0, -1.0, 6.5];
    this.groundPitch0 = Math.atan((mw[1] - tw[1]) / (mw[2] - tw[2]));
    const c = Math.cos(this.groundPitch0), s = Math.sin(this.groundPitch0);
    this.gearH0 = -(c * mw[1] - s * mw[2]);      // tail down
    this.gearH1 = -mw[1];                        // level
  }
  get alive() { return this.state === 'air' || this.state === 'ground'; }

  placeOnRunway(x, z, hdg, groundY) {
    this.state = 'ground';
    this.heading = hdg; this.groundPitch = this.groundPitch0;
    this.q.setHPR(hdg, this.groundPitch, 0);
    this.pos.set(x, groundY + this.gearH0, z);
    this.vel.set(0, 0, 0); this.w.set(0, 0, 0);
    this.gear = 1; this.gearUp = false; this.rpm = 0.6; this.speed = 0;
    this.flap = 0; this.flapDown = false; this.landedAt = undefined;
    this.updateBasis();
  }
  placeInAir(x, y, z, hdg, speed) {
    this.state = 'air';
    this.q.setHPR(hdg, 0, 0);
    this.pos.set(x, y, z);
    this.updateBasis();
    this.vel.copy(this.fwd).scale(speed);
    this.gear = 0; this.gearUp = true; this.rpm = 1; this.speed = speed;
    this.flap = 0; this.flapDown = false;
  }
  updateBasis() {
    qrot(this.q, 0, 0, -1, this.fwd); qrot(this.q, 0, 1, 0, this.up); qrot(this.q, 1, 0, 0, this.right);
  }
  // attitude for HUD / AI
  get pitchAngle() { return Math.asin(clamp(this.fwd.y, -1, 1)); }
  get bankAngle() { return Math.atan2(-this.right.y, this.up.y); }   // + = right wing down
  get compass() { return (Math.atan2(this.fwd.x, -this.fwd.z) + 2 * Math.PI) % (2 * Math.PI); }

  step(dt, world) {
    const T = this.type, ctl = this.ctl;
    this.age += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    // engine
    let tgt = this.state === 'down' ? 0 : clamp(ctl.throttle, 0, 1);
    if (ctl.boost && tgt > 0.95 && this.boostHeat < 1 && this.state !== 'down') { tgt = T.boost; this.boostHeat += dt / 25; }
    else this.boostHeat = Math.max(0, this.boostHeat - dt / 40);
    this.rpm += (tgt - this.rpm) * Math.min(1, dt * 1.6);
    this.propAngle += dt * (8 + 120 * this.rpm);
    if (this.state === 'ground') this.stepGround(dt, world);
    else this.stepAir(dt, world);
    this.updateBasis();
  }

  thrustAccel(V) {
    const T = this.type;
    const eng = Math.max(0, 1 - this.engineDmg * 0.55);
    return T.power * Math.max(0, this.rpm) * eng / Math.max(V, 45);
  }

  stepAir(dt, world) {
    const T = this.type, ctl = this.ctl, vs = T.vs;
    const V = Math.max(0.1, this.vel.len());
    this.speed = V;
    qrotInv(this.q, this.vel.x, this.vel.y, this.vel.z, _v);
    const alpha = Math.atan2(-_v.y, -_v.z), beta = Math.atan2(_v.x, -_v.z);
    this.alpha = alpha; this.beta = beta;
    const qbar = (V / vs) * (V / vs);
    // flaps: more lift at a given angle of attack (so a lower stall speed) and a lot more drag
    const flap = this.flap, clFlap = 1 + 0.3 * flap;
    const vsEff = vs / Math.sqrt(clFlap);
    this.vsNow = vsEff;
    // ground effect within a wingspan or so of the ground: a bit more lift, less induced drag
    const ge = world ? 1 - smoothstep(3, 16, this.agl ?? 1e9) : 0;
    const eff = clamp((V - 0.45 * vsEff) / (0.8 * vsEff), 0.1, 1);
    const hiSpeed = V > 150 ? Math.max(0.45, 1 - (V - 150) / 160) : 1;     // stiff controls in a fast dive
    // ---------------------------------------------------------- rotation
    let cp = ctl.pitch, cr = ctl.roll, cy = ctl.yaw;
    if (this.state === 'down') {
      cp = 0.15 * Math.sin(this.age * 0.7); cr = this.downSpin; cy = this.downSpin * 0.3;
    }
    const nPos = Math.min(T.gmax, qbar * 0.98), nNeg = Math.min(T.gmax * 0.45, qbar * 0.6);
    const qmax = (cp >= 0 ? nPos : nNeg) * G / Math.max(V, 25) + 0.08;
    let qc = cp * qmax * hiSpeed;
    // stall: the nose drops toward the flight path, wings rock
    const stall = Math.max(smoothstep(0.9 * ALPHA_STALL, 1.4 * ALPHA_STALL, Math.abs(alpha)), 1 - smoothstep(0.65 * vsEff, 0.95 * vsEff, V));
    this.stall = stall;
    qc += -alpha * 2.2 * stall;
    let rc = -cr * T.roll * eff * hiSpeed;
    if (stall > 0.5) rc += Math.sin(this.age * 2.3) * 0.6 * stall;
    let yc = -cy * T.yaw * eff - beta * 3.0 * Math.max(eff, 0.4);
    const k = Math.min(1, dt / 0.11);
    this.w.x += (qc - this.w.x) * k;
    this.w.y += (yc - this.w.y) * k;
    this.w.z += (rc - this.w.z) * Math.min(1, dt / 0.09);
    this.q.integrate(this.w.x, this.w.y, this.w.z, dt);
    qrot(this.q, 0, 0, -1, this.fwd); qrot(this.q, 0, 1, 0, this.up); qrot(this.q, 1, 0, 0, this.right);
    // ---------------------------------------------------------- forces
    const vx = this.vel.x / V, vy = this.vel.y / V, vz = this.vel.z / V;
    // lift
    const a = alpha / ALPHA_STALL;
    let CL = Math.abs(a) <= 1 ? a : Math.sign(a) * Math.max(0.4, 1 - (Math.abs(a) - 1) * 0.9);
    let L = G * qbar * CL * clFlap * (1 + 0.1 * ge);
    const Lmax = T.gmax * G * 1.08;
    if (L > Lmax) L = Lmax; else if (L < -Lmax * 0.5) L = -Lmax * 0.5;
    const ud = this.up.x * vx + this.up.y * vy + this.up.z * vz;
    _ld.set(this.up.x - vx * ud, this.up.y - vy * ud, this.up.z - vz * ud).normalize();
    // side force
    const sideK = clamp(beta / 0.25, -1, 1) * G * qbar * 0.8;
    const rd = this.right.x * vx + this.right.y * vy + this.right.z * vz;
    _sd.set(this.right.x - vx * rd, this.right.y - vy * rd, this.right.z - vz * rd).normalize();
    const n = L / G;
    this.nz = n;
    // drag
    const brake = this.diveBrake * 2.6 + (this.state === 'down' ? 1.5 : 0);
    // throttle closed: the windmilling propeller is a big flat disc (closing the throttle really brakes)
    const idle = 1 - clamp(this.rpm / 0.4, 0, 1);
    const Dp = T.cd0 * V * V * (1 + this.gear * 0.35 + brake + 1.5 * idle);
    const Di = (T.ki * n * n / Math.max(V * V, 300)) * (1 - 0.35 * ge) + T.ki * 0.6 * (beta * beta) * 10 / Math.max(V * V, 300) * qbar;
    // the undercarriage and the barn-door flaps: drag that matters at approach speed (per unit of qbar,
    // so it scales with the aircraft's own stall speed rather than its tiny clean cd0)
    const Dl = (this.gear * 0.12 + flap * 0.3) * qbar;
    const D = Dp + Di + Dl;
    const Th = this.thrustAccel(V);
    const ax = _ld.x * L - _sd.x * sideK - vx * D + this.fwd.x * Th;
    const ay = _ld.y * L - _sd.y * sideK - vy * D + this.fwd.y * Th - G;
    const az = _ld.z * L - _sd.z * sideK - vz * D + this.fwd.z * Th;
    this.vel.x += ax * dt; this.vel.y += ay * dt; this.vel.z += az * dt;
    this.pos.addScaled(this.vel, dt);
    // ---------------------------------------------------------- gear
    if (world) {
      const gh = world.groundAt(this.pos.x, this.pos.z);
      const agl = this.pos.y - gh;
      this.agl = agl;
      // AI aircraft raise the gear after take-off by themselves (they never touch down: the sim "lands"
      // them near home); the player's gear is manual
      if (this.gearAuto && this.state === 'air' && this.gear > 0 && agl > 25 && V > vs * 1.25) this.gearUp = true;
      this.gear = clamp(this.gear + (this.gearUp ? -dt / 3 : dt / 3), 0, 1);
      // flaps follow the gear down (below the flap limit speed) and come up with it
      const flapOut = this.flapDown && !this.gearUp && V < vs * 2.2;
      this.flap = clamp(this.flap + (flapOut ? dt / 2.5 : -dt / 2.5), 0, 1);
      // lowest point: main / tail wheel with the gear down, else the belly
      let low = -1.1;
      if (this.gear > 0.95) {
        const g = this.type.geom, mw = g ? g.mainWheel : [1.7, -2.2, -0.5], tw = g ? g.tailWheel : [0, -1.0, 6.5];
        low = Math.min(qrot(this.q, mw[0], mw[1], mw[2], _a).y, qrot(this.q, -mw[0], mw[1], mw[2], _b).y, qrot(this.q, tw[0], tw[1], tw[2], _c).y);
      }
      const wheelY = -low;
      if (agl < wheelY && (this.vel.y < 0.2 || agl < wheelY - 0.6)) this.touchdown(world, gh);
    }
  }

  touchdown(world, gh) {
    const V = this.speed, sink = -this.vel.y;
    const bank = Math.abs(this.bankAngle), pitch = this.pitchAngle;
    const okSurface = gh > 0.3 && world.slopeAt(this.pos.x, this.pos.z) > 0.985;
    if (this.state === 'air' && this.gear > 0.95 && okSurface && sink < 7 && bank < 22 * DEG && pitch > -5 * DEG && pitch < 22 * DEG && V < this.type.vs * 2.2 && this.up.y > 0.8) {
      this.state = 'ground';
      this.heading = this.compass;
      this.groundPitch = clamp(pitch, 0, this.groundPitch0);
      this.vel.y = 0;
      this.landedAt = this.age;
      return;
    }
    this.crash(gh <= 0.3 ? 'water' : 'ground');
  }
  crash(kind) { this.state = 'dead'; this.crashKind = kind; this.hp = 0; }

  stepGround(dt, world) {
    const T = this.type, ctl = this.ctl, vs = T.vs;
    const gh = world.groundAt(this.pos.x, this.pos.z);
    let V = this.speed;
    // tail comes up as speed builds; the pilot rotates past ~0.95 Vs
    const landed = this.landedAt !== undefined;
    // flaps: stay out through the landing roll (drag), never out for a take-off
    if (!landed) this.flapDown = false;
    this.flap = clamp(this.flap + (this.flapDown ? dt / 2.5 : -dt / 2.5), 0, 1);
    const clFlap = 1 + 0.3 * this.flap;
    this.vsNow = vs / Math.sqrt(clFlap);
    const tailUp = smoothstep(0.3 * vs, 0.75 * vs, V);
    let target = this.groundPitch0 * (1 - tailUp);
    if (ctl.pitch > 0.05 && V > this.vsNow * 0.92) target = this.groundPitch0 + 3 * DEG;
    this.groundPitch += clamp(target - this.groundPitch, -0.25 * dt, 0.18 * dt);
    // lift at this attitude
    const CL = clamp(this.groundPitch / ALPHA_STALL, -1, 1);
    const L = G * (V / vs) * (V / vs) * CL * clFlap * 1.15;      // + ground effect
    // longitudinal
    const Th = this.thrustAccel(Math.max(V, 1)) * (V < 22 ? V / 22 * 0.5 + 0.5 : 1);
    // rolling resistance + wheel brakes (the AI brakes by closing the throttle after landing)
    const roll = 0.4 + (ctl.brake || (ctl.throttle < 0.05 && this.landedAt !== undefined) ? 3.8 : 0);
    const D = T.cd0 * V * V * (1 + 0.35 * this.gear) + (0.12 + 0.3 * this.flap) * (V / vs) * (V / vs) + roll;
    V = Math.max(0, V + (Th - D) * dt);
    // steering
    const steer = clamp(ctl.yaw + ctl.roll * 0.8, -1, 1);
    this.heading = wrapPi(this.heading + steer * dt * 0.7 * clamp(V / 12, 0.15, 1)) ;
    if (this.heading < 0) this.heading += 2 * Math.PI;
    this.q.setHPR(this.heading, this.groundPitch, 0);
    this.updateBasis();
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    this.vel.set(sh * V, 0, -ch * V);
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const c = Math.cos(this.groundPitch), s = Math.sin(this.groundPitch);
    const mw = this.type.geom ? this.type.geom.mainWheel : [1.7, -2.2, -0.5];
    this.pos.y = world.groundAt(this.pos.x, this.pos.z) + -(c * mw[1] - s * mw[2]);
    this.speed = V; this.alpha = this.groundPitch; this.beta = 0; this.nz = 1; this.stall = 0; this.agl = this.pos.y - gh;
    this.w.set(0, 0, 0);
    // rough ground at speed
    if (V > 18 && world.slopeAt(this.pos.x, this.pos.z) < 0.97) { this.crash('ground'); return; }
    // airborne: a landed aircraft stays down (no bouncing back into the air at touchdown) unless the
    // pilot opens up and pulls for a go-around
    if (L > G && (!landed || (ctl.pitch > 0.05 && ctl.throttle > 0.5))) {
      this.state = 'air';
      this.w.x = 0.05;
      this.vel.y = 1.0;
      this.landedAt = undefined;
      this.flapDown = false;
    }
  }
}
