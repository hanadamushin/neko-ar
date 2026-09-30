import * as THREE from 'three';
import { CatActor } from './cat/CatActor.js';
import { CatVoice, KIND_LABEL } from './cat/CatVoice.js';
import { DEFAULT_APPEARANCE, normalizeAppearance, describeAppearance, PATTERN_LABEL } from './cat/appearance.js';
import { PreviewMode } from './world/PreviewMode.js';
import { DemoMode } from './world/DemoMode.js';
import { ARMode } from './world/ARMode.js';
import { store } from './store.js';
import { analyzeImages, fileToBitmap } from './learn/appearance.js';
import { extractFrames } from './learn/video.js';
import { extractVoice } from './learn/voice.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const SOURCE_LABEL = { default: 'デフォルト', photos: '写真から学習', video: '動画から学習', claude: 'Claude解析', manual: '手動調整' };

const state = {
  name: 'ねこ',
  appearance: normalizeAppearance(DEFAULT_APPEARANCE),
  settings: { scale: 1, sound: true, showSurfaces: true },
  sources: [],     // 最後に解析した画像（Claude 解析に再利用）
  clips: [],
  apiKey: '',
};

// ---------------- 3D ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.xr.enabled = true;

const voice = new CatVoice();
const actor = new CatActor(state.appearance, voice);

const hud = {
  status(t) { $('#status').textContent = t; },
  toast(t) {
    const el = $('#toast');
    el.textContent = t;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(this._t);
    this._t = setTimeout(() => { el.hidden = true; }, 2600);
  },
  showScan(on) { $('#btn-scan').hidden = !on; },
};

const modes = {
  preview: new PreviewMode(renderer, actor),
  demo: new DemoMode(renderer, actor, hud),
  ar: new ARMode(renderer, actor, hud, $('#overlay')),
};
let mode = null;
let modeName = '';

function setMode(name) {
  mode?.exit();
  modeName = name;
  mode = modes[name];
  const home = name === 'preview';
  $('#home').classList.toggle('active', home);
  $('#experience').classList.toggle('active', !home);
  (home ? $('#preview-host') : $('#exp-host')).appendChild(renderer.domElement);
  if (!home) {
    actor.setScale(state.settings.scale);
    mode.showPoints = state.settings.showSurfaces;
    $('#btn-surfaces').classList.toggle('on', mode.showPoints);
  }
  if (name !== 'ar') mode.enter();
  resize();
}

function resize() {
  if (renderer.xr.isPresenting) return;
  const host = renderer.domElement.parentElement;
  if (!host) return;
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  renderer.setSize(w, h, false);
  mode?.resize(w, h);
}
new ResizeObserver(resize).observe($('#preview-host'));
new ResizeObserver(resize).observe($('#exp-host'));

const timer = new THREE.Timer();
const debug = { timeScale: 1 };
renderer.setAnimationLoop((t, frame) => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1) * debug.timeScale;
  if (!mode) return;
  mode.update(dt, frame);
  renderer.render(mode.scene, mode.camera);
});

// ---------------- 体験画面のボタン ----------------
for (const el of $$('#overlay .btn, #status')) {
  // AR の dom-overlay 上のボタン操作が「画面タップ（select）」として扱われないように
  el.addEventListener('beforexrselect', (e) => e.preventDefault());
}
$('#btn-exit').onclick = () => {
  if (modeName === 'ar') modes.ar.stop();
  else setMode('preview');
};
$('#btn-call').onclick = () => { voice.unlock(); mode?.callToUser?.(); };
$('#btn-surfaces').onclick = () => {
  if (!mode) return;
  mode.showPoints = !mode.showPoints;
  $('#btn-surfaces').classList.toggle('on', mode.showPoints);
};
$('#btn-scan').onclick = () => { modes.demo.scanAll(); hud.toast('部屋全体をスキャンしました'); };

$('#btn-demo').onclick = () => { voice.unlock(); setMode('demo'); };
$('#btn-ar').onclick = async () => {
  voice.unlock();
  setMode('ar');
  hud.status('ARを起動しています…');
  try {
    await modes.ar.start(() => setMode('preview'));
  } catch (e) {
    console.error(e);
    setMode('preview');
    alert(`ARを開始できませんでした: ${e.message ?? e}`);
  }
};

