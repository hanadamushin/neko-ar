import { rgbToLab, labToHex, kmeans, mergeClusters, chroma, hueDeg, adjustLab } from './color.js';
import { loadVision } from './models.js';
import { normalizeAppearance } from '../cat/appearance.js';

// 写真（または動画のフレーム）から猫の見た目パラメータを推定する。
//  1. DeepLab v3 で猫の領域を切り出す
//  2. 領域内の画素を CIELAB で k-means → 毛色パレット
//  3. 画像分類（tabby / Siamese / Persian など）と縞の強さ（局所コントラスト）で柄を判定
//  4. 白の割合と位置から「白ぶち」の量と顔の白を推定
// 複数枚あれば全画像の画素をまとめて学習するので、角度違いの写真が多いほど安定する。

const MAX_SIDE = 384;

export async function fileToBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

export function toCanvas(src, maxSide = MAX_SIDE) {
  const w0 = src.naturalWidth || src.videoWidth || src.width;
  const h0 = src.naturalHeight || src.videoHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * s));
  c.height = Math.max(1, Math.round(h0 * s));
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export async function analyzeImages(sources, { onProgress = () => {}, base = {} } = {}) {
  let vision = null;
  onProgress(0.02, '解析モデルを読み込み中…（初回のみ数MB）');
  try { vision = await loadVision(); }
  catch (e) { console.warn('vision models unavailable, using fallback', e); }

  const per = [];
  for (let i = 0; i < sources.length; i++) {
    onProgress(0.1 + (0.75 * i) / sources.length, `画像を解析中 ${i + 1}/${sources.length}`);
    await new Promise((r) => setTimeout(r, 0));
    const cv = toCanvas(sources[i]);
    per.push(analyzeOne(vision, cv));
  }

  // 猫が見つかった画像を優先
  const found = per.filter((p) => p.found && p.area > 0.03);
  const use = found.length ? found : per;
  onProgress(0.9, '毛色を学習中…');

  // 画像ごとの画素数をそろえて結合
  const perCap = Math.floor(24000 / Math.max(1, use.length));
  const parts = use.map((p) => subsample(p.samples, perCap));
  const total = parts.reduce((s, a) => s + a.length, 0);
  const all = new Float32Array(total);
  let off = 0;
  for (const a of parts) { all.set(a, off); off += a.length; }

  const clusters = whiteBalance(mergeClusters(kmeans(all, 7, 16), 12).filter((c) => c.weight >= 0.025));
  const hints = averageHints(use.map((p) => p.hints));
  const stripe = avg(use.map((p) => p.stripe));
  const whiteTop = avg(use.map((p) => p.whiteTop));
  const blob = { dark: avg(use.map((p) => p.blob.dark)), warm: avg(use.map((p) => p.blob.warm)) };

  const result = decide(clusters, hints, stripe, whiteTop, blob);
  const appearance = normalizeAppearance({ ...base, ...result.params, source: 'photos', summary: result.summary });
  onProgress(1, '完了');
  return {
    appearance,
    palette: clusters.map((c) => ({ hex: labToHex(c.lab), weight: c.weight, name: colorNameJa(c.lab) })),
    details: { total: per.length, found: found.length, hints, stripe, reasons: result.reasons },
    thumbs: per.map((p) => p.thumb),
  };
}

