// Fog of war for the world renderer.
//  * A world-space RGBA mask (4 texels / world unit, blurred) sampled by every world shader:
//      R = currently visible, G = explored, B = "dirt" (known building / ruins ground patch),
//      A = occupied by a unit the viewer can see (tall props there bow out of the way).
//    Two copies (prev/next) are cross-faded so reveals dissolve smoothly instead of popping.
//  * A per-tile texture (W×H, nearest) with the territory owner + explored flag, used by the
//    terrain shader for hex-exact faction borders and grid lines.
//  * `patchFow()` injects the shared GLSL into built-in materials: unexplored geometry is
//    flattened into a drifting mist sheet (terrain) or shrunk away (decorations), and
//    explored-but-not-visible fragments are desaturated and darkened.
import * as THREE from 'three';
import type { FactionId, GameState } from '../core/types';
import { worldToHex, inBounds, tileIndex, hexToWorld } from '../core/hex';
import { FACTIONS } from '../data/factions';

export const MIST_LEVEL = 0.34;
const TEXELS_PER_UNIT = 4;
const FADE_SECONDS = 0.9;

export interface WorldRect { minX: number; minZ: number; maxX: number; maxZ: number }

export interface FowUniforms {
  uFowPrev: { value: THREE.Texture | null };
  uFowNext: { value: THREE.Texture | null };
  uFowBlend: { value: number };
  uFowRect: { value: THREE.Vector4 };
  uNoiseTex: { value: THREE.Texture | null };
  uTime: { value: number };
  uMistLevel: { value: number };
  uTileTex: { value: THREE.Texture | null };
  uMapSize: { value: THREE.Vector2 };
  uFactionColors: { value: THREE.Color[] };
  uGrid: { value: number };
  uMapRect: { value: THREE.Vector4 };
  uFogColor: { value: THREE.Color };
  /** Hovered hex outline drawn by the terrain shader: x, y = axial q, r; z = strength 0..1. */
  uHoverHex: { value: THREE.Vector3 };
  [key: string]: { value: unknown };
}

/** Faction → code stored in the tile texture (0 = nobody). */
export const FACTION_CODE: Record<FactionId, number> = { valen: 1, thorn: 2, ashen: 3, neutral: 4 };

export function createFowUniforms(): FowUniforms {
  const colors = [new THREE.Color(0, 0, 0)];
  for (const f of ['valen', 'thorn', 'ashen', 'neutral'] as FactionId[]) colors.push(new THREE.Color(FACTIONS[f].color));
  return {
    uFowPrev: { value: null },
    uFowNext: { value: null },
    uFowBlend: { value: 1 },
    uFowRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uNoiseTex: { value: null },
    uTime: { value: 0 },
    uMistLevel: { value: MIST_LEVEL },
    uTileTex: { value: null },
    uMapSize: { value: new THREE.Vector2(1, 1) },
    uFactionColors: { value: colors },
    uGrid: { value: 0 },
    uMapRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uFogColor: { value: new THREE.Color(0.5, 0.55, 0.6) },
    uHoverHex: { value: new THREE.Vector3(0, 0, 0) },
  };
}

