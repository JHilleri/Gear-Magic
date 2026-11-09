// Procedural textures generated on the GPU (fullscreen shader → render target → readback):
//  * terrain layer albedo (sRGB rgb + height in alpha) and normal maps → DataArrayTextures
//    (files from the manifest replace any layer; height is then derived from luminance),
//  * a tileable RGBA noise texture used by the mist, water, sky and anti-tiling,
//  * a tileable wave normal map for the water.
import * as THREE from 'three';
import type { AssetLibrary } from './types';

export const TERRAIN_LAYERS = ['grass', 'plains', 'forest', 'hills', 'rock', 'swamp', 'sand', 'crystal', 'snow', 'dirt'] as const;
export type TerrainLayer = (typeof TERRAIN_LAYERS)[number];
export const LAYER_INDEX: Record<TerrainLayer, number> = Object.fromEntries(TERRAIN_LAYERS.map((k, i) => [k, i])) as Record<TerrainLayer, number>;

/** World units covered by one repeat of each layer. */
export const LAYER_SCALE = [3.4, 3.4, 2.9, 3.6, 3.2, 3.2, 2.8, 3.1, 3.6, 2.6];
/** Base roughness per layer. */
export const LAYER_ROUGHNESS = [0.93, 0.95, 0.96, 0.9, 0.84, 0.72, 0.9, 0.6, 0.62, 0.97];
/** Normal-map strength used when deriving normals from height. */
const LAYER_NORMAL = [1.05, 1.1, 1.6, 1.8, 3.0, 1.4, 1.3, 2.6, 1.6, 2.0];

const GEN_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const GEN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform int uLayer;
uniform float uSeed;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030) + uSeed * 0.137);
  vec3 p3 = vec3(p.x, p.y, p.x * 0.731 + p.y * 0.193);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float pnoise(vec2 p, vec2 period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(mod(i, period));
  float b = hash(mod(i + vec2(1.0, 0.0), period));
  float c = hash(mod(i + vec2(0.0, 1.0), period));
  float d = hash(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 uv, float period, int oct, float gain) {
  float s = 0.0, amp = 0.5, norm = 0.0, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += amp * pnoise(uv * per + float(i) * 13.7, vec2(per));
    norm += amp; amp *= gain; per *= 2.0;
  }
  return s / norm;
}
float ridged(vec2 uv, float period, int oct) {
  float s = 0.0, amp = 0.5, norm = 0.0, per = period;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(pnoise(uv * per + float(i) * 7.1, vec2(per)) * 2.0 - 1.0);
    s += amp * n * n; norm += amp; amp *= 0.5; per *= 2.0;
  }
  return s / norm;
}
// Tileable worley: x = F1, y = F2, z = cell random.
vec3 worley(vec2 uv, float period) {
  vec2 p = uv * period;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, vec2(period));
      vec2 o = vec2(hash(cell + 0.17), hash(cell + 17.31));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash(cell + 3.71); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
vec2 warp(vec2 uv, float period, float amt) {
  return uv + (vec2(fbm(uv + 0.31, period, 3, 0.5), fbm(uv + 0.77, period, 3, 0.5)) - 0.5) * amt;
}