function analyzeOne(vision, cv) {
  const w = cv.width, h = cv.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h).data;

  // ---- 1. 猫の領域 ----
  let mask = null, found = false;
  if (vision) {
    try {
      const res = vision.segmenter.segment(cv);
      const cm = res.categoryMask;
      const arr = cm.getAsUint8Array();
      const mw = cm.width, mh = cm.height;
      mask = new Uint8Array(w * h);
      let cnt = 0;
      for (let y = 0; y < h; y++) {
        const sy = Math.min(mh - 1, Math.floor((y * mh) / h));
        for (let x = 0; x < w; x++) {
          const v = arr[sy * mw + Math.min(mw - 1, Math.floor((x * mw) / w))];
          if (v === vision.catIdx || v === vision.dogIdx) { mask[y * w + x] = 1; cnt++; }
        }
      }
      res.close();
      found = cnt / (w * h) > 0.015;
    } catch (e) {
      console.warn('segment failed', e);
    }
  }
  if (!found) mask = fallbackMask(img, w, h);
  mask = erode(mask, w, h, 2);

  let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    area++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  area /= w * h;
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);

  // ---- 2. 画素サンプル（Lab）と明度マップ ----
  const Lmap = new Float32Array(w * h);
  const darkM = new Uint8Array(w * h), warmM = new Uint8Array(w * h);
  const samples = [];
  let whiteTopN = 0, topN = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt((area * w * h) / 6000)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const lab = rgbToLab(img[i * 4], img[i * 4 + 1], img[i * 4 + 2]);
      Lmap[i] = lab[0];
      if (lab[0] < 32) darkM[i] = 1;
      else if (isWarm(lab)) warmM[i] = 1;
      if (x % stride === 0 && y % stride === 0) {
        samples.push(lab[0], lab[1], lab[2]);
        if ((y - y0) / bh < 0.35) { topN++; if (isWhite(lab)) whiteTopN++; }
      }
    }
  }

  // ---- 3. 縞の強さ: 局所平均との明度差が大きい画素の割合 ----
  const stripe = stripeScore(Lmap, mask, w, h, Math.max(3, Math.round(Math.min(bw, bh) / 28)));
  // 黒・茶の領域が「太い塊（サビ・三毛のパッチ）」か「細い縞」か
  const br = Math.max(2, Math.round(Math.min(bw, bh) * 0.035));
  const blob = { dark: blobness(darkM, w, h, br), warm: blobness(warmM, w, h, br) };

  // ---- 4. 画像分類のヒント ----
  let hints = { tabby: 0, egyptian: 0, siamese: 0, persian: 0 };
  if (vision?.classifier && area > 0.01) {
    try {
      const m = 0.08;
      const cx0 = Math.max(0, x0 - bw * m), cy0 = Math.max(0, y0 - bh * m);
      const cw = Math.min(w - cx0, bw * (1 + 2 * m)), ch = Math.min(h - cy0, bh * (1 + 2 * m));
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.round(cw)); crop.height = Math.max(1, Math.round(ch));
      crop.getContext('2d').drawImage(cv, cx0, cy0, cw, ch, 0, 0, crop.width, crop.height);
      const cats = vision.classifier.classify(crop).classifications?.[0]?.categories ?? [];
      const s = (re) => cats.filter((c) => re.test(c.categoryName || c.displayName || '')).reduce((a, c) => a + c.score, 0);
      hints = { tabby: s(/tabby|tiger cat/i), egyptian: s(/egyptian/i), siamese: s(/siamese/i), persian: s(/persian/i) };
    } catch (e) { console.warn('classify failed', e); }
  }

  return {
    found, area, samples: new Float32Array(samples), stripe, hints, blob,
    whiteTop: topN ? whiteTopN / topN : 0,
    thumb: makeThumb(cv, mask),
  };
}

// ---------- 判定 ----------
const isWhite = (lab) => (lab[0] > 74 && chroma(lab) < 16) || (lab[0] > 84 && chroma(lab) < 24);
const isDark = (lab) => lab[0] < 30;
const isOrange = (lab) => { const h = hueDeg(lab); return chroma(lab) > 22 && h > 35 && h < 88 && lab[0] > 35; };
const isVivid = (lab) => isOrange(lab) && chroma(lab) >= 32;
const isWarm = (lab) => { const h = hueDeg(lab); return chroma(lab) > 12 && h > 35 && h < 90 && lab[0] > 35; };
const isBrownish = (lab) => { const h = hueDeg(lab); return chroma(lab) >= 15 && h > 35 && h < 90 && lab[0] > 30 && lab[0] < 82; };

// 一番明るい無彩色クラスタ（白い毛）を基準にホワイトバランスと露出を補正する
function whiteBalance(clusters) {
  const ref = clusters.filter((c) => c.lab[0] > 70 && chroma(c.lab) < 20 && c.weight >= 0.06).sort((a, b) => b.lab[0] - a.lab[0])[0];
  if (!ref) return clusters;
  const [wL, wa, wb] = ref.lab;
  const gain = Math.min(1.25, 93 / wL);
  return clusters.map((c) => {
    const k = c.lab[0] / wL;
    return { ...c, lab: [Math.min(100, c.lab[0] * gain), c.lab[1] - wa * k, c.lab[2] - wb * k] };
  });
}

