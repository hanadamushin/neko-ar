import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SurfaceMap } from './SurfaceMap.js';
import { addLights, getEnvironment, onTap, cssVar } from './common.js';

// ホーム画面の小さなステージ。丸い床とクッションがあり、猫がくつろぐ。
export class PreviewMode {
  constructor(renderer, actor) {
    this.renderer = renderer;
    this.actor = actor;
    this.scene = new THREE.Scene();
    this.scene.environment = getEnvironment(renderer);
    this.scene.environmentIntensity = 0.55;
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.03, 30);
    this.camera.position.set(0.95, 0.62, 1.35);
    addLights(this.scene);

    const floorMat = new THREE.MeshStandardMaterial({ color: '#e6d6c3', roughness: 1 });
    this.floorMesh = new THREE.Mesh(new THREE.CircleGeometry(0.95, 64), floorMat);
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.scene.add(this.floorMesh);

    const cushion = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.22, 0.16, 40),
      new THREE.MeshStandardMaterial({ color: '#8fb3a8', roughness: 0.95 }),
    );
    cushion.position.set(0.42, 0.08, -0.28);
    this.scene.add(cushion);
    this.cushion = cushion;

    this.map = new SurfaceMap({ cell: 0.06, minCells: 6 });
    const c = this.map.cell;
    for (let x = -0.9; x <= 0.9; x += c) {
      for (let z = -0.9; z <= 0.9; z += c) {
        const inCushion = Math.hypot(x - 0.42, z + 0.28) < 0.26;
        if (Math.hypot(x, z) < 0.86 && !inCushion) this.map.addHit(x, 0, z, 3);
        if (Math.hypot(x - 0.42, z + 0.28) < 0.17) this.map.addHit(x, 0.16, z, 3);
      }
    }
    this.map.maintain();
  }

  enter(host) {
    this.renderer.setClearColor(new THREE.Color(cssVar('--stage', '#f3e9dc')), 1);
    this.actor.attach(this.scene, this.map);
    this.actor.setScale(1);
    const floor = this.map.floor();
    this.actor.spawn(new THREE.Vector3(-0.1, 0, 0.1), floor);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.16, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 3;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    this.offTap = onTap(this.renderer.domElement, (ndc) => this.tap(ndc));
  }

  exit() {
    this.controls?.dispose();
    this.offTap?.();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    this.controls?.update();
    this.actor.update(dt, { camPos: this.camera.position });
    this.actor.voice?.updateListener(this.camera);
  }

  tap(ndc) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    if (this.actor.hit(ray.ray.origin, ray.ray.direction)) { this.actor.voice?.unlock(); this.actor.brain.pet(); return; }
    const h = this.map.raycast(ray.ray.origin, ray.ray.direction);
    if (h) this.actor.brain.callTo(h.point, h.level);
  }
}
