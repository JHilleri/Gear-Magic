// Building visuals: models, faction banners, construction scaffolding, territory is drawn by terrain.ts.
// Buildings are remembered under fog of war (last seen state, drawn darkened) and only revealed once explored.
import * as THREE from 'three';
import type { Building, BuildingId, BuildingInstanceId, FactionId, GameState, Hex } from '../core/types';
import { tileIndex } from '../core/hex';
import { BUILDINGS } from '../data/buildings';
import { FACTIONS } from '../data/factions';
import { BUILDING_FOOTPRINT, BUILDING_MODEL_TUNING } from './types';
import type { BuildingLayerApi, CreateBuildingLayer, FxLayerApi, RenderContext } from './types';
import {
  Scheduler, GLSL_OUTPUT, bump, clamp01, damp, discGeometry, drapeGeometry, easeInCubic, easeInQuad, easeOutBack, easeOutCubic, makeRand, normSpeed,
} from './anim';
import { createPaletteMaterial, softDotTexture, type PaletteMaterial } from './procedural';
import { BP, buildingModel, buildingPalette, scaffoldGeometry, type BuildingModel } from './procedural-buildings';
import { hasFxExtras } from './fx';
import { rayCylinder, raycastMeshes } from './pick';

interface Snap { id: BuildingInstanceId; type: BuildingId; owner: FactionId | null; level: number; buildLeft: number; upgrading: boolean; pos: Hex }
type Mode = 'normal' | 'construction' | 'upgrade';

interface Look { tint: number; desat: number; emit: number }
const LOOKS: Record<string, Look> = {
  normal: { tint: 1, desat: 0, emit: 1 },
  fog: { tint: 0.46, desat: 0.55, emit: 0.12 },
  // ownerless: slate grey, so a fallen seat never reads as anyone's (least of all the player's)
  abandoned: { tint: 0.55, desat: 1, emit: 0 },
  abandonedFog: { tint: 0.32, desat: 1, emit: 0 },
};

interface BView {
  id: BuildingInstanceId;
  snap: Snap;
  key: string;
  mode: Mode;
  root: THREE.Group;          // at hex centre, rotated by tile variant
  holder: THREE.Group;        // pop / sink / shake transforms
  model: THREE.Object3D;
  procedural: boolean;
  height: number;             // world height of the model
  radius: number;
  /** Top of the pickable volume (model or banner, whichever is higher). */
  pickTop: number;
  /** Model-local reach toward 12 directions (j at 30j−30°: corners and edge midpoints), for units standing in front. */
  reach: number[];
  /** Shared by the GLB materials of this view: desaturation of the look (fog / abandoned). */
  desatU: { value: number };
  mats: THREE.Material[];     // owned (disposed with the view)
  palMat: PaletteMaterial | null;
  scaffMat: PaletteMaterial | null;
  parts: { obj: THREE.Object3D; anim: string; base: THREE.Vector3 }[];
  glows: { sprite: THREE.Sprite; base: number; flicker: boolean }[];
  smoke: THREE.Vector3[];
  smokeKind: 'forge' | 'chimney' | null;
  banner: THREE.Group | null;
  bannerMat: THREE.MeshStandardMaterial | null;
  scaffold: THREE.Mesh | null;
  ghost: THREE.Object3D | null;
  ghostMat: THREE.MeshBasicMaterial | null;
  ring: THREE.Mesh | null;
  ringMat: THREE.ShaderMaterial | null;
  solidPlane: THREE.Plane;
  ghostPlane: THREE.Plane;
  progress: number;
  progressTarget: number;
  maxLeft: number;
  fogged: boolean;
  look: string;
  smokeT: number;
  dustT: number;
  busy: number;
  seed: number;
}

const WIND = 0.65; // world wind heading for every banner (radians around Y)

/** Mean luminance (0..1) of a texture image, read from a tiny downsample; null when it cannot be read. */
function imageLuminance(img: unknown): number | null {
  if (typeof document === 'undefined' || !img) return null;
  const im = img as CanvasImageSource & { width?: number; height?: number };
  if (!(im.width && im.height)) return null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(im, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (64 * 255);
  } catch {
    return null;
  }
}
/** Every textured material of the model has an (almost) black colour map: a broken asset. */
function blackAlbedo(obj: THREE.Object3D): boolean {
  let maps = 0, black = 0;
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (!map) continue;
      const l = imageLuminance(map.image);
      if (l === null) continue;
      maps++;
      if (l < 0.012) black++;
    }
  });
  return maps > 0 && black === maps;
}

/** Model tuning of a GLB key; a faction variant (house_thorn) shares its plain model's footprint. */
function tuningOf(key: string): (typeof BUILDING_MODEL_TUNING)[string] | undefined {
  return BUILDING_MODEL_TUNING[key] ?? (key.startsWith('castle_') ? undefined : BUILDING_MODEL_TUNING[key.replace(/_(valen|thorn|ashen)$/, '')]);
}

