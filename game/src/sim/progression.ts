// XP, levels and level-up choices. See DESIGN §4.7.
import type { GameEvent, GameState, PassiveId, ActiveId, SkillOptionDef, Unit, UnitStats, XpCategory } from '../core/types';
import { LEVEL_OPTIONS, LEVEL_OPTION_BY_ID, MAX_LEVEL, LEADER_XP_MULT, XP_CATEGORIES, xpToNext, zeroXp } from '../data/skills';
import { rand } from '../core/rng';
import { addLog } from './state';
import { canBuildWith, getAttackDefs, effectiveStats, mainAttackKind } from './units';
import { computeVisibility } from './visibility';

/** Max HP gained (and healed) on every level-up. */
export const LEVEL_HP_GAIN = 4;
/** Multiplier applied by each efficiency pick. */
export const EFFICIENCY_STEP = 1.25;

const XP_CATS = XP_CATEGORIES;
const ECONOMY_PASSIVES: PassiveId[] = ['harvester', 'prospector', 'manaspring', 'scholar'];
const MONSTER_ACTIVES: ActiveId[] = ['powerstrike', 'fortify'];
/** Actives that are permanent knowledge (building unlocks), not battlefield skills. */
const PERMANENT_ACTIVES: ActiveId[] = ['masonry', 'devotion'];

/**
 * Queue one level-up offer: 3 options drawn from the XP mix of the level just completed, with
 * that mix kept beside it (levelUpXp) so the choice can show why these were offered.
 */
export function queueLevelOffer(state: GameState, unit: Unit): void {
  const mix = { ...unit.levelXpByCat };
  const mixes = unit.levelUpXp ?? (unit.levelUpXp = []);
  while (mixes.length < unit.levelUpOptions.length) mixes.push(mix); // keep both queues aligned
  unit.levelUpOptions.push(drawOptions(state, unit, 3, new Set(), mix));
  mixes.push(mix);
}

/**
 * Add XP (×1.3 for leaders; the fraction is carried in xpFrac so small grants keep the bonus),
 * tracking xpByCat and levelXpByCat. While xp ≥ xpToNext(level) and level < MAX_LEVEL: level++,
 * maxHp+4 & heal 4, pendingLevelUps++, queue an offer weighted by that level's XP, then start the
 * new level's tally with the overflow, emit unitLeveled.
 */
export function grantXp(state: GameState, unit: Unit, cat: XpCategory, amount: number): GameEvent[] {
  if (!Number.isFinite(amount) || amount <= 0 || unit.hp <= 0) return [];
  let v: number;
  if (unit.isLeader) {
    const raw = amount * LEADER_XP_MULT + (unit.xpFrac ?? 0);
    v = Math.floor(raw + 1e-9);
    const frac = Math.round(Math.max(0, raw - v) * 1e6) / 1e6;
    if (frac > 0) unit.xpFrac = frac; else delete unit.xpFrac;
  } else {
    v = Math.round(amount);
  }
  if (v <= 0) return [];
  unit.xpByCat[cat] = (unit.xpByCat[cat] ?? 0) + v;
  if (unit.level >= MAX_LEVEL) { unit.xp = 0; return []; }
  unit.levelXpByCat[cat] = (unit.levelXpByCat[cat] ?? 0) + v;
  unit.xp += v;
  const events: GameEvent[] = [];
  while (unit.level < MAX_LEVEL && unit.xp >= xpToNext(unit.level)) {
    unit.xp -= xpToNext(unit.level);
    unit.level++;
    unit.base.maxHp += LEVEL_HP_GAIN;
    unit.hp = Math.min(unit.hp + LEVEL_HP_GAIN, effectiveStats(state, unit).maxHp);
    unit.pendingLevelUps++;
    queueLevelOffer(state, unit);
    // The next level's tally starts now (with the overflow), not when the choice is made: XP
    // earned while the pick waits counts toward the next level's offer.
    unit.levelXpByCat = zeroXp();
    if (unit.xp > 0) unit.levelXpByCat[cat] = unit.xp;
    events.push({ type: 'unitLeveled', unit: unit.id, level: unit.level });
    if (state.factions[unit.faction]?.isHuman) {
      events.push({ type: 'log', entry: addLog(state, `${unit.name} reached level ${unit.level}!`, 'levelup', unit.faction) });
    }
  }
  if (unit.level >= MAX_LEVEL) unit.xp = 0;
  return events;
}

