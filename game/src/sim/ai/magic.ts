// Spells from mage towers and active unit skills (DESIGN §7, §4.8, §9 "Spells").
import type { Action, Hex, SpellId, Unit } from '../../core/types';
import { hexDistance, inBounds, spiral, tileIndex } from '../../core/hex';
import { SPELLS } from '../../data/spells';
import { TERRAIN } from '../../data/terrain';
import { fireballDamageAt, HEAL_HP, knownSpells, manaCap, STORM_BOLTS, STORM_DAMAGE } from '../spells';
import { mendOf } from '../skills';
import { canBuildWith, effectiveStats, getAttackDefs } from '../units';
import { isVisible } from '../visibility';
import { buildingOn, isFunctional, unitOn } from '../ruleutil';
import { getStrategy } from './strategy';
import { HASTE_MIN_SCORE, hastePlan, ready } from './tactics';
import { exposureAt } from './threat';
import type { Ctx } from './types';
import { attempt, maxHp, mhp, unitsNear, val, valueOf } from './util';

interface SpellOption { spell: SpellId; target: Hex; value: number }

/** Value of `dmg` unblockable damage on `u` (positive for enemies, negative for our own). */
function harm(ctx: Ctx, u: Unit, dmg: number, pk?: number): number {
  const mx = mhp(ctx, u);
  const V = val(ctx, u);
  const dealt = Math.min(dmg, u.hp);
  const kill = pk ?? (dmg >= u.hp ? 1 : 0);
  if (u.faction === ctx.f) {
    return -((dealt / mx) * V * 1.0 + kill * V * 2) * (u.isLeader ? 6 : 1);
  }
  let v = (dealt / mx) * V * 0.8 + kill * V * 1.2;
  if (u.isLeader && u.faction !== 'neutral') v = v * 4 + kill * 700;
  if (u.faction === 'neutral') v *= hexDistance(u.pos, ctx.home) <= 9 ? 0.6 : 0.3;
  return v;
}

