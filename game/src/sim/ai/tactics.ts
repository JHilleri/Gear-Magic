// Tactical AI: forecast-scored move+attack search with focus fire, retreats to healing sites,
// leader discipline, castle (re)founding and objective-driven army movement. DESIGN §9 "Tactics".
import type { Action, ActiveId, Building, BuildingId, CombatForecast, Hex, Unit } from '../../core/types';
import { hexDistance, hexEq, inBounds, spiral, tileIndex } from '../../core/hex';
import { BUILDINGS } from '../../data/buildings';
import { FLAT_TERRAIN } from '../../data/terrain';
import { attackProfile, tileDefense } from '../combat';
import { canBuildAt, computeTerritory } from '../economy';
import { canBuildWith, getAttackDefs } from '../units';
import { isExplored, isVisible } from '../visibility';
import { moveCost } from '../pathfinding';
import { buildingOn, isFunctional, unitOn } from '../ruleutil';
import { equipClaims, nearestArmory } from './economy-ai';
import { trackOf } from './loadout';
import { moveToward, safestHex } from './movement';
import { getStrategy } from './strategy';
import { attackersOn, exposureAt, threatens } from './threat';
import type { Ctx, PendingAttack, PlanKind, Strategy } from './types';
import { attempt, claim, claimedByOther, forecastCached, idxOf, isArmed, isHeldSite, maxHp, mhp, powerOf, reachOf, unitsNear, val } from './util';

const FLAT = new Set<string>(FLAT_TERRAIN);
const LEADER_KILL_BONUS = 700;

export interface Plan {
  unit: Unit;
  hex: Hex;
  target: Unit;
  kind: PlanKind;
  aux?: Hex;
  score: number;
  retaliates: boolean;
  pk: number;
}

export const ready = (u: Unit, sk: ActiveId): boolean => u.actives.includes(sk) && !((u.cooldowns[sk] ?? 0) > 0);

/** Leader's danger where it stands: expected damage next enemy turn / hp (cached per call). */
function leaderDanger(ctx: Ctx): number {
  const L = ctx.leader;
  if (!L) return 0;
  const key = `danger@${L.pos.q},${L.pos.r}:${L.hp}`;
  const memo = ctx.t.plans.get(key);
  const alive = ctx.enemies.length;
  if (memo && memo.sig === String(alive)) return memo.plan as number;
  const d = exposureAt(ctx, L, L.pos) / Math.max(1, L.hp);
  ctx.t.plans.set(key, { sig: String(alive), plan: d });
  return d;
}

/** What killing / hurting `t` is worth to us. */
function targetValue(ctx: Ctx, t: Unit): number {
  let v = val(ctx, t);
  // Anything that can reach our leader is a priority target, more so the more danger it is in.
  const L = ctx.leader;
  if (L && threatens(ctx, t, L.pos)) v *= leaderDanger(ctx) >= 0.5 ? 3 : 1.6;
  if (t.faction === 'neutral') {
    // Monsters: worth clearing near home (XP, safe ruins), a distraction elsewhere.
    v *= hexDistance(t.pos, ctx.home) <= 9 ? 0.85 : 0.45;
  } else if (ctx.t.strategy?.target === t.faction) {
    v *= 1.1;
  }
  return v;
}

/** Own value, scaled down for temporary summons. */
function selfValue(ctx: Ctx, u: Unit): number {
  const v = val(ctx, u);
  return u.summonTurns ? v * 0.4 * Math.min(1, u.summonTurns / 4) : v;
}

/** How much the unit discounts next-turn danger (lower = bolder). */
function aggression(ctx: Ctx, u: Unit): number {
  if (u.isLeader) return 1;
  if (u.summonTurns) return 0.3;
  // The leader is in mortal danger: everyone nearby fights, whatever it costs.
  if (ctx.leader && hexDistance(u.pos, ctx.leader.pos) <= 7 && leaderDanger(ctx) >= 0.5) return 0.35;
  const st = ctx.t.strategy;
  if (st?.stance === 'attack' && st.army.has(u.id)) return 0.65;
  if (hexDistance(u.pos, ctx.home) <= 6) return 0.8;  // fighting for our own fields
  return 1;
}

/** Value of dealing `dealt` expected damage with kill chance `pk` to `t` (leader ×4, wounded bonus). */
function gainOf(ctx: Ctx, t: Unit, dealt: number, pk: number): number {
  const tMax = mhp(ctx, t);
  const Vt = targetValue(ctx, t);
  let gain = (dealt / tMax) * Vt * 0.8;
  if (t.hp <= tMax * 0.5) gain *= 1.25;
  let kill = pk * Vt * 1.2;
  if (t.isLeader && t.faction !== 'neutral') { gain *= 4; kill += pk * LEADER_KILL_BONUS; }
  return gain + kill;
}

/** Cost of taking `taken` damage (death chance `pd`) and then standing on `h` through the enemy turn. */
function costOf(ctx: Ctx, u: Unit, h: Hex, taken: number, pd: number, ignore: number, ignoreWeight: number): number {
  const s = ctx.s;
  const sMax = mhp(ctx, u);
  const Vs = selfValue(ctx, u);
  let loss = (taken / sMax) * Vs * 0.8 + pd * Vs * 1.5;
  if (u.isLeader) loss = loss * 4 + pd * 4000;
  const aggr = aggression(ctx, u);
  const expo = exposureAt(ctx, u, h, ignore, ignoreWeight);
  const hpAfter = Math.max(1, u.hp - taken);
  let expoLoss = (Math.min(expo, hpAfter) / sMax) * Vs * 0.5 * aggr;
  if (expo >= hpAfter * 0.9) expoLoss += Vs * 0.6 * aggr * (1 - pd);
  if (u.isLeader) expoLoss *= 5;
  const cover = (tileDefense(s, u, h) - 40) * 0.06;
  return loss + expoLoss - cover;
}

/**
 * Score of an attack (DESIGN §9): expected damage × target value (leader ×4, wounded bonus) +
 * kill chance × bonus − expected damage taken × own value − exposure next turn + cover.
 */