// ── layers: rgb in sRGB, a = height ──
vec4 grass(vec2 uv) {
  float lo = fbm(uv, 3.0, 4, 0.5);
  float mid = fbm(uv + 0.37, 8.0, 4, 0.55);
  float blades = fbm(uv, 64.0, 2, 0.6) * 0.55 + pnoise(uv * 160.0, vec2(160.0)) * 0.45;
  vec3 c = mix(vec3(0.19, 0.31, 0.08), vec3(0.33, 0.48, 0.14), smoothstep(0.25, 0.68, mid));
  c = mix(c, vec3(0.47, 0.58, 0.19), smoothstep(0.52, 0.85, lo) * 0.65);
  c = mix(c, vec3(0.56, 0.56, 0.22), smoothstep(0.66, 0.88, fbm(uv + 3.1, 5.0, 3, 0.5)) * 0.4);
  c *= 0.7 + 0.55 * blades;
  vec3 w = worley(uv, 22.0);
  c = mix(c, vec3(0.15, 0.25, 0.06), smoothstep(0.32, 0.05, w.x) * 0.3);
  vec3 fw = worley(uv + 0.5, 46.0);
  float fl = smoothstep(0.16, 0.07, fw.x) * step(0.935, fw.z);
  vec3 flc = fw.z > 0.975 ? vec3(0.96, 0.85, 0.33) : (fw.z > 0.955 ? vec3(0.85, 0.55, 0.85) : vec3(0.95, 0.95, 0.92));
  c = mix(c, flc, fl);
  float h = blades * 0.65 + mid * 0.35;
  return vec4(c, mix(h, 0.9, fl));
}
vec4 plains(vec2 uv) {
  vec2 wu = warp(uv, 4.0, 0.08);
  float lo = fbm(wu, 3.0, 4, 0.5);
  float straw = fbm(uv * vec2(1.0, 1.0), 48.0, 3, 0.6) * 0.5 + pnoise(uv * 150.0, vec2(150.0)) * 0.5;
  vec3 c = mix(vec3(0.50, 0.47, 0.22), vec3(0.66, 0.60, 0.31), smoothstep(0.3, 0.75, lo));
  c = mix(c, vec3(0.42, 0.47, 0.19), smoothstep(0.62, 0.85, fbm(uv + 1.7, 6.0, 3, 0.5)) * 0.5);
  float dirt = smoothstep(0.62, 0.78, fbm(uv + 5.3, 5.0, 4, 0.55));
  c = mix(c, vec3(0.50, 0.40, 0.27), dirt * 0.8);
  c *= 0.74 + 0.5 * straw;
  vec3 w = worley(uv, 30.0);
  float peb = smoothstep(0.22, 0.12, w.x) * dirt;
  c = mix(c, vec3(0.62, 0.58, 0.52) * (0.8 + 0.4 * w.z), peb);
  float h = straw * (1.0 - dirt * 0.6) + peb * 0.5;
  return vec4(c, h);
}
vec4 forest(vec2 uv) {
  float lo = fbm(uv, 3.0, 4, 0.5);
  float moss = fbm(uv + 2.0, 12.0, 4, 0.55);
  vec3 c = mix(vec3(0.12, 0.16, 0.07), vec3(0.22, 0.30, 0.11), smoothstep(0.3, 0.7, moss));
  c = mix(c, vec3(0.26, 0.20, 0.11), smoothstep(0.55, 0.8, lo) * 0.6);
  // leaf litter
  vec3 l1 = worley(warp(uv, 8.0, 0.02), 34.0);
  float leaf = smoothstep(0.32, 0.12, l1.x) * step(0.45, l1.z);
  vec3 leafC = mix(vec3(0.42, 0.24, 0.09), vec3(0.55, 0.37, 0.12), fract(l1.z * 7.0));
  c = mix(c, leafC, leaf * 0.85);
  // needles / twigs
  float tw = smoothstep(0.93, 0.99, ridged(uv * vec2(1.0, 3.0), 18.0, 2));
  c = mix(c, vec3(0.33, 0.24, 0.14), tw * 0.6);
  float spk = pnoise(uv * 180.0, vec2(180.0));
  c *= 0.78 + 0.4 * spk;
  return vec4(c, moss * 0.5 + leaf * 0.4 + spk * 0.2);
}
vec4 hills(vec2 uv) {
  vec4 g = grass(uv + 0.21);
  vec3 c = mix(g.rgb, vec3(0.42, 0.44, 0.22), 0.35);
  vec3 w = worley(warp(uv, 6.0, 0.03), 16.0);
  float edge = w.y - w.x;
  float stone = smoothstep(0.3, 0.16, w.x) * step(0.6, w.z) * smoothstep(0.35, 0.6, fbm(uv + 2.2, 4.0, 3, 0.5));
  float shade = 0.62 + 0.34 * (1.0 - w.x / 0.3) + 0.15 * fbm(uv, 32.0, 3, 0.5);
  vec3 sc = mix(vec3(0.40, 0.385, 0.36), vec3(0.52, 0.5, 0.46), w.z) * shade;
  sc = mix(sc, vec3(0.38, 0.45, 0.22), smoothstep(0.6, 0.8, fbm(uv + 4.0, 24.0, 3, 0.5)) * 0.5);
  c = mix(c, sc, stone);
  c *= mix(1.0, 0.55, smoothstep(0.08, 0.0, edge) * stone);
  float dry = smoothstep(0.55, 0.8, fbm(uv + 8.0, 4.0, 3, 0.5));
  c = mix(c, vec3(0.55, 0.50, 0.28), dry * (1.0 - stone) * 0.5);
  return vec4(c, mix(g.a * 0.45, 0.55 + 0.45 * (1.0 - w.x / 0.3), stone));
}
vec4 rock(vec2 uv) {
  vec2 wu = warp(uv, 3.0, 0.16);
  float r = ridged(wu, 3.0, 5);
  float f = fbm(wu + 1.3, 5.0, 5, 0.55);
  float strata = sin((wu.y * 9.0 + f * 5.0) * 3.14159) * 0.5 + 0.5;
  vec3 w = worley(warp(uv, 8.0, 0.04), 11.0);
  float crack = smoothstep(0.03, 0.0, w.y - w.x) * smoothstep(0.5, 0.7, fbm(uv + 7.0, 6.0, 3, 0.5));
  vec3 c = mix(vec3(0.31, 0.295, 0.28), vec3(0.55, 0.52, 0.48), f);
  c = mix(c, c * vec3(1.08, 0.98, 0.88), strata * 0.35);
  c *= 0.78 + 0.38 * r;
  c *= 0.86 + 0.24 * fbm(uv, 64.0, 2, 0.5);
  c *= 1.0 - crack * 0.3;
  c *= 0.9 + 0.2 * ridged(uv + 3.0, 16.0, 3);
  float lichen = smoothstep(0.66, 0.82, fbm(uv + 9.0, 8.0, 4, 0.55));
  c = mix(c, vec3(0.47, 0.5, 0.3), lichen * 0.35);
  float h = r * 0.5 + f * 0.4 + (1.0 - crack) * 0.1;
  return vec4(c, h);
}
vec4 swamp(vec2 uv) {
  vec2 wu = warp(uv, 4.0, 0.1);
  float lo = fbm(wu, 4.0, 5, 0.55);
  vec3 c = mix(vec3(0.33, 0.33, 0.18), vec3(0.45, 0.47, 0.22), smoothstep(0.35, 0.7, lo));
  float algae = smoothstep(0.45, 0.72, fbm(uv + 2.4, 10.0, 4, 0.55));
  c = mix(c, vec3(0.42, 0.52, 0.18), algae * 0.75);
  float moss = smoothstep(0.6, 0.8, fbm(uv + 5.1, 20.0, 3, 0.5));
  c = mix(c, vec3(0.42, 0.48, 0.2), moss * 0.4);
  float puddle = smoothstep(0.42, 0.34, lo);
  c = mix(c, vec3(0.2, 0.24, 0.17), puddle * 0.8);
  c *= 0.85 + 0.25 * pnoise(uv * 120.0, vec2(120.0));
  return vec4(c, lo * (1.0 - puddle * 0.9));
}
vec4 sand(vec2 uv) {
  vec2 wu = warp(uv, 3.0, 0.15);
  float rip = sin((wu.x * 22.0 + wu.y * 6.0 + fbm(wu, 6.0, 3, 0.5) * 4.0) * 3.14159) * 0.5 + 0.5;
  float lo = fbm(uv, 4.0, 4, 0.5);
  vec3 c = mix(vec3(0.66, 0.58, 0.42), vec3(0.80, 0.72, 0.54), lo);
  c *= 0.9 + 0.12 * rip;
  float spk = pnoise(uv * 200.0, vec2(200.0));
  c *= 0.88 + 0.22 * spk;
  vec3 w = worley(uv, 26.0);
  float peb = smoothstep(0.14, 0.08, w.x) * step(0.8, w.z);
  c = mix(c, vec3(0.45, 0.42, 0.38), peb);
  return vec4(c, rip * 0.6 + lo * 0.3 + peb * 0.3);
}
vec4 crystal(vec2 uv) {
  float lo = fbm(uv, 4.0, 4, 0.5);
  vec3 c = mix(vec3(0.17, 0.15, 0.21), vec3(0.30, 0.27, 0.34), lo);
  vec4 g = grass(uv + 0.6);
  c = mix(c, g.rgb * vec3(0.8, 0.85, 1.0), smoothstep(0.55, 0.75, fbm(uv + 3.3, 5.0, 3, 0.5)) * 0.55);
  vec3 w = worley(uv, 16.0);
  float shard = smoothstep(0.24, 0.1, w.x) * step(0.55, w.z);
  float facet = 0.6 + 0.6 * fract(w.z * 13.0 + (w.y - w.x) * 2.0);
  vec3 sc = mix(vec3(0.55, 0.38, 0.92), vec3(0.45, 0.78, 0.98), fract(w.z * 5.3)) * facet;
  c = mix(c, sc, shard);
  float vein = smoothstep(0.035, 0.0, abs(ridged(uv, 6.0, 3) - 0.82)) * 0.6;
  c = mix(c, vec3(0.62, 0.45, 0.95), vein);
  // height: shards stand out; their top values (>0.85) drive the emissive glow in the terrain shader.
  return vec4(c, max(lo * 0.5, max(shard * (0.86 + 0.14 * (1.0 - w.x / 0.24)), vein * 1.4)));
}
vec4 snow(vec2 uv) {
  vec2 wu = warp(uv, 3.0, 0.1);
  float lo = fbm(wu, 4.0, 5, 0.55);
  vec3 c = mix(vec3(0.62, 0.68, 0.79), vec3(0.84, 0.86, 0.9), smoothstep(0.3, 0.7, lo));
  float drift = sin((wu.x * 7.0 + wu.y * 3.0 + lo * 5.0) * 3.14159) * 0.5 + 0.5;
  c *= 0.92 + 0.1 * drift;
  float spk = step(0.985, pnoise(uv * 220.0, vec2(220.0)));
  c += spk * 0.1;
  float rock = smoothstep(0.72, 0.8, fbm(uv + 6.0, 6.0, 4, 0.55));
  c = mix(c, vec3(0.40, 0.40, 0.42), rock * 0.7);
  return vec4(c, lo * 0.6 + drift * 0.2 + rock * 0.3);
}
vec4 dirt(vec2 uv) {
  vec2 wu = warp(uv, 4.0, 0.08);
  float lo = fbm(wu, 4.0, 5, 0.55);
  vec3 c = mix(vec3(0.30, 0.22, 0.15), vec3(0.47, 0.37, 0.25), lo);
  vec3 w = worley(uv, 20.0);
  float peb = smoothstep(0.26, 0.14, w.x) * step(0.5, w.z);
  c = mix(c, mix(vec3(0.42, 0.39, 0.35), vec3(0.54, 0.49, 0.42), w.z) * (0.78 + 0.3 * (1.0 - w.x / 0.26)), peb);
  vec3 w2 = worley(uv + 0.3, 7.0);
  c *= 1.0 - smoothstep(0.05, 0.0, w2.y - w2.x) * 0.35;
  c *= 0.85 + 0.25 * pnoise(uv * 150.0, vec2(150.0));
  float straw = smoothstep(0.7, 0.85, fbm(uv + 2.0, 12.0, 3, 0.5));
  c = mix(c, vec3(0.55, 0.48, 0.28), straw * 0.4);
  return vec4(c, lo * 0.5 + peb * 0.5);
}

