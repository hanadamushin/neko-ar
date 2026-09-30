import { normalizeAppearance } from '../cat/appearance.js';
import { toCanvas } from './appearance.js';

// 任意機能: Claude（画像理解）で毛柄・部位ごとの白・目の色などを詳しく読み取る。
// ユーザー自身の API キーでブラウザから直接呼ぶ（キーは端末内にのみ保存）。
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm';

const HEX = { type: 'string', description: 'sRGB hex color like #a0522d' };
const SCHEMA = {
  type: 'object',
  properties: {
    is_cat: { type: 'boolean', description: 'true if the photos clearly show a (domestic) cat' },
    coat_name_ja: { type: 'string', description: 'Common Japanese coat name, e.g. キジトラ白, 茶トラ, 三毛, サビ, ハチワレ, 黒猫, サバトラ' },
    pattern: {
      type: 'string',
      enum: ['solid', 'tabby', 'spotted', 'tortoiseshell', 'calico', 'colorpoint', 'bicolor', 'van'],
    },
    base_color: { ...HEX, description: 'Main / ground fur color as it would look under neutral daylight (compensate for indoor lighting).' },
    secondary_color: { ...HEX, description: 'Stripe / spot / patch / point color. For solid coats, a slightly darker shade of the base.' },
    belly_color: { ...HEX, description: 'Color of the underside (belly, inner legs) excluding pure white spotting.' },
    white_amount: { type: 'number', description: 'Fraction of the body surface that is white spotting, 0 to 1. 0 = none, 0.08 = white paws or small chest spot, 0.3 = tuxedo, 0.5 = bicolor, 0.85 = van.' },
    white_on_face: { type: 'number', description: '0 to 1: how much white is on the face (muzzle / blaze).' },
    eye_color: { ...HEX, description: 'Iris color. If eyes are not visible, give a typical color for this coat.' },
    nose_color: { ...HEX, description: 'Nose leather color.' },
    fur_length: { type: 'string', enum: ['short', 'medium', 'long'] },
    build: { type: 'string', enum: ['slim', 'average', 'chubby'] },
    ear_size: { type: 'string', enum: ['small', 'average', 'large'] },
    tail_length: { type: 'string', enum: ['short', 'average', 'long'] },
    summary_ja: { type: 'string', description: 'One short Japanese sentence describing the cat\'s appearance.' },
  },
  required: ['is_cat', 'coat_name_ja', 'pattern', 'base_color', 'secondary_color', 'belly_color', 'white_amount',
    'white_on_face', 'eye_color', 'nose_color', 'fur_length', 'build', 'ear_size', 'tail_length', 'summary_ja'],
  additionalProperties: false,
};

const SYSTEM = `You are helping a hobby AR app recreate the user's own cat as a stylized 3D model.
Look at every photo, reason about the cat's true fur colors under neutral light (photos are often warm or dim),
and describe the coat so that a procedural shader can reproduce it. When photos disagree, prefer the clearest, best-lit one.`;

function toJpegBase64(src) {
  const c = toCanvas(src, 1024);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

export async function analyzeWithClaude(apiKey, sources, base = {}) {
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const images = sources.slice(0, 5).map((s) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: toJpegBase64(s) },
  }));
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [...images, { type: 'text', text: `These ${images.length} photo(s) show my cat. Describe its appearance using the schema.` }],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude がこの解析を完了できませんでした。');
  if (response.stop_reason === 'max_tokens') throw new Error('応答が途中で切れました。もう一度お試しください。');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const j = JSON.parse(text);
  if (!j.is_cat) throw new Error('写真から猫を確認できませんでした。');
  return { appearance: toAppearance(j, base), raw: j };
}

function toAppearance(j, base) {
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  let pattern = j.pattern;
  let white = clamp01(j.white_amount);
  if (pattern === 'calico') { pattern = 'tortie'; white = Math.max(white, 0.3); }
  else if (pattern === 'tortoiseshell') pattern = 'tortie';
  else if (pattern === 'bicolor') { pattern = 'solid'; white = Math.max(white, 0.35); }
  else if (pattern === 'van') { pattern = 'solid'; white = Math.max(white, 0.8); }
  return normalizeAppearance({
    ...base,
    pattern,
    baseColor: j.base_color,
    secondaryColor: j.secondary_color,
    bellyColor: j.belly_color,
    whiteAmount: white < 0.03 ? 0 : white,
    whiteFace: clamp01(j.white_on_face),
    eyeColor: j.eye_color,
    noseColor: j.nose_color,
    furLength: { short: 0.15, medium: 0.45, long: 0.8 }[j.fur_length] ?? 0.2,
    chubby: { slim: 0.1, average: 0.35, chubby: 0.75 }[j.build] ?? 0.35,
    earSize: { small: 0.85, average: 1.0, large: 1.2 }[j.ear_size] ?? 1,
    tailLength: { short: 0.45, average: 1.0, long: 1.15 }[j.tail_length] ?? 1,
    source: 'claude',
    summary: j.coat_name_ja,
    note: j.summary_ja,
  });
}
