// Small shared helpers for the rules modules (combat, economy, skills, spells, turn,
// neutral, actions). Pure; no three.js / DOM.
import type { Building, FactionId, GameEvent, GameState, Hex, LogEntry, Unit, XpCategory } from '../core/types';
import { inBounds, tileIndex } from '../core/hex';
import { TERRAIN } from '../data/terrain';
import { addLog } from './state';
import { grantXp } from './progression';

/** A building that works (produces, heals, recruits, defends): owned and built (an upgrade in progress keeps the current level working). */
export function isFunctional(b: Building | undefined | null): b is Building {
  return !!b && b.owner !== null && (b.buildLeft <= 0 || b.upgrading);
}

/** A completed structure regardless of owner (for territory / display). */
export function isBuilt(b: Building): boolean {
  return b.buildLeft <= 0 || b.upgrading;
}

/** Round to 2 decimals to keep float noise out of persisted numbers. */
export function round2(x: number): number {
  return Math.round(x * 100 + (x >= 0 ? 1e-9 : -1e-9)) / 100;
}

/** Math.round with a tiny epsilon so 10.4999999 (float noise of 10.5) rounds up. */
export function roundHalfUp(x: number): number {
  return Math.round(x + 1e-9);
}

/** True when the faction is controlled by the human player. */
export function isHumanFaction(state: GameState, f: FactionId | null | undefined): boolean {
  return !!f && !!state.factions[f]?.isHuman;
}

/** Append a log entry and return the matching 'log' event. */
export function logEvent(state: GameState, text: string, kind: LogEntry['kind'], faction: FactionId | null = null): GameEvent {
  return { type: 'log', entry: addLog(state, text, kind, faction) };
}

/** Log only when one of `factions` is the human player (keeps fog-of-war secrets out of the log). */
export function logFor(state: GameState, factions: (FactionId | null | undefined)[], text: string, kind: LogEntry['kind'], faction: FactionId | null = null): GameEvent[] {
  return factions.some((f) => isHumanFaction(state, f)) ? [logEvent(state, text, kind, faction)] : [];
}

/** XP for real units only: monsters/summons never level. Dead units get nothing. */
export function giveXp(state: GameState, unit: Unit | null | undefined, cat: XpCategory, amount: number): GameEvent[] {
  if (!unit || unit.monster || amount <= 0) return [];
  if (!state.units[String(unit.id)]) return [];
  return grantXp(state, unit, cat, amount);
}

/** Terrain passable for a unit without one (spawns): finite move cost, mounts not on mountains. */
export function passableForSpawn(state: GameState, h: Hex, mounted: boolean): boolean {
  if (!inBounds(h, state.width, state.height)) return false;
  const t = state.tiles[tileIndex(h, state.width)];
  if (!t || !Number.isFinite(TERRAIN[t.terrain].moveCost)) return false;
  if (mounted && t.terrain === 'mountain') return false;
  return true;
}

/** Unit standing on `h` (fast path without importing state helpers in hot loops). */
export function unitOn(state: GameState, h: Hex): Unit | undefined {
  for (const k in state.units) {
    const u = state.units[k];
    if (u.pos.q === h.q && u.pos.r === h.r) return u;
  }
  return undefined;
}

/** Building on `h` via the tile index. */
export function buildingOn(state: GameState, h: Hex): Building | undefined {
  if (!inBounds(h, state.width, state.height)) return undefined;
  const id = state.tiles[tileIndex(h, state.width)]?.building;
  return id == null ? undefined : state.buildings[String(id)];
}
