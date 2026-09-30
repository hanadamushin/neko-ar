import * as THREE from 'three';
import { PART, createFurMaterial, createEyeMaterial, applyFurAppearance } from './materials.js';

// プリミティブを組み合わせた、関節付きの手続き的な猫モデル。
// 単位はメートル（実寸の猫）。+Z が頭の向き、root の原点は足元の地面。
export class CatModel {
  constructor(appearance) {
    this.root = new THREE.Group();
    this.root.name = 'cat';
    this.scaleGroup = new THREE.Group();
    this.root.add(this.scaleGroup);

    this.furMat = createFurMaterial();
    this.earMat = createFurMaterial(this.furMat, THREE.DoubleSide);
    this.eyeMat = createEyeMaterial();
    this.noseMat = new THREE.MeshStandardMaterial({ color: '#d98a8f', roughness: 0.45 });
    this.whiskerMat = new THREE.LineBasicMaterial({ color: '#f4f1ea', transparent: true, opacity: 0.8 });
    this.proxyMat = new THREE.MeshBasicMaterial({ visible: false });

    this.appearance = null;
    this.build(appearance);
  }

  setAppearance(ap, rebuild) {
    if (rebuild) this.build(ap);
    else this._applyColors(ap);
  }

  _applyColors(ap) {
    this.appearance = ap;
    applyFurAppearance(this.furMat, ap);
    this.eyeMat.userData.uniforms.uIris.value.set(ap.eyeColor);
    this.noseMat.color.set(ap.noseColor);
  }

