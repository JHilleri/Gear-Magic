// Procedural fallback art: palette PBR material, a merged-geometry builder, a rigged humanoid
// (exact ASSETS.md bone names) with generated animation clips, equipment, mounts, monsters
// and canvas textures. Everything here is used whenever a GLB from the manifest is missing.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { BodyVariant, FactionId, ItemId, MonsterKind, RaceId } from '../core/types';
import { FACTIONS } from '../data/factions';
import { makeCanvas } from './anim';

const D2R = Math.PI / 180;
type V3 = [number, number, number];

// ═════════════════════════════ palette material ═════════════════════════════
export interface PalEntry { c: THREE.ColorRepresentation; r?: number; m?: number; e?: number }
export const PAL_SIZE = 16;

export interface PaletteUniforms {
  uPalC: { value: THREE.Color[] };
  uPalP: { value: THREE.Vector3[] };   // roughness, metalness, emissive strength
  uTint: { value: THREE.Color };
  uFlash: { value: THREE.Vector4 };    // rgb + amount (hit flash)
  uFx: { value: THREE.Vector4 };       // desaturate, emissive scale, dissolve 0..1, dissolve height scale
  uDissColor: { value: THREE.Color };  // glowing dissolve edge
}
export type PaletteMaterial = THREE.MeshStandardMaterial & { userData: { pal: PaletteUniforms } };

/**
 * One MeshStandardMaterial driven by a 16-entry palette: each vertex carries a palette index
 * (`aPal`) that selects colour, roughness, metalness and emissive strength — so a whole unit
 * (body, items, mount) renders with full PBR variety in a single program. Supports a tint,
 * a hit flash and a noise dissolve with a glowing edge (spawn / death).
 */
export function createPaletteMaterial(entries: PalEntry[], opts: { side?: THREE.Side; name?: string } = {}): PaletteMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, side: opts.side ?? THREE.FrontSide }) as PaletteMaterial;
  mat.name = opts.name ?? 'palette';
  const u: PaletteUniforms = {
    uPalC: { value: Array.from({ length: PAL_SIZE }, () => new THREE.Color(1, 1, 1)) },
    uPalP: { value: Array.from({ length: PAL_SIZE }, () => new THREE.Vector3(0.8, 0, 0)) },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFlash: { value: new THREE.Vector4(1, 0.2, 0.1, 0) },
    uFx: { value: new THREE.Vector4(0, 1, 0, 1) },
    uDissColor: { value: new THREE.Color(1.0, 0.55, 0.2) },
  };
  mat.userData = { pal: u };
  setPalette(mat, entries);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPal;\nvarying float vPal;\nvarying vec3 vOPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPal = aPal;\nvOPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uPalC[${PAL_SIZE}];
