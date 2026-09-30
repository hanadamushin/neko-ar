import { toCanvas } from './appearance.js';

// 動画から等間隔にフレームを取り出す（見た目の学習用）
export async function extractFrames(file, { count = 14, maxSide = 512, onProgress = () => {} } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await waitFor(video, 'loadeddata', 15000);
    // iOS Safari は一度再生しないとフレームが描けないことがある
    try { await video.play(); video.pause(); } catch { /* 自動再生不可でも続行 */ }
    let dur = video.duration;
    if (!Number.isFinite(dur)) {
      // 録画アプリ製の webm などは長さが入っていないので、末尾へシークして求める
      await seek(video, 1e7);
      dur = video.duration;
      await seek(video, 0);
    }
    if (!Number.isFinite(dur) || dur <= 0) dur = 10;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / count);
      await seek(video, t);
      frames.push(toCanvas(video, maxSide));
      onProgress((i + 1) / count);
    }
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function waitFor(el, ev, timeout) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('動画を読み込めませんでした')), timeout);
    el.addEventListener(ev, () => { clearTimeout(to); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(to); reject(new Error('この動画形式は読み込めませんでした')); }, { once: true });
  });
}

function seek(v, t) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); resolve(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}