async function checkAR() {
  const btn = $('#btn-ar');
  const note = $('#ar-note');
  if (!window.isSecureContext) {
    btn.textContent = 'ARにはHTTPSが必要';
    note.textContent = 'ARはHTTPSで公開したページ（または localhost）でのみ動作します。README の公開手順をご覧ください。';
    return;
  }
  if (await ARMode.isSupported()) {
    btn.disabled = false;
    btn.textContent = 'ARで猫を出す';
    note.textContent = '床や机をゆっくり映すと、猫がその面を認識して歩いたり飛び乗ったりします。';
  } else {
    btn.textContent = 'この端末はAR非対応';
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    note.textContent = ios
      ? 'iPhone/iPad の Safari は現在 WebXR の AR に対応していません。デモルームで同じ猫の動きを試せます（Android の Chrome や Meta Quest なら AR で動きます）。'
      : 'Android の Chrome や Meta Quest のブラウザで開くと AR で使えます。この端末ではデモルームをお試しください。';
  }
}

// ---------------- タブ ----------------
for (const tab of $$('.tab')) {
  tab.onclick = () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
  };
}

// ---------------- 見た目 ----------------
const FIELDS = ['pattern', 'baseColor', 'secondaryColor', 'bellyColor', 'eyeColor', 'noseColor', 'whiteAmount', 'whiteFace',
  'patternScale', 'patternContrast', 'furLength', 'chubby', 'earSize', 'tailLength', 'legLength'];

function fillForm() {
  for (const k of FIELDS) {
    const el = $(`#f-${k}`);
    if (el) el.value = state.appearance[k];
  }
}

function updateChip() {
  const ap = state.appearance;
  $('#appearance-chip').textContent = `見た目: ${ap.summary || describeAppearance(ap)}（${SOURCE_LABEL[ap.source] ?? ap.source}）`;
}

let saveTimer = 0;
function applyAppearance(ap, { save = true, form = true } = {}) {
  state.appearance = normalizeAppearance(ap);
  actor.setAppearance(state.appearance);
  if (form) fillForm();
  updateChip();
  if (save) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('profile', { name: state.name, appearance: state.appearance }), 300);
  }
}

for (const k of FIELDS) {
  const el = $(`#f-${k}`);
  if (!el) continue;
  el.addEventListener('input', () => {
    const v = el.type === 'range' ? parseFloat(el.value) : el.value;
    const summary = state.appearance.source === 'manual' ? state.appearance.summary : `${state.appearance.summary || ''}（調整済み）`.replace('（調整済み）（調整済み）', '（調整済み）');
    applyAppearance({ ...state.appearance, [k]: v, source: 'manual', summary }, { form: false });
  });
}
$('#btn-reset-look').onclick = () => applyAppearance({ ...DEFAULT_APPEARANCE });

function progress(el, frac, label) {
  el.hidden = frac == null;
  if (frac == null) return;
  el.querySelector('.bar').style.width = `${Math.round(frac * 100)}%`;
  el.querySelector('.label').textContent = label ?? '';
}

function showLookResult(res, sourceKind) {
  const thumbs = $('#look-thumbs');
  thumbs.replaceChildren(...res.thumbs.slice(0, 12));
  const r = $('#look-result');
  r.hidden = false;
  const ap = res.appearance;
  const sw = (hex) => `<span class="swatch" style="background:${hex}"></span>${hex}`;
  r.innerHTML = `
    <div class="palette">${res.palette.map((p) => `<span title="${p.name} ${Math.round(p.weight * 100)}%" style="background:${p.hex};width:${p.weight * 100}%"></span>`).join('')}</div>
    <dl class="facts">
      <dt>推定</dt><dd><b>${ap.summary}</b></dd>
      <dt>柄</dt><dd>${PATTERN_LABEL[ap.pattern]}</dd>
      <dt>地の色</dt><dd>${sw(ap.baseColor)}</dd>
      <dt>柄の色</dt><dd>${sw(ap.secondaryColor)}</dd>
      <dt>白の量</dt><dd>${Math.round(ap.whiteAmount * 100)}%</dd>
      <dt>毛色</dt><dd>${res.palette.map((p) => `${p.name} ${Math.round(p.weight * 100)}%`).join('・')}</dd>
      <dt>猫を検出</dt><dd>${res.details.found}/${res.details.total} ${sourceKind === 'video' ? 'フレーム' : '枚'}${res.details.found ? '' : '（検出できず、中央付近の色を使用）'}</dd>
      <dt>根拠</dt><dd class="note">${res.details.reasons.join('<br>')}</dd>
    </dl>
    <p class="hint">目の色は写真から直接は測れないため、毛色から推定しています。「手動で微調整」や Claude 解析で直せます。</p>`;
}

