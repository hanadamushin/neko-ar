// 猫の見た目パラメータ。写真解析・Claude解析・手動編集のすべてがこの形に落ちる。
export const PATTERNS = ['solid', 'tabby', 'spotted', 'tortie', 'colorpoint'];

export const PATTERN_LABEL = {
  solid: '単色',
  tabby: 'トラ（縞）',
  spotted: '斑点',
  tortie: 'サビ',
  colorpoint: 'ポインテッド',
};

export const DEFAULT_APPEARANCE = Object.freeze({
  pattern: 'tabby',
  baseColor: '#c98a4b',
  secondaryColor: '#6b3f1f',
  bellyColor: '#ecd3ae',
  eyeColor: '#c9a227',
  noseColor: '#d98a8f',
  whiteAmount: 0.18,
  whiteFace: 0.2,
  patternScale: 1.0,
  patternContrast: 0.85,
  furLength: 0.2,
  chubby: 0.35,
  earSize: 1.0,
  tailLength: 1.0,
  legLength: 1.0,
  source: 'default',
  summary: '茶トラ白',
});

const NUM_RANGES = {
  whiteAmount: [0, 1], whiteFace: [0, 1], patternScale: [0.5, 2], patternContrast: [0, 1],
  furLength: [0, 1], chubby: [0, 1], earSize: [0.7, 1.4], tailLength: [0.4, 1.3], legLength: [0.8, 1.2],
};

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeAppearance(input = {}) {
  const out = { ...DEFAULT_APPEARANCE, ...input };
  if (!PATTERNS.includes(out.pattern)) out.pattern = DEFAULT_APPEARANCE.pattern;
  for (const k of ['baseColor', 'secondaryColor', 'bellyColor', 'eyeColor', 'noseColor']) {
    if (typeof out[k] !== 'string' || !HEX.test(out[k])) out[k] = DEFAULT_APPEARANCE[k];
    out[k] = out[k].toLowerCase();
  }
  for (const [k, [lo, hi]] of Object.entries(NUM_RANGES)) {
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_APPEARANCE[k];
  }
  return out;
}

// 形（メッシュの再構築が必要なパラメータ）が変わったか
export const SHAPE_KEYS = ['furLength', 'chubby', 'earSize', 'tailLength', 'legLength'];
export function shapeChanged(a, b) {
  return SHAPE_KEYS.some((k) => Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)) > 1e-4);
}

export function describeAppearance(ap) {
  const parts = [PATTERN_LABEL[ap.pattern] ?? ap.pattern];
  if (ap.pattern === 'tortie' && ap.whiteAmount >= 0.3) parts[0] = '三毛';
  else if (ap.whiteAmount >= 0.55) parts.push('白多め');
  else if (ap.whiteAmount >= 0.12) parts.push('白ぶち');
  if (ap.furLength > 0.6) parts.push('長毛');
  return parts.join('・');
}
