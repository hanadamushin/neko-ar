import * as THREE from 'three';

// 行動系。SurfaceMap（床・机などの面）を見て、歩く／座る／毛づくろい／高い所へ飛び乗る／
// ユーザーに近寄る／なでられて喉を鳴らす、などを決める。
// 結果は motor.cmd と猫の root の位置・向きとして出力する。

const rand = (a, b) => a + Math.random() * (b - a);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const pick = (weights) => {
  let s = 0;
  for (const w of Object.values(weights)) s += Math.max(0, w);
  let r = Math.random() * s;
  for (const [k, w] of Object.entries(weights)) { r -= Math.max(0, w); if (r <= 0) return k; }
  return Object.keys(weights)[0];
};

export class CatBrain {
  constructor({ model, motor, voice, map }) {
    this.model = model;
    this.motor = motor;
    this.voice = voice;
    this.map = map;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.level = null;
    this.spawned = false;
    this.queue = [];
    this.task = null;
    this.time = 0;
    this.scale = 1;
    this.energy = rand(0.5, 1);
    this.affection = 0.5;
    this.levelSince = 0;
    this.lastMeow = -10;
    this.interest = null;      // 新しく見つけた面（行ってみたい）
    this.visited = new Set();
    this.onEvent = null;       // (type, info) => void  UI への通知
    this.camPos = new THREE.Vector3(0, 1.4, 1);
  }

  setMap(map) {
    this.map = map;
    this.level = null;
    this.spawned = false;
    this.queue = [];
    this.task = null;
    this.visited.clear();
  }

  spawn(point, level) {
    this.level = level;
    this.pos.set(point.x, level ? level.y : point.y, point.z);
    this.yaw = Math.atan2(this.camPos.x - point.x, this.camPos.z - point.z);
    this.spawned = true;
    this.levelSince = this.time;
    if (level) this.visited.add(level.id);
    this.queue = [];
    this.task = null;
    this._push(this._idle(1.2, 'stand', { look: 'user' }));
    this._push(this._meow('meow'));
    this._applyRoot();
  }

  // ---------- 外部からのきっかけ ----------
  notifySurface(level) {
    if (!this.level || level === this.level) return;
    const rel = level.y - this.level.y;
    if (Math.abs(rel) > 0.15 && !this.visited.has(level.id)) this.interest = level;
  }

  pet() {
    if (!this.spawned || this.airborne) return;
    this.affection = Math.min(1, this.affection + 0.15);
    this.queue = [];
    this._setTask(this._petted());
  }

  callTo(point, level) {
    if (!this.spawned || this.airborne) return false;
    level = this.map.resolve(level) ?? level;
    this.queue = [];
    if (level === this.level || !level) {
      const path = this.map.findPath(this.level, this.pos, point);
      if (!path) return false;
      this._setTask(this._walk(path, 0.62, 'come'));
      this._push(this._idle(1.5, 'sit', { look: 'user' }));
      return true;
    }
    const plan = this.map.planRoute(this.level, this.pos, level);
    if (!plan) return false;
    this._setTask(this._goRoute(plan, 0.55));
    const after = this.map.findPath(level, plan[plan.length - 1].landing, point);
    if (after) this._push(this._walk(after, 0.4));
    this._push(this._idle(1.5, 'sit', { look: 'user' }));
    return true;
  }

  callToUser() {
    if (!this.spawned || !this.level) return false;
    const target = this._userSpot(0.45);
    const floor = this.map.floor();
    // 高い所にいる時は床に降りてくる
    if (floor && floor !== this.level && this.level.y - floor.y > 0.2) {
      return this.callTo(target, floor);
    }
    const ok = this.callTo(target, this.level);
    if (ok) this._push(this._meow('meow'));
    return ok;
  }

  // ---------- 毎フレーム ----------
  update(dt, ctx) {
    this.time += dt;
    if (ctx?.camPos) this.camPos.copy(ctx.camPos);
    const cmd = this.motor.cmd;
    if (!this.spawned) return;

    // 今いる面の高さ推定が更新されたら追従
    if (this.level) {
      const L = this.map.resolve(this.level);
      if (L) this.level = L;
      if (!this.airborne) this.pos.y += (this.level.y - this.pos.y) * Math.min(1, dt * 4);
    }

    if (!this.task) this._setTask(this.queue.shift() ?? this._decide());
    const done = this.task.update(dt);
    if (done) this.task = null;

    cmd.meowing = Math.max(0, cmd.meowing - dt);
    this.energy = Math.max(0, this.energy - dt * 0.004);
    this._applyRoot();
  }