export function evaluate(ctx: Ctx, u: Unit, h: Hex, t: Unit, dealt: number, pk: number, taken: number, pd: number): number {
  return gainOf(ctx, t, dealt, pk) - costOf(ctx, u, h, taken, pd, t.id, 1 - pk);
}

function adjacentEnemies(ctx: Ctx, u: Unit, h: Hex): number {
  let n = 0;
  for (const e of unitsNear(ctx, h, 1)) {
    if (e.faction !== u.faction && hexDistance(e.pos, h) === 1 && isVisible(ctx.s, u.faction, e.pos)) n++;
  }
  return n;
}

function leadershipNear(ctx: Ctx, u: Unit, h: Hex, leaders: Unit[]): boolean {
  for (const l of leaders) if (l.id !== u.id && hexDistance(l.pos, h) === 1) return true;
  return false;
}

/**
 * Upper bound on any plan's score against `t`: a certain kill taking no damage, plus the best
 * possible cover and shooter bonuses. Used for branch and bound over targets and units.
 */
function targetBound(ctx: Ctx, t: Unit): number {
  return gainOf(ctx, t, t.hp, 1) + 5;
}

/**
 * Best attack plan for one unit over every hex it can reach this turn (and its own hex).
 * `zone` restricts where it may attack from; plans scoring `floor` or less are not wanted, so
 * targets that cannot beat it are skipped. Forecasts are shared between hexes that give
 * identical fights (same cover, distance, charge and leadership).
 */
