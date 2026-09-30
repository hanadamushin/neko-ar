import * as THREE from 'three';

// 水平面の地図。
// AR のヒットテスト結果（または平面検出のポリゴン）を高さごとの「レベル」に分け、
// 各レベルを 8cm グリッドで管理する。床・机・椅子などが別々のレベルになる。
// 猫はこの地図の上だけを歩き、レベル間は「ジャンプ」で移動する。

const OFF = 20000;
const keyOf = (ix, iz) => (ix + OFF) * 40000 + (iz + OFF);
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class SurfaceMap {
  constructor({ cell = 0.08, levelTol = 0.05, minCells = 8 } = {}) {
    this.cell = cell;
    this.levelTol = levelTol;
    this.minCells = minCells;
    this.levels = [];
    this.nextId = 1;
    this.version = 0;
    this.onSurface = null; // (level) => void : 新しい面が十分な大きさになった時
  }

  clear() {
    this.levels = [];
    this.version++;
  }

  // ---------- 入力 ----------
  addHit(x, y, z, w = 1, semantic = null) {
    let L = this._levelFor(y);
    if (!L) L = this._newLevel(y);
    const cap = Math.min(L.wsum, 400);
    L.y = (L.y * cap + y * w) / (cap + w);
    L.wsum += w;
    this._mark(L, Math.floor(x / this.cell), Math.floor(z / this.cell), w);
    if (semantic) L.semantic = semantic;
    return L;
  }

  // 平面検出のポリゴン（世界座標の {x,z} 配列）をまとめて塗る
  addPolygon(points, y, semantic = null) {
    if (points.length < 3) return null;
    let L = this._levelFor(y);
    if (!L) L = this._newLevel(y);
    L.y = L.wsum > 0 ? (L.y * 0.7 + y * 0.3) : y;
    L.wsum += 20;
    if (semantic) L.semantic = semantic;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++) {
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        if (pointInPolygon((ix + 0.5) * c, (iz + 0.5) * c, points)) this._mark(L, ix, iz, 2);
      }
    }
    return L;
  }

  _mark(L, ix, iz, w) {
    const k = keyOf(ix, iz);
    const cell = L.cells.get(k);
    if (cell) cell.n += w;
    else {
      L.cells.set(k, { ix, iz, n: w });
      L.ver++;
      this.version++;
    }
  }

  _levelFor(y) {
    let best = null, bd = this.levelTol;
    for (const L of this.levels) {
      const d = Math.abs(L.y - y);
      if (d < bd) { bd = d; best = L; }
    }
    return best;
  }

  _newLevel(y) {
    const L = { id: this.nextId++, y, wsum: 0, cells: new Map(), ver: 0, semantic: null, announced: false, mergedInto: null };
    this.levels.push(L);
    return L;
  }

  // 近すぎるレベルの統合と、新しい面の通知
  maintain() {
    this.levels.sort((a, b) => a.y - b.y);
    for (let i = 0; i < this.levels.length - 1; i++) {
      const a = this.levels[i], b = this.levels[i + 1];
      if (Math.abs(a.y - b.y) < this.levelTol * 0.8) {
        const [big, small] = a.cells.size >= b.cells.size ? [a, b] : [b, a];
        for (const [k, c] of small.cells) {
          const e = big.cells.get(k);
          if (e) e.n += c.n; else big.cells.set(k, c);
        }
        big.y = (big.y * big.cells.size + small.y * small.cells.size) / (big.cells.size + small.cells.size);
        big.ver++;
        big.semantic ||= small.semantic;
        big.announced ||= small.announced;
        small.mergedInto = big;
        this.levels.splice(this.levels.indexOf(small), 1);
        this.version++;
        i--;
      }
    }
    for (const L of this.levels) {
      if (!L.announced && L.cells.size >= this.minCells * 2) {
        L.announced = true;
        this.onSurface?.(L);
      }
    }
  }

  resolve(L) {
    while (L && L.mergedInto) L = L.mergedInto;
    return L && this.levels.includes(L) ? L : null;
  }

  significant() {
    return this.levels.filter((L) => L.cells.size >= this.minCells);
  }

  floor() {
    let f = null;
    for (const L of this.levels) if (L.cells.size >= this.minCells && (!f || L.y < f.y)) f = L;
    return f;
  }

  levelAt(y, tol = 0.12) {
    let best = null, bd = tol;
    for (const L of this.significant()) {
      const d = Math.abs(L.y - y);
      if (d < bd) { bd = d; best = L; }
    }
    return best;
  }

  // ---------- 歩行可能セル ----------
  // 観測されたセルを「クロージング」して小さな穴を埋めたもの
  walkable(L) {
    if (L._wkVer === L.ver) return L._wk;
    // スキャン中はセルが毎フレーム増えるので、再計算は 0.4 秒に 1 回まで
    const now = performance.now();
    if (L._wk && now - L._wkTime < 400) return L._wk;
    L._wkTime = now;
    const dil = new Map();
    for (const c of L.cells.values()) {
      dil.set(keyOf(c.ix, c.iz), c);
      for (const [dx, dz] of NB8) {
        const k = keyOf(c.ix + dx, c.iz + dz);
        if (!dil.has(k)) dil.set(k, { ix: c.ix + dx, iz: c.iz + dz, n: 0 });
      }
    }
    const wk = new Map();
    for (const [k, c] of dil) {
      let all = true;
      for (const [dx, dz] of NB8) if (!dil.has(keyOf(c.ix + dx, c.iz + dz))) { all = false; break; }
      if (all) wk.set(k, c);
    }
    for (const [k, c] of L.cells) wk.set(k, c);
    L._wk = wk;
    L._wkArr = [...wk.values()];
    L._wkVer = L.ver;
    return wk;
  }

  isWalkable(L, x, z) {
    return this.walkable(L).has(keyOf(Math.floor(x / this.cell), Math.floor(z / this.cell)));
  }

  neighborsIn(wk, c) {
    let n = 0;
    for (const [dx, dz] of NB8) if (wk.has(keyOf(c.ix + dx, c.iz + dz))) n++;
    return n;
  }

  cellCenter(c, y) {
    return new THREE.Vector3((c.ix + 0.5) * this.cell, y, (c.iz + 0.5) * this.cell);
  }

  nearestWalkable(L, x, z, maxR = 6) {
    const wk = this.walkable(L);
    const ix0 = Math.floor(x / this.cell), iz0 = Math.floor(z / this.cell);
    if (wk.has(keyOf(ix0, iz0))) return wk.get(keyOf(ix0, iz0));
    let best = null, bd = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const c = wk.get(keyOf(ix0 + dx, iz0 + dz));
          if (c) { const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = c; } }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // ---------- 経路探索 ----------
  findPath(L, from, to) {
    const wk = this.walkable(L);
    const s = this.nearestWalkable(L, from.x, from.z, 5);
    const g = this.nearestWalkable(L, to.x, to.z, 5);
    if (!s || !g) return null;
    const sk = keyOf(s.ix, s.iz), gk = keyOf(g.ix, g.iz);
    const open = new MinHeap();
    const gScore = new Map([[sk, 0]]);
    const came = new Map();
    const h = (c) => {
      const dx = Math.abs(c.ix - g.ix), dz = Math.abs(c.iz - g.iz);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    };
    open.push(sk, h(s));
    const closed = new Set();
    let iter = 0;
    while (open.size && iter++ < 30000) {
      const k = open.pop();
      if (k === gk) break;
      if (closed.has(k)) continue;
      closed.add(k);
      const c = wk.get(k);
      for (const [dx, dz] of NB8) {
        const nk = keyOf(c.ix + dx, c.iz + dz);
        const n = wk.get(nk);
        if (!n || closed.has(nk)) continue;
        // 斜め移動で角をすり抜けない
        if (dx && dz && (!wk.has(keyOf(c.ix + dx, c.iz)) || !wk.has(keyOf(c.ix, c.iz + dz)))) continue;
        const ng = gScore.get(k) + (dx && dz ? 1.414 : 1);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, k);
          open.push(nk, ng + h(n));
        }
      }
    }
    if (sk !== gk && !came.has(gk)) return null;
    const cells = [];
    for (let k = gk; k !== undefined; k = came.get(k)) {
      cells.push(wk.get(k));
      if (k === sk) break;
    }
    cells.reverse();
    const pts = cells.map((c) => this.cellCenter(c, L.y));
    // 目的地はセル中心ではなく指定点に（歩ける場合）
    if (this.isWalkable(L, to.x, to.z)) pts[pts.length - 1] = new THREE.Vector3(to.x, L.y, to.z);
    return this._smooth(L, [new THREE.Vector3(from.x, L.y, from.z), ...pts]);
  }

  _los(L, a, b) {
    const d = a.distanceTo(b);
    const n = Math.ceil(d / (this.cell * 0.5));
    const p = new THREE.Vector3();
    for (let i = 1; i < n; i++) {
      p.lerpVectors(a, b, i / n);
      if (!this.isWalkable(L, p.x, p.z)) return false;
    }
    return true;
  }

  _smooth(L, pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this._los(L, pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  pathLength(path) {
    let s = 0;
    for (let i = 1; i < path.length; i++) s += path[i - 1].distanceTo(path[i]);
    return s;
  }

  randomTarget(L, from, minD = 0.3, maxD = 1.5) {
    const wk = this.walkable(L);
    const arr = L._wkArr;
    if (!arr?.length) return null;
    for (let tries = 0; tries < 30; tries++) {
      const c = arr[(Math.random() * arr.length) | 0];
      if (this.neighborsIn(wk, c) < 5) continue; // 縁ぎりぎりは避ける
      const p = this.cellCenter(c, L.y);
      p.x += (Math.random() - 0.5) * this.cell * 0.8;
      p.z += (Math.random() - 0.5) * this.cell * 0.8;
      const d = Math.hypot(p.x - from.x, p.z - from.z);
      if (d < minD || d > maxD) continue;
      const path = this.findPath(L, from, p);
      if (path) return { point: p, path };
    }
    return null;
  }

  // ---------- ジャンプ計画 ----------
  // from レベルの fromPos から to レベルへ跳べる「踏み切り点」と「着地点」を探す
  planJump(fromL, fromPos, toL) {
    const dh = toL.y - fromL.y;
    if (Math.abs(dh) < 0.1 || dh > 1.3 || dh < -1.7) return null;
    const up = dh > 0;
    const upper = up ? toL : fromL;
    const lower = up ? fromL : toL;
    const U = this.walkable(upper), Lw = this.walkable(lower);
    const c = this.cell;
    const minH = 0.1, maxH = up ? 0.6 : 0.7;
    const rad = Math.ceil(maxH / c);
    // 下側の地点の真上に別の面（机・椅子の座面など）があると、跳ぶ途中でぶつかる
    const covers = this.significant().filter((o) => o !== lower && o.y > lower.y + 0.08);
    const underUpper = (ix, iz) => {
      for (const o of covers) {
        // 飛び乗る時は頭がぶつからないよう、目標の面から少し離れて踏み切る
        const r = up && o === upper ? 2 : 1;
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (o.cells.has(keyOf(ix + dx, iz + dz))) return true;
      }
      return false;
    };
    const cands = [];
    for (const u of upper._wkArr) {
      const nu = this.neighborsIn(U, u);
      if (up && nu < 6) continue;   // 着地は縁から少し内側
      if (!up && nu > 7) continue;  // 飛び降りは縁から
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const l = Lw.get(keyOf(u.ix + dx, u.iz + dz));
          if (!l) continue;
          const hd = Math.hypot(dx, dz) * c;
          if (hd < minH || hd > maxH) continue;
          if (underUpper(l.ix, l.iz)) continue;
          if (!up && this.neighborsIn(Lw, l) < 6) continue;
          const lowP = this.cellCenter(l, lower.y), upP = this.cellCenter(u, upper.y);
          const start = up ? lowP : upP;
          const cost = Math.hypot(start.x - fromPos.x, start.z - fromPos.z) + 1.2 * Math.abs(hd - (up ? 0.38 : 0.3)) + (8 - nu) * 0.02;
          cands.push({ cost, lowP, upP });
        }
      }
    }
    cands.sort((a, b) => a.cost - b.cost);
    for (const cd of cands.slice(0, 8)) {
      const takeoff = up ? cd.lowP : cd.upP;
      const landing = up ? cd.upP : cd.lowP;
      const path = this.findPath(fromL, fromPos, takeoff);
      if (!path) continue;
      // 着地は踏み切り→着地方向に少し奥へ
      const dir = new THREE.Vector3(landing.x - takeoff.x, 0, landing.z - takeoff.z).normalize();
      const inward = landing.clone().addScaledVector(dir, up ? 0.06 : 0.04);
      const toWk = this.walkable(toL);
      const land = toWk.has(keyOf(Math.floor(inward.x / c), Math.floor(inward.z / c))) ? inward : landing;
      return { takeoff, landing: land, path, up, dh };
    }
    return null;
  }

  // 目標レベルへの行き方（直接 or 1回乗り継ぎ）
  planRoute(fromL, fromPos, toL) {
    const direct = this.planJump(fromL, fromPos, toL);
    if (direct) return [{ ...direct, to: toL }];
    for (const mid of this.significant()) {
      if (mid === fromL || mid === toL) continue;
      const a = this.planJump(fromL, fromPos, mid);
      if (!a) continue;
      const b = this.planJump(mid, a.landing, toL);
      if (b) return [{ ...a, to: mid }, { ...b, to: toL }];
    }
    return null;
  }

  // 画面タップなどのレイと面の交差
  raycast(origin, dir) {
    let best = null;
    if (dir.y > -1e-3) return null;
    for (const L of this.significant()) {
      const t = (L.y - origin.y) / dir.y;
      if (t <= 0 || (best && t >= best.t)) continue;
      const p = origin.clone().addScaledVector(dir, t);
      if (this.nearestWalkable(L, p.x, p.z, 1)) best = { t, point: p, level: L };
    }
    return best;
  }

  // ---------- デバッグ表示 ----------
  buildPoints(existing) {
    const floor = this.floor();
    const pos = [], col = [];
    const cFloor = new THREE.Color('#58d6c9'), cHigh = new THREE.Color('#ffb057'), cLow = new THREE.Color('#9aa7ff');
    for (const L of this.significant()) {
      const rel = floor ? L.y - floor.y : 0;
      const color = !floor || L === floor ? cFloor : rel > 0.15 ? cHigh : cLow;
      for (const c of L.cells.values()) {
        pos.push((c.ix + 0.5) * this.cell, L.y + 0.004, (c.iz + 0.5) * this.cell);
        col.push(color.r, color.g, color.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = g;
      return existing;
    }
    const m = new THREE.PointsMaterial({ size: 0.022, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 1;
    return pts;
  }
}

function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const { k, p } = this;
    k.push(key); p.push(pri);
    let i = k.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= p[i]) break;
      [k[i], k[j]] = [k[j], k[i]]; [p[i], p[j]] = [p[j], p[i]];
      i = j;
    }
  }
  pop() {
    const { k, p } = this;
    const top = k[0];
    const lk = k.pop(), lp = p.pop();
    if (k.length) {
      k[0] = lk; p[0] = lp;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && p[l] < p[m]) m = l;
        if (r < k.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [k[i], k[m]] = [k[m], k[i]]; [p[i], p[m]] = [p[m], p[i]];
        i = m;
      }
    }
    return top;
  }
}
