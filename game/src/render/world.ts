// Scene, renderer, post-processing, camera controller, terrain, picking, event playback.
import * as THREE from 'three';
import type { BuildingInstanceId, FactionId, GameEvent, GameState, Hex } from '../core/types';
import { hexToWorld, inBounds, spiral, tileIndex, worldToHex, indexToHex } from '../core/hex';
import { FACTIONS } from '../data/factions';
import { BUILDINGS } from '../data/buildings';
import { computeTerritory } from '../sim/economy';
import type { LoadProgress, OverlayState, WorldRenderer } from './index';
import type {
  AssetLibrary, BuildingLayerApi, FxLayerApi, OverlayLayerApi, RenderContext, UnitLayerApi,
} from './types';
import { loadAssets } from './assets';
import { createUnitLayer } from './units';
import { createBuildingLayer } from './buildings';
import { createOverlayLayer } from './overlays';
import { createFxLayer } from './fx';
import { FogOfWar, MIST_LEVEL, createFowUniforms } from './fow';
import { generateWorldTextures, type WorldTextures } from './textures';
import { buildTerrain, marchRay, terrainFieldSteps, WATER_LEVEL, type Terrain, type TerrainField } from './terrain';
import { buildWater, type Water } from './water';
import { buildDecor, type Decor } from './decor';
import { createSky, type Sky } from './sky';
import { createPost, type PostChain } from './post';
import { DEFAULT_DIST, RtsCamera } from './camera';
import { playEventSequence, takeSnapshot, type PlaybackPlan, type Snapshot } from './playback';

const DEFAULT_OVERLAYS: OverlayState = {
  selectedUnit: null, hoverHex: null, reach: [], path: [], attackable: [], forecastTarget: null,
  areaCenter: null, areaRadius: 0, areaValid: true, spellRanges: [], showGrid: false,
};

// ───────────────────────────── no-op layers (used only if a layer factory fails) ─────────────────────────────
const noopUnits = (): UnitLayerApi => ({
  sync() {}, update() {}, dispose() {},
  async animateMove() {}, async animateCombat() {}, async animateDeath() {}, async animateSpawn() {}, async playClip() {},
  unitAnchor: () => null, refreshUnit() {},
});
const noopBuildings = (): BuildingLayerApi => ({ sync() {}, update() {}, dispose() {}, async animateConstructed() {}, async animateDestroyed() {} });
const noopOverlays = (): OverlayLayerApi => ({ set() {}, update() {}, dispose() {} });
const noopFx = (): FxLayerApi => ({
  async projectile() {}, damageNumber() {}, burst() {}, async spell() {}, levelUp() {}, hitSpark() {}, update() {}, dispose() {},
});

/** Territory owners; falls back to a local implementation of the DESIGN §5 rule if the sim one is unavailable. */
function territory(state: GameState): (FactionId | null)[] {
  try {
    return computeTerritory(state);
  } catch {
    const n = state.width * state.height;
    const owners: (FactionId | null)[] = new Array(n).fill(null);
    const age = new Array<number>(n).fill(Infinity);
    const list = Object.values(state.buildings).filter((b) => b.owner).sort((a, b) => a.foundedRound - b.foundedRound || a.id - b.id);
    for (const b of list) {
      const complete = b.buildLeft === 0 || b.upgrading;
      const radius = complete ? BUILDINGS[b.type].territoryRadius : 0;
      for (const h of spiral(b.pos, radius)) {
        if (!inBounds(h, state.width, state.height)) continue;
        const i = tileIndex(h, state.width);
        if (b.foundedRound < age[i]) { age[i] = b.foundedRound; owners[i] = b.owner; }
      }
    }
    return owners;
  }
}