export function planFor(ctx: Ctx, u: Unit, zone?: (h: Hex) => boolean, floor = -Infinity): Plan | null {
  const s = ctx.s;
  if (u.acted || u.hp <= 0 || !s.units[String(u.id)]) return null;
  const origins = new Map<number, Hex>();
  origins.set(idxOf(s, u.pos), u.pos);
  for (const ri of reachOf(ctx, u)) origins.set(idxOf(s, ri.hex), ri.hex);
  const defs = getAttackDefs(u);
  const leaders = ctx.units.filter((o) => o.passives.includes('leadership'));
  const fcCache = new Map<string, CombatForecast | null>();
  const reachR = u.mp + 1;
  const fire = ready(u, 'firebolt');
  let best: Plan | null = null;
  const consider = (p: Plan) => { if (!best || p.score > best.score) best = p; };

  // Branch and bound: most promising targets first; skip those that cannot beat the best plan
  // even with a certain kill and no losses.
  const targets: { t: Unit; ub: number }[] = [];
  for (const t of ctx.enemies) {
    if (!s.units[String(t.id)] || t.hp <= 0) continue;
    if (hexDistance(u.pos, t.pos) > reachR + 3) continue;
    targets.push({ t, ub: targetBound(ctx, t) });
  }
  targets.sort((a, b) => b.ub - a.ub || a.t.id - b.t.id);
  for (const { t, ub } of targets) {
    if (ub <= floor || (best && ub <= (best as Plan).score)) break;
    const d0 = hexDistance(u.pos, t.pos);
    for (const d of defs) {
      const R = d.kind === 'melee' ? 1 : d.range;
      if (d0 > reachR + R) continue;
      for (const h of spiral(t.pos, R)) {
        const dist = hexDistance(h, t.pos);
        if (dist < 1 || (d.kind === 'melee' && dist !== 1)) continue;
        if (!inBounds(h, s.width, s.height)) continue;
        const o = origins.get(idxOf(s, h));
        if (!o || (zone && !zone(o))) continue;
        const terr = s.tiles[tileIndex(o, s.width)].terrain;
        const key = `${t.id}|${d.kind}|${tileDefense(s, u, o)}|${dist}|${FLAT.has(terr) ? 1 : 0}|${leadershipNear(ctx, u, o, leaders) ? 1 : 0}`;
        let fc = fcCache.get(key);
        if (fc === undefined) { fc = forecastCached(ctx, u, o, t, d.kind); fcCache.set(key, fc); }
        if (!fc) continue;
        // No suicide: a leader never gambles; others only for a shot at the enemy leader.
        if (u.isLeader ? fc.attackerKillChance > 0.03
          : fc.attackerKillChance > 0.4 && !(t.isLeader && fc.defenderKillChance >= 0.25)) continue;
        let sc = evaluate(ctx, u, o, t, fc.expectedDamageToDefender, fc.defenderKillChance, fc.expectedDamageToAttacker, fc.attackerKillChance);
        if (!hexEq(o, u.pos)) sc -= 0.05;
        // Shooters keep their distance: no zone-of-control lock, adjacent hexes left to the melee.
        if (d.kind !== 'melee') sc += (dist >= 2 ? 0.8 : 0) - adjacentEnemies(ctx, u, o) * 0.4;
        consider({ unit: u, hex: o, target: t, kind: d.kind, score: sc, retaliates: !!fc.defender, pk: fc.defenderKillChance });
      }
    }
    // Firebolt: 14 unblockable damage at range 3, no retaliation.
    if (fire && d0 <= reachR + 3) {
      const dmg = Math.min(14, t.hp);
      const pk = t.hp <= 14 ? 1 : 0;
      for (const h of spiral(t.pos, 3)) {
        if (hexDistance(h, t.pos) < 1 || !inBounds(h, s.width, s.height)) continue;
        const o = origins.get(idxOf(s, h));
        if (!o || (zone && !zone(o))) continue;
        const sc = evaluate(ctx, u, o, t, dmg, pk, 0, 0) - 1.5 - (hexEq(o, u.pos) ? 0 : 0.05);
        consider({ unit: u, hex: o, target: t, kind: 'firebolt', score: sc, retaliates: false, pk });
      }
    }
  }

  // Volley: 60% damage on every enemy around a hex in bow range, no retaliation.
  const bow = defs.find((d) => d.kind === 'ranged');
  const volleyProfiles = new Map<string, ReturnType<typeof attackProfile>>();
  if (bow && ready(u, 'volley')) {
    const centers = new Map<number, Hex>();
    for (const t of ctx.enemies) {
      if (hexDistance(u.pos, t.pos) > reachR + bow.range + 1) continue;
      for (const c of spiral(t.pos, 1)) if (inBounds(c, s.width, s.height)) centers.set(idxOf(s, c), c);
    }
    for (const c of centers.values()) {
      const victims = unitsNear(ctx, c, 1).filter((e) => e.faction !== u.faction && isVisible(s, u.faction, e.pos));
      if (victims.length < 2) continue;
      let gain = 0;
      for (const v of victims) {
        const pk0 = `vp:${u.id}:${v.id}`;
        let p = volleyProfiles.get(pk0);
        if (p === undefined) { p = attackProfile(s, u, v, 'ranged'); volleyProfiles.set(pk0, p); }
        if (!p) continue;
        const per = Math.max(1, Math.round(p.damage * 0.6));
        const exp = per * p.strikes * p.hitChance;
        const need = Math.ceil(v.hp / per);
        // P(at least `need` hits out of `strikes`) for the kill chance.
        let pk = 0;
        if (need <= p.strikes) {
          for (let k = need; k <= p.strikes; k++) pk += binom(p.strikes, k) * Math.pow(p.hitChance, k) * Math.pow(1 - p.hitChance, p.strikes - k);
        }
        gain += gainOf(ctx, v, Math.min(exp, v.hp), pk);
      }
      for (const h of spiral(c, bow.range)) {
        const dist = hexDistance(h, c);
        if (dist < 1 || !inBounds(h, s.width, s.height)) continue;
        const o = origins.get(idxOf(s, h));
        if (!o || (zone && !zone(o))) continue;
        const sc = gain - costOf(ctx, u, o, 0, 0, -1, 0) - 2;
        consider({ unit: u, hex: o, target: victims[0], kind: 'volley', aux: c, score: sc, retaliates: false, pk: 0 });
      }
    }
  }
  return best;
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

function hasBuff(u: Unit, id: string): boolean {
  return u.buffs.some((b) => b.id === id);
}

/** Turn a plan into the next action: move, pre-attack skill, or the strike itself. */
function execute(ctx: Ctx, p: Plan): Action | null {
  const u = p.unit;
  const pend: PendingAttack = { unit: u.id, target: p.target.id, kind: p.kind, hex: { ...p.hex }, aux: p.aux };
  if (!hexEq(u.pos, p.hex)) {
    const a = attempt(ctx, { type: 'move', unit: u.id, to: { ...p.hex } });
    if (a) ctx.t.pending = pend;
    return a;
  }
  if (p.kind === 'melee' && ready(u, 'powerstrike') && !hasBuff(u, 'powerstrike')) {
    const a = attempt(ctx, { type: 'skill', unit: u.id, skill: 'powerstrike' });
    if (a) { ctx.t.pending = pend; return a; }
  }
  switch (p.kind) {
    case 'firebolt':
      return attempt(ctx, { type: 'skill', unit: u.id, skill: 'firebolt', target: { ...p.target.pos } });
    case 'volley':
      return p.aux ? attempt(ctx, { type: 'skill', unit: u.id, skill: 'volley', target: { ...p.aux } }) : null;
    default:
      return attempt(ctx, { type: 'attack', unit: u.id, target: p.target.id, kind: p.kind });
  }
}

/** Leader attacks only from (next to) the castle unless the blow is decisive. */
function leaderPlan(ctx: Ctx, L: Unit): Plan | null {
  const seat = ctx.castle?.pos;
  const home = seat ?? L.pos;
  const near = planFor(ctx, L, (h) => hexDistance(h, home) <= (seat ? 2 : 3)
    && (hexDistance(h, home) <= 1 || exposureAt(ctx, L, h) <= L.hp * 0.3));
  const far = planFor(ctx, L);
  if (far && (far.score >= 150 || (far.target.isLeader && far.pk >= 0.4)) && (!near || far.score > near.score * 1.5)) return far;
  return near;
}

/** Can `u` possibly strike anyone this turn (cheap distance test before any pathfinding)? */
function enemyInStrikeRange(ctx: Ctx, u: Unit): boolean {
  let range = 1;
  for (const d of getAttackDefs(u)) range = Math.max(range, d.range);
  if (ready(u, 'firebolt')) range = Math.max(range, 3);
  const r = u.mp + range;
  for (const e of ctx.enemies) if (hexDistance(e.pos, u.pos) <= r) return true;
  return false;
}

/** Hex distance from an own unit to the nearest visible enemy (memoised per call). */
function frontDist(ctx: Ctx, o: Unit): number {
  const k = `front:${o.id}`;
  let v = ctx.memo.get(k);
  if (v === undefined) {
    v = Infinity;
    for (const e of ctx.enemies) v = Math.min(v, hexDistance(e.pos, o.pos));
    ctx.memo.set(k, v);
  }
  return v;
}

/**
 * Everything a unit's best attack depends on, cheaply: its own state, friends close enough to
 * hold a hex it could strike from (or lend Leadership), every other unit it could strike or
 * splash (position, hp, seen), the enemies whose threat can reach those hexes (exposure) and
 * our leader (target values, aggression). Same signature → same plan; friends shuffling behind
 * the front and changes further away do not invalidate it (friends never block movement).
 */
function planSig(ctx: Ctx, u: Unit, extraMp = 0): string {
  const s = ctx.s;
  const L = ctx.leader;
  let sig = `${u.pos.q},${u.pos.r}|${u.mp}|${u.hp}|${u.acted ? 1 : 0}|${u.buffs.map((b) => b.id).join('')}|`
    + `${ready(u, 'firebolt') ? 1 : 0}${ready(u, 'volley') ? 1 : 0}|${L ? `${L.pos.q},${L.pos.r}:${L.hp}` : ''}|`;
  const mp = Math.ceil(u.mp + extraMp);
  let range = 1;
  for (const d of getAttackDefs(u)) range = Math.max(range, d.range);
  if (ready(u, 'firebolt')) range = Math.max(range, 3);
  const rFriend = mp + 1;                                       // blocking, Leadership
  const rStrike = mp + range + (ready(u, 'volley') ? 3 : 1);    // targets, volley splash, ZOC
  const rThreat = mp + 10;                                      // enemy movement + range
  for (const k in s.units) {
    const o = s.units[k];
    if (o.id === u.id || o.hp <= 0) continue;
    const d = hexDistance(o.pos, u.pos);
    if (o.faction === u.faction) {
      if (d <= rFriend && (frontDist(ctx, o) <= range || o.passives.includes('leadership'))) sig += `${o.id}@${o.pos.q},${o.pos.r};`;
    } else if (d <= rThreat) {
      const seen = isVisible(s, ctx.f, o.pos) ? '' : '?';
      sig += d <= rStrike ? `${o.id}@${o.pos.q},${o.pos.r}:${o.hp}${seen};` : `${o.id}${seen};`;
    }
  }
  return sig;
}

function cachedPlan(ctx: Ctx, key: string, sig: string, compute: () => Plan | null): Plan | null {
  const c = ctx.t.plans.get(key);
  if (c && c.sig === sig) {
    const p = c.plan as Plan | null;
    if (!p || ctx.s.units[String(p.target.id)]) return p;
  }
  const p = compute();
  ctx.t.plans.set(key, { sig, plan: p });
  return p;
}

export function attackPhase(ctx: Ctx): Action | null {
  if (!ctx.enemies.length) return null;
  const s = ctx.s;
  const pd = ctx.t.pending;
  ctx.t.pending = null;
  if (pd) {
    const u = s.units[String(pd.unit)];
    if (u && !u.acted && hexEq(u.pos, pd.hex)) {
      const p = planFor(ctx, u, (h) => hexEq(h, u.pos));
      if (p && p.score > 0) {
        const a = execute(ctx, p);
        if (a) return a;
      }
    }
  }
  // Branch and bound over units: only the best plan is executed, so units are planned in order
  // of their best conceivable score and the search stops once no remaining unit can beat the
  // best plan found (each plan is cached until its signature changes).
  const cands: { u: Unit; ub: number; plan: () => Plan | null }[] = [];
  const add = (u: Unit, scale: number, plan: () => Plan | null) => {
    const ub = strikeBound(ctx, u) * scale;
    if (ub > 0) cands.push({ u, ub, plan });
  };
  for (const u of ctx.military) {
    if (u.acted) continue;
    add(u, 1, () => {
      const p = cachedPlan(ctx, `m${u.id}`, planSig(ctx, u), () => planFor(ctx, u, undefined, 1));
      return p && p.score > 1 ? p : null;
    });
  }
  const L = ctx.leader;
  if (L && !L.acted) {
    add(L, 1, () => {
      const p = cachedPlan(ctx, `L${L.id}`, planSig(ctx, L), () => leaderPlan(ctx, L));
      return p && p.score > 2 ? p : null;
    });
  }
  for (const b of ctx.builders) {
    if (b.acted) continue;
    const site = buildingOn(s, b.pos);
    if (site && site.owner === ctx.f && site.buildLeft > 0) continue; // never abandon a construction
    add(b, 0.6, () => {
      const p = cachedPlan(ctx, `b${b.id}`, planSig(ctx, b), () => planFor(ctx, b, undefined, 10));
      return p && p.score * 0.6 > 6 ? { ...p, score: p.score * 0.6 } : null;
    });
  }
  cands.sort((a, b) => b.ub - a.ub || a.u.id - b.u.id);
  const plans: Plan[] = [];
  let next = 0;
  for (;;) {
    let top = plans.length ? plans[0].score : -Infinity;
    while (next < cands.length && cands[next].ub > top) {
      const p = cands[next++].plan();
      if (!p) continue;
      plans.push(p);
      plans.sort((a, b) => b.score - a.score || a.unit.id - b.unit.id);
      top = plans[0].score;
    }
    const p = plans.shift();
    if (!p) return null;
    const a = execute(ctx, p);
    if (a) return a;
  }
}

/**
 * Upper bound on the score of any attack `u` can make this turn (0 = nobody in strike range):
 * the best target bound among enemies within movement + range (cheap, no pathfinding).
 */
function strikeBound(ctx: Ctx, u: Unit): number {
  let range = 1;
  for (const d of getAttackDefs(u)) range = Math.max(range, d.range);
  if (ready(u, 'firebolt')) range = Math.max(range, 3);
  const r = u.mp + range;
  let ub = 0;
  let volley = 0;
  const vr = ready(u, 'volley') ? u.mp + 1 + range + 1 : -1;
  for (const e of ctx.enemies) {
    const d = hexDistance(e.pos, u.pos);
    if (d <= r) ub = Math.max(ub, targetBound(ctx, e));
    if (d <= vr + 1) volley += targetBound(ctx, e);
  }
  return Math.max(ub, volley);
}

/** With Haste (+3 mp) could this unit land a valuable blow it cannot reach now? */
export function hastePlan(ctx: Ctx, u: Unit): Plan | null {
  if (u.acted || u.hp <= 0) return null;
  return cachedPlan(ctx, `h${u.id}`, planSig(ctx, u, 3), () => hastePlanRaw(ctx, u));
}

/** Haste is only cast for a decisive blow, so plans under this score are not searched for. */
export const HASTE_MIN_SCORE = 30;

function hastePlanRaw(ctx: Ctx, u: Unit): Plan | null {
  const saved = u.mp;
  ctx.reach.delete(u.id);
  u.mp += 3;
  let p: Plan | null;
  try {
    p = strikeBound(ctx, u) >= HASTE_MIN_SCORE ? planFor(ctx, u, undefined, HASTE_MIN_SCORE) : null;
  } finally {
    u.mp = saved;
    ctx.reach.delete(u.id);
  }
  return p;
}

// ───────────────────────────── retreat & leader ─────────────────────────────

/** Can the leader step off the castle for a turn (no hostile faction near) so a comrade heals there? */
function leaderCanYield(ctx: Ctx): boolean {
  const L = ctx.leader;
  return !!L && !!ctx.castle && hexEq(L.pos, ctx.castle.pos) && L.mp > 0 && !ctx.t.handled.has(L.id)
    && (ctx.t.strategy?.castleThreat ?? 0) === 0 && L.hp >= maxHp(ctx.s, L) * 0.6;
}

/** Best own healing building for `u` (castle and shrine cure poison). */
function healingSite(ctx: Ctx, u: Unit): Building | null {
  const s = ctx.s;
  let best: Building | null = null;
  let bv = -Infinity;
  for (const b of ctx.own) {
    if (!isFunctional(b)) continue;
    const heal = BUILDINGS[b.type].heal ?? 0;
    if (heal <= 0) continue;
    const cures = b.type === 'castle' || b.type === 'shrine';
    const occ = unitOn(s, b.pos);
    if (occ && occ.id !== u.id) {
      // Only the leader gives way, and only to cure poison.
      if (!(occ.isLeader && b.type === 'castle' && u.poisoned && leaderCanYield(ctx))) continue;
    }
    if (claimedByOther(ctx, `heal:${b.id}`, u.id)) continue;
    if (u.poisoned && !cures && hexDistance(u.pos, b.pos) > 0 && ctx.own.some((o) => (o.type === 'shrine' || o.type === 'castle') && hexDistance(o.pos, u.pos) <= 8)) continue;
    const v = heal * 0.5 + (u.poisoned && cures ? 6 : 0) - hexDistance(u.pos, b.pos) - attackersOn(ctx, b.pos, false) * 3;
    if (v > bv) { bv = v; best = b; }
  }
  if (best) claim(ctx, `heal:${best.id}`, u.id);
  return best;
}

/** Units under 40% hp (or poisoned and hurt) fall back to a healing site. */
export function retreatPhase(ctx: Ctx): Action | null {
  const s = ctx.s;
  for (const u of [...ctx.military, ...ctx.builders]) {
    if (ctx.t.handled.has(u.id) || u.summonTurns) continue;
    const r = u.hp / maxHp(s, u);
    if (!(r < 0.4 || (u.poisoned && r < 0.6))) continue;
    const danger = exposureAt(ctx, u, u.pos) > 0;
    // Builders keep working when nobody threatens them (poison never kills), unless a cure is
    // near. The last builder is the exception: an unseen monster may finish it, and a house
    // without one cannot even mine the iron to replace it.
    const lastBuilder = canBuildWith(u) && ctx.builders.length <= 1 && r < 0.4;
    if (canBuildWith(u) && !danger && !(u.poisoned && r < 0.4) && !lastBuilder) continue;
    const here = buildingOn(s, u.pos);
    const cureHere = here && (here.type === 'castle' || here.type === 'shrine');
    if (here && here.owner === ctx.f && isFunctional(here) && (BUILDINGS[here.type].heal ?? 0) > 0 && (!u.poisoned || cureHere)) {
      ctx.t.handled.add(u.id);
      continue;
    }
    // Blink out of a deadly spot when walking is not possible.
    if (ready(u, 'blink') && !u.acted && (u.mp <= 0 || exposureAt(ctx, u, u.pos) >= u.hp)) {
      const dest = blinkEscape(ctx, u);
      if (dest) {
        const a = attempt(ctx, { type: 'skill', unit: u.id, skill: 'blink', target: dest });
        if (a) { ctx.t.handled.add(u.id); return a; }
      }
    }
    if (u.mp <= 0) continue;
    const site = healingSite(ctx, u);
    // The leader makes room on the castle (it returns next turn).
    const L = ctx.leader;
    if (site && L && hexEq(L.pos, site.pos) && L.id !== u.id) {
      if (hexDistance(u.pos, site.pos) <= u.mp) {
        let spot: Hex | null = null;
        for (const ri of reachOf(ctx, L)) {
          if (hexDistance(ri.hex, site.pos) !== 1) continue;
          if (!spot || exposureAt(ctx, L, ri.hex) < exposureAt(ctx, L, spot)) spot = ri.hex;
        }
        if (spot) {
          const a = attempt(ctx, { type: 'move', unit: L.id, to: spot });
          if (a) { ctx.t.handled.add(L.id); return a; }
        }
      }
      ctx.t.handled.add(u.id);
      const a = moveToward(ctx, u, site.pos, { risk: 2.5 });
      if (a) return a;
      continue;
    }
    ctx.t.handled.add(u.id);
    let a: Action | null = null;
    if (site) a = moveToward(ctx, u, site.pos, { risk: 2.5, exact: true });
    if (!a && danger) {
      const h = safestHex(ctx, u, ctx.castle?.pos ?? ctx.home);
      if (h) a = attempt(ctx, { type: 'move', unit: u.id, to: h });
    }
    if (a) return a;
  }
  return null;
}

function blinkEscape(ctx: Ctx, u: Unit): Hex | null {
  const s = ctx.s;
  let best: Hex | null = null;
  let bv = exposureAt(ctx, u, u.pos);
  for (const h of spiral(u.pos, 3)) {
    if (hexDistance(h, u.pos) < 1 || !inBounds(h, s.width, s.height)) continue;
    if (!isExplored(s, ctx.f, h) || unitOn(s, h) || !Number.isFinite(moveCost(s, u, h))) continue;
    if (isHeldSite(ctx, h, u)) continue;
    const v = exposureAt(ctx, u, h) + hexDistance(h, ctx.home) * 0.2;
    if (v < bv - 2) { bv = v; best = h; }
  }
  return best;
}

function validCastleSite(ctx: Ctx, h: Hex, owners: (string | null)[]): boolean {
  const s = ctx.s;
  if (!inBounds(h, s.width, s.height)) return false;
  const tile = s.tiles[tileIndex(h, s.width)];
  if (tile.building != null || !BUILDINGS.castle.terrains.includes(tile.terrain)) return false;
  const o = owners[tileIndex(h, s.width)];
  if (o !== null && o !== ctx.f) return false;
  const occ = unitOn(s, h);
  return !occ || occ.faction === ctx.f;
}

/** Seat lost: the leader founds a new castle (anywhere it stands, DESIGN §5 / economy rules). */
function foundCastle(ctx: Ctx, L: Unit): Action | null {
  const s = ctx.s;
  if (!L.acted && canBuildAt(s, L, 'castle') === null) return attempt(ctx, { type: 'build', unit: L.id, building: 'castle' });
  const owners = computeTerritory(s) as (string | null)[];
  const hereOk = validCastleSite(ctx, L.pos, owners) && exposureAt(ctx, L, L.pos) < L.hp * 0.4;
  if (hereOk) return null; // saving up on a good spot
  if (L.mp <= 0) return null;
  let best: Hex | null = null;
  let bv = -Infinity;
  for (const h of spiral(L.pos, 8)) {
    if (!validCastleSite(ctx, h, owners)) continue;
    const i = tileIndex(h, s.width);
    let v = -hexDistance(h, L.pos) * 1.2 - (exposureAt(ctx, L, h) / Math.max(1, L.hp)) * 12;
    if (owners[i] === ctx.f) v += 3;
    for (const b of ctx.own) if (hexDistance(b.pos, h) <= 2) v += 0.6;
    if (v > bv) { bv = v; best = h; }
  }
  if (!best) {
    const h = safestHex(ctx, L, ctx.home);
    return h ? attempt(ctx, { type: 'move', unit: L.id, to: h }) : null;
  }
  return moveToward(ctx, L, best, { risk: 2.5, exact: true });
}

/** The leader holds the castle (recruits, +25% defense, heals) and returns to it after sorties. */
export function leaderPhase(ctx: Ctx): Action | null {
  const L = ctx.leader;
  if (!L || ctx.t.handled.has(L.id)) return null;
  const s = ctx.s;
  if (!ctx.castle) {
    const a = foundCastle(ctx, L);
    if (!a || a.type === 'move') ctx.t.handled.add(L.id);
    return a;
  }
  const seat = ctx.castle.pos;
  // Mortal danger (massed archers can kill a leader even on its castle): step out of reach.
  if (L.mp > 0 && !L.acted) {
    const here = exposureAt(ctx, L, L.pos);
    if (here >= L.hp * 0.6) {
      let best: Hex | null = null;
      let bv = here + hexDistance(L.pos, seat) * 0.5;
      for (const ri of reachOf(ctx, L)) {
        const v = exposureAt(ctx, L, ri.hex) + hexDistance(ri.hex, seat) * 0.5;
        if (v < bv * 0.75) { bv = v; best = ri.hex; }
      }
      ctx.t.handled.add(L.id);
      if (best) return attempt(ctx, { type: 'move', unit: L.id, to: best });
      return null;
    }
  }
  if (hexEq(L.pos, seat) || L.mp <= 0) { ctx.t.handled.add(L.id); return null; }
  // A comrade sitting on the throne makes way first.
  const occ = unitOn(s, seat);
  if (occ && occ.faction === ctx.f && occ.id !== L.id && occ.mp > 0) {
    const h = safestHex(ctx, occ, seat);
    const alt = h && !hexEq(h, seat) ? h
      : reachOf(ctx, occ).find((ri) => hexDistance(ri.hex, seat) <= 2 && !isHeldSite(ctx, ri.hex, occ))?.hex;
    if (alt) {
      const a = attempt(ctx, { type: 'move', unit: occ.id, to: alt });
      if (a) { ctx.t.handled.add(occ.id); return a; }
    }
  }
  ctx.t.handled.add(L.id);
  if (exposureAt(ctx, L, seat) >= L.hp * 0.6) return null; // wait until the seat is safe again
  return moveToward(ctx, L, seat, { risk: 2, exact: true });
}

// ───────────────────────────── army movement ─────────────────────────────

/** Capturable / razable hostile building this unit can end on this turn. */
function captureTarget(ctx: Ctx, u: Unit, maxDistHome = Infinity): Hex | null {
  const s = ctx.s;
  let best: Hex | null = null;
  let bv = 0;
  for (const ri of reachOf(ctx, u)) {
    const b = buildingOn(s, ri.hex);
    if (!b || b.owner === ctx.f) continue;
    if (b.owner === null ? false : !s.factions[b.owner]?.alive) continue;
    if (hexDistance(ri.hex, ctx.home) > maxDistHome) continue;
    const def = BUILDINGS[b.type];
    const razes = b.type === 'castle';
    if (def.uncapturable && !razes) continue;
    if (claimedByOther(ctx, `cap:${b.id}`, u.id)) continue;
    const expo = exposureAt(ctx, u, ri.hex);
    if (!razes && expo > u.hp * 0.8) continue;
    const worth = razes ? 120 : b.type === 'magetower' ? 30 : b.type === 'library' ? 26 : b.type === 'mine' || b.type === 'crystalmine' ? 22
      : b.type === 'forge' || b.type === 'training' ? 16 : 12;
    const v = worth - (expo / Math.max(1, u.hp)) * 10 - ri.cost * 0.2;
    if (v > bv) { bv = v; best = ri.hex; }
  }
  if (best) {
    const b = buildingOn(s, best);
    if (b) claim(ctx, `cap:${b.id}`, u.id);
  }
  return best;
}

function nearestIntruder(ctx: Ctx, u: Unit, strat: Strategy, maxDist: number): Unit | null {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const e of strat.intruders) {
    if (!ctx.s.units[String(e.id)]) continue;
    const d = hexDistance(e.pos, u.pos) + (e.faction === 'neutral' ? 3 : 0);
    if (d < bd && d <= maxDist) { bd = d; best = e; }
  }
  return best;
}

