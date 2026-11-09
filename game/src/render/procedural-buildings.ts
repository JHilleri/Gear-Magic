// Procedural fallback buildings (world units, footprint radius ≤ 0.82, ground centre, +Z front).
// One merged palette geometry per type/level + optional animated parts (windmill sails,
// floating crystals) and anchors for the banner, chimney smoke and glow sprites.
import * as THREE from 'three';
import type { BuildingId, FactionId } from '../core/types';
import { FACTIONS } from '../data/factions';
import { G, GeoBuilder, T, jitter, span, type PalEntry } from './procedural';

/** Building palette slots. */
export const BP = {
  STONE: 0, PRIMARY: 1, ACCENT: 2, WOOD: 3, WOODDARK: 4, ROOF: 5, PLASTER: 6, THATCH: 7,
  METAL: 8, GOLD: 9, WINDOW: 10, CRYSTAL: 11, DARK: 12, GROUND: 13, CROP: 14, GREEN: 15,
} as const;

interface Style { stone: string; roof: string; plaster: string; wood: string; woodDark: string; thatch: string; window: string; windowE: number; crystal: string }
const STYLES: Record<string, Style> = {
  human: { stone: '#a9a49b', roof: '#3f5f93', plaster: '#e7dcc4', wood: '#7d5838', woodDark: '#4a3322', thatch: '#c9a85a', window: '#ffcf7a', windowE: 1.7, crystal: '#7cc8ff' },
  orc: { stone: '#8c7f6c', roof: '#7c3a24', plaster: '#b49a74', wood: '#6b4a2c', woodDark: '#3d2a19', thatch: '#a8874a', window: '#ff9a4a', windowE: 1.8, crystal: '#ff8a3c' },
  undead: { stone: '#5f5c66', roof: '#3d2f52', plaster: '#7f7888', wood: '#4c423d', woodDark: '#2a2422', thatch: '#6e6458', window: '#b48cff', windowE: 2.2, crystal: '#8dffc4' },
  none: { stone: '#8f8b84', roof: '#5b4b3d', plaster: '#a9a08f', wood: '#6a5440', woodDark: '#3e3126', thatch: '#8f7d58', window: '#6b5a40', windowE: 0.15, crystal: '#7a8a96' },
};

export function buildingPalette(owner: FactionId | null): PalEntry[] {
  const f = owner ? FACTIONS[owner] : null;
  const race = f && f.race !== 'monster' ? f.race : 'none';
  const s = STYLES[race] ?? STYLES.none;
  const primary = f && owner !== 'neutral' ? f.color : '#77716a';
  const accent = f && owner !== 'neutral' ? f.accent : '#a39a8c';
  return [
    { c: s.stone, r: 0.92 },          // STONE
    { c: primary, r: 0.75 },          // PRIMARY
    { c: accent, r: 0.5, m: accent === '#e8c35a' ? 0.6 : 0 }, // ACCENT
    { c: s.wood, r: 0.82 },           // WOOD
    { c: s.woodDark, r: 0.85 },       // WOODDARK
    { c: s.roof, r: 0.7 },            // ROOF
    { c: s.plaster, r: 0.9 },         // PLASTER
    { c: s.thatch, r: 0.95 },         // THATCH
    { c: '#8d939b', r: 0.38, m: 0.85 }, // METAL
    { c: '#d9a93e', r: 0.3, m: 1 },   // GOLD
    { c: s.window, r: 0.4, e: s.windowE }, // WINDOW
    { c: s.crystal, r: 0.15, e: 1.5 }, // CRYSTAL
    { c: '#15110e', r: 0.95 },        // DARK
    { c: '#6f5b41', r: 0.98 },        // GROUND
    { c: '#d8b34a', r: 0.9 },         // CROP
    { c: '#4f7a32', r: 0.9 },         // GREEN
  ];
}

export interface BuildingPart { geometry: THREE.BufferGeometry; pos: THREE.Vector3; anim: 'windmill' | 'float' | 'spin' }
export interface BuildingModel {
  geometry: THREE.BufferGeometry;
  height: number;
  radius: number;
  banner: THREE.Vector3;                 // pole base
  bannerHeight: number;
  parts: BuildingPart[];
  smoke: THREE.Vector3[];
  glows: { pos: THREE.Vector3; size: number; slot: 'window' | 'crystal' }[];
}

const P = BP;
const D2R = Math.PI / 180;
const cache = new Map<string, BuildingModel>();