function decide(clusters, hints, stripe, whiteTop, blob) {
  const reasons = [];
  let white = 0, dark = 0, orange = 0, vivid = 0, brownish = 0;
  // 真っ白な毛が十分あるなら、明るい灰色は「影になった白」とみなす
  const trueWhite = clusters.filter((c) => isWhite(c.lab)).reduce((s, c) => s + c.weight, 0);
  if (trueWhite >= 0.1) for (const c of clusters) if (!isWhite(c.lab) && chroma(c.lab) < 12 && c.lab[0] >= 60) c.shadowWhite = true;
  const whiteish = (c) => isWhite(c.lab) || c.shadowWhite;
  for (const c of clusters) {
    if (isBrownish(c.lab) && !whiteish(c)) brownish += c.weight;
    if (whiteish(c)) white += c.weight;
    else if (isDark(c.lab)) dark += c.weight;
    if (isOrange(c.lab)) orange += c.weight;
    if (isVivid(c.lab)) vivid += c.weight;
  }
  const colored = clusters.filter((c) => !whiteish(c));
  const coloredW = colored.reduce((s, c) => s + c.weight, 0);
  const byL = [...colored].sort((a, b) => b.lab[0] - a.lab[0]);
  const heaviest = colored[0];
  const tabbyHint = hints.tabby + hints.egyptian * 0.6;
  reasons.push(`白 ${pct(white)} / 黒系 ${pct(dark)} / 茶系 ${pct(brownish)}（鮮やかな茶 ${pct(vivid)}）`);
  reasons.push(`縞の強さ ${stripe.toFixed(2)}・塊の太さ 黒 ${blob.dark.toFixed(2)} 茶 ${blob.warm.toFixed(2)}`);
  reasons.push(`画像分類 tabby ${hints.tabby.toFixed(2)} / siamese ${hints.siamese.toFixed(2)} / persian ${hints.persian.toFixed(2)}`);

  const p = { whiteAmount: 0, whiteFace: 0.15, patternContrast: 0.85, patternScale: 1 };
  let kind;
  let baseLab;

  if (white >= 0.85 || !heaviest) {
    kind = 'white';
    const w = clusters.find((c) => isWhite(c.lab)) ?? clusters[0];
    baseLab = w.lab;
    p.pattern = 'solid';
    p.baseColor = labToHex(w.lab);
    p.secondaryColor = labToHex(adjustLab(w.lab, -12));
    p.bellyColor = labToHex(adjustLab(w.lab, 3));
  } else if (hints.siamese >= 0.3 || (hints.siamese >= 0.12 && byL.length >= 2 && byL[0].lab[0] - byL[byL.length - 1].lab[0] > 30)) {
    kind = 'colorpoint';
    const light = white > 0.2 ? clusters.find((c) => whiteish(c)) : byL[0];
    const darkest = byL[byL.length - 1];
    baseLab = light.lab;
    p.pattern = 'colorpoint';
    p.baseColor = labToHex(adjustLab(light.lab, -2));
    p.secondaryColor = labToHex(darkest.lab);
    p.bellyColor = labToHex(adjustLab(light.lab, 5));
    p.patternContrast = 0.95;
    white = 0;
  } else if (dark >= 0.08 && blob.dark >= 0.2 && (
    (white >= 0.15 && brownish >= 0.08 && tabbyHint < 0.8) ||           // 三毛: 白＋黒の塊＋茶
    (vivid >= 0.05 && blob.warm >= 0.12))) {                            // サビ: 鮮やかな茶と黒の塊
    // サビ・三毛: 茶と黒が「太い塊」で分かれている（キジトラは黒が細い縞）
    kind = 'tortie';
    const o = colored.filter((c) => isBrownish(c.lab)).sort((a, b) => chroma(b.lab) * b.weight - chroma(a.lab) * a.weight)[0];
    const d = colored.filter((c) => isDark(c.lab)).sort((a, b) => a.lab[0] - b.lab[0])[0];
    baseLab = o.lab;
    p.pattern = 'tortie';
    p.baseColor = labToHex(adjustLab(o.lab, 5, 1.3)); // 写真の茶はくすみやすいので少し鮮やかに
    p.secondaryColor = labToHex(d.lab);
    p.bellyColor = labToHex(adjustLab(o.lab, 12, 0.7));
    p.patternContrast = 1;
  } else if ((tabbyHint >= 0.3 || stripe >= 0.3) && (colored.length >= 2 || stripe >= 0.38)) {
    // 縞: 一番多い「暗すぎない色」が地色、それより十分暗い色が縞
    const top = colored.slice(0, 4);
    const darkest = [...top].sort((a, b) => a.lab[0] - b.lab[0])[0];
    const score = (c) => c.weight * (1 + chroma(c.lab) / 30);
    const ground = top.filter((c) => c !== darkest && c.weight >= 0.06 && c.lab[0] > darkest.lab[0] + 12).sort((a, b) => score(b) - score(a))[0] ?? top[0];
    const stripeC = top.filter((c) => c.lab[0] < ground.lab[0] - 12).sort((a, b) => b.weight - a.weight)[0];
    const stripeLab = stripeC ? adjustLab(stripeC.lab, -4) : adjustLab(ground.lab, -28, 1.1);
    kind = hints.egyptian > hints.tabby * 1.5 && hints.egyptian > 0.2 ? 'spotted' : 'tabby';
    baseLab = ground.lab;
    p.pattern = kind;
    p.baseColor = labToHex(ground.lab);
    p.secondaryColor = labToHex(stripeLab);
    const lighter = byL.find((c) => c.lab[0] > ground.lab[0] + 6);
    p.bellyColor = labToHex(lighter ? lighter.lab : adjustLab(ground.lab, 14, 0.75));
    p.patternContrast = Math.min(1, 0.6 + stripe);
  } else {
    kind = 'solid';
    // 影で暗くなった画素に引っ張られないよう、重い色クラスタの重み付き平均を使う
    const near = colored.filter((c) => Math.abs(c.lab[0] - heaviest.lab[0]) < 25);
    const wsum = near.reduce((s, c) => s + c.weight, 0);
    const lab = [0, 1, 2].map((t) => near.reduce((s, c) => s + c.lab[t] * c.weight, 0) / wsum);
    baseLab = lab;
    p.pattern = 'solid';
    p.baseColor = labToHex(lab);
    p.secondaryColor = labToHex(adjustLab(lab, -15));
    p.bellyColor = labToHex(adjustLab(lab, isDark(lab) ? 4 : 10, 0.85));
  }

  // 白ぶち（写真は正面寄りで胸や顔の白が多く写るので、少し控えめに換算）
  if (kind !== 'white' && kind !== 'colorpoint') {
    const wf = white / Math.max(0.01, white + coloredW);
    p.whiteAmount = wf < 0.04 ? 0 : Math.min(0.95, 0.04 + 0.85 * wf ** 1.3);
    p.whiteFace = whiteTop > 0.2 ? Math.min(1, whiteTop * 1.3) : 0.1;
  }

  // 目の色（写真から直接は取れないので毛色から推定。手動で変更可）
  if (kind === 'colorpoint') p.eyeColor = '#5da7e3';
  else if (kind === 'white') p.eyeColor = '#7fb6d9';
  else if (isDark(baseLab)) p.eyeColor = '#d8a31a';
  else if (chroma(baseLab) < 12) p.eyeColor = '#b5c23c';
  else p.eyeColor = '#c99a2e';
  p.noseColor = isDark(baseLab) ? '#3a2e2e' : kind === 'colorpoint' ? '#6b4b4b' : '#d98a8f';
  p.furLength = hints.persian >= 0.25 ? 0.75 : 0.2;

  return { params: p, summary: coatNameJa(kind, p, baseLab, white), reasons };
}