/** Sum of power of own armed units within `r` of `h`. */
function localPower(ctx: Ctx, h: Hex, r: number): number {
  let p = 0;
  for (const u of ctx.military) if (hexDistance(u.pos, h) <= r) p += powerOf(ctx.s, u);
  if (ctx.leader && hexDistance(ctx.leader.pos, h) <= r) p += powerOf(ctx.s, ctx.leader) * 0.5;
  return p;
}

function enemyPowerNear(ctx: Ctx, h: Hex, r: number): number {
  let p = 0;
  for (const e of ctx.enemies) if (ctx.s.units[String(e.id)] && hexDistance(e.pos, h) <= r) p += powerOf(ctx.s, e);
  return p;
}

/** Nearest unlooted ruin this unit should go for (claimed), or null. */
function lootTarget(ctx: Ctx, u: Unit, maxDist: number, unguardedOnly: boolean): Hex | null {
  const s = ctx.s;
  let pick: Hex | null = null;
  let pv = -Infinity;
  for (const r of unlootedRuins(ctx, maxDist)) {
    if (claimedByOther(ctx, `loot:${r.q},${r.r}`, u.id)) continue;
    const guards = enemyPowerNear(ctx, r, 3);
    if (unguardedOnly ? guards > 0 : guards > 0 && localPower(ctx, r, 5) + powerOf(s, u) < guards * 1.3) continue;
    const v = -hexDistance(u.pos, r) - hexDistance(ctx.home, r) * 0.3;
    if (v > pv) { pv = v; pick = r; }
  }
  if (pick) claim(ctx, `loot:${pick.q},${pick.r}`, u.id);
  return pick;
}

