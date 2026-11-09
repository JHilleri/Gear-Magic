// Movement: costs, reachability with ZOC, multi-turn paths. See DESIGN §4.6.
import type { GameState, Hex, ReachInfo, TerrainId, Unit } from '../core/types';
import { DIRS, hexDistance, inBounds, tileIndex, indexToHex } from '../core/hex';
import { TERRAIN } from '../data/terrain';
import { isMounted } from './units';
import { isEnemy } from './state';

export interface PathOptions {
  /**
   * When true, every enemy blocks and exerts ZOC. By default only enemies standing on hexes
   * the mover's faction can currently see count (neutral monsters see everything), so the
   * overlay never leaks hidden units; actions.move stops a walk early if a hidden enemy is hit.
   */
  omniscient?: boolean;
}

// ── binary min-heap of tile indices keyed by a float priority ──
class MinHeap {
  private idx: number[] = [];
  private pri: number[] = [];
  get size(): number { return this.idx.length; }
  push(i: number, p: number): void {
    const a = this.idx, b = this.pri;
    let n = a.length;
    a.push(i); b.push(p);
    while (n > 0) {
      const parent = (n - 1) >> 1;
      if (b[parent] <= p) break;
      a[n] = a[parent]; b[n] = b[parent];
      n = parent;
    }
    a[n] = i; b[n] = p;
  }
  /** Pops the index with the smallest priority (caller checks size first). */
  pop(): number {
    const a = this.idx, b = this.pri;
    const top = a[0];
    const lastI = a.pop()!;
    const lastP = b.pop()!;
    const n = a.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && b[r] < b[l] ? r : l;
        if (b[c] >= lastP) break;
        a[k] = a[c]; b[k] = b[c];
        k = c;
      }
      a[k] = lastI; b[k] = lastP;
    }
    return top;
  }
}

/** Movement cost for one unit to enter `terrain`, Infinity when impassable. */
function terrainCost(terrain: TerrainId, mounted: boolean, pathfinder: boolean): number {
  let c = TERRAIN[terrain].moveCost;
  if (!Number.isFinite(c)) return Infinity;
  if (pathfinder && (terrain === 'forest' || terrain === 'hills')) c = 1;
  if (mounted) {
    if (terrain === 'mountain') return Infinity;
    if (terrain === 'forest' || terrain === 'swamp') c += 1;
  }
  return c;
}

/** Cost for `unit` to enter `h` (terrain, mount rules, pathfinder). Infinity if impassable / out of bounds. Ignores occupancy. */
export function moveCost(state: GameState, unit: Unit, h: Hex): number {
  if (!inBounds(h, state.width, state.height)) return Infinity;
  const tile = state.tiles[tileIndex(h, state.width)];
  return terrainCost(tile.terrain, isMounted(unit), unit.passives.includes('pathfinder'));
}

/** Precomputed per-tile movement grid for one unit. */
interface MoveGrid {
  w: number;
  h: number;
  /** Cost to enter each tile index (Infinity = impassable). */
  cost: Float64Array;
  /** 0 = free, 1 = ally (pass, no stop), 2 = blocking enemy. */
  occ: Uint8Array;
  /** 1 = entering ends movement (adjacent to a known enemy). */
  zoc: Uint8Array;
}

function knowsUnitAt(state: GameState, mover: Unit, idx: number, omniscient: boolean): boolean {
  if (omniscient || mover.faction === 'neutral') return true;
  const vis = state.factions[mover.faction]?.visible;
  return !vis || vis.length !== state.tiles.length || vis[idx] === 1;
}

function buildGrid(state: GameState, unit: Unit, opts: PathOptions | undefined, withZoc: boolean): MoveGrid {
  const w = state.width, h = state.height, n = w * h;
  const omniscient = !!opts?.omniscient;
  const mounted = isMounted(unit);
  const pathfinder = unit.passives.includes('pathfinder');
  // Terrain costs are memoised per terrain id for this unit.
  const memo: Record<string, number> = {};
  const cost = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = state.tiles[i].terrain;
    let c = memo[t];
    if (c === undefined) c = memo[t] = terrainCost(t, mounted, pathfinder);
    cost[i] = c;
  }
  const occ = new Uint8Array(n);
  const zoc = new Uint8Array(n);
  const skirmisher = unit.passives.includes('skirmisher');
  for (const k in state.units) {
    const o = state.units[k];
    if (o.id === unit.id || o.hp <= 0) continue;
    if (!inBounds(o.pos, w, h)) continue;
    const oi = tileIndex(o.pos, w);
    if (!isEnemy(unit.faction, o.faction)) { occ[oi] = 1; continue; }
    if (!knowsUnitAt(state, unit, oi, omniscient)) continue;
    occ[oi] = 2;
    if (!withZoc || skirmisher) continue;
    for (const d of DIRS) {
      const nh = { q: o.pos.q + d.q, r: o.pos.r + d.r };
      if (inBounds(nh, w, h)) zoc[tileIndex(nh, w)] = 1;
    }
  }
  return { w, h, cost, occ, zoc };
}

