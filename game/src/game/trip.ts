// Multi-turn trips for the selected unit (click / hover past this turn's reach): why a unit that
// cannot take a single step this turn is stuck. Reads the sim, changes nothing.
import type { GameState, Hex, Unit } from '../core/types';
import { tileIndex } from '../core/hex';
import { TERRAIN } from '../data/terrain';
import { moveCost, pathCost, truncatePathToMp } from '../sim/pathfinding';
import { tooCostlyThisTurn } from './interaction';

/**
 * A multi-turn trip toward a hex: this turn's leg and the turns it takes (this one included), or
 * why the unit cannot head there. `wait`: no step is affordable this turn, but the unit could set
 * out with full MP (the trip then takes `wait.turns`; `wait.why` is the hover chip's short form).
 */
export type TowardPlan = { path: Hex[]; turns: number } | { error: string; wait?: { turns: number; why: string } };

/**
 * No step of `full` (a pathTowards route) can be taken this turn. Too costly this turn — the first
 * hex costs more than the MP left, or the hexes it can afford hold friendly units it may not stop
 * on — when full MP (`mov`) would get it moving; otherwise a real block (an enemy or its zone of
 * control in the way).
 */
export function stuckTrip(s: GameState, u: Unit, full: Hex[], mov: number): Extract<TowardPlan, { error: string }> {
  const blocked = { error: `${u.name} is blocked and cannot move that way now` };
  if (full.length === 0 || u.mp >= mov) return blocked;
  if (truncatePathToMp(s, { ...u, mp: mov }, full).length === 0) return blocked;
  const first = full[0];
  const cost = moveCost(s, u, first);
  const terrain = TERRAIN[s.tiles[tileIndex(first, s.width)]?.terrain]?.name;
  const turns = 1 + Math.ceil(pathCost(s, u, full) / Math.max(1, mov));
  const why = tooCostlyThisTurn(u.name, cost > u.mp && terrain ? { terrain, cost } : null, u.mp, turns);
  return { error: why.long, wait: { turns, why: why.short } };
}
