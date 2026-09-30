import * as THREE from 'three';

// 体の部位ID（頂点属性 aPart に入れてシェーダーで柄を塗り分ける）
export const PART = {
  TORSO: 0, NECK: 1, HEAD: 2, MUZZLE: 3, CHIN: 4, EAR: 5, EAR_IN: 6,
  LEG_F_UP: 7, LEG_F_LO: 8, LEG_H_UP: 9, LEG_H_LO: 10, PAW: 11, TAIL: 12,
};

// Ashima Arts の 3D simplex noise (MIT)
const NOISE_GLSL = /* glsl */ `
vec3 nk_mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 nk_mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 nk_permute(vec4 x){return nk_mod289(((x*34.0)+1.0)*x);}
vec4 nk_taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = nk_mod289(i);
  vec4 p = nk_permute(nk_permute(nk_permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = nk_taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm3(vec3 p){ return 0.55*snoise(p) + 0.3*snoise(p*2.03 + 7.1) + 0.15*snoise(p*4.07 + 3.3); }
`;

// 休止姿勢の位置 (vRest) と法線 (vRestN) から毛柄を決める。
// 座標系: メートル、+Z が頭の向き、+Y が上、地面 y=0。
const FUR_GLSL = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uSecond;
uniform vec3 uBelly;
uniform vec3 uWhite;
uniform vec3 uInnerEar;
uniform float uWhiteAmt;
uniform float uWhiteFace;
uniform float uPattern;
uniform float uPatScale;
uniform float uPatContrast;
uniform float uRim;
uniform vec3 uSeed;
uniform vec3 uHeadC;
uniform vec3 uNose;
uniform vec3 uTailBase;
uniform float uTailLen;
uniform float uBodyTop;
uniform float uBodyBottom;
varying vec3 vRest;
varying vec3 vRestN;
varying float vPart;
${NOISE_GLSL}

bool isP(float part, float id){ return abs(part - id) < 0.5; }

float whitePriority(vec3 p, vec3 n, float part, float tailT){
  // 値が小さい部位ほど「白の量」が少なくても白くなる（足先→胸→お腹→顔→脇→背中の順）
  if (isP(part, 11.0)) return 0.04;
  if (isP(part, 8.0) || isP(part, 10.0)) return 0.10 + clamp(p.y / 0.13, 0.0, 1.0) * 0.28;
  if (isP(part, 7.0) || isP(part, 9.0)) return 0.38 + clamp((p.y - 0.10) / 0.10, 0.0, 1.0) * 0.25;
  if (isP(part, 4.0)) return 0.07;
  if (isP(part, 3.0)) return 0.12 - uWhiteFace * 0.06;
  if (isP(part, 0.0) || isP(part, 1.0)) {
    float up = n.y * 0.5 + 0.5;
    float f = 0.12 + up * 0.82;
    f -= max(n.z, 0.0) * 0.10 * (1.0 - up);       // 胸（前向きの面）が先に白くなる
    if (isP(part, 1.0)) f -= max(n.z, 0.0) * 0.08;  // 首の前側
    return f;
  }
  if (isP(part, 2.0)) {
    vec3 d = p - uHeadC;
    float front = smoothstep(-0.005, 0.035, d.z) * smoothstep(-0.3, 0.3, n.z);
    float blaze = 0.30 + abs(d.x) * 8.0 + max(d.y + 0.004, 0.0) * 9.0 - uWhiteFace * 0.42;
    float lower = smoothstep(-0.2, -0.7, n.y) * 0.25;  // 顎の下
    return clamp(mix(0.95 - lower, blaze - lower, front), 0.05, 0.99);
  }
  if (isP(part, 5.0) || isP(part, 6.0)) return 0.985;
  if (isP(part, 12.0)) return 0.93 - smoothstep(0.85, 1.0, tailT / uTailLen) * 0.08;
  return 0.9;
}