function binomAtLeast(n: number, p: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let tot = 0;
  for (let i = k; i <= n; i++) {
    let c = 1;
    for (let j = 1; j <= i; j++) c = (c * (n - i + j)) / j;
    tot += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return tot;
}

/** Hexes worth considering as centres around the given units. */
function centersAround(ctx: Ctx, units: Unit[], r: number): Hex[] {
  const s = ctx.s;
  const seen = new Set<number>();
  const out: Hex[] = [];
  for (const u of units) {
    for (const h of spiral(u.pos, r)) {
      if (!inBounds(h, s.width, s.height)) continue;
      const i = tileIndex(h, s.width);
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(h);
    }
  }
  return out;
}

function unitsWithin(ctx: Ctx, c: Hex, r: number): Unit[] {
  return unitsNear(ctx, c, r);
}

const seen = (ctx: Ctx, u: Unit) => u.faction === ctx.f || isVisible(ctx.s, ctx.f, u.pos);

/** Each functional own tower with its reach bonus (⌊int/3⌋ of its channeler, sim/spells.towerRange). */
function towerReach(ctx: Ctx): { pos: Hex; bonus: number }[] {
  const s = ctx.s;
  return towers(ctx).map((b) => {
    const occ = ctx.at.get(tileIndex(b.pos, s.width));
    const ch = occ && occ.faction === ctx.f && !occ.monster ? occ : undefined;
    return { pos: b.pos, bonus: ch ? Math.floor(Math.max(0, effectiveStats(s, ch).int) / 3) : 0 };
  });
}

/** Can any own tower reach `target` with `spell`? */
function inReach(ctx: Ctx, spell: SpellId, target: Hex, tw = towerReach(ctx)): boolean {
  const r = SPELLS[spell].range;
  return tw.some((t) => hexDistance(t.pos, target) <= r + t.bonus);
}

/** Mana of the dearest spell the house knows, Farsight aside (what a pool is saved up for). */
function dearestSpell(ctx: Ctx): number {
  let r = 0;
  for (const sp of knownSpells(ctx.s, ctx.f)) if (sp !== 'farsight') r = Math.max(r, SPELLS[sp].mana);
  return r;
}

/**
 * Mana pressure: a pool near its cap is wasted income, so the value bar for casting drops
 * (×0.5 at 90% full, ×0.75 at 70%, and ×0.8 whenever the pool holds two of the dearest
 * known spell: casting now blocks nothing).
 */
function manaFactor(ctx: Ctx): number {
  const mana = ctx.fs.resources.mana;
  const fill = mana / Math.max(1, manaCap(ctx.s, ctx.f));
  const k = fill >= 0.9 ? 0.5 : fill >= 0.7 ? 0.75 : 1;
  const top = dearestSpell(ctx);
  return top > 0 && mana >= top * 2 ? Math.min(k, 0.8) : k;
}

/** The point `steps` hexes from `a` along the straight line to `b` (or `b` itself when nearer). */
function stepAlong(a: Hex, b: Hex, steps: number): Hex {
  const n = hexDistance(a, b);
  if (n <= steps) return { ...b };
  const t = steps / n;
  // Cube lerp, then round (standard hex line drawing).
  const aq = a.q, ar = a.r, as = -a.q - a.r;
  const bq = b.q, br = b.r, bs = -b.q - b.r;
  let q = Math.round(aq + (bq - aq) * t), r = Math.round(ar + (br - ar) * t);
  const sx = Math.round(as + (bs - as) * t);
  const dq = Math.abs(q - (aq + (bq - aq) * t)), dr = Math.abs(r - (ar + (br - ar) * t)), ds = Math.abs(sx - (as + (bs - as) * t));
  if (dq > dr && dq > ds) q = -r - sx; else if (dr > ds) r = -q - sx;
  return { q, r };
}

/**
 * The most valuable target of `spell` that some own tower can actually reach (a big fight out
 * of range must not hide the smaller one next door).
 */
function bestFor(ctx: Ctx, spell: SpellId): SpellOption | null {
  const s = ctx.s;
  const strat = getStrategy(ctx);
  const tw = towerReach(ctx);
  const k = manaFactor(ctx);
  let best: SpellOption | null = null;
  const take = (target: Hex, value: number) => {
    if (best && value <= best.value) return;
    if (!inBounds(target, s.width, s.height) || !inReach(ctx, spell, target, tw)) return;
    best = { spell, target, value };
  };
  switch (spell) {
    case 'fireball': {
      for (const c of centersAround(ctx, ctx.enemies, 1)) {
        let v = 0;
        for (const u of unitsWithin(ctx, c, 1)) {
          if (!seen(ctx, u)) continue;
          v += harm(ctx, u, fireballDamageAt(hexDistance(u.pos, c)));
        }
        if (v >= 28 * k) take(c, v);
      }
      break;
    }
    case 'storm': {
      for (const c of centersAround(ctx, ctx.foes.length ? ctx.foes : ctx.enemies, 1)) {
        const pool = unitsWithin(ctx, c, 2).filter((u) => u.faction !== ctx.f);
        const visible = pool.filter((u) => seen(ctx, u));
        if (!visible.length) continue;
        const n = pool.length;
        let v = 0;
        for (const e of visible) {
          const pk = binomAtLeast(STORM_BOLTS, 1 / n, Math.ceil(e.hp / STORM_DAMAGE));
          v += harm(ctx, e, Math.min(e.hp, (STORM_DAMAGE * STORM_BOLTS) / n), pk);
        }
        if (v >= 32 * k) take(c, v);
      }
      break;
    }
    case 'heal': {
      const hurt = ctx.units.filter((u) => u.poisoned || u.hp < maxHp(s, u) - 6);
      for (const c of centersAround(ctx, hurt, 1)) {
        let v = 0;
        for (const u of unitsWithin(ctx, c, 1)) {
          if (u.faction !== ctx.f) continue;
          const mx = maxHp(s, u);
          v += (Math.min(HEAL_HP, mx - u.hp) / mx) * valueOf(u) * 0.9 * (u.isLeader ? 2 : 1) + (u.poisoned ? 6 : 0);
        }
        if (v >= 12 * k) take(c, v);
      }
      break;
    }
    case 'bless': {
      // Before a big attack: allies who can strike this turn, or who stand in harm's way.
      const engaged = (u: Unit) => {
        if (u.acted) return exposureAt(ctx, u, u.pos) > 0 ? 0.5 : 0;
        let r = 0;
        for (const d of getAttackDefs(u)) r = Math.max(r, d.range);
        return ctx.enemies.some((e) => hexDistance(e.pos, u.pos) <= u.mp + r + 1) ? 1 : 0;
      };
      const fighters = ctx.units.filter((u) => engaged(u) > 0);
      for (const c of centersAround(ctx, fighters, 1)) {
        let v = 0;
        let n = 0;
        for (const u of unitsWithin(ctx, c, 1)) {
          if (u.faction !== ctx.f) continue;
          const e = engaged(u);
          if (e <= 0) continue;
          n++;
          v += (u.isLeader ? 12 : 8) * e;
        }
        if ((n >= 2 || (n >= 1 && k <= 0.5)) && v >= 16 * k) take(c, v);
      }
      break;
    }
    case 'summon': {
      // Stone guardians where our holdings or people are under pressure within tower reach: the
      // castle, a building with raiders next to it, or our units with foes at their throats.
      // With mana to spare (two summons' worth) monsters raiding a building count as raiders.
      const spare = ctx.fs.resources.mana >= SPELLS.summon.mana * 2;
      const hostile = (e: Unit) => e.faction !== 'neutral' || spare;
      const seats: Hex[] = [];
      const add = (h: Hex) => { if (!seats.some((x) => x.q === h.q && x.r === h.r)) seats.push(h); };
      if (ctx.castle && strat.castleThreat >= 1) add(ctx.castle.pos);
      for (const b of ctx.own) {
        if (!inReach(ctx, 'summon', b.pos, tw)) continue;
        if (strat.intruders.some((e) => hostile(e) && hexDistance(e.pos, b.pos) <= 1)) add(b.pos);
      }
      for (const u of ctx.units) {
        if (u.monster || !inReach(ctx, 'summon', u.pos, tw)) continue;
        if (ctx.foes.some((e) => hexDistance(e.pos, u.pos) <= 2)) add(u.pos);
      }
      for (const seat of seats) {
        const foes = ctx.enemies.filter((e) => hostile(e) && hexDistance(e.pos, seat) <= 6);
        for (const h of spiral(seat, 3)) {
          if (!inBounds(h, s.width, s.height) || unitOn(s, h) || !isVisible(s, ctx.f, h)) continue;
          if (!Number.isFinite(TERRAIN[s.tiles[tileIndex(h, s.width)].terrain].moveCost)) continue;
          // Never on someone else's building (sim/spells refuses it).
          const bh = buildingOn(s, h);
          if (bh && bh.owner !== ctx.f) continue;
          let nearest = Infinity;
          for (const e of foes) nearest = Math.min(nearest, hexDistance(e.pos, h));
          if (!Number.isFinite(nearest)) continue;
          take(h, 45 + foes.length * 5 - nearest * 2 - hexDistance(h, seat));
        }
      }
      // An overflowing pool at war: a guardian next to the tower nearest the front joins the
      // host (or the home guard) for its 8 turns, rather than mana idling. Two at most.
      const guardians = ctx.units.filter((u) => u.summonTurns).length;
      const atWar = strat.stance === 'attack' || strat.intruders.some((e) => e.faction !== 'neutral');
      if (!best && spare && atWar && guardians < 2 && strat.anchor) {
        const front = tw.slice().sort((a, b) => hexDistance(a.pos, strat.anchor!) - hexDistance(b.pos, strat.anchor!))[0];
        if (front) {
          for (const h of spiral(front.pos, 2)) {
            if (!inBounds(h, s.width, s.height) || unitOn(s, h) || !isVisible(s, ctx.f, h)) continue;
            if (!Number.isFinite(TERRAIN[s.tiles[tileIndex(h, s.width)].terrain].moveCost)) continue;
            const bh = buildingOn(s, h);
            if (bh && bh.owner !== ctx.f) continue;
            take(h, 30 - hexDistance(h, strat.anchor) * 0.1);
          }
        }
      }
      break;
    }
    case 'farsight': {
      // Look where it matters: toward the rival from each tower, ahead of the marching host,
      // and around raiders near our border. Worth more the more fog it lifts near our people.
      const fill = ctx.fs.resources.mana / Math.max(1, manaCap(s, ctx.f));
      const raided = strat.intruders.some((e) => e.faction !== 'neutral');
      if (!(strat.stance === 'attack' || raided || fill >= 0.6)) break;
      const cands: Hex[] = [];
      const r = SPELLS.farsight.range;
      for (const t of tw) if (strat.anchor) cands.push(stepAlong(t.pos, strat.anchor, r + t.bonus));
      if (strat.anchor) {
        const host = ctx.military.filter((u) => strat.army.has(u.id));
        if (host.length) {
          const lead = host.reduce((a, b) => (hexDistance(a.pos, strat.anchor!) <= hexDistance(b.pos, strat.anchor!) ? a : b));
          cands.push(stepAlong(lead.pos, strat.anchor, 4));
        }
      }
      for (const e of strat.intruders) if (e.faction !== 'neutral') cands.push({ ...e.pos });
      const ours = (h: Hex) => ctx.units.some((u) => hexDistance(u.pos, h) <= 4) || ctx.own.some((b) => hexDistance(b.pos, h) <= 4);
      for (const c of cands) {
        let hidden = 0;
        for (const h of spiral(c, 4)) if (inBounds(h, s.width, s.height) && !isVisible(s, ctx.f, h)) hidden++;
        if (hidden < 10) continue;
        take(c, hidden * 0.15 * (ours(c) ? 1.5 : 1) * (fill >= 0.9 ? 1.5 : 1));
      }
      break;
    }
    case 'haste':
      break; // cast from hastePhase, where the tactical search knows what extra movement buys
  }
  return best;
}

function towers(ctx: Ctx) {
  return ctx.own.filter((b) => b.type === 'magetower' && isFunctional(b));
}

/**
 * Own towers that can reach `target` with `spell` (spell range + ⌊int/3⌋ of the unit standing
 * in the tower), channelled towers first. Same rule as sim/spells.towerRange, via the
 * per-call spatial index.
 */
function reachingTowers(ctx: Ctx, spell: SpellId, target: Hex): number[] {
  const s = ctx.s;
  const out: { id: number; ch: number; d: number }[] = [];
  for (const b of towers(ctx)) {
    const occ = ctx.at.get(tileIndex(b.pos, s.width));
    const ch = occ && occ.faction === ctx.f && !occ.monster ? occ : undefined;
    const bonus = ch ? Math.floor(Math.max(0, effectiveStats(s, ch).int) / 3) : 0;
    const d = hexDistance(b.pos, target);
    if (d <= SPELLS[spell].range + bonus) out.push({ id: b.id, ch: ch ? 1 : 0, d });
  }
  return out.sort((a, b) => b.ch - a.ch || a.d - b.d || a.id - b.id).map((x) => x.id);
}

/**
 * Mana a scouting spell (Farsight) must leave in the pool: enough for the dearest war spell the
 * house knows, up to a Fireball's 30, so cheap looks do not keep the pool too low for the
 * spells that win fights. Waived once the pool is 60% full (it would only fill up anyway).
 */
export function scoutReserve(ctx: Ctx): number {
  const fill = ctx.fs.resources.mana / Math.max(1, manaCap(ctx.s, ctx.f));
  return fill >= 0.6 ? 0 : Math.min(30, dearestSpell(ctx));
}

/** Cast the most valuable spell available (one per call; each spell has its own cooldown). */
export function spellPhase(ctx: Ctx): Action | null {
  const { s, f, fs } = ctx;
  if (!towers(ctx).length) return null;
  const opts: SpellOption[] = [];
  for (const spell of knownSpells(s, f)) {
    const def = SPELLS[spell];
    if ((fs.spellCooldowns[spell] ?? 0) > 0 || fs.resources.mana + 1e-9 < def.mana) continue;
    if (spell === 'farsight' && fs.resources.mana - def.mana + 1e-9 < scoutReserve(ctx)) continue;
    const o = bestFor(ctx, spell);
    if (o) opts.push(o);
  }
  opts.sort((a, b) => b.value - a.value || a.spell.localeCompare(b.spell));
  for (const o of opts) {
    // Only targets some tower can actually reach.
    for (const tw of reachingTowers(ctx, o.spell, o.target)) {
      const a = attempt(ctx, { type: 'cast', faction: f, spell: o.spell, tower: tw, target: { ...o.target } });
      if (a) return a;
    }
  }
  return null;
}

/** Haste a unit that could then reach a decisive blow (a kill or the enemy leader). */
export function hastePhase(ctx: Ctx): Action | null {
  const { s, f, fs } = ctx;
  if (!knownSpells(s, f).includes('haste')) return null;
  if ((fs.spellCooldowns.haste ?? 0) > 0 || fs.resources.mana < SPELLS.haste.mana) return null;
  if (!towers(ctx).length || !ctx.enemies.length) return null;
  for (const u of ctx.military) {
    if (u.acted || u.mp <= 0) continue;
    // Only worth a look when the extra 3 hexes are what separates it from an enemy.
    let range = 1;
    for (const d of getAttackDefs(u)) range = Math.max(range, d.range);
    let nearest = Infinity;
    for (const e of ctx.enemies) nearest = Math.min(nearest, hexDistance(e.pos, u.pos));
    if (nearest <= range || nearest > u.mp + 3 + range) continue;
    const tws = reachingTowers(ctx, 'haste', u.pos);
    if (!tws.length) continue;
    const p = hastePlan(ctx, u);
    if (!p || p.score < HASTE_MIN_SCORE || !(p.pk >= 0.5 || p.target.isLeader)) continue;
    const a = attempt(ctx, { type: 'cast', faction: f, spell: 'haste', tower: tws[0], target: { ...u.pos } });
    if (a) return a;
  }
  return null;
}

/** Rally (+2 mp to allies within 2) right before the host moves out. */
export function rallyPhase(ctx: Ctx): Action | null {
  const strat = getStrategy(ctx);
  const pushing = strat.stance === 'attack' || strat.intruders.some((e) => e.faction !== 'neutral');
  if (!pushing) return null;
  for (const u of [ctx.leader, ...ctx.military].filter((x): x is Unit => !!x)) {
    if (!ready(u, 'rally') || u.acted) continue;
    let n = 0;
    for (const o of ctx.military) {
      if (o.id === u.id || ctx.t.handled.has(o.id) || o.mp <= 0 || o.moveEnded || o.justSpawned) continue;
      if (hexDistance(o.pos, u.pos) <= 2) n++;
    }
    if (n < 2) continue;
    const a = attempt(ctx, { type: 'skill', unit: u.id, skill: 'rally' });
    if (a) return a;
  }
  return null;
}

/** Mend (heal an adjacent ally or oneself, mendOf by rank) for units that will not attack this turn. */
export function mendPhase(ctx: Ctx): Action | null {
  const s = ctx.s;
  for (const u of ctx.units) {
    if (!ready(u, 'heal') || u.acted) continue;
    let best: Unit | null = null;
    let bv = 4;
    for (const o of ctx.units) {
      if (hexDistance(o.pos, u.pos) > 1) continue;
      const mx = maxHp(s, o);
      const missing = mx - o.hp;
      if (missing < 6 && !o.poisoned) continue;
      const v = (Math.min(mendOf(u), missing) / mx) * valueOf(o) * (o.isLeader ? 2 : 1) + (o.poisoned ? 5 : 0);
      if (v > bv) { bv = v; best = o; }
    }
    if (!best) continue;
    const a = attempt(ctx, { type: 'skill', unit: u.id, skill: 'heal', target: { ...best.pos } });
    if (a) return a;
  }
  return null;
}

/** Fortify (+7.5% armor per rank until next turn; uses the action) for exposed units that are done for the turn. */
export function fortifyPhase(ctx: Ctx): Action | null {
  for (const u of ctx.units) {
    if (!ready(u, 'fortify') || u.acted || u.buffs.some((b) => b.id === 'fortify')) continue;
    if (exposureAt(ctx, u, u.pos) < u.hp * 0.25) continue;
    // Digging in forfeits the turn's work on a construction site.
    const site = buildingOn(ctx.s, u.pos);
    if (site && site.owner === ctx.f && site.buildLeft > 0 && canBuildWith(u)) continue;
    const a = attempt(ctx, { type: 'skill', unit: u.id, skill: 'fortify' });
    if (a) return a;
  }
  return null;
}
