// Safe multi-turn movement toward a goal: pick the reachable hex that best trades progress
// (distance field) against danger (threat map) and cover (terrain defense).
import type { Action, Hex, Unit } from '../../core/types';
import { hexDistance, hexEq } from '../../core/hex';
import { tileDefense } from '../combat';
import { exposureAt } from './threat';
import type { Ctx } from './types';
import { attempt, idxOf, isHeldSite, reachOf, unitField } from './util';

export interface MoveOpts {
  /** Weight of danger: 0 = ignore, 1 = normal, 2+ = very careful. */
  risk: number;
  /** Do not end closer to the goal than this distance-field value (keeps a column together). */
  limit?: number;
  /** Strongly prefer ending exactly on the goal hex when reachable. */
  exact?: boolean;
  /** Extra per-hex score hook (e.g. stay out of a castle hex). */
  bias?: (h: Hex) => number;
}

/** Best hex to move `u` to this turn toward `goal`, or null if staying put is best. */
export function bestStepToward(ctx: Ctx, u: Unit, goal: Hex, opts: MoveOpts): Hex | null {
  const s = ctx.s;
  if (u.mp <= 0) return null;
  const field = unitField(ctx, u, goal);
  const curD = field[idxOf(s, u.pos)];
  const useField = Number.isFinite(curD);
  const distTo = (h: Hex): number => (useField ? field[idxOf(s, h)] : hexDistance(h, goal) * 1.5);
  const hp = Math.max(1, u.hp);
  const score = (h: Hex, d: number): number => {
    let sc = -d;
    if (opts.risk > 0) sc -= opts.risk * Math.min(1.5, exposureAt(ctx, u, h) / hp) * 6;
    sc += (tileDefense(s, u, h) - 40) * 0.025;
    if (opts.bias) sc += opts.bias(h);
    if (opts.exact && hexEq(h, goal)) sc += 4;
    return sc;
  };
  const here = distTo(u.pos);
  let bestScore = score(u.pos, here) + 0.15; // inertia: do not shuffle for nothing
  let best: Hex | null = null;
  for (const ri of reachOf(ctx, u)) {
    // Keep off another builder's planned site (unless it is where we are going).
    if (!hexEq(ri.hex, goal) && isHeldSite(ctx, ri.hex, u)) continue;
    const d = distTo(ri.hex);
    if (!Number.isFinite(d)) continue;
    // Column discipline: never step beyond the limit (moving back toward it is fine).
    if (opts.limit !== undefined && d < opts.limit && d < here) continue;
    const sc = score(ri.hex, d) - ri.cost * 0.01;
    if (sc > bestScore) { bestScore = sc; best = ri.hex; }
  }
  return best;
}

export function moveToward(ctx: Ctx, u: Unit, goal: Hex, opts: MoveOpts): Action | null {
  const h = bestStepToward(ctx, u, goal, opts);
  if (!h) return null;
  return attempt(ctx, { type: 'move', unit: u.id, to: { q: h.q, r: h.r } });
}

/** Lowest-danger reachable hex (ties → closer to `anchor`). */
export function safestHex(ctx: Ctx, u: Unit, anchor: Hex): Hex | null {
  const s = ctx.s;
  const hp = Math.max(1, u.hp);
  const rate = (h: Hex) => -Math.min(2, exposureAt(ctx, u, h) / hp) * 10 - hexDistance(h, anchor) * 0.3
    + (tileDefense(s, u, h) - 40) * 0.05;
  let best: Hex | null = null;
  let bs = rate(u.pos) + 0.2;
  for (const ri of reachOf(ctx, u)) {
    if (isHeldSite(ctx, ri.hex, u)) continue;
    const sc = rate(ri.hex);
    if (sc > bs) { bs = sc; best = ri.hex; }
  }
  return best;
}