async function learnFromImages(sources, sourceKind) {
  const pg = $('#look-progress');
  try {
    const res = await analyzeImages(sources, {
      base: state.appearance,
      onProgress: (f, label) => progress(pg, f, label),
    });
    res.appearance.source = sourceKind;
    state.sources = sources;
    applyAppearance(res.appearance);
    showLookResult(res, sourceKind);
    updateClaudeButton();
  } catch (e) {
    console.error(e);
    alert(`解析に失敗しました: ${e.message ?? e}`);
  } finally {
    progress(pg, null);
  }
}

$('#in-photos').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const bitmaps = [];
  for (const f of files.slice(0, 12)) {
    try { bitmaps.push(await fileToBitmap(f)); } catch (err) { console.warn(err); }
  }
  if (bitmaps.length) await learnFromImages(bitmaps, 'photos');
};

async function learnLookFromVideo(file) {
  const pg = $('#look-progress');
  progress(pg, 0.01, '動画からフレームを取り出しています…');
  const frames = await extractFrames(file, { count: 14, onProgress: (f) => progress(pg, f * 0.3, '動画からフレームを取り出しています…') });
  await learnFromImages(frames, 'video');
}

$('#in-video-look').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { await learnLookFromVideo(file); } catch (err) { alert(err.message ?? err); progress($('#look-progress'), null); }
};

function updateClaudeButton() {
  const btn = $('#btn-claude');
  btn.disabled = !(state.apiKey && state.sources.length);
  btn.title = !state.apiKey ? '設定タブでAPIキーを入力すると使えます' : !state.sources.length ? '先に写真か動画を選んでください' : '';
}

$('#btn-claude').onclick = async () => {
  const btn = $('#btn-claude');
  const pg = $('#look-progress');
  btn.disabled = true;
  progress(pg, 0.4, 'Claude が写真を見ています…');
  try {
    const { analyzeWithClaude } = await import('./learn/claude.js');
    const { appearance, raw } = await analyzeWithClaude(state.apiKey, state.sources, state.appearance);
    applyAppearance(appearance);
    const r = $('#look-result');
    r.hidden = false;
    r.insertAdjacentHTML('afterbegin', `<p class="hint"><b>Claude: ${raw.coat_name_ja}</b> — ${raw.summary_ja}</p>`);
  } catch (e) {
    console.error(e);
    alert(`Claude 解析に失敗しました: ${e.message ?? e}`);
  } finally {
    progress(pg, null);
    updateClaudeButton();
  }
};

// ---------------- 鳴き声 ----------------
async function reloadClips() {
  state.clips = (await store.clips()).sort((a, b) => (a.id < b.id ? -1 : 1));
  await voice.setClips(state.clips);
  renderClips();
}