  _applyRoot() {
    const r = this.model.root;
    r.position.copy(this.pos);
    r.rotation.set(0, this.yaw, 0);
  }

  _setTask(t) {
    this.task = t;
    t.start?.();
  }

  _push(t) { if (t) this.queue.push(t); }

  _userSpot(dist) {
    const d = new THREE.Vector3(this.camPos.x - this.pos.x, 0, this.camPos.z - this.pos.z);
    const len = d.length();
    if (len < 1e-3) return this.pos.clone();
    const target = new THREE.Vector3(this.camPos.x, this.pos.y, this.camPos.z).addScaledVector(d.normalize(), -dist);
    return target;
  }

  // ユーザーの方へ向き直る（足踏みしながら）。向き直り中なら true
  _faceUser(dt, threshold, posture) {
    const cmd = this.motor.cmd;
    const want = Math.atan2(this.camPos.x - this.pos.x, this.camPos.z - this.pos.z);
    const err = wrapAngle(want - this.yaw);
    if (!this._turning && Math.abs(err) < threshold) return false;
    this._turning = Math.abs(err) > 0.25;
    if (!this._turning) { cmd.turnRate = 0; cmd.posture = posture; return false; }
    const turn = THREE.MathUtils.clamp(err, -2.2 * dt, 2.2 * dt);
    this.yaw = wrapAngle(this.yaw + turn);
    cmd.posture = 'stand';
    cmd.turnRate = turn / Math.max(dt, 1e-3);
    return true;
  }

  _userDist() {
    return Math.hypot(this.camPos.x - this.pos.x, this.camPos.z - this.pos.z);
  }

  // ---------- 次の行動を決める ----------
  _decide() {
    const map = this.map;
    const L = this.level;
    if (!L) return this._idle(2, 'stand', { look: 'user' });
    const floor = map.floor();
    const onHigh = floor && L && L !== floor && L.y - floor.y > 0.2;
    const onLevelFor = this.time - this.levelSince;
    const userNear = this._userDist() < 3.5;

    // 近くの高い面（机など）
    const highs = map.significant().filter((o) => L && o !== L && o.y - L.y > 0.15 && o.y - L.y < 1.3);

    const w = {
      wander: 3,
      sit: 2,
      loaf: this.energy < 0.4 ? 2.5 : 0.8,
      groom: 1.2,
      stretch: 0.4,
      approach: userNear ? 1.2 + this.affection : 0.2,
      meow: 0.6,
      lookAround: 1.2,
      jumpUp: highs.length ? (this.interest ? 6 : 1.4) : 0,
      jumpDown: onHigh ? (onLevelFor > 25 ? 3 : 0.5) : 0,
    };
    if (this.interest && !map.resolve(this.interest)) this.interest = null;

    const choice = pick(w);
    switch (choice) {
      case 'wander': {
        const t = map.randomTarget(L, this.pos, 0.3, onHigh ? 0.8 : 1.8);
        if (!t) return this._idle(rand(2, 4), 'stand', { look: 'around' });
        return this._walk(t.path, rand(0.18, 0.3));
      }
      case 'sit': return this._idle(rand(4, 9), 'sit', { look: 'user' });
      case 'loaf': {
        this.energy = Math.min(1, this.energy + 0.4);
        this._push(this._idle(rand(1.5, 2.5), 'stand', { look: 'around' }));
        this._push(this._stretch());
        return this._idle(rand(8, 16), 'lie', { look: 'user', eyes: 'sleepy' });
      }
      case 'groom': return this._groom(rand(3, 6));
      case 'stretch': return this._stretch();
      case 'approach': {
        const spot = this._userSpot(0.5);
        const path = map.findPath(L, this.pos, spot);
        if (!path || map.pathLength(path) < 0.25) return this._idle(3, 'sit', { look: 'user' });
        this._push(this._meow(Math.random() < 0.3 ? 'trill' : 'meow'));
        this._push(this._idle(rand(3, 6), 'sit', { look: 'user' }));
        return this._walk(path, rand(0.3, 0.45));
      }
      case 'meow': return this._meow('meow');
      case 'lookAround': return this._idle(rand(2, 4), 'stand', { look: 'around' });
      case 'jumpUp': {
        const target = this.interest && highs.includes(map.resolve(this.interest)) ? map.resolve(this.interest) : highs[(Math.random() * highs.length) | 0];
        const plan = map.planRoute(L, this.pos, target);
        if (!plan) {
          if (this.interest) this.onEvent?.('noRoute', { level: target });
          this.interest = null;
          return this._idle(2, 'stand', { look: 'around' });
        }
        this.interest = null;
        this._push(this._idle(rand(2, 4), 'sit', { look: 'user' }));
        return this._goRoute(plan, 0.3);
      }
      case 'jumpDown': {
        const lows = map.significant().filter((o) => o !== L && o.y < L.y - 0.15);
        lows.sort((a, b) => b.cells.size - a.cells.size);
        for (const low of lows) {
          const plan = map.planRoute(L, this.pos, low);
          if (plan) return this._goRoute(plan, 0.3);
        }
        return this._idle(3, 'sit', { look: 'around' });
      }
      default: return this._idle(2, 'stand', {});
    }
  }

