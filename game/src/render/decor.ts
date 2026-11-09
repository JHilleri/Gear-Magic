// Instanced terrain decorations seeded per tile: trees, rocks, peaks, reeds, crystals, ruins,
// grass tufts, flowers and deposit props. Manifest prop GLBs are merged per material; anything
// missing uses stylised procedural geometry. One InstancedMesh per (prop, material part).
// Decorations on a tile with a (known) building are hidden; fog shrinks unexplored props away.
// Placements are grouped in cells of CELL×CELL tiles. Every frame `cull()` tests the cells against
// the camera frustum and against the sun's view of what is on screen; each instance buffer is then
// packed with the on-screen cells first and the cells that only cast shadows into the view after
// them, and the draw count switches between the two per pass (onBeforeRender / onBeforeShadow).
// Props on tiles the viewer has not explored (nor any neighbour of) are not drawn at all.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameState, TerrainId } from '../core/types';
import { DIRS, hexToWorld, inBounds, indexToHex, tileIndex } from '../core/hex';
import { Rng, hash2 } from '../core/rng';
import type { AssetLibrary } from './types';
import { fowDepthMaterial, patchFow, type FowUniforms } from './fow';
import { WATER_LEVEL, type Terrain } from './terrain';

interface PropPart { geometry: THREE.BufferGeometry; material: THREE.Material; tint: boolean }
/** Shadow tier: cast always, only on the high quality setting, or never. */
type ShadowTier = 'always' | 'high' | 'never';
interface Placement { tile: number; cell: number; m: THREE.Matrix4; c: THREE.Color }
interface PropType {
  key: string;
  parts: PropPart[];
  wind: number;
  shadow: ShadowTier;
  ao: boolean;               // drawn into the screen-space AO pre-pass
  align: number;             // 0 = upright, 1 = follow terrain normal
  occShrink: number;          // how much the prop yields on tiles with a visible unit
  meshes: THREE.InstancedMesh[];
  placements: Placement[];
  /** placements sorted by cell: cell c owns placements[cellStart[c] .. cellStart[c + 1]). */
  cellStart: Int32Array;
  /** Draw counts of the current packing: on-screen instances, and those plus shadow-only ones. */
  mainCount: number;
  totalCount: number;
}

/** Tiles per decor cell side (culling granularity). */
const CELL = 4;

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

// ───────────────────────────── procedural geometry ─────────────────────────────
function withColor(geo: THREE.BufferGeometry, fn: (p: THREE.Vector3, i: number) => THREE.Color): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const c = fn(p, i);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
function solid(c: THREE.Color) { return () => c; }

