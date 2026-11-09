// Shared AI helpers: action validation, distance fields, unit valuation. Pure, deterministic.
import type { Action, AttackKind, Building, CombatForecast, FactionId, GameState, Hex, ReachInfo, Resources, TerrainId, Unit } from '../../core/types';
import { DIRS, hexDistance, inBounds, indexToHex, tileIndex } from '../../core/hex';
import { TERRAIN } from '../../data/terrain';
import { FACTIONS } from '../../data/factions';
import { validateAction } from '../actions';
import { reachable } from '../pathfinding';
import { forecastFrom } from '../combat';
import { factionIncome } from '../economy';
import { isVisible } from '../visibility';
import { effectiveStats, getAttackDefs, isMounted, unitValue } from '../units';
import type { Ctx } from './types';

/** Same key the controller uses to remember failed actions (JSON of the action object). */
export function actionKey(a: Action): string {
  return JSON.stringify(a);
}

/** How many times an identical action may be returned in one turn before it counts as "no progress". */
function repeatLimit(a: Action): number {
  switch (a.type) {
    case 'craft': return 8;      // several of the same item from one forge is legitimate
    case 'levelup': return 12;   // the same option can be offered on consecutive level-ups
    default: return 1;
  }
}

/**
 * The action if it is legal now and was neither rejected before nor already returned too often
 * this turn, else null. Never mutates the game state.
 */
export function attempt(ctx: Ctx, a: Action): Action | null {
  const key = actionKey(a);
  if (ctx.mem.failed.has(key)) return null;
  if ((ctx.t.returned.get(key) ?? 0) >= repeatLimit(a)) return null;
  if (validateAction(ctx.s, a) !== null) return null;
  return a;
}

// ───────────────────────────── geometry ─────────────────────────────

export const idxOf = (s: GameState, h: Hex): number => tileIndex(h, s.width);
export const hexOf = (s: GameState, i: number): Hex => indexToHex(i, s.width);

export function terrainAt(s: GameState, h: Hex): TerrainId | null {
  if (!inBounds(h, s.width, s.height)) return null;
  return s.tiles[tileIndex(h, s.width)].terrain;
}

/** Movement cost to enter a terrain for a movement class (mirrors sim/pathfinding). */
export function enterCost(t: TerrainId, mounted: boolean, pathfinder: boolean): number {
  let c = TERRAIN[t].moveCost;
  if (!Number.isFinite(c)) return Infinity;
  if (pathfinder && (t === 'forest' || t === 'hills')) c = 1;
  if (mounted) {
    if (t === 'mountain') return Infinity;
    if (t === 'forest' || t === 'swamp') c += 1;
  }
  return c;
}

class Heap {
  private i: number[] = [];
  private p: number[] = [];
  get size(): number { return this.i.length; }
  push(idx: number, pri: number): void {
    const a = this.i, b = this.p;
    let n = a.length;
    a.push(idx); b.push(pri);
    while (n > 0) {
      const par = (n - 1) >> 1;
      if (b[par] <= pri) break;
      a[n] = a[par]; b[n] = b[par]; n = par;
    }
    a[n] = idx; b[n] = pri;
  }
  pop(): number {
    const a = this.i, b = this.p;
    const top = a[0];
    const li = a.pop()!, lp = b.pop()!;
    const n = a.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && b[r] < b[l] ? r : l;
        if (b[c] >= lp) break;
        a[k] = a[c]; b[k] = b[c]; k = c;
      }
      a[k] = li; b[k] = lp;
    }
    return top;
  }
}

/**
 * Multi-turn movement cost from every tile to `goal` for a movement class (occupancy and ZOC
 * ignored: units shift every turn). Cached for the whole AI turn. An impassable goal (a
 * mountain for a rider) makes its neighbours distance 0.
 */
export function distField(ctx: Ctx, goal: Hex, mounted = false, pathfinder = false): Float64Array {
  const s = ctx.s;
  const key = `${goal.q},${goal.r}|${mounted ? 1 : 0}${pathfinder ? 1 : 0}`;
  const hit = ctx.t.dist.get(key);
  if (hit) return hit;
  const w = s.width, h = s.height, n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  if (!inBounds(goal, w, h)) { ctx.t.dist.set(key, dist); return dist; }
  const cost = new Float64Array(n);
  const memo: Partial<Record<TerrainId, number>> = {};
  for (let i = 0; i < n; i++) {
    const t = s.tiles[i].terrain;
    let c = memo[t];
    if (c === undefined) c = memo[t] = enterCost(t, mounted, pathfinder);
    cost[i] = c;
  }
  const g = tileIndex(goal, w);
  dist[g] = 0;
  const heap = new Heap();
  heap.push(g, 0);
  const done = new Uint8Array(n);
  while (heap.size > 0) {
    const a = heap.pop();
    if (done[a]) continue;
    done[a] = 1;
    // Stepping from a neighbour into `a` costs cost[a] (0 into an impassable goal).
    const step = a === g ? (Number.isFinite(cost[a]) ? cost[a] : 0) : cost[a];
    const col = a % w, row = (a - col) / w;
    const q = col - (row - (row & 1)) / 2;
    for (const d of DIRS) {
      const nr = row + d.r;
      if (nr < 0 || nr >= h) continue;
      const ncol = q + d.q + (nr - (nr & 1)) / 2;
      if (ncol < 0 || ncol >= w) continue;
      const b = nr * w + ncol;
      if (done[b] || !Number.isFinite(cost[b])) continue;
      const nd = dist[a] + step;
      if (nd < dist[b]) { dist[b] = nd; heap.push(b, nd); }
    }
  }
  ctx.t.dist.set(key, dist);
  return dist;
}