// ───────────── helpers ─────────────
function hexSlab(gb: GeoBuilder, r: number, top: number, depth: number, pal: number): void {
  gb.add(G.cyl(r, r * 1.03, depth, 6), T(0, top - depth / 2, 0), pal);
}
function gable(gb: GeoBuilder, x: number, y: number, z: number, w: number, d: number, h: number, pal: number, ry = 0): void {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  gb.add(G.extrude(s, d), T(x, y, z, 0, ry, 0), pal);
}
function boxAt(gb: GeoBuilder, x: number, y: number, z: number, w: number, h: number, d: number, pal: number, ry = 0, rx = 0, rz = 0): void {
  gb.add(G.box(w, h, d), T(x, y + h / 2, z, rx, ry, rz), pal);
}
function windowPane(gb: GeoBuilder, x: number, y: number, z: number, w: number, h: number, ry = 0, frame = P.WOODDARK): void {
  const rot = T(x, y, z, 0, ry, 0);
  gb.add(G.box(w + 0.016, h + 0.016, 0.012), rot, frame);
  gb.add(G.box(w, h, 0.016), rot.clone().multiply(T(0, 0, 0.002)), P.WINDOW);
}
function crenels(gb: GeoBuilder, a: [number, number], b: [number, number], y: number, n: number, size: number, pal: number): void {
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    const ang = Math.atan2(b[0] - a[0], b[1] - a[1]) / D2R;
    gb.add(G.box(size, size * 0.9, size * 0.9), T(x, y + size * 0.45, z, 0, ang, 0), pal);
  }
}
function wallSeg(gb: GeoBuilder, a: [number, number], b: [number, number], h: number, thick: number, pal: number, merlons: number): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ang = Math.atan2(b[0] - a[0], b[1] - a[1]) / D2R;
  gb.add(G.box(thick, h, len), T((a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2, 0, ang, 0), pal);
  if (merlons > 0) crenels(gb, a, b, h, merlons, thick * 0.9, pal);
}
function tower(gb: GeoBuilder, x: number, z: number, r: number, h: number, roof: 'cone' | 'flat', roofH = r * 2): void {
  gb.add(G.cyl(r, r * 1.08, h, 12), T(x, h / 2, z), P.STONE);
  gb.add(G.cyl(r * 1.18, r * 1.18, 0.05, 12), T(x, h + 0.02, z), P.STONE);
  if (roof === 'cone') {
    gb.add(G.cone(r * 1.3, roofH, 12), T(x, h + 0.045 + roofH / 2, z), P.ROOF);
    gb.add(G.sph(0.016, 6, 5), T(x, h + 0.05 + roofH, z), P.GOLD);
  } else {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      gb.add(G.box(r * 0.42, r * 0.42, r * 0.3), T(x + Math.sin(a) * r * 1.05, h + 0.07, z + Math.cos(a) * r * 1.05, 0, a / D2R, 0), P.STONE);
    }
  }
  windowPane(gb, x, h * 0.62, z + r * 1.01, 0.03, 0.05, 0);
}
function hexCorner(r: number, k: number, offDeg = 30): [number, number] {
  const a = (offDeg + k * 60) * D2R;
  return [Math.sin(a) * r, Math.cos(a) * r];
}
function barrel(gb: GeoBuilder, x: number, z: number, s = 1): void {
  gb.add(G.cyl(0.035 * s, 0.035 * s, 0.08 * s, 10), T(x, 0.04 * s, z), P.WOOD);
  gb.add(G.tor(0.036 * s, 0.004, 4, 12), T(x, 0.02 * s, z, 90, 0, 0), P.METAL);
  gb.add(G.tor(0.036 * s, 0.004, 4, 12), T(x, 0.06 * s, z, 90, 0, 0), P.METAL);
}
function pine(gb: GeoBuilder, x: number, z: number, s: number): void {
  gb.add(G.cyl(0.018 * s, 0.024 * s, 0.12 * s, 6), T(x, 0.06 * s, z), P.WOODDARK);
  for (let i = 0; i < 3; i++) gb.add(G.cone((0.13 - i * 0.03) * s, (0.2 - i * 0.03) * s, 7), T(x, (0.16 + i * 0.1) * s, z), P.GREEN);
}
function fence(gb: GeoBuilder, a: [number, number], b: [number, number], posts: number): void {
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    gb.add(G.box(0.018, 0.11, 0.018), T(a[0] + (b[0] - a[0]) * t, 0.055, a[1] + (b[1] - a[1]) * t), P.WOOD);
  }
  const s = span([a[0], 0.075, a[1]], [b[0], 0.075, b[1]]);
  gb.add(G.cyl(0.006, 0.006, s.len, 4), s.m, P.WOOD);
  const s2 = span([a[0], 0.04, a[1]], [b[0], 0.04, b[1]]);
  gb.add(G.cyl(0.006, 0.006, s2.len, 4), s2.m, P.WOOD);
}
function rock(gb: GeoBuilder, x: number, y: number, z: number, r: number, sx = 1, sy = 1, sz = 1, seed = 1, pal: number = P.STONE): void {
  gb.addFlat(jitter(G.ico(r, 0), r * 0.18, seed), T(x, y, z, seed * 17, seed * 31, 0, sx, sy, sz), pal);
}
function crystal(gb: GeoBuilder, x: number, y: number, z: number, h: number, rx: number, rz: number): void {
  gb.addFlat(G.oct(h * 0.3), T(x, y, z, rx, 0, rz, 0.55, 1.6, 0.55), P.CRYSTAL);
}

// ───────────── per-type builders ─────────────
type Builder = (gb: GeoBuilder, lvl: number, out: Omit<BuildingModel, 'geometry'>) => void;