  // ---------- タスク ----------
  _lookTarget(mode) {
    if (mode === 'user') return this.camPos.clone();
    if (mode === 'around') {
      const a = this.yaw + rand(-1.1, 1.1);
      return new THREE.Vector3(this.pos.x + Math.sin(a) * 1.5, this.pos.y + rand(0, 0.6), this.pos.z + Math.cos(a) * 1.5);
    }
    return null;
  }

  _idle(duration, posture = 'stand', { look = null, eyes = 'open', tail = null } = {}) {
    const self = this;
    let t = 0, lookT = 0, target = null;
    return {
      kind: 'idle',
      start() {
        const cmd = self.motor.cmd;
        cmd.speed = 0; cmd.turnRate = 0; cmd.posture = posture; cmd.groom = false;
        self._turning = false;
        cmd.eyes = eyes; cmd.ears = 'normal'; cmd.pupil = 0.3;
        cmd.tail = tail ?? (posture === 'sit' || posture === 'lie' ? 'wrap' : 'relaxed');
      },
      update(dt) {
        t += dt;
        lookT -= dt;
        if (lookT <= 0) {
          lookT = rand(1.5, 3.5);
          // user 指定でも、ずっと見つめ続けず時々よそ見する
          const mode = look === 'user' ? (Math.random() < 0.72 ? 'user' : 'around') : look;
          target = self._lookTarget(mode);
          self._lookMode = mode;
          if (posture === 'lie' && Math.random() < 0.4) self.motor.cmd.eyes = Math.random() < 0.5 ? 'sleepy' : 'closed';
        }
        if (self._lookMode === 'user') {
          target = self.camPos;
          if (posture !== 'lie' && self._faceUser(dt, 1.4, posture)) t -= dt * 0.5;
        }
        self.motor.cmd.lookAt = target;
        // ユーザーがとても近くに来たら見上げる
        return t >= duration;
      },
    };
  }