function renderClips() {
  const list = $('#clip-list');
  list.replaceChildren();
  const c = voice.counts();
  $('#voice-summary').textContent = state.clips.length
    ? `学習済み: にゃー ${c.meow} / くるる ${c.trill} / ゴロゴロ ${c.purr} / シャー ${c.hiss}（声の高さ 約${Math.round(voice.f0)}Hz）`
    : 'まだ鳴き声を学習していません（合成した声で鳴きます）。';
  for (const clip of state.clips) {
    const li = document.createElement('li');
    const sel = document.createElement('select');
    sel.className = 'kind';
    for (const [k, v] of Object.entries(KIND_LABEL)) sel.add(new Option(v, k, false, k === clip.kind));
    sel.onchange = async () => { await store.updateClip(clip.id, { kind: sel.value }); reloadClips(); };
    const wave = document.createElement('canvas');
    wave.className = 'wave';
    wave.width = 90; wave.height = 24;
    drawWave(wave, clip.peaks ?? []);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${clip.duration}s${clip.f0 ? ` · ${clip.f0}Hz` : ''}`;
    meta.title = clip.source ?? '';
    const play = document.createElement('button');
    play.className = 'btn';
    play.textContent = '▶';
    play.onclick = () => playBlob(clip.blob);
    const del = document.createElement('button');
    del.className = 'btn subtle';
    del.textContent = '削除';
    del.onclick = async () => { await store.deleteClip(clip.id); reloadClips(); };
    li.append(sel, wave, meta, play, del);
    list.append(li);
  }
}

function drawWave(cv, peaks) {
  const g = cv.getContext('2d');
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#e8793a';
  const w = cv.width / Math.max(1, peaks.length);
  peaks.forEach((p, i) => { const h = Math.max(1, p * cv.height); g.fillRect(i * w, (cv.height - h) / 2, Math.max(1, w - 0.5), h); });
}

async function playBlob(blob) {
  const ctx = voice.unlock();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.connect(voice.master);
  s.start();
}

$('#in-voice').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  voice.unlock();
  const pg = $('#voice-progress');
  try {
    const res = await extractVoice(file, { onProgress: (f, label) => progress(pg, f, label) });
    if (res.clips.length) {
      await store.putClips(res.clips);
      await reloadClips();
      const c = res.clips.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {});
      $('#voice-summary').textContent += `　今回: ${Object.entries(c).map(([k, n]) => `${KIND_LABEL[k]} ${n}`).join('、')} を追加${res.usedClassifier ? '' : '（分類モデルなし・ピッチで判定）'}`;
    } else {
      $('#voice-summary').textContent = `鳴き声が見つかりませんでした（音の区間 ${res.candidates} 個を確認）。猫の声がはっきり入った部分を含む動画をお試しください。`;
    }
  } catch (err) {
    console.error(err);
    alert(err.message ?? err);
  } finally {
    progress(pg, null);
  }
  if (file.type.startsWith('video/') && $('#chk-voice-look').checked) {
    try { await learnLookFromVideo(file); } catch (err) { console.warn(err); progress($('#look-progress'), null); }
  }
};

for (const b of $$('[data-say]')) b.onclick = () => { voice.unlock(); voice.say(b.dataset.say); };

// ---------------- 設定 ----------------
function saveSettings() { store.set('settings', state.settings); }
$('#s-scale').oninput = (e) => { state.settings.scale = parseFloat(e.target.value); saveSettings(); };
$('#s-sound').onchange = (e) => { state.settings.sound = e.target.checked; voice.enabled = e.target.checked; saveSettings(); };
$('#s-surfaces').onchange = (e) => { state.settings.showSurfaces = e.target.checked; saveSettings(); };

const KEY_STORE = 'nekoar.apikey';
$('#s-apikey').oninput = (e) => {
  state.apiKey = e.target.value.trim();
  if ($('#s-savekey').checked) try { localStorage.setItem(KEY_STORE, state.apiKey); } catch { /* 保存不可 */ }
  updateClaudeButton();
};
$('#s-savekey').onchange = (e) => {
  try {
    if (e.target.checked) localStorage.setItem(KEY_STORE, state.apiKey);
    else localStorage.removeItem(KEY_STORE);
  } catch { /* 保存不可 */ }
};

$('#cat-name').onchange = (e) => {
  state.name = e.target.value.trim() || 'ねこ';
  store.set('profile', { name: state.name, appearance: state.appearance });
};

$('#btn-clear').onclick = async () => {
  if (!confirm('学習した見た目と鳴き声をすべて消去しますか？')) return;
  await store.clearAll();
  try { localStorage.removeItem(KEY_STORE); } catch { /* noop */ }
  state.sources = [];
  $('#look-thumbs').replaceChildren();
  $('#look-result').hidden = true;
  applyAppearance({ ...DEFAULT_APPEARANCE }, { save: false });
  await reloadClips();
};

// ---------------- 起動 ----------------
async function init() {
  const profile = await store.get('profile');
  if (profile?.appearance) state.appearance = normalizeAppearance(profile.appearance);
  if (profile?.name) state.name = profile.name;
  const settings = await store.get('settings');
  if (settings) Object.assign(state.settings, settings);
  try { state.apiKey = localStorage.getItem(KEY_STORE) ?? ''; } catch { state.apiKey = ''; }

  $('#cat-name').value = state.name;
  $('#s-scale').value = state.settings.scale;
  $('#s-sound').checked = state.settings.sound;
  $('#s-surfaces').checked = state.settings.showSurfaces;
  $('#s-apikey').value = state.apiKey;
  $('#s-savekey').checked = !!state.apiKey;
  voice.enabled = state.settings.sound;

  applyAppearance(state.appearance, { save: false });
  setMode('preview');
  checkAR();
  updateClaudeButton();
  reloadClips().catch((e) => console.warn(e));
}

init();

// デバッグ用（ブラウザのコンソールから触れるように）
window.nekoar = { state, actor, modes, voice, debug, applyAppearance, analyzeImages, extractVoice };