void main() {
  vec2 uv = vUv;
  vec4 o;
  if (uLayer == 0) o = grass(uv);
  else if (uLayer == 1) o = plains(uv);
  else if (uLayer == 2) o = forest(uv);
  else if (uLayer == 3) o = hills(uv);
  else if (uLayer == 4) o = rock(uv);
  else if (uLayer == 5) o = swamp(uv);
  else if (uLayer == 6) o = sand(uv);
  else if (uLayer == 7) o = crystal(uv);
  else if (uLayer == 8) o = snow(uv);
  else if (uLayer == 9) o = dirt(uv);
  else if (uLayer == 100) {
    // runtime noise: r,g = smooth fbm (different periods), b = worley F1, a = fine noise
    o = vec4(fbm(uv, 4.0, 5, 0.5), fbm(uv + 0.5, 8.0, 4, 0.5), worley(uv, 8.0).x, pnoise(uv * 32.0, vec2(32.0)));
  } else {
    // water wave height
    float h = fbm(warp(uv, 2.0, 0.08), 4.0, 5, 0.52) * 0.7 + ridged(uv, 6.0, 3) * 0.3;
    o = vec4(h, h, h, 1.0);
  }
  gl_FragColor = clamp(o, 0.0, 1.0);
}
`;

class GpuGen {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  constructor(private renderer: THREE.WebGLRenderer, seed: number) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: GEN_VERT,
      fragmentShader: GEN_FRAG,
      uniforms: { uLayer: { value: 0 }, uSeed: { value: seed } },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }
  render(layer: number, size: number): Uint8Array {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    this.mat.uniforms.uLayer.value = layer;
    const prev = this.renderer.getRenderTarget();
    const prevXr = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.cam);
    const out = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, out);
    this.renderer.setRenderTarget(prev);
    this.renderer.xr.enabled = prevXr;
    rt.dispose();
    return out;
  }
  dispose(): void {
    this.mat.dispose();
    (this.scene.children[0] as THREE.Mesh).geometry.dispose();
  }
}

/** Normal map (RGB) from a height channel (tileable Sobel). */
function heightToNormal(src: Uint8Array, size: number, channel: number, strength: number, out: Uint8Array, outOffset: number): void {
  const H = (i: number, j: number) => src[(((j + size) % size) * size + ((i + size) % size)) * 4 + channel] / 255;
  const s = strength * (size / 512);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (H(i + 1, j - 1) + 2 * H(i + 1, j) + H(i + 1, j + 1)) - (H(i - 1, j - 1) + 2 * H(i - 1, j) + H(i - 1, j + 1));
      const dy = (H(i - 1, j + 1) + 2 * H(i, j + 1) + H(i + 1, j + 1)) - (H(i - 1, j - 1) + 2 * H(i, j - 1) + H(i + 1, j - 1));
      let nx = -dx * s, ny = -dy * s, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const k = outOffset + (j * size + i) * 4;
      out[k] = Math.round((nx * 0.5 + 0.5) * 255);
      out[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[k + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[k + 3] = 255;
    }
  }
}

/**
 * Target mean colour (sRGB 0..255) per layer. Generated photo textures arrive with very different
 * exposure/saturation; each is graded part-way toward its target so the biomes read as one palette.
 */
const LAYER_TARGET: [number, number, number][] = [
  [80, 110, 42],    // grass
  [150, 132, 72],   // plains
  [62, 68, 32],     // forest floor
  [98, 98, 56],     // hills
  [118, 113, 105],  // rock
  [84, 86, 46],     // swamp
  [188, 166, 122],  // sand
  [66, 54, 96],     // crystal ground
  [206, 213, 226],  // snow
  [104, 80, 55],    // dirt
];
const GRADE_STRENGTH = 0.7;

/** Pixels of a loaded image resized to size² (RGBA, alpha = height from luminance), graded for `layer`. */
function imagePixels(tex: THREE.Texture, size: number, layer: number | null): Uint8Array | null {
  const img = tex.image as CanvasImageSource & { width?: number; height?: number } | undefined;
  if (!img || !img.width) return null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size).data;
    const n = size * size;
    const out = new Uint8Array(n * 4);
    let mr = 0, mg = 0, mb = 0;
    for (let k = 0; k < n; k++) { mr += d[k * 4]; mg += d[k * 4 + 1]; mb += d[k * 4 + 2]; }
    mr /= n; mg /= n; mb /= n;
    let gr = 1, gg = 1, gb = 1;
    if (layer !== null && LAYER_TARGET[layer]) {
      const [tr, tg, tb] = LAYER_TARGET[layer];
      const k = (t: number, m: number) => Math.min(2.4, Math.max(0.45, 1 + (t / Math.max(1, m) - 1) * GRADE_STRENGTH));
      gr = k(tr, mr); gg = k(tg, mg); gb = k(tb, mb);
    }
    // Height from luminance, contrast-stretched (photo textures carry their relief in shading).
    let mn = 255, mx = 0;
    const lum = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const l = d[k * 4] * 0.299 + d[k * 4 + 1] * 0.587 + d[k * 4 + 2] * 0.114;
      lum[k] = l;
      if (l < mn) mn = l;
      if (l > mx) mx = l;
    }
    const range = Math.max(1, mx - mn);
    for (let k = 0; k < n; k++) {
      out[k * 4] = Math.min(255, Math.round(d[k * 4] * gr));
      out[k * 4 + 1] = Math.min(255, Math.round(d[k * 4 + 1] * gg));
      out[k * 4 + 2] = Math.min(255, Math.round(d[k * 4 + 2] * gb));
      out[k * 4 + 3] = Math.round(((lum[k] - mn) / range) * 255);
    }
    return out;
  } catch {
    return null;
  }
}

/** 2× nearest-ish upscale (bilinear) of an RGBA square image. */
function upscale2(src: Uint8Array, size: number): Uint8Array {
  const S = size * 2;
  const out = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    const fy = (j + 0.5) / 2 - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    const ya = ((y0 % size) + size) % size, yb = (ya + 1) % size;
    for (let i = 0; i < S; i++) {
      const fx = (i + 0.5) / 2 - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const xa = ((x0 % size) + size) % size, xb = (xa + 1) % size;
      for (let c = 0; c < 4; c++) {
        const v = (src[(ya * size + xa) * 4 + c] * (1 - tx) + src[(ya * size + xb) * 4 + c] * tx) * (1 - ty)
                + (src[(yb * size + xa) * 4 + c] * (1 - tx) + src[(yb * size + xb) * 4 + c] * tx) * ty;
        out[(j * S + i) * 4 + c] = Math.round(v);
      }
    }
  }
  return out;
}

/** 2× box downsample of an RGBA square image. */
function downsample2(src: Uint8Array, size: number): Uint8Array {
  const h = size / 2;
  const out = new Uint8Array(h * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < h; i++) {
      for (let c = 0; c < 4; c++) {
        const a = ((2 * j) * size + 2 * i) * 4 + c, b = a + 4, cc = a + size * 4, dd = cc + 4;
        out[(j * h + i) * 4 + c] = (src[a] + src[b] + src[cc] + src[dd] + 2) >> 2;
      }
    }
  }
  return out;
}

export interface WorldTextures {
  albedo: THREE.DataArrayTexture;   // sRGB rgb + height alpha, one layer per TERRAIN_LAYERS entry
  normal: THREE.DataArrayTexture;   // linear tangent-space normals
  noise: THREE.DataTexture;         // tileable linear noise (see GEN_FRAG layer 100)
  waves: THREE.DataTexture;         // tileable water normal map
  dispose(): void;
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

export async function generateWorldTextures(
  renderer: THREE.WebGLRenderer,
  assets: AssetLibrary,
  onProgress?: (f: number) => void,
): Promise<WorldTextures> {
  const L = TERRAIN_LAYERS.length;
  const files = TERRAIN_LAYERS.map((k) => assets.texture(k));
  // Full-resolution albedo only when every layer comes from a file (the procedural set is 512²).
  const AS = files.every(Boolean) ? 1024 : 512;
  const NSZ = 512;
  const gen = new GpuGen(renderer, 7.31);
  const albedo = new Uint8Array(AS * AS * 4 * L);
  const normal = new Uint8Array(NSZ * NSZ * 4 * L);
  for (let l = 0; l < L; l++) {
    const key = TERRAIN_LAYERS[l];
    const file = files[l];
    let px = file ? imagePixels(file, AS, l) : null;
    if (!px) px = AS === 512 ? gen.render(l, 512) : upscale2(gen.render(l, 512), 512);
    albedo.set(px, l * AS * AS * 4);
    const hsrc = AS === NSZ ? px : downsample2(px, AS);
    const nfile = assets.texture(`${key}_normal`);
    const npx = nfile ? imagePixels(nfile, NSZ, null) : null;
    if (npx) {
      for (let k = 0; k < NSZ * NSZ; k++) {
        const o = l * NSZ * NSZ * 4 + k * 4;
        normal[o] = npx[k * 4]; normal[o + 1] = npx[k * 4 + 1]; normal[o + 2] = npx[k * 4 + 2]; normal[o + 3] = 255;
      }
    } else {
      heightToNormal(hsrc, NSZ, 3, LAYER_NORMAL[l] * (file ? 0.8 : 1), normal, l * NSZ * NSZ * 4);
    }
    onProgress?.((l + 1) / (L + 2));
    await yieldFrame();
  }
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const mkArr = (data: Uint8Array, cs: THREE.ColorSpace, size: number) => {
    const t = new THREE.DataArrayTexture(data, size, size, L);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = cs;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(8, aniso);
    t.needsUpdate = true;
    return t;
  };
  const albedoTex = mkArr(albedo, THREE.SRGBColorSpace, AS);
  const normalTex = mkArr(normal, THREE.NoColorSpace, NSZ);

  const NS = 256;
  const noisePx = gen.render(100, NS);
  const noise = new THREE.DataTexture(noisePx, NS, NS, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.generateMipmaps = true;
  noise.colorSpace = THREE.NoColorSpace;
  noise.needsUpdate = true;
  onProgress?.((L + 1) / (L + 2));

  const WS = 256;
  const wavePx = gen.render(101, WS);
  const waveN = new Uint8Array(WS * WS * 4);
  heightToNormal(wavePx, WS, 0, 2.2, waveN, 0);
  const waves = new THREE.DataTexture(waveN, WS, WS, THREE.RGBAFormat, THREE.UnsignedByteType);
  waves.wrapS = waves.wrapT = THREE.RepeatWrapping;
  waves.minFilter = THREE.LinearMipmapLinearFilter;
  waves.magFilter = THREE.LinearFilter;
  waves.generateMipmaps = true;
  waves.colorSpace = THREE.NoColorSpace;
  waves.anisotropy = Math.min(4, aniso);
  waves.needsUpdate = true;
  gen.dispose();
  onProgress?.(1);

  return {
    albedo: albedoTex, normal: normalTex, noise, waves,
    dispose() { albedoTex.dispose(); normalTex.dispose(); noise.dispose(); waves.dispose(); },
  };
}
