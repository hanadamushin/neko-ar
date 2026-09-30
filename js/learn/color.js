// 色空間変換と k-means（CIELAB で距離を測る）

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
const finv = (t) => (t > 6 / 29 ? t ** 3 : (108 / 841) * (t - 4 / 29));
const XN = 0.95047, YN = 1.0, ZN = 1.08883;

export function rgbToLab(r, g, b) {
  const R = srgbToLin(r / 255), G = srgbToLin(g / 255), B = srgbToLin(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / XN;
  const Y = (0.2126 * R + 0.7152 * G + 0.0722 * B) / YN;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / ZN;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = finv(fx) * XN, Y = finv(fy) * YN, Z = finv(fz) * ZN;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [R, G, B].map((c) => Math.round(Math.min(1, Math.max(0, linToSrgb(c))) * 255));
}

export const labToHex = (lab) => rgbToHex(...labToRgb(...lab));
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
export function hexToLab(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

export const chroma = (lab) => Math.hypot(lab[1], lab[2]);
export const hueDeg = (lab) => ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
export const deltaE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

// 明るさ・彩度をずらした色
export function adjustLab(lab, dL = 0, cMul = 1) {
  return [Math.min(100, Math.max(0, lab[0] + dL)), lab[1] * cMul, lab[2] * cMul];
}

// samples: Float32Array [L,a,b, L,a,b, ...]
export function kmeans(samples, k = 6, iters = 14) {
  const n = samples.length / 3;
  if (n === 0) return [];
  k = Math.min(k, n);
  const cent = [];
  // k-means++ 初期化
  const first = (Math.random() * n) | 0;
  cent.push([samples[first * 3], samples[first * 3 + 1], samples[first * 3 + 2]]);
  const d2 = new Float32Array(n).fill(Infinity);
  while (cent.length < k) {
    const c = cent[cent.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dl = samples[i * 3] - c[0], da = samples[i * 3 + 1] - c[1], db = samples[i * 3 + 2] - c[2];
      d2[i] = Math.min(d2[i], dl * dl + da * da + db * db);
      sum += d2[i];
    }
    let r = Math.random() * sum, idx = 0;
    for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { idx = i; break; } }
    cent.push([samples[idx * 3], samples[idx * 3 + 1], samples[idx * 3 + 2]]);
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < cent.length; j++) {
        const c = cent[j];
        const dl = samples[i * 3] - c[0], da = samples[i * 3 + 1] - c[1], db = samples[i * 3 + 2] - c[2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = j; }
      }
      assign[i] = best;
      const a = acc[best];
      a[0] += samples[i * 3]; a[1] += samples[i * 3 + 1]; a[2] += samples[i * 3 + 2]; a[3]++;
    }
    acc.forEach((a, j) => { if (a[3]) cent[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const counts = new Array(cent.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  return cent.map((lab, j) => ({ lab, weight: counts[j] / n })).filter((c) => c.weight > 0);
}

// 近い色のクラスタを統合
export function mergeClusters(clusters, thresh = 11) {
  const out = clusters.map((c) => ({ lab: [...c.lab], weight: c.weight }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (deltaE(out[i].lab, out[j].lab) < thresh) {
          const w = out[i].weight + out[j].weight;
          out[i].lab = out[i].lab.map((v, t) => (v * out[i].weight + out[j].lab[t] * out[j].weight) / w);
          out[i].weight = w;
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}