/** Jitter shared vertices consistently (so the mesh stays watertight). */
function jitter(geo: THREE.BufferGeometry, amt: number, seed: number, yAmt = amt): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  const g = mergeVertices(geo, 1e-4);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const hx = Math.round(x * 1000), hz = Math.round(z * 1000), hy = Math.round(y * 1000);
    pos.setXYZ(i,
      x + (hash2(hx, hz + hy, seed) - 0.5) * amt,
      y + (hash2(hz, hx - hy, seed + 1) - 0.5) * yAmt,
      z + (hash2(hx + hy, hz, seed + 2) - 0.5) * amt);
  }
  return g;
}
function finish(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = geos.map((g) => {
    let x = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'color') x.deleteAttribute(k);
    if (!x.attributes.color) x = withColor(x, solid(new THREE.Color(1, 1, 1)));
    return x;
  });
  const m = mergeGeometries(list, false)!;
  m.computeVertexNormals();
  return m;
}
/** Grass-like cards: normals forced up for soft, consistent shading. */
function finishBlades(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = finish(geos);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

function gradient(a: THREE.Color, b: THREE.Color, y0: number, y1: number) {
  const c = new THREE.Color();
  return (p: THREE.Vector3) => c.copy(a).lerp(b, Math.min(1, Math.max(0, (p.y - y0) / (y1 - y0))));
}

function pineGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(withColor(new THREE.CylinderGeometry(0.02, 0.034, 0.22, 6).translate(0, 0.11, 0), solid(srgb(0.33, 0.22, 0.13))));
  const tiers = 4;
  for (let k = 0; k < tiers; k++) {
    const r = 0.21 - k * 0.042, h = 0.27 - k * 0.025, y = 0.14 + k * 0.125;
    const cone = jitter(new THREE.ConeGeometry(r, h, 8, 1).translate(0, y + h / 2, 0), 0.03, 11 + k, 0.015);
    parts.push(withColor(cone, gradient(srgb(0.07, 0.19, 0.09), srgb(0.17, 0.36, 0.15), y, y + h)));
  }
  return finish(parts);
}
function oakGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(withColor(new THREE.CylinderGeometry(0.026, 0.045, 0.3, 6).translate(0, 0.15, 0), solid(srgb(0.36, 0.25, 0.15))));
  parts.push(withColor(new THREE.CylinderGeometry(0.012, 0.02, 0.16, 5).rotateZ(0.9).translate(0.06, 0.25, 0), solid(srgb(0.36, 0.25, 0.15))));
  const blobs: [number, number, number, number][] = [[0, 0.42, 0, 0.17], [0.11, 0.36, 0.05, 0.12], [-0.1, 0.37, -0.04, 0.13], [0.02, 0.36, -0.11, 0.12], [-0.03, 0.52, 0.04, 0.12]];
  blobs.forEach(([x, y, z, r], i) => {
    // Only the crown blob is subdivided; the others stay at 20 faces (instanced ×1000s).
    const s = jitter(new THREE.IcosahedronGeometry(r, i === 0 ? 1 : 0), r * (i === 0 ? 0.35 : 0.22), 30 + i).translate(x, y, z);
    parts.push(withColor(s, gradient(srgb(0.12, 0.27, 0.09), srgb(0.33, 0.5, 0.17), 0.26, 0.62)));
  });
  return finish(parts);
}
function deadTreeGeo(): THREE.BufferGeometry {
  const c = srgb(0.3, 0.27, 0.23);
  const parts = [
    withColor(new THREE.CylinderGeometry(0.018, 0.04, 0.42, 6).translate(0, 0.21, 0), solid(c)),
    withColor(new THREE.CylinderGeometry(0.008, 0.016, 0.2, 5).translate(0, 0.1, 0).rotateZ(0.8).translate(0.0, 0.26, 0), solid(c)),
    withColor(new THREE.CylinderGeometry(0.007, 0.014, 0.16, 5).translate(0, 0.08, 0).rotateZ(-0.9).rotateY(1.2).translate(0, 0.33, 0), solid(c)),
    withColor(new THREE.CylinderGeometry(0.006, 0.012, 0.12, 5).translate(0, 0.06, 0).rotateX(0.7).translate(0, 0.38, 0), solid(c)),
  ];
  return finish(parts);
}
function rockGeo(seed: number, tint = srgb(0.5, 0.49, 0.46)): THREE.BufferGeometry {
  const g = jitter(new THREE.IcosahedronGeometry(0.11, 1), 0.05, seed).scale(1, 0.62, 0.9).translate(0, 0.035, 0);
  const moss = srgb(0.34, 0.4, 0.2);
  const dark = tint.clone().multiplyScalar(0.55);
  const c = new THREE.Color();
  return finish([withColor(g, (p) => {
    c.copy(dark).lerp(tint, Math.min(1, Math.max(0, (p.y + 0.02) / 0.09)));
    if (p.y > 0.06) c.lerp(moss, 0.45);
    return c;
  })]);
}
function peakGeo(seed: number): THREE.BufferGeometry {
  const rock = srgb(0.44, 0.41, 0.38), dark = srgb(0.26, 0.24, 0.23), snow = srgb(0.93, 0.95, 0.99);
  const c = new THREE.Color();
  const col = (top: number) => (p: THREE.Vector3) => {
    c.copy(dark).lerp(rock, Math.min(1, p.y / (top * 0.5)));
    if (p.y > top * 0.62 + hash2(Math.round(p.x * 100), Math.round(p.z * 100), seed) * top * 0.12) c.copy(snow);
    return c;
  };
  // Craggy spires: several jittered, slightly leaning cones of different heights.
  const spires: [number, number, number, number, number][] = [[0, 0, 0.36, 0.9, 0.12], [0.24, 0.1, 0.22, 0.58, -0.18], [-0.2, 0.14, 0.2, 0.46, 0.2], [0.05, -0.24, 0.18, 0.4, 0.1]];
  const parts = spires.map(([x, z, r, h, lean], i) => {
    const g = jitter(new THREE.ConeGeometry(r, h, 7, 4).translate(0, h / 2, 0), r * 0.32, seed + i * 7, h * 0.06);
    g.rotateZ(lean).rotateX(lean * 0.6).translate(x, -0.02, z);
    return withColor(g, col(h));
  });
  return finish(parts);
}
function crystalGeo(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const h = 0.14 + rng.next() * 0.24 * (i === 0 ? 1.6 : 1);
    const g = new THREE.OctahedronGeometry(1, 0).scale(0.04 + rng.next() * 0.02, h / 2, 0.04 + rng.next() * 0.02).translate(0, h / 2 - 0.02, 0);
    g.rotateZ((rng.next() - 0.5) * 0.9).rotateX((rng.next() - 0.5) * 0.9).rotateY(rng.next() * 6.28);
    const a = i === 0 ? 0 : rng.next() * 6.28, r = i === 0 ? 0 : 0.04 + rng.next() * 0.05;
    g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    const tint = rng.next() < 0.3 ? srgb(0.55, 0.85, 1.0) : srgb(0.78, 0.58, 1.0);
    parts.push(withColor(g, solid(tint)));
  }
  return finish(parts);
}
function bushGeo(seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number][] = [[0, 0.06, 0, 0.075], [0.06, 0.045, 0.02, 0.055], [-0.05, 0.045, -0.03, 0.06]];
  blobs.forEach(([x, y, z, r], i) => {
    parts.push(withColor(jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.22, seed + i).translate(x, y, z), gradient(srgb(0.1, 0.22, 0.07), srgb(0.28, 0.44, 0.14), 0, 0.12)));
  });
  return finish(parts);
}
function bladesGeo(seed: number, count: number, hMin: number, hMax: number, spread: number, base: THREE.Color, tip: THREE.Color, width = 0.012): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = rng.next() * Math.PI * 2, r = rng.next() * spread;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = hMin + rng.next() * (hMax - hMin);
    const lean = 0.25 + rng.next() * 0.5;
    const tx = x + Math.cos(a) * h * lean * 0.5, tz = z + Math.sin(a) * h * lean * 0.5;
    const px = -Math.sin(a) * width, pz = Math.cos(a) * width;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([x - px, 0, z - pz, x + px, 0, z + pz, tx, h, tz], 3));
    parts.push(withColor(g, gradient(base, tip, 0, h)));
  }
  return finishBlades(parts);
}
function reedsGeo(seed: number): THREE.BufferGeometry {
  const blades = bladesGeo(seed, 10, 0.16, 0.3, 0.07, srgb(0.24, 0.3, 0.12), srgb(0.56, 0.56, 0.3), 0.008);
  const rng = new Rng(seed + 9);
  const heads: THREE.BufferGeometry[] = [blades];
  for (let i = 0; i < 3; i++) {
    const a = rng.next() * 6.28, r = rng.next() * 0.05, h = 0.24 + rng.next() * 0.08;
    heads.push(withColor(new THREE.CylinderGeometry(0.004, 0.004, h, 3).translate(Math.cos(a) * r, h / 2, Math.sin(a) * r), solid(srgb(0.4, 0.42, 0.2))));
    heads.push(withColor(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 5).translate(Math.cos(a) * r, h, Math.sin(a) * r), solid(srgb(0.36, 0.22, 0.12))));
  }
  return finishBlades(heads);
}
function wheatGeo(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [bladesGeo(seed, 12, 0.1, 0.16, 0.08, srgb(0.5, 0.42, 0.16), srgb(0.85, 0.7, 0.3), 0.006)];
  for (let i = 0; i < 10; i++) {
    const a = rng.next() * 6.28, r = rng.next() * 0.08, h = 0.13 + rng.next() * 0.05;
    parts.push(withColor(new THREE.OctahedronGeometry(1, 0).scale(0.01, 0.028, 0.01).translate(Math.cos(a) * r * 1.2, h, Math.sin(a) * r * 1.2), solid(srgb(0.9, 0.74, 0.32))));
  }
  return finishBlades(parts);
}
function flowerLeavesGeo(seed: number): THREE.BufferGeometry {
  return bladesGeo(seed, 7, 0.03, 0.06, 0.04, srgb(0.15, 0.3, 0.08), srgb(0.3, 0.5, 0.15), 0.01);
}
function flowerBlossomGeo(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = rng.next() * 6.28, r = rng.next() * 0.045, h = 0.045 + rng.next() * 0.03;
    parts.push(withColor(new THREE.IcosahedronGeometry(0.013, 0).translate(Math.cos(a) * r, h, Math.sin(a) * r), solid(new THREE.Color(1, 1, 1))));
  }
  return finish(parts);
}
function ruinColumnGeo(seed: number): THREE.BufferGeometry {
  const stone = srgb(0.66, 0.63, 0.56), moss = srgb(0.36, 0.42, 0.22);
  const c = new THREE.Color();
  const col = (p: THREE.Vector3) => c.copy(moss).lerp(stone, Math.min(1, (p.y + 0.02) / 0.14));
  const shaft = new THREE.CylinderGeometry(0.06, 0.068, 0.36, 8, 3).translate(0, 0.2, 0);
  const pos = shaft.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.37) pos.setY(i, 0.38 - hash2(i, seed, 3) * 0.16);
  return finish([
    withColor(jitter(shaft, 0.01, seed, 0.01), col),
    withColor(new THREE.BoxGeometry(0.19, 0.045, 0.19).translate(0, 0.022, 0), col),
  ]);
}
function ruinBlockGeo(seed: number): THREE.BufferGeometry {
  const stone = srgb(0.62, 0.6, 0.54);
  return finish([
    withColor(jitter(new THREE.BoxGeometry(0.2, 0.1, 0.13, 2, 1, 1).translate(0, 0.045, 0), 0.025, seed), solid(stone)),
    withColor(jitter(new THREE.BoxGeometry(0.11, 0.07, 0.1).rotateY(0.6).translate(0.12, 0.03, 0.08), 0.02, seed + 1), solid(stone.clone().multiplyScalar(0.9))),
  ]);
}
function ruinWallGeo(seed: number): THREE.BufferGeometry {
  const stone = srgb(0.6, 0.57, 0.5), moss = srgb(0.34, 0.4, 0.2);
  const g = new THREE.BoxGeometry(0.46, 0.28, 0.08, 6, 3, 1).translate(0, 0.14, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0.27) pos.setY(i, 0.28 - hash2(Math.round(pos.getX(i) * 100), seed, 5) * 0.2);
  }
  const c = new THREE.Color();
  return finish([withColor(jitter(g, 0.012, seed, 0.01), (p) => c.copy(moss).lerp(stone, Math.min(1, (p.y + 0.02) / 0.12)))]);
}
function oreGeo(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts = [rockGeo(seed, srgb(0.3, 0.28, 0.29))];
  for (let i = 0; i < 6; i++) {
    const a = rng.next() * 6.28, r = 0.03 + rng.next() * 0.06;
    parts.push(withColor(new THREE.OctahedronGeometry(0.022 + rng.next() * 0.015, 0).translate(Math.cos(a) * r, 0.04 + rng.next() * 0.04, Math.sin(a) * r), solid(srgb(0.72, 0.38, 0.16))));
  }
  return finish(parts);
}
function stonePileGeo(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const spots: [number, number, number][] = [[0, 0, 0], [0.1, 0, 0.02], [-0.09, 0, 0.04], [0.02, 0, -0.09], [0.03, 0.06, 0.0], [-0.04, 0.06, -0.03]];
  for (const [x, y, z] of spots) {
    const s = 0.07 + rng.next() * 0.03;
    const b = jitter(new THREE.BoxGeometry(s * 1.2, s * 0.7, s), 0.01, seed + Math.round(x * 100)).rotateY(rng.next() * 3).translate(x, y + s * 0.35, z);
    parts.push(withColor(b, solid(srgb(0.6 + rng.next() * 0.1, 0.59 + rng.next() * 0.08, 0.55))));
  }
  return finish(parts);
}