/**
 * GLB keys to try for a building, best first (the caller takes the first the asset library has,
 * else the procedural model).
 * - Castles: the seat of its owner (`castle_<owner>`). An ownerless castle keeps the silhouette of
 *   the faction last seen owning it (`former`; it is drawn slate grey by the abandoned look); one
 *   never seen owned gets a castle of a faction other than the viewer and never Valen's blue seat
 *   unless no other castle model exists.
 * - Everything else: the faction variant (`<model>_<owner>`, e.g. house_thorn) when one exists,
 *   else the plain model. Ownerless buildings use the former owner's variant, so a fallen faction's
 *   town does not change shape; neutral or never-owned ones use the plain model.
 */
export function buildingModelKeys(type: BuildingId, model: string, owner: FactionId | null, former: FactionId | null, viewer: FactionId): string[] {
  const live = owner && owner !== 'neutral' ? owner : null;
  const face = live ?? (former && former !== 'neutral' ? former : null);
  if (type === 'castle') {
    const all: FactionId[] = ['ashen', 'thorn', 'valen'];
    const neutralSeat = all.filter((f) => f !== viewer && f !== 'valen');
    const order: FactionId[] = live ? [live, ...all]
      : face ? [face, ...neutralSeat, ...all]
        : [...neutralSeat, ...all.filter((f) => f !== 'valen'), 'valen'];
    return [...new Set(order)].map((f) => `castle_${f}`);
  }
  return face ? [`${model}_${face}`, model] : [model];
}

function progressRingMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uProg: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uProg; uniform float uTime; uniform float uAlpha; varying vec2 vUv;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float band = smoothstep(0.8, 0.84, r) * (1.0 - smoothstep(0.95, 0.99, r));
        if (band < 0.01) discard;
        float a = fract(atan(p.x, p.y) / 6.2831853 + 0.5);
        float filled = step(a, uProg);
        float edge = (1.0 - smoothstep(0.0, 0.03, abs(a - uProg))) * step(0.001, uProg);
        vec3 col = mix(vec3(0.05, 0.04, 0.03), uColor * 1.4, filled) + vec3(1.0, 0.9, 0.6) * edge * 1.5;
        float alpha = band * mix(0.55, 0.95, filled) * uAlpha;
        gl_FragColor = vec4(col, alpha);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
}

/** Banner cloth: vertex wave + swallowtail, border, emblem and level pips drawn in the fragment shader. */
function bannerMaterial(time: { value: number }, color: THREE.Color, accent: THREE.Color, level: number, next: boolean, phase: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
  const u = {
    uTime: time, uBColor: { value: color.clone() }, uBAccent: { value: accent.clone() }, uGold: { value: new THREE.Color('#e9c25a') },
    uLevel: { value: level }, uNext: { value: next ? 1 : 0 }, uPhase: { value: phase }, uTint: { value: new THREE.Color(1, 1, 1) },
  };
  mat.userData.banner = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uPhase; varying vec2 vBan;')
      .replace('#include <beginnormal_vertex>', `
        float bx = clamp(position.x / 0.2, 0.0, 1.0);
        float wv = uTime * 3.4 + bx * 7.0 + uPhase;
        float dz = cos(wv) * 7.0 * 0.026 * bx / 0.2 + sin(wv) * 0.026 / 0.2;
        vec3 objectNormal = normalize(vec3(-dz, 0.0, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        float bxx = clamp(position.x / 0.2, 0.0, 1.0);
        transformed.z += sin(uTime * 3.4 + bxx * 7.0 + uPhase) * 0.026 * bxx + sin(uTime * 5.3 + bxx * 13.0 + position.y * 30.0 + uPhase) * 0.007 * bxx;
        transformed.y -= bxx * bxx * 0.018;
        vBan = vec2(bxx, clamp(-position.y / 0.13, 0.0, 1.0));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uBColor; uniform vec3 uBAccent; uniform vec3 uGold; uniform float uLevel; uniform float uNext; uniform float uTime; uniform vec3 uTint; varying vec2 vBan;')
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 bb = vBan;
        if (bb.x > 0.76 && abs(bb.y - 0.5) < (bb.x - 0.76) * 1.7) discard;
        vec3 bcol = uBColor;
        float border = step(bb.y, 0.09) + step(0.91, bb.y);
        bcol = mix(bcol, uBAccent, clamp(border, 0.0, 1.0));
        vec2 e = vec2((bb.x - 0.38) * 1.25, bb.y - 0.42);
        bcol = mix(bcol, uBAccent, step(abs(e.x) + abs(e.y), 0.16));
        bcol = mix(bcol, uBColor * 0.6, step(abs(e.x) + abs(e.y), 0.07));
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          vec2 q = vec2((bb.x - (0.16 + fi * 0.15)) * 1.3, bb.y - 0.76);
          float d = abs(q.x) + abs(q.y);
          if (fi < uLevel && d < 0.075) bcol = uGold;
          if (uNext > 0.5 && abs(fi - uLevel) < 0.5 && d < 0.075) bcol = mix(bcol, uGold * 1.6, 0.5 + 0.5 * sin(uTime * 5.0));
        }
        diffuseColor.rgb = bcol * uTint;`);
  };
  mat.customProgramCacheKey = () => 'aei-banner-v1';
  return mat;
}

