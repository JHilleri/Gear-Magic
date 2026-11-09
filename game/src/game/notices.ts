// What the player is told about a batch of events (pure, unit-tested): which outcome toasts a
// batch leaves out, and how a house's fall is announced.
import type { FactionId, GameEvent } from '../core/types';
import { FACTIONS } from '../data/factions';

/**
 * Indices of the unitDied events an elimination sweeps up (a house's remaining units vanishing
 * with its leader): the run of killer-less deaths of that house right before its
 * factionEliminated (sim/combat.eliminateFaction). The leader's own death is not part of it: it
 * comes with its chronicle line ("… is slain by …") in between.
 */
export function eliminationSweep(events: readonly GameEvent[]): Set<number> {
  const out = new Set<number>();
  events.forEach((ev, j) => {
    if (ev.type !== 'factionEliminated') return;
    for (let i = j - 1; i >= 0; i--) {
      const d = events[i];
      if (d.type !== 'unitDied' || d.faction !== ev.faction || d.killer !== null) break;
      out.add(i);
    }
  });
  return out;
}

/**
 * Outcome toasts a batch leaves out: the units swept away with a fallen leader (the leader's own
 * line says it, not one toast per unit), and everything from the player's own fall on (the
 * results screen says it: "Your leader has fallen…", "Defeat…").
 */
export function skippedOutcomeToasts(events: readonly GameEvent[], human: FactionId): Set<number> {
  const out = eliminationSweep(events);
  const fall = events.findIndex((ev) => ev.type === 'factionEliminated' && ev.faction === human);
  if (fall >= 0) for (let i = fall; i < events.length; i++) out.add(i);
  return out;
}

/** How a house's fall is announced: banner title and line, and the toast. */
export function eliminationNotice(f: FactionId, by: FactionId | null, human: FactionId): { title: string; sub: string; toast: string } {
  const name = FACTIONS[f]?.name ?? f;
  // A house never slays itself (its own Fireball): that is just a fall.
  const slayer = by && by !== f ? by : null;
  const slayerName = slayer ? FACTIONS[slayer]?.name ?? slayer : '';
  if (!slayer) return { title: `${name} has fallen`, sub: 'Its leader is dead and its banners are struck', toast: `${name} has been destroyed!` };
  if (slayer === human) return { title: `${name} has fallen`, sub: 'Destroyed by your hand', toast: `You have destroyed ${name}!` };
  if (slayer === 'neutral') return { title: `${name} has fallen`, sub: 'Its leader fell to the wilds', toast: `${name} has fallen to the wilds!` };
  return { title: `${name} has fallen`, sub: `Destroyed by ${slayerName}`, toast: `${name} has been destroyed by ${slayerName}!` };
}
