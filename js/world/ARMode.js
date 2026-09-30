import * as THREE from 'three';
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';
import { SurfaceMap } from './SurfaceMap.js';
import { addLights, getEnvironment } from './common.js';

const SEMANTIC_JA = { table: '机', desk: '机', couch: 'ソファ', bed: 'ベッド', floor: '床', shelf: '棚', other: '面' };

// WebXR immersive-ar。ヒットテスト（と、あれば平面検出）で水平面を集めて SurfaceMap を作り、
// そこに猫を置いて自由に行動させる。
export class ARMode {
  constructor(renderer, actor, hud, overlayRoot) {
    this.renderer = renderer;
    this.actor = actor;
    this.hud = hud;
    this.overlayRoot = overlayRoot;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 30);
    this.defaultLights = addLights(this.scene, { key: 1.5, fill: 1.5 });
    this.defaultEnv = getEnvironment(renderer);
    this.scene.environment = this.defaultEnv;
    this.scene.environmentIntensity = 0.45;

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.reticle.renderOrder = 3;
    this.scene.add(this.reticle);

    this.map = new SurfaceMap({ cell: 0.08 });
    this.map.onSurface = (L) => this._announce(L);
    this.points = null;
    this.showPoints = true;
    this.planeSeen = new Map();
    this.camPos = new THREE.Vector3();
    this.maintainT = 0;
    this.pointsVer = -1;
    this.reticleHit = null;
    // XREstimatedLight はセッション開始イベントを待ち受けるので、セッション前に作っておく
    this._setupLightEstimation();
  }

  static async isSupported() {
    try { return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar')); }
    catch { return false; }
  }

  // ボタン押下（ユーザー操作）の中から呼ぶこと
  async start(onEnd) {
    this.onEnd = onEnd;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'plane-detection', 'light-estimation', 'anchors'],
      domOverlay: { root: this.overlayRoot },
    });
    this.session = session;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);

    this.viewerSpace = await session.requestReferenceSpace('viewer');
    this.centerSource = await session.requestHitTestSource({ space: this.viewerSpace });
    // 画面中央だけでなく、周囲にも光線を張って面を早く広く見つける
    this.scanSources = [];
    const angles = [];
    for (const ay of [-0.55, -0.3, -0.05, 0.2]) for (const ax of [-0.35, 0, 0.35]) angles.push([ax, ay]);
    for (const [ax, ay] of angles) {
      try {
        const offsetRay = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: Math.tan(ax), y: Math.tan(ay), z: -1, w: 0 });
        this.scanSources.push(await session.requestHitTestSource({ space: this.viewerSpace, offsetRay }));
      } catch (e) { console.warn('scan source', e); }
    }

    session.addEventListener('select', (e) => this._onSelect(e));
    session.addEventListener('end', () => this._ended());

    this.map.clear();
    this.actor.attach(this.scene, this.map);
    this.actor.brain.onEvent = (type, info) => this._onCatEvent(type, info);
    this.hud.status('床や机を映しながら、スマホをゆっくり左右に動かしてください。');
  }

  _setupLightEstimation() {
    try {
      const xrLight = new XREstimatedLight(this.renderer);
      xrLight.addEventListener('estimationstart', () => {
        this.scene.add(xrLight);
        this.defaultLights.hemi.visible = false;
        this.defaultLights.dir.visible = false;
        if (xrLight.environment) this.scene.environment = xrLight.environment;
      });
      xrLight.addEventListener('estimationend', () => {
        this.scene.remove(xrLight);
        this.defaultLights.hemi.visible = true;
        this.defaultLights.dir.visible = true;
        this.scene.environment = this.defaultEnv;
      });
      this.xrLight = xrLight;
    } catch (e) {
      console.warn('light estimation unavailable', e);
    }
  }

  stop() {
    this.session?.end().catch(() => {});
  }

  _ended() {
    this.centerSource?.cancel?.();
    this.scanSources?.forEach((s) => s.cancel?.());
    this.session = null;
    this.actor.brain.onEvent = null;
    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); this.points = null; }
    this.planeSeen.clear();
    this.onEnd?.();
  }

  exit() {}

  resize() {}

  update(dt, frame) {
    if (!frame || !this.session || !this.centerSource) return;
    const ref = this.renderer.xr.getReferenceSpace();
    const vp = frame.getViewerPose(ref);
    if (vp) this.camPos.set(vp.transform.position.x, vp.transform.position.y, vp.transform.position.z);

    // --- 中央レティクル ---
    this.reticleHit = null;
    const center = frame.getHitTestResults(this.centerSource)[0];
    if (center) {
      const m = center.getPose(ref)?.transform.matrix;
      if (m && m[5] > 0.85) {
        this.reticle.matrix.fromArray(m);
        this.reticleHit = new THREE.Vector3(m[12], m[13], m[14]);
        this.map.addHit(m[12], m[13], m[14]);
      }
    }
    this.reticle.visible = !!this.reticleHit && !this.actor.spawned;

    // --- 周囲のスキャン光線 ---
    for (const src of this.scanSources) {
      const r = frame.getHitTestResults(src)[0];
      if (!r) continue;
      const m = r.getPose(ref)?.transform.matrix;
      if (m && m[5] > 0.88) this.map.addHit(m[12], m[13], m[14]);
    }

    // --- 平面検出（対応端末のみ。Quest などは「table」等のラベル付き）---
    let planes = null;
    try { planes = frame.detectedPlanes; } catch { planes = null; }
    if (planes) {
      for (const plane of planes) {
        if (plane.orientation !== 'horizontal') continue;
        if (this.planeSeen.get(plane) === plane.lastChangedTime) continue;
        this.planeSeen.set(plane, plane.lastChangedTime);
        const pose = frame.getPose(plane.planeSpace, ref);
        if (!pose) continue;
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        if (m.elements[5] < 0.85) continue; // 天井など下向きの面は除外
        const pts = plane.polygon.map((p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m));
        const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        this.map.addPolygon(pts, y, plane.semanticLabel || null);
      }
    }

    this.maintainT -= dt;
    if (this.maintainT <= 0) {
      this.maintainT = 0.3;
      this.map.maintain();
      if (this.showPoints && this.map.version !== this.pointsVer) {
        this.pointsVer = this.map.version;
        const p = this.map.buildPoints(this.points);
        if (!this.points) { this.points = p; this.scene.add(p); }
      }
      if (!this.actor.spawned) {
        this.hud.status(this.reticleHit
          ? '猫を出したい場所（床がおすすめ）をタップしてください。'
          : '床や机を映しながら、スマホをゆっくり左右に動かしてください。');
      }
    }
    if (this.points) this.points.visible = this.showPoints;

    this.actor.update(dt, { camPos: this.camPos });
    this.actor.voice?.updateListener(this.camera);
  }

  _onSelect(e) {
    this.actor.voice?.unlock();
    const ref = this.renderer.xr.getReferenceSpace();
    if (!this.actor.spawned) {
      if (!this.reticleHit) { this.hud.toast('まだ面が見つかっていません'); return; }
      this.map.maintain();
      const L = this.map.levelAt(this.reticleHit.y, 0.08) ?? this.map.addHit(this.reticleHit.x, this.reticleHit.y, this.reticleHit.z, 4);
      this.actor.spawn(this.reticleHit.clone(), L);
      this.hud.status('タップした場所に呼べます。猫をタップするとなでられます。机などを映すと飛び乗りに行きます。');
      return;
    }
    const pose = e.frame.getPose(e.inputSource.targetRaySpace, ref);
    if (!pose) return;
    const o = pose.transform.position, q = pose.transform.orientation;
    const origin = new THREE.Vector3(o.x, o.y, o.z);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    if (this.actor.hit(origin, dir)) { this.actor.brain.pet(); return; }
    const h = this.map.raycast(origin, dir);
    if (h) {
      const ok = this.actor.brain.callTo(h.point, h.level);
      this.hud.status(ok ? 'おいで！' : 'そこへは行けないみたい…（まわりの面をもう少し映してみてください）');
    }
  }

  callToUser() {
    const ok = this.actor.brain.callToUser();
    this.hud.status(ok ? 'おいで〜' : 'ここまでは来られないみたい');
  }

  _announce(L) {
    const floor = this.map.floor();
    const label = L.semantic ? SEMANTIC_JA[L.semantic] ?? L.semantic : null;
    if (!floor || L === floor) { this.hud.toast(`${label ?? '床'}を見つけました`); return; }
    const h = Math.round((L.y - floor.y) * 100);
    if (h > 12) {
      const name = label ?? (h > 55 && h < 95 ? '机' : h >= 30 && h <= 55 ? '椅子やソファ' : '台');
      this.hud.toast(`${name}（高さ ${h}cm）を見つけました`);
    }
    this.actor.brain.notifySurface(L);
  }

  _onCatEvent(type, info) {
    if (type === 'jump' && info.up) this.hud.status(`ぴょん！ 高さ ${Math.round(info.height * 100)}cm に飛び乗ります`);
    if (type === 'jump' && !info.up) this.hud.status('飛び降ります');
    if (type === 'pet') this.hud.status('ゴロゴロ…');
    if (type === 'noRoute') this.hud.status('飛び乗りたいけど届かないみたい。机の手前の床も映してあげてください。');
  }
}