const pct = (v) => `${Math.round(v * 100)}%`;

// 2値マスクの「太さ」: 周囲 (2r+1)^2 の 9 割以上が同じ領域に入る画素の割合
function blobness(bin, w, h, r) {
  const I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += bin[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const need = 0.9 * (2 * r + 1) ** 2;
  let set = 0, keep = 0;
  for (let y = r; y < h - r; y += 2) {
    for (let x = r; x < w - r; x += 2) {
      if (!bin[y * w + x]) continue;
      set++;
      const sum = I[(y + r + 1) * (w + 1) + x + r + 1] - I[(y - r) * (w + 1) + x + r + 1] - I[(y + r + 1) * (w + 1) + x - r] + I[(y - r) * (w + 1) + x - r];
      if (sum >= need) keep++;
    }
  }
  return set ? keep / set : 0;
}
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

function averageHints(list) {
  const out = { tabby: 0, egyptian: 0, siamese: 0, persian: 0 };
  for (const h of list) for (const k in out) out[k] += h[k] / list.length;
  return out;
}

export function colorNameJa(lab) {
  const [L] = lab, C = chroma(lab), h = hueDeg(lab);
  if (L > 80 && C < 16) return '白';
  if (L < 22) return '黒';
  if (C < 11) return L > 62 ? '薄グレー' : 'グレー';
  if (h > 55 && h < 100 && L > 68 && C < 32) return 'クリーム';
  if (h > 30 && h < 90 && C > 24) return L > 62 ? '薄茶' : '茶';
  if (L < 48) return 'こげ茶';
  return '茶';
}

function coatNameJa(kind, p, baseLab, white) {
  const w = p.whiteAmount;
  const C = chroma(baseLab);
  const orangey = isVivid(baseLab) || (isBrownish(baseLab) && baseLab[0] >= 62);
  const suffix = w >= 0.15 ? '白' : '';
  switch (kind) {
    case 'white': return '白猫';
    case 'tortie': return w >= 0.25 ? '三毛' : 'サビ';
    case 'colorpoint': return 'ポインテッド（シャム系）';
    case 'tabby':
    case 'spotted': {
      const t = orangey ? '茶トラ' : C < 12 ? 'サバトラ' : 'キジトラ';
      return (kind === 'spotted' ? `${t}（斑点）` : t) + suffix;
    }
    default: {
      if (isDark(baseLab)) return w >= 0.15 ? (p.whiteFace > 0.3 ? 'ハチワレ（白黒）' : '白黒') : '黒猫';
      if (C < 12) return w >= 0.15 ? 'グレー白' : 'グレー';
      return (orangey ? '茶' : colorNameJa(baseLab)) + (w >= 0.15 ? '白' : '');
    }
  }
}

// ---------- 画像処理ユーティリティ ----------
function subsample(arr, maxSamples) {
  const n = arr.length / 3;
  if (n <= maxSamples) return arr;
  const out = new Float32Array(maxSamples * 3);
  const step = n / maxSamples;
  for (let i = 0; i < maxSamples; i++) {
    const j = Math.floor(i * step) * 3;
    out[i * 3] = arr[j]; out[i * 3 + 1] = arr[j + 1]; out[i * 3 + 2] = arr[j + 2];
  }
  return out;
}

// モデルが使えない／猫が検出できない時: 中央の楕円から、背景（画像の縁）に似た色を除く
function fallbackMask(img, w, h) {
  const border = [];
  const push = (x, y) => { const i = (y * w + x) * 4; border.push(rgbToLab(img[i], img[i + 1], img[i + 2])); };
  for (let x = 0; x < w; x += 4) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 4) { push(0, y); push(w - 1, y); }
  const bg = mergeClusters(kmeans(new Float32Array(border.flat()), 4, 8), 10).filter((c) => c.weight > 0.12);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / w - 0.5) / 0.36, ny = (y / h - 0.52) / 0.42;
      if (nx * nx + ny * ny > 1) continue;
      const i = (y * w + x) * 4;
      const lab = rgbToLab(img[i], img[i + 1], img[i + 2]);
      if (bg.some((c) => Math.hypot(lab[0] - c.lab[0], lab[1] - c.lab[1], lab[2] - c.lab[2]) < 16)) continue;
      mask[y * w + x] = 1;
    }
  }
  return mask;
}

