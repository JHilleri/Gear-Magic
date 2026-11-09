// Threat map: where each visible enemy could strike next turn, and how hard. Computed lazily,
// once per enemy per AI turn (enemies do not move during our turn; dead ones are skipped).
import type { AttackKind, Hex, Unit } from '../../core/types';
import { hexDistance, inBounds, neighbors, spiral, tileIndex } from '../../core/hex';
import { reachable } from '../pathfinding';
import { castleHexes, monsterMayStand } from '../neutral';
import { attackProfile, tileDefense } from '../combat';
import { effectiveStats, getAttackDefs, isMounted } from '../units';
import type { Ctx, Threat } from './types';
import { armorOf } from './util';

/** At most this many enemies are assumed to be able to pile onto one hex. */
const MAX_ATTACKERS = 3;

function computeThreat(ctx: Ctx, e: Unit): Threat {
  const s = ctx.s;
  const w = s.width, h = s.height;
  const origins: Hex[] = [e.pos];
  const saved = e.mp;
  const mov = effectiveStats(s, e).mov;
  // Where it could stand next turn: full movement from its current hex.
  e.mp = mov;
  try {
    for (const ri of reachable(s, e)) origins.push(ri.hex);
  } finally {
    e.mp = saved;
  }
  // Monsters keep to their leash and out of castle sanctuaries (the same rule sim/neutral obeys).
  let leashed = origins;
  if (e.faction === 'neutral' && e.home) {
    const castles = castleHexes(s);
    leashed = origins.filter((o, i) => i === 0 || monsterMayStand(s, e, o, castles));
  }
  const melee = new Set<number>();
  const ranged = new Set<number>();
  let range = 0;
  for (const d of getAttackDefs(e)) if (d.kind !== 'melee') range = Math.max(range, d.range);
  for (const o of leashed) {
    for (const n of neighbors(o)) if (inBounds(n, w, h)) melee.add(tileIndex(n, w));
    if (range > 0) {
      for (const n of spiral(o, range)) {
        if ((n.q !== o.q || n.r !== o.r) && inBounds(n, w, h)) ranged.add(tileIndex(n, w));
      }
    }
  }
  return { id: e.id, melee, ranged, reach: mov + Math.max(1, range) };
}

/** Threat entries for every currently visible enemy (computed on first need). */
export function threatOf(ctx: Ctx, e: Unit): Threat {
  let th = ctx.t.threats.get(e.id);
  if (!th) {
    th = computeThreat(ctx, e);
    ctx.t.threats.set(e.id, th);
  }
  return th;
}

/**
 * damage × strikes of `e`'s attack of `kind` against `u`. Only the victim's armor and whether it
 * rides matter (vs-mounted spears), so the value is shared by every unit with the same armor.
 */
function rawDamage(ctx: Ctx, e: Unit, u: Unit, kind: AttackKind): number {
  const armor = armorOf(ctx, u);
  const key = `${e.id}|${kind}|${armor}|${isMounted(u) ? 1 : 0}`;
  let v = ctx.t.prof.get(key);
  if (v === undefined) {
    const p = attackProfile(ctx.s, e, u, kind);
    v = p ? p.damage * p.strikes : 0;
    ctx.t.prof.set(key, v);
  }
  return v;
}

/**
 * Expected damage `u` would take next enemy turn standing on `h` (top 3 attackers).
 * `ignore` scales one enemy's contribution (e.g. by its survival chance after our attack).
 */
export function exposureAt(ctx: Ctx, u: Unit, h: Hex, ignore = -1, ignoreWeight = 0, maxAttackers = MAX_ATTACKERS): number {
  const hits = hitsAt(ctx, u, h);
  // Enemies focus a leader with everything in reach.
  if (u.isLeader) maxAttackers = Math.max(maxAttackers, 8);
  let sum = 0;
  let n = 0;
  // Top attackers after down-weighting the ignored one (lists are short: re-sort is cheap).
  if (ignore >= 0 && hits.some((x) => x.id === ignore)) {
    const vals = hits.map((x) => (x.id === ignore ? x.v * ignoreWeight : x.v)).sort((a, b) => b - a);
    for (const v of vals) { if (n++ >= maxAttackers) break; sum += v; }
    return sum;
  }
  for (const x of hits) { if (n++ >= maxAttackers) break; sum += x.v; }
  return sum;
}

/** Expected damage per visible enemy that could strike `u` on `h` next turn (memoised per call). */
function hitsAt(ctx: Ctx, u: Unit, h: Hex): { id: number; v: number }[] {
  const s = ctx.s;
  if (!inBounds(h, s.width, s.height) || ctx.enemies.length === 0) return [];
  const idx = tileIndex(h, s.width);
  // Armor (equipment, Fortify) and riding change what hits; the hex's cover is fixed this turn.
  const key = `${u.id}|${idx}|${armorOf(ctx, u)}|${u.equipment.mount ? 1 : 0}${u.equipment.off ? 1 : 0}`;
  const memo = ctx.hits.get(key);
  if (memo) return memo;
  const def = tileDefense(s, u, h);
  const physHit = Math.max(0.1, Math.min(0.9, (100 - def) / 100));
  const out: { id: number; v: number }[] = [];
  for (const e of ctx.enemies) {
    if (!s.units[String(e.id)]) continue;
    const th = threatOf(ctx, e);
    if (hexDistance(e.pos, h) > th.reach) continue;
    const inM = th.melee.has(idx), inR = th.ranged.has(idx);
    if (!inM && !inR) continue;
    let best = 0;
    for (const d of getAttackDefs(e)) {
      if (d.kind === 'melee' ? !inM : !inR) continue;
      let hit = d.kind === 'magic' ? 0.7 : physHit;
      if (d.kind === 'ranged' && e.passives.includes('marksman')) hit = Math.max(hit, 0.6);
      const v = rawDamage(ctx, e, u, d.kind) * hit;
      if (v > best) best = v;
    }
    if (best > 0) out.push({ id: e.id, v: best });
  }
  out.sort((a, b) => b.v - a.v);
  ctx.hits.set(key, out);
  return out;
}

/** Does visible enemy `e` threaten hex `h` next turn? */
export function threatens(ctx: Ctx, e: Unit, h: Hex): boolean {
  const s = ctx.s;
  if (!inBounds(h, s.width, s.height)) return false;
  const th = threatOf(ctx, e);
  if (hexDistance(e.pos, h) > th.reach) return false;
  const idx = tileIndex(h, s.width);
  return th.melee.has(idx) || th.ranged.has(idx);
}

/** Number of visible hostile faction units (not monsters) that could strike `h` next turn. */
export function attackersOn(ctx: Ctx, h: Hex, foesOnly = true): number {
  const s = ctx.s;
  if (!inBounds(h, s.width, s.height)) return 0;
  const idx = tileIndex(h, s.width);
  let n = 0;
  for (const e of foesOnly ? ctx.foes : ctx.enemies) {
    if (!s.units[String(e.id)]) continue;
    const th = threatOf(ctx, e);
    if (hexDistance(e.pos, h) > th.reach) continue;
    if (th.melee.has(idx) || th.ranged.has(idx)) n++;
  }
  return n;
}