  _walk(path, speed = 0.25, mode = 'walk') {
    const self = this;
    let i = 1, stuck = 0, cur = 0;
    return {
      kind: 'walk',
      start() {
        const cmd = self.motor.cmd;
        cmd.posture = 'stand'; cmd.groom = false; cmd.eyes = 'open'; cmd.ears = 'normal';
        cmd.tail = mode === 'come' ? 'happy' : 'up';
        cmd.pupil = mode === 'come' ? 0.45 : 0.3;
      },
      update(dt) {
        const cmd = self.motor.cmd;
        if (i >= path.length) { cmd.speed = 0; cmd.turnRate = 0; return true; }
        const wp = path[i];
        const dx = wp.x - self.pos.x, dz = wp.z - self.pos.z;
        const dist = Math.hypot(dx, dz);
        const last = i === path.length - 1;
        if (dist < (last ? 0.04 : 0.1)) { i++; return false; }
        const want = Math.atan2(dx, dz);
        const err = wrapAngle(want - self.yaw);
        const maxTurn = 3.2 * dt;
        const turn = THREE.MathUtils.clamp(err, -maxTurn, maxTurn);
        self.yaw = wrapAngle(self.yaw + turn);
        // 向きがずれている時は減速、ゴール手前で減速
        const align = Math.max(0, Math.cos(err));
        const brake = last ? THREE.MathUtils.clamp(dist / 0.25, 0.25, 1) : 1;
        const target = speed * align * align * brake;
        cur += (target - cur) * Math.min(1, dt * 4);
        cmd.speed = cur;
        cmd.turnRate = turn / Math.max(dt, 1e-3);
        const step = cur * dt;
        const nx = self.pos.x + Math.sin(self.yaw) * step;
        const nz = self.pos.z + Math.cos(self.yaw) * step;
        if (self.map.isWalkable(self.level, nx, nz) || !self.map.isWalkable(self.level, self.pos.x, self.pos.z)) {
          self.pos.x = nx; self.pos.z = nz; stuck = 0;
        } else if ((stuck += dt) > 1.5) { cmd.speed = 0; return true; }
        // 進行方向の少し先を見る
        cmd.lookAt = new THREE.Vector3(self.pos.x + Math.sin(self.yaw) * 1.2, self.pos.y + 0.1, self.pos.z + Math.cos(self.yaw) * 1.2);
        return false;
      },
    };
  }

  _turnTo(point, then = null) {
    const self = this;
    return {
      kind: 'turn',
      start() { self.motor.cmd.posture = 'stand'; self.motor.cmd.speed = 0; },
      update(dt) {
        const want = Math.atan2(point.x - self.pos.x, point.z - self.pos.z);
        const err = wrapAngle(want - self.yaw);
        const turn = THREE.MathUtils.clamp(err, -2.5 * dt, 2.5 * dt);
        self.yaw = wrapAngle(self.yaw + turn);
        self.motor.cmd.turnRate = turn / Math.max(dt, 1e-3);
        self.motor.cmd.lookAt = point;
        if (Math.abs(err) < 0.06) { self.motor.cmd.turnRate = 0; return true; }
        return false;
      },
    };
  }

  // 踏み切り点まで歩く → 向き直る → ジャンプ、を経路の区間ごとに
  _goRoute(plan, speed) {
    const self = this;
    const steps = [];
    let k = 0;
    return {
      kind: 'route',
      start() {
        for (const seg of plan) {
          steps.push(() => {
            const L = self.map.resolve(self.level) ?? self.level;
            const path = self.map.findPath(L, self.pos, seg.takeoff) ?? [self.pos.clone(), seg.takeoff];
            return self._walk(path, speed);
          });
          steps.push(() => self._turnTo(seg.landing));
          steps.push(() => self._jump(seg.landing, seg.to));
        }
        this.cur = steps[0]();
        this.cur.start?.();
      },
      update(dt) {
        if (this.cur.update(dt)) {
          k++;
          if (k >= steps.length) return true;
          this.cur = steps[k]();
          this.cur.start?.();
        }
        return false;
      },
    };
  }

  _jump(landing, toLevel) {
    const self = this;
    let phase = 'prep', t = 0;
    const start = new THREE.Vector3();
    const end = landing.clone();
    let prepDur = rand(0.55, 1.0), air = 0.5, arc = 0.15;
    return {
      kind: 'jump',
      start() {
        start.copy(self.pos);
        const dh = end.y - start.y;
        const hd = Math.hypot(end.x - start.x, end.z - start.z);
        air = 0.28 + 0.2 * Math.sqrt(Math.abs(dh) + hd);
        arc = dh > 0 ? 0.1 + dh * 0.3 : 0.06 + hd * 0.1;
        const cmd = self.motor.cmd;
        cmd.speed = 0; cmd.turnRate = 0; cmd.posture = 'crouch'; cmd.tail = 'swish'; cmd.ears = 'forward'; cmd.pupil = 0.62;
        cmd.lookAt = end.clone().add(new THREE.Vector3(0, 0.05, 0));
        self.onEvent?.('jump', { up: dh > 0, height: Math.abs(dh), level: toLevel });
      },
      update(dt) {
        const cmd = self.motor.cmd;
        t += dt;
        if (phase === 'prep') {
          // お尻ふりふり
          cmd.headTilt = 0;
          cmd.wiggle = Math.sin(t * 22) * 0.005 * Math.min(1, t * 3);
          if (t >= prepDur) { phase = 'air'; t = 0; cmd.wiggle = 0; self.airborne = true; }
          return false;
        }
        if (phase === 'air') {
          const s = Math.min(1, t / air);
          const y0 = start.y, y1 = end.y;
          self.pos.x = THREE.MathUtils.lerp(start.x, end.x, s);
          self.pos.z = THREE.MathUtils.lerp(start.z, end.z, s);
          self.pos.y = THREE.MathUtils.lerp(y0, y1, s) + arc * 4 * s * (1 - s);
          const vy = (y1 - y0) + arc * 4 * (1 - 2 * s);
          const vh = Math.hypot(end.x - start.x, end.z - start.z) + 1e-3;
          cmd.posture = 'air';
          cmd.airPhase = s;
          cmd.airPitch = THREE.MathUtils.clamp(Math.atan2(vy, vh) * 0.7, -0.6, 0.7);
          cmd.tail = 'air';
          if (s >= 1) { phase = 'land'; t = 0; self.airborne = false; self.level = toLevel; self.levelSince = self.time; self.visited.add(toLevel.id); cmd.posture = 'crouch'; }
          return false;
        }
        if (phase === 'land') {
          cmd.pupil = 0.35;
          if (t > 0.35) { cmd.posture = 'stand'; cmd.tail = 'up'; cmd.ears = 'normal'; return true; }
        }
        return false;
      },
    };
  }

