// One continuous heightfield for the whole map (chunked for culling): heights and 8-way splat
// weights blended from per-hex values with domain warping (organic, non-hexagonal transitions);
// a MeshStandardMaterial patched with a height-blended texture-array splat, slope rock, peak snow,
// wet shores, caustics, hex-exact faction borders / grid lines and the fog-of-war mist.
import * as THREE from 'three';
import type { GameState, Hex, TerrainId } from '../core/types';
import { DIRS, hexToWorld, offsetToAxial, worldToHex, axialToOffset } from '../core/hex';
import { hash2 } from '../core/rng';
import { TERRAIN } from '../data/terrain';
import { fowDepthMaterial, patchFow, type FowUniforms, type WorldRect } from './fow';
import { LAYER_ROUGHNESS, LAYER_SCALE, TERRAIN_LAYERS, type WorldTextures } from './textures';

export const WATER_LEVEL = -0.13;
const SQRT3 = Math.sqrt(3);
const MARGIN = 6;            // world units of terrain beyond the map edge (melts into the haze)
const CHUNK = 96;            // quads per chunk side
const MIST_SKIRT_Y = -0.05;  // the skirt sits a little under the terrain where both overlap

// ───────────────────────────── JS noise (heights) ─────────────────────────────
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number, seed: number, oct: number, gain = 0.5): number {
  let s = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f + i * 17.3, y * f - i * 9.1, seed + i * 101);
    norm += amp; amp *= gain; f *= 2.03;
  }
  return s / norm;
}
function ridged(x: number, y: number, seed: number, oct: number): number {
  let s = 0, amp = 0.55, norm = 0, f = 1, prev = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise(x * f + i * 5.7, y * f + i * 3.3, seed + i * 77) * 2 - 1);
    n *= n;
    s += amp * n * prev;
    prev = Math.min(1, n * 1.6);
    norm += amp; amp *= 0.5; f *= 2.1;
  }
  return s / norm;
}

// ───────────────────────────── per-terrain parameters ─────────────────────────────
// Splat channels: 0 grass 1 plains 2 forest 3 hills | 4 rock 5 swamp 6 sand 7 crystal (snow & dirt are shader-driven)
const SPLAT: Record<TerrainId, number[]> = {
  grass:    [1, 0, 0, 0, 0, 0, 0, 0],
  plains:   [0, 1, 0, 0, 0, 0, 0, 0],
  forest:   [0.12, 0, 0.88, 0, 0, 0, 0, 0],
  hills:    [0.1, 0.05, 0, 0.85, 0, 0, 0, 0],
  mountain: [0, 0, 0, 0.12, 0.88, 0, 0, 0],
  swamp:    [0.08, 0, 0, 0, 0, 0.92, 0, 0],
  shallows: [0, 0, 0, 0, 0.1, 0.1, 0.8, 0],
  water:    [0, 0, 0, 0, 0.25, 0.35, 0.4, 0],
  crystal:  [0.22, 0, 0, 0, 0.08, 0, 0, 0.7],
  ruins:    [0.35, 0.4, 0, 0.25, 0, 0, 0, 0],
};
/** How much tile.elevation shifts the base height, per terrain. */
const ELEV_VAR: Record<TerrainId, number> = {
  grass: 0.07, plains: 0.07, forest: 0.08, hills: 0.16, mountain: 0.36, swamp: 0.03, shallows: 0.03, water: 0.06, crystal: 0.07, ruins: 0.06,
};
const FEAT = { flat: 0, forest: 1, hills: 2, mountain: 3, swamp: 4, water: 5 } as const;
const FEATURE_OF: Record<TerrainId, number> = {
  grass: FEAT.flat, plains: FEAT.flat, crystal: FEAT.flat, ruins: FEAT.flat, forest: FEAT.forest,
  hills: FEAT.hills, mountain: FEAT.mountain, swamp: FEAT.swamp, shallows: FEAT.water, water: FEAT.water,
};

function kernel(d: number, R: number): number {
  const t = Math.max(0, 1 - d / R);
  return t * t * (3 - 2 * t);
}

export interface Terrain {
  group: THREE.Group;
  rect: WorldRect;                 // extended world rect covered by the mesh
  mapRect: WorldRect;              // hex extents of the playable map
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** Water depth texture (R = depth below WATER_LEVEL / 0.45) + its world rect transform. */
  depthTex: THREE.DataTexture;
  depthRect: THREE.Vector4;
  material: THREE.MeshStandardMaterial;
  dispose(): void;
}

export function mapWorldRect(width: number, height: number): WorldRect {
  return { minX: -SQRT3 / 2, maxX: SQRT3 * width, minZ: -1, maxZ: 1.5 * (height - 1) + 1 };
}

/** The terrain's sampled fields (heights, splat weights): the costly part of building it. */
export interface TerrainField {
  readonly state: GameState;
  rect: WorldRect;
  mapRect: WorldRect;
  step: number;
  nx: number;
  nz: number;
  heights: Float32Array;
  splatA: Uint8Array;
  splatB: Uint8Array;
}