/** Whether a level option can still do anything for this unit. */
export function optionEligible(unit: Unit, opt: SkillOptionDef): boolean {
  switch (opt.kind) {
    case 'stat':
      return true; // stats are always on the table
    case 'efficiency':
      if (!opt.efficiency) return false;
      if (unit.monster) {
        const kinds = getAttackDefs(unit).map((a) => a.kind);
        if (opt.efficiency === 'attack') return kinds.includes('melee');
        if (opt.efficiency === 'ranged') return kinds.includes('ranged');
        if (opt.efficiency === 'magic') return kinds.includes('magic');
        return false; // farming, mining… mean nothing to a beast
      }
      return true;
    case 'passive':
      if (!opt.passive || unit.passives.includes(opt.passive)) return false;
      if (unit.monster) {
        if (ECONOMY_PASSIVES.includes(opt.passive) || opt.passive === 'inspiring') return false;
        if (opt.passive === 'marksman') return getAttackDefs(unit).some((a) => a.kind === 'ranged');
      }
      return true;
    case 'active':
      if (!opt.active || unit.actives.includes(opt.active)) return false;
      if (unit.monster) return MONSTER_ACTIVES.includes(opt.active);
      return true;
    default:
      return false;
  }
}

function eligibleOptions(unit: Unit, exclude: ReadonlySet<string>): SkillOptionDef[] {
  return LEVEL_OPTIONS.filter((o) => !exclude.has(o.id) && optionEligible(unit, o));
}

/** Weight kept by the remaining options of a kind already on offer (offers spread across kinds). */
const KIND_REPEAT_FACTOR = 0.3;
/** Weight kept by further options outside the level's XP trades once one such wildcard is on offer. */
const OFF_TRADE_REPEAT_FACTOR = 0.15;
/** Bow-only options are less likely for a unit with no ranged attack (it may still take up a bow). */
const NO_BOW_FACTOR = 0.4;
const BOW_OPTIONS = new Set(['active_volley', 'eff_ranged', 'passive_marksman']);
/** Likewise, melee-only options are less likely for a unit whose main weapon shoots or casts (an archer). */
const NO_MELEE_FACTOR = 0.4;
const MELEE_ONLY_OPTIONS = new Set(['stat_str', 'eff_attack', 'passive_poison', 'passive_berserker', 'active_powerstrike']);

/**
 * Weighted draw without replacement (DESIGN §4.7 weighting by the XP mix `mix`, default: this
 * level's). The draw softly avoids repeating an option kind, offers at most one option outside
 * the level's XP trades (a wildcard), and damps options the unit's weapon does not suit (bow
 * skills without a bow, melee-only ones for a shooter or caster). `taken`: options already on the offer (when one
 * stale option is replaced), counted for both rules. RNG use: one draw per pool entry, then one
 * per pick, whatever the rules do.
 */
function drawOptions(
  state: GameState, unit: Unit, count: number, exclude: ReadonlySet<string>,
  mix: Record<XpCategory, number> = unit.levelXpByCat, taken: readonly string[] = [],
): string[] {
  const pool = eligibleOptions(unit, exclude);
  let total = 0;
  for (const c of XP_CATS) total += mix[c] ?? 0;
  const shareOf = (o: SkillOptionDef): number => {
    if (total <= 0) return 0;
    let s = 0;
    for (const c of new Set(o.categories)) s += mix[c] ?? 0;
    return s / total;
  };
  // Without an XP mix there is no trade to stray from: no option counts as a wildcard.
  const offTrade = (o: SkillOptionDef): boolean => total > 0 && shareOf(o) === 0;
  const ranged = unit.monster || getAttackDefs(unit).some((a) => a.kind === 'ranged');
  const shooter = !unit.monster && mainAttackKind(unit) !== 'melee';
  const weights = pool.map((o) => {
    let w = o.weight * (0.35 + shareOf(o) * 3) * (0.75 + 0.5 * rand(state));
    if (!ranged && BOW_OPTIONS.has(o.id)) w *= NO_BOW_FACTOR;
    if (shooter && MELEE_ONLY_OPTIONS.has(o.id)) w *= NO_MELEE_FACTOR;
    return w;
  });
  let picked = 0;
  const onPick = (o: SkillOptionDef): void => {
    for (let i = 0; i < pool.length; i++) if (pool[i].kind === o.kind) weights[i] *= KIND_REPEAT_FACTOR;
    if (!offTrade(o)) return;
    // One wildcard at most: none at all while enough in-trade options remain to fill the offer.
    const inTrade = pool.filter((x) => !offTrade(x)).length;
    const f = inTrade >= count - picked ? 0 : OFF_TRADE_REPEAT_FACTOR;
    for (let i = 0; i < pool.length; i++) if (offTrade(pool[i])) weights[i] *= f;
  };
  for (const id of taken) {
    const o = LEVEL_OPTION_BY_ID[id];
    if (o) onPick(o);
  }
  const out: string[] = [];
  while (out.length < count && pool.length > 0) {
    let sum = 0;
    for (const w of weights) sum += w;
    let r = rand(state) * sum;
    let k = 0;
    for (; k < pool.length - 1; k++) {
      r -= weights[k];
      if (r < 0) break;
    }
    // Floating-point leftovers must never land on a zero-weight option.
    while (weights[k] <= 0 && k > 0) k--;
    const o = pool[k];
    out.push(o.id);
    pool.splice(k, 1);
    weights.splice(k, 1);
    picked++;
    onPick(o);
  }
  return out;
}