/** Distance field for this unit's own movement class. */
export function unitField(ctx: Ctx, u: Unit, goal: Hex): Float64Array {
  return distField(ctx, goal, isMounted(u), u.passives.includes('pathfinder'));
}

/**
 * Reachable hexes for `u`. Memoised per call, and across calls while nothing that matters
 * changed: its position and mp, and every unit (position, and for enemies whether we see
 * them) close enough to block it or exert zone of control.
 */
export function reachOf(ctx: Ctx, u: Unit): ReachInfo[] {
  let r = ctx.reach.get(u.id);
  if (r) return r;
  if (u.mp <= 0 || u.moveEnded) { r = []; ctx.reach.set(u.id, r); return r; }
  const s = ctx.s;
  const R = Math.ceil(u.mp) + 1;
  let sig = `${u.pos.q},${u.pos.r}|${u.mp}|${u.passives.length}|${u.equipment.mount ?? ''}|`;
  for (const k in s.units) {
    const o = s.units[k];
    if (o.id === u.id || hexDistance(o.pos, u.pos) > R) continue;
    const seen = o.faction === u.faction || isVisible(s, u.faction, o.pos);
    sig += `${o.id}@${o.pos.q},${o.pos.r}${seen ? '' : '?'};`;
  }
  const ck = `${u.id}:${u.mp}`;
  const c = ctx.t.reachCache.get(ck);
  if (c && c.sig === sig) r = c.reach;
  else {
    r = reachable(s, u);
    ctx.t.reachCache.set(ck, { sig, reach: r });
  }
  ctx.reach.set(u.id, r);
  return r;
}

/**
 * factionIncome, memoised for the turn while the faction's units and buildings are unchanged
 * (recruits and losses change upkeep; workers moving between buildings are a rounding error).
 */
export function incomeOf(ctx: Ctx): Resources {
  if (ctx.income) return ctx.income;
  const sig = `${ctx.units.length}|${ctx.own.length}`;
  const c = ctx.t.incomeCache;
  if (c && c.sig === sig) ctx.income = c.inc;
  else {
    ctx.income = factionIncome(ctx.s, ctx.f);
    ctx.t.incomeCache = { sig, inc: ctx.income };
  }
  return ctx.income;
}

/** Per-call memoised max hp / value / armor of a unit. */
export function mhp(ctx: Ctx, u: Unit): number {
  const k = `hp:${u.id}`;
  let v = ctx.memo.get(k);
  if (v === undefined) { v = maxHp(ctx.s, u); ctx.memo.set(k, v); }
  return v;
}
export function val(ctx: Ctx, u: Unit): number {
  const k = `val:${u.id}`;
  let v = ctx.memo.get(k);
  if (v === undefined) { v = valueOf(u); ctx.memo.set(k, v); }
  return v;
}
export function armorOf(ctx: Ctx, u: Unit): number {
  const k = `arm:${u.id}`;
  let v = ctx.memo.get(k);
  if (v === undefined) { v = effectiveStats(ctx.s, u).armor; ctx.memo.set(k, v); }
  return v;
}

/** Units standing within `r` of `c` (spatial index; any faction). */
export function unitsNear(ctx: Ctx, c: Hex, r: number): Unit[] {
  const s = ctx.s;
  const out: Unit[] = [];
  for (let dq = -r; dq <= r; dq++) {
    for (let dr = Math.max(-r, -dq - r); dr <= Math.min(r, -dq + r); dr++) {
      const h = { q: c.q + dq, r: c.r + dr };
      if (!inBounds(h, s.width, s.height)) continue;
      const u = ctx.at.get(tileIndex(h, s.width));
      if (u && s.units[String(u.id)]) out.push(u);
    }
  }
  return out;
}

function equipSig(u: Unit): string {
  const e = u.equipment;
  return `${e.main ?? ''}.${e.off ?? ''}.${e.body ?? ''}.${e.trinket ?? ''}.${e.mount ?? ''}`;
}

function leadAdj(ctx: Ctx, u: Unit, h: Hex): boolean {
  if (!ctx.leadHexes.size) return false;
  for (const d of DIRS) if (ctx.leadHexes.has(`${u.faction}@${h.q + d.q},${h.r + d.r}`)) return true;
  return false;
}