/** Neighbor tile indices of `i` (axial step via offset conversion). */
function neighborIndices(i: number, w: number, h: number, out: number[]): number {
  const col = i % w;
  const row = (i - col) / w;
  const q = col - (row - (row & 1)) / 2;
  let k = 0;
  for (let d = 0; d < 6; d++) {
    const nq = q + DIRS[d].q;
    const nr = row + DIRS[d].r;
    if (nr < 0 || nr >= h) continue;
    const ncol = nq + (nr - (nr & 1)) / 2;
    if (ncol < 0 || ncol >= w) continue;
    out[k++] = nr * w + ncol;
  }
  return k;
}

interface DijkstraResult {
  grid: MoveGrid;
  dist: Float64Array;
  prev: Int32Array;
  startIdx: number;
}

/**
 * Single-turn Dijkstra bounded by the unit's remaining movement. ZOC hexes are terminal
 * (can be entered, never expanded), allied hexes are expanded but not valid stops.
 * Stops early once `target` is settled.
 */
function runReach(state: GameState, unit: Unit, opts: PathOptions | undefined, target = -1): DijkstraResult {
  const grid = buildGrid(state, unit, opts, true);
  const n = grid.w * grid.h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const startIdx = inBounds(unit.pos, grid.w, grid.h) ? tileIndex(unit.pos, grid.w) : -1;
  if (startIdx < 0) return { grid, dist, prev, startIdx };
  const budget = Math.max(0, unit.mp);
  dist[startIdx] = 0;
  const heap = new MinHeap();
  heap.push(startIdx, 0);
  const nb: number[] = [0, 0, 0, 0, 0, 0];
  const done = new Uint8Array(n);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === target) break;
    // Entering a ZOC hex ends movement; an ally standing in ZOC is a dead end.
    if (cur !== startIdx && grid.zoc[cur]) continue;
    const dc = dist[cur];
    const k = neighborIndices(cur, grid.w, grid.h, nb);
    for (let j = 0; j < k; j++) {
      const ni = nb[j];
      if (done[ni] || grid.occ[ni] === 2) continue;
      const nd = dc + grid.cost[ni];
      if (nd > budget || nd >= dist[ni]) continue;
      dist[ni] = nd;
      prev[ni] = cur;
      heap.push(ni, nd);
    }
  }
  return { grid, dist, prev, startIdx };
}

function buildPath(prev: Int32Array, startIdx: number, endIdx: number, w: number): Hex[] {
  const out: Hex[] = [];
  let c = endIdx;
  while (c !== startIdx && c >= 0) {
    out.push(indexToHex(c, w));
    c = prev[c];
  }
  out.reverse();
  return out;
}

/** True if `h` is adjacent to a living enemy of `unit` (zone of control) and the unit is not a skirmisher. */
export function inEnemyZoc(state: GameState, unit: Unit, h: Hex, opts?: PathOptions): boolean {
  if (unit.passives.includes('skirmisher')) return false;
  const omniscient = !!opts?.omniscient;
  for (const k in state.units) {
    const o = state.units[k];
    if (o.id === unit.id || o.hp <= 0 || !isEnemy(unit.faction, o.faction)) continue;
    if (hexDistance(o.pos, h) !== 1) continue;
    if (!inBounds(o.pos, state.width, state.height)) continue;
    if (!knowsUnitAt(state, unit, tileIndex(o.pos, state.width), omniscient)) continue;
    return true;
  }
  return false;
}

/**
 * Every hex the unit can end its move on this turn (excluding its own hex), with the
 * cheapest path. Rules: cannot enter enemy-occupied hexes; may pass through allied units
 * but not end on them; entering an enemy ZOC hex ends movement there.
 */
