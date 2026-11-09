// Which own units still need orders this turn (Tab, the "N idle" badge). Pure: reads the sim only.
// sim/actions.idleUnits answers "can it still act?"; here a unit with a standing order (rest,
// sentry) or a standing job is left out, because in this design a worker's job is to stand still.
import type { GameState, Unit, UnitId, UnitOrder } from '../core/types';
import { BUILDINGS } from '../data/buildings';
import { attackTargets, idleUnits } from '../sim/actions';
import { workerOf } from '../sim/economy';
import { buildingOn, isFunctional } from '../sim/ruleutil';
import { canBuildWith } from '../sim/units';

/** What a standing order (DESIGN §4.10) reads as in the unit panel and the End Turn tooltip. */
export const ORDER_DUTY: Record<UnitOrder, string> = { heal: 'Resting until healed', sentry: 'On sentry' };

/** Why `u` is busy where it stands (a standing order, else a standing job), or null. */
export function dutyOf(state: GameState, u: Unit): string | null {
  if (u.order) return ORDER_DUTY[u.order] ?? null;
  const b = buildingOn(state, u.pos);
  if (!b || b.owner !== u.faction) return null;
  const def = BUILDINGS[b.type];
  if (!def) return null;
  const tools = canBuildWith(u);
  if (u.isLeader && b.type === 'castle') return b.buildLeft > 0 && !b.upgrading ? `Raising the ${def.name}` : 'Holding the castle (+10%)';
  if (tools && b.buildLeft > 0) return `${b.upgrading ? 'Upgrading' : 'Building'} the ${def.name}`;
  if (!isFunctional(b)) return null;
  // Any own unit works a producing building it stands on; tools only make it work better.
  if (workerOf(state, b) === u) return `Working the ${def.name}`;
  if (def.xpPerTurn) return `Training at the ${def.name}`;
  return null;
}

/** True when the unit has a standing job where it stands (see dutyOf). */
export function onDuty(state: GameState, u: Unit): boolean {
  return dutyOf(state, u) !== null;
}

/**
 * True when the unit has an enemy to attack this turn, as the command bar's Attack button counts
 * them. The HUD passes its move-then-attack plan (store.attackableTargets); without one, only
 * targets attackable from where the unit stands count (sim attackTargets, the bar's fallback too).
 */
export type StrikeTest = (u: Unit) => boolean;

/**
 * Own units of the current faction that still await orders: those idleUnits() lists, minus units
 * told to wait this turn (`skipped`) and units on duty (standing orders included). A unit with an
 * enemy attackable from where it stands always counts; a unit under a standing order also counts
 * when `canStrike` finds a target it can reach by moving first, so Tab offers it whenever its
 * Attack button is lit (a worker or a skipped unit is not called off its job for that).
 */
export function unitsAwaitingOrders(state: GameState, skipped: ReadonlySet<UnitId> = new Set(), canStrike?: StrikeTest): UnitId[] {
  return idleUnits(state).filter((id) => {
    const u = state.units[String(id)];
    if (!u) return false;
    if (!u.acted && attackTargets(state, u).length > 0) return true;
    if (u.order && !u.acted && canStrike?.(u)) return true;
    return !skipped.has(id) && !onDuty(state, u);
  });
}

/** Units that could still act but are working or waiting (for the End Turn tooltip). */
export function unitsAtWork(state: GameState, skipped: ReadonlySet<UnitId> = new Set(), canStrike?: StrikeTest): number {
  return idleUnits(state).length - unitsAwaitingOrders(state, skipped, canStrike).length;
}