function unlootedRuins(ctx: Ctx, maxDist: number): Hex[] {
  const s = ctx.s;
  const out: Hex[] = [];
  for (const h of spiral(ctx.home, maxDist)) {
    if (!inBounds(h, s.width, s.height)) continue;
    const t = s.tiles[tileIndex(h, s.width)];
    if (t.terrain === 'ruins' && !t.ruinsLooted) out.push(h);
  }
  return out;
}

function moveUnit(ctx: Ctx, u: Unit, strat: Strategy, claims: Map<number, unknown[]>): Action | null {
  const s = ctx.s;
  const home = ctx.castle?.pos ?? ctx.home;
  const armed = isArmed(u);
  const inArmy = strat.stance === 'attack' && strat.army.has(u.id);
  const offCastle = (h: Hex) => (ctx.castle && hexEq(h, ctx.castle.pos) ? -6 : 0);

  // 0. A channeler holds its mage tower: spell reach matters most when the fight comes home,
  //    and it still strikes from there in the attack phase.
  const post = strat.channelers.get(u.id);
  if (post && !inArmy) {
    if (hexEq(u.pos, post)) return null;
    const a = moveToward(ctx, u, post, { risk: 1.2, exact: true });
    if (a) return a;
  }

  // 1. Defend our lands against intruders (everyone turns out when the castle itself is in danger).
  const levy = !armed && strat.castleThreat > 0;
  const intr = armed ? nearestIntruder(ctx, u, strat, inArmy ? 6 : 12)
    : levy ? nearestIntruder(ctx, u, strat, 8) : null;
  if (intr && (armed || (intr.faction !== 'neutral' && hexDistance(intr.pos, home) <= 5))
    && (!inArmy || hexDistance(intr.pos, home) <= 6)) {
    const mine = localPower(ctx, intr.pos, 6) + powerOf(s, u);
    const theirs = enemyPowerNear(ctx, intr.pos, 3);
    const risk = mine >= theirs * 1.2 ? 0.8 : 1.6;
    const a = moveToward(ctx, u, intr.pos, { risk, bias: offCastle });
    if (a) return a;
    return null;
  }

  // 2. Fetch better gear from the stockpile at a nearby armory.
  if (claims.get(u.id)?.length && (!inArmy || hexDistance(u.pos, home) <= 8)) {
    const arm = nearestArmory(ctx, u, inArmy ? 6 : 14);
    if (arm && !claimedByOther(ctx, `armory:${arm.q},${arm.r}`, u.id)) {
      claim(ctx, `armory:${arm.q},${arm.r}`, u.id);
      if (hexEq(arm, u.pos)) return null;
      const a = moveToward(ctx, u, arm, { risk: 1.2, exact: true });
      if (a) return a;
    }
  }

  // 3. The host marches on the enemy, taking what it can on the way.
  if (inArmy && strat.anchor) {
    const cap = captureTarget(ctx, u);
    if (cap) {
      const a = attempt(ctx, { type: 'move', unit: u.id, to: cap });
      if (a) return a;
    }
    return moveToward(ctx, u, strat.anchor, { risk: 0.55, limit: strat.advanceLimit });
  }

  // 4. Unarmed commoners: loot unguarded ruins nearby, drill at the training ground, else work a
  //    free producing building near home (bare hands still add 25%, DESIGN §5).
  if (!armed && !u.monster) {
    if (u.hp >= maxHp(s, u) * 0.8) {
      const r = lootTarget(ctx, u, 10, true);
      if (r) {
        const a = moveToward(ctx, u, r, { risk: 2, exact: true });
        if (a) return a;
      }
    }
    const tg = freeBuilding(ctx, u, (b) => b.type === 'training', 12, 'post');
    if (tg) return hexEq(tg, u.pos) ? null : moveToward(ctx, u, tg, { risk: 2, exact: true });
    const post = workPost(ctx, u, 8);
    if (post) return hexEq(post, u.pos) ? null : moveToward(ctx, u, post, { risk: 2, exact: true, bias: offCastle });
    return null;
  }

  // 5. Mages channel in a free mage tower (spell reach, magic XP) before any errand.
  if (trackOf(u) === 'mage') {
    const tw = freeBuilding(ctx, u, (b) => b.type === 'magetower', 14, 'post');
    if (tw) return hexEq(tw, u.pos) ? null : moveToward(ctx, u, tw, { risk: 1.2, exact: true });
  }

  // 6. Abandoned buildings near home are free for the taking.
  const grab = captureTarget(ctx, u, 10);
  if (grab) {
    const a = attempt(ctx, { type: 'move', unit: u.id, to: grab });
    if (a) return a;
  }

  // 7. Hunt monsters close to home (XP, safer ruins) when we clearly outmatch them.
  if (!u.summonTurns || hexDistance(u.pos, home) <= 8) {
    let prey: Unit | null = null;
    let pd = Infinity;
    for (const m of ctx.monsters) {
      if (!s.units[String(m.id)] || hexDistance(m.pos, home) > 9) continue;
      const d = hexDistance(m.pos, u.pos);
      if (d < pd && localPower(ctx, m.pos, 5) + powerOf(s, u) >= enemyPowerNear(ctx, m.pos, 3) * 1.3) { pd = d; prey = m; }
    }
    if (prey && pd <= 10) {
      const a = moveToward(ctx, u, prey.pos, { risk: 0.9, bias: offCastle });
      if (a) return a;
    }
  }

  // 8. Loot unexplored ruins (gold, items, iron, research) when the guardians are not too strong.
  if (!u.summonTurns && u.hp >= maxHp(s, u) * 0.7) {
    const pick = lootTarget(ctx, u, 13, false);
    if (pick) {
      const a = moveToward(ctx, u, pick, { risk: 1.2, exact: true });
      if (a) return a;
      return null;
    }
  }

  // 9. Drill at a training ground (+5 melee or ranged XP a turn) when one is free.
  if (!u.summonTurns) {
    const tg = freeBuilding(ctx, u, (b) => b.type === 'training', 10, 'post');
    if (tg) return hexEq(tg, u.pos) ? null : moveToward(ctx, u, tg, { risk: 1.2, exact: true });
  }

  // 10. Guard the frontier: stand on the buildings closest to the rival (blocks captures).
  const anchor = strat.anchor;
  const posts = new Set([...strat.channelers.values()].map((h) => `${h.q},${h.r}`));
  const frontier = ctx.own
    .filter((b) => b.type !== 'castle' && b.type !== 'wall' && !BUILDINGS[b.type].heal && !posts.has(`${b.pos.q},${b.pos.r}`))
    .sort((a, b) => (anchor ? hexDistance(a.pos, anchor) - hexDistance(b.pos, anchor) : 0) || a.id - b.id);
  for (const b of frontier) {
    const occ = unitOn(s, b.pos);
    if (occ && occ.id !== u.id) continue;
    if (hexDistance(b.pos, u.pos) > 14) continue;
    const key = `post:${b.pos.q},${b.pos.r}`;
    if (claimedByOther(ctx, key, u.id)) continue;
    claim(ctx, key, u.id);
    if (hexEq(b.pos, u.pos)) return null;
    return moveToward(ctx, u, b.pos, { risk: 1.2, exact: true });
  }
  // Nothing to do: stay close to home, off the castle.
  if (hexDistance(u.pos, home) > 4 || (ctx.castle && hexEq(u.pos, ctx.castle.pos))) {
    return moveToward(ctx, u, home, { risk: 1.2, bias: offCastle });
  }
  return null;
}

