import * as THREE from 'three';

// 姿勢・歩容・IK・視線・しっぽ・まばたきをまとめて動かす「運動系」。
// 行動系（CatBrain）が毎フレーム cmd を書き換え、ここで骨格に反映する。

const POSTURES = {
  // y: 立ち姿の高さに対する比率, z: 前後オフセット(m), pitch: 鼻先が上向きで+ (rad), head: 頭の世界ピッチ
  stand:   { y: 1.0,  z: 0.0,    pitch: 0.0,   head: 0.02 },
  sit:     { y: 0.78, z: -0.028, pitch: 0.62,  head: 0.02 },
  lie:     { y: 0.41, z: 0.0,    pitch: 0.02,  head: -0.02 },
  crouch:  { y: 0.72, z: -0.01,  pitch: -0.05, head: -0.12 },
  stretch: { y: 0.74, z: 0.03,   pitch: -0.3,  head: 0.35 },
  air:     { y: 0.95, z: 0.0,    pitch: 0.0,   head: 0.0 },
};

// 各姿勢の足先の位置（モデル座標）。[LF, RF, LH, RH]
function postureFeet(name, pawH, H, airPhase = 0) {
  const F = (x, y, z) => new THREE.Vector3(x, y, z);
  switch (name) {
    case 'sit': return [F(0.034, pawH, 0.08), F(-0.034, pawH, 0.08), F(0.05, pawH, 0.0), F(-0.05, pawH, 0.0)];
    case 'lie': return [F(0.032, pawH, 0.135), F(-0.032, pawH, 0.135), F(0.052, pawH, -0.055), F(-0.052, pawH, -0.055)];
    case 'crouch': return [F(0.038, pawH, 0.115), F(-0.038, pawH, 0.115), F(0.046, pawH, -0.1), F(-0.046, pawH, -0.1)];
    case 'stretch': return [F(0.035, pawH, 0.24), F(-0.035, pawH, 0.24), F(0.042, pawH, -0.11), F(-0.042, pawH, -0.11)];
    case 'air': {
      const a = airPhase;
      const fy = THREE.MathUtils.lerp(0.09, 0.015, a), fz = THREE.MathUtils.lerp(0.19, 0.17, a);
      const hy = THREE.MathUtils.lerp(0.06, 0.05, a), hz = THREE.MathUtils.lerp(-0.22, -0.14, a);
      return [F(0.034, fy, fz), F(-0.034, fy, fz), F(0.04, hy, hz), F(-0.04, hy, hz)];
    }
    default: return [F(0.036, pawH, 0.118), F(-0.036, pawH, 0.118), F(0.042, pawH, -0.118), F(-0.042, pawH, -0.118)];
  }
}

// しっぽの形（関節ごとの [上下, 左右] 回転）
function tailTarget(mode, i, N, t) {
  const k = i / (N - 1);
  switch (mode) {
    case 'up': // 歩行・ごきげん: ピンと立てて先がくるん
      return [i === 0 ? 1.15 : i < 4 ? 0.12 : k > 0.8 ? 0.28 : -0.04, 0.06 * Math.sin(t * 2 - i * 0.5) * k];
    case 'happy':
      return [i === 0 ? 1.25 : i < 4 ? 0.1 : k > 0.8 ? 0.3 : -0.02, 0.05 * Math.sin(t * 16 - i) * k];
    case 'wrap': // 座り・香箱: 体に沿わせる
      return [i === 0 ? -1.05 : i < 3 ? 0.18 : 0.05, i === 0 ? 0.2 : 0.3 + 0.03 * Math.sin(t * 0.8 + i)];
    case 'swish': // イライラ・狩りモード
      return [i === 0 ? -0.35 : 0.06, (0.15 + 0.35 * k) * Math.sin(t * 5.5 - i * 0.45)];
    case 'air':
      return [i === 0 ? 0.3 : -0.02, 0.05 * Math.sin(t * 3 - i * 0.4)];
    case 'down':
      return [i === 0 ? -0.9 : 0.02, 0.05 * Math.sin(t * 1.3 - i * 0.4)];
    default: // relaxed: J字にゆらゆら
      return [i === 0 ? -0.5 : 0.085, (0.1 + 0.12 * k) * Math.sin(t * 1.2 - i * 0.42)];
  }
}