function erode(mask, w, h, iters) {
  let m = mask;
  for (let it = 0; it < iters; it++) {
    const o = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w];
      }
    }
    m = o;
  }
  return m;
}

function stripeScore(Lmap, mask, w, h, r) {
  // 積分画像で局所平均（マスク内のみ）を求める
  const S = new Float64Array((w + 1) * (h + 1));
  const N = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rn = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) { rs += Lmap[i]; rn++; }
      S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + rs;
      N[(y + 1) * (w + 1) + x + 1] = N[y * (w + 1) + x + 1] + rn;
    }
  }
  const box = (A, xa, ya, xb, yb) => A[yb * (w + 1) + xb] - A[ya * (w + 1) + xb] - A[yb * (w + 1) + xa] + A[ya * (w + 1) + xa];
  let hit = 0, tot = 0;
  for (let y = r; y < h - r; y += 2) {
    for (let x = r; x < w - r; x += 2) {
      const i = y * w + x;
      if (!mask[i] || Lmap[i] > 80) continue;
      const n = box(N, x - r, y - r, x + r + 1, y + r + 1);
      if (n < 8) continue;
      const mean = box(S, x - r, y - r, x + r + 1, y + r + 1) / n;
      tot++;
      if (mean - Lmap[i] > 7) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

function makeThumb(cv, mask) {
  const s = 128 / Math.max(cv.width, cv.height);
  const t = document.createElement('canvas');
  t.width = Math.round(cv.width * s); t.height = Math.round(cv.height * s);
  const g = t.getContext('2d');
  g.drawImage(cv, 0, 0, t.width, t.height);
  const d = g.getImageData(0, 0, t.width, t.height);
  for (let y = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++) {
      const mi = Math.min(cv.height - 1, Math.floor(y / s)) * cv.width + Math.min(cv.width - 1, Math.floor(x / s));
      if (!mask[mi]) {
        const i = (y * t.width + x) * 4;
        d.data[i] *= 0.3; d.data[i + 1] *= 0.3; d.data[i + 2] *= 0.3;
      }
    }
  }
  g.putImageData(d, 0, 0);
  return t;
}