/**
 * forecastFrom with a turn-wide cache keyed by everything the forecast depends on: both units'
 * hp, kit, level and buffs, the attacker's hex (cover, charge, distance) and leadership auras.
 */
export function forecastCached(ctx: Ctx, u: Unit, from: Hex, t: Unit, kind: AttackKind): CombatForecast | null {
  const s = ctx.s;
  const tf = s.tiles[tileIndex(from, s.width)];
  const tt = s.tiles[tileIndex(t.pos, s.width)];
  const bf = tf.building != null ? s.buildings[String(tf.building)] : undefined;
  const bt = tt.building != null ? s.buildings[String(tt.building)] : undefined;
  const key = `${u.id}:${u.hp}:${u.level}:${equipSig(u)}:${u.buffs.map((b) => b.id).join('')}:${u.passives.length}`
    + `|${from.q},${from.r}:${tf.terrain}:${bf ? `${bf.owner}${bf.level}${bf.buildLeft > 0 ? 'u' : ''}` : ''}:${leadAdj(ctx, u, from) ? 1 : 0}`
    + `|${t.id}:${t.hp}:${t.level}:${equipSig(t)}:${t.buffs.map((b) => b.id).join('')}:${t.passives.length}`
    + `|${t.pos.q},${t.pos.r}:${tt.terrain}:${bt ? `${bt.owner}${bt.level}${bt.buildLeft > 0 ? 'u' : ''}` : ''}:${leadAdj(ctx, t, t.pos) ? 1 : 0}|${kind}`;
  if (ctx.t.forecasts.has(key)) return ctx.t.forecasts.get(key)!;
  const fc = forecastFrom(s, u, from, t, kind);
  ctx.t.forecasts.set(key, fc);
  return fc;
}

// ───────────────────────────── valuation ─────────────────────────────

/** Strategic value of a unit (leaders are priceless: losing one loses the game). */
export function valueOf(u: Unit): number {
  return Math.max(8, unitValue(u));
}

export function maxHp(s: GameState, u: Unit): number {
  return Math.max(1, effectiveStats(s, u).maxHp);
}

/** Rough fighting strength (hp × best damage output × armor), for force comparisons. */
export function powerOf(s: GameState, u: Unit): number {
  const st = effectiveStats(s, u);
  let best = 0;
  const fdef = FACTIONS[u.faction];
  for (const d of getAttackDefs(u)) {
    const stat = d.kind === 'melee' ? st.str : d.kind === 'ranged' ? st.dex : st.int;
    let dmg = (d.base + Math.floor(Math.max(0, stat) / 2)) * d.strikes;
    if (d.kind !== 'melee') dmg *= 1.15; // no retaliation from melee units
    // The house's own damage bonus for this kind of attack.
    dmg *= (d.kind === 'melee' ? fdef?.meleeMult : d.kind === 'ranged' ? fdef?.rangedMult : fdef?.magicMult) ?? 1;
    if (dmg > best) best = dmg;
  }
  return (Math.max(1, u.hp) * best * (1 + st.armor / 100)) / 10;
}

/** True if the unit carries a real weapon (or is a creature that fights natively). */
export function isArmed(u: Unit): boolean {
  if (u.monster) return true;
  const m = u.equipment.main;
  return !!m && m !== 'tools';
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Hex of the nearest building in `list` to `from` (ties → lower id). */
export function nearestBuilding(list: Building[], from: Hex): Building | undefined {
  let best: Building | undefined;
  let bd = Infinity;
  for (const b of list) {
    const d = hexDistance(b.pos, from);
    if (d < bd || (d === bd && best && b.id < best.id)) { bd = d; best = b; }
  }
  return best;
}

/** Claim an objective for a unit (exclusive per turn). Returns false if someone else holds it. */
/**
 * Builder holding `h` as its planned construction site this turn (build / resume tasks), or null.
 * Other units keep off such hexes so they never squat on the site and stall the economy.
 */
export function siteHolder(ctx: Ctx, h: Hex): number | null {
  for (const t of ctx.t.tasks ?? []) {
    if ((t.kind === 'build' || t.kind === 'resume') && t.site.q === h.q && t.site.r === h.r) return t.builder;
  }
  return null;
}

/** True when `h` is someone else's planned building site (see siteHolder). */
export function isHeldSite(ctx: Ctx, h: Hex, u: Unit): boolean {
  const b = siteHolder(ctx, h);
  return b !== null && b !== u.id;
}

export function claim(ctx: Ctx, key: string, unit: number): boolean {
  const cur = ctx.t.claims.get(key);
  if (cur !== undefined && cur !== unit) return false;
  ctx.t.claims.set(key, unit);
  return true;
}

export function claimedByOther(ctx: Ctx, key: string, unit: number): boolean {
  const cur = ctx.t.claims.get(key);
  return cur !== undefined && cur !== unit;
}

/** Alive hostile faction ids (excluding neutral). */
export function enemyFactions(s: GameState, f: FactionId): FactionId[] {
  return s.turnOrder.filter((o) => o !== f && s.factions[o]?.alive);
}