uniform vec3 uPalP[${PAL_SIZE}];
uniform vec3 uTint;
uniform vec4 uFlash;
uniform vec4 uFx;
uniform vec3 uDissColor;
varying float vPal;
varying vec3 vOPos;
float aeiHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
int palI = int(clamp(vPal + 0.5, 0.0, ${PAL_SIZE - 1}.0));
vec3 palC = uPalC[palI];
vec3 palP = uPalP[palI];
diffuseColor.rgb *= palC * uTint;
float palLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(palLum), uFx.x);
float dissEdge = 0.0;
if (uFx.z > 0.0) {
  float dn = aeiHash(floor(vOPos * 34.0));
  float dh = clamp(vOPos.y * uFx.w, 0.0, 1.0);
  float dd = mix(dn, 1.0 - dh, 0.5);
  float thr = uFx.z * 1.1 - 0.05;
  if (dd < thr) discard;
  dissEdge = 1.0 - smoothstep(0.0, 0.07, dd - thr);
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = palP.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = palP.y;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += palC * palP.z * uFx.y + uFlash.rgb * uFlash.a + uDissColor * dissEdge * 4.0;`);
  };
  mat.customProgramCacheKey = () => 'aei-palette-v1';
  return mat;
}

export function setPalette(mat: PaletteMaterial, entries: PalEntry[]): void {
  const u = mat.userData.pal;
  for (let i = 0; i < PAL_SIZE; i++) {
    const e = entries[i] ?? entries[0] ?? { c: '#ff00ff' };
    u.uPalC.value[i].set(e.c);
    u.uPalP.value[i].set(e.r ?? 0.8, e.m ?? 0, e.e ?? 0);
  }
}

/** A palette material sharing another's palette arrays (same look) but with its own tint/flash/fx. */
export function paletteVariant(src: PaletteMaterial, name = 'palette-variant'): PaletteMaterial {
  const m = createPaletteMaterial([], { side: src.side, name });
  const u = m.userData.pal;
  u.uPalC.value = src.userData.pal.uPalC.value;
  u.uPalP.value = src.userData.pal.uPalP.value;
  return m;
}

// ═════════════════════════════ geometry builder ═════════════════════════════
type SkinFn = (p: THREE.Vector3) => [number, number][];
export type SkinSpec = number | SkinFn;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const IDENT = new THREE.Matrix4();

/** Accumulates transformed primitives into one indexed geometry with `aPal` (+ skin attributes). */
export class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private pal: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private idx: number[] = [];
  private count = 0;
  constructor(readonly skinned = false) {}

  add(src: THREE.BufferGeometry, m: THREE.Matrix4 | null, pal: number, skin: SkinSpec = 0, flip = false): this {
    if (!src.getAttribute('normal')) src.computeVertexNormals();
    const P = src.getAttribute('position');
    const N = src.getAttribute('normal');
    const mat = m ?? IDENT;
    _nm.getNormalMatrix(mat);
    const neg = mat.determinant() < 0;
    const base = this.count;
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(mat);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      if (flip) _n.negate();
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.pal.push(pal);
      if (this.skinned) {
        let w: [number, number][] = typeof skin === 'number' ? [[skin, 1]] : skin(_v);
        w = w.filter((x) => x[1] > 1e-4).slice(0, 4);
        if (w.length === 0) w = [[0, 1]];
        const tot = w.reduce((s, x) => s + x[1], 0);
        for (let k = 0; k < 4; k++) {
          this.si.push(w[k] ? w[k][0] : 0);
          this.sw.push(w[k] ? w[k][1] / tot : 0);
        }
      }
    }
    const index = src.getIndex();
    const flipW = neg !== flip;
    const tri = (a: number, b: number, c: number) => {
      if (flipW) this.idx.push(base + a, base + c, base + b);
      else this.idx.push(base + a, base + b, base + c);
    };
    if (index) for (let i = 0; i + 2 < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    else for (let i = 0; i + 2 < P.count; i += 3) tri(i, i + 1, i + 2);
    this.count += P.count;
    src.dispose();
    return this;
  }

  /** Add with faceted (flat) normals — rocks, crystals, low-poly stone. */
  addFlat(src: THREE.BufferGeometry, m: THREE.Matrix4 | null, pal: number, skin: SkinSpec = 0): this {
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    g.computeVertexNormals();
    return this.add(g, m, pal, skin);
  }

  get vertexCount(): number { return this.count; }

  build(scale = 1): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pos = scale === 1 ? this.pos : this.pos.map((v) => v * scale);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPal', new THREE.Float32BufferAttribute(this.pal, 1));
    if (this.skinned) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Compose a matrix: translation, Euler rotation in degrees (XYZ), scale. */
export function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx * D2R, ry * D2R, rz * D2R, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}
const _up = new THREE.Vector3(0, 1, 0);
/** Matrix that places a +Y-axis geometry (centred on the origin) so it spans a → b. */
export function span(a: V3, b: V3): { m: THREE.Matrix4; len: number } {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const d = vb.clone().sub(va);
  const len = Math.max(1e-5, d.length());
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.normalize());
  return { m: new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), len };
}

/** Primitive factories (fresh geometries; GeoBuilder.add disposes them). */
export const G = {
  box: (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d),
  rbox: (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)),
  cyl: (rt: number, rb: number, h: number, s = 12, open = false, ts = 0, tl = Math.PI * 2) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open, ts, tl),
  sph: (r: number, ws = 14, hs = 10, ps = 0, pl = Math.PI * 2, ts = 0, tl = Math.PI) => new THREE.SphereGeometry(r, ws, hs, ps, pl, ts, tl),
  cone: (r: number, h: number, s = 10) => new THREE.ConeGeometry(r, h, s),
  cap: (r: number, len: number, rs = 10) => new THREE.CapsuleGeometry(r, len, 4, rs),
  tor: (R: number, r: number, rs = 6, ts = 20, arc = Math.PI * 2) => new THREE.TorusGeometry(R, r, rs, ts, arc),
  ico: (r: number, d = 0) => new THREE.IcosahedronGeometry(r, d),
  oct: (r: number) => new THREE.OctahedronGeometry(r),
  dode: (r: number) => new THREE.DodecahedronGeometry(r),
  lathe: (pts: [number, number][], s = 16) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), s),
  extrude: (shape: THREE.Shape, depth: number, bevel = 0) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 10 });
    g.translate(0, 0, -depth / 2);
    return g;
  },
  tube: (pts: V3[], r: number, segs = 20, rs = 6) =>
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), segs, r, rs, false),
};

/** Deterministic jitter of a geometry's vertices (organic rocks/stone). */
export function jitter(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  // jitter by position hash so shared vertices of non-indexed faces move together
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = (k: number) => {
      const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19 + k * 3.7) * 43758.5453;
      return (s - Math.floor(s)) * 2 - 1;
    };
    p.setXYZ(i, x + h(1) * amount, y + h(2) * amount, z + h(3) * amount);
  }
  p.needsUpdate = true;
  return g;
}

// ═════════════════════════════ unit palette ═════════════════════════════
/** Palette slots of the unit material (body, items, mount share one material per unit). */
export const UP = {
  SKIN: 0, PRIMARY: 1, ACCENT: 2, LEATHER: 3, CLOTH: 4, DARK: 5, METAL: 6, GOLD: 7,
  HAIR: 8, EYE: 9, BONE: 10, WOOD: 11, DETAIL: 12, GLOW: 13, COAT: 14, COAT2: 15,
} as const;

const SKIN_TONES: Record<string, string[]> = {
  human: ['#e8b896', '#d29a72', '#b0754f', '#f1cba9'],
  orc: ['#6f9a45', '#5d8838', '#7ea54f', '#64903f'],
  undead: ['#c3c9b6', '#b4baa8', '#cdd1c2', '#a9b0a0'],
  monster: ['#888888'],
};
const HAIR_TONES: Record<string, string[]> = {
  human: ['#5a3a22', '#c9a25a', '#2a211c', '#8a4a2a'],
  orc: ['#1d1814', '#2d2520', '#3b2a1e', '#18130f'],
  undead: ['#d6d6cc', '#9b9b92', '#77766f', '#c2c0b5'],
  monster: ['#444444'],
};
export const RACE_GLOW: Record<string, string> = { human: '#7cc8ff', orc: '#ff8a3c', undead: '#8dffc4', monster: '#ffb347' };

export interface MountCoat { coat: string; coat2: string; coat2Emit?: number }
export const MOUNT_COATS: Record<'horse' | 'wolf' | 'nightmare', MountCoat[]> = {
  horse: [
    { coat: '#6a4127', coat2: '#1f1813' }, { coat: '#8a4b25', coat2: '#4e2814' }, { coat: '#9c978f', coat2: '#e2ddd4' },
    { coat: '#2b2623', coat2: '#121010' }, { coat: '#d8d2c6', coat2: '#b9b1a2' },
  ],
  wolf: [{ coat: '#5b5048', coat2: '#2e2824' }, { coat: '#6e6a63', coat2: '#3b3733' }, { coat: '#4a3c33', coat2: '#241d19' }],
  nightmare: [{ coat: '#17151b', coat2: '#b27bff', coat2Emit: 2.6 }, { coat: '#1d1a16', coat2: '#7dffb6', coat2Emit: 2.4 }],
};

function mixHex(a: string, b: string, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

export function unitPalette(race: RaceId, faction: FactionId, variant: number, mount?: MountCoat): PalEntry[] {
  const f = FACTIONS[faction] ?? FACTIONS.neutral;
  const v = Math.abs(variant | 0);
  const r = race === 'monster' ? 'human' : race;
  const skin = SKIN_TONES[r][v % SKIN_TONES[r].length];
  const hair = HAIR_TONES[r][(v >> 2) % HAIR_TONES[r].length];
  const metal = r === 'human' ? { c: '#a3abb6', r: 0.4, m: 0.82 } : r === 'orc' ? { c: '#7d756b', r: 0.52, m: 0.8 } : { c: '#5d606e', r: 0.38, m: 0.88 };
  const dark = r === 'human' ? '#4b4037' : r === 'orc' ? '#40352a' : '#2e2b33';
  const eye = r === 'human' ? { c: '#1c1612', r: 0.3 } : r === 'orc' ? { c: '#f2c14a', r: 0.4, e: 0.9 } : { c: '#9ff7ff', r: 0.3, e: 3.2 };
  return [
    { c: skin, r: r === 'undead' ? 0.75 : 0.62 },                 // SKIN
    { c: f.color, r: 0.72 },                                       // PRIMARY
    { c: f.accent, r: 0.55, m: f.accent === '#e8c35a' ? 0.6 : 0 }, // ACCENT
    { c: '#6b4a2e', r: 0.7 },                                      // LEATHER
    { c: r === 'undead' ? mixHex(f.color, '#3b3742', 0.55) : r === 'orc' ? mixHex(f.color, '#7a6448', 0.5) : mixHex(f.color, '#c9b38a', 0.5), r: 0.9 }, // CLOTH (muted faction tunic)
    { c: dark, r: 0.85 },                                          // DARK
    metal,                                                         // METAL
    { c: '#d9a93e', r: 0.28, m: 1 },                               // GOLD
    { c: hair, r: 0.7 },                                           // HAIR
    eye,                                                           // EYE
    { c: '#e3d8bd', r: 0.6 },                                      // BONE
    { c: r === 'undead' ? '#4a423c' : '#7a5532', r: 0.8 },         // WOOD
    { c: '#18130f', r: 0.9 },                                      // DETAIL
    { c: RACE_GLOW[r], r: 0.2, e: 2.4 },                           // GLOW
    { c: mount?.coat ?? '#6a4127', r: 0.75 },                      // COAT
    { c: mount?.coat2 ?? '#1f1813', r: 0.8, e: mount?.coat2Emit ?? 0 }, // COAT2
  ];
}

export function monsterPalette(kind: MonsterKind, faction: FactionId): PalEntry[] {
  const f = FACTIONS[faction] ?? FACTIONS.neutral;
  const base = unitPalette('human', faction, 0);
  const set = (i: number, e: PalEntry) => { base[i] = e; };
  set(UP.PRIMARY, { c: f.color, r: 0.7 });
  switch (kind) {
    case 'wolf':
      set(UP.COAT, { c: '#7f7b74', r: 0.85 }); set(UP.COAT2, { c: '#4a4642', r: 0.9 });
      set(UP.EYE, { c: '#ff5a3a', r: 0.3, e: 2.2 }); break;
    case 'spider':
      set(UP.COAT, { c: '#2a2128', r: 0.55 }); set(UP.COAT2, { c: '#53303f', r: 0.6 });
      set(UP.EYE, { c: '#ff2a2a', r: 0.2, e: 3 }); set(UP.ACCENT, { c: '#b3262a', r: 0.5 }); break;
    case 'golem':
      set(UP.COAT, { c: '#8c8a80', r: 0.95 }); set(UP.COAT2, { c: '#6d6b63', r: 0.95 });
      set(UP.EYE, { c: '#7fe8ff', r: 0.2, e: 3.2 }); set(UP.GLOW, { c: '#63d8ff', r: 0.2, e: 3 });
      set(UP.CLOTH, { c: '#5f7a3a', r: 0.9 }); break; // CLOTH doubles as moss
    case 'elemental':
      set(UP.COAT, { c: '#94652d', r: 0.9 }); set(UP.COAT2, { c: '#b9812f', r: 0.85 });
      set(UP.EYE, { c: '#ffd27a', r: 0.2, e: 3.4 }); set(UP.GLOW, { c: '#ff9d2e', r: 0.2, e: 3.4 });
      set(UP.CLOTH, { c: '#6e4a22', r: 0.9 }); break;
  }
  return base;
}

// ═════════════════════════════ humanoid rig ═════════════════════════════
export const BONE_NAMES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'shoulder.L', 'upperarm.L', 'forearm.L', 'hand.L',
  'shoulder.R', 'upperarm.R', 'forearm.R', 'hand.R',
  'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];
const BONE_PARENT: Record<BoneName, BoneName | null> = {
  root: null, hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  'shoulder.L': 'chest', 'upperarm.L': 'shoulder.L', 'forearm.L': 'upperarm.L', 'hand.L': 'forearm.L',
  'shoulder.R': 'chest', 'upperarm.R': 'shoulder.R', 'forearm.R': 'upperarm.R', 'hand.R': 'forearm.R',
  'thigh.L': 'hips', 'shin.L': 'thigh.L', 'foot.L': 'shin.L', 'thigh.R': 'hips', 'shin.R': 'thigh.R', 'foot.R': 'shin.R',
};
const BI = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i])) as Record<BoneName, number>;

export const CLIP_NAMES = ['idle', 'walk', 'attack_melee', 'attack_ranged', 'cast', 'hit', 'death', 'work', 'ride_idle', 'ride_attack'] as const;

interface RaceShape { height: number; shoulderW: number; hipW: number; limb: number; leg: number; torso: number; hunch: number; headR: number; armDown: number }
export const RACE_SHAPE: Record<'human' | 'orc' | 'undead', RaceShape> = {
  human: { height: 1.0, shoulderW: 0.125, hipW: 0.068, limb: 1.0, leg: 1.0, torso: 1.0, hunch: 0, headR: 0.082, armDown: 78 },
  orc: { height: 1.07, shoulderW: 0.152, hipW: 0.078, limb: 1.32, leg: 1.18, torso: 1.24, hunch: 9, headR: 0.08, armDown: 68 },
  undead: { height: 0.99, shoulderW: 0.118, hipW: 0.062, limb: 0.74, leg: 0.8, torso: 0.86, hunch: 6, headR: 0.079, armDown: 80 },
};
const shapeOf = (race: RaceId): RaceShape => RACE_SHAPE[race === 'monster' ? 'human' : race];

function rigJoints(s: RaceShape): Record<BoneName, V3> {
  const sw = s.shoulderW, hw = s.hipW;
  return {
    root: [0, 0, 0], hips: [0, 0.5, 0], spine: [0, 0.57, 0], chest: [0, 0.665, 0], neck: [0, 0.795, 0], head: [0, 0.845, 0],
    'shoulder.L': [0.03, 0.785, 0], 'upperarm.L': [sw, 0.785, 0], 'forearm.L': [sw + 0.16, 0.785, 0], 'hand.L': [sw + 0.305, 0.785, 0],
    'shoulder.R': [-0.03, 0.785, 0], 'upperarm.R': [-sw, 0.785, 0], 'forearm.R': [-sw - 0.16, 0.785, 0], 'hand.R': [-sw - 0.305, 0.785, 0],
    'thigh.L': [hw, 0.49, 0], 'shin.L': [hw, 0.27, 0], 'foot.L': [hw, 0.055, 0],
    'thigh.R': [-hw, 0.49, 0], 'shin.R': [-hw, 0.27, 0], 'foot.R': [-hw, 0.055, 0],
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
// Soft-skinning helpers (blend cloth over joints so robes/capes follow the legs)
const skirtSkin: SkinFn = (p) => {
  const s = clamp01((0.47 - p.y) / 0.3) * 0.9;
  const a = clamp01(0.5 + p.x * 7);
  return [[BI.hips, 1 - s], [BI['thigh.L'], s * a], [BI['thigh.R'], s * (1 - a)]];
};
const capeSkin: SkinFn = (p) => {
  if (p.y > 0.68) return [[BI.chest, 1]];
  if (p.y > 0.52) { const t = (p.y - 0.52) / 0.16; return [[BI.chest, t], [BI.spine, 1 - t]]; }
  if (p.y > 0.4) { const t = (p.y - 0.4) / 0.12; return [[BI.spine, t], [BI.hips, 1 - t]]; }
  return [[BI.hips, 0.8], [BI['thigh.L'], 0.1], [BI['thigh.R'], 0.1]];
};
const tabardSkin: SkinFn = (p) => {
  if (p.y > 0.62) return [[BI.chest, 1]];
  if (p.y > 0.52) { const t = (p.y - 0.52) / 0.1; return [[BI.chest, t], [BI.spine, 1 - t]]; }
  if (p.y > 0.42) return [[BI.hips, 1]];
  const s = clamp01((0.42 - p.y) / 0.14) * 0.6;
  return [[BI.hips, 1 - s], [BI['thigh.L'], s / 2], [BI['thigh.R'], s / 2]];
};

/** Grip frames: item +Y along the thumb, +Z toward the fingertips (ASSETS.md convention). */
export const GRIP_R = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
export const GRIP_L = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));

const humanoidGeoCache = new Map<string, THREE.BufferGeometry>();

/** Merged skinned geometry for a race × body × look variant (cached). Unit space, feet at 0, faces +Z. */
export function humanoidGeometry(race: RaceId, body: BodyVariant, variant: number): THREE.BufferGeometry {
  const v = Math.abs(variant | 0) % 4;
  const key = `${race}|${body}|${v}`;
  const hit = humanoidGeoCache.get(key);
  if (hit) return hit;
  const sh = shapeOf(race);
  const J = rigJoints(sh);
  const R: 'human' | 'orc' | 'undead' = race === 'monster' ? 'human' : race;
  const gb = new GeoBuilder(true);
  const tw = sh.torso, lw = sh.limb, legw = sh.leg;
  const P = UP;

  const limb = (a: V3, b: V3, r0: number, r1: number, pal: number, bone: BoneName, seg = 10) => {
    const s = span(a, b);
    gb.add(G.cyl(r1, r0, s.len, seg), s.m, pal, BI[bone]);
  };
  const ball = (p: V3, r: number, pal: number, bone: BoneName | SkinFn, sx = 1, sy = sx, sz = sx, ws = 14, hs = 10) =>
    gb.add(G.sph(r, ws, hs), T(p[0], p[1], p[2], 0, 0, 0, sx, sy, sz), pal, typeof bone === 'string' ? BI[bone] : bone);
  const ell = (p: V3, s: V3, pal: number, bone: BoneName | SkinFn, rx = 0, ry = 0, rz = 0) =>
    gb.add(G.sph(1, 16, 12), T(p[0], p[1], p[2], rx, ry, rz, s[0], s[1], s[2]), pal, typeof bone === 'string' ? BI[bone] : bone);

  const heavy = body === 'heavy';
  const leader = body === 'leader';
  const robe = body === 'robe' || (leader && R === 'undead');
  const armored = heavy || (leader && R !== 'undead');

  // palette choices per body
  const torsoPal = body === 'commoner' ? P.CLOTH : body === 'light' ? P.LEATHER : armored ? P.METAL : P.PRIMARY;
  const sleevePal = body === 'commoner' ? P.CLOTH : body === 'light' ? P.PRIMARY : armored ? P.METAL : P.PRIMARY;
  const forePal = body === 'commoner' ? P.SKIN : body === 'light' ? P.LEATHER : armored ? P.METAL : P.PRIMARY;
  const handPal = armored ? P.METAL : P.SKIN;
  const legPal = armored ? P.METAL : P.DARK;
  const shinPal = armored ? P.METAL : body === 'light' || leader ? P.LEATHER : P.DARK;
  const footPal = armored ? P.METAL : P.LEATHER;

  // ── torso ──
  ell([0, 0.5, 0], [0.105 * tw, 0.078, 0.08 * tw], armored ? P.DARK : torsoPal === P.METAL ? P.DARK : body === 'robe' ? P.PRIMARY : P.DARK, 'hips');
  ell([0, 0.585, 0.003], [0.098 * tw, 0.088, 0.075 * tw], torsoPal, 'spine');
  ell([0, 0.7, 0.004 + sh.hunch * 0.001], [0.124 * tw, 0.1, 0.086 * tw], torsoPal, 'chest');
  ell([0, 0.758, 0], [0.132 * tw, 0.05, 0.078 * tw], torsoPal, 'chest');
  limb([0, 0.765, 0], [0, 0.875, 0.004], 0.033 * Math.sqrt(lw), 0.03 * Math.sqrt(lw), armored ? P.METAL : P.SKIN, 'neck');

  // ── arms ──
  for (const side of [1, -1] as const) {
    const S = side > 0 ? 'L' : 'R';
    const sj = J[`upperarm.${S}` as BoneName], ej = J[`forearm.${S}` as BoneName], wj = J[`hand.${S}` as BoneName];
    const upper = `upperarm.${S}` as BoneName, fore = `forearm.${S}` as BoneName, hand = `hand.${S}` as BoneName;
    ball(sj, 0.042 * lw, sleevePal, upper);
    limb(sj, ej, 0.036 * lw, 0.03 * lw, sleevePal, upper);
    ball(ej, 0.029 * lw, forePal, fore);
    if (body === 'robe') {
      // bell sleeve
      limb(ej, [wj[0] - side * 0.01, wj[1], wj[2]], 0.032 * lw, 0.05 * lw, P.PRIMARY, fore, 12);
      gb.add(G.tor(0.049 * lw, 0.007, 6, 16), T(wj[0] - side * 0.012, wj[1], wj[2], 0, 90, 0), P.ACCENT, BI[fore]);
    } else {
      limb(ej, wj, 0.029 * lw, 0.023 * lw, forePal, fore);
      if (armored) limb([ej[0] + side * 0.07, ej[1], ej[2]], [wj[0] + side * 0.005, wj[1], wj[2]], 0.031 * lw, 0.036 * lw, P.METAL, fore);
    }
    ell([wj[0] + side * 0.03, wj[1] - 0.004, wj[2] + 0.004], [0.034 * lw, 0.024 * lw, 0.03 * lw], R === 'undead' && handPal === P.SKIN ? P.BONE : handPal, hand);
    ell([wj[0] + side * 0.012, wj[1] - 0.004, wj[2] + 0.026 * lw], [0.012 * lw, 0.012 * lw, 0.014 * lw], handPal, hand); // thumb
    // shoulder armour
    if (armored) {
      ell([sj[0] + side * 0.01, sj[1] + 0.018, sj[2]], [0.07 * lw, 0.05 * lw, 0.065 * lw], P.METAL, upper);
      gb.add(G.tor(0.062 * lw, 0.008, 6, 18), T(sj[0] + side * 0.012, sj[1] - 0.008, sj[2], 90, 0, side * 20, 1, 1, 0.9), leader ? P.GOLD : P.METAL, BI[upper]);
      if (R === 'orc' && leader && side < 0) ell([sj[0] - 0.02, sj[1] + 0.06, sj[2]], [0.045, 0.045, 0.05], P.BONE, upper); // skull trophy
    } else if (body === 'light') {
      ell([sj[0] + side * 0.008, sj[1] + 0.012, sj[2]], [0.055 * lw, 0.038 * lw, 0.055 * lw], P.LEATHER, upper);
    }
  }

  // ── legs ──
  for (const side of [1, -1] as const) {
    const S = side > 0 ? 'L' : 'R';
    const hj = J[`thigh.${S}` as BoneName], kj = J[`shin.${S}` as BoneName], aj = J[`foot.${S}` as BoneName];
    const thigh = `thigh.${S}` as BoneName, shin = `shin.${S}` as BoneName, foot = `foot.${S}` as BoneName;
    ball(hj, 0.05 * legw, legPal, thigh);
    limb(hj, kj, 0.05 * legw, 0.039 * legw, legPal, thigh);
    ball(kj, 0.038 * legw, armored ? P.METAL : legPal, shin);
    limb(kj, aj, 0.037 * legw, 0.028 * legw, shinPal, shin);
    if (body === 'light' || leader) limb([kj[0], kj[1] - 0.06, kj[2]], [aj[0], aj[1] + 0.01, aj[2]], 0.041 * legw, 0.034 * legw, P.LEATHER, shin); // boots
    gb.add(G.rbox(0.058 * legw, 0.05, 0.125, 0.018), T(aj[0], 0.026, 0.03), footPal, BI[foot]);
  }

  // ── clothing details per body ──
  if (body === 'commoner') {
    gb.add(G.cyl(0.1 * tw, 0.126 * tw, 0.13, 16, true), T(0, 0.45, 0), P.CLOTH, skirtSkin);
    gb.add(G.cyl(0.103 * tw, 0.105 * tw, 0.024, 16), T(0, 0.522, 0), P.LEATHER, BI.hips);
    gb.add(G.box(0.02, 0.018, 0.01), T(0, 0.522, 0.104 * tw), P.GOLD, BI.hips);
    gb.add(G.tor(0.045, 0.012, 6, 14), T(0, 0.79, 0.01, 90, 0, 0, 1, 1, 0.8), P.CLOTH, BI.chest); // collar
  } else if (body === 'light') {
    gb.add(G.cyl(0.1 * tw, 0.13 * tw, 0.12, 8, true), T(0, 0.452, 0), P.LEATHER, skirtSkin);
    gb.add(G.cyl(0.104 * tw, 0.106 * tw, 0.026, 16), T(0, 0.522, 0), P.DARK, BI.hips);
    gb.add(G.box(0.024, 0.022, 0.01), T(0, 0.522, 0.106 * tw), P.GOLD, BI.hips);
    gb.add(G.box(0.07 * tw, 0.15, 0.012), T(0, 0.44, 0.106 * tw, -6, 0, 0), P.PRIMARY, tabardSkin); // front flap
    gb.add(G.box(0.07 * tw, 0.13, 0.012), T(0, 0.45, -0.1 * tw, 6, 0, 0), P.PRIMARY, tabardSkin);
    gb.add(G.box(0.074 * tw, 0.014, 0.014), T(0, 0.37, 0.11 * tw, -6, 0, 0), P.ACCENT, tabardSkin);
    gb.add(G.tor(0.05, 0.016, 6, 16), T(0, 0.79, 0.008, 90, 0, 0, 1, 1, 0.8), P.PRIMARY, BI.chest); // scarf
    const strap = span([0.1 * tw, 0.78, 0.07 * tw], [-0.09 * tw, 0.55, 0.085 * tw]);
    gb.add(G.box(0.022, strap.len, 0.01), strap.m, P.DARK, BI.chest); // baldric
  } else if (heavy) {
    gb.add(G.cyl(0.104 * tw, 0.128 * tw, 0.12, 14, true), T(0, 0.452, 0), P.DARK, skirtSkin); // mail skirt
    gb.add(G.box(0.12 * tw, 0.3, 0.012), T(0, 0.5, 0.088 * tw), P.PRIMARY, tabardSkin);
    gb.add(G.box(0.028, 0.26, 0.014), T(0, 0.5, 0.093 * tw), P.ACCENT, tabardSkin);
    gb.add(G.box(0.12 * tw, 0.22, 0.012), T(0, 0.5, -0.088 * tw), P.PRIMARY, tabardSkin);
    gb.add(G.cyl(0.108 * tw, 0.11 * tw, 0.026, 16), T(0, 0.53, 0), P.LEATHER, BI.hips);
    gb.add(G.cyl(0.045, 0.055, 0.04, 14), T(0, 0.79, 0), P.METAL, BI.chest); // gorget
  } else if (robe) {
    // long robe skirt blended over the legs
    gb.add(G.lathe([[0.0, 0.03], [0.17 * tw, 0.03], [0.16 * tw, 0.12], [0.135 * tw, 0.3], [0.112 * tw, 0.46], [0.1 * tw, 0.56], [0.0, 0.57]], 18), T(0, 0, 0), P.PRIMARY, skirtSkin);
    gb.add(G.tor(0.168 * tw, 0.009, 6, 24), T(0, 0.036, 0, 90, 0, 0), P.ACCENT, skirtSkin);
    gb.add(G.box(0.03, 0.46, 0.01), T(0, 0.3, 0.142 * tw, -5, 0, 0), P.ACCENT, skirtSkin);
    gb.add(G.cyl(0.103 * tw, 0.106 * tw, 0.03, 16), T(0, 0.535, 0), P.ACCENT, BI.hips);
    gb.add(G.box(0.03, 0.03, 0.012), T(0, 0.535, 0.106 * tw), P.GOLD, BI.hips);
    gb.add(G.tor(0.055, 0.016, 6, 16), T(0, 0.785, 0.01, 90, 0, 0, 1, 1, 0.85), P.ACCENT, BI.chest); // collar
    if (R === 'orc') for (let i = 0; i < 7; i++) {
      const a = ((i - 3) / 3) * 1.1;
      ball([Math.sin(a) * 0.06, 0.74 - Math.cos(a) * 0.03, 0.07 + Math.cos(a) * 0.02], 0.012, P.BONE, 'chest');
    }
  }

  // leader extras: cape, ornate trim
  if (leader) {
    const capePal = R === 'undead' ? P.ACCENT : P.PRIMARY;
    const cr0 = 0.13 * tw, cr1 = 0.21 * tw;
    const capeGeo = () => G.cyl(cr0, cr1, 0.56, 16, true, Math.PI - 1.15, 2.3);
    gb.add(capeGeo(), T(0, 0.5, -0.01), capePal, capeSkin);
    gb.add(G.cyl(cr0 - 0.006, cr1 - 0.006, 0.56, 16, true, Math.PI - 1.15, 2.3), T(0, 0.5, -0.01), R === 'undead' ? P.DARK : P.ACCENT, capeSkin, true);
    if (armored) {
      gb.add(G.tor(0.11 * tw, 0.008, 6, 22), T(0, 0.62, 0, 90, 0, 0, 1, 0.8, 1), P.GOLD, BI.spine);
      gb.add(G.cyl(0.107 * tw, 0.13 * tw, 0.14, 16, true), T(0, 0.45, 0), P.PRIMARY, skirtSkin);
      gb.add(G.tor(0.128 * tw, 0.007, 6, 22), T(0, 0.382, 0, 90, 0, 0), P.ACCENT, skirtSkin);
      gb.add(G.cyl(0.108 * tw, 0.11 * tw, 0.026, 16), T(0, 0.53, 0), P.LEATHER, BI.hips);
      gb.add(G.box(0.03, 0.03, 0.012), T(0, 0.53, 0.11 * tw), P.GOLD, BI.hips);
      ell([0, 0.7, 0.085 * tw], [0.032, 0.04, 0.012], P.GOLD, 'chest', 0, 0, 45);
      if (R === 'orc') gb.add(G.tor(0.12 * tw, 0.04, 8, 20), T(0, 0.78, -0.01, 90, 0, 0, 1, 0.75, 0.8), P.HAIR, BI.chest); // fur mantle
    } else {
      gb.add(G.box(0.12 * tw, 0.012, 0.13), T(0, 0.71, 0.04), P.DETAIL, BI.chest);
      ell([0, 0.69, 0.002], [0.128 * tw, 0.1, 0.09 * tw], P.METAL, 'chest');
      gb.add(G.tor(0.118 * tw, 0.008, 6, 22), T(0, 0.76, 0.004, 90, 0, 0, 1, 0.75, 1), P.GOLD, BI.chest);
      gb.add(G.oct(0.022), T(0, 0.7, 0.09 * tw, 0, 0, 0, 1, 1.4, 0.6), P.GLOW, BI.chest);
      ell([0.1, 0.8, 0], [0.06, 0.06, 0.06], P.METAL, 'upperarm.L');
      ell([-0.1, 0.8, 0], [0.06, 0.06, 0.06], P.METAL, 'upperarm.R');
      gb.add(G.cone(0.016, 0.07, 6), T(0.11, 0.86, 0, 0, 0, -25), P.BONE, BI['upperarm.L']);
      gb.add(G.cone(0.016, 0.07, 6), T(-0.11, 0.86, 0, 0, 0, 25), P.BONE, BI['upperarm.R']);
    }
  }

  // ── head ──
  const hr = sh.headR;
  const hc: V3 = [0, 0.845 + hr * 0.95, 0.006 + sh.hunch * 0.0015];
  const helmet = heavy;
  if (R === 'orc') {
    ell(hc, [hr * 1.06, hr * 0.98, hr * 1.0], P.SKIN, 'head');
    gb.add(G.rbox(hr * 1.5, hr * 0.7, hr * 1.1, 0.02), T(0, hc[1] - hr * 0.55, hc[2] + hr * 0.25), P.SKIN, BI.head); // jaw
    for (const s of [1, -1]) {
      gb.add(G.cone(0.011, 0.045, 6), T(s * 0.032, hc[1] - hr * 0.45, hc[2] + hr * 0.82, -10, 0, -s * 12), P.BONE, BI.head); // tusks
      gb.add(G.cone(0.02, 0.07, 6), T(s * hr * 1.05, hc[1] + 0.01, hc[2] - 0.01, 0, 0, -s * 70), P.SKIN, BI.head); // ears
    }
  } else {
    ell(hc, [hr, hr * 1.07, hr * 1.02], P.SKIN, 'head');
    for (const s of [1, -1]) ell([s * hr * 0.97, hc[1] - 0.004, hc[2] - 0.006], [0.011, 0.019, 0.015], P.SKIN, 'head');
    if (R === 'undead') ell([0, hc[1] - hr * 0.62, hc[2] + hr * 0.3], [hr * 0.62, hr * 0.34, hr * 0.62], P.BONE, 'head'); // jaw
  }
  if (!helmet) {
    // eyes, brows, nose, mouth
    for (const s of [1, -1]) {
      if (R === 'undead') {
        ell([s * 0.03, hc[1] + 0.006, hc[2] + hr * 0.8], [0.02, 0.017, 0.012], P.DETAIL, 'head');
        ball([s * 0.03, hc[1] + 0.006, hc[2] + hr * 0.86], 0.0105, P.EYE, 'head');
      } else {
        ball([s * 0.029, hc[1] + 0.007, hc[2] + hr * 0.86], R === 'orc' ? 0.0105 : 0.0115, R === 'orc' ? P.EYE : P.DETAIL, 'head');
        gb.add(G.box(0.032, R === 'orc' ? 0.012 : 0.007, 0.012), T(s * 0.03, hc[1] + 0.03, hc[2] + hr * 0.86, 0, 0, s * (R === 'orc' ? -14 : 8)), R === 'orc' ? P.DETAIL : P.HAIR, BI.head);
      }
    }
    if (R !== 'undead') gb.add(G.cone(0.013, 0.03, 6), T(0, hc[1] - 0.008, hc[2] + hr * 0.98, 90, 0, 0), P.SKIN, BI.head);
    else gb.add(G.cone(0.008, 0.016, 3), T(0, hc[1] - 0.012, hc[2] + hr * 0.95, -90, 0, 0), P.DETAIL, BI.head);
    if (R !== 'orc') gb.add(G.box(0.026, 0.005, 0.006), T(0, hc[1] - 0.038, hc[2] + hr * 0.9), P.DETAIL, BI.head);
  }

  // ── headgear / hair ──
  const capTop = (r: number, pal: number, theta = 0.55) => gb.add(G.sph(r, 16, 8, 0, Math.PI * 2, 0, Math.PI * theta), T(hc[0], hc[1] + 0.004, hc[2] - 0.006), pal, BI.head);
  if (helmet) {
    if (R === 'orc') {
      gb.add(G.sph(hr * 1.14, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), T(hc[0], hc[1] - 0.004, hc[2]), P.METAL, BI.head);
      gb.add(G.box(hr * 1.6, 0.012, 0.02), T(0, hc[1] - 0.004, hc[2] + hr * 1.02), P.DETAIL, BI.head);
      gb.add(G.box(0.02, hr * 0.9, 0.025), T(0, hc[1] - hr * 0.35, hc[2] + hr * 1.03), P.METAL, BI.head); // nasal
      for (const s of [1, -1]) gb.add(G.tube([[s * hr * 0.9, hc[1] + 0.02, hc[2]], [s * hr * 1.45, hc[1] + 0.05, hc[2] + 0.01], [s * hr * 1.7, hc[1] + 0.12, hc[2] + 0.03]], 0.014, 10, 6), null, P.BONE, BI.head);
    } else {
      gb.add(G.sph(hr * 1.15, 18, 12), T(hc[0], hc[1] + 0.002, hc[2], 0, 0, 0, 1, 1.06, 1.06), P.METAL, BI.head);
      gb.add(G.box(hr * 1.4, 0.014, 0.03), T(0, hc[1] + 0.005, hc[2] + hr * 1.08), P.DETAIL, BI.head); // visor slit
      gb.add(G.box(0.012, hr * 0.5, 0.03), T(0, hc[1] - hr * 0.45, hc[2] + hr * 1.06), P.DETAIL, BI.head);
      if (R === 'undead') {
        for (const s of [1, -1]) ball([s * 0.028, hc[1] + 0.005, hc[2] + hr * 1.1], 0.009, P.EYE, 'head');
        for (let i = 0; i < 5; i++) gb.add(G.cone(0.012, 0.06, 5), T(0, hc[1] + hr * 1.1, hc[2] - hr * 0.6 + i * hr * 0.32, -10 + i * 6, 0, 0), P.METAL, BI.head);
      } else {
        gb.add(G.box(0.016, 0.07, hr * 2.2), T(0, hc[1] + hr * 1.18, hc[2] - 0.01), P.PRIMARY, BI.head); // crest
      }
    }
  } else if (leader) {
    if (R === 'human') {
      if (v % 2 === 0) capTop(hr * 1.06, P.HAIR);
      else { capTop(hr * 1.07, P.HAIR, 0.62); ell([0, hc[1] - 0.03, hc[2] - hr * 0.75], [hr * 0.85, hr * 1.1, hr * 0.5], P.HAIR, 'head'); }
      gb.add(G.cyl(hr * 1.02, hr * 0.98, 0.028, 18, true), T(hc[0], hc[1] + hr * 0.58, hc[2]), P.GOLD, BI.head);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        gb.add(G.cone(0.011, 0.04, 4), T(Math.sin(a) * hr, hc[1] + hr * 0.58 + 0.032, hc[2] + Math.cos(a) * hr), P.GOLD, BI.head);
      }
      ball([0, hc[1] + hr * 0.6, hc[2] + hr * 1.0], 0.011, P.GLOW, 'head');
    } else if (R === 'orc') {
      gb.add(G.cyl(hr * 1.06, hr * 1.04, 0.03, 16, true), T(hc[0], hc[1] + hr * 0.5, hc[2]), P.BONE, BI.head);
      for (let i = 0; i < 5; i++) {
        const a = ((i - 2) / 2) * 0.9;
        gb.add(G.cone(0.014, 0.07, 5), T(Math.sin(a) * hr, hc[1] + hr * 0.5 + 0.04, hc[2] + Math.cos(a) * hr, 0, 0, 0), P.BONE, BI.head);
      }
      gb.add(G.box(0.02, 0.06, hr * 1.4), T(0, hc[1] + hr * 0.95, hc[2] - 0.02), P.HAIR, BI.head);
    } else {
      // lich: hood + spiked dark crown
      gb.add(G.sph(hr * 1.2, 16, 10, Math.PI * 0.68, Math.PI * 1.64, 0, Math.PI * 0.75), T(hc[0], hc[1], hc[2] - 0.004), P.PRIMARY, BI.head);
      gb.add(G.cyl(hr * 1.0, hr * 1.04, 0.028, 14, true), T(hc[0], hc[1] + hr * 0.6, hc[2]), P.DETAIL, BI.head);
      for (let i = 0; i < 7; i++) {
        const a = ((i - 3) / 3) * 1.3;
        gb.add(G.cone(0.01, 0.06 + (i === 3 ? 0.03 : 0), 4), T(Math.sin(a) * hr, hc[1] + hr * 0.6 + 0.04, hc[2] + Math.cos(a) * hr), P.GOLD, BI.head);
      }
      ball([0, hc[1] + hr * 0.62, hc[2] + hr * 1.02], 0.012, P.GLOW, 'head');
    }
  } else if (robe) {
    // hood (open at the front)
    gb.add(G.sph(hr * 1.22, 16, 10, Math.PI * 0.72, Math.PI * 1.56, 0, Math.PI * 0.78), T(hc[0], hc[1] + 0.006, hc[2] - 0.012), P.PRIMARY, BI.head);
    gb.add(G.cone(hr * 0.5, hr * 0.9, 8), T(0, hc[1] + hr * 0.85, hc[2] - hr * 0.55, -55, 0, 0), P.PRIMARY, BI.head);
    gb.add(G.tor(0.07, 0.022, 6, 16), T(0, 0.8, 0, 90, 0, 0, 1, 1, 0.75), P.PRIMARY, BI.chest);
    if (R === 'human' && v === 2) ell([0, hc[1] - hr * 0.62, hc[2] + hr * 0.55], [hr * 0.55, hr * 0.6, hr * 0.45], P.HAIR, 'head'); // beard
  } else if (body === 'light') {
    if (R === 'orc') gb.add(G.box(0.022, 0.05, hr * 1.7), T(0, hc[1] + hr * 0.95, hc[2] - 0.01), P.HAIR, BI.head);
    else {
      if (R === 'undead') {
        gb.add(G.sph(hr * 1.18, 16, 10, Math.PI * 0.72, Math.PI * 1.56, 0, Math.PI * 0.74), T(hc[0], hc[1] + 0.006, hc[2] - 0.012), P.PRIMARY, BI.head);
      } else {
        gb.add(G.sph(hr * 1.09, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), T(hc[0], hc[1] + 0.02, hc[2] - 0.004), P.LEATHER, BI.head);
        gb.add(G.cyl(hr * 1.02, hr * 1.04, 0.014, 18, true), T(hc[0], hc[1] + 0.045, hc[2] - 0.004), P.PRIMARY, BI.head);
      }
    }
  } else {
    // commoner hair styles
    if (R === 'human') {
      if (v !== 3) capTop(hr * 1.06, P.HAIR, v === 1 ? 0.6 : 0.52);
      if (v === 1) ell([0, hc[1] - 0.03, hc[2] - hr * 0.72], [hr * 0.85, hr * 1.1, hr * 0.5], P.HAIR, 'head');
      if (v === 2 || v === 3) ell([0, hc[1] - hr * 0.62, hc[2] + hr * 0.55], [hr * 0.55, hr * 0.55, hr * 0.42], P.HAIR, 'head');
      if (v === 3) gb.add(G.cyl(hr * 0.95, hr * 1.12, 0.05, 16), T(hc[0], hc[1] + hr * 0.62, hc[2] - 0.004), P.LEATHER, BI.head); // cap
    } else if (R === 'orc') {
      if (v % 2 === 0) gb.add(G.box(0.022, 0.05, hr * 1.7), T(0, hc[1] + hr * 0.95, hc[2] - 0.01), P.HAIR, BI.head);
      else ell([0, hc[1] + hr * 0.88, hc[2] - hr * 0.4], [0.03, 0.04, 0.03], P.HAIR, 'head');
    } else if (v % 2 === 1) {
      capTop(hr * 1.04, P.HAIR, 0.42);
    }
  }

  const geo = gb.build(sh.height);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5 * sh.height, 0), 0.9 * sh.height);
  humanoidGeoCache.set(key, geo);
  return geo;
}

export interface HumanoidInstance {
  root: THREE.Group;              // contains the bone hierarchy + skinned mesh
  mesh: THREE.SkinnedMesh;
  bones: Record<BoneName, THREE.Bone>;
  gripR: THREE.Object3D;
  gripL: THREE.Object3D;
  chestSocket: THREE.Object3D;
  height: number;                 // nominal height (1.0 — race size differences are baked in)
  hipsHeight: number;             // rest height of the hips joint
}

/** A fresh rigged procedural humanoid sharing cached geometry. */
export function createHumanoid(race: RaceId, body: BodyVariant, variant: number, material: THREE.Material): HumanoidInstance {
  const sh = shapeOf(race);
  const J = rigJoints(sh);
  const geo = humanoidGeometry(race, body, variant);
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const name of BONE_NAMES) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
  }
  const inverses: THREE.Matrix4[] = [];
  for (const name of BONE_NAMES) {
    const p = BONE_PARENT[name];
    const w = J[name];
    const b = bones[name];
    if (p) {
      const pw = J[p];
      b.position.set((w[0] - pw[0]) * sh.height, (w[1] - pw[1]) * sh.height, (w[2] - pw[2]) * sh.height);
      bones[p].add(b);
    }
    inverses.push(new THREE.Matrix4().makeTranslation(-w[0] * sh.height, -w[1] * sh.height, -w[2] * sh.height));
  }
  const skeleton = new THREE.Skeleton(BONE_NAMES.map((n) => bones[n]), inverses);
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.name = 'body';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const root = new THREE.Group();
  root.name = 'humanoid';
  root.add(bones.root);
  root.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.boundingSphere = geo.boundingSphere!.clone();

  const gripR = new THREE.Object3D();
  gripR.name = 'grip.R';
  gripR.position.set(-0.034 * sh.height, -0.004, 0.004);
  gripR.quaternion.copy(GRIP_R);
  bones['hand.R'].add(gripR);
  const gripL = new THREE.Object3D();
  gripL.name = 'grip.L';
  gripL.position.set(0.034 * sh.height, -0.004, 0.004);
  gripL.quaternion.copy(GRIP_L);
  bones['hand.L'].add(gripL);
  const chestSocket = new THREE.Object3D();
  chestSocket.name = 'chest_socket';
  chestSocket.position.set(0, 0.07 * sh.height, 0.098 * sh.torso * sh.height);
  bones.chest.add(chestSocket);
  return { root, mesh, bones, gripR, gripL, chestSocket, height: 1.0, hipsHeight: 0.5 * sh.height };
}

// ═════════════════════════════ animation clips ═════════════════════════════
export interface ClipStyle {
  race: RaceId;
  hold: 'none' | 'weapon' | 'bow' | 'long';  // right hand (long = staff/spear: held upright)
  shield: boolean;
  melee: 'swing' | 'thrust' | 'punch';
  mounted: boolean;
}
type Euler3 = [number, number, number];
type Pose = Partial<Record<BoneName, Euler3>> & { _hips?: Euler3 };

const ORDER: Partial<Record<BoneName, THREE.EulerOrder>> = {
  'upperarm.L': 'XYZ', 'upperarm.R': 'XYZ', 'thigh.L': 'XYZ', 'thigh.R': 'XYZ',
};

function addPose(a: Pose, b: Pose, w = 1): Pose {
  const out: Pose = { ...a };
  for (const k of Object.keys(b) as (keyof Pose)[]) {
    const bv = b[k]!;
    const av = (out[k] as Euler3 | undefined) ?? [0, 0, 0];
    out[k] = [av[0] + bv[0] * w, av[1] + bv[1] * w, av[2] + bv[2] * w];
  }
  return out;
}
function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Pose>;
  for (const k of keys) {
    const av = (a[k] as Euler3 | undefined) ?? [0, 0, 0];
    const bv = (b[k] as Euler3 | undefined) ?? [0, 0, 0];
    out[k] = [av[0] + (bv[0] - av[0]) * t, av[1] + (bv[1] - av[1]) * t, av[2] + (bv[2] - av[2]) * t];
  }
  return out;
}
const eio = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Sample piecewise keyed poses; each key may carry its own easing into it. */
function keyed(keys: { t: number; p: Pose; ease?: (x: number) => number }[]): (t: number) => Pose {
  return (t) => {
    if (t <= keys[0].t) return keys[0].p;
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return lerpPose(a.p, b.p, (b.ease ?? eio)(u));
      }
    }
    return keys[keys.length - 1].p;
  };
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
function buildClip(name: string, duration: number, sample: (t: number) => Pose, hipsRest: number, scale: number, fps = 30): THREE.AnimationClip {
  const n = Math.max(2, Math.round(duration * fps) + 1);
  const times = new Float32Array(n);
  const rot: Record<string, Float32Array> = {};
  for (const b of BONE_NAMES) rot[b] = new Float32Array(n * 4);
  const hipsPos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    times[i] = u * duration;
    const pose = sample(u);
    for (const b of BONE_NAMES) {
      const e = pose[b] ?? [0, 0, 0];
      _e.set(e[0] * D2R, e[1] * D2R, e[2] * D2R, ORDER[b] ?? 'YXZ');
      _q.setFromEuler(_e);
      // keep quaternion hemisphere continuous for clean interpolation
      if (i > 0) {
        const o = (i - 1) * 4, arr = rot[b];
        if (arr[o] * _q.x + arr[o + 1] * _q.y + arr[o + 2] * _q.z + arr[o + 3] * _q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      }
      rot[b].set([_q.x, _q.y, _q.z, _q.w], i * 4);
    }
    const h = pose._hips ?? [0, 0, 0];
    hipsPos.set([h[0] * scale, hipsRest + h[1] * scale, h[2] * scale], i * 3);
  }
  const tracks: THREE.KeyframeTrack[] = BONE_NAMES.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times as unknown as number[], rot[b] as unknown as number[]));
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', times as unknown as number[], hipsPos as unknown as number[]));
  return new THREE.AnimationClip(name, duration, tracks);
}

const clipCache = new Map<string, THREE.AnimationClip[]>();
export const clipStyleKey = (s: ClipStyle): string => `${s.race}|${s.hold}|${s.shield ? 1 : 0}|${s.melee}|${s.mounted ? 1 : 0}`;

/** All 10 standard clips for a procedural humanoid in the given stance (cached). */
export function humanoidClips(style: ClipStyle): THREE.AnimationClip[] {
  const key = clipStyleKey(style);
  const cached = clipCache.get(key);
  if (cached) return cached;
  const race = style.race === 'monster' ? 'human' : style.race;
  const sh = shapeOf(race);
  const S = sh.height;
  const hipsRest = 0.5 * S;
  const ad = sh.armDown;
  const hunch = sh.hunch;
  const stance = race === 'orc' ? 7 : 4;
  const sin = Math.sin, cos = Math.cos, TAU = Math.PI * 2;

  // ── building blocks ──
  const relaxedR: Pose = { 'upperarm.R': [-6, 0, ad], 'forearm.R': [0, 16, 0], 'hand.R': [0, 0, -6] };
  const holdR: Pose =
    style.hold === 'weapon' ? { 'upperarm.R': [-14, 0, ad + 2], 'forearm.R': [0, 76, 0], 'hand.R': [-8, 0, 0] }
    : style.hold === 'long' ? { 'upperarm.R': [-10, 0, ad + 4], 'forearm.R': [0, 84, 0], 'hand.R': [0, 0, 0] }
    : style.hold === 'bow' ? { 'upperarm.R': [-8, 0, ad], 'forearm.R': [0, 58, 0], 'hand.R': [0, 0, 0] }
    : relaxedR;
  const relaxedL: Pose = { 'upperarm.L': [-6, 0, -ad], 'forearm.L': [0, -16, 0], 'hand.L': [0, 0, 6] };
  const shieldL: Pose = { 'upperarm.L': [-22, 0, -ad + 4], 'forearm.L': [0, -84, 0], 'hand.L': [0, 0, 0] };
  const armsBase: Pose = { ...(style.shield ? shieldL : relaxedL), ...holdR };
  const standLegs: Pose = { 'thigh.L': [0, 0, stance], 'thigh.R': [0, 0, -stance], 'foot.L': [0, 0, -stance], 'foot.R': [0, 0, stance] };
  const rideLegs: Pose = {
    'thigh.L': [-78, 0, 30], 'thigh.R': [-78, 0, -30], 'shin.L': [82, 0, 0], 'shin.R': [82, 0, 0],
    'foot.L': [-12, 0, 0], 'foot.R': [-12, 0, 0],
  };
  const reinsArms: Pose = {
    'upperarm.L': [-26, 0, -ad + 6], 'forearm.L': [0, -64, 0],
    ...(style.hold === 'none' ? { 'upperarm.R': [-26, 0, ad - 6], 'forearm.R': [0, 64, 0] } : {}),
  };
  const torsoBase: Pose = { spine: [hunch * 0.4, 0, 0], chest: [hunch * 0.6, 0, 0], neck: [-hunch * 0.5, 0, 0], head: [-hunch * 0.3, 0, race === 'undead' ? 5 : 0] };
  const legsFor = (p: Pose): Pose => (style.mounted ? { ...p, ...rideLegs, _hips: [0, 0, 0] } : p);
  const withLegs = (upper: Pose, legs: Pose): Pose => legsFor({ ...upper, ...legs });
  const base: Pose = withLegs({ ...torsoBase, ...armsBase, ...(style.mounted ? reinsArms : {}) }, standLegs);

  // ── idle ──
  const idle = (t: number): Pose => {
    const p = t * TAU;
    let pose: Pose = { ...base };
    pose = addPose(pose, {
      chest: [1.6 * sin(p), 1.5 * sin(p * 0.5 * 2), 0], spine: [0.8 * sin(p), 0, 0],
      head: [2 * sin(p * 2 + 1), 7 * sin(p), 0], neck: [0, 2 * sin(p), 0],
      'upperarm.L': [1.5 * sin(p + 0.5), 0, -1.2 * sin(p)], 'upperarm.R': [1.5 * sin(p + 0.8), 0, 1.2 * sin(p)],
      'shoulder.L': [0, 0, 1.2 * sin(p)], 'shoulder.R': [0, 0, -1.2 * sin(p)],
      'thigh.L': [0, 0, 0.8 * sin(p)], 'thigh.R': [0, 0, 0.8 * sin(p)],
    });
    pose._hips = style.mounted ? [0, 0.004 * sin(p * 2), 0] : [0.004 * sin(p), 0.003 * sin(p * 2), 0];
    if (!style.mounted) pose.hips = [0, 0, 1.2 * sin(p)];
    return pose;
  };

  // ── walk (a brisk march) ──
  const walk = (t: number): Pose => {
    const p = t * TAU;
    if (style.mounted) {
      const pose = idle(t);
      return addPose(pose, { spine: [3 + 2 * sin(p * 2), 0, 0], head: [-3 * sin(p * 2), 0, 0] });
    }
    const swingL = Math.max(0, cos(p)), swingR = Math.max(0, -cos(p));
    const amp = race === 'undead' ? 26 : 32;
    const armAmp = 20;
    const pose: Pose = { ...base };
    const legs: Pose = {
      'thigh.L': [-amp * sin(p) - 6 * swingL, 0, stance * 0.6], 'thigh.R': [amp * sin(p) - 6 * swingR, 0, -stance * 0.6],
      'shin.L': [6 + 52 * Math.pow(swingL, 1.4), 0, 0], 'shin.R': [6 + 52 * Math.pow(swingR, 1.4), 0, 0],
      'foot.L': [-6 + 14 * swingL - 10 * Math.max(0, sin(p)), 0, 0], 'foot.R': [-6 + 14 * swingR - 10 * Math.max(0, -sin(p)), 0, 0],
    };
    Object.assign(pose, legs);
    const armL = style.shield ? 4 : armAmp, armR = style.hold !== 'none' ? 6 : armAmp;
    const add: Pose = {
      hips: [0, 7 * sin(p), 0], spine: [4, -3 * sin(p), 0], chest: [1 + 1.5 * cos(p * 2), -7 * sin(p), 0], head: [-2, 3 * sin(p), 0],
      'upperarm.L': [armL * sin(p), 0, 0], 'upperarm.R': [-armR * sin(p), 0, 0],
      'forearm.L': [0, -(style.shield ? 0 : 14 + 8 * Math.max(0, -sin(p))), 0],
      'forearm.R': [0, style.hold !== 'none' ? 0 : 14 + 8 * Math.max(0, sin(p)), 0],
    };
    const out = addPose(pose, add);
    out._hips = [0, 0.012 * cos(p * 2) - 0.008, 0];
    return out;
  };

  // ── melee ──
  let meleeKeys: { t: number; p: Pose; ease?: (x: number) => number }[];
  if (style.melee === 'thrust') {
    meleeKeys = [
      { t: 0, p: base },
      { t: 0.3, p: withLegs({ ...base, 'upperarm.R': [16, 0, ad + 4], 'forearm.R': [0, 22, 0], 'upperarm.L': [-48, 0, -ad + 10], 'forearm.L': [0, -55, 0], chest: [-4, -22, 0], spine: [-2, -8, 0] }, { ...standLegs, 'thigh.L': [-14, 0, stance], 'thigh.R': [12, 0, -stance], _hips: [0, -0.01, -0.02] }) },
      { t: 0.42, ease: (x) => x * x, p: withLegs({ ...base, 'upperarm.R': [-52, 0, ad + 4], 'forearm.R': [0, 8, 0], 'upperarm.L': [-70, 0, -ad + 10], 'forearm.L': [0, -30, 0], chest: [12, 24, 0], spine: [6, 10, 0] }, { ...standLegs, 'thigh.L': [-34, 0, stance], 'shin.L': [24, 0, 0], 'thigh.R': [18, 0, -stance], 'shin.R': [8, 0, 0], _hips: [0, -0.025, 0.04] }) },
      { t: 0.62, p: withLegs({ ...base, 'upperarm.R': [-42, 0, ad + 4], 'forearm.R': [0, 14, 0], chest: [8, 16, 0] }, { ...standLegs, 'thigh.L': [-24, 0, stance], 'shin.L': [16, 0, 0], _hips: [0, -0.015, 0.025] }) },
      { t: 1, p: base },
    ];
  } else if (style.melee === 'punch') {
    meleeKeys = [
      { t: 0, p: base },
      { t: 0.3, p: withLegs({ ...base, 'upperarm.R': [-4, 0, ad + 6], 'forearm.R': [0, 110, 0], 'upperarm.L': [-40, 0, -ad + 8], 'forearm.L': [0, -100, 0], chest: [0, -24, 0] }, standLegs) },
      { t: 0.42, ease: (x) => x * x, p: withLegs({ ...base, 'upperarm.R': [-86, 0, ad + 8], 'forearm.R': [0, 6, 0], 'upperarm.L': [-30, 0, -ad + 4], 'forearm.L': [0, -110, 0], chest: [8, 28, 0], spine: [4, 8, 0] }, { ...standLegs, 'thigh.L': [-22, 0, stance], 'shin.L': [14, 0, 0], _hips: [0, -0.01, 0.03] }) },
      { t: 1, p: base },
    ];
  } else {
    meleeKeys = [
      { t: 0, p: base },
      { t: 0.32, p: withLegs({ ...base, 'upperarm.R': [-158, 12, ad - 18], 'forearm.R': [0, 52, 0], 'hand.R': [-20, 0, 0], 'upperarm.L': [-40, 0, -ad + 18], 'forearm.L': [0, -40, 0], chest: [-6, -24, 0], spine: [-4, -8, 0], head: [-4, 10, 0] }, { ...standLegs, 'thigh.L': [-10, 0, stance], 'thigh.R': [10, 0, -stance], _hips: [0, -0.005, -0.02] }) },
      { t: 0.46, ease: (x) => x * x, p: withLegs({ ...base, 'upperarm.R': [-36, -12, ad - 6], 'forearm.R': [0, 12, 0], 'hand.R': [10, 0, 0], 'upperarm.L': [12, 0, -ad + 4], 'forearm.L': [0, -30, 0], chest: [14, 28, 0], spine: [8, 10, 0], head: [6, -12, 0] }, { ...standLegs, 'thigh.L': [-32, 0, stance], 'shin.L': [22, 0, 0], 'thigh.R': [16, 0, -stance], 'shin.R': [6, 0, 0], _hips: [0, -0.03, 0.035] }) },
      { t: 0.62, p: withLegs({ ...base, 'upperarm.R': [-18, -16, ad - 2], 'forearm.R': [0, 22, 0], chest: [10, 22, 0], spine: [5, 6, 0] }, { ...standLegs, 'thigh.L': [-22, 0, stance], 'shin.L': [14, 0, 0], _hips: [0, -0.018, 0.02] }) },
      { t: 1, p: base },
    ];
  }
  const melee = keyed(meleeKeys);

  // ── ranged (longbow draw, bow in the right hand) ──
  const aimR: Pose = { 'upperarm.R': [0, 62, 0], 'forearm.R': [-90, 0, 0], 'hand.R': [0, 0, 0] };
  const twist: Pose = { hips: [0, style.mounted ? 0 : 8, 0], spine: [0, 6, 0], chest: [-2, 6, 0], head: [0, -18, 0] };
  const ranged = keyed([
    { t: 0, p: base },
    { t: 0.18, p: withLegs({ ...base, ...twist, ...aimR, 'upperarm.L': [0, -80, 0], 'forearm.L': [0, -62, 0] }, standLegs) },
    { t: 0.55, p: withLegs({ ...base, ...twist, ...aimR, 'upperarm.L': [0, 24, -4], 'forearm.L': [0, -150, 0] }, standLegs) },
    { t: 0.6, ease: (x) => 1 - (1 - x) * (1 - x), p: withLegs({ ...base, ...twist, ...aimR, 'upperarm.R': [-2, 60, 0], 'upperarm.L': [0, 36, -8], 'forearm.L': [0, -164, 0], 'hand.L': [0, 0, 20] }, standLegs) },
    { t: 0.82, p: withLegs({ ...base, ...twist, ...aimR, 'upperarm.L': [0, 30, -20], 'forearm.L': [0, -120, 0] }, standLegs) },
    { t: 1, p: base },
  ]);

  // ── cast ──
  const cast = keyed([
    { t: 0, p: base },
    { t: 0.36, p: withLegs({ ...base, 'upperarm.R': [-118, 0, ad - 10], 'forearm.R': [0, 42, 0], 'upperarm.L': [-72, 0, -ad + 18], 'forearm.L': [0, -42, 0], 'hand.L': [0, 0, 20], chest: [-9, -6, 0], spine: [-4, 0, 0], head: [-12, 0, 0] }, { ...standLegs, _hips: [0, -0.008, -0.01] }) },
    { t: 0.55, ease: (x) => x * x, p: withLegs({ ...base, 'upperarm.R': [-82, 0, ad + 2], 'forearm.R': [0, 4, 0], 'upperarm.L': [-84, 0, -ad + 4], 'forearm.L': [0, -8, 0], chest: [10, 6, 0], spine: [5, 0, 0], head: [4, 0, 0] }, { ...standLegs, 'thigh.L': [-18, 0, stance], 'shin.L': [12, 0, 0], _hips: [0, -0.015, 0.02] }) },
    { t: 0.75, p: withLegs({ ...base, 'upperarm.R': [-74, 0, ad + 2], 'forearm.R': [0, 10, 0], 'upperarm.L': [-60, 0, -ad + 8], 'forearm.L': [0, -20, 0], chest: [6, 4, 0] }, { ...standLegs, 'thigh.L': [-12, 0, stance], _hips: [0, -0.008, 0.012] }) },
    { t: 1, p: base },
  ]);

  // ── hit ──
  const hit = keyed([
    { t: 0, p: base },
    { t: 0.16, ease: (x) => 1 - (1 - x) * (1 - x), p: withLegs({ ...base, spine: [-14, 4, 0], chest: [-12, 8, 4], head: [-18, -6, 0], 'upperarm.L': [-20, 0, -ad + 28], 'upperarm.R': [-20, 0, ad - 28] }, { ...standLegs, 'thigh.L': [6, 0, stance], 'thigh.R': [10, 0, -stance], 'shin.R': [10, 0, 0], _hips: [0, -0.01, -0.03] }) },
    { t: 1, p: base },
  ]);

  // ── death (ends lying on the back) ──
  const deathKeys = [
    { t: 0, p: base },
    { t: 0.16, p: withLegs({ ...base, spine: [-16, 0, 0], chest: [-12, 0, 0], head: [-22, 0, 0], 'upperarm.L': [-30, 0, -40], 'upperarm.R': [-30, 0, 40] }, { ...standLegs, _hips: [0, 0, -0.03] }) },
    { t: 0.4, p: withLegs({ ...base, spine: [22, 0, 0], chest: [12, 0, 0], head: [28, 0, 0], 'upperarm.L': [-10, 0, -60], 'upperarm.R': [-10, 0, 60] }, { 'thigh.L': [-58, 0, 10], 'thigh.R': [-50, 0, -10], 'shin.L': [100, 0, 0], 'shin.R': [96, 0, 0], 'foot.L': [-40, 0, 0], 'foot.R': [-40, 0, 0], _hips: [0, -0.2, -0.02] }) },
    { t: 0.75, ease: (x: number) => x * x, p: withLegs({ ...base, hips: [-86, 0, 0], spine: [-6, 0, 0], chest: [-4, 0, 0], head: [-10, 20, 0], 'upperarm.L': [10, 0, -38], 'upperarm.R': [10, 0, 38], 'forearm.L': [0, -30, 0], 'forearm.R': [0, 30, 0] }, { 'thigh.L': [-22, 0, 12], 'thigh.R': [-14, 0, -10], 'shin.L': [36, 0, 0], 'shin.R': [20, 0, 0], _hips: [0, -0.44, -0.12] }) },
    { t: 1, p: withLegs({ ...base, hips: [-90, 0, 0], spine: [-4, 0, 0], chest: [-2, 0, 0], head: [-6, 26, 0], 'upperarm.L': [6, 0, -34], 'upperarm.R': [6, 0, 34], 'forearm.L': [0, -24, 0], 'forearm.R': [0, 24, 0] }, { 'thigh.L': [-10, 0, 12], 'thigh.R': [-6, 0, -10], 'shin.L': [18, 0, 0], 'shin.R': [8, 0, 0], _hips: [0, -0.445, -0.13] }) },
  ];
  const death = keyed(deathKeys);

  // ── work (hammering, looped) ──
  const workUp: Pose = withLegs({ ...base, 'upperarm.R': [-118, 0, ad - 8], 'forearm.R': [0, 84, 0], 'upperarm.L': [-42, 0, -ad + 10], 'forearm.L': [0, -52, 0], spine: [12, 0, 0], chest: [10, -6, 0], head: [16, 0, 0] }, { 'thigh.L': [-22, 0, stance + 4], 'thigh.R': [-10, 0, -stance - 4], 'shin.L': [34, 0, 0], 'shin.R': [24, 0, 0], 'foot.L': [-12, 0, 0], 'foot.R': [-14, 0, 0], _hips: [0, -0.03, 0] });
  const workDown: Pose = { ...workUp, 'upperarm.R': [-42, 0, ad - 2], 'forearm.R': [0, 22, 0], chest: [16, 6, 0], spine: [16, 0, 0] };
  const work = keyed([
    { t: 0, p: workUp }, { t: 0.5, p: workUp }, { t: 0.66, ease: (x) => x * x, p: workDown }, { t: 0.74, p: workDown }, { t: 1, p: workUp },
  ]);

  // ── riding (always seated, regardless of style.mounted) ──
  const seat = (p: Pose): Pose => ({ ...p, ...rideLegs, _hips: [0, 0, 0] });
  const rideIdle = (t: number): Pose => {
    const p = t * TAU;
    const pose = seat({ ...torsoBase, ...armsBase, ...reinsArms });
    return addPose(pose, { chest: [1.5 * sin(p), 0, 0], head: [2 * sin(p * 2), 6 * sin(p), 0] });
  };
  const rideBase = seat({ ...torsoBase, ...armsBase, ...reinsArms });
  const rideAttack = keyed([
    { t: 0, p: rideBase },
    { t: 0.32, p: seat({ ...rideBase, 'upperarm.R': [-158, 12, ad - 18], 'forearm.R': [0, 52, 0], chest: [-8, -26, 0], spine: [-4, -8, 0] }) },
    { t: 0.46, ease: (x) => x * x, p: seat({ ...rideBase, 'upperarm.R': [-40, -12, ad - 4], 'forearm.R': [0, 12, 0], chest: [16, 28, 0], spine: [10, 10, 0] }) },
    { t: 0.64, p: seat({ ...rideBase, 'upperarm.R': [-20, -16, ad], 'forearm.R': [0, 22, 0], chest: [10, 20, 0] }) },
    { t: 1, p: rideBase },
  ]);

  const durMelee = style.melee === 'punch' ? 0.75 : style.melee === 'thrust' ? 0.9 : 1.0;
  const clips = [
    buildClip('idle', race === 'undead' ? 3.0 : 2.6, idle, hipsRest, S),
    buildClip('walk', 0.62, walk, hipsRest, S),
    buildClip('attack_melee', durMelee, style.mounted ? rideAttack : melee, hipsRest, S),
    buildClip('attack_ranged', 1.1, ranged, hipsRest, S),
    buildClip('cast', 1.2, cast, hipsRest, S),
    buildClip('hit', 0.5, hit, hipsRest, S),
    buildClip('death', 1.5, death, hipsRest, S),
    buildClip('work', 0.9, work, hipsRest, S),
    buildClip('ride_idle', 2.6, rideIdle, hipsRest, S),
    buildClip('ride_attack', 1.0, rideAttack, hipsRest, S),
  ];
  clipCache.set(key, clips);
  return clips;
}

/** Normalised time (0..1) of the impact / release moment inside each procedural clip. */
export const CLIP_IMPACT: Record<string, number> = {
  attack_melee: 0.46, attack_ranged: 0.6, cast: 0.55, ride_attack: 0.46, work: 0.66, hit: 0.15,
};
export const MELEE_IMPACT: Record<ClipStyle['melee'], number> = { swing: 0.46, thrust: 0.42, punch: 0.42 };

// ═════════════════════════════ equipment ═════════════════════════════
export interface ItemModel {
  geometry: THREE.BufferGeometry;
  /** Far end (projectile origin / spell tip) in item space. */
  tip: THREE.Vector3;
  /** Optional emissive glow sprite (crystal, gem). */
  glow?: { pos: THREE.Vector3; size: number; color: string };
}
const itemCache = new Map<string, ItemModel>();

/** Procedural item (grip at origin, long axis +Y, edge/face +Z, unit-space proportions). Shields: id 'shield'. */
export function itemModel(id: ItemId, race: RaceId): ItemModel {
  const r: 'human' | 'orc' | 'undead' = race === 'monster' ? 'human' : race;
  const key = `${id}|${r}`;
  const hit = itemCache.get(key);
  if (hit) return hit;
  const gb = new GeoBuilder(false);
  const P = UP;
  let tip = new THREE.Vector3(0, 0.3, 0);
  let glow: ItemModel['glow'];
  const k = r === 'orc' ? 1.15 : 1;
  switch (id) {
    case 'sword': {
      const bl = r === 'orc' ? 0.36 : 0.34, bw = r === 'orc' ? 0.06 : 0.044;
      gb.add(G.box(0.012, bl, bw), T(0, 0.06 + bl / 2, 0), P.METAL);
      gb.add(G.cone(bw * 0.72, 0.075, 4), T(0, 0.06 + bl + 0.037, 0, 0, 45, 0, 0.27, 1, 1.0), P.METAL);
      gb.add(G.box(0.014, bl * 0.75, 0.01), T(0, 0.06 + bl * 0.42, 0), P.DETAIL);
      gb.add(G.rbox(0.026, 0.022, 0.15, 0.007), T(0, 0.05, 0), r === 'human' ? P.GOLD : P.METAL);
      gb.add(G.cyl(0.012, 0.012, 0.09, 8), T(0, 0.0, 0), P.LEATHER);
      gb.add(G.sph(0.019, 10, 8), T(0, -0.05, 0), r === 'human' ? P.GOLD : P.METAL);
      tip = new THREE.Vector3(0, 0.06 + bl + 0.07, 0);
      break;
    }
    case 'spear': {
      gb.add(G.cyl(0.011, 0.012, 0.92, 8), T(0, 0.07, 0), P.WOOD);
      gb.add(G.cyl(0.014, 0.016, 0.045, 8), T(0, 0.53, 0), P.METAL);
      gb.add(G.cone(0.032, 0.16, 4), T(0, 0.63, 0, 0, 45, 0, 0.42, 1, 1), P.METAL);
      gb.add(G.tor(0.0125, 0.004, 4, 10), T(0, 0.5, 0, 90, 0, 0), P.LEATHER);
      gb.add(G.tor(0.0125, 0.004, 4, 10), T(0, 0.08, 0, 90, 0, 0), P.LEATHER);
      gb.add(G.box(0.004, 0.06, 0.1), T(0, 0.46, -0.058), P.PRIMARY);
      gb.add(G.cone(0.012, 0.04, 6), T(0, -0.405, 0, 180, 0, 0), P.METAL);
      tip = new THREE.Vector3(0, 0.71, 0);
      break;
    }
    case 'axe': {
      gb.add(G.cyl(0.012, 0.015, 0.54 * k, 8), T(0, 0.15 * k, 0), P.WOOD);
      const s = new THREE.Shape();
      s.moveTo(0, 0.4); s.lineTo(0.05, 0.415); s.lineTo(0.12, 0.475);
      s.quadraticCurveTo(0.17, 0.36, 0.12, 0.245); s.lineTo(0.05, 0.31); s.lineTo(0, 0.32); s.lineTo(0, 0.4);
      gb.add(G.extrude(s, 0.016), T(0, (k - 1) * 0.4, 0, 0, -90, 0, k), P.METAL);
      const b = new THREE.Shape();
      b.moveTo(0, 0.39); b.lineTo(-0.075, 0.36); b.lineTo(0, 0.33); b.lineTo(0, 0.39);
      gb.add(G.extrude(b, 0.014), T(0, (k - 1) * 0.36, 0, 0, -90, 0, k), r === 'orc' ? P.BONE : P.METAL);
      gb.add(G.cyl(0.017, 0.017, 0.06, 8), T(0, 0.0, 0), P.LEATHER);
      gb.add(G.cyl(0.016, 0.016, 0.03, 8), T(0, 0.36 * k, 0), P.METAL);
      tip = new THREE.Vector3(0, 0.44 * k, 0.15 * k);
      break;
    }
    case 'bow': {
      const pts: V3[] = [];
      for (let i = 0; i <= 12; i++) {
        const y = -0.33 + (i / 12) * 0.66;
        const u = Math.abs(y) / 0.33;
        pts.push([0, y, 0.09 * (1 - u * u) - 0.09 + 0.025 * Math.pow(u, 6)]);
      }
      gb.add(G.tube(pts, r === 'orc' ? 0.013 : 0.011, 28, 6), null, r === 'undead' ? P.BONE : P.WOOD);
      gb.add(G.cyl(0.015, 0.015, 0.08, 8), T(0, 0, 0), P.LEATHER);
      const ty = 0.325, tz = -0.065;
      const st = span([0, -ty, tz], [0, ty, tz]);
      gb.add(G.cyl(0.0028, 0.0028, st.len, 4), st.m, P.BONE);
      tip = new THREE.Vector3(0, 0, 0.02);
      break;
    }
    case 'staff': {
      gb.add(G.cyl(0.013, 0.017, 0.86, 8), T(0, 0, 0), r === 'undead' ? P.BONE : P.WOOD);
      gb.add(G.sph(0.02, 8, 6), T(0, -0.18, 0, 0, 0, 0, 1, 1.4, 1), r === 'undead' ? P.BONE : P.WOOD);
      gb.add(G.sph(0.019, 8, 6), T(0, 0.17, 0, 0, 0, 0, 1, 1.3, 1), r === 'undead' ? P.BONE : P.WOOD);
      gb.add(G.tor(0.019, 0.006, 4, 12), T(0, 0.43, 0, 90, 0, 0), P.GOLD);
      if (r === 'undead') {
        gb.add(G.sph(0.04, 12, 10), T(0, 0.47, 0, 0, 0, 0, 1, 1.05, 1.05), P.BONE);
        for (const s of [1, -1]) gb.add(G.sph(0.011, 6, 5), T(s * 0.015, 0.475, 0.034), P.DETAIL);
        gb.add(G.oct(0.04), T(0, 0.56, 0, 0, 0, 0, 1, 1.5, 1), P.GLOW);
        tip = new THREE.Vector3(0, 0.6, 0);
        glow = { pos: new THREE.Vector3(0, 0.56, 0), size: 0.3, color: RACE_GLOW.undead };
      } else {
        for (let i = 0; i < 3; i++) {
          const a = i * 120;
          gb.add(G.cone(0.011, 0.1, 5), T(Math.sin(a * D2R) * 0.03, 0.49, Math.cos(a * D2R) * 0.03, Math.cos(a * D2R) * 22, 0, -Math.sin(a * D2R) * 22), r === 'orc' ? P.BONE : P.WOOD);
        }
        gb.add(G.oct(0.045), T(0, 0.525, 0, 0, 0, 0, 1, 1.6, 1), P.GLOW);
        tip = new THREE.Vector3(0, 0.6, 0);
        glow = { pos: new THREE.Vector3(0, 0.525, 0), size: 0.32, color: RACE_GLOW[r] };
      }
      break;
    }
    case 'wand': {
      gb.add(G.cyl(0.006, 0.009, 0.3, 6), T(0, 0.08, 0), r === 'undead' ? P.BONE : P.WOOD);
      gb.add(G.cyl(0.011, 0.011, 0.07, 8), T(0, -0.02, 0), r === 'human' ? P.GOLD : P.LEATHER);
      gb.add(G.tor(0.009, 0.003, 4, 10), T(0, 0.225, 0, 90, 0, 0), P.GOLD);
      gb.add(G.oct(0.019), T(0, 0.248, 0, 0, 0, 0, 1, 1.5, 1), P.GLOW);
      tip = new THREE.Vector3(0, 0.27, 0);
      glow = { pos: new THREE.Vector3(0, 0.248, 0), size: 0.16, color: RACE_GLOW[r] };
      break;
    }
    case 'shield': {
      const zc = 0.035;
      if (r === 'orc') {
        const R0 = 0.17;
        gb.add(G.cyl(R0, R0, 0.026, 22), T(0, 0, zc, 90, 0, 0), P.WOOD);
        for (const x of [-0.085, 0, 0.085]) {
          const h = 2 * Math.sqrt(R0 * R0 - x * x) * 0.97;
          gb.add(G.box(0.004, h, 0.004), T(x + 0.042, 0, zc + 0.014), P.DETAIL);
        }
        gb.add(G.tor(0.115, 0.016, 5, 24), T(0, 0, zc + 0.012), P.PRIMARY);
        gb.add(G.tor(R0, 0.012, 6, 28), T(0, 0, zc), P.METAL);
        gb.add(G.sph(0.045, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), T(0, 0, zc + 0.01, 90, 0, 0), P.METAL);
        gb.add(G.cone(0.014, 0.05, 6), T(0, 0, zc + 0.065, 90, 0, 0), P.BONE);
      } else if (r === 'undead') {
        const sh = new THREE.Shape();
        sh.moveTo(-0.1, 0.2); sh.lineTo(0.1, 0.2); sh.lineTo(0.135, 0.08); sh.lineTo(0.095, -0.2); sh.lineTo(-0.095, -0.2); sh.lineTo(-0.135, 0.08); sh.lineTo(-0.1, 0.2);
        gb.add(G.extrude(sh, 0.022), T(0, 0, zc), P.METAL);
        const face = sh.getPoints().map((p) => p.clone().multiplyScalar(0.86));
        gb.add(G.extrude(new THREE.Shape(face), 0.012), T(0, -0.004, zc + 0.012), P.DARK);
        gb.add(G.box(0.03, 0.33, 0.012), T(0, -0.005, zc + 0.02), P.PRIMARY);
        gb.add(G.sph(0.04, 12, 10), T(0, 0.04, zc + 0.03, 0, 0, 0, 1, 1.1, 0.7), P.BONE);
        for (const s of [1, -1]) gb.add(G.sph(0.011, 6, 5), T(s * 0.016, 0.048, zc + 0.056), P.DETAIL);
        for (const s of [1, -1]) gb.add(G.cone(0.014, 0.07, 5), T(s * 0.12, 0.2, zc, 0, 0, -s * 30), P.METAL);
      } else {
        const sh = new THREE.Shape();
        sh.moveTo(-0.125, 0.17); sh.quadraticCurveTo(0, 0.205, 0.125, 0.17); sh.quadraticCurveTo(0.13, -0.02, 0, -0.21); sh.quadraticCurveTo(-0.13, -0.02, -0.125, 0.17);
        gb.add(G.extrude(sh, 0.02), T(0, 0, zc), P.METAL);
        const face = sh.getPoints(10).map((p) => new THREE.Vector2(p.x * 0.88, p.y * 0.88 - 0.002));
        gb.add(G.extrude(new THREE.Shape(face), 0.012), T(0, 0, zc + 0.01), P.PRIMARY);
        gb.add(G.box(0.032, 0.27, 0.01), T(0, -0.01, zc + 0.018), P.ACCENT);
        gb.add(G.box(0.17, 0.032, 0.01), T(0, 0.07, zc + 0.018), P.ACCENT);
        gb.add(G.sph(0.024, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), T(0, 0.07, zc + 0.02, 90, 0, 0), P.GOLD);
      }
      gb.add(G.box(0.03, 0.12, 0.012), T(0, 0, 0.012), P.LEATHER);
      tip = new THREE.Vector3(0, 0, zc + 0.04);
      break;
    }
    case 'tools': {
      gb.add(G.cyl(0.011, 0.013, 0.33, 8), T(0, 0.09, 0), P.WOOD);
      gb.add(G.rbox(0.046, 0.05, 0.12, 0.008), T(0, 0.27, 0.01), P.METAL);
      gb.add(G.cone(0.02, 0.06, 4), T(0, 0.27, -0.075, -90, 45, 0, 1, 1, 0.5), P.METAL);
      gb.add(G.cyl(0.015, 0.015, 0.06, 8), T(0, -0.02, 0), P.LEATHER);
      tip = new THREE.Vector3(0, 0.27, 0.07);
      break;
    }
    default: {
      gb.add(G.sph(0.02), null, P.METAL);
    }
  }
  const model: ItemModel = { geometry: gb.build(), tip, glow };
  itemCache.set(key, model);
  return model;
}

// ═════════════════════════════ mounts ═════════════════════════════
export type MountKind = 'horse' | 'wolf' | 'nightmare';
export interface QuadrupedRig {
  group: THREE.Group;
  body: THREE.Object3D;          // bobs / pitches
  head?: THREE.Object3D;
  tail?: THREE.Object3D;
  legs: { hip: THREE.Object3D; knee: THREE.Object3D; front: boolean; side: number }[];
  extra: THREE.Object3D[];       // floating bits etc.
  saddle: THREE.Vector3;
  height: number;
}
const partCache = new Map<string, THREE.BufferGeometry>();
function cachedPart(key: string, build: (gb: GeoBuilder) => void): THREE.BufferGeometry {
  let g = partCache.get(key);
  if (!g) {
    const gb = new GeoBuilder(false);
    build(gb);
    g = gb.build();
    partCache.set(key, g);
  }
  return g;
}
function partMesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** A procedural mount (or monster quadruped) with leg pivots for transform animation. */
export function createQuadruped(kind: MountKind | 'wolfbeast', mat: THREE.Material, tack: boolean): QuadrupedRig {
  const P = UP;
  const isWolf = kind === 'wolf' || kind === 'wolfbeast';
  const night = kind === 'nightmare';
  const group = new THREE.Group();
  group.name = `mount_${kind}`;
  const body = new THREE.Group();
  group.add(body);
  const legs: QuadrupedRig['legs'] = [];
  const tkey = `${kind}|${tack ? 1 : 0}`;
  let saddle: THREE.Vector3;
  let head: THREE.Object3D, tail: THREE.Object3D;
  if (!isWolf) {
    // ── horse / nightmare ──
    body.add(partMesh(cachedPart(`body|${tkey}`, (gb) => {
      gb.add(G.cap(0.13, 0.42, 14), T(0, 0.58, -0.01, 90, 0, 0, 1, 1, 1.12), P.COAT);
      gb.add(G.sph(0.135, 14, 10), T(0, 0.6, 0.22, 0, 0, 0, 0.95, 1.08, 1), P.COAT);
      gb.add(G.sph(0.142, 14, 10), T(0, 0.61, -0.21, 0, 0, 0, 1, 1.02, 1), P.COAT);
      const nk = span([0, 0.64, 0.25], [0, 0.88, 0.4]);
      gb.add(G.cyl(0.062, 0.1, nk.len, 12), nk.m, P.COAT);
      gb.add(G.box(0.03, 0.3, 0.07), T(0, 0.81, 0.31, 34, 0, 0), night ? P.COAT2 : P.COAT2);
      if (night) for (let i = 0; i < 5; i++) gb.add(G.cone(0.016, 0.07, 5), T(0, 0.74, 0.12 - i * 0.09, -20, 0, 0), P.BONE);
      if (tack) {
        gb.add(G.cyl(0.155, 0.155, 0.27, 14, true, Math.PI - 1.15, 2.3), T(0, 0.585, -0.03, 90, 0, 0, 1, 1, 1.12), P.PRIMARY);
        gb.add(G.rbox(0.18, 0.05, 0.22, 0.02), T(0, 0.735, -0.03), P.LEATHER);
        gb.add(G.box(0.17, 0.05, 0.03), T(0, 0.77, 0.07), P.LEATHER);
        gb.add(G.box(0.16, 0.07, 0.03), T(0, 0.775, -0.135), P.LEATHER);
        if (night) {
          for (const s of [1, -1]) gb.add(G.box(0.012, 0.22, 0.5), T(s * 0.158, 0.47, -0.02, 0, 0, s * 4), P.PRIMARY);
          for (const s of [1, -1]) for (let i = 0; i < 6; i++) gb.add(G.cone(0.03, 0.06, 3), T(s * 0.158, 0.335, -0.24 + i * 0.088, 180, 0, 0, 0.4, 1, 1), P.PRIMARY);
        } else {
          const cap = new THREE.Shape();
          cap.moveTo(-0.31, 0.6);
          cap.quadraticCurveTo(0, 0.7, 0.31, 0.6);
          cap.lineTo(0.3, 0.42);
          for (let i = 0; i < 7; i++) {
            const z0 = 0.3 - (i / 7) * 0.6, z1 = 0.3 - ((i + 1) / 7) * 0.6;
            cap.quadraticCurveTo((z0 + z1) / 2, 0.33, z1, 0.4);
          }
          cap.lineTo(-0.31, 0.6);
          const trim = new THREE.Shape();
          trim.moveTo(0.3, 0.45);
          for (let i = 0; i < 7; i++) {
            const z0 = 0.3 - (i / 7) * 0.6, z1 = 0.3 - ((i + 1) / 7) * 0.6;
            trim.quadraticCurveTo((z0 + z1) / 2, 0.38, z1, 0.45);
          }
          trim.lineTo(-0.3, 0.4);
          for (let i = 6; i >= 0; i--) {
            const z0 = 0.3 - ((i + 1) / 7) * 0.6, z1 = 0.3 - (i / 7) * 0.6;
            trim.quadraticCurveTo((z0 + z1) / 2, 0.33, z1, 0.4);
          }
          for (const s of [1, -1]) {
            gb.add(G.extrude(cap, 0.01), T(s * 0.158, 0, -0.02, 0, 90, s * 4), P.PRIMARY);
            gb.add(G.extrude(trim, 0.012), T(s * 0.163, 0, -0.02, 0, 90, s * 4), P.ACCENT);
            gb.add(G.sph(0.035, 10, 6), T(s * 0.168, 0.52, -0.02, 0, 0, 0, 0.3, 1, 1), P.ACCENT);
          }
        }
      }
    }), mat));
    head = new THREE.Group();
    head.position.set(0, 0.88, 0.41);
    body.add(head);
    head.add(partMesh(cachedPart(`head|${tkey}`, (gb) => {
      gb.add(G.sph(0.062, 12, 10), T(0, 0.015, 0.02, 0, 0, 0, 0.85, 1, 1.2), P.COAT);
      const mz = span([0, 0.0, 0.05], [0, -0.075, 0.19]);
      gb.add(G.cyl(0.034, 0.05, mz.len, 10), mz.m, P.COAT);
      gb.add(G.sph(0.036, 10, 8), T(0, -0.078, 0.19), P.COAT);
      for (const s of [1, -1]) {
        gb.add(G.cone(0.016, 0.06, 6), T(s * 0.03, 0.085, 0.0, -10, 0, -s * 12), P.COAT);
        gb.add(G.sph(night ? 0.012 : 0.01, 8, 6), T(s * 0.046, 0.03, 0.06), night ? P.EYE : P.DETAIL);
        gb.add(G.sph(0.007, 6, 4), T(s * 0.018, -0.083, 0.222), P.DETAIL);
      }
      gb.add(G.box(0.025, 0.05, 0.05), T(0, 0.06, 0.06, 20, 0, 0), P.COAT2); // forelock
      if (tack) {
        gb.add(G.box(0.07, 0.03, 0.16), T(0, 0.03, 0.08, -30, 0, 0), night ? P.METAL : P.METAL); // chanfron
        gb.add(G.tor(0.04, 0.005, 4, 12), T(0, -0.05, 0.14, 0, 90, 0, 1, 1.2, 1), P.LEATHER);
        if (night) for (const s of [1, -1]) gb.add(G.cone(0.012, 0.08, 5), T(s * 0.03, 0.1, 0.04, -30, 0, -s * 25), P.BONE);
      }
    }), mat));
    tail = new THREE.Group();
    tail.position.set(0, 0.66, -0.34);
    body.add(tail);
    tail.add(partMesh(cachedPart(`tail|${kind}`, (gb) => {
      const tl = span([0, 0, 0], [0, -0.3, -0.1]);
      gb.add(G.cyl(0.018, 0.05, tl.len, 8), tl.m, P.COAT2);
      gb.add(G.sph(0.05, 8, 6), T(0, -0.29, -0.1, 0, 0, 0, 1, 1.4, 1), P.COAT2);
    }), mat));
    const legDefs: [number, number, number, boolean][] = [[0.075, 0.52, 0.21, true], [-0.075, 0.52, 0.21, true], [0.078, 0.55, -0.21, false], [-0.078, 0.55, -0.21, false]];
    for (const [x, y, z, front] of legDefs) {
      const hip = new THREE.Group();
      hip.position.set(x, y, z);
      body.add(hip);
      const up = front ? 0.24 : 0.265;
      hip.add(partMesh(cachedPart(`legU|${kind}|${front ? 1 : 0}`, (gb) => {
        const s = span([0, 0, 0], [0, -up, front ? 0.0 : -0.02]);
        gb.add(G.cyl(0.034, 0.052, s.len, 10), s.m, P.COAT);
        gb.add(G.sph(0.05, 10, 8), T(0, 0, 0), P.COAT);
      }), mat));
      const knee = new THREE.Group();
      knee.position.set(0, -up, front ? 0 : -0.02);
      hip.add(knee);
      knee.add(partMesh(cachedPart(`legL|${kind}|${front ? 1 : 0}`, (gb) => {
        const lo = y - up - 0.035;
        const s = span([0, 0, 0], [0, -lo, 0.01]);
        gb.add(G.cyl(0.024, 0.029, s.len, 8), s.m, P.COAT);
        gb.add(G.sph(0.03, 8, 6), T(0, 0, 0), P.COAT);
        gb.add(G.cyl(0.034, 0.037, 0.045, 10), T(0, -lo - 0.006, 0.012), night ? P.COAT2 : P.DETAIL);
        if (tack && !night && front) gb.add(G.cyl(0.033, 0.033, 0.05, 8), T(0, -lo * 0.55, 0.005), P.ACCENT);
      }), mat));
      legs.push({ hip, knee, front, side: Math.sign(x) });
    }
    saddle = new THREE.Vector3(0, 0.75, -0.03);
  } else {
    // ── dire wolf ──
    body.add(partMesh(cachedPart(`body|${tkey}`, (gb) => {
      gb.add(G.cap(0.125, 0.42, 14), T(0, 0.45, -0.04, 90, 0, 0, 1, 1, 1.1), P.COAT);
      gb.add(G.sph(0.15, 14, 10), T(0, 0.5, 0.18, 0, 0, 0, 1, 1.05, 1), P.COAT);
      gb.add(G.sph(0.16, 14, 10), T(0, 0.54, 0.22, 0, 0, 0, 1.02, 0.92, 0.82), P.COAT2);
      gb.add(G.sph(0.125, 12, 10), T(0, 0.46, -0.25), P.COAT);
      const nk = span([0, 0.53, 0.27], [0, 0.6, 0.39]);
      gb.add(G.cyl(0.085, 0.11, nk.len, 12), nk.m, P.COAT2);
      if (tack) {
        gb.add(G.cyl(0.145, 0.145, 0.26, 14, true, Math.PI - 1.2, 2.4), T(0, 0.455, -0.05, 90, 0, 0, 1, 1, 1.1), P.PRIMARY);
        gb.add(G.rbox(0.16, 0.045, 0.2, 0.018), T(0, 0.6, -0.05), P.LEATHER);
        gb.add(G.box(0.15, 0.06, 0.03), T(0, 0.64, -0.145), P.LEATHER);
        for (const s of [1, -1]) {
          gb.add(G.tube([[s * 0.05, 0.62, 0.04], [s * 0.08, 0.68, 0.06], [s * 0.07, 0.74, 0.03]], 0.012, 8, 5), null, P.BONE);
          gb.add(G.box(0.01, 0.15, 0.2), T(s * 0.15, 0.41, -0.05, 0, 0, s * 6), P.PRIMARY);
          for (let i = 0; i < 3; i++) gb.add(G.sph(0.012, 6, 5), T(s * 0.158, 0.34, -0.11 + i * 0.06), P.BONE);
        }
      }
    }), mat));
    head = new THREE.Group();
    head.position.set(0, 0.6, 0.4);
    body.add(head);
    head.add(partMesh(cachedPart(`head|${tkey}`, (gb) => {
      gb.add(G.sph(0.075, 12, 10), T(0, 0.012, 0.03, 0, 0, 0, 1, 0.9, 1.1), P.COAT);
      const sn = span([0, -0.005, 0.08], [0, -0.03, 0.2]);
      gb.add(G.cyl(0.03, 0.042, sn.len, 10), sn.m, P.COAT);
      gb.add(G.sph(0.016, 8, 6), T(0, -0.03, 0.207), P.DETAIL);
      gb.add(G.box(0.055, 0.02, 0.1), T(0, -0.055, 0.13), P.COAT2);
      for (const s of [1, -1]) {
        gb.add(G.cone(0.027, 0.075, 5), T(s * 0.042, 0.075, 0.0, -12, 0, -s * 14), P.COAT2);
        gb.add(G.sph(0.011, 8, 6), T(s * 0.038, 0.025, 0.09), P.EYE);
        gb.add(G.cone(0.006, 0.026, 4), T(s * 0.022, -0.048, 0.18, 180, 0, 0), P.BONE);
      }
    }), mat));
    tail = new THREE.Group();
    tail.position.set(0, 0.5, -0.36);
    body.add(tail);
    tail.add(partMesh(cachedPart(`tail|${kind}`, (gb) => {
      const t1 = span([0, 0, 0], [0, -0.06, -0.14]);
      gb.add(G.cyl(0.04, 0.035, t1.len, 8), t1.m, P.COAT2);
      const t2 = span([0, -0.06, -0.14], [0, -0.19, -0.22]);
      gb.add(G.cyl(0.03, 0.045, t2.len, 8), t2.m, P.COAT2);
      gb.add(G.sph(0.045, 8, 6), T(0, -0.06, -0.14), P.COAT2);
      gb.add(G.sph(0.032, 8, 6), T(0, -0.2, -0.225, 0, 0, 0, 1, 1.4, 1), P.COAT2);
    }), mat));
    const legDefs: [number, number, number, boolean][] = [[0.085, 0.4, 0.2, true], [-0.085, 0.4, 0.2, true], [0.08, 0.42, -0.25, false], [-0.08, 0.42, -0.25, false]];
    for (const [x, y, z, front] of legDefs) {
      const hip = new THREE.Group();
      hip.position.set(x, y, z);
      body.add(hip);
      hip.add(partMesh(cachedPart(`legU|${kind}|${front ? 1 : 0}`, (gb) => {
        const s = span([0, 0, 0], [0, -0.19, 0.01]);
        gb.add(G.cyl(0.04, 0.062, s.len, 10), s.m, P.COAT);
        gb.add(G.sph(0.062, 10, 8), T(0, 0, 0), P.COAT);
      }), mat));
      const knee = new THREE.Group();
      knee.position.set(0, -0.19, 0.01);
      hip.add(knee);
      knee.add(partMesh(cachedPart(`legL|${kind}|${front ? 1 : 0}`, (gb) => {
        const lo = y - 0.19 - 0.02;
        const s = span([0, 0, 0], [0, -lo, -0.01]);
        gb.add(G.cyl(0.028, 0.036, s.len, 8), s.m, P.COAT);
        gb.add(G.sph(0.038, 8, 6), T(0, 0, 0), P.COAT);
        gb.add(G.sph(0.036, 8, 6), T(0, -lo, 0.016, 0, 0, 0, 1, 0.6, 1.4), P.COAT2);
      }), mat));
      legs.push({ hip, knee, front, side: Math.sign(x) });
    }
    saddle = new THREE.Vector3(0, 0.62, -0.05);
  }
  return { group, body, head, tail, legs, extra: [], saddle, height: isWolf ? 0.7 : 0.95 };
}

/** Animate a quadruped rig: gait phase advances with `moving` (0..1 blend). */
export function animateQuadruped(rig: QuadrupedRig, time: number, moving: number, gallop: boolean, seed = 0): void {
  const f = gallop ? 2.3 : 1.9;
  const p = time * Math.PI * 2 * f + seed;
  const idleP = time * 1.3 + seed;
  for (const L of rig.legs) {
    // trot: diagonal pairs in phase
    const ph = p + (L.front ? 0 : Math.PI) + (L.side > 0 ? 0 : Math.PI);
    const swing = Math.sin(ph) * 0.55 * moving;
    L.hip.rotation.x = swing;
    L.knee.rotation.x = (L.front ? 1 : -1) * Math.max(0, Math.cos(ph)) * 0.7 * moving;
  }
  rig.body.position.y = moving * 0.022 * Math.abs(Math.sin(p)) + (1 - moving) * 0.004 * Math.sin(idleP);
  rig.body.rotation.x = moving * 0.04 * Math.sin(p * 2);
  if (rig.head) {
    rig.head.rotation.x = moving * 0.12 * Math.sin(p * 2 + 0.6) + (1 - moving) * (0.06 * Math.sin(idleP * 0.6) - 0.05);
    rig.head.rotation.y = (1 - moving) * 0.25 * Math.sin(idleP * 0.31);
  }
  if (rig.tail) {
    rig.tail.rotation.y = 0.25 * Math.sin(idleP * 1.4) + moving * 0.2 * Math.sin(p);
    rig.tail.rotation.x = moving * -0.3;
  }
}

// ═════════════════════════════ monsters ═════════════════════════════
export interface MonsterRig {
  group: THREE.Group;
  body: THREE.Object3D;
  head?: THREE.Object3D;
  legs: THREE.Object3D[];      // spider legs / golem legs
  arms: THREE.Object3D[];      // golem arms
  floaters: THREE.Object3D[];  // elemental shards
  quad?: QuadrupedRig;         // wolf
  height: number;
  kind: MonsterKind;
}

export function createMonster(kind: MonsterKind, mat: THREE.Material): MonsterRig {
  const P = UP;
  if (kind === 'wolf') {
    const quad = createQuadruped('wolfbeast', mat, false);
    return { group: quad.group, body: quad.body, head: quad.head, legs: [], arms: [], floaters: [], quad, height: 0.72, kind };
  }
  const group = new THREE.Group();
  group.name = `monster_${kind}`;
  const body = new THREE.Group();
  group.add(body);
  if (kind === 'spider') {
    body.add(partMesh(cachedPart('spider|body', (gb) => {
      gb.add(G.sph(0.11, 14, 10), T(0, 0.3, 0.1, 0, 0, 0, 1, 0.78, 1.1), P.COAT);
      gb.add(G.sph(0.2, 16, 12), T(0, 0.37, -0.22, -12, 0, 0, 1, 0.86, 1.25), P.COAT);
      gb.add(G.sph(0.08, 10, 8), T(0, 0.52, -0.22, 0, 0, 0, 0.9, 0.3, 1.6), P.COAT2);
      gb.add(G.cone(0.05, 0.09, 3), T(0, 0.535, -0.18, 90, 0, 0, 1, 1, 0.3), P.ACCENT);
      gb.add(G.cone(0.05, 0.09, 3), T(0, 0.53, -0.28, -90, 0, 0, 1, 1, 0.3), P.ACCENT);
      for (let i = 0; i < 6; i++) {
        const x = ((i % 3) - 1) * 0.032, y = 0.36 + Math.floor(i / 3) * 0.022;
        gb.add(G.sph(i % 3 === 1 ? 0.016 : 0.011, 8, 6), T(x, y, 0.2), P.EYE);
      }
      for (const s of [1, -1]) gb.add(G.cone(0.014, 0.07, 6), T(s * 0.03, 0.24, 0.21, 160, 0, s * 10), P.BONE);
    }), mat));
    const legs: THREE.Object3D[] = [];
    const zs = [0.16, 0.09, 0.02, -0.05];
    for (const s of [1, -1]) {
      zs.forEach((z, i) => {
        const hip = new THREE.Group();
        hip.position.set(s * 0.07, 0.31, z);
        hip.rotation.y = -s * ((1.5 - i) * 0.42);
        hip.userData.baseY = hip.rotation.y;
        hip.userData.side = s;
        hip.userData.index = i;
        body.add(hip);
        hip.add(partMesh(cachedPart(`spider|leg|${s}`, (gb) => {
          const a = span([0, 0, 0], [s * 0.2, 0.16, 0]);
          gb.add(G.cyl(0.016, 0.022, a.len, 6), a.m, P.COAT);
          gb.add(G.sph(0.02, 6, 5), T(s * 0.2, 0.16, 0), P.COAT2);
          const b = span([s * 0.2, 0.16, 0], [s * 0.36, -0.31, 0]);
          gb.add(G.cyl(0.006, 0.017, b.len, 6), b.m, P.COAT2);
        }), mat));
        legs.push(hip);
      });
    }
    return { group, body, legs, arms: [], floaters: [], height: 0.56, kind };
  }
  // golem / elemental
  const elem = kind === 'elemental';
  const key = elem ? 'elem' : 'golem';
  body.add(partMesh(cachedPart(`${key}|body`, (gb) => {
    gb.addFlat(jitter(G.ico(0.28, 1), 0.02, 1), T(0, 0.84, 0, 0, 0, 0, 1.05, 0.88, 0.72), P.COAT);
    gb.addFlat(jitter(G.ico(0.17, 0), 0.02, 2), T(0, 0.9, 0.11, 0, 20, 0, 1.2, 0.9, 0.6), P.COAT2);
    gb.addFlat(G.oct(elem ? 0.1 : 0.07), T(0, 0.86, 0.19, 0, 0, 0, 1, 1.3, 0.8), P.GLOW);
    gb.addFlat(jitter(G.ico(0.15, 0), 0.02, 3), T(0.3, 1.0, 0, 0, 0, 0, 1, 0.9, 1), P.COAT2);
    gb.addFlat(jitter(G.ico(0.15, 0), 0.02, 4), T(-0.3, 1.0, 0, 0, 0, 0, 1, 0.9, 1), P.COAT2);
    gb.addFlat(G.ico(0.07, 0), T(0.3, 1.12, 0, 0, 0, 0, 1.3, 0.4, 1.2), P.CLOTH);
    gb.addFlat(G.ico(0.06, 0), T(-0.26, 1.1, 0.05, 0, 0, 0, 1.3, 0.4, 1.2), P.CLOTH);
    gb.addFlat(jitter(G.ico(0.2, 0), 0.02, 5), T(0, 0.58, 0, 0, 0, 0, 1, 0.6, 0.8), P.COAT);
    if (elem) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        gb.add(G.box(0.012, 0.18, 0.012), T(Math.sin(a) * 0.22, 0.84, Math.cos(a) * 0.15, 0, 0, Math.sin(a * 3) * 30), P.GLOW);
      }
    }
  }), mat));
  const head = new THREE.Group();
  head.position.set(0, 1.08, 0.06);
  body.add(head);
  head.add(partMesh(cachedPart(`${key}|head`, (gb) => {
    gb.addFlat(jitter(G.ico(0.11, 0), 0.015, 6), T(0, 0.04, 0, 0, 0, 0, 1.1, 0.9, 1), P.COAT);
    gb.add(G.box(0.05, 0.016, 0.02), T(0.04, 0.05, 0.095, 0, 0, -10), P.EYE);
    gb.add(G.box(0.05, 0.016, 0.02), T(-0.04, 0.05, 0.095, 0, 0, 10), P.EYE);
    if (elem) gb.addFlat(G.cone(0.05, 0.14, 5), T(0, 0.16, -0.02), P.GLOW);
  }), mat));
  const arms: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const sh = new THREE.Group();
    sh.position.set(s * 0.34, 1.0, 0);
    sh.userData.side = s;
    body.add(sh);
    sh.add(partMesh(cachedPart(`${key}|arm|${s}`, (gb) => {
      gb.addFlat(jitter(G.ico(0.1, 0), 0.015, 7), T(s * 0.04, -0.17, 0), P.COAT);
      gb.addFlat(jitter(G.ico(0.12, 0), 0.015, 8), T(s * 0.06, -0.38, 0.02, 0, 0, 0, 1, 1.2, 1), P.COAT2);
      gb.addFlat(jitter(G.ico(0.14, 0), 0.015, 9), T(s * 0.07, -0.6, 0.04), P.COAT);
      if (elem) gb.addFlat(G.oct(0.04), T(s * 0.07, -0.6, 0.16), P.GLOW);
    }), mat));
    arms.push(sh);
  }
  const legs: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.14, 0.55, 0);
    body.add(hip);
    hip.add(partMesh(cachedPart(`${key}|leg|${s}`, (gb) => {
      gb.addFlat(jitter(G.ico(0.13, 0), 0.015, 10 + s), T(0, -0.22, 0, 0, 0, 0, 1, 1.5, 1), P.COAT2);
      gb.addFlat(jitter(G.ico(0.12, 0), 0.015, 12 + s), T(0, -0.47, 0.04, 0, 0, 0, 1.1, 0.6, 1.35), P.COAT);
    }), mat));
    legs.push(hip);
  }
  const floaters: THREE.Object3D[] = [];
  if (elem) {
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.9 + (i % 2) * 0.25, 0);
      pivot.userData.speed = 0.8 + i * 0.25;
      pivot.userData.phase = i * 1.7;
      body.add(pivot);
      const m = partMesh(cachedPart(`elem|shard|${i}`, (gb) => {
        gb.addFlat(jitter(G.ico(0.05 + (i % 2) * 0.02, 0), 0.01, 20 + i), T(0.42, 0, 0), i % 2 ? P.COAT2 : P.COAT);
        gb.addFlat(G.oct(0.018), T(0.42, 0.06, 0), P.GLOW);
      }), mat);
      pivot.add(m);
      floaters.push(pivot);
    }
  }
  return { group, body, head, legs, arms, floaters, height: elem ? 1.3 : 1.25, kind };
}

/** Idle/walk transform animation for procedural monsters (attack/hit/death are handled by the unit layer). */
export function animateMonster(rig: MonsterRig, time: number, moving: number, seed = 0): void {
  if (rig.quad) { animateQuadruped(rig.quad, time, moving, true, seed); return; }
  const t = time + seed;
  if (rig.kind === 'spider') {
    const f = 3.2;
    for (const leg of rig.legs) {
      const i = leg.userData.index as number, s = leg.userData.side as number;
      const ph = t * Math.PI * 2 * f + i * 1.6 + (s > 0 ? 0 : Math.PI);
      leg.rotation.y = (leg.userData.baseY as number) + Math.sin(ph) * 0.28 * moving + Math.sin(t * 1.1 + i) * 0.03;
      leg.rotation.z = s * Math.max(0, Math.cos(ph)) * 0.3 * moving;
    }
    rig.body.position.y = 0.01 * Math.sin(t * 2.2) + moving * 0.012 * Math.abs(Math.sin(t * Math.PI * 2 * f));
    return;
  }
  // golem / elemental: heavy stomp
  const f = 1.4;
  const p = t * Math.PI * 2 * f;
  rig.legs.forEach((leg, i) => { leg.rotation.x = Math.sin(p + i * Math.PI) * 0.38 * moving; });
  rig.arms.forEach((arm, i) => {
    arm.rotation.x = -Math.sin(p + i * Math.PI) * 0.3 * moving + Math.sin(t * 1.2 + i) * 0.04;
    arm.rotation.z = (arm.userData.side as number) * (0.08 + 0.03 * Math.sin(t * 0.9));
  });
  rig.body.position.y = moving * 0.03 * Math.abs(Math.cos(p)) + 0.006 * Math.sin(t * 1.6);
  rig.body.rotation.z = moving * 0.04 * Math.sin(p);
  if (rig.head) rig.head.rotation.y = 0.3 * Math.sin(t * 0.4);
  for (const f2 of rig.floaters) {
    f2.rotation.y = t * (f2.userData.speed as number) + (f2.userData.phase as number);
    f2.position.y = 0.95 + 0.08 * Math.sin(t * 1.7 + (f2.userData.phase as number));
  }
}

// ═════════════════════════════ textures ═════════════════════════════
const texCache = new Map<string, THREE.Texture>();
function cachedTex(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, srgb = false): THREE.Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  texCache.set(key, t);
  return t;
}
/** Soft round glow (white, alpha falloff). */
export function softDotTexture(): THREE.Texture {
  return cachedTex('softdot', 64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.7)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}
/** Hot spark: tight core with a halo. */
export function sparkTexture(): THREE.Texture {
  return cachedTex('spark', 64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.12, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.25)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}
/** Wispy smoke puff. */
export function smokeTexture(): THREE.Texture {
  return cachedTex('smoke', 128, (g, s) => {
    const rnd = (() => { let x = 7; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; })();
    for (let i = 0; i < 22; i++) {
      const x = s / 2 + (rnd() - 0.5) * s * 0.42, y = s / 2 + (rnd() - 0.5) * s * 0.42, r = s * (0.14 + rnd() * 0.2);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.22)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    }
  });
}
/** Thin glowing ring (for shockwaves / decals). */
export function ringTexture(): THREE.Texture {
  return cachedTex('ring', 128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.62, 'rgba(255,255,255,0)');
    gr.addColorStop(0.8, 'rgba(255,255,255,1)');
    gr.addColorStop(0.9, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}
/** Four-point star flare. */
export function flareTexture(): THREE.Texture {
  return cachedTex('flare', 128, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.15, 'rgba(255,255,255,0.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'lighter';
    for (const [w, h] of [[s, s * 0.05], [s * 0.05, s]] as const) {
      const lg = g.createLinearGradient(c - w / 2, c - h / 2, c + w / 2, c + h / 2);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = lg;
      g.beginPath();
      g.ellipse(c, c, w / 2, h / 2, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
}
/** Soft ground ring used under units (faction tinted additive decal). */
export function unitRingTexture(): THREE.Texture {
  return cachedTex('unitring', 128, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(255,255,255,0.10)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.14)');
    gr.addColorStop(0.74, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.8, 'rgba(255,255,255,0.75)');
    gr.addColorStop(0.9, 'rgba(255,255,255,0.18)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}
/** Dark round contact shadow (multiplicative feel via normal blending). */
export function blobShadowTexture(): THREE.Texture {
  return cachedTex('blob', 64, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)');
    gr.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}