const EYE_OPEN = { open: 1.0, sleepy: 0.42, happy: 0.16, closed: 0.07 };
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class CatMotor {
  constructor(model) {
    this.cmd = {
      speed: 0, turnRate: 0, posture: 'stand', lookAt: null, tail: 'relaxed', eyes: 'open',
      ears: 'normal', airPhase: 0, airPitch: 0, groom: false, headTilt: 0, meowing: 0, pupil: 0.3, wiggle: 0,
    };
    this.phase = 0;
    this.time = 0;
    this.blinkT = 2;
    this.blink = 0;
    this.earTwitch = { t: 3, side: 0, amt: 0 };
    this.rebind(model);
  }

  rebind(model) {
    this.model = model;
    const d = model.dims;
    const p = POSTURES.stand;
    this.cur = {
      y: d.H * p.y, z: 0, pitch: 0, roll: 0, headPitch: 0,
      feet: postureFeet('stand', d.pawH, d.H),
      yaw: 0, lookPitch: 0, tilt: 0, eyeOpen: 1, pupil: 0.3,
      tail: model.tail.map(() => [0, 0]),
      ears: model.ears.map(() => ({ x: 0, z: 0 })),
    };
  }

  update(dt, scale = 1) {
    const { model, cmd, cur } = this;
    const d = model.dims;
    this.time += dt;
    const t = this.time;
    const post = POSTURES[cmd.posture] ?? POSTURES.stand;
    const fast = cmd.posture === 'air' || cmd.posture === 'crouch' ? 14 : 6;

    // ---- 体の姿勢 ----
    let pitchTarget = post.pitch;
    if (cmd.posture === 'air') pitchTarget = cmd.airPitch;
    cur.y = damp(cur.y, d.H * post.y, fast, dt);
    cur.z = damp(cur.z, post.z, fast, dt);
    cur.pitch = damp(cur.pitch, pitchTarget, fast, dt);

    const feetT = postureFeet(cmd.posture, d.pawH, d.H, cmd.airPhase);

    // ---- 歩容（立ち姿勢のときだけ）----
    const sp = Math.abs(cmd.speed) / scale;
    const turning = Math.abs(cmd.turnRate) > 0.4 && sp < 0.05;
    const gaitOn = cmd.posture === 'stand' && (sp > 0.01 || turning);
    this.gaitW = damp(this.gaitW ?? 0, gaitOn ? 1 : 0, 8, dt);
    const trot = THREE.MathUtils.smoothstep(sp, 0.38, 0.6);
    const S = turning ? 0.06 : THREE.MathUtils.clamp(0.16 + 0.3 * sp, 0.14, 0.34);
    const freq = turning ? 1.4 : sp / S;
    this.phase = (this.phase + dt * freq) % 1;
    const beta = THREE.MathUtils.lerp(0.62, 0.5, trot);
    const offs = [
      THREE.MathUtils.lerp(0.25, 0.5, trot), // LF
      THREE.MathUtils.lerp(0.75, 1.0, trot), // RF
      0.0,                                    // LH
      0.5,                                    // RH
    ];
    const Ls = S * beta;
    const lift = 0.03 + 0.02 * trot;
    for (let i = 0; i < 4; i++) {
      const target = feetT[i];
      if (this.gaitW > 0.001) {
        const u = (this.phase + offs[i]) % 1;
        let gz, gy;
        if (u < beta) { gz = Ls * (0.5 - u / beta); gy = 0; }
        else {
          const s = (u - beta) / (1 - beta);
          gz = Ls * (-0.5 + s * s * (3 - 2 * s));
          gy = lift * Math.sin(Math.PI * s);
        }
        if (turning) { target.x += gz * 0.5 * Math.sign(cmd.turnRate) * (i < 2 ? 1 : -1); gz *= 0.3; }
        target.z += gz * this.gaitW;
        target.y += gy * this.gaitW;
      }
      cur.feet[i].x = damp(cur.feet[i].x, target.x, fast + 6, dt);
      cur.feet[i].y = damp(cur.feet[i].y, target.y, fast + 10, dt);
      cur.feet[i].z = damp(cur.feet[i].z, target.z, fast + 10, dt);
    }

    // 毛づくろい: 右前足を口元へ
    if (cmd.groom && cmd.posture === 'sit') {
      const lick = Math.sin(t * 8) * 0.012;
      const g = _v.set(-0.018, 0.255 + lick, 0.17);
      cur.feet[1].lerp(g, 1 - Math.exp(-8 * dt));
    }

    const bob = -0.004 * this.gaitW * (1 - Math.cos(this.phase * Math.PI * 4)) * 0.5;
    const breathe = Math.sin(t * (cmd.posture === 'lie' ? 1.6 : 2.3)) * 0.0018;
    const body = model.body;
    body.position.set(cmd.wiggle || 0, cur.y + bob + breathe, cur.z);
    body.rotation.set(-cur.pitch, 0, 0.02 * this.gaitW * Math.sin(this.phase * Math.PI * 2));
    body.updateMatrix();

    // ---- 脚のIK ----
    _m.copy(body.matrix).invert();
    for (let i = 0; i < 4; i++) this._solveLeg(model.legs[i], _v.copy(cur.feet[i]).applyMatrix4(_m), body.rotation.x);

    // ---- 視線（首と頭で分担）----
    let yawT = 0, pitchT = post.head - cur.pitch, tiltT = cmd.headTilt;
    if (cmd.lookAt) {
      model.root.updateMatrixWorld(true);
      const local = body.worldToLocal(_v.copy(cmd.lookAt));
      local.sub(_v2.set(0, 0.1, 0.18));
      yawT = Math.atan2(local.x, local.z);
      pitchT = Math.atan2(local.y, Math.hypot(local.x, local.z));
      if (Math.abs(yawT) > 1.9) { yawT = 0; pitchT = post.head - cur.pitch; } // 真後ろは見ない
      yawT = THREE.MathUtils.clamp(yawT, -1.2, 1.2);
      pitchT = THREE.MathUtils.clamp(pitchT, -0.7, 0.75);
    }
    if (cmd.groom && cmd.posture === 'sit') { yawT = -0.35; pitchT = -0.45 - cur.pitch * 0.3 + Math.sin(t * 8) * 0.06; tiltT = 0.25; }
    if (cmd.meowing > 0) pitchT += 0.18 * Math.min(1, cmd.meowing * 4);
    cur.yaw = damp(cur.yaw, yawT, 5, dt);
    cur.lookPitch = damp(cur.lookPitch, pitchT, 5, dt);
    cur.tilt = damp(cur.tilt, tiltT, 3, dt);
    model.neck.rotation.set(model.neckTilt - cur.lookPitch * 0.35, cur.yaw * 0.4, 0);
    model.head.rotation.set(-model.neckTilt - cur.lookPitch * 0.65, cur.yaw * 0.6, cur.tilt);
    for (const e of model.eyes) {
      e.pivot.rotation.y = e.baseYaw + THREE.MathUtils.clamp((yawT - cur.yaw) * 0.6, -0.25, 0.25);
    }

    // ---- まばたき・瞳孔 ----
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blink = 0.16; this.blinkT = 2 + Math.random() * 4.5; }
    this.blink = Math.max(0, this.blink - dt);
    const open = EYE_OPEN[cmd.eyes] ?? 1;
    cur.eyeOpen = damp(cur.eyeOpen, open, 10, dt);
    const blinkMul = this.blink > 0 ? Math.abs(Math.cos((this.blink / 0.16) * Math.PI)) * 0.9 + 0.1 : 1;
    for (const e of model.eyes) e.eye.scale.set(1, Math.max(0.07, cur.eyeOpen * blinkMul), 1);
    cur.pupil = damp(cur.pupil, cmd.pupil, 3, dt);
    model.eyeMat.userData.uniforms.uPupil.value = cur.pupil;

    // ---- 耳 ----
    this.earTwitch.t -= dt;
    if (this.earTwitch.t <= 0) {
      this.earTwitch = { t: 2.5 + Math.random() * 6, side: Math.random() < 0.5 ? 0 : 1, amt: 0.22 };
    }
    this.earTwitch.amt = Math.max(0, this.earTwitch.amt - dt * 1.4);
    model.ears.forEach((ear, i) => {
      let tx = ear.base.x, tz = ear.base.z;
      if (cmd.ears === 'back') { tx = -0.7; tz = ear.base.z * 2.1; }
      else if (cmd.ears === 'forward') { tx = 0.08; tz = ear.base.z * 0.6; }
      if (i === this.earTwitch.side) tz += this.earTwitch.amt * ear.side * Math.sin(this.earTwitch.amt * 40);
      cur.ears[i].x = damp(cur.ears[i].x, tx, 10, dt);
      cur.ears[i].z = damp(cur.ears[i].z, tz, 14, dt);
      ear.pivot.rotation.set(cur.ears[i].x, ear.base.y, cur.ears[i].z);
    });

    // ---- しっぽ ----
    const N = model.tail.length;
    let tailMode = cmd.tail;
    if (cmd.posture === 'air') tailMode = 'air';
    model.tail.forEach((j, i) => {
      const [tx, ty] = tailTarget(tailMode, i, N, t);
      const c = cur.tail[i];
      c[0] = damp(c[0], tx, 5, dt);
      c[1] = damp(c[1], ty, 7, dt);
      j.rotation.set(c[0], c[1], 0);
    });
  }

  // 2ボーンIK。関節（肘・かかと）は後ろ向きに曲がる。
  _solveLeg(leg, footLocal, bodyRotX) {
    const { hip, knee, ankle, L1, L2 } = leg;
    const dx = footLocal.x - hip.position.x;
    const dy = footLocal.y - hip.position.y;
    const dz = footLocal.z - hip.position.z;
    const psi = THREE.MathUtils.clamp(Math.atan2(dx, Math.max(-dy, 0.03)), -0.6, 0.6);
    const dyp = -dx * Math.sin(psi) + dy * Math.cos(psi);
    let D = Math.hypot(dyp, dz);
    D = THREE.MathUtils.clamp(D, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-4);
    const theta = Math.atan2(-dz, -dyp);
    const a = Math.acos(THREE.MathUtils.clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
    const k = Math.acos(THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
    hip.rotation.set(theta + a, 0, psi);
    knee.rotation.x = -(Math.PI - k);
    ankle.rotation.x = THREE.MathUtils.clamp(-(bodyRotX + hip.rotation.x + knee.rotation.x), -1.3, 1.3);
  }
}
