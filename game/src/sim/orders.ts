// Standing orders (DESIGN §4.10): a unit told to rest until healed, or to keep watch, stays where
// it is (Tab passes it by) until the order is fulfilled, a hostile comes close, or it is attacked.
// The order itself changes no rule: a still unit already rests (+REST_HEAL HP) and works its building.
import type { FactionId, GameEvent, GameState, OrderEndReason, Unit, UnitOrder } from '../core/types';
import { hexDistance } from '../core/hex';
import { aOrAn } from '../core/text';
import { FACTIONS, MONSTERS } from '../data/factions';
import { isEnemy } from './state';
import { effectiveStats } from './units';
import { isVisible, unitSightRadius } from './visibility';
import { isHumanFaction, logEvent } from './ruleutil';

/** A resting unit wakes when a hostile it can see stands this close (hexes). */
export const HEAL_ORDER_ALERT = 2;

export const ORDER_NAMES: Record<UnitOrder, string> = { heal: 'Rest until healed', sentry: 'Sentry' };

/** Null when `unit` may take `order` now (null cancels and is always allowed), else a reason. Ownership and turn are checked by the caller. */
export function canGiveOrder(state: GameState, unit: Unit, order: UnitOrder | null): string | null {
  if (!state.units[String(unit.id)] || unit.hp <= 0) return 'This unit has fallen';
  if (unit.monster) return 'Creatures do not take standing orders';
  if (order === null) return null;
  if (order !== 'heal' && order !== 'sentry') return 'Unknown order';
  if (order === 'heal' && unit.hp >= effectiveStats(state, unit).maxHp) return `${unit.name} is already at full health`;
  return null;
}

/** Set or clear the order. Free: no movement or action is spent, no event (the panel shows it). */
export function setOrder(unit: Unit, order: UnitOrder | null): GameEvent[] {
  if (order === null) delete unit.order;
  else unit.order = order;
  return [];
}

/** How far a hostile may come before the order ends: the unit's sight on sentry, 2 hexes while resting. */
export function orderAlertRadius(state: GameState, unit: Unit, order: UnitOrder): number {
  return order === 'sentry' ? unitSightRadius(state, unit) : HEAL_ORDER_ALERT;
}

/** The nearest hostile (lowest id on ties) the unit's faction can see within `radius`, if any. */
export function nearestSeenHostile(state: GameState, unit: Unit, radius: number): Unit | null {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const k in state.units) {
    const o = state.units[k];
    if (o.faction === unit.faction || !isEnemy(unit.faction, o.faction) || o.hp <= 0) continue;
    const d = hexDistance(o.pos, unit.pos);
    if (d > radius || !isVisible(state, unit.faction, o.pos)) continue;
    if (d < bd || (d === bd && best && o.id < best.id)) { best = o; bd = d; }
  }
  return best;
}

/**
 * The hostile that would end `order` at the start of the next turn if nothing moved: one already
 * inside the alert range now (the command bar warns before such an order is given).
 */
export function orderWakeThreat(state: GameState, unit: Unit, order: UnitOrder): Unit | null {
  return nearestSeenHostile(state, unit, orderAlertRadius(state, unit, order));
}

/**
 * The caveat for giving `order` now when a hostile is already inside its wake-up range ("A Giant
 * Spider is within 2 hexes — Piers will wake at the start of next turn."), else null.
 */
export function orderWakeWarning(state: GameState, unit: Unit, order: UnitOrder): string | null {
  const foe = orderWakeThreat(state, unit, order);
  if (!foe) return null;
  const r = orderAlertRadius(state, unit, order);
  const who = hostileLabel(foe);
  const where = order === 'heal' ? `within ${r} hex${r === 1 ? '' : 'es'}` : 'in sight';
  const then = order === 'heal' ? 'wake' : 'be called back';
  return `${who[0].toUpperCase()}${who.slice(1)} is ${where} — ${unit.name} will ${then} at the start of next turn.`;
}

/** "a Giant Spider", "Mira (House Thorn)", "an enemy": how order texts name the hostile. */
export function hostileLabel(foe: Unit | null | undefined): string {
  if (!foe) return 'an enemy';
  if (foe.monster) return aOrAn(MONSTERS[foe.monster]?.name ?? foe.name);
  return `${foe.name} (${FACTIONS[foe.faction]?.name ?? 'enemy'})`;
}

/** The chronicle line (and the HUD toast) for an order that ended by itself. */
export function orderEndText(unit: Unit, order: UnitOrder, reason: OrderEndReason, foe?: Unit | null): string {
  switch (reason) {
    case 'healed': return `${unit.name} is fully healed.`;
    case 'enemy': return order === 'heal'
      ? `${unit.name} stops resting: ${hostileLabel(foe)} is near!`
      : `${unit.name} spots ${hostileLabel(foe)}!`;
    case 'attacked': return `${unit.name} is attacked and ${order === 'heal' ? 'stops resting' : 'leaves the watch'}.`;
    default: return `${unit.name}'s orders end.`;
  }
}

/**
 * End the unit's standing order by itself: delete it, emit orderEnded and, for the human, a
 * chronicle line. Log kinds are 'info' / 'combat' so the controller's warning toast does not fire:
 * the HUD toasts on orderEnded itself.
 */
export function endOrder(state: GameState, unit: Unit, reason: OrderEndReason, enemy?: Unit | null): GameEvent[] {
  const order = unit.order;
  if (!order) return [];
  delete unit.order;
  const ev: Extract<GameEvent, { type: 'orderEnded' }> = { type: 'orderEnded', unit: unit.id, order, reason };
  if (enemy) ev.enemy = enemy.id;
  const events: GameEvent[] = [ev];
  if (isHumanFaction(state, unit.faction)) {
    events.push(logEvent(state, orderEndText(unit, order, reason, enemy), reason === 'healed' ? 'info' : 'combat', unit.faction));
  }
  return events;
}

/** The unit was attacked (combat defender, or hit by a hostile spell or skill): a living unit drops its order. */
export function orderInterrupted(state: GameState, unit: Unit): GameEvent[] {
  if (!unit.order || unit.hp <= 0 || !state.units[String(unit.id)]) return [];
  return endOrder(state, unit, 'attacked');
}

/**
 * Start of `faction`'s turn, after healing, poison and the visibility refresh: a seen hostile
 * within alert range ends any order ('enemy', checked first: it is the news that matters), and a
 * resting unit back at full health is done ('healed').
 */
export function checkStandingOrders(state: GameState, faction: FactionId): GameEvent[] {
  const events: GameEvent[] = [];
  const units = Object.values(state.units).filter((u) => u.faction === faction && u.order).sort((a, b) => a.id - b.id);
  for (const u of units) {
    const order = u.order!;
    if (u.monster) { delete u.order; continue; } // (never given; a hand-edited save)
    const foe = nearestSeenHostile(state, u, orderAlertRadius(state, u, order));
    if (foe) events.push(...endOrder(state, u, 'enemy', foe));
    else if (order === 'heal' && u.hp >= effectiveStats(state, u).maxHp) events.push(...endOrder(state, u, 'healed'));
  }
  return events;
}
