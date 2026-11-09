// Internal contracts between render/world.ts (scene, camera, terrain, loop) and the
// entity layers (units, buildings, overlays, fx). See ASSETS.md for model conventions.
import type * as THREE from 'three';
import type { AttackKind, FactionId, GameState, Hex, SpellId, StrikeEvent, UnitId, BuildingInstanceId } from '../core/types';
import type { OverlayState } from './index';

/** World-space height of one unit model (hex radius = 1). Units stand taller than trees and boulders. */
export const UNIT_HEIGHT = 0.8;
export const BUILDING_FOOTPRINT = 0.82; // radius buildings are scaled to fit (default)

/**
 * Per-model overrides of the building normalisation (GLB key → footprint radius, extra height
 * scale, albedo tint). The seat of power is the dominant silhouette; cottages sit inside their hex.
 * Castle 1.0 + house 0.7 = 1.7 < 1.732 (neighbouring hex centres), so they never interpenetrate.
 */
export const BUILDING_MODEL_TUNING: Record<string, { footprint?: number; yScale?: number; tint?: [number, number, number] }> = {
  castle_valen: { footprint: 1.0 },
  castle_ashen: { footprint: 1.0, tint: [1.2, 1.15, 1.22] },
  castle_thorn: { footprint: 1.0, yScale: 1.2, tint: [1.45, 1.3, 1.2] },
  house: { footprint: 0.7 },
};

/**
 * Ground speed (world units/s at animation speed 1) of a humanoid moving on foot. GLB units play
 * their long-stride `run` cycle at this pace with planted feet; models without one fall back to the
 * short-stride `walk` (a brisk cadence) and procedural units to their own cycle.
 */
export const FOOT_SPEED = 1.8;
/** Planted-foot speed of a GLB walk cycle at timeScale 1 (model heights/s) when its sidecar gives none. */
export const DEFAULT_WALK_SPEED = 0.56;
/** Same for the `run` cycle (sidecar `run_speed`). */
export const DEFAULT_RUN_SPEED = 2.1;
/** Length of one GLB run cycle at timeScale 1 (blender/rig_anim.py clip_run). */
export const RUN_CYCLE = 0.6;
/** `action.timeScale` that keeps a walk cycle's feet planted at ground speed `v` (blender/README). */
export function walkTimeScale(v: number, walkSpeed: number = DEFAULT_WALK_SPEED): number {
  const ws = walkSpeed > 0 && Number.isFinite(walkSpeed) ? walkSpeed : DEFAULT_WALK_SPEED;
  return v / (ws * UNIT_HEIGHT);
}

export interface SkinnedAsset {
  scene: THREE.Object3D;            // original (do not add to the scene; clone with SkeletonUtils.clone)
  animations: THREE.AnimationClip[];
}

export interface AssetManifest {
  /** `walkSpeed` / `runSpeed`: planted-foot speed of the walk / run cycle (sidecar `walk_speed` / `run_speed`, model heights/s). */
  units: Record<string, { file: string; height?: number; walkSpeed?: number; runSpeed?: number }>;
  items: Record<string, { file: string }>;
  mounts: Record<string, { file: string; saddle?: [number, number, number] }>;
  buildings: Record<string, { file: string }>;
  props: Record<string, { file: string }>;
  monsters: Record<string, { file: string }>;
  textures: Record<string, string>;
  icons: Record<string, string>;
  portraits: Record<string, string>;
}

export interface AssetLibrary {
  manifest: AssetManifest;
  /** Clone of a static model normalised as loaded (or null if missing → caller uses procedural fallback). */
  model(kind: 'items' | 'mounts' | 'buildings' | 'props' | 'monsters', key: string): THREE.Object3D | null;
  /** Rigged unit asset (shared; clone before use) or null if missing. */
  skinned(key: string): SkinnedAsset | null;
  /** Terrain/other texture or null. */
  texture(key: string): THREE.Texture | null;
  /** URL for a UI icon/portrait key ('items/sword.png' → '/assets/icons/items/sword.png') or null. */
  iconUrl(key: string): string | null;
  portraitUrl(key: string): string | null;
}

