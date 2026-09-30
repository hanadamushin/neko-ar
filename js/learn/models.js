// MediaPipe のモデル読み込み（初回のみダウンロード、以降はブラウザキャッシュ）
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const AUDIO = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.0.1';
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';
const CLS_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/int8/1/efficientnet_lite0.tflite';
const YAMNET_MODEL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';

let visionP = null;
let audioP = null;

// 画像: 猫の領域を切り出すセグメンテーション（DeepLab v3, PASCAL VOC の "cat"）と
// 柄のヒントを得る画像分類（ImageNet の "tabby", "Siamese cat" など）
export function loadVision() {
  if (!visionP) {
    visionP = (async () => {
      const mp = await import(`${VISION}/vision_bundle.mjs`);
      const fileset = await mp.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
      const segmenter = await mp.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      let classifier = null;
      try {
        classifier = await mp.ImageClassifier.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: CLS_MODEL, delegate: 'CPU' },
          runningMode: 'IMAGE',
          maxResults: 20,
        });
      } catch (e) {
        console.warn('classifier unavailable', e);
      }
      const labels = segmenter.getLabels?.() ?? [];
      const idx = (name, fb) => { const i = labels.findIndex((l) => l.toLowerCase() === name); return i >= 0 ? i : fb; };
      return { segmenter, classifier, catIdx: idx('cat', 8), dogIdx: idx('dog', 12) };
    })().catch((e) => { visionP = null; throw e; });
  }
  return visionP;
}

// 音声: YAMNet（AudioSet 521クラス。"Meow", "Purr", "Hiss", "Cat" などを含む）
export function loadAudioClassifier() {
  if (!audioP) {
    audioP = (async () => {
      const mp = await import(`${AUDIO}/audio_bundle.mjs`);
      const fileset = await mp.FilesetResolver.forAudioTasks(`${AUDIO}/wasm`);
      return mp.AudioClassifier.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: YAMNET_MODEL },
        maxResults: -1,
        scoreThreshold: 0,
      });
    })().catch((e) => { audioP = null; throw e; });
  }
  return audioP;
}
