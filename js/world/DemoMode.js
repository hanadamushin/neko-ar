import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SurfaceMap } from './SurfaceMap.js';
import { addLights, getEnvironment, onTap } from './common.js';

// AR 非対応の端末でも同じ行動ロジックを試せる「デモルーム」。
// 仮想の部屋に対してカメラから光線を飛ばし、当たった水平面だけを SurfaceMap に記録する。
// つまり AR のヒットテストと同じ情報の流れで、見回した場所から机や椅子を「発見」していく。
export class DemoMode {
  constructor(renderer, actor, hud) {
    this.renderer = renderer;
    this.actor = actor;
    this.hud = hud;
    this.scene = new THREE.Scene();
    this.scene.environment = getEnvironment(renderer);
    this.scene.environmentIntensity = 0.5;
    this.scene.background = new THREE.Color('#d9cfc4');
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.03, 40);
    this.camera.position.set(1.9, 1.55, 2.3);
    addLights(this.scene, { key: 1.8, fill: 1.3 });

    this.sensors = [];
    this._buildRoom();

    this.map = new SurfaceMap({ cell: 0.08 });
    this.map.onSurface = (L) => this._announce(L);
    this.raycaster = new THREE.Raycaster();
    this.points = null;
    this.showPoints = true;
    this.maintainT = 0;
    this.pointsVer = -1;
  }

  _buildRoom() {
    const S = this.scene;
    const add = (mesh, sensor = true) => { S.add(mesh); if (sensor) this.sensors.push(mesh); return mesh; };
    const box = (w, h, d, color, x, y, z, rough = 0.85) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: rough }));
      m.position.set(x, y, z);
      return add(m);
    };

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.8 }));
    floor.rotation.x = -Math.PI / 2;
    add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: '#efe7dc', roughness: 1 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.6), wallMat);
    back.position.set(0, 1.3, -2.5);
    add(back);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.6), wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-2.5, 1.3, 0);
    add(left);

    const rug = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), new THREE.MeshStandardMaterial({ color: '#c9a98a', roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0.3, 0.003, 0.4);
    add(rug, false);

    // 机（天板 72cm）
    box(1.2, 0.04, 0.6, '#b98b5e', -0.9, 0.7, -1.9, 0.6);
    for (const [dx, dz] of [[-0.56, -0.26], [0.56, -0.26], [-0.56, 0.26], [0.56, 0.26]]) box(0.04, 0.68, 0.04, '#6d5037', -0.9 + dx, 0.34, -1.9 + dz);
    // 椅子（座面 45cm）
    box(0.42, 0.05, 0.42, '#4f6b73', -0.55, 0.425, -1.25);
    box(0.42, 0.45, 0.04, '#4f6b73', -0.55, 0.675, -1.05);
    for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) box(0.03, 0.4, 0.03, '#2f3c40', -0.55 + dx, 0.2, -1.25 + dz);
    // 段ボール箱（32cm）
    box(0.45, 0.32, 0.35, '#c79a62', 1.0, 0.16, -0.6, 1);
    // 棚（1m）
    box(0.9, 1.0, 0.38, '#8a7f73', 1.4, 0.5, -2.3);
    // 棚の上の小物（飾り）
    box(0.12, 0.2, 0.12, '#d86f4f', 1.75, 1.1, -2.35);
  }

  enter() {
    this.renderer.setClearColor(0x000000, 1);
    this.map.clear();
    this.actor.attach(this.scene, this.map);
    this.actor.brain.onEvent = (type, info) => this._onCatEvent(type, info);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-0.1, 0.35, -0.8);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 6;
    this.offTap = onTap(this.renderer.domElement, (ndc) => this.tap(ndc));
    this.hud.status('部屋を見回すと、床や机などの水平な面が見つかります（ドラッグで視点移動）。');
    this.hud.showScan(true);
  }

  exit() {
    this.controls?.dispose();
    this.offTap?.();
    this.actor.brain.onEvent = null;
    this.hud.showScan(false);
    if (this.points) { this.scene.remove(this.points); this.points = null; }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // カメラから光線を飛ばして水平面を見つける（AR のヒットテストの代わり）
  _sense(n = 28) {
    const ndc = new THREE.Vector2();
    const nrm = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      ndc.set(Math.random() * 1.8 - 0.9, Math.random() * 1.8 - 0.9);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObjects(this.sensors, false)[0];
      if (!hit || !hit.face) continue;
      nrm.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (nrm.y > 0.9) this.map.addHit(hit.point.x, hit.point.y, hit.point.z);
    }
  }

  scanAll() {
    // 真上から格子状に光線を落として部屋全体を記録
    const down = new THREE.Vector3(0, -1, 0);
    const nrm = new THREE.Vector3();
    for (let x = -2.45; x <= 2.45; x += 0.04) {
      for (let z = -2.45; z <= 2.45; z += 0.04) {
        this.raycaster.set(new THREE.Vector3(x, 2.5, z), down);
        const hit = this.raycaster.intersectObjects(this.sensors, false)[0];
        if (!hit) continue;
        nrm.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        if (nrm.y > 0.9) this.map.addHit(hit.point.x, hit.point.y, hit.point.z, 2);
      }
    }
  }

  update(dt) {
    this.controls?.update();
    this._sense();
    this.maintainT -= dt;
    if (this.maintainT <= 0) {
      this.maintainT = 0.25;
      this.map.maintain();
      if (!this.actor.spawned) {
        const floor = this.map.floor();
        if (floor && floor.cells.size > 60) {
          const c = this.map.nearestWalkable(floor, 0.3, 0.5, 12);
          if (c) {
            this.actor.spawn(this.map.cellCenter(c, floor.y), floor);
            this.hud.status('猫が来ました。タップした場所に呼べます。猫をタップするとなでられます。');
          }
        }
      }
      if (this.showPoints && this.map.version !== this.pointsVer) {
        this.pointsVer = this.map.version;
        const p = this.map.buildPoints(this.points);
        if (!this.points) { this.points = p; this.scene.add(p); }
      }
    }
    if (this.points) this.points.visible = this.showPoints;
    this.actor.update(dt, { camPos: this.camera.position });
    this.actor.voice?.updateListener(this.camera);
  }

  _announce(L) {
    const floor = this.map.floor();
    if (!floor || L === floor) { this.hud.toast('床を見つけました'); return; }
    const h = Math.round((L.y - floor.y) * 100);
    if (h > 10) this.hud.toast(`高さ ${h}cm の面を見つけました`);
    this.actor.brain.notifySurface(L);
  }

  _onCatEvent(type, info) {
    if (type === 'jump' && info.up) this.hud.status(`ぴょん！ 高さ ${Math.round(info.height * 100)}cm に飛び乗ります`);
    if (type === 'jump' && !info.up) this.hud.status('飛び降ります');
    if (type === 'pet') this.hud.status('ゴロゴロ…');
  }

  tap(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    this.actor.voice?.unlock();
    if (this.actor.spawned && this.actor.hit(origin, direction)) { this.actor.brain.pet(); return; }
    const hit = this.raycaster.intersectObjects(this.sensors, false)[0];
    if (!hit || !this.actor.spawned) return;
    const L = this.map.levelAt(hit.point.y, 0.06);
    if (!L) { this.hud.status('まだその面は見つかっていません。もう少し見回してください。'); return; }
    const ok = this.actor.brain.callTo(hit.point, L);
    this.hud.status(ok ? 'おいで！' : 'そこへは行けないみたい…');
  }

  callToUser() {
    const ok = this.actor.brain.callToUser();
    this.hud.status(ok ? 'おいで〜' : 'ここまでは来られないみたい');
  }
}

function plankTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    const l = 62 + Math.random() * 8;
    g.fillStyle = `hsl(30, 35%, ${l}%)`;
    g.fillRect(0, i * 64, 512, 64);
    g.fillStyle = 'rgba(80,50,30,0.25)';
    g.fillRect(0, i * 64, 512, 2);
    const off = Math.random() * 512;
    g.fillRect(off, i * 64, 2, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