/** Producing buildings an idle unarmed commoner works (towers are mages' posts, the castle the leader's). */
const COMMONER_POSTS: BuildingId[] = ['farm', 'lumber', 'quarry', 'mine', 'crystalmine', 'library', 'house'];

/** Stock below which a resource counts as short when an idle commoner picks a post. */
const SHORT_STOCK = 20;

/**
 * The free producing building an idle commoner should work within `maxDist` (bare hands add 25%):
 * the nearest, counting one making a resource the house is short of as 3 hexes nearer. Skips
 * buildings a builder means to work (tools get more out of them). Claims the post.
 */
function workPost(ctx: Ctx, u: Unit, maxDist: number): Hex | null {
  const res = ctx.fs.resources;
  const short = (b: Building): boolean => Object.entries(BUILDINGS[b.type].output)
    .some(([r, n]) => (n ?? 0) > 0 && r !== 'research' && (res[r as keyof typeof res] ?? 0) < SHORT_STOCK);
  let best: Building | null = null;
  let bv = -Infinity;
  for (const b of ctx.own) {
    if (!COMMONER_POSTS.includes(b.type) || !isFunctional(b)) continue;
    const occ = unitOn(ctx.s, b.pos);
    if (occ && occ.id !== u.id) continue;
    if (claimedByOther(ctx, `post:${b.pos.q},${b.pos.r}`, u.id) || claimedByOther(ctx, `work:${b.id}`, u.id)) continue;
    const d = hexDistance(b.pos, u.pos);
    if (d > maxDist) continue;
    const v = -d + (short(b) ? 3 : 0);
    if (v > bv) { bv = v; best = b; }
  }
  if (!best) return null;
  claim(ctx, `post:${best.pos.q},${best.pos.r}`, u.id);
  return best.pos;
}