const BUILDERS: Record<BuildingId, Builder> = {
  castle(gb, lvl, out) {
    hexSlab(gb, 0.8, 0.08, 0.3, P.STONE);
    const R = 0.6;
    const wallH = 0.3 + 0.04 * (lvl - 1);
    const corners = [0, 1, 2, 3, 4, 5].map((k) => hexCorner(R, k, 30));
    for (let k = 0; k < 6; k++) {
      const a = corners[k], b = corners[(k + 1) % 6];
      if (k === 5) {
        // front wall (faces +Z): gatehouse in the middle
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const ga: [number, number] = [mid[0] - 0.1 * Math.sign(b[0] - a[0] || 1), mid[1]];
        const gb2: [number, number] = [mid[0] + 0.1 * Math.sign(b[0] - a[0] || 1), mid[1]];
        wallSeg(gb, a, ga, wallH, 0.08, P.STONE, 2);
        wallSeg(gb, gb2, b, wallH, 0.08, P.STONE, 2);
        boxAt(gb, mid[0], 0.06, mid[1], 0.26, wallH + 0.14, 0.14, P.STONE);
        boxAt(gb, mid[0], 0.06, mid[1] + 0.072, 0.11, 0.17, 0.01, P.DARK);
        for (let i = 0; i < 4; i++) boxAt(gb, mid[0] - 0.04 + i * 0.027, 0.06, mid[1] + 0.078, 0.006, 0.16, 0.006, P.METAL);
        crenels(gb, [mid[0] - 0.13, mid[1]], [mid[0] + 0.13, mid[1]], wallH + 0.2, 4, 0.05, P.STONE);
        boxAt(gb, mid[0], wallH - 0.02, mid[1] + 0.075, 0.1, 0.1, 0.01, P.PRIMARY);
        boxAt(gb, mid[0], wallH + 0.02, mid[1] + 0.081, 0.04, 0.04, 0.01, P.ACCENT);
      } else wallSeg(gb, a, b, wallH, 0.08, P.STONE, 4);
    }
    corners.forEach(([x, z], k) => tower(gb, x, z, 0.1, wallH + 0.16, k % 2 === 0 ? 'cone' : 'flat', 0.22));
    // keep
    const kh = 0.56 + 0.12 * (lvl - 1);
    boxAt(gb, 0, 0.06, -0.06, 0.4, kh, 0.32, P.STONE);
    boxAt(gb, 0, 0.06 + kh * 0.45, 0.101, 0.3, 0.02, 0.01, P.WOODDARK);
    gable(gb, 0, 0.06 + kh, -0.06, 0.44, 0.36, 0.2, P.ROOF);
    for (const x of [-0.11, 0, 0.11]) windowPane(gb, x, 0.06 + kh * 0.7, 0.103, 0.035, 0.06);
    for (const x of [-0.08, 0.08]) windowPane(gb, x, 0.06 + kh * 0.35, 0.103, 0.03, 0.05);
    // keep tower
    const tx = 0.17, tz = -0.18, th = kh + 0.34;
    gb.add(G.cyl(0.085, 0.09, th, 12), T(tx, 0.06 + th / 2, tz), P.STONE);
    gb.add(G.cyl(0.1, 0.1, 0.05, 12), T(tx, 0.06 + th, tz), P.STONE);
    gb.add(G.cone(0.115, 0.3, 12), T(tx, 0.06 + th + 0.17, tz), P.ROOF);
    windowPane(gb, tx, 0.06 + th * 0.8, tz + 0.088, 0.03, 0.05);
    out.banner.set(tx, 0.06 + th + 0.31, tz);
    out.bannerHeight = 0.3;
    out.height = 0.06 + th + 0.32;
    out.smoke.push(new THREE.Vector3(-0.12, 0.06 + kh + 0.12, -0.15));
    boxAt(gb, -0.12, 0.06 + kh - 0.02, -0.15, 0.05, 0.14, 0.05, P.STONE);
  },
  house(gb, lvl, out) {
    hexSlab(gb, 0.72, 0.03, 0.2, P.GROUND);
    const h = 0.24 + 0.09 * (lvl - 1);
    boxAt(gb, 0.02, 0.03, -0.06, 0.46, h, 0.32, P.PLASTER);
    // timber framing
    for (const x of [-0.21, -0.07, 0.11, 0.25]) boxAt(gb, x, 0.03, 0.102, 0.02, h, 0.01, P.WOODDARK);
    boxAt(gb, 0.02, 0.03 + h * 0.52, 0.102, 0.46, 0.018, 0.01, P.WOODDARK);
    if (lvl >= 2) boxAt(gb, 0.02, 0.03 + h * 0.52, -0.06, 0.48, 0.03, 0.34, P.WOODDARK);
    gable(gb, 0.02, 0.03 + h, -0.06, 0.54, 0.42, 0.22, P.ROOF, 0);
    boxAt(gb, 0.02, 0.03 + h + 0.2, -0.06, 0.03, 0.02, 0.43, P.WOODDARK);
    boxAt(gb, 0.15, 0.03 + h, -0.14, 0.07, 0.24, 0.07, P.STONE);
    out.smoke.push(new THREE.Vector3(0.15, 0.03 + h + 0.26, -0.14));
    boxAt(gb, -0.02, 0.03, 0.105, 0.08, 0.14, 0.012, P.WOODDARK);
    windowPane(gb, -0.15, 0.03 + h * 0.3, 0.104, 0.05, 0.05);
    windowPane(gb, 0.18, 0.03 + h * 0.3, 0.104, 0.05, 0.05);
    if (lvl >= 2) { windowPane(gb, -0.1, 0.03 + h * 0.76, 0.104, 0.05, 0.05); windowPane(gb, 0.14, 0.03 + h * 0.76, 0.104, 0.05, 0.05); }
    // annex shed
    boxAt(gb, -0.36, 0.03, -0.24, 0.2, 0.16, 0.2, P.WOOD);
    boxAt(gb, -0.36, 0.19, -0.24, 0.25, 0.025, 0.26, P.THATCH, 0, 12, 0);
    barrel(gb, -0.3, 0.06); barrel(gb, -0.38, 0.1, 0.9);
    boxAt(gb, 0.36, 0.03, 0.18, 0.12, 0.06, 0.08, P.WOOD);
    fence(gb, [0.45, 0.3], [0.05, 0.52], 4);
    fence(gb, [-0.05, 0.52], [-0.45, 0.3], 4);
    gb.add(G.sph(0.07, 8, 6), T(0.4, 0.06, -0.3, 0, 0, 0, 1, 0.7, 1), P.GREEN);
    gb.add(G.sph(0.06, 8, 6), T(-0.5, 0.06, 0.05, 0, 0, 0, 1, 0.7, 1), P.GREEN);
    out.banner.set(-0.21, 0.03 + h + 0.05, -0.06);
    out.bannerHeight = 0.32;
    out.height = 0.03 + h + 0.24;
  },
  farm(gb, _lvl, out) {
    hexSlab(gb, 0.8, 0.02, 0.18, P.GROUND);
    // crop strips in the front half
    for (let i = 0; i < 5; i++) {
      const z = 0.08 + i * 0.12;
      const half = Math.sqrt(Math.max(0.02, 0.62 - (z + 0.05) * (z + 0.05))) * 0.95;
      boxAt(gb, 0, 0.02, z, half * 2, 0.025, 0.08, i % 2 ? P.GREEN : P.CROP);
      for (let k = 0; k < 6; k++) gb.add(G.cone(0.02, 0.06, 4), T(-half + 0.05 + (k / 5) * (half * 2 - 0.1), 0.075, z), i % 2 ? P.GREEN : P.CROP);
    }
    // barn
    boxAt(gb, 0.24, 0.02, -0.3, 0.32, 0.2, 0.26, P.ROOF);
    gable(gb, 0.24, 0.22, -0.3, 0.36, 0.3, 0.16, P.THATCH, 90);
    boxAt(gb, 0.24, 0.02, -0.168, 0.1, 0.14, 0.01, P.WOODDARK);
    boxAt(gb, 0.24, 0.02, -0.165, 0.012, 0.14, 0.012, P.PLASTER, 0, 0, 35);
    // haystack
    gb.add(G.cyl(0.085, 0.09, 0.07, 10), T(-0.34, 0.055, -0.22), P.THATCH);
    gb.add(G.cone(0.09, 0.12, 10), T(-0.34, 0.15, -0.22), P.THATCH);
    // windmill tower
    gb.add(G.cyl(0.06, 0.1, 0.5, 8), T(-0.12, 0.27, -0.42), P.PLASTER);
    gb.add(G.cone(0.085, 0.1, 8), T(-0.12, 0.57, -0.42), P.ROOF);
    boxAt(gb, -0.12, 0.02, -0.33, 0.05, 0.09, 0.012, P.WOODDARK);
    const sails = new GeoBuilder(false);
    for (let i = 0; i < 4; i++) {
      const a = i * 90;
      sails.add(G.box(0.012, 0.26, 0.008), T(0, 0, 0, 0, 0, a).multiply(T(0, 0.13, 0)), P.WOOD);
      sails.add(G.box(0.055, 0.2, 0.004), T(0, 0, 0, 0, 0, a).multiply(T(0.03, 0.15, 0.004)), P.PLASTER);
    }
    sails.add(G.cyl(0.018, 0.018, 0.04, 8), T(0, 0, 0, 90, 0, 0), P.WOODDARK);
    out.parts.push({ geometry: sails.build(), pos: new THREE.Vector3(-0.12, 0.47, -0.355), anim: 'windmill' });
    fence(gb, [-0.62, 0.0], [-0.3, 0.62], 4);
    fence(gb, [0.62, 0.0], [0.3, 0.62], 4);
    out.banner.set(0.38, 0.32, -0.3);
    out.bannerHeight = 0.26;
    out.height = 0.62;
  },
  lumber(gb, _lvl, out) {
    hexSlab(gb, 0.72, 0.02, 0.18, P.GROUND);
    // log cabin
    for (let i = 0; i < 5; i++) {
      gb.add(G.cyl(0.026, 0.026, 0.4, 8), T(-0.05, 0.045 + i * 0.045, -0.2, 0, 0, 90), P.WOOD);
      gb.add(G.cyl(0.026, 0.026, 0.3, 8), T(-0.24, 0.045 + i * 0.045, -0.2, 90, 0, 0), P.WOOD);
      gb.add(G.cyl(0.026, 0.026, 0.3, 8), T(0.14, 0.045 + i * 0.045, -0.2, 90, 0, 0), P.WOOD);
    }
    boxAt(gb, -0.05, 0.02, -0.2, 0.36, 0.22, 0.26, P.WOODDARK);
    gable(gb, -0.05, 0.25, -0.2, 0.48, 0.38, 0.17, P.THATCH);
    boxAt(gb, -0.05, 0.02, -0.068, 0.08, 0.13, 0.01, P.DARK);
    windowPane(gb, 0.07, 0.15, -0.066, 0.04, 0.04);
    // log piles
    for (let row = 0; row < 3; row++) for (let i = 0; i < 4 - row; i++) {
      gb.add(G.cyl(0.03, 0.03, 0.28, 8), T(0.24 + (i - (3 - row) / 2) * 0.062, 0.05 + row * 0.052, 0.18, 90, 0, 0), P.WOOD);
      gb.add(G.cyl(0.024, 0.024, 0.285, 8), T(0.24 + (i - (3 - row) / 2) * 0.062, 0.05 + row * 0.052, 0.18, 90, 0, 0), P.THATCH);
    }
    // saw horse + stump with axe
    gb.add(G.cyl(0.05, 0.055, 0.07, 9), T(-0.22, 0.055, 0.2), P.WOOD);
    gb.add(G.cyl(0.045, 0.045, 0.072, 9), T(-0.22, 0.056, 0.2), P.THATCH);
    boxAt(gb, -0.22, 0.09, 0.2, 0.012, 0.12, 0.012, P.WOODDARK, 0, 0, 20);
    boxAt(gb, -0.24, 0.17, 0.2, 0.03, 0.04, 0.008, P.METAL, 0, 0, 20);
    gb.add(G.cyl(0.026, 0.026, 0.34, 8), T(-0.04, 0.12, 0.3, 0, 0, 90), P.WOOD);
    for (const x of [-0.16, 0.08]) for (const s of [-1, 1]) boxAt(gb, x, 0.02, 0.3, 0.014, 0.12, 0.014, P.WOODDARK, 0, s * 18, 0);
    pine(gb, 0.46, -0.32, 1.2); pine(gb, -0.48, -0.2, 1.0); pine(gb, 0.5, 0.2, 0.8);
    out.banner.set(0.12, 0.27, -0.2);
    out.bannerHeight = 0.28;
    out.height = 0.6;
  },
  quarry(gb, _lvl, out) {
    hexSlab(gb, 0.74, 0.02, 0.2, P.GROUND);
    rock(gb, -0.15, 0.18, -0.32, 0.3, 1.3, 0.85, 0.9, 1);
    rock(gb, 0.28, 0.14, -0.3, 0.22, 1, 0.9, 1, 2);
    rock(gb, -0.45, 0.1, -0.05, 0.17, 1, 0.8, 1, 3);
    // cut terraces
    boxAt(gb, -0.05, 0.02, -0.08, 0.42, 0.14, 0.12, P.STONE);
    boxAt(gb, -0.05, 0.02, -0.16, 0.4, 0.24, 0.1, P.STONE);
    boxAt(gb, -0.05, 0.02, -0.23, 0.38, 0.34, 0.08, P.STONE);
    // stone blocks
    for (let i = 0; i < 4; i++) gb.add(G.rbox(0.09, 0.07, 0.07, 0.01), T(0.22 + (i % 2) * 0.1, 0.055 + Math.floor(i / 2) * 0.072, 0.18), P.STONE);
    gb.add(G.rbox(0.09, 0.07, 0.07, 0.01), T(0.06, 0.055, 0.3, 0, 25, 0), P.STONE);
    // crane
    const legs: [number, number][] = [[-0.33, 0.2], [-0.21, 0.2]];
    for (const [x, z] of legs) { const s = span([x, 0.02, z], [-0.27, 0.48, 0.13]); gb.add(G.cyl(0.012, 0.014, s.len, 6), s.m, P.WOOD); }
    const sb = span([-0.27, 0.02, 0.0], [-0.27, 0.48, 0.13]); gb.add(G.cyl(0.012, 0.014, sb.len, 6), sb.m, P.WOOD);
    const boom = span([-0.27, 0.46, 0.13], [0.05, 0.4, 0.13]); gb.add(G.cyl(0.01, 0.012, boom.len, 6), boom.m, P.WOOD);
    gb.add(G.cyl(0.003, 0.003, 0.2, 4), T(0.04, 0.3, 0.13), P.DARK);
    gb.add(G.rbox(0.07, 0.06, 0.06, 0.008), T(0.04, 0.18, 0.13), P.STONE);
    // cart
    boxAt(gb, 0.3, 0.06, 0.38, 0.16, 0.06, 0.1, P.WOOD);
    for (const s of [-1, 1]) gb.add(G.cyl(0.04, 0.04, 0.012, 10), T(0.3 + s * 0.05, 0.05, 0.43, 90, 0, 0), P.WOODDARK);
    rock(gb, 0.3, 0.13, 0.38, 0.04, 1, 1, 1, 5);
    out.banner.set(0.28, 0.33, -0.3);
    out.bannerHeight = 0.26;
    out.height = 0.6;
  },
  forge(gb, _lvl, out) {
    hexSlab(gb, 0.72, 0.03, 0.2, P.STONE);
    boxAt(gb, -0.02, 0.03, -0.1, 0.42, 0.28, 0.3, P.STONE);
    boxAt(gb, -0.02, 0.31, -0.1, 0.5, 0.03, 0.4, P.ROOF, 0, -14, 0);
    // chimney
    gb.add(G.box(0.12, 0.5, 0.12), T(-0.17, 0.3, -0.2, 0, 0, 0, 1, 1, 1), P.STONE);
    gb.add(G.box(0.14, 0.04, 0.14), T(-0.17, 0.56, -0.2), P.STONE);
    out.smoke.push(new THREE.Vector3(-0.17, 0.6, -0.2));
    // glowing furnace mouth
    boxAt(gb, 0.06, 0.05, 0.052, 0.14, 0.12, 0.01, P.DARK);
    boxAt(gb, 0.06, 0.06, 0.056, 0.11, 0.08, 0.01, P.WINDOW);
    out.glows.push({ pos: new THREE.Vector3(0.06, 0.1, 0.09), size: 0.28, slot: 'window' });
    // anvil on stump
    gb.add(G.cyl(0.045, 0.05, 0.08, 9), T(0.2, 0.07, 0.25), P.WOOD);
    boxAt(gb, 0.2, 0.11, 0.25, 0.1, 0.035, 0.05, P.METAL);
    boxAt(gb, 0.2, 0.145, 0.25, 0.14, 0.03, 0.06, P.METAL);
    gb.add(G.cone(0.02, 0.06, 6), T(0.29, 0.16, 0.25, 0, 0, -90), P.METAL);
    barrel(gb, -0.25, 0.22, 1.1);
    gb.add(G.cyl(0.034, 0.034, 0.005, 10), T(-0.25, 0.09, 0.22), P.CRYSTAL);
    // weapon rack
    boxAt(gb, 0.33, 0.03, -0.08, 0.02, 0.18, 0.2, P.WOOD);
    for (let i = 0; i < 3; i++) boxAt(gb, 0.345, 0.05, -0.15 + i * 0.07, 0.008, 0.2, 0.02, P.METAL, 0, 0, 8);
    for (let i = 0; i < 5; i++) rock(gb, -0.32 + (i % 3) * 0.05, 0.05, 0.05 + Math.floor(i / 3) * 0.05, 0.035, 1, 0.6, 1, 10 + i, P.DARK);
    out.banner.set(0.16, 0.3, -0.24);
    out.bannerHeight = 0.28;
    out.height = 0.64;
  },
  training(gb, _lvl, out) {
    hexSlab(gb, 0.8, 0.02, 0.18, P.GROUND);
    const corners = [0, 1, 2, 3, 4, 5].map((k) => hexCorner(0.72, k, 0));
    for (let k = 0; k < 6; k++) if (k !== 0) fence(gb, corners[k], corners[(k + 1) % 6], 3);
    // dummies
    for (const [x, z, r] of [[-0.18, 0.12, 15], [0.12, 0.26, -20]] as [number, number, number][]) {
      gb.add(G.cyl(0.012, 0.014, 0.32, 6), T(x, 0.16, z), P.WOOD);
      gb.add(G.cyl(0.05, 0.045, 0.14, 10), T(x, 0.22, z), P.THATCH);
      gb.add(G.cyl(0.01, 0.01, 0.2, 6), T(x, 0.26, z, 0, r, 90), P.WOOD);
      gb.add(G.sph(0.038, 8, 6), T(x, 0.33, z), P.THATCH);
      gb.add(G.cyl(0.052, 0.052, 0.02, 10), T(x, 0.2, z), P.PRIMARY);
    }
    // archery target
    gb.add(G.cyl(0.11, 0.11, 0.035, 18), T(0.36, 0.2, -0.12, 70, 30, 0), P.THATCH);
    gb.add(G.cyl(0.08, 0.08, 0.037, 18), T(0.36, 0.2, -0.12, 70, 30, 0), P.PRIMARY);
    gb.add(G.cyl(0.05, 0.05, 0.039, 18), T(0.36, 0.2, -0.12, 70, 30, 0), P.PLASTER);
    gb.add(G.cyl(0.022, 0.022, 0.041, 12), T(0.36, 0.2, -0.12, 70, 30, 0), P.PRIMARY);
    for (const s of [-1, 1]) { const st = span([0.36 + s * 0.06, 0.02, -0.17], [0.36 + s * 0.03, 0.22, -0.13]); gb.add(G.cyl(0.008, 0.01, st.len, 5), st.m, P.WOOD); }
    // spear rack
    boxAt(gb, -0.38, 0.02, -0.05, 0.02, 0.14, 0.24, P.WOOD);
    for (let i = 0; i < 4; i++) {
      gb.add(G.cyl(0.006, 0.006, 0.34, 5), T(-0.37, 0.18, -0.14 + i * 0.06, 0, 0, -12), P.WOOD);
      gb.add(G.cone(0.012, 0.04, 4), T(-0.336, 0.36, -0.14 + i * 0.06, 0, 0, -12), P.METAL);
    }
    // command tent
    gb.add(G.cone(0.22, 0.34, 8), T(-0.05, 0.19, -0.36), P.PRIMARY);
    for (let i = 0; i < 8; i += 2) gb.add(G.box(0.012, 0.35, 0.004), T(Math.sin((i * 45 + 22.5) * D2R) * 0.1, 0.19, -0.36 + Math.cos((i * 45 + 22.5) * D2R) * 0.1, 0, i * 45 + 22.5, 0).multiply(T(0, 0, 0, Math.atan2(0.22, 0.34) / D2R, 0, 0)), P.ACCENT);
    gb.add(G.cyl(0.006, 0.006, 0.1, 5), T(-0.05, 0.4, -0.36), P.WOODDARK);
    boxAt(gb, -0.05, 0.02, -0.15, 0.06, 0.1, 0.01, P.DARK);
    out.banner.set(-0.05, 0.42, -0.36);
    out.bannerHeight = 0.24;
    out.height = 0.6;
  },
  mine(gb, _lvl, out) {
    hexSlab(gb, 0.74, 0.02, 0.2, P.GROUND);
    rock(gb, 0, 0.12, -0.25, 0.42, 1.25, 0.65, 0.9, 7);
    rock(gb, 0.38, 0.08, -0.12, 0.2, 1, 0.8, 1, 8);
    rock(gb, -0.38, 0.07, -0.1, 0.18, 1, 0.8, 1, 9);
    // entrance
    boxAt(gb, 0, 0.02, 0.04, 0.17, 0.2, 0.08, P.DARK);
    for (const s of [-1, 1]) boxAt(gb, s * 0.095, 0.02, 0.08, 0.03, 0.22, 0.03, P.WOOD);
    boxAt(gb, 0, 0.23, 0.08, 0.24, 0.035, 0.04, P.WOOD);
    boxAt(gb, 0.12, 0.17, 0.11, 0.025, 0.035, 0.025, P.WINDOW);
    out.glows.push({ pos: new THREE.Vector3(0.12, 0.19, 0.12), size: 0.14, slot: 'window' });
    // rails
    for (const s of [-1, 1]) boxAt(gb, s * 0.04, 0.02, 0.3, 0.01, 0.012, 0.48, P.METAL);
    for (let i = 0; i < 6; i++) boxAt(gb, 0, 0.015, 0.1 + i * 0.08, 0.13, 0.01, 0.025, P.WOODDARK);
    // cart with ore
    boxAt(gb, 0, 0.05, 0.36, 0.14, 0.07, 0.1, P.METAL);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) gb.add(G.cyl(0.022, 0.022, 0.01, 8), T(sx * 0.07, 0.045, 0.36 + sz * 0.03, 0, 0, 90), P.DARK);
    for (let i = 0; i < 4; i++) rock(gb, -0.03 + (i % 2) * 0.05, 0.13, 0.34 + Math.floor(i / 2) * 0.04, 0.03, 1, 1, 1, 20 + i, P.ROOF);
    for (let i = 0; i < 5; i++) rock(gb, 0.28 + (i % 3) * 0.06, 0.04, 0.22 + Math.floor(i / 3) * 0.06, 0.04, 1, 0.7, 1, 30 + i, P.ROOF);
    out.banner.set(-0.22, 0.32, -0.28);
    out.bannerHeight = 0.26;
    out.height = 0.6;
  },
  crystalmine(gb, _lvl, out) {
    hexSlab(gb, 0.74, 0.02, 0.2, P.GROUND);
    rock(gb, 0, 0.12, -0.25, 0.4, 1.25, 0.65, 0.9, 11);
    rock(gb, -0.36, 0.08, -0.12, 0.18, 1, 0.8, 1, 12);
    boxAt(gb, 0, 0.02, 0.04, 0.17, 0.2, 0.08, P.DARK);
    for (const s of [-1, 1]) boxAt(gb, s * 0.095, 0.02, 0.08, 0.03, 0.22, 0.03, P.WOOD);
    boxAt(gb, 0, 0.23, 0.08, 0.24, 0.035, 0.04, P.WOOD);
    const spots: [number, number, number, number, number, number][] = [
      [0.22, 0.25, -0.3, 0.34, 10, -25], [0.3, 0.2, -0.18, 0.24, -15, -40], [-0.18, 0.3, -0.36, 0.3, 20, 22],
      [-0.06, 0.38, -0.3, 0.26, -8, 6], [0.42, 0.12, 0.02, 0.2, 25, -30], [-0.4, 0.14, 0.08, 0.18, -20, 35], [0.12, 0.34, -0.42, 0.22, 30, -5],
    ];
    for (const [x, y, z, h, rx, rz] of spots) crystal(gb, x, y, z, h, rx, rz);
    out.glows.push({ pos: new THREE.Vector3(0.22, 0.3, -0.26), size: 0.3, slot: 'crystal' }, { pos: new THREE.Vector3(-0.12, 0.36, -0.32), size: 0.26, slot: 'crystal' });
    boxAt(gb, 0, 0.05, 0.34, 0.14, 0.07, 0.1, P.WOOD);
    for (const sx of [-1, 1]) gb.add(G.cyl(0.03, 0.03, 0.012, 8), T(sx * 0.075, 0.05, 0.34, 0, 0, 90), P.WOODDARK);
    for (let i = 0; i < 3; i++) crystal(gb, -0.03 + i * 0.03, 0.14, 0.34, 0.08, i * 20 - 20, i * 15 - 15);
    out.banner.set(-0.3, 0.3, -0.1);
    out.bannerHeight = 0.26;
    out.height = 0.6;
  },
  library(gb, lvl, out) {
    hexSlab(gb, 0.72, 0.03, 0.2, P.GROUND);
    boxAt(gb, 0, 0.03, 0.02, 0.56, 0.04, 0.46, P.STONE);
    boxAt(gb, 0, 0.07, -0.06, 0.48, 0.3, 0.3, P.PLASTER);
    gable(gb, 0, 0.37, -0.06, 0.54, 0.36, 0.17, P.ROOF);
    // portico
    boxAt(gb, 0, 0.07, 0.15, 0.4, 0.02, 0.12, P.STONE);
    for (const x of [-0.16, -0.055, 0.055, 0.16]) gb.add(G.cyl(0.02, 0.024, 0.26, 10), T(x, 0.21, 0.19), P.PLASTER);
    boxAt(gb, 0, 0.34, 0.16, 0.42, 0.03, 0.14, P.PLASTER);
    gable(gb, 0, 0.37, 0.16, 0.42, 0.14, 0.1, P.PLASTER);
    boxAt(gb, 0, 0.07, 0.092, 0.08, 0.15, 0.01, P.WOODDARK);
    for (const x of [-0.18, 0.18]) windowPane(gb, x, 0.22, 0.093, 0.04, 0.09);
    // observatory tower with dome
    const th = 0.5 + 0.08 * (lvl - 1);
    gb.add(G.cyl(0.1, 0.11, th, 14), T(-0.24, 0.07 + th / 2, -0.22), P.STONE);
    gb.add(G.sph(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), T(-0.24, 0.07 + th, -0.22), P.ROOF);
    gb.add(G.tor(0.105, 0.008, 5, 16), T(-0.24, 0.07 + th, -0.22, 90, 0, 0), P.GOLD);
    gb.add(G.cyl(0.012, 0.016, 0.12, 6), T(-0.2, 0.07 + th + 0.1, -0.18, -30, 0, -20), P.GOLD);
    windowPane(gb, -0.24, 0.07 + th * 0.7, -0.108, 0.03, 0.06);
    out.banner.set(0.2, 0.42, -0.06);
    out.bannerHeight = 0.26;
    out.height = 0.07 + th + 0.14;
  },
  magetower(gb, lvl, out) {
    gb.add(G.cyl(0.36, 0.4, 0.12, 8), T(0, 0.04, 0), P.STONE);
    gb.add(G.tor(0.34, 0.012, 5, 32), T(0, 0.105, 0, 90, 0, 0), P.CRYSTAL);
    const h = 1.0 + 0.12 * (lvl - 1);
    gb.add(G.cyl(0.155, 0.21, h, 14), T(0, 0.1 + h / 2, 0), P.STONE);
    for (let i = 0; i < 3; i++) {
      const a = i * 120 + 60;
      const x = Math.sin(a * D2R) * 0.2, z = Math.cos(a * D2R) * 0.2;
      gb.add(G.box(0.05, 0.36, 0.1), T(x, 0.26, z, 0, a, 0).multiply(T(0, 0, 0, 12, 0, 0)), P.STONE);
    }
    for (const y of [0.35, 0.7]) gb.add(G.tor(0.2 - y * 0.04, 0.012, 5, 22), T(0, 0.1 + y * h, 0, 90, 0, 0), P.ACCENT);
    for (let i = 0; i < 4; i++) {
      const a = i * 90 + 20, y = 0.3 + i * 0.17;
      const r = 0.205 - (y / h) * 0.05;
      gb.add(G.box(0.025, 0.07, 0.02), T(Math.sin(a * D2R) * r, 0.1 + y * h, Math.cos(a * D2R) * r, 0, a, 0), P.CRYSTAL);
    }
    boxAt(gb, 0, 0.1, 0.19, 0.07, 0.13, 0.03, P.WOODDARK);
    // balcony + spire
    gb.add(G.cyl(0.21, 0.17, 0.06, 14), T(0, 0.1 + h + 0.03, 0), P.STONE);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      gb.add(G.box(0.02, 0.05, 0.02), T(Math.sin(a) * 0.2, 0.1 + h + 0.085, Math.cos(a) * 0.2), P.STONE);
    }
    const spire: [number, number][] = [[0.2, 0], [0.18, 0.06], [0.12, 0.2], [0.06, 0.36], [0.015, 0.5], [0, 0.52]];
    gb.add(G.lathe(spire, 14), T(0, 0.1 + h + 0.06, 0), P.PRIMARY);
    gb.add(G.tor(0.17, 0.01, 5, 18), T(0, 0.1 + h + 0.1, 0, 90, 0, 0), P.GOLD);
    gb.add(G.sph(0.02, 8, 6), T(0, 0.1 + h + 0.6, 0), P.GOLD);
    const cr = new GeoBuilder(false);
    cr.addFlat(G.oct(0.07), T(0, 0, 0, 0, 0, 0, 0.7, 1.6, 0.7), P.CRYSTAL);
    for (let i = 0; i < 3; i++) cr.addFlat(G.oct(0.025), T(Math.sin(i * 2.1) * 0.11, Math.cos(i * 1.3) * 0.05, Math.cos(i * 2.1) * 0.11), P.CRYSTAL);
    out.parts.push({ geometry: cr.build(), pos: new THREE.Vector3(0, 0.1 + h + 0.74, 0), anim: 'float' });
    out.glows.push({ pos: new THREE.Vector3(0, 0.1 + h + 0.74, 0), size: 0.5, slot: 'crystal' });
    out.banner.set(0.19, 0.1 + h + 0.06, 0.05);
    out.bannerHeight = 0.3;
    out.height = 0.1 + h + 0.95;
  },
  wall(gb, lvl, out) {
    const h = 0.2 + 0.07 * (lvl - 1);
    const R = 0.7;
    const corners = [0, 1, 2, 3, 4, 5].map((k) => hexCorner(R, k, 0));
    for (let k = 0; k < 6; k++) {
      const a = corners[k], b = corners[(k + 1) % 6];
      if (k === 2 || k === 5) {
        // gaps (front-left & back-right openings) to read as a fortified post
        const m1: [number, number] = [a[0] + (b[0] - a[0]) * 0.36, a[1] + (b[1] - a[1]) * 0.36];
        const m2: [number, number] = [a[0] + (b[0] - a[0]) * 0.64, a[1] + (b[1] - a[1]) * 0.64];
        wallSeg(gb, a, m1, h, 0.1, P.STONE, 2);
        wallSeg(gb, m2, b, h, 0.1, P.STONE, 2);
      } else wallSeg(gb, a, b, h, 0.1, P.STONE, 4);
    }
    corners.forEach(([x, z]) => {
      gb.add(G.cyl(0.075, 0.085, h + 0.1, 10), T(x, (h + 0.1) / 2, z), P.STONE);
      gb.add(G.cyl(0.09, 0.09, 0.04, 10), T(x, h + 0.12, z), P.STONE);
    });
    gb.add(G.cyl(0.2, 0.22, 0.04, 6), T(0, 0.0, 0), P.GROUND);
    out.banner.set(corners[0][0], h + 0.14, corners[0][1]);
    out.bannerHeight = 0.3;
    out.height = h + 0.16;
  },
  watchtower(gb, lvl, out) {
    hexSlab(gb, 0.5, 0.02, 0.16, P.GROUND);
    const top = 0.75 + 0.1 * (lvl - 1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const s = span([sx * 0.18, 0.02, sz * 0.18], [sx * 0.12, top, sz * 0.12]);
      gb.add(G.cyl(0.018, 0.022, s.len, 6), s.m, P.WOOD);
    }
    for (const y of [0.25, 0.5]) {
      const r = 0.18 - (y / top) * 0.06;
      for (let k = 0; k < 4; k++) {
        const s = span([-r, y - 0.12, r], [r, y + 0.12, r]);
        gb.add(G.cyl(0.007, 0.007, s.len, 4), T(0, 0, 0, 0, k * 90, 0).multiply(s.m), P.WOODDARK);
      }
    }
    boxAt(gb, 0, top, 0, 0.36, 0.04, 0.36, P.WOOD);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxAt(gb, sx * 0.165, top + 0.04, sz * 0.165, 0.02, 0.14, 0.02, P.WOOD);
    for (let k = 0; k < 4; k++) boxAt(gb, 0, top + 0.12, 0, 0.35, 0.015, 0.015, P.WOOD, k * 90, 0, 0);
    for (let k = 0; k < 4; k++) gb.add(G.box(0.35, 0.015, 0.015), T(Math.sin(k * 90 * D2R) * 0.165, top + 0.13, Math.cos(k * 90 * D2R) * 0.165, 0, k * 90, 0), P.WOOD);
    gb.add(G.cone(0.3, 0.2, 4), T(0, top + 0.33, 0, 0, 45, 0), P.THATCH);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxAt(gb, sx * 0.16, top + 0.04, sz * 0.16, 0.014, 0.2, 0.014, P.WOOD);
    // brazier
    gb.add(G.cyl(0.05, 0.03, 0.04, 10), T(0, top + 0.06, 0), P.METAL);
    gb.add(G.cone(0.035, 0.06, 6), T(0, top + 0.1, 0), P.WINDOW);
    out.glows.push({ pos: new THREE.Vector3(0, top + 0.11, 0), size: 0.3, slot: 'window' });
    // ladder
    for (const s of [-1, 1]) { const l = span([s * 0.05, 0.02, 0.27], [s * 0.05, top, 0.16]); gb.add(G.cyl(0.007, 0.007, l.len, 4), l.m, P.WOODDARK); }
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      gb.add(G.cyl(0.005, 0.005, 0.1, 4), T(0, 0.02 + t * (top - 0.02), 0.27 - t * 0.11, 0, 0, 90), P.WOODDARK);
    }
    out.banner.set(0, top + 0.43, 0);
    out.bannerHeight = 0.22;
    out.height = top + 0.5;
  },
  shrine(gb, _lvl, out) {
    gb.add(G.cyl(0.5, 0.54, 0.08, 18), T(0, 0.02, 0), P.STONE);
    gb.add(G.cyl(0.3, 0.32, 0.04, 18), T(0, 0.08, 0), P.STONE);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      const h = 0.26 + ((i * 37) % 10) * 0.012;
      gb.addFlat(jitter(G.box(0.08, h, 0.05), 0.006, 40 + i), T(Math.sin(a) * 0.42, 0.06 + h / 2, Math.cos(a) * 0.42, 0, a / D2R, (i % 2 ? 4 : -3)), P.STONE);
      gb.add(G.box(0.012, 0.05, 0.006), T(Math.sin(a) * 0.395, 0.06 + h * 0.6, Math.cos(a) * 0.395, 0, a / D2R, 0), P.CRYSTAL);
    }
    gb.add(G.rbox(0.18, 0.12, 0.12, 0.015), T(0, 0.16, 0), P.STONE);
    gb.add(G.cyl(0.04, 0.05, 0.03, 10), T(0, 0.235, 0), P.GOLD);
    for (const [x, z] of [[0.3, 0.3], [-0.32, -0.25], [0.05, -0.45]] as [number, number][]) gb.add(G.sph(0.06, 8, 6), T(x, 0.08, z, 0, 0, 0, 1, 0.7, 1), P.GREEN);
    const orb = new GeoBuilder(false);
    orb.add(G.sph(0.045, 14, 10), null, P.CRYSTAL);
    out.parts.push({ geometry: orb.build(), pos: new THREE.Vector3(0, 0.34, 0), anim: 'float' });
    out.glows.push({ pos: new THREE.Vector3(0, 0.34, 0), size: 0.5, slot: 'crystal' });
    out.banner.set(0.42 * Math.sin(0.26), 0.36, 0.42 * Math.cos(0.26));
    out.bannerHeight = 0.18;
    out.height = 0.5;
  },
};