vec3 catFur(vec3 p, vec3 n, float part){
  vec3 q = p + uSeed;
  float nz = fbm3(q * 9.0);
  float tailT = length(p - uTailBase);
  bool tail = isP(part, 12.0);
  bool legs = isP(part, 7.0) || isP(part, 8.0) || isP(part, 9.0) || isP(part, 10.0) || isP(part, 11.0);
  bool head = isP(part, 2.0) || isP(part, 3.0) || isP(part, 4.0);
  bool ear = isP(part, 5.0) || isP(part, 6.0);
  float underside = smoothstep(-0.15, -0.6, n.y);

  float pat = 0.0;
  if (uPattern < 0.5) {
    pat = 0.0;
  } else if (uPattern < 1.5) {
    // トラ（マッカレル）: 胴は背骨から下に向かう縞、脚と尾はリング、額に縦縞
    float f = 125.0 * uPatScale;
    float s;
    if (tail) {
      s = sin(tailT * f * 1.1 + nz * 1.5);
      s = max(s, smoothstep(0.88, 0.97, tailT / uTailLen) * 2.0 - 1.0);
    } else if (legs) {
      s = sin(p.y * f * 1.25 + nz * 2.0) - 0.25;
    } else if (head) {
      vec3 d = p - uHeadC;
      float forehead = smoothstep(0.004, 0.02, d.y) * smoothstep(-0.02, 0.02, d.z);
      float cheek = smoothstep(0.03, 0.045, abs(d.x)) * smoothstep(0.01, -0.01, d.y);
      s = max(sin(d.x * 190.0 * uPatScale + nz) * forehead,
              sin(d.y * 170.0 * uPatScale + nz) * cheek * 0.9) - 0.1;
      s = max(s, smoothstep(0.02, 0.04, d.y) * smoothstep(-0.01, -0.035, d.z) * 0.8 - 0.1);
    } else if (ear) {
      s = 0.35;
    } else {
      float dorsal = smoothstep(0.35, 0.8, n.y) * smoothstep(0.02, 0.0, abs(p.x)) ;
      s = sin(p.z * f + nz * 3.5 + abs(p.x) * 30.0 - (1.0 - n.y) * 2.0);
      s = max(s, dorsal * 1.4 - 0.2);
      s -= underside * 1.3;
    }
    pat = smoothstep(0.05, 0.55, s);
  } else if (uPattern < 2.5) {
    // 斑点
    if (tail) pat = smoothstep(0.1, 0.5, sin(tailT * 40.0 * uPatScale + nz));
    else if (legs) pat = smoothstep(0.2, 0.6, sin(p.y * 42.0 * uPatScale + nz * 2.0));
    else {
      float sp = snoise(q * 32.0 * uPatScale) + 0.3 * nz;
      pat = smoothstep(0.32, 0.55, sp) * (1.0 - underside);
      if (head) pat *= 0.6;
    }
  } else if (uPattern < 3.5) {
    // サビ・三毛: 大きなパッチ + 細かいまだら
    float m = fbm3(q * 6.5 * uPatScale) + 0.28 * snoise(q * 38.0);
    pat = smoothstep(-0.07, 0.07, m);
  } else {
    // ポインテッド: 顔・耳・脚先・尾が濃い
    float pt = smoothstep(0.065, 0.02, length(p - uNose));
    if (ear) pt = 1.0;
    if (legs) pt = max(pt, smoothstep(0.17, 0.06, p.y));
    if (tail) pt = max(pt, smoothstep(0.0, 0.35, tailT / uTailLen));
    if (!head && !legs && !tail && !ear) pt = max(pt, 0.18 * smoothstep(0.3, 0.9, n.y));
    pat = pt;
  }

  vec3 col = mix(uBase, uSecond, clamp(pat * uPatContrast, 0.0, 1.0));

  // お腹側は明るい色に
  float belly = 0.0;
  if (isP(part, 0.0) || isP(part, 1.0)) belly = underside;
  if (head) belly = smoothstep(-0.25, -0.75, n.y) * 0.85;
  if (isP(part, 3.0) || isP(part, 4.0)) belly = max(belly, 0.55);
  if (uPattern > 3.5) belly *= 0.4;
  col = mix(col, uBelly, belly * 0.8);

  // 白ぶち
  if (uWhiteAmt > 0.001) {
    float f = whitePriority(p, n, part, tailT) + snoise(q * 22.0) * 0.045 + nz * 0.03;
    float w = 1.0 - smoothstep(uWhiteAmt - 0.018, uWhiteAmt + 0.018, f);
    col = mix(col, uWhite, w);
  }

  // 耳の内側（裏面）はピンク
  if (isP(part, 5.0) && !gl_FrontFacing) col = mix(uInnerEar, col, 0.2);

  // 毛並みの細かい明暗
  col *= 0.94 + 0.1 * snoise(p * 210.0) + 0.04 * nz;
  return col;
}
`;

export function createFurMaterial(shared = null, side = THREE.FrontSide) {
  const uniforms = shared?.userData.uniforms ?? {
    uBase: { value: new THREE.Color() },
    uSecond: { value: new THREE.Color() },
    uBelly: { value: new THREE.Color() },
    uWhite: { value: new THREE.Color('#f5f2ec') },
    uInnerEar: { value: new THREE.Color('#e6a3a0') },
    uWhiteAmt: { value: 0 },
    uWhiteFace: { value: 0 },
    uPattern: { value: 0 },
    uPatScale: { value: 1 },
    uPatContrast: { value: 1 },
    uRim: { value: 0.35 },
    uSeed: { value: new THREE.Vector3(1.3, 4.1, 2.7) },
    uHeadC: { value: new THREE.Vector3() },
    uNose: { value: new THREE.Vector3() },
    uTailBase: { value: new THREE.Vector3() },
    uTailLen: { value: 0.28 },
    uBodyTop: { value: 0.31 },
    uBodyBottom: { value: 0.15 },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0, side });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aRest;
attribute vec3 aRestN;
attribute float aPart;
varying vec3 vRest;
varying vec3 vRestN;
varying float vPart;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRest = aRest; vRestN = aRestN; vPart = aPart;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${FUR_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = catFur(vRest, normalize(vRestN), vPart);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 vdir = normalize(vViewPosition);
  float rim = pow(1.0 - clamp(dot(normal, vdir), 0.0, 1.0), 2.2);
  totalEmissiveRadiance += diffuseColor.rgb * rim * uRim;
}`);
  };
  mat.customProgramCacheKey = () => 'nekoar-fur-v1';
  mat.userData.uniforms = uniforms;
  return mat;
}

