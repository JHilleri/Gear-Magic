// Public facade of the 3D renderer. Reads GameState; never mutates it.
import type { BuildingInstanceId, FactionId, GameEvent, GameState, Hex, ReachInfo, UnitId } from '../core/types';
import type { PlaybackPlan } from './playback';

export interface OverlayState {
  selectedUnit: UnitId | null;
  hoverHex: Hex | null;
  reach: ReachInfo[];               // movement range (tint) for selected unit
  path: Hex[];                      // path preview to hover hex
  attackable: UnitId[];             // enemies the selected unit can attack (red outline)
  forecastTarget: UnitId | null;    // highlighted target
  areaCenter: Hex | null;           // spell/skill AoE preview
  areaRadius: number;
  areaValid: boolean;
  /** Colour of a valid area: help (green, default), harm (fiery: damage), warn (damage that also hits own units). */
  areaTone?: 'help' | 'harm' | 'warn';
  spellRanges: { pos: Hex; range: number }[]; // tower positions and their own range circles
  showGrid: boolean;
}

export interface LoadProgress { (fraction: number, label: string): void }

export interface WorldRenderer {
  /** Load the manifest + assets (with procedural fallbacks for anything missing). */
  init(onProgress: LoadProgress): Promise<void>;
  /**
   * Optional, before setGame(state): compute the costly part of the new world (the terrain field)
   * in small slices between other tasks, so setGame() does not block the page as long.
   */
  prepareGame?(state: GameState): Promise<void>;
  /** Rebuild terrain for a new game and snap all units/buildings to `state` as seen by `viewer`. */
  setGame(state: GameState, viewer: FactionId): void;
  /** Incremental sync after events have been animated (adds/removes/moves meshes, fog, territory, equipment). */
  sync(state: GameState): void;
  /**
   * Animate events in order (moves along paths, combat strikes with projectiles and damage
   * numbers, deaths, spawns, spells, constructions, level-ups). Resolves when done. Events
   * the viewer cannot see are skipped quickly. speed multiplies animation speed.
   */
  playEvents(state: GameState, events: GameEvent[], speed: number, plan?: PlaybackPlan): Promise<void>;
  setOverlays(o: Partial<OverlayState>): void;
  /** Hex under the given client pixel (null if off-map). */
  pickHex(clientX: number, clientY: number): Hex | null;
  /**
   * Smoothly move the camera to center on a hex; `pace` > 1 shortens the glide. Returns the
   * glide's length in seconds (0 when instant).
   */
  focus(h: Hex, instant?: boolean, pace?: number): number;
  /** Project a hex to client pixels (for DOM tooltips). */
  hexToScreen(h: Hex): { x: number; y: number; visible: boolean };
  /**
   * Where a hex will be on screen once the camera settles: at the end of the glide in progress,
   * or (with `from`) centred on `from` as focus(from) would leave it.
   */
  hexToView(h: Hex, from?: Hex): { x: number; y: number; visible: boolean };
  setQuality(q: 'low' | 'high'): void;
  /**
   * Whether the map can be seen at all. While false (an opaque title, loading or results screen
   * covers the canvas) nothing is drawn; entity animations still tick at a low rate.
   */
  setActive(on: boolean): void;
  /** Release the current game's world (terrain, entities, playback in flight), e.g. on quit to title. */
  clearGame(): void;
  /**
   * After setGame(), while a loading screen still covers the canvas: compile the new world's shader
   * programs off the main thread where the browser can (KHR_parallel_shader_compile) and draw one
   * hidden frame, so the first visible frame does not stall. Resolves early if the game is replaced.
   */
  warmup?(onProgress?: (fraction: number, label: string) => void): Promise<void>;
  /** World x/z ground polygon of the view (screen corners on the target's ground plane), not clamped to the map. */
  cameraFootprint?(): { x: number; z: number }[] | null;
  /** Called every frame by the renderer's own RAF loop; exposes camera keyboard state. */
  keyState: Set<string>;
  dispose(): void;
}

export { createWorldRenderer } from './world';
export { beatDependencies, splitBeats, type Beat, type PlaybackPlan, type PlaybackStep } from './playback';
export type { BuildingInstanceId };
