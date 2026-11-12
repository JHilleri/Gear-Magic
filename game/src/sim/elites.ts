// Undead elite augments (DESIGN §2): a unit of a house that raises elites buys ranks of Unholy
// Vigor, Grave Might, Deadeye or Dark Wisdom with dark energy, standing on its castle or a mage
// tower. Free (no movement or action); each rank adds mana upkeep (sim/houses unitUpkeep).
import type { EliteId, GameEvent, GameState, Unit } from '../core/types';
import { ELITES, eliteCost } from '../data/elites';
import { FACTIONS } from '../data/factions';
import { rankedName } from '../data/ranks';
import { buildingOn, isFunctional, logFor, round2 } from './ruleutil';

/** Buildings where the dead are empowered. */
export const EMPOWER_SITES = ['castle', 'magetower'] as const;

/** True when house `f` raises elites with dark energy. */
export function raisesElites(f: Unit['faction']): boolean {
  return !!FACTIONS[f]?.unitBase;
}

/** The rank `u` holds of elite `e` (0: none). */
export function eliteRank(u: Pick<Unit, 'elite'>, e: EliteId): number {
  return Math.max(0, Math.floor(u.elite?.[e] ?? 0));
}

/** Dark energy the next rank of elite `e` costs `u`. */
export function nextEliteCost(u: Pick<Unit, 'elite'>, e: EliteId): number {
  return eliteCost(eliteRank(u, e) + 1);
}

/** Why `u` cannot be empowered at all where it stands (any elite), or null. */
export function empowerSiteError(state: GameState, u: Unit): string | null {
  if (!raisesElites(u.faction)) return 'Only the Ashen Covenant raises elites';
  if (u.monster || u.summonTurns !== undefined) return 'Creatures cannot be empowered';
  const b = buildingOn(state, u.pos);
  if (!isFunctional(b) || b.owner !== u.faction || !(EMPOWER_SITES as readonly string[]).includes(b.type)) {
    return 'Stand on your castle or a mage tower to be empowered';
  }
  return null;
}

/** Null if `u` can buy the next rank of elite `e` now, else why not. */
export function canEmpower(state: GameState, u: Unit, e: EliteId): string | null {
  if (!ELITES[e]) return 'Unknown elite augment';
  const site = empowerSiteError(state, u);
  if (site) return site;
  const fs = state.factions[u.faction];
  const cost = nextEliteCost(u, e);
  if ((fs?.resources.dark ?? 0) + 1e-9 < cost) return `Not enough dark energy (need ${Math.ceil(cost - (fs?.resources.dark ?? 0))} more)`;
  return null;
}

/** Pay the dark energy and add one rank of elite `e` to `u` (Unholy Vigor's hit points come at once). */
export function empower(state: GameState, u: Unit, e: EliteId): GameEvent[] {
  const def = ELITES[e];
  const fs = state.factions[u.faction];
  const cost = nextEliteCost(u, e);
  fs.resources.dark = round2(fs.resources.dark - cost);
  const rank = eliteRank(u, e) + 1;
  (u.elite ??= {})[e] = rank;
  if (def.stat === 'maxHp') u.hp += def.per;
  return [
    { type: 'unitEmpowered', unit: u.id, elite: e, rank },
    ...logFor(state, [u.faction], `${u.name} is empowered: ${rankedName(def.name, rank)}.`, 'magic', u.faction),
  ];
}