/** Nearest own functional building matching `pred` that is free (or occupied by `u`) and unclaimed. */
function freeBuilding(ctx: Ctx, u: Unit, pred: (b: Building) => boolean, maxDist: number, tag: string): Hex | null {
  let best: Building | null = null;
  let bd = Infinity;
  for (const b of ctx.own) {
    if (!pred(b) || !isFunctional(b)) continue;
    const occ = unitOn(ctx.s, b.pos);
    if (occ && occ.id !== u.id) continue;
    const key = `${tag}:${b.pos.q},${b.pos.r}`;
    if (claimedByOther(ctx, key, u.id)) continue;
    const d = hexDistance(b.pos, u.pos);
    if (d < bd && d <= maxDist) { bd = d; best = b; }
  }
  if (!best) return null;
  claim(ctx, `${tag}:${best.pos.q},${best.pos.r}`, u.id);
  return best.pos;
}

/** Every military unit without an attack gets an objective and moves toward it. */
export function militaryMovePhase(ctx: Ctx): Action | null {
  const strat = getStrategy(ctx);
  const claims = equipClaims(ctx);
  for (const u of ctx.military) {
    if (ctx.t.handled.has(u.id) || u.mp <= 0) continue;
    ctx.t.handled.add(u.id);
    const a = moveUnit(ctx, u, strat, claims);
    if (a) return a;
  }
  return null;
}