// ───────────────────────────── GLB → merged parts ─────────────────────────────
function geometryForGroup(geo: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const out = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) {
    const attr = a as THREE.BufferAttribute;
    const arr = (attr.array as Float32Array).slice(start * attr.itemSize, (start + count) * attr.itemSize);
    out.setAttribute(k, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
  }
  return out;
}

function partsFromModel(root: THREE.Object3D): PropPart[] {
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    const add = (mat: THREE.Material, g: THREE.BufferGeometry) => {
      g.applyMatrix4(mesh.matrixWorld);
      const list = byMat.get(mat) ?? [];
      list.push(g);
      byMat.set(mat, list);
    };
    if (Array.isArray(mesh.material)) {
      const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
      for (const gr of groups) {
        const mat = mesh.material[gr.materialIndex ?? 0];
        if (!mat) continue;
        const total = mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count;
        add(mat, geometryForGroup(mesh.geometry, gr.start, Math.min(gr.count, total - gr.start)));
      }
    } else {
      add(mesh.material, mesh.geometry.clone());
    }
  });
  const parts: PropPart[] = [];
  for (const [mat, geos] of byMat) {
    // Keep only attributes every piece has; make indexing uniform.
    const keys = ['position', 'normal', 'uv', 'color'].filter((k) => geos.every((g) => g.attributes[k]));
    const norm = geos.map((g) => {
      const x = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(x.attributes)) if (!keys.includes(k)) x.deleteAttribute(k);
      return x;
    });
    const merged = norm.length === 1 ? norm[0] : mergeGeometries(norm, false);
    if (!merged) continue;
    if (!merged.attributes.normal) merged.computeVertexNormals();
    let m = mat.clone();
    if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const src = mat as THREE.MeshBasicMaterial;
      m = new THREE.MeshStandardMaterial({ color: src.color ?? new THREE.Color(1, 1, 1), map: src.map ?? null, roughness: 0.85, vertexColors: !!merged.attributes.color });
    }
    parts.push({ geometry: merged, material: m, tint: true });
  }
  return parts;
}