// ───────────────────────────── shared GLSL ─────────────────────────────
export const FOW_PARS = /* glsl */`
uniform sampler2D uFowPrev;
uniform sampler2D uFowNext;
uniform float uFowBlend;
uniform vec4 uFowRect;
uniform sampler2D uNoiseTex;
uniform float uTime;
uniform float uMistLevel;
uniform vec4 uMapRect;
uniform vec3 uFogColor;

vec4 fowRaw(vec2 xz) {
  vec2 uv = (xz - uFowRect.xy) * uFowRect.zw;
  return mix(textureLod(uFowPrev, uv, 0.0), textureLod(uFowNext, uv, 0.0), uFowBlend);
}
// Domain-warped lookup so fog edges look like soft clouds, not hexagons.
vec2 fowWarp(vec2 xz) {
  vec2 n = textureLod(uNoiseTex, xz * 0.061 + vec2(uTime * 0.0015, 0.0), 0.0).rg - 0.5;
  return xz + n * 0.75;
}
vec4 fowAt(vec2 xz) { return fowRaw(fowWarp(xz)); }
float fowExplored(vec2 xz) { return smoothstep(0.08, 0.92, fowAt(xz).g); }
// Height of the drifting mist sheet that covers unexplored land.
float mistHeight(vec2 xz) {
  float a = textureLod(uNoiseTex, xz * 0.043 + vec2(uTime * 0.0042, uTime * 0.0021), 0.0).r;
  float b = textureLod(uNoiseTex, xz * 0.097 - vec2(uTime * 0.0055, -uTime * 0.0031), 0.0).g;
  return uMistLevel + (a * 0.65 + b * 0.35 - 0.5) * 0.55;
}
vec3 fowTint(vec3 col, vec3 wp) {
  vec4 s = fowAt(wp.xz);
  float vis = smoothstep(0.15, 0.85, s.r);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 fogged = mix(vec3(lum), col, 0.28) * vec3(0.40, 0.43, 0.50);
  return mix(fogged, col, vis);
}
// 0 inside the map, → 1 a few units outside it (used to melt the board edge into the haze).
float outsideMap(vec2 xz) {
  vec2 d = max(uMapRect.xy - xz, xz - uMapRect.zw);
  return smoothstep(0.5, 4.5, max(d.x, d.y));
}
`;

export type FowMode = 'flatten' | 'shrink' | 'none';

export interface FowPatchOpts {
  mode: FowMode;
  /** Apply the explored-not-visible desaturation in the fragment shader (lit materials only). */
  tint?: boolean;
  /** Wind sway amplitude (props: grass, trees). 0 = none. */
  wind?: number;
  /** Shrink factor applied on tiles occupied by a visible unit (tall props). */
  occShrink?: number;
  /** Emissive pulse (crystals). */
  pulse?: boolean;
  /** Fade toward the haze colour outside the map. */
  edgeFade?: boolean;
  /**
   * Screen-space AO pre-pass override material: instanced meshes (decorations) collapse like their
   * colour pass ('shrink'), everything else flattens into the mist with its normals turned to the
   * mist surface, so nothing under the fog of war leaves an occlusion footprint.
   */
  ao?: boolean;
}

function shrinkBlock(): string {
  return /* glsl */`
  {
    #ifdef USE_INSTANCING
      vec3 fowOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #else
      vec3 fowOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    float fowE = smoothstep(0.3, 0.85, fowRaw(fowWarp(fowOrigin.xz)).g);
    float fowOcc = 1.0 - uOccShrink * smoothstep(0.35, 0.8, fowRaw(fowOrigin.xz).a);
    float fowH = max(transformed.y, 0.0);
    float fowPhase = fowOrigin.x * 0.83 + fowOrigin.z * 0.61;
    vec2 fowGust = vec2(sin(uTime * 1.7 + fowPhase) + 0.4 * sin(uTime * 3.1 + fowPhase * 1.7),
                        cos(uTime * 1.3 + fowPhase * 1.3)) * uWind * fowH * fowH;
    fowWorld.xz += fowGust;
    fowWorld.xyz = fowOrigin + (fowWorld.xyz - fowOrigin) * fowE * fowOcc;
    fowWorld.y -= (1.0 - fowE) * 0.4;
  }
`;
}

/** GLSL replacing `#include <project_vertex>`; declares `fowWorld` (world position after fog effects). */
function projectVertex(o: FowPatchOpts): string {
  let s = /* glsl */`
  vec4 fowWorld = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    fowWorld = batchingMatrix * fowWorld;
  #endif
  #ifdef USE_INSTANCING
    fowWorld = instanceMatrix * fowWorld;
  #endif
  fowWorld = modelMatrix * fowWorld;
`;
  if (o.ao) {
    s += /* glsl */`
  #ifdef USE_INSTANCING
${shrinkBlock()}
  #else
  {
    float fowE = smoothstep(0.08, 0.92, fowRaw(fowWarp(fowWorld.xz)).g);
    fowWorld.y = mix(mistHeight(fowWorld.xz) + FOW_MIST_OFFSET, fowWorld.y, fowE);
    #ifndef FLAT_SHADED
      vNormal = normalize(mix(normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), vNormal, fowE));
    #endif
  }
  #endif
`;
  } else if (o.mode === 'flatten') {
    s += /* glsl */`
  {
    float fowE = smoothstep(0.08, 0.92, fowRaw(fowWarp(fowWorld.xz)).g);
    fowWorld.y = mix(mistHeight(fowWorld.xz) + FOW_MIST_OFFSET, fowWorld.y, fowE);
  }
`;
  } else if (o.mode === 'shrink') {
    s += shrinkBlock();
  }
  s += /* glsl */`
  vec4 mvPosition = viewMatrix * fowWorld;
  gl_Position = projectionMatrix * mvPosition;
  vFowWorld = fowWorld.xyz;
`;
  return s;
}

