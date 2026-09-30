// 鳴き声の再生。学習した実際の鳴き声クリップがあればそれを使い（毎回少し高さを変える）、
// ない種類は学習した声の高さ（f0）に合わせて合成する。AR では猫の頭の位置に立体定位する。

export const KIND_LABEL = { meow: 'にゃー', trill: 'くるる', purr: 'ゴロゴロ', hiss: 'シャー' };

export class CatVoice {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.buffers = { meow: [], trill: [], purr: [], hiss: [] };
    this.f0 = 620;
    this.purr = null;
    this._last = {};
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  async setClips(records) {
    this.unlock();
    const next = { meow: [], trill: [], purr: [], hiss: [] };
    const f0s = [];
    for (const r of records) {
      if (r.disabled) continue;
      try {
        const buf = await this.ctx.decodeAudioData(await r.blob.arrayBuffer());
        (next[r.kind] ?? next.meow).push(buf);
        if ((r.kind === 'meow' || r.kind === 'trill') && r.f0 > 150) f0s.push(r.f0);
      } catch (e) {
        console.warn('clip decode failed', e);
      }
    }
    this.buffers = next;
    if (f0s.length) {
      f0s.sort((a, b) => a - b);
      this.f0 = f0s[f0s.length >> 1];
    }
  }

  counts() {
    return Object.fromEntries(Object.entries(this.buffers).map(([k, v]) => [k, v.length]));
  }

  updateListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(px, t, 0.02); l.positionY.setTargetAtTime(py, t, 0.02); l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02); l.forwardY.setTargetAtTime(fy, t, 0.02); l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setTargetAtTime(ux, t, 0.02); l.upY.setTargetAtTime(uy, t, 0.02); l.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _out(pos) {
    const ctx = this.ctx;
    if (!pos) return this.master;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 0.6;
    p.rolloffFactor = 1.1;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.master);
    return p;
  }

  // 鳴く。戻り値は長さ（秒）
  say(kind = 'meow', pos = null) {
    if (!this.enabled) return 0;
    this.unlock();
    if (kind === 'purr') return this.startPurr(pos, 3.5);
    const bufs = this.buffers[kind];
    const out = this._out(pos);
    if (bufs?.length) {
      // 同じクリップが続かないように
      let i = (Math.random() * bufs.length) | 0;
      if (bufs.length > 1 && i === this._last[kind]) i = (i + 1) % bufs.length;
      this._last[kind] = i;
      const src = this.ctx.createBufferSource();
      src.buffer = bufs[i];
      src.playbackRate.value = 0.93 + Math.random() * 0.14;
      const g = this.ctx.createGain();
      g.gain.value = 1.0;
      src.connect(g).connect(out);
      src.start();
      return bufs[i].duration / src.playbackRate.value;
    }
    const when = this.ctx.currentTime + 0.01;
    if (kind === 'hiss') return this._synthHiss(out, when);
    if (kind === 'trill') return this._synthMeow(out, when, { dur: 0.28, trill: true });
    return this._synthMeow(out, when, {});
  }

  _synthMeow(dest, when, { dur = 0.5 + Math.random() * 0.4, trill = false }) {
    const ctx = this.ctx;
    const f0 = this.f0 * (0.92 + Math.random() * 0.16);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f = osc.frequency;
    if (trill) {
      f.setValueAtTime(f0 * 0.85, when);
      f.exponentialRampToValueAtTime(f0 * 1.25, when + dur);
    } else {
      f.setValueAtTime(f0 * 0.8, when);
      f.linearRampToValueAtTime(f0 * 1.12, when + dur * 0.32);
      f.linearRampToValueAtTime(f0 * 1.04, when + dur * 0.58);
      f.exponentialRampToValueAtTime(f0 * 0.66, when + dur);
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = trill ? 28 : 5.5;
    const lfoG = ctx.createGain();
    lfoG.gain.value = trill ? f0 * 0.05 : f0 * 0.015;
    lfo.connect(lfoG).connect(f);

    // 「み・あ・う」と口の形が変わるフォルマント
    const sum = ctx.createGain();
    const formants = trill
      ? [[500, 700, 700, 1], [1600, 1700, 1700, 0.5], [2800, 2900, 2900, 0.2]]
      : [[380, 950, 520, 1], [2300, 1500, 950, 0.55], [3100, 2700, 2500, 0.22]];
    for (const [a, b, c, gain] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 5;
      bp.frequency.setValueAtTime(a, when);
      bp.frequency.linearRampToValueAtTime(b, when + dur * 0.38);
      bp.frequency.linearRampToValueAtTime(c, when + dur);
      const g = ctx.createGain();
      g.gain.value = gain * 3.2;
      osc.connect(bp).connect(g).connect(sum);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.55, when + 0.05);
    env.gain.setValueAtTime(0.55, when + dur * 0.62);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    if (trill) {
      const am = ctx.createOscillator();
      am.frequency.value = 26;
      const amG = ctx.createGain();
      amG.gain.value = 0.35;
      const bias = ctx.createGain();
      bias.gain.value = 0.65;
      sum.connect(bias).connect(env);
      am.connect(amG).connect(bias.gain);
      am.start(when); am.stop(when + dur + 0.05);
    } else {
      sum.connect(env);
    }
    env.connect(dest);
    osc.start(when); osc.stop(when + dur + 0.05);
    lfo.start(when); lfo.stop(when + dur + 0.05);
    return dur;
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _synthHiss(dest, when) {
    const ctx = this.ctx;
    const dur = 0.9;
    const src = ctx.createBufferSource();
    src.buffer = this._noise(dur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2200;
    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking'; pk.frequency.value = 5200; pk.gain.value = 8; pk.Q.value = 1.2;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.5, when + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(hp).connect(pk).connect(env).connect(dest);
    src.start(when);
    return dur;
  }

  // ゴロゴロ（なでている間ループ）
  startPurr(pos = null, seconds = 0) {
    if (!this.enabled) return 0;
    this.unlock();
    const ctx = this.ctx;
    if (!this.purr) {
      const out = this._out(pos);
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(out);
      let src;
      const bufs = this.buffers.purr;
      if (bufs.length) {
        src = ctx.createBufferSource();
        src.buffer = bufs[(Math.random() * bufs.length) | 0];
        src.loop = true;
        src.connect(g);
      } else {
        src = ctx.createBufferSource();
        src.buffer = this._noise(2);
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 2;
        const am = ctx.createGain();
        am.gain.value = 0.5;
        const lfo = ctx.createOscillator();
        lfo.type = 'triangle';
        lfo.frequency.value = 25;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 0.5;
        lfo.connect(lfoG).connect(am.gain);
        // 吸う・吐くのゆっくりした揺れ
        const breath = ctx.createOscillator();
        breath.frequency.value = 0.8;
        const breathG = ctx.createGain();
        breathG.gain.value = 0.25;
        const level = ctx.createGain();
        level.gain.value = 1.6;
        breath.connect(breathG).connect(level.gain);
        src.connect(lp).connect(am).connect(level).connect(g);
        lfo.start(); breath.start();
        src._extra = [lfo, breath];
      }
      src.start();
      g.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.4);
      this.purr = { src, g, out };
    }
    clearTimeout(this.purrTimer);
    if (seconds > 0) this.purrTimer = setTimeout(() => this.stopPurr(), seconds * 1000);
    return seconds;
  }

  movePurr(pos) {
    const p = this.purr?.out;
    if (!p || !p.positionX || !pos) return;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
  }

  stopPurr() {
    if (!this.purr) return;
    const { src, g } = this.purr;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.stop(t + 0.55);
    src._extra?.forEach((o) => o.stop(t + 0.55));
    this.purr = null;
  }
}
