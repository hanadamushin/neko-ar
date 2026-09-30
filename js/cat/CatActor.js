import * as THREE from 'three';
import { CatModel } from './CatModel.js';
import { CatMotor } from './CatMotor.js';
import { CatBrain } from './CatBrain.js';
import { shapeChanged } from './appearance.js';

// モデル＋運動系＋行動系＋接地影をひとまとめにした「猫」
export class CatActor {
  constructor(appearance, voice) {
    this.appearance = appearance;
    this.model = new CatModel(appearance);
    this.motor = new CatMotor(this.model);
    this.brain = new CatBrain({ model: this.model, motor: this.motor, voice, map: null });
    this.voice = voice;
    this.scale = 1;

    this.group = new THREE.Group();
    this.group.add(this.model.root);
    this.shadow = makeBlobShadow();
    this.group.add(this.shadow);
    this.raycaster = new THREE.Raycaster();
  }

  setAppearance(ap) {
    const rebuild = shapeChanged(this.appearance, ap);
    this.appearance = ap;
    this.model.setAppearance(ap, rebuild);
    if (rebuild) this.motor.rebind(this.model);
  }

  setScale(s) {
    this.scale = s;
    this.model.scaleGroup.scale.setScalar(s);
    this.brain.scale = s;
  }

  attach(scene, map) {
    scene.add(this.group);
    this.brain.setMap(map);
    this.group.visible = false;
  }

  spawn(point, level) {
    this.brain.spawn(point, level);
    this.group.visible = true;
    this.motor.rebind(this.model);
  }

  get spawned() { return this.brain.spawned; }

  update(dt, ctx) {
    dt = Math.min(dt, 0.05);
    this.brain.update(dt, ctx);
    if (!this.brain.spawned) return;
    this.motor.update(dt, this.scale);
    this._updateShadow();
  }

  _updateShadow() {
    const map = this.brain.map;
    const p = this.brain.pos;
    let gy = this.brain.level ? this.brain.level.y : p.y;
    if (map) {
      // 真下にある一番高い面に影を落とす
      let best = -Infinity;
      for (const L of map.significant()) {
        if (L.y <= p.y + 0.02 && L.y > best && map.isWalkable(L, p.x, p.z)) best = L.y;
      }
      if (best > -Infinity) gy = best;
    }
    const h = Math.max(0, p.y - gy);
    const s = this.scale * (1 + h * 0.8);
    this.shadow.position.set(p.x, gy + 0.003, p.z);
    this.shadow.rotation.set(-Math.PI / 2, 0, this.brain.yaw);
    this.shadow.scale.set(0.26 * s, 0.46 * s, 1);
    this.shadow.material.opacity = 0.5 * Math.max(0.15, 1 - h * 1.6);
  }

  // 画面タップが猫に当たったか
  hit(origin, dir) {
    if (!this.spawned) return false;
    this.raycaster.set(origin, dir);
    this.model.root.updateMatrixWorld(true);
    if (this.raycaster.intersectObject(this.model.hitProxy, false).length > 0) return true;
    // 小さく見えている時でもタップしやすいよう、体の中心から少し離れていても当たりにする
    const center = this.model.body.getWorldPosition(new THREE.Vector3());
    return this.raycaster.ray.distanceToPoint(center) < 0.22 * this.scale;
  }
}

function makeBlobShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  mesh.renderOrder = 2;
  return mesh;
}