/** Draw 3 distinct option ids weighted by levelXpByCat shares (+ base weight + state RNG). Excludes owned passives/actives and inapplicable options (e.g. monsters). */
export function rollLevelOptions(state: GameState, unit: Unit): string[] {
  return drawOptions(state, unit, 3, new Set());
}

/** Null if `optionId` is a valid pick for the unit's first pending level-up, else a reason. */
export function canApplyLevelOption(state: GameState, unit: Unit, optionId: string): string | null {
  if (unit.pendingLevelUps <= 0 || unit.levelUpOptions.length === 0) return 'No level-up is pending.';
  if (!unit.levelUpOptions[0].includes(optionId)) return 'That option was not offered.';
  const def = LEVEL_OPTION_BY_ID[optionId];
  if (!def) return 'Unknown option.';
  return null;
}

/**
 * Apply the chosen option of the first pending level-up (must be one of its 3) and record it in the
 * level history (`learned`). levelXpByCat is untouched (it already tallies the next level).
 */
export function applyLevelOption(state: GameState, unit: Unit, optionId: string): GameEvent[] {
  if (canApplyLevelOption(state, unit, optionId) !== null) return [];
  const def = LEVEL_OPTION_BY_ID[optionId];
  const before = effectiveStats(state, unit);
  switch (def.kind) {
    case 'stat':
      for (const [k, v] of Object.entries(def.stat ?? {}) as [keyof UnitStats, number][]) {
        unit.base[k] += v;
        if (k === 'maxHp') unit.hp += v; // new vigour comes with the hit points
      }
      break;
    case 'efficiency':
      if (def.efficiency) {
        const cur = unit.efficiency[def.efficiency] ?? 1;
        unit.efficiency[def.efficiency] = Math.round(cur * EFFICIENCY_STEP * 10000) / 10000;
      }
      break;
    case 'passive':
      if (def.passive && !unit.passives.includes(def.passive)) unit.passives.push(def.passive);
      break;
    case 'active':
      // 'masonry' / 'devotion' are permanent building unlocks: knowing them is enough.
      if (def.active && !unit.actives.includes(def.active)) unit.actives.push(def.active);
      break;
  }
  const after = effectiveStats(state, unit);
  unit.hp = Math.max(1, Math.min(unit.hp, after.maxHp));
  // Level history (unit sheet): the oldest pending offer belongs to the earliest level still unresolved.
  (unit.learned ??= []).push({ level: unit.level - unit.pendingLevelUps + 1, option: optionId });
  unit.levelUpOptions.shift();
  unit.levelUpXp?.shift();
  unit.pendingLevelUps = Math.max(0, unit.pendingLevelUps - 1);
  if (unit.pendingLevelUps === 0) {
    unit.levelUpOptions = [];
    delete unit.levelUpXp;
  } else {
    // A later queued draw may offer what was just learned: swap those for fresh options
    // (weighted like the rest of that offer).
    unit.levelUpOptions.forEach((set, k) => {
      const mix = unit.levelUpXp?.[k] ?? unit.levelXpByCat;
      for (let i = 0; i < set.length; i++) {
        const o = LEVEL_OPTION_BY_ID[set[i]];
        if (o && optionEligible(unit, o)) continue;
        const repl = drawOptions(state, unit, 1, new Set(set), mix, set.filter((_, j) => j !== i));
        if (repl.length > 0) set[i] = repl[0];
        else { set.splice(i, 1); i--; }
      }
    });
  }
  if (after.vis !== before.vis && unit.faction !== 'neutral') computeVisibility(state, unit.faction);
  const events: GameEvent[] = [];
  if (state.factions[unit.faction]?.isHuman) {
    events.push({ type: 'log', entry: addLog(state, `${unit.name} learned ${def.name}.`, 'levelup', unit.faction) });
  }
  return events;
}