export function reachable(state: GameState, unit: Unit, opts?: PathOptions): ReachInfo[] {
  if (unit.mp <= 0 || unit.hp <= 0 || unit.moveEnded) return [];
  const { grid, dist, prev, startIdx } = runReach(state, unit, opts);
  if (startIdx < 0) return [];
  const out: ReachInfo[] = [];
  const n = grid.w * grid.h;
  for (let i = 0; i < n; i++) {
    if (i === startIdx || dist[i] === Infinity || grid.occ[i] !== 0) continue;
    const zocStop = grid.zoc[i] === 1;
    out.push({
      hex: indexToHex(i, grid.w),
      cost: dist[i],
      mpLeft: zocStop ? 0 : Math.max(0, unit.mp - dist[i]),
      path: buildPath(prev, startIdx, i, grid.w),
      zocStop,
    });
  }
  return out;
}

/** Path for this turn (excl. start, incl. target) or null if not reachable now. */
export function findPath(state: GameState, unit: Unit, to: Hex, opts?: PathOptions): Hex[] | null {
  if (unit.mp <= 0 || unit.hp <= 0 || unit.moveEnded) return null;
  if (!inBounds(to, state.width, state.height)) return null;
  if (to.q === unit.pos.q && to.r === unit.pos.r) return null;
  const ti = tileIndex(to, state.width);
  const { grid, dist, prev, startIdx } = runReach(state, unit, opts, ti);
  if (startIdx < 0 || dist[ti] === Infinity || grid.occ[ti] !== 0) return null;
  return buildPath(prev, startIdx, ti, grid.w);
}

/** Total movement cost of walking `path` (excl. start). */
export function pathCost(state: GameState, unit: Unit, path: Hex[]): number {
  let c = 0;
  for (const h of path) c += moveCost(state, unit, h);
  return c;
}

/**
 * Longest prefix of a (multi-turn) path the unit can walk this turn and legally stop on:
 * respects remaining mp, blocking enemies and ZOC, and never ends on an occupied hex.
 * Handy for AI units following `pathTowards`.
 */
export function truncatePathToMp(state: GameState, unit: Unit, path: Hex[], opts?: PathOptions): Hex[] {
  const grid = buildGrid(state, unit, opts, true);
  let spent = 0;
  let lastStop = 0; // number of steps of the best legal stopping prefix
  for (let s = 0; s < path.length; s++) {
    const h = path[s];
    if (!inBounds(h, grid.w, grid.h)) break;
    const i = tileIndex(h, grid.w);
    if (grid.occ[i] === 2) break;
    spent += grid.cost[i];
    if (spent > unit.mp) break;
    if (grid.occ[i] === 0) lastStop = s + 1;
    if (grid.zoc[i]) break;
  }
  return path.slice(0, lastStop);
}

/**
 * Multi-turn A* toward `goal` ignoring current mp and ZOC but avoiding impassable and
 * enemy-occupied hexes (goal itself may be occupied). Returns full path (excl. start) or null.
 * If the goal's terrain is impassable for this unit (e.g. a mountain for a rider), the path
 * ends on the cheapest passable hex adjacent to it instead.
 */
export function pathTowards(state: GameState, unit: Unit, goal: Hex, maxNodes?: number, opts?: PathOptions): Hex[] | null {
  const w = state.width, h = state.height;
  if (!inBounds(goal, w, h) || !inBounds(unit.pos, w, h)) return null;
  if (goal.q === unit.pos.q && goal.r === unit.pos.r) return [];
  const grid = buildGrid(state, unit, opts, false);
  const n = w * h;
  const startIdx = tileIndex(unit.pos, w);
  const goalIdx = tileIndex(goal, w);
  const goalPassable = Number.isFinite(grid.cost[goalIdx]);
  if (!goalPassable && hexDistance(unit.pos, goal) === 1) return [];
  const limit = maxNodes ?? n * 2;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  g[startIdx] = 0;
  heap.push(startIdx, hexDistance(unit.pos, goal));
  const nb: number[] = [0, 0, 0, 0, 0, 0];
  let expanded = 0;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const curHex = indexToHex(cur, w);
    if (cur === goalIdx || (!goalPassable && hexDistance(curHex, goal) === 1)) return buildPath(prev, startIdx, cur, w);
    if (++expanded > limit) return null;
    const k = neighborIndices(cur, w, h, nb);
    for (let j = 0; j < k; j++) {
      const ni = nb[j];
      if (closed[ni]) continue;
      const c = grid.cost[ni];
      if (!Number.isFinite(c)) continue;
      if (grid.occ[ni] === 2 && ni !== goalIdx) continue;
      const ng = g[cur] + c;
      if (ng >= g[ni]) continue;
      g[ni] = ng;
      prev[ni] = cur;
      const nh = indexToHex(ni, w);
      // Admissible heuristic (every step costs ≥ 1); the tiny tie-break favours straighter paths.
      heap.push(ni, ng + hexDistance(nh, goal) * 1.001);
    }
  }
  return null;
}