  build(ap) {
    this._disposeRig();
    const ls = ap.legLength, ch = ap.chubby, es = ap.earSize, tl = ap.tailLength, fl = ap.furLength;
    const fluff = 1 + fl * 0.12;
    const tailFluff = 1 + fl * 0.7;
    const furMeshes = [];
    const fur = (geo, part, mat = this.furMat) => {
      const n = geo.attributes.position.count;
      geo.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
      const m = new THREE.Mesh(geo, mat);
      furMeshes.push(m);
      return m;
    };

    const H = 0.037 + 0.195 * ls;
    const pawH = 0.0195 * 0.62;
    const dims = (this.dims = { H, pawH, ls });

    // ---- 胴体 ----
    const body = new THREE.Group();
    body.name = 'body';
    body.position.set(0, H, 0);
    body.rotation.order = 'YXZ';
    this.scaleGroup.add(body);
    this.body = body;

    const profile = [
      [0.001, -0.195], [0.034, -0.19], [0.057, -0.178], [0.071, -0.16], [0.079, -0.135], [0.082, -0.1],
      [0.079, -0.06], [0.075, -0.02], [0.077, 0.03], [0.081, 0.075], [0.082, 0.108], [0.077, 0.14],
      [0.064, 0.165], [0.043, 0.182], [0.001, 0.19],
    ].map(([r, z]) => new THREE.Vector2(r, z));
    const torsoGeo = new THREE.LatheGeometry(profile, 28);
    torsoGeo.rotateX(Math.PI / 2);
    {
      const pos = torsoGeo.attributes.position;
      const wx = (0.8 + ch * 0.24) * fluff, wy = (1.0 + ch * 0.05) * fluff, sag = 1 + ch * 0.3;
      for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i) * wx, y = pos.getY(i) * wy;
        if (y < 0) y *= sag;
        // 背中のゆるいカーブ
        const z = pos.getZ(i);
        y += 0.006 * Math.cos(z * 9);
        pos.setXYZ(i, x, y, z);
      }
      torsoGeo.computeVertexNormals();
    }
    body.add(fur(torsoGeo, PART.TORSO));

    for (const s of [1, -1]) {
      const shoulder = fur(new THREE.SphereGeometry(0.042 * fluff, 16, 12), PART.TORSO);
      shoulder.position.set(0.036 * s, -0.02, 0.108);
      shoulder.scale.set(0.62, 1.1, 1.05);
      body.add(shoulder);
      const haunch = fur(new THREE.SphereGeometry(0.056 * fluff * (1 + ch * 0.1), 18, 14), PART.TORSO);
      haunch.position.set(0.04 * s, -0.012, -0.112);
      haunch.scale.set(0.6, 1.08, 1.12);
      body.add(haunch);
    }

    // ---- 首と頭 ----
    const NECK_TILT = 0.72;
    const neck = new THREE.Group();
    neck.position.set(0, 0.035, 0.132);
    neck.rotation.order = 'YXZ';
    neck.rotation.x = NECK_TILT;
    body.add(neck);
    const Ln = 0.075;
    const neckGeo = taperCapsule(0.038 * fluff, 0.047 * fluff, Ln, 16, 5);
    neckGeo.translate(0, Ln, 0);
    neck.add(fur(neckGeo, PART.NECK));
    if (fl > 0.5) {
      const ruff = fur(new THREE.SphereGeometry(0.056 * (0.8 + fl * 0.3), 18, 14), PART.NECK);
      ruff.position.set(0, 0.025, 0.0);
      ruff.scale.set(1.05, 0.9, 0.8);
      neck.add(ruff);
    }

    const head = new THREE.Group();
    head.position.set(0, Ln, 0);
    head.rotation.order = 'YXZ';
    head.rotation.x = -NECK_TILT;
    head.scale.setScalar(1.14);
    neck.add(head);
    const HC = new THREE.Vector3(0, 0.02, 0.028);

    const skull = fur(new THREE.SphereGeometry(0.056, 28, 20), PART.HEAD);
    skull.position.copy(HC);
    skull.scale.set(1.1, 0.93, 1.0);
    head.add(skull);
    for (const s of [1, -1]) {
      const cheek = fur(new THREE.SphereGeometry(0.034 * (1 + fl * 0.15), 16, 12), PART.HEAD);
      cheek.position.copy(HC).add(new THREE.Vector3(0.03 * s, -0.017, 0.02));
      cheek.scale.set(1, 0.85, 0.9);
      head.add(cheek);
      const pad = fur(new THREE.SphereGeometry(0.0185, 14, 10), PART.MUZZLE);
      pad.position.copy(HC).add(new THREE.Vector3(0.0125 * s, -0.024, 0.047));
      head.add(pad);
    }
    const bridge = fur(new THREE.SphereGeometry(0.019, 14, 10), PART.HEAD);
    bridge.position.copy(HC).add(new THREE.Vector3(0, -0.004, 0.044));
    bridge.scale.set(0.85, 0.8, 1.0);
    head.add(bridge);
    const chin = fur(new THREE.SphereGeometry(0.015, 12, 8), PART.CHIN);
    chin.position.copy(HC).add(new THREE.Vector3(0, -0.037, 0.038));
    chin.scale.set(1.1, 0.72, 1);
    head.add(chin);

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.0078, 12, 8), this.noseMat);
    nose.position.copy(HC).add(new THREE.Vector3(0, -0.0085, 0.0612));
    nose.scale.set(1.35, 0.75, 0.7);
    head.add(nose);

    this.eyes = [];
    for (const s of [1, -1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0138, 20, 14), this.eyeMat);
      const pivot = new THREE.Group();
      pivot.position.copy(HC).add(new THREE.Vector3(0.0235 * s, 0.004, 0.0425));
      pivot.rotation.set(-0.06, 0.3 * s, 0, 'YXZ');
      pivot.add(eye);
      head.add(pivot);
      this.eyes.push({ pivot, eye, side: s, baseYaw: 0.3 * s });
    }

    this.ears = [];
    for (const s of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.copy(HC).add(new THREE.Vector3(0.03 * s, 0.037, -0.006));
      pivot.rotation.order = 'YXZ';
      const base = { x: -0.12, y: 0.3 * s, z: -0.3 * s };
      pivot.rotation.set(base.x, base.y, base.z);
      const eh = 0.054 * es, er = 0.028 * es;
      const earGeo = new THREE.ConeGeometry(er, eh, 18, 3, true, Math.PI / 2, Math.PI);
      earGeo.translate(0, eh / 2, 0);
      earGeo.scale(1, 1, 0.62);
      const ear = fur(earGeo, PART.EAR, this.earMat);
      pivot.add(ear);
      head.add(pivot);
      this.ears.push({ pivot, base, side: s });
    }

    // ヒゲ
    {
      const pts = [];
      for (const s of [1, -1]) {
        for (let i = 0; i < 3; i++) {
          const o = HC.clone().add(new THREE.Vector3(0.022 * s, -0.024 + i * 0.0035, 0.052));
          const d = new THREE.Vector3(s * 1, 0.12 - i * 0.12, 0.28).normalize().multiplyScalar(0.072);
          pts.push(o, o.clone().add(d));
        }
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      head.add(new THREE.LineSegments(g, this.whiskerMat));
    }

    this.neck = neck;
    this.head = head;
    this.neckTilt = NECK_TILT;
    this.headCenter = HC;

    // ---- 脚 ----
    this.legs = [];
    const legDefs = [
      { name: 'LF', s: 1, front: true },
      { name: 'RF', s: -1, front: true },
      { name: 'LH', s: 1, front: false },
      { name: 'RH', s: -1, front: false },
    ];
    for (const d of legDefs) {
      const L1 = (d.front ? 0.1 : 0.112) * ls;
      const L2 = (d.front ? 0.092 : 0.11) * ls;
      const hip = new THREE.Group();
      hip.position.set((d.front ? 0.036 : 0.04) * d.s, d.front ? -0.035 : -0.025, d.front ? 0.112 : -0.118);
      hip.rotation.order = 'ZXY';
      body.add(hip);
      const rTop = (d.front ? 0.028 : 0.033) * fluff;
      const rMid = (d.front ? 0.02 : 0.021) * fluff;
      const rLow = 0.0165 * fluff;
      hip.add(fur(taperCapsule(rTop, rMid, L1, 14, 4), d.front ? PART.LEG_F_UP : PART.LEG_H_UP));
      const knee = new THREE.Group();
      knee.position.y = -L1;
      hip.add(knee);
      knee.add(fur(taperCapsule(rMid * 0.96, rLow, L2, 14, 4), d.front ? PART.LEG_F_LO : PART.LEG_H_LO));
      const ankle = new THREE.Group();
      ankle.position.y = -L2;
      knee.add(ankle);
      const pawGeo = new THREE.SphereGeometry(0.021 * fluff, 16, 10);
      pawGeo.scale(1, 0.62, 1.3);
      pawGeo.translate(0, 0, 0.007);
      ankle.add(fur(pawGeo, PART.PAW));
      this.legs.push({ ...d, hip, knee, ankle, L1, L2 });
    }

    // ---- しっぽ ----
    const N = 12;
    const segLen = 0.024 * tl;
    const tailRoot = new THREE.Group();
    tailRoot.position.set(0, 0.035, -0.178);
    body.add(tailRoot);
    this.tail = [];
    let parent = tailRoot;
    for (let i = 0; i < N; i++) {
      const j = new THREE.Group();
      if (i > 0) j.position.z = -segLen;
      parent.add(j);
      const r = (0.0165 - 0.0055 * (i / (N - 1))) * tailFluff;
      const g = new THREE.CapsuleGeometry(r, segLen, 4, 10);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, -segLen / 2);
      j.add(fur(g, PART.TAIL));
      this.tail.push(j);
      parent = j;
    }
    dims.tailLen = N * segLen;

    // タップ判定用の見えない当たり判定
    const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), this.proxyMat);
    proxy.scale.set(0.75, 0.9, 1.35);
    proxy.position.set(0, 0.03, 0.02);
    body.add(proxy);
    this.hitProxy = proxy;

    // ---- 休止姿勢の座標を頂点属性に焼き込む（柄が関節の動きに追従する）----
    this.scaleGroup.updateMatrixWorld(true);
    const inv = this.scaleGroup.matrixWorld.clone().invert();
    const M = new THREE.Matrix4();
    const Nm = new THREE.Matrix3();
    const v = new THREE.Vector3();
    for (const m of furMeshes) {
      M.multiplyMatrices(inv, m.matrixWorld);
      Nm.getNormalMatrix(M);
      const pos = m.geometry.attributes.position;
      const nor = m.geometry.attributes.normal;
      const rest = new Float32Array(pos.count * 3);
      const restN = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(M);
        rest.set([v.x, v.y, v.z], i * 3);
        v.fromBufferAttribute(nor, i).applyMatrix3(Nm).normalize();
        restN.set([v.x, v.y, v.z], i * 3);
      }
      m.geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
      m.geometry.setAttribute('aRestN', new THREE.BufferAttribute(restN, 3));
    }
    const u = this.furMat.userData.uniforms;
    u.uHeadC.value.copy(head.localToWorld(HC.clone())).applyMatrix4(inv);
    u.uNose.value.copy(nose.getWorldPosition(new THREE.Vector3())).applyMatrix4(inv);
    u.uTailBase.value.copy(tailRoot.getWorldPosition(new THREE.Vector3())).applyMatrix4(inv);
    u.uTailLen.value = dims.tailLen;

    this.furMeshes = furMeshes;
    this._applyColors(ap);
  }

  _disposeRig() {
    if (!this.body) return;
    this.body.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.scaleGroup.remove(this.body);
    this.body = null;
  }

  // 頭の世界座標（音の定位や視線に使う）
  headWorldPosition(target = new THREE.Vector3()) {
    return this.head.localToWorld(target.copy(this.headCenter));
  }
}

// 上端半径 r0（y=0）から下端半径 r1（y=-len）へ細くなるカプセル
export function taperCapsule(r0, r1, len, radial = 14, capSeg = 4) {
  const pts = [];
  for (let i = 0; i <= capSeg; i++) {
    const a = -Math.PI / 2 + (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r1), -len + Math.sin(a) * r1));
  }
  for (let i = 0; i <= capSeg; i++) {
    const a = (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r0), Math.sin(a) * r0));
  }
  return new THREE.LatheGeometry(pts, radial);
}