type Role = 'builder' | 'fighter' | 'archer' | 'mage' | 'leader';

/** What an AI unit is for, from its kit. */
export function unitRole(unit: Unit): Role {
  if (unit.isLeader) return 'leader';
  if (unit.monster) return 'fighter';
  const kinds = getAttackDefs(unit).map((a) => a.kind);
  if (kinds.includes('magic')) return 'mage';
  if (kinds.includes('ranged')) return 'archer';
  if (canBuildWith(unit) || !unit.equipment.main) return 'builder';
  return 'fighter';
}

/** Preference scores per role (higher = better). Options not listed get a small generic score. */
const ROLE_PREFS: Record<Role, Record<string, number>> = {
  builder: {
    eff_building: 10, eff_mining: 8, eff_farming: 8, eff_gathering: 7, eff_trade: 6, eff_research: 5,
    passive_harvester: 7, passive_prospector: 7, passive_scholar: 6, active_masonry: 6, active_devotion: 5,
    passive_pathfinder: 3, stat_hp: 3, stat_mov: 2, active_fortify: 2,
  },
  fighter: {
    stat_str: 9, eff_attack: 9, stat_armor: 7, stat_hp: 7, passive_ironskin: 7, active_powerstrike: 6,
    passive_berserker: 5, passive_vampiric: 6, passive_poison: 6, passive_regeneration: 5, active_fortify: 5,
    passive_skirmisher: 4, stat_mov: 3,
  },
  archer: {
    stat_dex: 10, eff_ranged: 9, passive_marksman: 8, active_volley: 7, passive_skirmisher: 4,
    stat_hp: 4, stat_mov: 3, stat_vis: 3, stat_armor: 3, passive_pathfinder: 3,
  },
  mage: {
    stat_int: 10, eff_magic: 9, active_firebolt: 8, passive_manaspring: 6, eff_mana: 6, active_heal: 6,
    passive_regeneration: 4, active_blink: 4, stat_hp: 4, passive_scholar: 3,
  },
  leader: {
    passive_leadership: 10, stat_hp: 8, stat_armor: 8, passive_inspiring: 7, active_rally: 7, passive_ironskin: 7,
    active_fortify: 5, stat_str: 4, eff_attack: 4, passive_regeneration: 4, eff_trade: 3,
  },
};

/**
 * The kind of XP a unit mostly earns: the largest share of this level's XP, else of its
 * lifetime XP, else what its kit is for (Inspiring teaches allies in their own trade).
 */
export function mainXpCategory(unit: Unit): XpCategory {
  for (const tally of [unit.levelXpByCat, unit.xpByCat]) {
    let best: XpCategory | null = null;
    let bv = 0;
    for (const c of XP_CATS) {
      const v = tally?.[c] ?? 0;
      if (v > bv) { bv = v; best = c; }
    }
    if (best) return best;
  }
  const role = unitRole(unit);
  return role === 'builder' ? 'building' : role === 'archer' ? 'ranged' : role === 'mage' ? 'magic' : role === 'leader' ? 'leader' : 'melee';
}

/** Heuristic pick for AI-controlled units (by role: builder/fighter/archer/mage/leader). */
export function aiChooseLevelOption(state: GameState, unit: Unit): string {
  const offered = unit.levelUpOptions[0] ?? [];
  if (offered.length === 0) return '';
  const prefs = ROLE_PREFS[unitRole(unit)];
  // A unit with no combat active yet takes its first one over a primary stat (actives are what
  // make levels visible on the battlefield; building unlocks do not count).
  const hasCombatActive = unit.actives.some((a) => !PERMANENT_ACTIVES.includes(a));
  let best = offered[0];
  let bestScore = -Infinity;
  for (const id of offered) {
    const def = LEVEL_OPTION_BY_ID[id];
    if (!def) continue;
    let s = prefs[id] ?? (def.kind === 'stat' ? 1.5 : 1);
    if (def.kind === 'active' && def.active && !PERMANENT_ACTIVES.includes(def.active) && !hasCombatActive) s += 4;
    // A badly hurt unit values hit points a little more.
    if (id === 'stat_hp' && unit.hp < effectiveStats(state, unit).maxHp * 0.5) s += 1;
    if (s > bestScore) { bestScore = s; best = id; }
  }
  return best;
}