/** Rows of the field computed between two yields of terrainFieldSteps. */
const FIELD_ROWS_PER_STEP = 24;

/** Compute the field a few rows at a time (each `yield` is a point where the caller may pause). */
export function* terrainFieldSteps(state: GameState): Generator<void, TerrainField> {
  const W = state.width, H = state.height;
  const seed = (state.settings.seed | 0) ^ 0x5bd1e995;
  const mapRect = mapWorldRect(W, H);
  const rect: WorldRect = { minX: mapRect.minX - MARGIN, maxX: mapRect.maxX + MARGIN, minZ: mapRect.minZ - MARGIN, maxZ: mapRect.maxZ + MARGIN };

  // Grid spacing: 8 samples per hex edge, relaxed on very large maps to cap the vertex count.
  let step = 0.125;
  const area = (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ);
  if (area / (step * step) > 300000) step = Math.sqrt(area / 300000);
  const nx = Math.ceil((rect.maxX - rect.minX) / step) + 1;
  const nz = Math.ceil((rect.maxZ - rect.minZ) / step) + 1;

  // Per-tile base values.
  const nTiles = W * H;
  const tileH = new Float32Array(nTiles);
  const tileFeat = new Uint8Array(nTiles);
  const tileSplat = new Float32Array(nTiles * 8);
  const tileMount = new Float32Array(nTiles);
  for (let i = 0; i < nTiles; i++) {
    const t = state.tiles[i];
    const def = TERRAIN[t.terrain];
    // Mountains sit on a hill-height plinth; their peaks come from a separate smooth field below.
    tileH[i] = (t.terrain === 'mountain' ? 0.42 : def.height) + (t.elevation - 0.5) * ELEV_VAR[t.terrain] * 2;
    tileMount[i] = t.terrain === 'mountain' ? 0.62 + t.elevation * 0.45 : 0;
    tileFeat[i] = FEATURE_OF[t.terrain];
    const sp = SPLAT[t.terrain];
    for (let k = 0; k < 8; k++) tileSplat[i * 8 + k] = sp[k];
  }
  const tileOf = (q: number, r: number): number => {
    const o = axialToOffset({ q, r });
    const col = Math.min(W - 1, Math.max(0, o.col));
    const row = Math.min(H - 1, Math.max(0, o.row));
    return row * W + col;
  };

  const nv = nx * nz;
  const heights = new Float32Array(nv);
  const splatA = new Uint8Array(nv * 4);
  const splatB = new Uint8Array(nv * 4);
  const feat = new Float32Array(6);
  const sp = new Float32Array(8);

  for (let j = 0; j < nz; j++) {
    if (j > 0 && j % FIELD_ROWS_PER_STEP === 0) yield;
    const z = rect.minZ + j * step;
    for (let i = 0; i < nx; i++) {
      const x = rect.minX + i * step;
      const v = j * nx + i;

      // ── height: weights from a gently warped position ──
      const hwx = x + (vnoise(x * 0.42, z * 0.42, seed + 1) - 0.5) * 0.5;
      const hwz = z + (vnoise(x * 0.42, z * 0.42, seed + 2) - 0.5) * 0.5;
      let hc = worldToHex(hwx, hwz);
      let sumW = 0, base = 0, mount = 0;
      feat.fill(0);
      for (let k = -1; k < 6; k++) {
        const q = k < 0 ? hc.q : hc.q + DIRS[k].q;
        const r = k < 0 ? hc.r : hc.r + DIRS[k].r;
        const cx = SQRT3 * (q + r / 2), cz = 1.5 * r;
        const dist = Math.hypot(hwx - cx, hwz - cz);
        const ti = tileOf(q, r);
        // Massif: a broad cone per mountain hex; neighbouring cones merge into ridges.
        if (tileMount[ti] > 0) {
          const t = Math.max(0, 1 - dist / 1.62);
          mount += tileMount[ti] * t * t * (3 - 2 * t);
        }
        const w = kernel(dist, 1.25);
        if (w <= 0) continue;
        sumW += w;
        base += w * tileH[ti];
        feat[tileFeat[ti]] += w;
      }
      if (sumW <= 0) { sumW = 1; base = 0; feat[0] = 1; }
      base /= sumW;
      for (let k = 0; k < 6; k++) feat[k] /= sumW;
      let h = base;
      h += feat[FEAT.flat] * (fbm(x * 0.55, z * 0.55, seed + 3, 3) - 0.5) * 0.08;
      h += feat[FEAT.forest] * (fbm(x * 0.8, z * 0.8, seed + 4, 3) - 0.5) * 0.1;
      if (feat[FEAT.hills] > 0) h += feat[FEAT.hills] * ((fbm(x * 0.85, z * 0.85, seed + 5, 3) - 0.5) * 0.36 + 0.03);
      if (mount > 0) {
        const m = Math.min(1.25, mount);
        const rg = ridged(x * 0.95, z * 0.95, seed + 6, 4);
        h += Math.pow(m, 1.5) * (0.32 + rg * 1.3) + m * m * (fbm(x * 2.6, z * 2.6, seed + 7, 2) - 0.5) * 0.24;
      }
      if (feat[FEAT.mountain] > 0) h += feat[FEAT.mountain] * (fbm(x * 1.3, z * 1.3, seed + 14, 3) - 0.5) * 0.18;
      h += feat[FEAT.swamp] * (fbm(x * 1.7, z * 1.7, seed + 8, 2) - 0.5) * 0.05;
      h += feat[FEAT.water] * (fbm(x * 0.7, z * 0.7, seed + 9, 3) - 0.5) * 0.1;
      heights[v] = h;

      // ── splat: stronger warp + wider kernel → organic biome edges ──
      const swx = x + (fbm(x * 0.33, z * 0.33, seed + 11, 2) - 0.5) * 1.1;
      const swz = z + (fbm(x * 0.33, z * 0.33, seed + 12, 2) - 0.5) * 1.1;
      hc = worldToHex(swx, swz);
      let sw = 0;
      sp.fill(0);
      for (let k = -1; k < 6; k++) {
        const q = k < 0 ? hc.q : hc.q + DIRS[k].q;
        const r = k < 0 ? hc.r : hc.r + DIRS[k].r;
        const cx = SQRT3 * (q + r / 2), cz = 1.5 * r;
        const w = kernel(Math.hypot(swx - cx, swz - cz), 1.45);
        if (w <= 0) continue;
        const ti = tileOf(q, r);
        sw += w;
        for (let c = 0; c < 8; c++) sp[c] += w * tileSplat[ti * 8 + c];
      }
      if (sw <= 0) { sw = 1; sp[0] = 1; }
      // Large-scale variety: dry patches inside grassland, mossy patches inside plains.
      const macro = fbm(x * 0.16, z * 0.16, seed + 13, 2);
      const g2p = sp[0] * 0.45 * Math.max(0, Math.min(1, (macro - 0.6) / 0.18));
      const p2g = sp[1] * 0.35 * Math.max(0, Math.min(1, (0.4 - macro) / 0.18));
      sp[0] += p2g - g2p;
      sp[1] += g2p - p2g;
      for (let c = 0; c < 4; c++) splatA[v * 4 + c] = Math.round((sp[c] / sw) * 255);
      for (let c = 0; c < 4; c++) splatB[v * 4 + c] = Math.round((sp[c + 4] / sw) * 255);
    }
  }

  return { state, rect, mapRect, step, nx, nz, heights, splatA, splatB };
}