/** Shared services handed by world.ts to every layer. */
export interface RenderContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  assets: AssetLibrary;
  /** Terrain surface height at world x/z. */
  heightAt(x: number, z: number): number;
  /** Center of a hex on the terrain surface (y = terrain height; for water: water level). */
  hexCenter(h: Hex): THREE.Vector3;
  factionColor(f: FactionId | null): THREE.Color;
  /** Small camera shake (0..1). */
  shake(amount: number): void;
  /** Current viewer (human player) — used for fog decisions. */
  viewer: FactionId;
  time: number;                      // seconds since start (updated each frame)
  /** Canvas height in CSS pixels (constant-screen-size markers). */
  viewportHeight?(): number;
  /**
   * How far the building on hex `h` reaches from its centre toward direction `dir` (0..11, at
   * 30·dir−30° in x/z: even = hex corners, odd = edge midpoints), or null when no building is drawn there.
   */
  buildingFront?(h: Hex, dir: number): number | null;
}

export interface Layer {
  /** Rebuild/sync from state. `visible(h)` = hex currently visible to the viewer. */
  sync(state: GameState, visible: (h: Hex) => boolean, explored: (h: Hex) => boolean): void;
  update(dt: number): void;
  dispose(): void;
}

export interface UnitLayerApi extends Layer {
  /** Walk along path (excl. start). Resolves when arrived. */
  animateMove(unit: UnitId, path: Hex[], speed: number): Promise<void>;
  /** Full exchange: alternating swings/shots with hit/miss reactions; returns when done. Calls fx for projectiles & numbers. */
  animateCombat(attacker: UnitId, defender: UnitId, kind: AttackKind, strikes: StrikeEvent[], speed: number): Promise<void>;
  animateDeath(unit: UnitId, speed: number): Promise<void>;
  animateSpawn(unit: UnitId, speed: number): Promise<void>;
  /** One-shot clip ('cast' | 'work' | 'hit' ...). */
  playClip(unit: UnitId, clip: string, speed: number): Promise<void>;
  /** World position of a unit's chest (for fx targeting); null if not rendered. */
  unitAnchor(unit: UnitId): THREE.Vector3 | null;
  /** Rebuild a unit's equipment attachments/body after an equip change. */
  refreshUnit(state: GameState, unit: UnitId): void;
  /** Nearest drawn unit (body, or its always-on-top bar / marker) under `ray`. */
  pick?(ray: THREE.Ray): { hex: Hex; t: number } | null;
}

export interface BuildingLayerApi extends Layer {
  animateConstructed(b: BuildingInstanceId, speed: number): Promise<void>;
  animateDestroyed(b: BuildingInstanceId, speed: number): Promise<void>;
  /** Nearest drawn building mesh under `ray` (exact triangles, after a cylinder rejection). */
  pick?(ray: THREE.Ray): { hex: Hex; t: number } | null;
  /** See RenderContext.buildingFront. */
  frontReach?(h: Hex, dir: number): number | null;
}

export interface OverlayLayerApi {
  set(o: OverlayState, state: GameState | null): void;
  update(dt: number): void;
  dispose(): void;
}

export interface FxLayerApi {
  projectile(from: THREE.Vector3, to: THREE.Vector3, kind: AttackKind, speed: number): Promise<void>;
  damageNumber(at: THREE.Vector3, text: string, color: string): void;
  burst(at: THREE.Vector3, color: string, count?: number): void;
  /**
   * `targets`: ground positions of the units the spell actually affected (ally-only spells such as
   * heal / bless play their heavy effect only there, plus a faint cue over the whole area).
   * Omitted: every hex of the area.
   */
  spell(spell: SpellId, from: THREE.Vector3, center: THREE.Vector3, radius: number, speed: number, targets?: THREE.Vector3[]): Promise<void>;
  levelUp(at: THREE.Vector3): void;
  hitSpark(at: THREE.Vector3, kind: AttackKind): void;
  update(dt: number): void;
  dispose(): void;
}

/** Factories implemented by the entity layer modules. */
export type CreateUnitLayer = (ctx: RenderContext, fx: FxLayerApi) => UnitLayerApi;
export type CreateBuildingLayer = (ctx: RenderContext, fx: FxLayerApi) => BuildingLayerApi;
export type CreateOverlayLayer = (ctx: RenderContext) => OverlayLayerApi;
export type CreateFxLayer = (ctx: RenderContext) => FxLayerApi;
