import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

let envTex = null;
export function getEnvironment(renderer) {
  if (!envTex) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }
  return envTex;
}

export function addLights(scene, { key = 1.7, fill = 1.4 } = {}) {
  const hemi = new THREE.HemisphereLight(0xfff4e6, 0x7d6c5c, fill);
  const dir = new THREE.DirectionalLight(0xffffff, key);
  dir.position.set(1.2, 2.6, 1.4);
  scene.add(hemi, dir);
  return { hemi, dir };
}

// タップ（ドラッグではない短いクリック）だけを拾う
export function onTap(el, cb) {
  let down = null;
  const pd = (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const pu = (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const dt = performance.now() - down.t;
    down = null;
    if (moved > 8 || dt > 450) return;
    const r = el.getBoundingClientRect();
    cb(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
  };
  el.addEventListener('pointerdown', pd);
  el.addEventListener('pointerup', pu);
  return () => { el.removeEventListener('pointerdown', pd); el.removeEventListener('pointerup', pu); };
}

export function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