const WORLDPOS_VERTEX = /* glsl */`
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  vec4 worldPosition = fowWorld;
#endif
`;

/**
 * Inject fog-of-war behaviour into a built-in material (standard/physical/lambert/depth/normal).
 * `extra` may further edit the shader (called after the fog patch). Uniform objects are shared,
 * so updating `uniforms` affects every patched material.
 */
export function patchFow(
  mat: THREE.Material,
  uniforms: FowUniforms,
  o: FowPatchOpts,
  extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void,
  cacheKey = '',
): void {
  const windU = { value: o.wind ?? 0 };
  const occU = { value: o.occShrink ?? 0 };
  mat.userData.fowWind = windU;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uWind = windU;
    shader.uniforms.uOccShrink = occU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FOW_PARS}\nuniform float uWind;\nuniform float uOccShrink;\nvarying vec3 vFowWorld;\n#ifndef FOW_MIST_OFFSET\n#define FOW_MIST_OFFSET 0.0\n#endif`)
      .replace('#include <project_vertex>', projectVertex(o))
      .replace('#include <worldpos_vertex>', WORLDPOS_VERTEX);
    if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FOW_PARS}\nvarying vec3 vFowWorld;`);
      let tail = '';
      if (o.pulse) {
        tail += `outgoingLight += totalEmissiveRadiance * (0.35 * sin(uTime * 2.2 + vFowWorld.x * 1.7 + vFowWorld.z * 1.3));\n`;
      }
      if (o.tint) tail += `outgoingLight = fowTint(outgoingLight, vFowWorld);\n`;
      if (o.edgeFade) tail += `outgoingLight = mix(outgoingLight, uFogColor, outsideMap(vFowWorld.xz));\n`;
      if (tail) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `${tail}#include <opaque_fragment>`);
    }
    extra?.(shader);
  };
  mat.customProgramCacheKey = () => `fow-${o.mode}-${o.tint ? 1 : 0}-${o.pulse ? 1 : 0}-${o.edgeFade ? 1 : 0}-${o.ao ? 1 : 0}-${cacheKey}`;
  mat.needsUpdate = true;
}

/** A MeshDepthMaterial (shadow caster) carrying the same vertex displacement. */
export function fowDepthMaterial(uniforms: FowUniforms, mode: FowMode, wind = 0, alphaMap?: THREE.Texture | null, occShrink = 0): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (alphaMap) { m.alphaMap = alphaMap; m.alphaTest = 0.5; }
  patchFow(m, uniforms, { mode, wind, occShrink });
  return m;
}

// ───────────────────────────── CPU-side mask ─────────────────────────────
export class FogOfWar {
  readonly uniforms: FowUniforms;
  private tw = 0;
  private th = 0;
  private rect: WorldRect = { minX: 0, minZ: 0, maxX: 1, maxZ: 1 };
  private prev = new Uint8Array(4);
  private next = new Uint8Array(4);
  private prevTex: THREE.DataTexture | null = null;
  private nextTex: THREE.DataTexture | null = null;
  private tileTex: THREE.DataTexture | null = null;
  private texelTile = new Int32Array(0);
  private texelCore = new Uint8Array(0);
  private blend = 1;
  private mapW = 0;
  private mapH = 0;
  private fa = new Float32Array(0);
  private fb = new Float32Array(0);
  private lastKey = '';

  constructor(uniforms: FowUniforms) { this.uniforms = uniforms; }

