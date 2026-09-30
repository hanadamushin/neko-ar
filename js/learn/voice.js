import { loadAudioClassifier } from './models.js';

// 動画・音声ファイルから猫の鳴き声だけを切り出す。
//  1. 音声トラックをデコードしてモノラル化
//  2. 音量（短時間エネルギー）で「音が鳴っている区間」を検出
//  3. YAMNet（AudioSet）で各区間が Meow / Purr / Hiss / Cat かを判定し、人の声や雑音を除外
//  4. ピッチ（f0）を推定して、にゃー／くるる（短く上がる）を分け、合成音声の高さ学習にも使う
//  5. 元のサンプリング周波数のまま WAV に書き出して保存

const SR = 16000;

export async function extractVoice(file, { onProgress = () => {} } = {}) {
  onProgress(0.03, '音声を読み込み中…');
  const ab = await file.arrayBuffer();
  let audio;
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    audio = await new AC(1, 1, 44100).decodeAudioData(ab);
  } catch {
    throw new Error('このファイルの音声を読み込めませんでした（mp4 / mov / webm / m4a / mp3 / wav をお試しください）');
  }
  const mono = mixDown(audio);
  const sr0 = audio.sampleRate;

  onProgress(0.12, '解析用に変換中…');
  const x = await resample(mono, sr0, SR);

  onProgress(0.2, '音の区間を探しています…');
  const segs = detectSegments(x, SR);

  let timeline = null;
  if (segs.length) {
    try {
      onProgress(0.3, '音声分類モデルを読み込み中…（初回のみ約4MB）');
      const clf = await loadAudioClassifier();
      onProgress(0.5, '猫の声かどうかを判定中…');
      await new Promise((r) => setTimeout(r, 0));
      timeline = classifyTimeline(clf, x);
    } catch (e) {
      console.warn('YAMNet unavailable; falling back to pitch heuristics', e);
    }
  }

  onProgress(0.75, '鳴き声を切り出しています…');
  const clips = [];
  for (const seg of segs) {
    const pitch = estimatePitch(x, SR, seg.start, seg.end);
    let kind = 'meow', score;
    if (timeline) {
      const s = aggregate(timeline, seg.start, seg.end);
      score = Math.max(s.cat, s.meow, s.purr, s.hiss, s.caterwaul);
      if (score < 0.12) continue;
      const cand = { meow: s.meow + s.caterwaul * 0.8 + s.cat * 0.3, purr: s.purr, hiss: s.hiss };
      kind = Object.entries(cand).sort((a, b) => b[1] - a[1])[0][0];
    } else {
      // 分類モデルなし: 猫の声らしい高さで有声なら採用
      if (pitch.voiced < 0.3 || pitch.median < 220 || pitch.median > 1600) continue;
      score = pitch.voiced * 0.5;
    }
    const dur = seg.end - seg.start;
    if (kind === 'meow' && dur < 0.5 && pitch.slope > 40) kind = 'trill';
    clips.push({ kind, start: seg.start, end: seg.end, f0: Math.round(pitch.median || 0), score });
  }
  clips.sort((a, b) => b.score - a.score);
  const keep = clips.slice(0, 20).sort((a, b) => a.start - b.start);

  const stamp = Date.now();
  const out = keep.map((c, i) => {
    const pcm = cut(mono, sr0, c.start - 0.03, c.end + 0.06);
    return {
      id: `${stamp}-${i}`,
      kind: c.kind,
      start: +c.start.toFixed(2),
      duration: +(pcm.length / sr0).toFixed(2),
      f0: c.f0,
      score: +c.score.toFixed(3),
      source: file.name,
      peaks: peaks(pcm, 48),
      blob: encodeWav(pcm, sr0),
    };
  });
  onProgress(1, '完了');
  return { clips: out, candidates: segs.length, usedClassifier: !!timeline, duration: audio.duration };
}

