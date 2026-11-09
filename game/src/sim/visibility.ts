// Fog of war. See DESIGN §10.
import type { FactionId, GameState, Hex, Unit } from '../core/types';
import { inBounds, tileIndex } from '../core/hex';
import { BUILDINGS } from '../data/buildings';
import { SPELLS } from '../data/spells';
import { effectiveStats } from './units';
import { isOperational } from './state';

/** Base sight radius of any owned building or construction site. */
export const BUILDING_VISION = 2;

/** Set every in-bounds tile within `radius` of `c` to 1 in `out` (no allocations). */
function markRadius(out: number[], c: Hex, radius: number, w: number, h: number): void {
  const R = Math.floor(radius);
  if (R < 0) return;
  for (let dq = -R; dq <= R; dq++) {
    const lo = Math.max(-R, -dq - R);
    const hi = Math.min(R, -dq + R);
    for (let dr = lo; dr <= hi; dr++) {
      const r = c.r + dr;
      if (r < 0 || r >= h) continue;
      const col = c.q + dq + (r - (r & 1)) / 2;
      if (col < 0 || col >= w) continue;
      out[r * w + col] = 1;
    }
  }
}

/** How far a unit sees from where it stands: its vision stat, +1 on hills or a mountain. */
export function unitSightRadius(state: GameState, u: Unit): number {
  const t = inBounds(u.pos, state.width, state.height) ? state.tiles[tileIndex(u.pos, state.width)]?.terrain : undefined;
  const bonus = t === 'hills' || t === 'mountain' ? 1 : 0;
  return effectiveStats(state, u).vis + bonus;
}

/**
 * Recompute `factions[f].visible` (units' vision radius, buildings radius 2, watchtower
 * bonus, farsight areas; mountains/hills give +1 vision to a unit standing on them) and OR
 * it into `explored`. Returns the number of newly explored tiles.
 */
export function computeVisibility(state: GameState, faction: FactionId): number {
  const fs = state.factions[faction];
  if (!fs) return 0;
  const w = state.width, h = state.height, n = w * h;
  if (faction === 'neutral') {
    // The Wilds are never fog-limited.
    fs.visible = new Array(n).fill(1);
    fs.explored = new Array(n).fill(1);
    return 0;
  }
  const vis: number[] = new Array(n).fill(0);
  if (fs.alive) {
    for (const k in state.units) {
      const u = state.units[k];
      if (u.faction !== faction || u.hp <= 0 || !inBounds(u.pos, w, h)) continue;
      markRadius(vis, u.pos, unitSightRadius(state, u), w, h);
    }
    for (const k in state.buildings) {
      const b = state.buildings[k];
      if (b.owner !== faction || !inBounds(b.pos, w, h)) continue;
      const extra = isOperational(b) ? BUILDINGS[b.type].visionBonus ?? 0 : 0;
      markRadius(vis, b.pos, BUILDING_VISION + extra, w, h);
    }
    for (const f of fs.farsight) {
      if (f.turns > 0) markRadius(vis, f.hex, SPELLS.farsight.radius, w, h);
    }
  }
  if (!Array.isArray(fs.explored) || fs.explored.length !== n) fs.explored = new Array(n).fill(0);
  const exp = fs.explored;
  let fresh = 0;
  for (let i = 0; i < n; i++) {
    if (vis[i] === 1 && exp[i] !== 1) { exp[i] = 1; fresh++; }
  }
  fs.visible = vis;
  return fresh;
}

export function isVisible(state: GameState, faction: FactionId, h: Hex): boolean {
  if (!inBounds(h, state.width, state.height)) return false;
  if (faction === 'neutral') return true;
  const v = state.factions[faction]?.visible;
  return !!v && v[tileIndex(h, state.width)] === 1;
}

export function isExplored(state: GameState, faction: FactionId, h: Hex): boolean {
  if (!inBounds(h, state.width, state.height)) return false;
  if (faction === 'neutral') return true;
  const e = state.factions[faction]?.explored;
  return !!e && e[tileIndex(h, state.width)] === 1;
}

/** Recompute for every non-neutral faction. */
export function computeAllVisibility(state: GameState): void {
  for (const f of Object.keys(state.factions) as FactionId[]) {
    if (f === 'neutral') continue;
    computeVisibility(state, f);
  }
}