/** Procedural model for a building type at a level (cached). */
export function buildingModel(type: BuildingId, level: number): BuildingModel {
  const lvl = Math.max(1, Math.min(3, level | 0));
  const key = `${type}|${lvl}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const gb = new GeoBuilder(false);
  const out: Omit<BuildingModel, 'geometry'> = {
    height: 0.6, radius: 0.8, banner: new THREE.Vector3(0, 0.4, 0), bannerHeight: 0.28, parts: [], smoke: [], glows: [],
  };
  (BUILDERS[type] ?? BUILDERS.house)(gb, lvl, out);
  const model: BuildingModel = { geometry: gb.build(), ...out };
  cache.set(key, model);
  return model;
}

const scaffoldCache = new Map<string, THREE.BufferGeometry>();
/** Wooden scaffolding around a footprint of radius r up to height h. */
export function scaffoldGeometry(r: number, h: number): THREE.BufferGeometry {
  const key = `${r.toFixed(2)}|${h.toFixed(2)}`;
  const hit = scaffoldCache.get(key);
  if (hit) return hit;
  const gb = new GeoBuilder(false);
  const pts = [0, 1, 2, 3, 4, 5].map((k) => hexCorner(r, k, 30));
  for (const [x, z] of pts) gb.add(G.cyl(0.012, 0.014, h + 0.08, 5), T(x, (h + 0.08) / 2, z), BP.WOOD);
  const levels = Math.max(1, Math.round(h / 0.3));
  for (let l = 1; l <= levels; l++) {
    const y = (l / levels) * h * 0.92;
    for (let k = 0; k < 6; k++) {
      const a = pts[k], b = pts[(k + 1) % 6];
      if (k === 0 || k === 3) {
        const s = span([a[0], y, a[1]], [b[0], y, b[1]]);
        gb.add(G.box(0.09, 0.012, s.len), s.m.clone().multiply(T(0, 0, 0, 90, 0, 0)), BP.WOOD);
      }
      const s2 = span([a[0], y, a[1]], [b[0], y, b[1]]);
      gb.add(G.cyl(0.007, 0.007, s2.len, 4), s2.m, BP.WOODDARK);
      if (l === 1) {
        const d = span([a[0], 0.02, a[1]], [b[0], y, b[1]]);
        gb.add(G.cyl(0.005, 0.005, d.len, 4), d.m, BP.WOODDARK);
      }
    }
  }
  // material piles
  for (let i = 0; i < 3; i++) gb.add(G.rbox(0.08, 0.05, 0.06, 0.008), T(r * 0.9 + 0.05, 0.03 + i * 0.05, -0.1 + (i % 2) * 0.03), BP.STONE);
  for (let i = 0; i < 3; i++) gb.add(G.cyl(0.018, 0.018, 0.24, 6), T(-r * 0.85 - 0.04, 0.02 + i * 0.035, 0.1, 90, 30, 0), BP.WOOD);
  const g = gb.build();
  scaffoldCache.set(key, g);
  return g;
}