// ───────────────────────────── layer ─────────────────────────────
export interface Decor {
  group: THREE.Group;
  /**
   * Which placements exist: none on tiles flagged in `hidden` (1 = known building there), and with
   * `explored`, none on tiles that neither the viewer explored nor border an explored tile.
   */
  setMask(hidden: Uint8Array, explored?: ArrayLike<number> | null): void;
  /**
   * Per-frame culling. `view`: the camera frustum. `sunDir`: unit vector toward the sun; a cell off
   * screen is still drawn into the shadow map when its shadow can fall into the view.
   */
  cull(view: THREE.Frustum, sunDir: THREE.Vector3 | null, shadowView?: THREE.Frustum | null): void;
  /** Small props (rocks, bushes, crystals) cast shadows on 'high' only. */
  setQuality(q: 'low' | 'high'): void;
  /** Debug (perf comparisons): draw every placement in every pass, as before culling existed. */
  setDebugNoCull(on: boolean): void;
  dispose(): void;
}

export function buildDecor(state: GameState, terrain: Terrain, assets: AssetLibrary, uniforms: FowUniforms): Decor {
  const group = new THREE.Group();
  group.name = 'decor';
  const types = new Map<string, PropType>();
  const ownedMaterials: THREE.Material[] = [];
  const ownedGeometries: THREE.BufferGeometry[] = [];

  const vcMat = (opts: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, flatShading: true, ...opts });

  const define = (key: string, procedural: () => PropPart[], o: { wind?: number; shadow?: ShadowTier; ao?: boolean; align?: number; model?: string; occ?: number } = {}) => {
    const model = o.model ? assets.model('props', o.model) : null;
    const parts = model ? partsFromModel(model) : procedural();
    types.set(key, {
      key, parts: parts.length ? parts : procedural(), wind: o.wind ?? 0, shadow: o.shadow ?? 'always', ao: o.ao ?? true, align: o.align ?? 0,
      occShrink: o.occ ?? 0, meshes: [], placements: [], cellStart: new Int32Array(0), mainCount: 0, totalCount: 0,
    });
  };
  const single = (geo: THREE.BufferGeometry, mat: THREE.Material, tint = true): PropPart[] => [{ geometry: geo, material: mat, tint }];
  const blades = () => vcMat({ flatShading: false, side: THREE.DoubleSide, roughness: 0.95 });

  // occ: props on a tile with a visible unit bow out of the way so the unit is never smaller than its cover.
  define('pine', () => single(pineGeo(), vcMat({ roughness: 0.9 })), { wind: 0.05, model: 'pine', occ: 0.5 });
  define('oak', () => single(oakGeo(), vcMat({ roughness: 0.9 })), { wind: 0.05, model: 'oak', occ: 0.5 });
  define('deadtree', () => single(deadTreeGeo(), vcMat()), { wind: 0.02, model: 'deadtree', occ: 0.35 });
  define('rock', () => single(rockGeo(3), vcMat()), { align: 0.6, model: 'rock', occ: 0.45, shadow: 'high' });
  define('rock2', () => single(rockGeo(17), vcMat()), { align: 0.6, model: 'rock', occ: 0.45, shadow: 'high' });
  define('peak', () => single(peakGeo(5), vcMat({ roughness: 0.9, flatShading: false })), { model: 'peak' });
  define('peak2', () => single(peakGeo(23), vcMat({ roughness: 0.9, flatShading: false })), { model: 'peak' });
  define('crystal', () => single(crystalGeo(7), new THREE.MeshStandardMaterial({
    vertexColors: true, color: srgb(0.85, 0.75, 1.0), emissive: srgb(0.5, 0.26, 1.0), emissiveIntensity: 2.6,
    roughness: 0.16, metalness: 0.05, flatShading: true,
  })), { model: 'crystal', occ: 0.35, shadow: 'high' });
  define('bush', () => single(bushGeo(9), vcMat({ roughness: 0.9 })), { wind: 0.12, model: 'bush', occ: 0.3, shadow: 'high' });
  // Tiny blade props (grass, reeds, flowers, wheat) add nothing to shadows or screen-space AO.
  define('tuft', () => single(bladesGeo(13, 8, 0.06, 0.12, 0.05, srgb(0.2, 0.3, 0.09), srgb(0.62, 0.74, 0.32)), blades()), { wind: 0.7, shadow: 'never', ao: false });
  define('reeds', () => single(reedsGeo(19), blades(), false), { wind: 0.35, shadow: 'never', ao: false, model: 'reeds', occ: 0.3 });
  define('wheat', () => single(wheatGeo(21), blades(), false), { wind: 0.45, shadow: 'never', ao: false });
  define('flowers', () => [
    { geometry: flowerLeavesGeo(25), material: blades(), tint: false },
    { geometry: flowerBlossomGeo(27), material: vcMat({ flatShading: false, roughness: 0.7 }), tint: true },
  ], { wind: 0.5, shadow: 'never', ao: false });
  define('ruin_column', () => single(ruinColumnGeo(31), vcMat()), { model: 'ruin', occ: 0.35 });
  define('ruin_block', () => single(ruinBlockGeo(33), vcMat()), { align: 0.5, model: 'ruin', shadow: 'never' });
  define('ruin_wall', () => single(ruinWallGeo(35), vcMat()), { model: 'ruin', occ: 0.35 });
  define('ore', () => single(oreGeo(37), vcMat({ roughness: 0.6, metalness: 0.25 }), false), { align: 0.5, shadow: 'never' });
  define('stones', () => single(stonePileGeo(39), vcMat(), false), { align: 0.4, shadow: 'never' });

  // ── placement ──
  const W = state.width;
  const cellsX = Math.ceil(state.width / CELL), cellsZ = Math.ceil(state.height / CELL);
  const nCells = cellsX * cellsZ;
  const cellOf = (ti: number) => Math.floor((ti % W) / CELL) + Math.floor(Math.floor(ti / W) / CELL) * cellsX;
  const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3();
  const tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
  const TINT_GRASS = srgb(1, 1, 1), TINT_PLAINS = srgb(1.25, 1.1, 0.62), TINT_FOREST = srgb(0.62, 0.78, 0.55), TINT_SWAMP = srgb(0.85, 0.82, 0.55), TINT_HILLS = srgb(1.05, 1.0, 0.78);
  const FLOWER_COLORS = [srgb(0.95, 0.35, 0.3), srgb(1.0, 0.85, 0.3), srgb(0.95, 0.95, 0.95), srgb(0.7, 0.45, 0.95), srgb(0.4, 0.6, 1.0)];

  for (let ti = 0; ti < state.tiles.length; ti++) {
    const tile = state.tiles[ti];
    const hex = indexToHex(ti, W);
    const c = hexToWorld(hex);
    const rng = new Rng((tile.variant * 2654435761) ^ (ti * 40503) ^ 0x9e3779b9);
    const place = (key: string, rMin: number, rMax: number, sMin: number, sMax: number, opts: { minY?: number; tint?: THREE.Color; jitterTint?: number; tilt?: number } = {}) => {
      const t = types.get(key);
      if (!t) return;
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rMin * rMin + rng.next() * (rMax * rMax - rMin * rMin));
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      const y = terrain.heightAt(x, z);
      if (y < (opts.minY ?? WATER_LEVEL + 0.03)) return;
      const s = sMin + rng.next() * (sMax - sMin);
      tmpQ.setFromAxisAngle(up, rng.next() * Math.PI * 2);
      if (t.align > 0) {
        terrain.normalAt(x, z, nrm);
        tmpQ2.setFromUnitVectors(up, nrm);
        tmpQ.premultiply(tmpQ2.slerp(new THREE.Quaternion(), 1 - t.align));
      }
      if (opts.tilt) {
        tmpQ2.setFromAxisAngle(tmpP.set(rng.next() - 0.5, 0, rng.next() - 0.5).normalize(), (rng.next() - 0.5) * opts.tilt);
        tmpQ.premultiply(tmpQ2);
      }
      const m = new THREE.Matrix4().compose(tmpP.set(x, y - 0.012 * s, z), tmpQ, tmpS.set(s, s * (0.9 + rng.next() * 0.2), s));
      const jt = opts.jitterTint ?? 0.14;
      const col = (opts.tint ?? TINT_GRASS).clone().multiplyScalar(1 - jt / 2 + rng.next() * jt);
      t.placements.push({ tile: ti, cell: cellOf(ti), m, c: col });
    };
    const n = (lo: number, hi: number) => rng.int(lo, hi);
    const terr: TerrainId = tile.terrain;
    switch (terr) {
      case 'forest': {
        const pineBias = hash2(tile.variant, ti, 77);
        const count = n(7, 10);
        // Trees ring the tile and leave a clearing where a unit would stand.
        for (let k = 0; k < count; k++) place(rng.next() < 0.2 + pineBias * 0.65 ? 'pine' : 'oak', 0.4, 0.86, 0.8, 1.2, { jitterTint: 0.25 });
        for (let k = n(1, 2); k > 0; k--) place('bush', 0.15, 0.8, 0.8, 1.3);
        for (let k = n(3, 5); k > 0; k--) place('tuft', 0.1, 0.84, 0.8, 1.2, { tint: TINT_FOREST });
        break;
      }
      case 'grass': {
        for (let k = n(9, 15); k > 0; k--) place('tuft', 0.05, 0.86, 0.8, 1.35, { tint: TINT_GRASS });
        for (let k = n(0, 3); k > 0; k--) place('flowers', 0.15, 0.82, 0.8, 1.3, { tint: rng.pick(FLOWER_COLORS), jitterTint: 0.1 });
        for (let k = n(0, 2); k > 0; k--) place('bush', 0.35, 0.82, 0.7, 1.2);
        if (rng.next() < 0.18) place(rng.next() < 0.5 ? 'rock' : 'rock2', 0.3, 0.8, 0.5, 0.9);
        if (rng.next() < 0.12) place('oak', 0.45, 0.8, 0.85, 1.15);
        break;
      }
      case 'plains': {
        for (let k = n(7, 11); k > 0; k--) place('tuft', 0.05, 0.86, 0.8, 1.3, { tint: TINT_PLAINS });
        if (rng.next() < 0.45) place('bush', 0.35, 0.82, 0.6, 1.0, { tint: TINT_PLAINS.clone().multiplyScalar(0.8) });
        if (rng.next() < 0.25) place(rng.next() < 0.5 ? 'rock' : 'rock2', 0.3, 0.8, 0.5, 0.9);
        if (rng.next() < 0.08) place('pine', 0.45, 0.8, 0.8, 1.1);
        break;
      }
      case 'hills': {
        for (let k = n(2, 4); k > 0; k--) place(rng.next() < 0.5 ? 'rock' : 'rock2', 0.25, 0.82, 0.8, 1.7);
        for (let k = n(0, 2); k > 0; k--) place('bush', 0.3, 0.82, 0.7, 1.2, { tint: TINT_HILLS });
        for (let k = n(4, 7); k > 0; k--) place('tuft', 0.05, 0.86, 0.8, 1.2, { tint: TINT_HILLS });
        if (rng.next() < 0.18) place('pine', 0.4, 0.8, 0.8, 1.1);
        break;
      }
      case 'mountain': {
        for (let k = n(1, 2); k > 0; k--) place(rng.next() < 0.5 ? 'peak' : 'peak2', 0.32, 0.66, 0.42, 0.62, { minY: -10, jitterTint: 0.2 });
        for (let k = n(2, 3); k > 0; k--) place(rng.next() < 0.5 ? 'rock' : 'rock2', 0.2, 0.84, 0.9, 1.8, { minY: -10 });
        break;
      }
      case 'swamp': {
        for (let k = n(3, 6); k > 0; k--) place('reeds', 0.15, 0.85, 0.8, 1.3, { minY: WATER_LEVEL - 0.08 });
        for (let k = n(1, 2); k > 0; k--) place('deadtree', 0.32, 0.8, 0.8, 1.2, { minY: WATER_LEVEL - 0.05, tilt: 0.25 });
        for (let k = n(1, 3); k > 0; k--) place('tuft', 0.1, 0.85, 0.8, 1.2, { tint: TINT_SWAMP });
        break;
      }
      case 'shallows': {
        for (let k = n(0, 2); k > 0; k--) place('reeds', 0.45, 0.85, 0.7, 1.1, { minY: WATER_LEVEL - 0.1 });
        if (rng.next() < 0.3) place('rock2', 0.4, 0.8, 0.6, 1.0, { minY: -10 });
        break;
      }
      case 'crystal': {
        for (let k = n(2, 4); k > 0; k--) place('crystal', 0.28, 0.78, 1.3, 2.3, { tilt: 0.35, jitterTint: 0.2 });
        if (rng.next() < 0.6) place('rock', 0.3, 0.8, 0.6, 1.1);
        for (let k = n(2, 4); k > 0; k--) place('tuft', 0.1, 0.85, 0.8, 1.1, { tint: srgb(0.85, 0.9, 1.0) });
        break;
      }
      case 'ruins': {
        for (let k = n(2, 3); k > 0; k--) place('ruin_column', 0.2, 0.72, 0.8, 1.25, { tilt: 0.2 });
        for (let k = n(1, 2); k > 0; k--) place('ruin_block', 0.15, 0.75, 0.8, 1.3);
        place('ruin_wall', 0.3, 0.6, 0.85, 1.2);
        for (let k = n(2, 4); k > 0; k--) place('tuft', 0.1, 0.85, 0.8, 1.2, { tint: TINT_HILLS });
        break;
      }
      default: break;
    }
    switch (tile.deposit) {
      case 'iron': for (let k = n(2, 3); k > 0; k--) place('ore', 0.32, 0.66, 0.9, 1.3, { minY: -10 }); break;
      case 'crystal': if (terr !== 'crystal') for (let k = n(2, 3); k > 0; k--) place('crystal', 0.3, 0.66, 0.8, 1.2, { minY: -10, tilt: 0.4 }); break;
      case 'stone': for (let k = n(1, 2); k > 0; k--) place('stones', 0.32, 0.64, 0.9, 1.3); break;
      case 'fertile': for (let k = n(4, 6); k > 0; k--) place('wheat', 0.2, 0.76, 0.85, 1.25, { jitterTint: 0.12 }); break;
      default: break;
    }
  }

  // ── instanced meshes ──
  const white = new THREE.Color(1, 1, 1);
  // cell bounds (world AABB of every prop in the cell, padded for wind sway and the fog sink)
  const cellBox: THREE.Box3[] = Array.from({ length: nCells }, () => new THREE.Box3());
  const sph = new THREE.Sphere(), sc = new THREE.Vector3(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
  let quality: 'low' | 'high' = 'high';
  for (const t of types.values()) {
    if (t.placements.length === 0) continue;
    t.placements.sort((a, b) => a.cell - b.cell);
    t.cellStart = new Int32Array(nCells + 1);
    for (const p of t.placements) t.cellStart[p.cell + 1]++;
    for (let c = 0; c < nCells; c++) t.cellStart[c + 1] += t.cellStart[c];
    let r = 0;
    const center = new THREE.Vector3();
    for (const part of t.parts) {
      part.geometry.computeBoundingSphere();
      const bs = part.geometry.boundingSphere!;
      if (bs.radius + bs.center.length() > r) { r = bs.radius + bs.center.length(); center.copy(bs.center); }
    }
    for (const p of t.placements) {
      p.m.decompose(sc, sq, ss);
      sph.center.copy(sc);
      sph.radius = r * Math.max(ss.x, ss.y, ss.z) + 0.5;
      const b = cellBox[p.cell];
      b.expandByPoint(sc.set(sph.center.x - sph.radius, sph.center.y - sph.radius - 0.45, sph.center.z - sph.radius));
      b.expandByPoint(sc.set(sph.center.x + sph.radius, sph.center.y + sph.radius, sph.center.z + sph.radius));
    }
    for (const part of t.parts) {
      const mat = part.material;
      const std = mat as THREE.MeshStandardMaterial;
      patchFow(mat, uniforms, { mode: 'shrink', tint: true, wind: t.wind, occShrink: t.occShrink, pulse: std.emissiveIntensity > 0 && std.emissive?.getHex() !== 0 && t.key === 'crystal' }, undefined, t.key);
      ownedMaterials.push(mat);
      ownedGeometries.push(part.geometry);
      const im = new THREE.InstancedMesh(part.geometry, mat, t.placements.length);
      im.name = `decor-${t.key}`;
      im.castShadow = t.shadow !== 'never';
      im.receiveShadow = true;
      if (!t.ao) im.userData.noAO = true;
      const depthMap = std.alphaTest > 0 || std.transparent ? std.map : null;
      const dm = fowDepthMaterial(uniforms, 'shrink', t.wind, depthMap, t.occShrink);
      im.customDepthMaterial = dm;
      ownedMaterials.push(dm);
      for (let k = 0; k < t.placements.length; k++) {
        im.setMatrixAt(k, t.placements[k].m);
        im.setColorAt(k, part.tint ? t.placements[k].c : white);
      }
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      // culled by cell on the CPU (see cull()); the draw count differs between the colour/AO and shadow passes
      im.frustumCulled = false;
      im.matrixAutoUpdate = false;
      im.onBeforeRender = () => { im.count = t.mainCount; };
      im.onBeforeShadow = () => { im.count = t.totalCount; };
      t.meshes.push(im);
      group.add(im);
    }
    t.mainCount = t.totalCount = t.placements.length;
  }

  // ── masks & culling ──
  let active = new Map<PropType, Uint8Array>();
  for (const t of types.values()) active.set(t, new Uint8Array(t.placements.length).fill(1));
  let lastMask = '';
  let maskDirty = true;
  /** Per cell: 0 not drawn, 1 on screen, 2 only casts a shadow into the view. */
  const cellState = new Uint8Array(nCells).fill(1);
  let lastCells = '';
  const swept = new THREE.Box3(), shift = new THREE.Vector3();
  const near = new Uint8Array(state.tiles.length);
  let noCull = false;
  let lastHidden: Uint8Array = new Uint8Array(state.tiles.length);
  let lastExplored: ArrayLike<number> | null = null;

  function repack(): void {
    for (const t of types.values()) {
      if (!t.meshes.length) continue;
      const act = active.get(t)!;
      const casts = t.meshes[0].castShadow;
      for (let pi = 0; pi < t.meshes.length; pi++) {
        const im = t.meshes[pi];
        const tint = t.parts[pi].tint;
        const ma = im.instanceMatrix.array as Float32Array;
        const ca = im.instanceColor ? (im.instanceColor.array as Float32Array) : null;
        let n = 0;
        let main = 0;
        for (let pass = 1; pass <= 2; pass++) {
          if (pass === 2) { main = n; if (!casts) break; }
          for (let c = 0; c < nCells; c++) {
            if (cellState[c] !== pass) continue;
            for (let k = t.cellStart[c]; k < t.cellStart[c + 1]; k++) {
              if (!act[k]) continue;
              const pl = t.placements[k];
              ma.set(pl.m.elements, n * 16);
              if (ca) { const col = tint ? pl.c : white; ca[n * 3] = col.r; ca[n * 3 + 1] = col.g; ca[n * 3 + 2] = col.b; }
              n++;
            }
          }
        }
        if (!casts) main = n;
        t.mainCount = main;
        t.totalCount = n;
        im.count = main;
        im.visible = n > 0;
        im.instanceMatrix.clearUpdateRanges();
        im.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) {
          im.instanceColor.clearUpdateRanges();
          im.instanceColor.addUpdateRange(0, Math.max(1, n) * 3);
          im.instanceColor.needsUpdate = true;
        }
      }
    }
  }
  repack();

  return {
    group,
    setMask(hidden: Uint8Array, explored?: ArrayLike<number> | null) {
      const n = state.tiles.length;
      lastHidden = hidden.slice();
      lastExplored = explored ? Array.from(explored) : null;
      if (noCull) explored = null;
      if (explored) {
        for (let i = 0; i < n; i++) {
          let e = explored[i] ? 1 : 0;
          if (!e) {
            const h = indexToHex(i, W);
            for (const d of DIRS) {
              const nb = { q: h.q + d.q, r: h.r + d.r };
              if (inBounds(nb, W, state.height) && explored[tileIndex(nb, W)]) { e = 1; break; }
            }
          }
          near[i] = e;
        }
      } else near.fill(1);
      let key = '';
      for (let i = 0; i < n; i++) key += String.fromCharCode(48 + (hidden[i] ? 1 : 0) + (near[i] ? 2 : 0));
      if (key === lastMask) return;
      lastMask = key;
      const next = new Map<PropType, Uint8Array>();
      for (const t of types.values()) {
        const a = new Uint8Array(t.placements.length);
        for (let k = 0; k < t.placements.length; k++) { const ti = t.placements[k].tile; a[k] = !hidden[ti] && near[ti] ? 1 : 0; }
        next.set(t, a);
      }
      active = next;
      maskDirty = true;
    },
    cull(view: THREE.Frustum, sunDir: THREE.Vector3 | null, shadowView?: THREE.Frustum | null) {
      let key = '';
      for (let c = 0; c < nCells; c++) {
        const b = cellBox[c];
        let st = 0;
        if (b.isEmpty()) st = 0;
        else if (noCull) st = 1;
        else if (view.intersectsBox(b)) st = 1;
        else if (sunDir && sunDir.y > 0.05 && (!shadowView || shadowView.intersectsBox(b))) {
          // the cell's shadow volume: its box swept away from the sun down to the lowest ground
          const L = (b.max.y - (WATER_LEVEL - 0.3)) / Math.max(sunDir.y, 0.15);
          swept.copy(b);
          shift.copy(sunDir).multiplyScalar(-L);
          swept.expandByPoint(shift.add(b.min));
          shift.copy(sunDir).multiplyScalar(-L).add(b.max);
          swept.expandByPoint(shift);
          if (view.intersectsBox(swept)) st = 2;
        }
        cellState[c] = st;
        key += String.fromCharCode(48 + st);
      }
      if (key === lastCells && !maskDirty) return;
      lastCells = key;
      maskDirty = false;
      repack();
    },
    setDebugNoCull(on: boolean) {
      noCull = on;
      lastMask = '';
      this.setMask(lastHidden, lastExplored);
      for (const t of types.values()) for (const im of t.meshes) im.castShadow = on ? t.shadow !== 'never' || t.ao : t.shadow === 'always' || (t.shadow === 'high' && quality === 'high');
      maskDirty = true;
    },
    setQuality(q: 'low' | 'high') {
      if (q === quality) return;
      quality = q;
      for (const t of types.values()) for (const im of t.meshes) im.castShadow = t.shadow === 'always' || (t.shadow === 'high' && q === 'high');
      maskDirty = true;
    },
    dispose() {
      for (const t of types.values()) for (const im of t.meshes) im.dispose();
      for (const m of ownedMaterials) m.dispose();
      for (const g of ownedGeometries) g.dispose();
      // Procedural part geometries/materials of unused types.
      for (const t of types.values()) if (!t.meshes.length) for (const p of t.parts) { p.geometry.dispose(); p.material.dispose(); }
    },
  };
}