  /** Allocate the textures for a map. `rect` = extended world rectangle covered by the terrain. */
  setup(state: GameState, rect: WorldRect): void {
    this.disposeTextures();
    this.rect = rect;
    this.mapW = state.width;
    this.mapH = state.height;
    this.tw = Math.max(4, Math.ceil((rect.maxX - rect.minX) * TEXELS_PER_UNIT));
    this.th = Math.max(4, Math.ceil((rect.maxZ - rect.minZ) * TEXELS_PER_UNIT));
    const n = this.tw * this.th;
    this.prev = new Uint8Array(n * 4);
    this.next = new Uint8Array(n * 4);
    this.fa = new Float32Array(n);
    this.fb = new Float32Array(n);
    this.texelTile = new Int32Array(n);
    this.texelCore = new Uint8Array(n);
    const sx = (rect.maxX - rect.minX) / this.tw;
    const sz = (rect.maxZ - rect.minZ) / this.th;
    for (let j = 0; j < this.th; j++) {
      for (let i = 0; i < this.tw; i++) {
        const x = rect.minX + (i + 0.5) * sx;
        const z = rect.minZ + (j + 0.5) * sz;
        const h = worldToHex(x, z);
        const t = j * this.tw + i;
        if (inBounds(h, state.width, state.height)) {
          this.texelTile[t] = tileIndex(h, state.width);
          const c = hexToWorld(h);
          this.texelCore[t] = Math.hypot(x - c.x, z - c.z) < 0.64 ? 1 : 0;
        } else {
          this.texelTile[t] = -1;
        }
      }
    }
    const mk = (data: Uint8Array, w: number, h: number, filter: THREE.MagnificationTextureFilter) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.magFilter = filter;
      tex.minFilter = filter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      return tex;
    };
    this.prevTex = mk(this.prev, this.tw, this.th, THREE.LinearFilter);
    this.nextTex = mk(this.next, this.tw, this.th, THREE.LinearFilter);
    this.tileTex = mk(new Uint8Array(state.width * state.height * 4), state.width, state.height, THREE.NearestFilter);
    const u = this.uniforms;
    u.uFowPrev.value = this.prevTex;
    u.uFowNext.value = this.nextTex;
    u.uTileTex.value = this.tileTex;
    u.uFowBlend.value = 1;
    u.uFowRect.value.set(rect.minX, rect.minZ, 1 / (this.tw * sx), 1 / (this.th * sz));
    u.uMapSize.value.set(state.width, state.height);
    this.blend = 1;
    this.lastKey = '';
  }

  /**
   * Recompute masks for `viewer`. `dirt[i]` = 1 when tile i shows a trodden ground patch.
   * `owners[i]` = territory owner of tile i. Transitions fade unless `immediate`.
   */
  update(state: GameState, viewer: FactionId, dirt: Uint8Array, owners: (FactionId | null)[], immediate: boolean, occupied?: Uint8Array): void {
    if (!this.prevTex || !this.nextTex || !this.tileTex) return;
    const fs = state.factions[viewer];
    const nTiles = state.width * state.height;
    const vis = fs?.visible ?? [];
    const exp = fs?.explored ?? [];

    // Tile texture (owner + explored + visible), cheap → always rebuilt.
    const td = this.tileTex.image.data as Uint8Array;
    for (let i = 0; i < nTiles; i++) {
      const e = exp[i] ? 1 : 0;
      const o = owners[i];
      td[i * 4] = e && o ? FACTION_CODE[o] : 0;
      td[i * 4 + 1] = e * 255;
      td[i * 4 + 2] = vis[i] ? 255 : 0;
      td[i * 4 + 3] = 255;
    }
    this.tileTex.needsUpdate = true;

    // Skip the expensive mask rebuild when nothing it depends on changed.
    let key = '';
    for (let i = 0; i < nTiles; i++) key += String.fromCharCode(48 + (vis[i] ? 1 : 0) + (exp[i] ? 2 : 0) + (dirt[i] ? 4 : 0) + (occupied?.[i] ? 8 : 0));
    if (key === this.lastKey && !immediate) return;
    this.lastKey = key;

    const n = this.tw * this.th;
    const target = new Uint8Array(n * 4);
    for (let ch = 0; ch < 4; ch++) {
      const a = this.fa;
      for (let t = 0; t < n; t++) {
        const i = this.texelTile[t];
        let v = 0;
        if (i >= 0) {
          if (ch === 0) v = vis[i] ? 1 : 0;
          else if (ch === 1) v = exp[i] ? 1 : 0;
          else if (ch === 2) v = dirt[i] && this.texelCore[t] ? 1 : 0;
          else v = occupied?.[i] ? 1 : 0;
        }
        a[t] = v;
      }
      // ≈ gaussian: box radius 2 then 1, separable.
      this.blur(a, this.fb, 2);
      this.blur(a, this.fb, 1);
      for (let t = 0; t < n; t++) target[t * 4 + ch] = Math.round(Math.min(1, Math.max(0, a[t])) * 255);
    }

    if (immediate) {
      this.prev.set(target);
      this.next.set(target);
      this.blend = 1;
    } else {
      // prev ← what is on screen right now, next ← new target, then cross-fade.
      const b = this.blend;
      for (let k = 0; k < n * 4; k++) this.prev[k] = Math.round(this.prev[k] + (this.next[k] - this.prev[k]) * b);
      this.next.set(target);
      this.blend = 0;
    }
    this.uniforms.uFowBlend.value = this.ease(this.blend);
    this.prevTex.needsUpdate = true;
    this.nextTex.needsUpdate = true;
  }

  tick(dt: number): void {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / FADE_SECONDS);
      this.uniforms.uFowBlend.value = this.ease(this.blend);
    }
  }

  /** Displayed explored factor (0..1) at world x/z (bilinear, matches the shader without warp). */
  exploredAt(x: number, z: number): number { return this.sample(x, z, 1); }
  visibleAt(x: number, z: number): number { return this.sample(x, z, 0); }

  private sample(x: number, z: number, ch: number): number {
    if (this.tw === 0) return 1;
    const r = this.rect;
    const fx = ((x - r.minX) / (r.maxX - r.minX)) * this.tw - 0.5;
    const fz = ((z - r.minZ) / (r.maxZ - r.minZ)) * this.th - 0.5;
    const i0 = Math.max(0, Math.min(this.tw - 1, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(this.th - 1, Math.floor(fz)));
    const i1 = Math.min(this.tw - 1, i0 + 1);
    const j1 = Math.min(this.th - 1, j0 + 1);
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const b = this.ease(this.blend);
    const at = (i: number, j: number) => {
      const k = (j * this.tw + i) * 4 + ch;
      return (this.prev[k] + (this.next[k] - this.prev[k]) * b) / 255;
    };
    const top = at(i0, j0) * (1 - tx) + at(i1, j0) * tx;
    const bot = at(i0, j1) * (1 - tx) + at(i1, j1) * tx;
    return top * (1 - tz) + bot * tz;
  }

  private ease(t: number): number { return t * t * (3 - 2 * t); }

  /** Separable box blur with clamped edges (sliding window: O(1) per texel). */
  private blur(a: Float32Array, tmp: Float32Array, r: number): void {
    const w = this.tw, h = this.th;
    const inv = 1 / (2 * r + 1);
    for (let j = 0; j < h; j++) {
      const row = j * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let i = 0; i < w; i++) {
        tmp[row + i] = sum * inv;
        sum += a[row + Math.min(w - 1, i + r + 1)] - a[row + Math.max(0, i - r)];
      }
    }
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + i];
      for (let j = 0; j < h; j++) {
        a[j * w + i] = sum * inv;
        sum += tmp[Math.min(h - 1, j + r + 1) * w + i] - tmp[Math.max(0, j - r) * w + i];
      }
    }
  }

  private disposeTextures(): void {
    this.prevTex?.dispose();
    this.nextTex?.dispose();
    this.tileTex?.dispose();
    this.prevTex = this.nextTex = this.tileTex = null;
  }

  /** Release the current map's textures (quit to title) and unbind them from the shaders. */
  clear(): void {
    this.disposeTextures();
    this.uniforms.uFowPrev.value = null;
    this.uniforms.uFowNext.value = null;
    this.uniforms.uTileTex.value = null;
    this.tw = this.th = 0;
    this.lastKey = '';
  }

  dispose(): void { this.disposeTextures(); }
}
