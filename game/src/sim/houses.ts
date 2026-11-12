// What each house pays and earns in its own resources (DESIGN §2). Pure: data in, data out.
//  * House Valen: gold and food, the full economy.
//  * Thornwild Clans: honor replaces gold (costs and the castle's coin); houses pay nothing; the
//    Training Ground is an Arena that yields honor; units also cost honor upkeep.
//  * Ashen Covenant: never eats (no food in any cost or output, no farms); units cost mana upkeep;
//    the castle's food becomes mana.
import type { BuildingId, EliteId, FactionId, ItemId, PresetId, ResourceCost, ResourceId, Unit } from '../core/types';
import { BUILDINGS } from '../data/buildings';
import { FACTIONS } from '../data/factions';
import { ITEMS } from '../data/items';
import { PRESETS } from '../data/presets';
import { ELITE_UPKEEP } from '../data/elites';

/** Every resource, in display order. */
export const ALL_RESOURCES: readonly ResourceId[] = ['gold', 'honor', 'food', 'wood', 'stone', 'iron', 'crystal', 'mana', 'research', 'dark'];

/** Honor an orc unit earns its house for each fight it takes part in, won or lost. */
export const FIGHT_HONOR = 2;
/** Per level of the victim, what a kill earns the killer's house (honor for orcs, dark energy for the undead). */
export const KILL_REWARD: Partial<Record<FactionId, ResourceCost>> = { thorn: { honor: 2 }, ashen: { dark: 2 } };
/** Share of the kill honor a monster is worth (a wild beast is no rival house). */
export const MONSTER_HONOR_SHARE = 0.5;

/** What killing `victim` earns house `f`: KILL_REWARD per level of the victim, half the honor for a monster. */
export function killReward(f: FactionId, victim: Pick<Unit, 'level' | 'monster'>): ResourceCost {
  const out: ResourceCost = {};
  for (const [r, per] of Object.entries(KILL_REWARD[f] ?? {}) as [ResourceId, number][]) {
    const share = r === 'honor' && victim.monster ? MONSTER_HONOR_SHARE : 1;
    out[r] = per * share * Math.max(1, victim.level);
  }
  return out;
}

/** The resources house `f` uses at all (top bar, income): its coin, food if it eats, the rest. */
export function resourcesOf(f: FactionId): ResourceId[] {
  const def = FACTIONS[f];
  return ALL_RESOURCES.filter((r) => {
    if (r === 'gold') return def?.coin !== 'honor';
    if (r === 'honor') return def?.coin === 'honor';
    if (r === 'food') return def?.eats !== false;
    if (r === 'dark') return !!def?.unitBase;
    return true;
  });
}

/** `cost` in house `f`'s own resources: gold paid in its coin (honor for orcs), no food for a house that never eats. */
export function factionCost(f: FactionId | null | undefined, cost: ResourceCost): ResourceCost {
  const def = f ? FACTIONS[f] : undefined;
  if (!def) return { ...cost };
  const out: ResourceCost = {};
  for (const [k, v] of Object.entries(cost) as [ResourceId, number][]) {
    if (!v) continue;
    if (k === 'food' && !def.eats) continue;
    const key: ResourceId = k === 'gold' && def.coin === 'honor' ? 'honor' : k;
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

/** A crafted item's cost for house `f`. */
export function itemCost(f: FactionId, item: ItemId): ResourceCost {
  return factionCost(f, ITEMS[item].cost);
}

/** Recruit cost of a preset for house `f`: the house's commoner plus the preset's items. */
export function recruitCost(f: FactionId, preset: PresetId): ResourceCost {
  const cost: ResourceCost = { ...(FACTIONS[f]?.recruitCost ?? {}) };
  for (const it of PRESETS[preset].items) {
    for (const [k, v] of Object.entries(itemCost(f, it)) as [ResourceId, number][]) cost[k] = (cost[k] ?? 0) + v;
  }
  return cost;
}

/**
 * Per-turn level-1 output of a `type` building owned by `f` (before workers, level and bonuses):
 * the data table, with honor for gold (orc houses yield nothing, the orc Training Ground is an
 * Arena yielding ARENA_HONOR, only while worked) and no food for the undead (their castle yields
 * 2 mana instead).
 */
export function baseOutput(type: BuildingId, f: FactionId | null | undefined): ResourceCost {
  const def = BUILDINGS[type];
  const out: ResourceCost = { ...def.output };
  const fd = f ? FACTIONS[f] : undefined;
  if (!fd) return out;
  if (fd.coin === 'honor') {
    if (type === 'house') delete out.gold;
    if (type === 'training') out.honor = ARENA_HONOR;
    if (out.gold) { out.honor = (out.honor ?? 0) + out.gold; delete out.gold; }
  }
  if (!fd.eats) {
    if (type === 'castle' && out.food) out.mana = (out.mana ?? 0) + UNDEAD_CASTLE_MANA;
    delete out.food;
  }
  return out;
}

/** Honor a Thornwild Arena yields at level 1, before its worker's ×2 (it yields nothing unworked). */
export const ARENA_HONOR = 2;
/** Mana an Ashen castle yields in place of food. */
export const UNDEAD_CASTLE_MANA = 2;

/** True when a `type` building owned by `f` yields nothing unless a unit works it (the orc Arena). */
export function workedOnly(type: BuildingId, f: FactionId | null | undefined): boolean {
  return type === 'training' && !!f && FACTIONS[f]?.coin === 'honor';
}

/** The building's description in house `f`'s land (the Arena is no drill yard). */
export function buildingDescription(type: BuildingId, f: FactionId | null | undefined): string {
  if (workedOnly(type, f)) {
    return `A fighting pit. A unit stationed here drills in its trade and wins ${ARENA_HONOR} honor a turn before its work bonus (×2 bare-handed); an empty Arena yields nothing.`;
  }
  return BUILDINGS[type].description;
}

/** True when a `type` building owned by `f` produces something a worker can boost. */
export function producesFor(type: BuildingId, f: FactionId | null | undefined): boolean {
  return Object.values(baseOutput(type, f)).some((v) => (v ?? 0) > 0);
}

/** The building's name in house `f`'s land (the Thornwild Training Ground is an Arena). */
export function buildingName(type: BuildingId, f: FactionId | null | undefined): string {
  if (type === 'training' && f && FACTIONS[f]?.coin === 'honor') return 'Arena';
  return BUILDINGS[type].name;
}

/** Why house `f` may not raise a `type` building at all, or null (the dead do not farm). */
export function houseForbids(type: BuildingId, f: FactionId): string | null {
  if (type === 'farm' && FACTIONS[f] && !FACTIONS[f].eats) return 'The dead do not farm';
  return null;
}

/** Elite ranks a unit carries (DESIGN §2). */
export function eliteRanks(u: Pick<Unit, 'elite'>): number {
  let n = 0;
  for (const v of Object.values(u.elite ?? {})) n += v ?? 0;
  return n;
}

/**
 * What one unit costs its house each turn: the house's upkeep (food; honor for orcs; mana for the
 * undead), plus mana for every elite rank. Leaders, summons and creatures are free.
 */
export function unitUpkeep(u: Unit): ResourceCost {
  if (u.isLeader || u.monster || u.summonTurns) return {};
  const out: ResourceCost = { ...(FACTIONS[u.faction]?.upkeep ?? {}) };
  const elite = eliteRanks(u);
  if (elite > 0) out.mana = (out.mana ?? 0) + ELITE_UPKEEP * elite;
  return out;
}

/** The elite ids, in display order. */
export const ELITE_ORDER: readonly EliteId[] = ['vigor', 'might', 'deadeye', 'wisdom'];