/** The whole field at once. */
export function terrainField(state: GameState): TerrainField {
  const it = terrainFieldSteps(state);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** `field`: precomputed for this very state (see terrainFieldSteps); computed here otherwise. */
export function buildTerrain(state: GameState, tex: WorldTextures, uniforms: FowUniforms, field?: TerrainField | null): Terrain {
  const f = field && field.state === state ? field : terrainField(state);
  const { rect, mapRect, step, nx, nz, heights, splatA, splatB } = f;
  const nv = nx * nz;

  // Normals by central differences.
  const normals = new Float32Array(nv * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const hl = heights[j * nx + Math.max(0, i - 1)];
      const hr = heights[j * nx + Math.min(nx - 1, i + 1)];
      const hd = heights[Math.max(0, j - 1) * nx + i];
      const hu = heights[Math.min(nz - 1, j + 1) * nx + i];
      let ax = hl - hr, ay = 2 * step, az = hd - hu;
      const l = Math.hypot(ax, ay, az);
      ax /= l; ay /= l; az /= l;
      const k = (j * nx + i) * 3;
      normals[k] = ax; normals[k + 1] = ay; normals[k + 2] = az;
    }
  }

  // Water depth texture (same grid).
  const depth = new Uint8Array(nv * 4);
  for (let v = 0; v < nv; v++) {
    const d = Math.max(0, Math.min(1, (WATER_LEVEL - heights[v]) / 0.45));
    depth[v * 4] = Math.round(d * 255);
    depth[v * 4 + 3] = 255;
  }
  const depthTex = new THREE.DataTexture(depth, nx, nz, THREE.RGBAFormat, THREE.UnsignedByteType);
  depthTex.minFilter = depthTex.magFilter = THREE.LinearFilter;
  depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
  depthTex.generateMipmaps = false;
  depthTex.colorSpace = THREE.NoColorSpace;
  depthTex.needsUpdate = true;
  const depthRect = new THREE.Vector4(rect.minX - step / 2, rect.minZ - step / 2, 1 / (nx * step), 1 / (nz * step));

  // ── material ──
  const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  const terrainUniforms = {
    uAlbedoArr: { value: tex.albedo },
    uNormalArr: { value: tex.normal },
    uLayerScale: { value: LAYER_SCALE.slice(0, TERRAIN_LAYERS.length) },
    uLayerRough: { value: LAYER_ROUGHNESS.slice(0, TERRAIN_LAYERS.length) },
    uWaterLevel: { value: WATER_LEVEL },
    uTerrainDebug: { value: 0 },
  };
  material.userData.debug = terrainUniforms.uTerrainDebug; // dev views: 1 albedo, 2 normal, 3 swamp weight
  patchFow(material, uniforms, { mode: 'flatten' }, (shader) => {
    Object.assign(shader.uniforms, terrainUniforms);
    shader.vertexShader = shader.vertexShader
      // The horizon skirt (all-zero splat) stays a hair below the real terrain's mist.
      .replace('#include <common>', `#define FOW_MIST_OFFSET (dot(splatA + splatB, vec4(1.0)) < 0.01 ? -0.04 : 0.0)
#include <common>
attribute vec4 splatA;
attribute vec4 splatB;
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec3 vTerrN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vSplatA = splatA;
vSplatB = splatB;
vTerrN = objectNormal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${TERRAIN_FRAG_PARS}`)
      .replace('#include <map_fragment>', TERRAIN_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tWorldN, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += tEmissive;')
      .replace('#include <opaque_fragment>', `{
  float lum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
  vec3 fogged = mix(vec3(lum), outgoingLight, 0.28) * vec3(0.40, 0.43, 0.50);
  outgoingLight = mix(outgoingLight, fogged, (1.0 - tVis) * tExp);
  if (uTerrainDebug > 0.5) {
    if (uTerrainDebug < 1.5) outgoingLight = diffuseColor.rgb;
    else if (uTerrainDebug < 2.5) outgoingLight = tWorldN * 0.5 + 0.5;
    else outgoingLight = vec3(vSplatB.y, w[5], swampP);
  }
}
#include <opaque_fragment>`);
  }, 'terrain');
  const depthMat = fowDepthMaterial(uniforms, 'flatten');

  // ── chunked geometry ──
  const group = new THREE.Group();
  group.name = 'terrain';
  for (let cj = 0; cj < nz - 1; cj += CHUNK) {
    for (let ci = 0; ci < nx - 1; ci += CHUNK) {
      const i1 = Math.min(nx - 1, ci + CHUNK), j1 = Math.min(nz - 1, cj + CHUNK);
      const cw = i1 - ci + 1, ch = j1 - cj + 1;
      const pos = new Float32Array(cw * ch * 3);
      const nrm = new Float32Array(cw * ch * 3);
      const sa = new Uint8Array(cw * ch * 4);
      const sb = new Uint8Array(cw * ch * 4);
      let minY = Infinity, maxY = -Infinity;
      for (let j = 0; j < ch; j++) {
        for (let i = 0; i < cw; i++) {
          const gv = (cj + j) * nx + (ci + i);
          const lv = j * cw + i;
          const y = heights[gv];
          pos[lv * 3] = rect.minX + (ci + i) * step;
          pos[lv * 3 + 1] = y;
          pos[lv * 3 + 2] = rect.minZ + (cj + j) * step;
          nrm[lv * 3] = normals[gv * 3]; nrm[lv * 3 + 1] = normals[gv * 3 + 1]; nrm[lv * 3 + 2] = normals[gv * 3 + 2];
          for (let c = 0; c < 4; c++) { sa[lv * 4 + c] = splatA[gv * 4 + c]; sb[lv * 4 + c] = splatB[gv * 4 + c]; }
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const idx = new Uint32Array((cw - 1) * (ch - 1) * 6);
      let k = 0;
      for (let j = 0; j < ch - 1; j++) {
        for (let i = 0; i < cw - 1; i++) {
          const a = j * cw + i, b = a + 1, d = a + cw, c = d + 1;
          idx[k++] = a; idx[k++] = d; idx[k++] = c;
          idx[k++] = a; idx[k++] = c; idx[k++] = b;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('splatA', new THREE.BufferAttribute(sa, 4, true));
      g.setAttribute('splatB', new THREE.BufferAttribute(sb, 4, true));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      // Bounds must include the mist sheet the vertex shader may flatten this chunk into.
      const box = new THREE.Box3(
        new THREE.Vector3(pos[0], Math.min(minY, -0.3), pos[2]),
        new THREE.Vector3(pos[(cw * ch - 1) * 3], Math.max(maxY, 0.9), pos[(cw * ch - 1) * 3 + 2]),
      );
      g.boundingBox = box;
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.customDepthMaterial = depthMat;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.terrain = true;
      group.add(mesh);
    }
  }

  // Mist skirt: a coarse plane reaching the horizon with the same material. Everything outside
  // the map is unexplored, so the vertex shader turns it into the same drifting cloud sheet and
  // the board edge disappears into the clouds.
  {
    const R = 200, cell = 4;
    const cx = (rect.minX + rect.maxX) / 2, cz = (rect.minZ + rect.maxZ) / 2;
    const n = Math.ceil((2 * R) / cell);
    const g = new THREE.PlaneGeometry(2 * R, 2 * R, n, n);
    g.rotateX(-Math.PI / 2);
    g.translate(cx, MIST_SKIRT_Y, cz);
    // Cut a hole under the terrain rectangle (keeping one cell of overlap).
    {
      const pa = g.attributes.position;
      const src = g.index!.array;
      const keep: number[] = [];
      const ix0 = rect.minX + cell, ix1 = rect.maxX - cell, iz0 = rect.minZ + cell, iz1 = rect.maxZ - cell;
      for (let k = 0; k < src.length; k += 3) {
        const a = src[k], b = src[k + 1], c = src[k + 2];
        const mx = (pa.getX(a) + pa.getX(b) + pa.getX(c)) / 3, mz = (pa.getZ(a) + pa.getZ(b) + pa.getZ(c)) / 3;
        if (mx > ix0 && mx < ix1 && mz > iz0 && mz < iz1) continue;
        keep.push(a, b, c);
      }
      g.setIndex(keep);
    }
    const vc = g.attributes.position.count;
    g.setAttribute('splatA', new THREE.BufferAttribute(new Uint8Array(vc * 4), 4, true));
    g.setAttribute('splatB', new THREE.BufferAttribute(new Uint8Array(vc * 4), 4, true));
    g.deleteAttribute('uv');
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), R * 1.5);
    const skirt = new THREE.Mesh(g, material);
    skirt.name = 'mist-skirt';
    skirt.receiveShadow = true;
    skirt.castShadow = false;
    skirt.renderOrder = -1;
    skirt.matrixAutoUpdate = false;
    skirt.updateMatrix();
    group.add(skirt);
  }

  const heightAt = (x: number, z: number): number => {
    let gx = (x - rect.minX) / step, gz = (z - rect.minZ) / step;
    gx = Math.min(nx - 1.0001, Math.max(0, gx));
    gz = Math.min(nz - 1.0001, Math.max(0, gz));
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const a = heights[j * nx + i], b = heights[j * nx + i + 1];
    const d = heights[(j + 1) * nx + i], c = heights[(j + 1) * nx + i + 1];
    // Same triangulation as the mesh (diagonal a–c).
    return fz >= fx ? a + fx * (c - d) + fz * (d - a) : a + fx * (b - a) + fz * (c - b);
  };
  const normalAt = (x: number, z: number, out: THREE.Vector3): THREE.Vector3 => {
    const gx = Math.min(nx - 1, Math.max(0, Math.round((x - rect.minX) / step)));
    const gz = Math.min(nz - 1, Math.max(0, Math.round((z - rect.minZ) / step)));
    const k = (gz * nx + gx) * 3;
    return out.set(normals[k], normals[k + 1], normals[k + 2]);
  };

  return {
    group, rect, mapRect, heightAt, normalAt, depthTex, depthRect, material,
    dispose() {
      for (const c of group.children) (c as THREE.Mesh).geometry.dispose();
      material.dispose();
      depthMat.dispose();
      depthTex.dispose();
    },
  };
}

/**
 * March a ray against a height function. Returns the hit point or null. `maxT` bounds the search.
 */
export function marchRay(origin: THREE.Vector3, dir: THREE.Vector3, height: (x: number, z: number) => number, maxT = 400): THREE.Vector3 | null {
  // Start where the ray enters the band of possible heights.
  const TOP = 2.6, BOTTOM = -0.8;
  let t0 = 0;
  if (origin.y > TOP) {
    if (dir.y >= 0) return null;
    t0 = (TOP - origin.y) / dir.y;
  }
  let tEnd = maxT;
  if (dir.y < 0) tEnd = Math.min(tEnd, (BOTTOM - origin.y) / dir.y);
  const p = new THREE.Vector3();
  let prevT = t0;
  // Fine steps near the camera band, never more than ~4000 samples for grazing rays.
  const dt = Math.max(0.04, (tEnd - t0) / 4000);
  for (let t = t0; t <= tEnd; t += dt) {
    p.copy(origin).addScaledVector(dir, t);
    if (p.y <= height(p.x, p.z)) {
      // refine between prevT and t
      let lo = prevT, hi = t;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        p.copy(origin).addScaledVector(dir, mid);
        if (p.y <= height(p.x, p.z)) hi = mid; else lo = mid;
      }
      return p.copy(origin).addScaledVector(dir, hi);
    }
    prevT = t;
  }
  return null;
}

/** Offset tile index → axial hex helper re-export for callers. */
export function tileHex(i: number, width: number): Hex { return offsetToAxial(i % width, Math.floor(i / width)); }
export { hexToWorld };

// ───────────────────────────── terrain GLSL ─────────────────────────────
const TERRAIN_FRAG_PARS = /* glsl */`
uniform sampler2DArray uAlbedoArr;
uniform sampler2DArray uNormalArr;
uniform float uLayerScale[10];
uniform float uLayerRough[10];
uniform float uWaterLevel;
uniform sampler2D uTileTex;
uniform vec2 uMapSize;
uniform vec3 uFactionColors[5];
uniform float uGrid;
uniform vec3 uHoverHex;
uniform float uTerrainDebug;
varying vec4 vSplatA;
varying vec4 vSplatB;
varying vec3 vTerrN;

const vec2 EDGE_N[6] = vec2[6](vec2(1.0, 0.0), vec2(0.5, -0.8660254), vec2(-0.5, -0.8660254),
                               vec2(-1.0, 0.0), vec2(-0.5, 0.8660254), vec2(0.5, 0.8660254));
const ivec2 HEX_DIR[6] = ivec2[6](ivec2(1, 0), ivec2(1, -1), ivec2(0, -1), ivec2(-1, 0), ivec2(-1, 1), ivec2(0, 1));

ivec2 hexRoundI(float qf, float rf) {
  float sf = -qf - rf;
  float q = floor(qf + 0.5), r = floor(rf + 0.5), s = floor(sf + 0.5);
  float dq = abs(q - qf), dr = abs(r - rf), ds = abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return ivec2(int(q), int(r));
}
int tileOwner(ivec2 ax) {
  int col = ax.x + (ax.y - (ax.y & 1)) / 2;
  int row = ax.y;
  if (col < 0 || row < 0 || col >= int(uMapSize.x) || row >= int(uMapSize.y)) return 0;
  return int(texelFetch(uTileTex, ivec2(col, row), 0).r * 255.0 + 0.5);
}
`;

const TERRAIN_FRAG_MAIN = /* glsl */`
vec3 wp = vFowWorld;
vec4 fw = fowAt(wp.xz);
float tExp = smoothstep(0.08, 0.92, fw.g);
float tVis = smoothstep(0.15, 0.85, fw.r);
vec3 Ng = normalize(vTerrN);
float slope = 1.0 - Ng.y;
vec3 T = normalize(vec3(1.0, 0.0, 0.0) - Ng * Ng.x);
vec3 B = cross(T, Ng);
vec4 nzM = textureLod(uNoiseTex, wp.xz * 0.031, 0.0);
vec4 nzD = texture(uNoiseTex, wp.xz * 0.23);

float w[10];
w[0] = vSplatA.x; w[1] = vSplatA.y; w[2] = vSplatA.z; w[3] = vSplatA.w;
w[4] = vSplatB.x; w[5] = vSplatB.y; w[6] = vSplatB.z; w[7] = vSplatB.w; w[8] = 0.0; w[9] = 0.0;
float rockS = smoothstep(0.30, 0.55, slope + (nzD.r - 0.5) * 0.18);
float snowS = smoothstep(1.40, 1.62, wp.y + (nzD.g - 0.5) * 0.4) * (1.0 - smoothstep(0.48, 0.72, slope));
float shoreS = (1.0 - smoothstep(uWaterLevel + 0.02, uWaterLevel + 0.07 + nzD.b * 0.05, wp.y)) * (1.0 - rockS) * 0.85 * (1.0 - smoothstep(0.2, 0.6, vSplatB.y));
float dirtS = smoothstep(0.38, 0.72, fw.b + (nzD.r - 0.5) * 0.55 + (nzM.a - 0.5) * 0.35);
// High ground turns alpine: neighbouring lowland layers must not bleed onto summits.
float alpineS = smoothstep(0.72, 1.05, wp.y + (nzD.g - 0.5) * 0.25);
for (int i = 0; i < 8; i++) if (i != 4 && i != 3) w[i] *= (1.0 - alpineS);
w[4] += alpineS * 0.75 * (vSplatA.x + vSplatA.y + vSplatA.z + vSplatB.y + vSplatB.z + vSplatB.w);
w[3] += alpineS * 0.25 * (vSplatA.x + vSplatA.y + vSplatA.z + vSplatB.y + vSplatB.z + vSplatB.w);
for (int i = 0; i < 8; i++) w[i] *= (1.0 - rockS);
w[4] += rockS;
for (int i = 0; i < 10; i++) w[i] *= (1.0 - snowS);
w[8] += snowS;
for (int i = 0; i < 10; i++) w[i] *= (1.0 - shoreS);
w[6] += shoreS;
for (int i = 0; i < 10; i++) w[i] *= (1.0 - dirtS);
w[9] += dirtS;

// Anti-tiling: a second, rotated and rescaled sample blended in by low-frequency noise.
float atB = smoothstep(0.38, 0.62, nzM.g);
const mat2 ROT = mat2(0.4536, 0.8912, -0.8912, 0.4536);
vec4 alb[10];
vec3 nrm[10];
float hv[10];
float mx = -10.0;
// Gradients computed in uniform control flow; the per-layer branch below uses textureGrad.
vec3 dpx3 = dFdx(wp), dpy3 = dFdy(wp);
vec2 dpx = dpx3.xz, dpy = dpy3.xz;
for (int i = 0; i < 10; i++) {
  hv[i] = -10.0;
  alb[i] = vec4(0.0);
  nrm[i] = vec3(0.0, 0.0, 1.0);
  if (w[i] > 0.012) {
    float invS = 1.0 / uLayerScale[i];
    vec2 uv1 = wp.xz * invS;
    vec2 uv2 = ROT * uv1 * 0.73 + vec2(0.37, 0.71);
    vec2 g1x = dpx * invS, g1y = dpy * invS;
    vec2 g2x = ROT * g1x * 0.73, g2y = ROT * g1y * 0.73;
    vec4 a1 = textureGrad(uAlbedoArr, vec3(uv1, float(i)), g1x, g1y);
    vec4 a2 = textureGrad(uAlbedoArr, vec3(uv2, float(i)), g2x, g2y);
    vec3 n1 = textureGrad(uNormalArr, vec3(uv1, float(i)), g1x, g1y).xyz * 2.0 - 1.0;
    vec3 n2 = textureGrad(uNormalArr, vec3(uv2, float(i)), g2x, g2y).xyz * 2.0 - 1.0;
    n2.xy = n2.xy * ROT;
    alb[i] = mix(a1, a2, atB);
    nrm[i] = mix(n1, n2, atB);
    if (i == 4 && slope > 0.18) {
      // Cliffs: blend in side projections (UDN triplanar) so rock is not stretched vertically.
      float side = smoothstep(0.18, 0.5, slope);
      vec2 uvx = wp.zy * invS, uvz = wp.xy * invS;
      vec2 gxx = dpx3.zy * invS, gxy = dpy3.zy * invS, gzx = dpx3.xy * invS, gzy = dpy3.xy * invS;
      vec4 ax = textureGrad(uAlbedoArr, vec3(uvx, 4.0), gxx, gxy);
      vec4 az = textureGrad(uAlbedoArr, vec3(uvz, 4.0), gzx, gzy);
      vec3 tnx = textureGrad(uNormalArr, vec3(uvx, 4.0), gxx, gxy).xyz * 2.0 - 1.0;
      vec3 tnz = textureGrad(uNormalArr, vec3(uvz, 4.0), gzx, gzy).xyz * 2.0 - 1.0;
      vec2 bw = abs(Ng.xz) / max(abs(Ng.x) + abs(Ng.z), 1e-4);
      vec3 sideW = normalize((vec3(0.0, tnx.y, tnx.x) + Ng) * bw.x + (vec3(tnz.x, tnz.y, 0.0) + Ng) * bw.y);
      alb[i] = mix(alb[i], ax * bw.x + az * bw.y, side);
      nrm[i] = mix(nrm[i], vec3(dot(sideW, T), dot(sideW, B), dot(sideW, Ng)), side);
    }
    hv[i] = alb[i].a * 0.55 + w[i];
    mx = max(mx, hv[i]);
  }
}
// Height-based blending: taller texels (stones, shards) poke through softer layers.
vec3 accC = vec3(0.0);
vec3 accN = vec3(0.0);
float accR = 0.0, accW = 0.0, glowW = 0.0, swampP = 0.0;
for (int i = 0; i < 10; i++) {
  float b = max(hv[i] - (mx - 0.2), 0.0);
  accC += alb[i].rgb * b;
  accN += nrm[i] * b;
  accR += uLayerRough[i] * b;
  accW += b;
  if (i == 7) glowW = b * smoothstep(0.84, 0.97, alb[7].a);
  if (i == 5) swampP = b * smoothstep(0.24, 0.08, alb[5].a);
}
accW = max(accW, 1e-4);
vec3 col = accC / accW;
vec3 tn = normalize(accN / accW);
float tRough = accR / accW;
vec3 tEmissive = vec3(0.0);
// Swamp puddles: standing water — glossy, flat, slightly darker (they mirror the sky).
swampP /= accW;
tRough = mix(tRough, 0.07, swampP);
tn = normalize(mix(tn, vec3(0.0, 0.0, 1.0), swampP));
col = mix(col, col * 0.75 + vec3(0.006, 0.01, 0.014), swampP);

// Macro + mid-frequency colour variation breaks up repetition and large flat biomes.
vec4 nzMid = texture(uNoiseTex, wp.xz * 0.085 + 0.37);
col *= (0.84 + 0.32 * nzM.r) * (0.88 + 0.24 * nzMid.r);
col = mix(col, col * vec3(1.08, 1.0, 0.86), smoothstep(0.55, 0.85, nzM.b) * 0.45);
float veg = clamp(w[0] + w[1] + w[2] + w[3], 0.0, 1.0);
col = mix(col, col * vec3(1.1, 1.03, 0.72), smoothstep(0.52, 0.8, nzMid.g) * 0.4 * veg);   // dry patches
col = mix(col, col * vec3(0.86, 1.02, 0.9), smoothstep(0.55, 0.85, 1.0 - nzMid.g) * 0.3 * veg); // lush patches

// Wet shores, underwater tint and caustics.
float wet = (1.0 - smoothstep(uWaterLevel - 0.02, uWaterLevel + 0.07, wp.y)) * (1.0 - 0.6 * vSplatB.y);
col *= mix(1.0, 0.6, wet);
tRough = mix(tRough, 0.3, wet);
float under = clamp((uWaterLevel - wp.y) / 0.32, 0.0, 1.0);
col = mix(col, col * vec3(0.5, 0.72, 0.76), under);
{
  float c1 = texture(uNoiseTex, wp.xz * 0.33 + vec2(uTime * 0.021, uTime * 0.013)).b;
  float c2 = texture(uNoiseTex, wp.xz * 0.39 - vec2(uTime * 0.017, -uTime * 0.019)).b;
  float caus = pow(clamp(1.0 - abs(c1 - c2) * 5.0, 0.0, 1.0), 5.0);
  col *= 1.0 + caus * 0.9 * (1.0 - under * 0.7) * step(wp.y, uWaterLevel);
}

// Crystal shards glow (picked up by bloom).
tEmissive += vec3(0.55, 0.32, 1.0) * glowW / accW * (2.4 + 0.8 * sin(uTime * 1.8 + wp.x * 0.9 + wp.z * 1.3));

// World-space normal from the tangent-space blend (T = +X, B = +Z projected on the surface).
vec3 terrN = normalize(T * tn.x + B * tn.y + Ng * tn.z);

// Hex-exact borders and grid lines.
{
  vec2 p = wp.xz;
  ivec2 ax = hexRoundI(0.57735027 * p.x - 0.33333333 * p.y, 0.66666667 * p.y);
  vec2 c = vec2(1.7320508 * (float(ax.x) + float(ax.y) * 0.5), 1.5 * float(ax.y));
  vec2 lp = p - c;
  int own = tileOwner(ax);
  float gridD = 1.0, core = 0.0, glow = 0.0;
  for (int k = 0; k < 6; k++) {
    float d = 0.8660254 - dot(lp, EDGE_N[k]);
    gridD = min(gridD, d);
    if (own > 0 && d < 0.45) {
      int nOwn = tileOwner(ax + HEX_DIR[k]);
      if (nOwn != own) {
        core = max(core, 1.0 - smoothstep(0.022, 0.05, d));
        glow = max(glow, exp(-d * 8.0) * (1.0 - smoothstep(0.3, 0.45, d)));
      }
    }
  }
  float aa = max(fwidth(gridD) * 1.3, 0.004);
  float gridLine = 1.0 - smoothstep(0.008, 0.008 + aa, gridD);
  float gridHalo = (1.0 - smoothstep(0.0, 0.05, gridD)) * 0.35;
  // dark core with a faint light rim reads on both dark grass and pale rock/snow
  col = mix(col, col * 1.35 + vec3(0.03, 0.028, 0.02), gridHalo * uGrid * tExp);
  col = mix(col, col * 0.35, gridLine * uGrid * tExp * 0.85);
  if (own > 0) {
    vec3 bc = uFactionColors[own];
    float pulse = 0.88 + 0.12 * sin(uTime * 1.6);
    col = mix(col, bc, (glow * 0.28 + core * 0.65) * tExp);
    tEmissive += bc * (core * 1.7 + glow * 0.32 * pulse) * (0.45 + 0.55 * tVis) * tExp;
  }
  // Hovered hex: a thin outline exactly on the surface, ≈2 px wide at any slope or zoom.
  if (uHoverHex.z > 0.001 && ax == ivec2(floor(uHoverHex.xy + 0.5))) {
    float px = max(fwidth(gridD), 1e-4);
    float line = 1.0 - smoothstep(1.2 * px, 2.4 * px, gridD);
    float inner = (1.0 - smoothstep(0.0, 0.22, gridD)) * 0.10 + 0.04;
    col = mix(col, vec3(1.0, 0.97, 0.9), (line * 0.75 + inner) * uHoverHex.z * tExp);
    tEmissive += vec3(1.0, 0.95, 0.85) * line * 0.25 * uHoverHex.z * tExp;
  }
}

// Unexplored: drifting dark mist (geometry is flattened in the vertex shader).
float mN = texture(uNoiseTex, wp.xz * 0.05 + vec2(uTime * 0.006, uTime * 0.004)).r * 0.6
         + texture(uNoiseTex, wp.xz * 0.13 - vec2(uTime * 0.008, -uTime * 0.005)).g * 0.4;
float rim = tExp * (1.0 - tExp) * 4.0;
vec3 mistC = mix(vec3(0.008, 0.009, 0.014), vec3(0.042, 0.046, 0.06), smoothstep(0.3, 0.78, mN)) + rim * vec3(0.03, 0.034, 0.042);
float me = 0.3;
float mhx = mistHeight(wp.xz + vec2(me, 0.0)) - mistHeight(wp.xz - vec2(me, 0.0));
float mhz = mistHeight(wp.xz + vec2(0.0, me)) - mistHeight(wp.xz - vec2(0.0, me));
vec3 mistN = normalize(vec3(-mhx, 2.0 * me, -mhz));
col = mix(mistC, col, tExp);
tRough = mix(1.0, tRough, tExp);
tEmissive = mix(mistC * 0.22, tEmissive, tExp);
vec3 tWorldN = normalize(mix(mistN, terrN, tExp));
diffuseColor.rgb = col;
`;