const PATTERN_INDEX = { solid: 0, tabby: 1, spotted: 2, tortie: 3, colorpoint: 4 };

export function applyFurAppearance(mat, ap) {
  const u = mat.userData.uniforms;
  u.uBase.value.set(ap.baseColor);
  u.uSecond.value.set(ap.secondaryColor);
  u.uBelly.value.set(ap.bellyColor);
  u.uWhiteAmt.value = ap.whiteAmount;
  u.uWhiteFace.value = ap.whiteFace;
  u.uPattern.value = PATTERN_INDEX[ap.pattern] ?? 0;
  u.uPatScale.value = ap.patternScale;
  u.uPatContrast.value = ap.pattern === 'solid' ? 0 : ap.patternContrast;
  // 色からシードを作り、同じ猫なら同じ柄になるように
  const h = hashString(`${ap.baseColor}${ap.secondaryColor}${ap.pattern}`);
  u.uSeed.value.set((h % 97) * 0.37, ((h >> 7) % 89) * 0.41, ((h >> 14) % 83) * 0.29);
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 目: ローカル座標で虹彩と縦長の瞳孔を描く
export function createEyeMaterial() {
  const uniforms = {
    uIris: { value: new THREE.Color('#c9a227') },
    uPupil: { value: 0.28 },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vEyeLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vEyeLocal = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uIris;
uniform float uPupil;
varying vec3 vEyeLocal;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 d = normalize(vEyeLocal);
  vec2 xy = d.xy / max(d.z, 0.25);
  float r = length(xy);
  vec3 iris = mix(uIris * 1.25, uIris * 0.55, smoothstep(0.15, 1.05, r));
  iris *= 0.9 + 0.12 * sin(atan(xy.y, xy.x) * 38.0);
  iris = mix(iris, vec3(0.08, 0.06, 0.05), smoothstep(0.95, 1.2, r));
  float pupil = 1.0 - smoothstep(0.9, 1.08, length(vec2(xy.x / uPupil, xy.y / 0.78)));
  vec3 col = mix(iris, vec3(0.015), pupil);
  col = mix(vec3(0.04), col, smoothstep(0.05, 0.3, d.z));
  diffuseColor.rgb = col;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 d = normalize(vEyeLocal);
  vec2 xy = d.xy / max(d.z, 0.25);
  float hl = 1.0 - smoothstep(0.1, 0.16, length(xy - vec2(-0.28, 0.34)));
  totalEmissiveRadiance += vec3(hl) * 0.9 * step(0.2, d.z);
}`);
  };
  mat.customProgramCacheKey = () => 'nekoar-eye-v1';
  mat.userData.uniforms = uniforms;
  return mat;
}