export function createWorldRenderer(canvas: HTMLCanvasElement): WorldRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // PCFSoftShadowMap was removed in three r18x; PCF + shadow.radius gives the soft (Vogel-disk) filter.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Rendered once per frame (drawFrame). With autoUpdate every renderer.render() redraws it, and the
  // GTAO normal pre-pass is a second render() of the scene: the whole shadow pass ran twice.
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x0b0e14, 1);
  renderer.info.autoReset = false; // counted per frame (all passes) in the loop

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x77889b, 0.0085);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.3, 2500);
  camera.position.set(0, 20, 20);

  const fowU = createFowUniforms();
  const fow = new FogOfWar(fowU);
  const keyState = new Set<string>();

  let assets: AssetLibrary | null = null;
  let textures: WorldTextures | null = null;
  let sky: Sky | null = null;
  let post: PostChain | null = null;
  let terrain: Terrain | null = null;
  let water: Water | null = null;
  let decor: Decor | null = null;
  let units: UnitLayerApi = noopUnits();
  let buildings: BuildingLayerApi = noopBuildings();
  let overlays: OverlayLayerApi = noopOverlays();
  let fx: FxLayerApi = noopFx();
  let state: GameState | null = null;
  let viewer: FactionId = 'valen';
  let overlayState: OverlayState = { ...DEFAULT_OVERLAYS };
  let snapshot: Snapshot = { units: {}, buildings: {} };
  let known = new Uint8Array(0);          // last-known "has building" per tile (as seen by the viewer)
  let quality: 'low' | 'high' = 'high';
  let ready = false;
  /** The current world's programs have been compiled off-thread and one frame drawn (warmup()). */
  let warmed = false;
  const shadowDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  let disposed = false;
  let gridTarget = 0;
  let hoverTarget = 0;
  /** The terrain field prepareGame() computed ahead of setGame() for that state. */
  let prepared: TerrainField | null = null;
  /** Bumped whenever the world is replaced or torn down: playback started before then is stale. */
  let generation = 0;
  /** An event sequence is animating: the layers show its display model, not the final state. */
  let playing = false;
  /** False while an opaque screen (title, loading, results) covers the canvas. */
  let active = true;
  let idleTime = 0;
  const reported = new Set<string>();
  const reportError = (where: string, e: unknown) => {
    if (reported.has(where)) return;
    reported.add(where);
    console.error(`[render] ${where} failed:`, e);
  };

  const heightAt = (x: number, z: number) => (terrain ? Math.max(terrain.heightAt(x, z), WATER_LEVEL - 0.04) : 0);
  const colorCache = new Map<string, THREE.Color>();
  const ctx: RenderContext = {
    scene, camera, renderer,
    get assets(): AssetLibrary {
      if (!assets) throw new Error('assets not loaded');
      return assets;
    },
    heightAt,
    hexCenter(h: Hex) {
      const w = hexToWorld(h);
      let y = heightAt(w.x, w.z);
      if (state && inBounds(h, state.width, state.height)) {
        const t = state.tiles[tileIndex(h, state.width)].terrain;
        if (t === 'water') y = WATER_LEVEL;
        else if (t === 'shallows') y = Math.max(y, WATER_LEVEL - 0.05);
      }
      return new THREE.Vector3(w.x, y, w.z);
    },
    factionColor(f: FactionId | null) {
      const key = f ?? 'none';
      let c = colorCache.get(key);
      if (!c) {
        c = f ? new THREE.Color(FACTIONS[f].color) : new THREE.Color(0.62, 0.6, 0.56);
        colorCache.set(key, c);
      }
      return c.clone();
    },
    shake(amount: number) { rts.shake(amount); },
    viewer: 'valen',
    time: 0,
    viewportHeight: () => height,
    buildingFront: (h: Hex, dir: number) => buildings.frontReach?.(h, dir) ?? null,
  } as RenderContext;

  const rts = new RtsCamera({ camera, canvas, heightAt });

  // ── sizing ──
  let width = 1, height = 1;
  const pixelRatio = () => (quality === 'high' ? Math.min(window.devicePixelRatio || 1, 1.75) : 1);
  const resize = () => {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    width = w; height = h;
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post?.setSize(w, h, pixelRatio());
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  // ── shadows: a texel-snapped square fitted to what the camera sees ──
  // The sun is orthographic, so a caster and the shadow it throws project to the same light-space
  // point: the light-space bounds of the visible ground (and of anything standing on it, up to the
  // peaks) hold every caster whose shadow can be seen. Off-screen casters stay out of the pass.
  const lightRight = new THREE.Vector3(), lightUp = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const shadowRay = new THREE.Raycaster();
  const shadowNdc = new THREE.Vector2();
  const shadowP = new THREE.Vector3();
  const SHADOW_SAMPLES: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 1], [0, -1], [-1, 0], [1, 0]];
  let shadowHalf = 0;
  let shadowBaseRadius = 2.5;
  const updateShadow = () => {
    if (!sky) return;
    const sun = sky.sun;
    const dir = sky.uniforms.uSunDir.value;
    lightRight.crossVectors(UP, dir).normalize();
    lightUp.crossVectors(dir, lightRight).normalize();
    camera.updateMatrixWorld();
    const yLo = WATER_LEVEL - 0.3;
    const yHi = Math.max(rts.target.y, WATER_LEVEL) + 3.2; // mountain massifs, peak props, castle towers
    const maxT = Math.max(40, rts.distance * 3);
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    for (const [nx, ny] of SHADOW_SAMPLES) {
      shadowRay.setFromCamera(shadowNdc.set(nx, ny), camera);
      const o = shadowRay.ray.origin, d = shadowRay.ray.direction;
      for (const y of [yLo, yHi]) {
        let t = d.y < -1e-4 ? (y - o.y) / d.y : maxT;
        t = THREE.MathUtils.clamp(t, 0, maxT);
        shadowP.copy(o).addScaledVector(d, t);
        const r = shadowP.dot(lightRight), u = shadowP.dot(lightUp);
        r0 = Math.min(r0, r); r1 = Math.max(r1, r); u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      }
    }
    // square (PCF blurs by texelSize.x on both axes), padded, in 2-unit steps with some hysteresis
    const need = Math.max(r1 - r0, u1 - u0) / 2 + 1.5;
    const q = THREE.MathUtils.clamp(Math.ceil(need / 2) * 2, 8, 60);
    const sc = sun.shadow.camera;
    if (q > shadowHalf || q < shadowHalf - 4) {
      shadowHalf = q;
      sc.left = -q; sc.right = q; sc.top = q; sc.bottom = -q;
      sc.updateProjectionMatrix();
    }
    const half = shadowHalf;
    // Same world-space softness as the old zoom-sized box (radius is in texels).
    const oldHalf = Math.round(THREE.MathUtils.clamp(rts.distance * 0.95 + 7, 12, 50) / 2) * 2;
    sun.shadow.radius = THREE.MathUtils.clamp(shadowBaseRadius * (oldHalf / half), shadowBaseRadius, shadowBaseRadius * 2.4);
    const texel = (2 * half) / sun.shadow.mapSize.x;
    const cx = Math.round((r0 + r1) / 2 / texel) * texel;
    const cy = Math.round((u0 + u1) / 2 / texel) * texel;
    const cz = rts.target.dot(dir);
    const snapped = shadowP.set(0, 0, 0).addScaledVector(lightRight, cx).addScaledVector(lightUp, cy).addScaledVector(dir, cz);
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(dir, 80);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  };

  // ── frame loop ──
  let raf = 0;
  let last = performance.now();
  let time = 0;
  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    time += dt;
    ctx.time = time;
    fowU.uTime.value = time;
    renderer.info.reset();
    if (!ready || !post) { renderer.clear(); return; }
    if (!active) {
      // Nothing of the scene is visible: skip the camera, sky, shadows and post chain entirely.
      // The layers still tick a few times a second so any animation in flight settles.
      idleTime += dt;
      if (idleTime >= 0.25) { updateLayers(Math.min(0.1, idleTime)); idleTime = 0; }
      return;
    }
    rts.update(dt, keyState);
    fow.tick(dt);
    fowU.uGrid.value += (gridTarget - fowU.uGrid.value) * (1 - Math.exp(-10 * dt));
    const hv = fowU.uHoverHex.value;
    hv.z += (hoverTarget - hv.z) * (1 - Math.exp(-18 * dt));
    sky?.update(camera);
    updateShadow();
    updateLayers(dt);
    cullDecor();
    drawFrame(dt, time);
  };
  /** The post chain renders the scene more than once (colour, AO pre-pass): the shadow map only in the first. */
  function drawFrame(dt: number, t: number): void {
    if (!post) return;
    renderer.shadowMap.needsUpdate = true;
    post.render(dt, t);
  }
  /** Decor is culled per cell against the view, and against the sun's view of what is on screen. */
  const viewFrustum = new THREE.Frustum();
  const viewProj = new THREE.Matrix4();
  function cullDecor(): void {
    if (!decor || !sky) return;
    camera.updateMatrixWorld();
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    viewFrustum.setFromProjectionMatrix(viewProj);
    sky.sun.shadow.updateMatrices(sky.sun);
    try { decor.cull(viewFrustum, sky.uniforms.uSunDir.value, sky.sun.shadow.getFrustum()); } catch (e) { reportError('decor.cull', e); }
  }
  function updateLayers(dt: number): void {
    try { units.update(dt); } catch (e) { reportError('units.update', e); }
    try { buildings.update(dt); } catch (e) { reportError('buildings.update', e); }
    try { overlays.update(dt); } catch (e) { reportError('overlays.update', e); }
    try { fx.update(dt); } catch (e) { reportError('fx.update', e); }
  }
  raf = requestAnimationFrame(frame);

  // ── visibility helpers ──
  const predicates = (s: GameState) => {
    const fs = s.factions[viewer];
    const vis = fs?.visible ?? [];
    const exp = fs?.explored ?? [];
    return {
      visible: (h: Hex) => inBounds(h, s.width, s.height) && vis[tileIndex(h, s.width)] === 1,
      explored: (h: Hex) => inBounds(h, s.width, s.height) && exp[tileIndex(h, s.width)] === 1,
    };
  };

  /** Update last-known building flags and the per-tile dirt mask. */
  const updateKnown = (s: GameState, initial: boolean): Uint8Array => {
    const n = s.width * s.height;
    if (known.length !== n) known = new Uint8Array(n);
    const fs = s.factions[viewer];
    const dirt = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const t = s.tiles[i];
      if (fs?.visible[i] || (initial && fs?.explored[i])) known[i] = t.building != null ? 1 : 0;
      dirt[i] = known[i] || (t.terrain === 'ruins' && fs?.explored[i]) ? 1 : 0;
    }
    return dirt;
  };

  const refreshFog = (s: GameState, immediate: boolean) => {
    const dirt = updateKnown(s, immediate);
    const occupied = new Uint8Array(s.width * s.height);
    const vis = s.factions[viewer]?.visible;
    for (const u of Object.values(s.units)) {
      if (!inBounds(u.pos, s.width, s.height)) continue;
      const i = tileIndex(u.pos, s.width);
      if (vis?.[i]) occupied[i] = 1;
    }
    fow.update(s, viewer, dirt, territory(s), immediate, occupied);
    decor?.setMask(known, s.factions[viewer]?.explored ?? null);
  };

  /**
   * Overlays as drawn. Selection ring, reach tint and attack marks are resolved against the live
   * (final) state, so they are held back while playback still shows units on their way there.
   */
  const shownOverlays = (): OverlayState => (playing
    ? { ...overlayState, selectedUnit: null, reach: [], attackable: [], path: [], forecastTarget: null }
    : overlayState);

  const syncLayers = (s: GameState) => {
    const { visible, explored } = predicates(s);
    // buildings first: units on a building hex stand clear of its (measured) front
    try { buildings.sync(s, visible, explored); } catch (e) { reportError('buildings.sync', e); }
    try { units.sync(s, visible, explored); } catch (e) { reportError('units.sync', e); }
    try { overlays.set(shownOverlays(), s); } catch (e) { reportError('overlays.set', e); }
  };

  const disposeGame = () => {
    generation++;
    playing = false;
    for (const l of [units, buildings]) { try { l.dispose(); } catch (e) { reportError('layer.dispose', e); } }
    try { overlays.dispose(); } catch (e) { reportError('overlays.dispose', e); }
    try { fx.dispose(); } catch (e) { reportError('fx.dispose', e); }
    units = noopUnits(); buildings = noopBuildings(); overlays = noopOverlays(); fx = noopFx();
    if (terrain) { scene.remove(terrain.group); terrain.dispose(); terrain = null; }
    if (water) { scene.remove(water.mesh); water.dispose(); water = null; }
    if (decor) { scene.remove(decor.group); decor.dispose(); decor = null; }
  };

  const createLayers = () => {
    try { fx = createFxLayer(ctx); } catch (e) { reportError('createFxLayer', e); fx = noopFx(); }
    try { units = createUnitLayer(ctx, fx); } catch (e) { reportError('createUnitLayer', e); units = noopUnits(); }
    try { buildings = createBuildingLayer(ctx, fx); } catch (e) { reportError('createBuildingLayer', e); buildings = noopBuildings(); }
    try { overlays = createOverlayLayer(ctx); } catch (e) { reportError('createOverlayLayer', e); overlays = noopOverlays(); }
  };

  /** Let other tasks (input, the loading screen's animation) run. */
  const nextTask = () => new Promise<void>((resolve) => {
    if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(null);
  });

  /**
   * Behind the loading screen: first-use every compiled program and upload every texture the scene's
   * materials use, yielding between small batches, so the first frame finds nothing left to wait for.
   */
  const primeGpu = async (stale: () => boolean) => {
    let t0 = performance.now();
    const breathe = async () => {
      if (performance.now() - t0 < 12) return false;
      await nextTask();
      t0 = performance.now();
      return stale();
    };
    for (const p of [...(renderer.info.programs ?? [])]) {
      try { p.getUniforms(); p.getAttributes(); } catch (e) { reportError('warmup.program', e); }
      if (await breathe()) return;
    }
    const textures = new Set<THREE.Texture>();
    const take = (v: unknown) => {
      if ((v as THREE.Texture | null)?.isTexture) textures.add(v as THREE.Texture);
      else if (Array.isArray(v)) for (const x of v) if ((x as THREE.Texture | null)?.isTexture) textures.add(x as THREE.Texture);
    };
    const seenMats = new Set<THREE.Material>();
    scene.traverse((o) => {
      const mo = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mo) ? mo : mo ? [mo] : []) {
        if (seenMats.has(m)) continue;
        seenMats.add(m);
        for (const v of Object.values(m)) take(v);
        // uniforms as compiled (incl. those a patched shader added in onBeforeCompile)
        const u = (renderer.properties.get(m) as { uniforms?: Record<string, { value: unknown }> }).uniforms;
        if (u) for (const k in u) take(u[k]?.value);
      }
    });
    for (const tex of textures) {
      if ((tex as { isRenderTargetTexture?: boolean }).isRenderTargetTexture) continue;
      try { renderer.initTexture(tex); } catch (e) { reportError('warmup.texture', e); }
      if (await breathe()) return;
    }
  };

  /** Resolves once the GPU has finished the commands issued so far (a fence, polled between tasks; max 2 s). */
  const gpuSettled = async (stale: () => boolean) => {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== 'function') return;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return;
    gl.flush();
    const t0 = performance.now();
    try {
      while (performance.now() - t0 < 2000 && !stale()) {
        await new Promise<void>((r) => setTimeout(r, 4));
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED || st === gl.WAIT_FAILED) break;
      }
    } finally {
      gl.deleteSync(sync);
    }
  };

  /** World point (lifted to a unit's mid height) to client pixels. */
  const project = (p: THREE.Vector3): { x: number; y: number; visible: boolean } => {
    p.y += 0.25;
    p.project(camera);
    const r = canvas.getBoundingClientRect();
    const x = r.left + ((p.x + 1) / 2) * r.width;
    const y = r.top + ((1 - p.y) / 2) * r.height;
    const visible = p.z > -1 && p.z < 1 && p.x >= -1.05 && p.x <= 1.05 && p.y >= -1.05 && p.y <= 1.05;
    return { x, y, visible };
  };

  const api: WorldRenderer & { edgePan: boolean; readonly isDragging: boolean; readonly camera: RtsCamera; readonly debugScene: THREE.Scene; readonly debugTextures: WorldTextures | null; debugInfo(): Record<string, number>; debugDecorNoCull(on: boolean): void } = {
    keyState,
    get edgePan() { return rts.edgePan; },
    set edgePan(v: boolean) { rts.edgePan = v; },
    get isDragging() { return rts.dragging; },
    get camera() { return rts; },
    /** Debug: the three.js scene and generated textures (dev tools only). */
    get debugScene() { return scene; },
    get debugTextures() { return textures; },
    /** Debug: last frame's draw statistics. */
    debugInfo() {
      const r = renderer.info;
      return { calls: r.render.calls, triangles: r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs?.length ?? 0 };
    },
    /** Debug (perf comparisons): disable decor culling and shadow tiers (every prop drawn in every pass). */
    debugDecorNoCull(on: boolean) { decor?.setDebugNoCull(on); },

    async init(onProgress: LoadProgress) {
      if (ready) { onProgress(1, 'Ready'); return; }
      assets = await loadAssets((f, l) => onProgress(f * 0.6, l));
      onProgress(0.62, 'Painting the land');
      textures = await generateWorldTextures(renderer, assets, (f) => onProgress(0.62 + f * 0.3, 'Painting the land'));
      fowU.uNoiseTex.value = textures.noise;
      sky = createSky(textures.noise, fowU.uTime);
      scene.add(sky.dome, sky.sun, sky.sun.target, sky.hemi);
      onProgress(0.94, 'Lighting the sky');
      scene.environment = sky.environment(renderer);
      scene.environmentIntensity = 0.42;
      (scene.fog as THREE.FogExp2).color.copy(sky.fogColor);
      fowU.uFogColor.value.copy(sky.fogColor);
      post = createPost(renderer, scene, camera, fowU);
      post.setQuality(quality);
      applyShadowQuality();
      resize();
      // Compile the map-independent programs (sky, every post pass) now, behind the boot screen,
      // instead of inside the first in-game frame.
      try {
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(post.composer.readBuffer);
        await renderer.compileAsync(scene, camera);
        renderer.setRenderTarget(prevRT);
        sky.update(camera);
        drawFrame(0, 0);
      } catch (e) { reportError('init.warmup', e); }
      ready = true;
      onProgress(1, 'Ready');
    },

    async prepareGame(s: GameState) {
      if (prepared?.state === s) return;
      const steps = terrainFieldSteps(s);
      let t0 = performance.now();
      for (;;) {
        const r = steps.next();
        if (r.done) { prepared = r.value; return; }
        if (performance.now() - t0 > 12) {
          await nextTask();
          if (disposed) return;
          t0 = performance.now();
        }
      }
    },

    setGame(s: GameState, v: FactionId) {
      if (!textures || !assets || !sky) throw new Error('WorldRenderer.init() must complete before setGame()');
      disposeGame();
      state = s;
      viewer = v;
      ctx.viewer = v;
      known = new Uint8Array(s.width * s.height);
      reported.clear();
      terrain = buildTerrain(s, textures, fowU, prepared?.state === s ? prepared : null);
      prepared = null;
      scene.add(terrain.group);
      fow.setup(s, terrain.rect);
      const mr = terrain.mapRect;
      fowU.uMapRect.value.set(mr.minX, mr.minZ, mr.maxX, mr.maxZ);
      water = buildWater(terrain, fowU, sky.uniforms, textures.waves);
      scene.add(water.mesh);
      decor = buildDecor(s, terrain, assets, fowU);
      decor.setQuality(quality);
      scene.add(decor.group);
      createLayers();
      // zoom-aware clamp (camera.ts): the view may show at most this much ground past the map edge
      // (beyond the jagged hex outline); the near edge of the view is magnified, so keep it small
      rts.setBounds(mr, { slack: 1 });

      // Start over the viewer's leader (or castle, or the map centre).
      const fs = s.factions[v];
      const leader = fs?.leaderId != null ? s.units[String(fs.leaderId)] : undefined;
      const castle = fs?.castleId != null ? s.buildings[String(fs.castleId)] : undefined;
      const h = leader?.pos ?? castle?.pos ?? indexToHex(Math.floor(s.height / 2) * s.width + Math.floor(s.width / 2), s.width);
      const w = hexToWorld(h);
      rts.focusOn(w.x, w.z, true, DEFAULT_DIST);

      refreshFog(s, true);
      syncLayers(s);
      snapshot = takeSnapshot(s);
      warmed = false;
    },

    async warmup(onProgress?: (f: number, label: string) => void) {
      if (!terrain || !post || !sky || warmed) return;
      const gen = generation;
      const stale = () => gen !== generation || disposed;
      onProgress?.(0, 'Kindling the aether…');
      rts.update(0, new Set());
      sky.update(camera);
      updateShadow();
      // Programs are keyed by the render target (tone mapping, output colour space): compile them
      // for an off-screen target, as the composer and the shadow map draw them.
      const prevRT = renderer.getRenderTarget();
      renderer.setRenderTarget(post.composer.readBuffer);
      try {
        await renderer.compileAsync(scene, camera);
        if (stale()) return;
        onProgress?.(0.5, 'Kindling the aether…');
        // Shadow-caster and AO pre-pass variants are never on `object.material`: proxies carry them,
        // set up as WebGLShadowMap.getDepthMaterial and the AO pass will draw each mesh (side flipped
        // for the shadow pass, the colour map's alpha test, instance colours, skinning), so the
        // hidden frame below does not have to compile (and wait for) any program itself.
        const depthProxies = new THREE.Group();
        const aoProxies = new THREE.Group();
        const aoMat = post.aoMaterial;
        const seen = new Set<string>();
        const plainDepth = new THREE.MeshDepthMaterial();
        const white = new THREE.Color(1, 1, 1);
        const vsm = renderer.shadowMap.type === THREE.VSMShadowMap;
        const flip = (side: THREE.Side): THREE.Side => (side === THREE.FrontSide ? THREE.BackSide : side === THREE.BackSide ? THREE.FrontSide : side);
        scene.traverseVisible((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const mm = Array.isArray(m.material) ? m.material[0] : m.material;
          if (!mm) return;
          const skinned = (m as THREE.SkinnedMesh).isSkinnedMesh === true;
          const inst = (m as THREE.InstancedMesh).isInstancedMesh === true;
          const tinted = inst && !!(m as THREE.InstancedMesh).instanceColor;
          const shape = `${inst}|${tinted}|${skinned}|${m.receiveShadow}|${!!m.geometry.getAttribute('color')}`;
          const add = (group: THREE.Group, mat: THREE.Material) => {
            let p: THREE.Mesh;
            if (skinned) {
              const sm = m as THREE.SkinnedMesh;
              const sp = new THREE.SkinnedMesh(m.geometry, mat);
              sp.bind(sm.skeleton, sm.bindMatrix);
              p = sp;
            } else if (inst) {
              const ip = new THREE.InstancedMesh(m.geometry, mat, 1);
              if (tinted) ip.setColorAt(0, white);
              p = ip;
            } else {
              p = new THREE.Mesh(m.geometry, mat);
            }
            p.receiveShadow = m.receiveShadow;
            group.add(p);
          };
          if (m.castShadow) {
            const base = m.customDepthMaterial ?? plainDepth;
            const side = mm.shadowSide ?? (vsm ? mm.side : flip(mm.side));
            const alphaTest = mm.alphaToCoverage ? 0.5 : mm.alphaTest;
            const map = (mm as THREE.MeshStandardMaterial).map ?? null;
            const alphaMap = (mm as THREE.MeshStandardMaterial).alphaMap ?? null;
            const key = `d|${base.uuid}|${side}|${!!map}|${!!alphaMap}|${alphaTest > 0}|${shape}`;
            if (!seen.has(key)) {
              seen.add(key);
              const mat = base.clone() as THREE.MeshDepthMaterial;
              // a patched depth shader keys its program on onBeforeCompile (not copied by clone())
              mat.onBeforeCompile = base.onBeforeCompile;
              mat.customProgramCacheKey = base.customProgramCacheKey;
              mat.side = side;
              mat.alphaTest = alphaTest;
              mat.map = map;
              mat.alphaMap = alphaMap;
              add(depthProxies, mat);
            }
          }
          if (aoMat && quality === 'high' && !mm.transparent && mm.depthWrite && !(mm as THREE.ShaderMaterial).isShaderMaterial && !o.userData.noAO) {
            const key = `a|${shape}`;
            if (!seen.has(key)) { seen.add(key); add(aoProxies, aoMat); }
          }
        });
        // The shadow pass draws without the scene (no fog).
        const fog = scene.fog;
        scene.fog = null;
        let depthDone: Promise<unknown>;
        try { depthDone = renderer.compileAsync(depthProxies, camera, scene); } finally { scene.fog = fog; }
        await Promise.all([depthDone, renderer.compileAsync(aoProxies, camera, scene)]);
        if (stale()) return;
      } catch (e) {
        reportError('warmup', e);
      } finally {
        renderer.setRenderTarget(prevRT);
      }
      onProgress?.(0.85, 'Kindling the aether…');
      // The first use of each program (uniform lookup, error check: it waits for the driver) and the
      // texture uploads, a few at a time, so no single task stalls while the loading screen is up.
      await primeGpu(stale);
      if (stale()) return;
      onProgress?.(0.95, 'Kindling the aether…');
      // One hidden frame (the loading screen still covers the canvas) draws the shadow map once.
      try {
        updateLayers(0);
        cullDecor();
        drawFrame(0, time);
      } catch (e) { reportError('warmup.render', e); }
      // The GPU process may still be compiling / uploading for that frame: wait for it (without
      // blocking the page) so the first visible frame does not.
      await gpuSettled(stale);
      if (stale()) return;
      warmed = true;
      onProgress?.(1, 'Ready');
    },

    sync(s: GameState) {
      state = s;
      if (!terrain) return;
      refreshFog(s, false);
      syncLayers(s);
      snapshot = takeSnapshot(s);
    },

    async playEvents(s: GameState, events: GameEvent[], speed: number, plan?: PlaybackPlan) {
      state = s;
      if (!terrain || events.length === 0) { if (terrain) api.sync(s); return; }
      const gen = generation;
      const current = () => gen === generation;
      playing = true;
      try { overlays.set(shownOverlays(), s); } catch (e) { reportError('overlays.set', e); }
      try {
        await playEventSequence({
          ctx,
          layers: { units, buildings, fx },
          refreshFog: (st) => { if (current()) refreshFog(st, false); },
          reportError,
          cancelled: () => !current(),
        }, s, snapshot, events, speed, plan);
      } finally {
        if (current()) playing = false;
      }
      // A game loaded or started meanwhile owns the world now: never sync this one into it.
      if (!current()) return;
      api.sync(s);
    },

    setOverlays(o: Partial<OverlayState>) {
      overlayState = { ...overlayState, ...o };
      gridTarget = overlayState.showGrid ? 1 : 0;
      // hovered land hex: outlined by the terrain shader itself (hugs the surface, constant width)
      const hh = overlayState.hoverHex;
      const land = !!(hh && state && inBounds(hh, state.width, state.height) && !['water', 'shallows'].includes(state.tiles[tileIndex(hh, state.width)].terrain));
      if (land && hh) {
        const hv = fowU.uHoverHex.value;
        if (hv.x !== hh.q || hv.y !== hh.r) { hv.x = hh.q; hv.y = hh.r; hv.z = Math.min(hv.z, 0.35); }
      }
      hoverTarget = land ? 1 : 0;
      try { overlays.set(shownOverlays(), state); } catch (e) { reportError('overlays.set', e); }
    },

    setActive(on: boolean) {
      if (active === on) return;
      active = on;
      idleTime = 0;
    },

    clearGame() {
      disposeGame();
      state = null;
      snapshot = { units: {}, buildings: {} };
      known = new Uint8Array(0);
      fow.clear();
      hoverTarget = 0;
      fowU.uHoverHex.value.z = 0;
    },

    pickHex(clientX: number, clientY: number): Hex | null {
      if (!terrain || !state) return null;
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const o = ray.ray.origin, d = ray.ray.direction;
      const t = terrain;
      const displayed = (x: number, z: number) => {
        const e = fow.exploredAt(x, z);
        const h = Math.max(t.heightAt(x, z), WATER_LEVEL);
        return MIST_LEVEL + (h - MIST_LEVEL) * e;
      };
      const ground = marchRay(o, d, displayed);
      let best = ground ? o.distanceTo(ground) : Infinity;
      let bestHex: Hex | null = ground ? worldToHex(ground.x, ground.z) : null;
      const inMap = (h: Hex | null) => !!h && inBounds(h, state!.width, state!.height);
      // Units win wherever they are drawn, even behind a mountain or a wall (their x-ray silhouette
      // and always-on-top bar show there), so clicking what you see of a unit selects it.
      let uh: { hex: Hex; t: number } | null = null;
      try { uh = units.pick?.(ray.ray) ?? null; } catch (e) { reportError('units.pick', e); }
      if (uh && inMap(uh.hex)) return uh.hex;
      // Buildings: exact triangles, nearest hit against the ground.
      let bh: { hex: Hex; t: number } | null = null;
      try { bh = buildings.pick?.(ray.ray) ?? null; } catch (e) { reportError('buildings.pick', e); }
      if (bh && bh.t < best) { best = bh.t; bestHex = bh.hex; }
      if (!inMap(bestHex)) return null;
      return bestHex;
    },

    cameraFootprint(): { x: number; z: number }[] | null {
      if (!terrain || !state) return null;
      camera.updateMatrixWorld();
      const y = Math.max(WATER_LEVEL, rts.target.y);
      const out: { x: number; z: number }[] = [];
      const ray = new THREE.Raycaster();
      const flat = new THREE.Vector3();
      for (const [x, yy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
        ray.setFromCamera(new THREE.Vector2(x, yy), camera);
        const o = ray.ray.origin, d = ray.ray.direction;
        const cap = 3 * 46;
        let px: number, pz: number;
        if (d.y < -1e-3) {
          const tt = (y - o.y) / d.y;
          px = o.x + d.x * tt; pz = o.z + d.z * tt;
          const hd = Math.hypot(px - o.x, pz - o.z);
          if (hd > cap) { px = o.x + ((px - o.x) * cap) / hd; pz = o.z + ((pz - o.z) * cap) / hd; }
        } else {
          flat.set(d.x, 0, d.z).normalize();
          px = o.x + flat.x * cap; pz = o.z + flat.z * cap;
        }
        out.push({ x: px, z: pz });
      }
      return out;
    },

    focus(h: Hex, instant = false, pace = 1) {
      const w = hexToWorld(h);
      return rts.focusOn(w.x, w.z, instant, undefined, pace);
    },

    hexToScreen(h: Hex) {
      return project(ctx.hexCenter(h));
    },

    hexToView(h: Hex, from?: Hex) {
      // Moving the camera by d shows p where the current camera shows p - d.
      const p = ctx.hexCenter(h);
      const fw = from ? hexToWorld(from) : null;
      const goal = fw ? rts.restingTarget(fw.x, fw.z) : rts.restingTarget();
      p.x -= goal.x - rts.target.x;
      p.z -= goal.z - rts.target.z;
      return project(p);
    },
    setQuality(q: 'low' | 'high') {
      quality = q;
      post?.setQuality(q);
      decor?.setQuality(q);
      applyShadowQuality();
      resize();
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      disposeGame();
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      rts.dispose();
      fow.dispose();
      post?.dispose();
      sky?.dispose();
      textures?.dispose();
      scene.environment?.dispose();
      shadowDepth.dispose();
      renderer.dispose();
    },
  };

  function applyShadowQuality() {
    if (!sky) return;
    const size = quality === 'high' ? 4096 : 1024;
    const sh = sky.sun.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
    }
    shadowBaseRadius = quality === 'high' ? 2.5 : 1.5;
    sh.radius = shadowBaseRadius;
  }

  return api;
}

export type { BuildingInstanceId };