function mixDown(buf) {
  const n = buf.length, ch = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

async function resample(x, from, to) {
  if (from === to) return x;
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const len = Math.ceil((x.length * to) / from);
  const ctx = new AC(1, len, to);
  const b = ctx.createBuffer(1, x.length, from);
  b.getChannelData(0).set(x);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start();
  const r = await ctx.startRendering();
  return r.getChannelData(0).slice();
}

// 音量のヒステリシスしきい値で「鳴っている区間」を取り出す
function detectSegments(x, sr) {
  const hop = Math.round(sr * 0.01), win = Math.round(sr * 0.025);
  const nF = Math.max(0, Math.floor((x.length - win) / hop));
  if (nF < 10) return [];
  const db = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < win; i++) s += x[o + i] * x[o + i];
    db[f] = 10 * Math.log10(s / win + 1e-10);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(nF * 0.2)];
  const peak = sorted[Math.floor(nF * 0.995)];
  if (peak - floor < 10) return [];
  const hi = floor + Math.max(9, 0.45 * (peak - floor));
  const lo = floor + Math.max(6, 0.28 * (peak - floor));
  const segs = [];
  let f = 0;
  while (f < nF) {
    if (db[f] > hi) {
      let a = f, b = f;
      while (a > 0 && db[a - 1] > lo) a--;
      while (b < nF - 1 && db[b + 1] > lo) b++;
      segs.push([a, b]);
      f = b + 1;
    } else f++;
  }
  // 近い区間をつなぐ
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && (s[0] - last[1]) * 0.01 < 0.12) last[1] = s[1];
    else merged.push([...s]);
  }
  return merged
    .map(([a, b]) => ({ start: (a * hop) / sr, end: Math.min((b * hop + win) / sr, (a * hop) / sr + 4.5) }))
    .filter((s) => s.end - s.start >= 0.15);
}

const CLASS_KEYS = { cat: 'cat', meow: 'meow', purr: 'purr', hiss: 'hiss', caterwaul: 'caterwaul' };

function classifyTimeline(clf, x) {
  const results = clf.classify(x, SR);
  return results.map((r, i) => {
    const t0 = (r.timestampMs ?? i * 975) / 1000;
    const row = { t0, t1: t0 + 0.975, cat: 0, meow: 0, purr: 0, hiss: 0, caterwaul: 0 };
    for (const c of r.classifications?.[0]?.categories ?? []) {
      const k = CLASS_KEYS[(c.categoryName || '').toLowerCase()];
      if (k) row[k] = c.score;
    }
    return row;
  });
}

function aggregate(timeline, a, b) {
  const s = { cat: 0, meow: 0, purr: 0, hiss: 0, caterwaul: 0 };
  for (const r of timeline) {
    if (r.t1 < a - 0.1 || r.t0 > b + 0.1) continue;
    for (const k in s) s[k] = Math.max(s[k], r[k]);
  }
  return s;
}

// 自己相関によるピッチ推定
function estimatePitch(x, sr, a, b) {
  const frame = Math.round(sr * 0.04), hop = Math.round(sr * 0.02);
  const minLag = Math.floor(sr / 1600), maxLag = Math.ceil(sr / 180);
  const f0s = [];
  let frames = 0;
  for (let o = Math.floor(a * sr); o + frame + maxLag < Math.min(x.length, b * sr); o += hop) {
    frames++;
    let e0 = 0;
    for (let i = 0; i < frame; i++) e0 += x[o + i] * x[o + i];
    if (e0 < 1e-6) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0, e1 = 0;
      for (let i = 0; i < frame; i++) { s += x[o + i] * x[o + i + lag]; e1 += x[o + i + lag] * x[o + i + lag]; }
      const r = s / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.55) f0s.push({ t: o / sr, f: sr / bestLag });
  }
  if (!f0s.length) return { median: 0, voiced: 0, slope: 0 };
  const fs = f0s.map((p) => p.f).sort((p, q) => p - q);
  const third = Math.max(1, Math.floor(f0s.length / 3));
  const med = (arr) => { const s = arr.map((p) => p.f).sort((p, q) => p - q); return s[s.length >> 1]; };
  return {
    median: fs[fs.length >> 1],
    voiced: f0s.length / Math.max(1, frames),
    slope: med(f0s.slice(-third)) - med(f0s.slice(0, third)),
  };
}

function cut(x, sr, a, b) {
  const s = Math.max(0, Math.floor(a * sr)), e = Math.min(x.length, Math.ceil(b * sr));
  const out = x.slice(s, e);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? Math.min(8, 0.9 / peak) : 1;
  const fade = Math.round(sr * 0.015);
  for (let i = 0; i < out.length; i++) {
    let g = gain;
    if (i < fade) g *= i / fade;
    if (i > out.length - fade) g *= (out.length - i) / fade;
    out[i] *= g;
  }
  return out;
}

function peaks(x, n) {
  const out = [];
  const step = Math.max(1, Math.floor(x.length / n));
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(x.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(x[j]));
    out.push(+m.toFixed(3));
  }
  return out;
}

function encodeWav(x, sr) {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