  _groom(duration) {
    const self = this;
    let t = 0;
    return {
      kind: 'groom',
      start() {
        const cmd = self.motor.cmd;
        cmd.speed = 0; cmd.posture = 'sit'; cmd.tail = 'wrap'; cmd.eyes = 'happy'; cmd.lookAt = null;
      },
      update(dt) {
        t += dt;
        const cmd = self.motor.cmd;
        cmd.groom = t > 0.8 && t < duration - 0.3;
        cmd.lookAt = null;
        if (t >= duration) { cmd.groom = false; cmd.eyes = 'open'; return true; }
        return false;
      },
    };
  }

  _stretch() {
    const self = this;
    let t = 0;
    return {
      kind: 'stretch',
      start() { const c = self.motor.cmd; c.speed = 0; c.posture = 'stretch'; c.eyes = 'happy'; c.tail = 'up'; c.lookAt = null; },
      update(dt) {
        t += dt;
        if (t > 2.2) { self.motor.cmd.posture = 'stand'; self.motor.cmd.eyes = 'open'; return true; }
        return false;
      },
    };
  }

  _meow(kind) {
    const self = this;
    let t = 0, dur = 0.6;
    return {
      kind: 'meow',
      start() {
        const cmd = self.motor.cmd;
        cmd.speed = 0;
        cmd.lookAt = self.camPos.clone();
        if (self.time - self.lastMeow > 1.5) {
          dur = Math.max(0.4, self.voice?.say(kind, self.model.headWorldPosition()) || 0.6);
          self.lastMeow = self.time;
          cmd.meowing = dur;
          self.onEvent?.('meow', { kind });
        }
      },
      update(dt) {
        t += dt;
        self.motor.cmd.lookAt = self.camPos;
        return t > dur + 0.3;
      },
    };
  }

  _petted() {
    const self = this;
    let t = 0;
    const dur = rand(3, 4.5);
    return {
      kind: 'petted',
      start() {
        const cmd = self.motor.cmd;
        cmd.speed = 0; cmd.turnRate = 0;
        cmd.posture = self.affection > 0.8 && Math.random() < 0.5 ? 'lie' : cmd.posture === 'lie' ? 'lie' : 'sit';
        self._turning = false;
        cmd.eyes = 'happy'; cmd.tail = 'happy'; cmd.ears = 'normal'; cmd.headTilt = rand(-0.3, 0.3);
        self.voice?.startPurr(self.model.headWorldPosition(), dur);
        self.onEvent?.('pet', {});
      },
      update(dt) {
        t += dt;
        const cmd = self.motor.cmd;
        cmd.lookAt = self.camPos;
        if (cmd.posture !== 'lie') self._faceUser(dt, 0.9, 'sit');
        self.voice?.movePurr(self.model.headWorldPosition());
        if (t >= dur) { cmd.headTilt = 0; cmd.eyes = 'open'; return true; }
        return false;
      },
    };
  }
}