export const createBuildingLayer: CreateBuildingLayer = (ctx: RenderContext, fx: FxLayerApi): BuildingLayerApi => {
  ctx.renderer.localClippingEnabled = true; // construction sites clip the rising model
  const root = new THREE.Group();
  root.name = 'buildings';
  ctx.scene.add(root);
  const sched = new Scheduler();
  const views = new Map<BuildingInstanceId, BView>();
  const memory = new Map<BuildingInstanceId, Snap>();
  let lastState: GameState | null = null;
  let visibleFn: (h: Hex) => boolean = () => true;
  const ext = hasFxExtras(fx) ? fx : null;
  const bannerTime = { value: 0 };
  const rand = makeRand(0xb111d);
  const poleGeo = new THREE.CylinderGeometry(0.009, 0.012, 1, 6).translate(0, 0.5, 0);
  const finialGeo = new THREE.SphereGeometry(0.018, 8, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.7 });
  const finialMat = new THREE.MeshStandardMaterial({ color: 0xd9a93e, roughness: 0.3, metalness: 1 });
  const clothGeo = new THREE.PlaneGeometry(0.2, 0.13, 16, 6).translate(0.1, -0.065, 0);
  const glbInfo = new Map<string, { scale: number; yScale: number; footprint: number; height: number; banner: THREE.Vector3 }>();
  const reachCache = new Map<string, number[]>();
  /** Last faction seen owning a building: an ownerless castle keeps its builders' silhouette. */
  const formerOwner = new Map<BuildingInstanceId, FactionId>();
  const raycaster = new THREE.Raycaster();
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const sphere = new THREE.Sphere();

  const def = (t: BuildingId) => BUILDINGS[t];
  const snapOf = (b: Building): Snap => ({ id: b.id, type: b.type, owner: b.owner, level: b.level, buildLeft: b.buildLeft, upgrading: b.upgrading, pos: { ...b.pos } });
  const modeOf = (s: Snap): Mode => (s.buildLeft > 0 ? (s.upgrading ? 'upgrade' : 'construction') : 'normal');
  const keyOf = (s: Snap) => `${s.type}|${s.owner}|${s.level}|${modeOf(s)}|${s.pos.q},${s.pos.r}`;

  function lookFor(v: BView): string {
    const ab = v.snap.owner === null;
    return ab ? (v.fogged ? 'abandonedFog' : 'abandoned') : v.fogged ? 'fog' : 'normal';
  }

  function variantOf(state: GameState | null, h: Hex): number {
    if (!state) return 0;
    const i = tileIndex(h, state.width);
    return state.tiles[i]?.variant ?? 0;
  }

  /**
   * How far a model reaches from its centre toward each of 12 directions (j at 30j−30°: even j =
   * hex corners, odd j = edge midpoints), within the slice that can hide a unit standing in front of
   * it (near the direction's axis, below ≈1 unit). Model-local, unrotated.
   */
  function measureReach(key: string, model: THREE.Object3D): number[] {
    const hit = reachCache.get(key);
    if (hit) return hit;
    const dirs = Array.from({ length: 12 }, (_, j) => { const a = (j * Math.PI) / 6 - Math.PI / 6; return { x: Math.cos(a), z: Math.sin(a) }; });
    const reach = new Array<number>(12).fill(0);
    model.updateWorldMatrix(true, true);
    const inv = model.matrixWorld.clone().invert();
    const p = new THREE.Vector3();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry || (o as unknown as THREE.Sprite).isSprite) return;
      const pos = m.geometry.getAttribute('position');
      if (!pos) return;
      const toLocal = inv.clone().multiply(m.matrixWorld);
      const step = Math.max(1, Math.floor(pos.count / 6000));
      for (let i = 0; i < pos.count; i += step) {
        p.fromBufferAttribute(pos, i).applyMatrix4(toLocal);
        if (p.y > 1.0) continue;
        for (let k = 0; k < 12; k++) {
          const d = dirs[k];
          const along = p.x * d.x + p.z * d.z;
          if (along <= reach[k]) continue;
          if (Math.abs(p.x * d.z - p.z * d.x) < 0.28) reach[k] = along;
        }
      }
    });
    reachCache.set(key, reach);
    return reach;
  }

  /** Normalisation data for a GLB building model: scale to the footprint, height, banner anchor (highest point). */
  function glbData(key: string, obj: THREE.Object3D): { scale: number; yScale: number; footprint: number; height: number; banner: THREE.Vector3 } {
    const hit = glbInfo.get(key);
    if (hit) return hit;
    obj.updateWorldMatrix(true, true);
    const inv = obj.matrixWorld.clone().invert();
    let rMax = 0.01, yMax = 0;
    const top = new THREE.Vector3();
    const p = new THREE.Vector3();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const pos = m.geometry.getAttribute('position');
      const toLocal = inv.clone().multiply(m.matrixWorld);
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        p.fromBufferAttribute(pos, i).applyMatrix4(toLocal);
        rMax = Math.max(rMax, Math.hypot(p.x, p.z));
        if (p.y > yMax) { yMax = p.y; top.copy(p); }
      }
    });
    const tune = tuningOf(key);
    const footprint = tune?.footprint ?? BUILDING_FOOTPRINT;
    const yScale = tune?.yScale ?? 1;
    const scale = footprint / rMax;
    const data = { scale, yScale, footprint, height: yMax * scale * yScale, banner: top.multiplyScalar(scale).setY(yMax * scale * yScale - 0.04) };
    glbInfo.set(key, data);
    return data;
  }

  function adopt(v: BView, obj: THREE.Object3D, tint?: [number, number, number], glow?: THREE.Color): void {
    const desatU = v.desatU;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      const conv = (mat: THREE.Material) => {
        const c = mat.clone();
        const s = c as THREE.MeshStandardMaterial;
        if (tint && s.color) s.color.multiply(new THREE.Color(tint[0], tint[1], tint[2]));
        if (glow && s.emissive && s.emissive.getHex() === 0 && !s.emissiveMap) { s.emissive.copy(glow); s.emissiveIntensity = 1; }
        c.userData.baseColor = s.color ? s.color.clone() : null;
        c.userData.baseEmissive = s.emissiveIntensity ?? 1;
        if (s.isMeshStandardMaterial) {
          // GLB textures cannot be desaturated by the colour multiply alone (fogged / abandoned looks)
          c.onBeforeCompile = (sh) => {
            sh.uniforms.uDesat = desatU;
            sh.fragmentShader = sh.fragmentShader
              .replace('#include <common>', '#include <common>\nuniform float uDesat;')
              .replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), uDesat);`);
          };
          c.customProgramCacheKey = () => 'bld-desat';
        }
        v.mats.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    });
  }

  /**
   * A building GLB, unless its colour texture came out black (a failed texture bake: the model would
   * draw as a black blob); then null, so the next candidate (the plain model) is used instead.
   */
  const usable = new Map<string, boolean>();
  function usableModel(key: string): THREE.Object3D | null {
    const obj = ctx.assets.model('buildings', key);
    if (!obj) return null;
    let ok = usable.get(key);
    if (ok === undefined) {
      ok = !blackAlbedo(obj);
      usable.set(key, ok);
      if (!ok) console.warn(`[render] building model '${key}' has a black base-colour texture; drawing a fallback model instead`);
    }
    return ok ? obj : null;
  }

  // ───────── view construction ─────────
  function clearView(v: BView): void {
    v.holder.clear();
    if (v.banner) v.root.remove(v.banner);
    if (v.ring) { root.remove(v.ring); v.ring.geometry.dispose(); }
    for (const m of v.mats) m.dispose();
    v.mats = [];
    v.palMat?.dispose();
    v.palMat = null;
    v.scaffMat?.dispose();
    v.scaffMat = null;
    v.bannerMat?.dispose();
    v.ringMat?.dispose();
    v.ghostMat?.dispose();
    for (const g of v.glows) (g.sprite.material as THREE.Material).dispose();
    v.parts = []; v.glows = []; v.smoke = []; v.banner = null; v.bannerMat = null; v.scaffold = null; v.ghost = null; v.ghostMat = null; v.ring = null; v.ringMat = null;
  }

  function build(v: BView, s: Snap): void {
    clearView(v);
    v.snap = { ...s, pos: { ...s.pos } };
    v.key = keyOf(s);
    v.mode = modeOf(s);
    const d = def(s.type);
    // Faction variants (house_thorn …) and castle seats; see buildingModelKeys.
    const baseModel = d?.model ?? s.type;
    let glbKey = baseModel;
    let glb: THREE.Object3D | null = null;
    for (const k of buildingModelKeys(s.type, baseModel, s.owner, formerOwner.get(s.id) ?? null, ctx.viewer)) {
      glb = usableModel(k);
      if (glb) { glbKey = k; break; }
    }
    const model = new THREE.Group();
    let pm: BuildingModel | null = null;
    let bannerAt: THREE.Vector3;
    let bannerH: number;
    if (glb) {
      const data = glbData(glbKey, glb);
      const tune = tuningOf(glbKey);
      adopt(v, glb, tune?.tint, tune?.tint ? ctx.factionColor(s.owner).multiplyScalar(0.06) : undefined);
      glb.scale.multiply(new THREE.Vector3(data.scale, data.scale * data.yScale, data.scale));
      model.add(glb);
      v.height = data.height;
      v.radius = data.footprint;
      v.procedural = false;
      bannerAt = data.banner.clone();
      bannerH = 0.3;
      v.smoke = [];
      v.smokeKind = null;
    } else {
      pm = buildingModel(s.type, s.level);
      v.palMat = createPaletteMaterial(buildingPalette(s.owner));
      const mesh = new THREE.Mesh(pm.geometry, v.palMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      model.add(mesh);
      for (const part of pm.parts) {
        const pmesh = new THREE.Mesh(part.geometry, v.palMat);
        pmesh.castShadow = true;
        pmesh.position.copy(part.pos);
        model.add(pmesh);
        v.parts.push({ obj: pmesh, anim: part.anim, base: part.pos.clone() });
      }
      const pal = buildingPalette(s.owner);
      for (const g of pm.glows) {
        const col = g.slot === 'window' ? pal[BP.WINDOW].c : pal[BP.CRYSTAL].c;
        const sm = new THREE.SpriteMaterial({ map: softDotTexture(), color: col, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
        const sp = new THREE.Sprite(sm);
        sp.position.copy(g.pos);
        sp.scale.setScalar(g.size);
        sp.renderOrder = 8;
        model.add(sp);
        v.glows.push({ sprite: sp, base: g.size, flicker: g.slot === 'window' });
      }
      v.height = pm.height;
      v.radius = pm.radius;
      v.procedural = true;
      bannerAt = pm.banner.clone();
      bannerH = pm.bannerHeight;
      v.smoke = pm.smoke.map((p) => p.clone());
      v.smokeKind = s.type === 'forge' ? 'forge' : pm.smoke.length ? 'chimney' : null;
    }
    v.model = model;
    const reach = measureReach(glb ? `glb|${glbKey}` : `proc|${s.type}|${s.level}`, model);
    v.holder.add(model);

    // banner (abandoned buildings fly none)
    if (s.owner && s.owner !== 'neutral' && bannerH > 0) {
      const g = new THREE.Group();
      g.position.copy(bannerAt);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.scale.y = bannerH;
      pole.castShadow = true;
      g.add(pole);
      const fin = new THREE.Mesh(finialGeo, finialMat);
      fin.position.y = bannerH + 0.012;
      fin.userData.noAO = true;
      g.add(fin);
      const color = ctx.factionColor(s.owner);
      const accent = new THREE.Color(FACTIONS[s.owner]?.accent ?? '#cccccc');
      v.bannerMat = bannerMaterial(bannerTime, color, accent, s.level, v.mode === 'upgrade', v.seed % 7);
      const cloth = new THREE.Mesh(clothGeo, v.bannerMat);
      cloth.position.y = bannerH - 0.008;
      cloth.position.x = 0.008;
      cloth.userData.noAO = true;
      g.add(cloth);
      v.holder.add(g);
      v.banner = g;
    }

    // construction / upgrade dressing
    if (v.mode !== 'normal') {
      // own (unclipped) material: the scaffold must never be cut by the progress plane
      const scaffMat = createPaletteMaterial(buildingPalette(s.owner));
      v.scaffMat = scaffMat;
      const sh = v.mode === 'construction' ? Math.max(0.3, v.height * 0.85) : Math.max(0.3, v.height * 0.7);
      const sr = Math.min(0.66, v.radius * 0.82);
      v.scaffold = new THREE.Mesh(scaffoldGeometry(sr, sh), scaffMat);
      v.scaffold.castShadow = true;
      v.holder.add(v.scaffold);
      const color = ctx.factionColor(s.owner);
      v.ringMat = progressRingMaterial(color);
      v.ring = new THREE.Mesh(discGeometry(0.86, 48, 2), v.ringMat);
      v.ring.renderOrder = 4;
      v.ring.frustumCulled = false;
      root.add(v.ring);
    }
    if (v.mode === 'construction') {
      // solid part clipped below the progress line, translucent "blueprint" above
      const clip = [v.solidPlane];
      const setClip = (m: THREE.Material) => { m.clippingPlanes = clip; m.clipShadows = true; m.needsUpdate = true; };
      if (v.palMat) setClip(v.palMat);
      for (const m of v.mats) setClip(m);
      const tint = (s.owner ? ctx.factionColor(s.owner).clone() : new THREE.Color('#bbbbbb')).lerp(new THREE.Color('#ffffff'), 0.45);
      v.ghostMat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, clippingPlanes: [v.ghostPlane], fog: false });
      const ghost = model.clone(true);
      ghost.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.material = v.ghostMat!; m.castShadow = false; m.receiveShadow = false; }
        if ((o as THREE.Sprite).isSprite) o.visible = false;
      });
      v.ghost = ghost;
      v.holder.add(ghost);
      for (const g of v.glows) g.sprite.visible = false;
      if (v.banner) v.banner.visible = false;
    }
    v.reach = v.mode !== 'normal' ? reach.map((r) => Math.max(r, Math.min(0.66, v.radius * 0.82))) : reach;
    v.pickTop = Math.max(v.height, v.banner ? bannerAt.y + bannerH + 0.03 : 0);
    applyLook(v, true);
  }

  function totalPoints(s: Snap): number {
    const bp = def(s.type)?.buildPoints ?? 3;
    return s.upgrading ? bp * Math.max(1, s.level) : bp;
  }

  function targetProgress(v: BView): number {
    if (v.mode === 'normal') return 1;
    v.maxLeft = Math.max(v.maxLeft, v.snap.buildLeft);
    const tot = Math.max(totalPoints(v.snap), v.maxLeft);
    return clamp01(1 - v.snap.buildLeft / tot);
  }

  function applyLook(v: BView, force = false): void {
    const name = lookFor(v);
    if (!force && name === v.look) return;
    v.look = name;
    const L = LOOKS[name];
    for (const pm of [v.palMat, v.scaffMat]) {
      if (!pm) continue;
      const u = pm.userData.pal;
      u.uTint.value.setScalar(L.tint);
      u.uFx.value.x = L.desat;
      u.uFx.value.y = L.emit;
    }
    for (const m of v.mats) {
      const s = m as THREE.MeshStandardMaterial;
      const base = m.userData.baseColor as THREE.Color | null | undefined;
      if (base && s.color) s.color.copy(base).multiplyScalar(L.tint);
      if (s.emissiveIntensity !== undefined) s.emissiveIntensity = (m.userData.baseEmissive ?? 1) * L.emit;
    }
    v.desatU.value = L.desat;
    if (v.bannerMat) (v.bannerMat.userData.banner.uTint.value as THREE.Color).setScalar(L.tint);
    for (const g of v.glows) (g.sprite.material as THREE.SpriteMaterial).opacity = 0.75 * L.emit;
    if (v.ringMat) v.ringMat.uniforms.uAlpha.value = v.fogged ? 0.45 : 1;
  }

  function place(v: BView, state: GameState | null): void {
    const c = ctx.hexCenter(v.snap.pos);
    v.root.position.copy(c);
    v.root.rotation.y = (variantOf(state, v.snap.pos) % 6) * (Math.PI / 3);
    if (v.banner) v.banner.rotation.y = WIND - v.root.rotation.y;
    if (v.ring) {
      v.ring.position.set(c.x, 0, c.z);
      drapeGeometry(v.ring.geometry, ctx.heightAt, c.x, c.z, 0.03);
    }
  }

  function createView(s: Snap, state: GameState | null): BView {
    const rootG = new THREE.Group();
    rootG.name = `building_${s.id}`;
    const holder = new THREE.Group();
    rootG.add(holder);
    root.add(rootG);
    const v: BView = {
      id: s.id, snap: s, key: '', mode: 'normal', root: rootG, holder, model: new THREE.Group(), procedural: true, height: 0.6, radius: 0.8,
      pickTop: 0.6, reach: new Array<number>(12).fill(0.8), desatU: { value: 0 },
      mats: [], palMat: null, scaffMat: null, parts: [], glows: [], smoke: [], smokeKind: null, banner: null, bannerMat: null, scaffold: null, ghost: null, ghostMat: null,
      ring: null, ringMat: null, solidPlane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), ghostPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      progress: 0, progressTarget: 0, maxLeft: 0, fogged: false, look: '', smokeT: rand() * 2, dustT: rand() * 2, busy: 0,
      seed: (s.id * 2654435761) >>> 0,
    };
    build(v, s);
    place(v, state);
    v.progressTarget = targetProgress(v);
    v.progress = v.progressTarget;
    updateClip(v);
    views.set(s.id, v);
    return v;
  }

  function updateClip(v: BView): void {
    const y = v.root.position.y + v.holder.position.y + (v.progress * 0.94 + 0.03) * v.height * v.holder.scale.y;
    v.solidPlane.constant = y;
    v.ghostPlane.constant = -y;
    if (v.ringMat) v.ringMat.uniforms.uProg.value = v.progress;
  }

  function disposeView(v: BView): void {
    clearView(v);
    root.remove(v.root);
    views.delete(v.id);
  }

  // ───────── sync ─────────
  function sync(state: GameState, visible: (h: Hex) => boolean, explored: (h: Hex) => boolean): void {
    lastState = state;
    visibleFn = visible;
    const viewer = ctx.viewer;
    const present = new Set<BuildingInstanceId>();
    for (const key of Object.keys(state.buildings)) {
      const b = state.buildings[key];
      if (!b) continue;
      present.add(b.id);
      const own = b.owner === viewer;
      const vis = own || visible(b.pos);
      if (vis) {
        memory.set(b.id, snapOf(b));
        if (b.owner && b.owner !== 'neutral') formerOwner.set(b.id, b.owner);
      }
      const snap = memory.get(b.id);
      if (!snap || (!own && !explored(snap.pos))) {
        const v = views.get(b.id);
        if (v && !v.busy) disposeView(v);
        continue;
      }
      show(snap, !vis, state);
    }
    // remembered buildings that no longer exist: keep the ghost until the hex is seen again
    for (const [id, snap] of [...memory]) {
      if (present.has(id)) continue;
      if (visible(snap.pos)) {
        memory.delete(id);
        const v = views.get(id);
        if (v && !v.busy) disposeView(v);
      } else show(snap, true, state);
    }
    for (const v of [...views.values()]) if (!memory.has(v.id) && !v.busy) disposeView(v);
    for (const id of [...formerOwner.keys()]) if (!memory.has(id) && !present.has(id)) formerOwner.delete(id);
  }

  // ───────── picking & unit placement support ─────────
  const pickBase = new THREE.Vector3();
  /** Nearest building mesh under the ray: a cylinder rejects most views, exact triangles decide. */
  function pick(ray: THREE.Ray): { hex: Hex; t: number } | null {
    let best: { hex: Hex; t: number } | null = null;
    raycaster.ray.copy(ray);
    raycaster.near = 0;
    raycaster.far = Infinity;
    for (const v of views.values()) {
      if (!v.root.visible) continue;
      pickBase.copy(v.root.position);
      pickBase.y -= 0.05;
      const tc = rayCylinder(ray.origin, ray.direction, pickBase, v.radius * 1.05 + 0.02, v.pickTop + 0.1);
      if (tc === null || (best && tc > best.t)) continue;
      const t = raycastMeshes(raycaster, v.holder);
      if (t !== null && (!best || t < best.t)) best = { hex: { ...v.snap.pos }, t };
    }
    return best;
  }
  function frontReach(h: Hex, dir: number): number | null {
    for (const v of views.values()) {
      if (!v.root.visible || v.snap.pos.q !== h.q || v.snap.pos.r !== h.r) continue;
      // the model is turned by 60°·rot about Y: world direction j is model direction j + 2·rot
      const rot = ((variantOf(lastState, v.snap.pos) % 6) + 6) % 6;
      return v.reach[(((dir + 2 * rot) % 12) + 12) % 12];
    }
    return null;
  }

  function show(snap: Snap, fogged: boolean, state: GameState): void {
    let v = views.get(snap.id);
    if (v?.busy) return;
    if (!v) v = createView(snap, state);
    else if (v.key !== keyOf(snap)) {
      const keepMax = v.maxLeft;
      build(v, snap);
      v.maxLeft = modeOf(snap) === 'normal' ? 0 : keepMax;
      place(v, state);
    } else {
      v.snap = { ...snap, pos: { ...snap.pos } };
      place(v, state);
    }
    v.fogged = fogged;
    v.progressTarget = targetProgress(v);
    applyLook(v);
    v.root.visible = true;
  }

  // ───────── animations ─────────
  async function animateConstructed(id: BuildingInstanceId, speed: number): Promise<void> {
    const sp = normSpeed(speed);
    let v = views.get(id);
    const b = lastState?.buildings[String(id)];
    if (!v) {
      if (!b) return;
      const vis = b.owner === ctx.viewer || visibleFn(b.pos);
      if (!vis) return;
      memory.set(id, snapOf(b));
      v = createView(snapOf(b), lastState);
    }
    const view = v;
    if (view.fogged) return;
    view.busy++;
    try {
      // finish the rising model / pip
      if (view.mode !== 'normal') {
        const p0 = view.progress;
        await sched.tween(0.45 / sp, (t) => { view.progress = p0 + (1 - p0) * easeOutCubic(t); view.progressTarget = view.progress; updateClip(view); });
        if (view.scaffold) {
          const sc = view.scaffold;
          await sched.tween(0.3 / sp, (t) => { sc.scale.set(1 + t * 0.1, 1 - easeInCubic(t), 1 + t * 0.1); });
        }
      }
      // rebuild as complete with the live state
      const snap = b ? snapOf(b) : { ...view.snap, buildLeft: 0, upgrading: false };
      memory.set(id, snap);
      build(view, snap);
      view.maxLeft = 0;
      place(view, lastState);
      view.progress = view.progressTarget = 1;
      updateClip(view);
      const top = view.root.position.clone().add(new THREE.Vector3(0, view.height * 0.6, 0));
      const color = view.snap.owner ? `#${ctx.factionColor(view.snap.owner).getHexString()}` : '#cccccc';
      ext?.dust(view.root.position, 1.6);
      ext?.shockwave(view.root.position, color, 1.1, 0.6 / sp);
      ext?.sparkles(top, FACTIONS[view.snap.owner ?? 'neutral']?.accent ?? '#ffd76a', 30, 0.5, 0.9);
      ext?.flash(top, '#fff0c8', 1.0, 0.35);
      const bannerS = view.banner;
      await sched.tween(0.55 / sp, (t) => {
        const s = 1 + 0.07 * bump(t) * (1 - t * 0.5);
        view.holder.scale.set(s, 1 + 0.1 * bump(t), s);
        if (bannerS) bannerS.scale.y = easeOutBack(t);
      });
      view.holder.scale.set(1, 1, 1);
      if (bannerS) bannerS.scale.y = 1;
    } finally {
      view.busy--;
    }
  }

  async function animateDestroyed(id: BuildingInstanceId, speed: number): Promise<void> {
    const sp = normSpeed(speed);
    const v = views.get(id);
    if (!v) { memory.delete(id); return; }
    if (v.fogged && !visibleFn(v.snap.pos)) return; // unseen: keep the remembered ghost
    v.busy++;
    try {
      const base = v.root.position.clone();
      const h = v.height;
      ext?.dust(base, 2.2, '#8f7f66');
      ext?.smokePuff(base.clone().add(new THREE.Vector3(0, h * 0.5, 0)), '#3d3631', 0.6, 14);
      ext?.rubble(base.clone().add(new THREE.Vector3(0, h * 0.4, 0)), 18, 1.1);
      ctx.shake(0.4);
      await sched.tween(0.25 / sp, (t) => {
        v.holder.position.set(Math.sin(t * 70) * 0.025, 0, Math.cos(t * 63) * 0.025);
      });
      ext?.rubble(base.clone().add(new THREE.Vector3(0, h * 0.25, 0)), 12, 0.8);
      ext?.flash(base.clone().add(new THREE.Vector3(0, 0.2, 0)), '#ffb36a', 1.4, 0.4);
      await sched.tween(0.95 / sp, (t) => {
        const k = easeInQuad(t);
        v.holder.position.set(Math.sin(t * 50) * 0.02 * (1 - t), -h * 0.95 * k, 0);
        v.holder.rotation.z = 0.18 * k;
        v.holder.rotation.x = -0.1 * k;
        if (v.banner) v.banner.rotation.z = -1.2 * k;
      });
      ext?.dust(base, 1.4, '#7a6b58');
    } finally {
      memory.delete(id);
      disposeView(v);
    }
  }

  // ───────── per frame ─────────
  function update(dt: number): void {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    sched.update(dt);
    bannerTime.value = ctx.time;
    projScreen.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    for (const v of views.values()) {
      if (!v.root.visible) continue;
      sphere.center.copy(v.root.position);
      sphere.center.y += v.height * 0.5;
      sphere.radius = Math.max(1, v.height);
      const onScreen = frustum.intersectsSphere(sphere);
      // progress line
      if (v.mode !== 'normal') {
        if (Math.abs(v.progress - v.progressTarget) > 1e-4) { v.progress = damp(v.progress, v.progressTarget, 3, dt); }
        updateClip(v);
        if (v.ringMat) v.ringMat.uniforms.uTime.value = ctx.time;
      }
      if (!onScreen) continue;
      const t = ctx.time + (v.seed % 100) * 0.37;
      for (const p of v.parts) {
        if (p.anim === 'windmill') p.obj.rotation.z += dt * (v.fogged ? 0 : 1.1);
        else if (p.anim === 'float') {
          p.obj.position.y = p.base.y + Math.sin(t * 1.6) * 0.04;
          p.obj.rotation.y += dt * 0.9;
        } else p.obj.rotation.y += dt;
      }
      if (!v.fogged) {
        for (const g of v.glows) {
          const k = g.flicker ? 0.85 + 0.15 * Math.sin(t * 13.0) * Math.sin(t * 7.3 + 1.0) : 0.9 + 0.12 * Math.sin(t * 2.2);
          g.sprite.scale.setScalar(g.base * k);
        }
        // chimney smoke
        if (ext && v.smoke.length && v.mode === 'normal' && v.snap.owner !== null) {
          v.smokeT -= dt;
          if (v.smokeT <= 0) {
            v.smokeT = v.smokeKind === 'forge' ? 0.42 + rand() * 0.2 : 1.3 + rand() * 0.8;
            for (const s of v.smoke) {
              const w = v.root.localToWorld(tmpV.copy(s));
              if (v.smokeKind === 'forge') ext.smokePuff(w, '#3a3532', 0.22, 1);
              else ext.smokePuff(w, '#b9b3aa', 0.14, 1);
            }
          }
        }
        // construction bustle
        if (ext && v.mode !== 'normal' && !v.busy) {
          v.dustT -= dt;
          if (v.dustT <= 0) {
            v.dustT = 1.4 + rand() * 1.4;
            const a = rand() * Math.PI * 2;
            const p = v.root.position.clone().add(new THREE.Vector3(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4));
            ext.dust(p, 0.35, '#b8a68a');
            p.y += v.height * (0.2 + rand() * 0.5) * v.progress;
            fx.hitSpark(p, 'ranged');
          }
        }
      }
    }
  }

  function dispose(): void {
    sched.clear();
    for (const v of [...views.values()]) disposeView(v);
    views.clear();
    memory.clear();
    formerOwner.clear();
    reachCache.clear();
    poleGeo.dispose(); finialGeo.dispose(); poleMat.dispose(); finialMat.dispose(); clothGeo.dispose();
    ctx.scene.remove(root);
  }

  return { sync, update, dispose, animateConstructed, animateDestroyed, pick, frontReach };
};
