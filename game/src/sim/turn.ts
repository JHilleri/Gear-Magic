// Turn sequencing & victory. See DESIGN §8.
import type { FactionId, GameEvent, GameState, Unit } from '../core/types';
import { hexDistance } from '../core/hex';
import { BUILDINGS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { FACTIONS } from '../data/factions';
import { effectiveStats } from './units';
import { progressResearch } from './research';
import { computeVisibility } from './visibility';
import { aiChooseLevelOption, applyLevelOption, mainXpCategory, queueLevelOffer } from './progression';
import { applyProduction, captureBuildings, progressConstruction } from './economy';
import { applyDamage, clearReactions, poisonOn } from './combat';
import { augmentRank, inspireXp, regenHeal, venomDamage } from '../data/ranks';
import { runNeutralTurn } from './neutral';
import { checkStandingOrders } from './orders';
import { buildingOn, giveXp, isFunctional, isHumanFaction, logEvent } from './ruleutil';

/** HP a unit heals at its turn start when it neither moved nor fought last turn. */
export const REST_HEAL = 3;
/** HP the Regeneration passive heals every turn at rank 1 (data/ranks regenHeal for every rank). */
export const REGEN_HEAL = regenHeal(1);
/** HP rank-1 poison takes every turn (never below 1); a higher Venom Blades rank poisons harder (unit.poisonDamage). */
export const POISON_DAMAGE = venomDamage(1);

function sortedUnitsOf(state: GameState, f: FactionId): Unit[] {
  return Object.values(state.units).filter((u) => u.faction === f).sort((a, b) => a.id - b.id);
}

/**
 * Upkeep shared by factions and the neutral wilds at the start of a unit's turn:
 * summon expiry, poison, healing, buff & cooldown timers, movement reset.
 */
export function unitTurnUpkeep(state: GameState, u: Unit): GameEvent[] {
  const events: GameEvent[] = [];
  const key = String(u.id);
  if (!state.units[key]) return events;

  // Summons crumble when their time runs out.
  if (u.summonTurns !== undefined) {
    u.summonTurns--;
    if (u.summonTurns <= 0) {
      delete state.units[key];
      events.push({ type: 'unitDied', unit: u.id, killer: null, pos: { ...u.pos }, faction: u.faction });
      if (isHumanFaction(state, u.faction)) events.push(logEvent(state, `${u.name} crumbles back into the earth.`, 'magic', u.faction));
      return events;
    }
  }

  // Healing sources (own functional building on the hex, rest, regeneration, amulet).
  const b = buildingOn(state, u.pos);
  const home = isFunctional(b) && b.owner === u.faction ? b : undefined;
  let heal = 0;
  let cures = false;
  if (u.restedLastTurn) heal += REST_HEAL;
  if (home) {
    const hd = BUILDINGS[home.type].heal ?? 0;
    heal += hd;
    if (home.type === 'castle' || home.type === 'shrine') cures = true;
  }
  const regen = augmentRank(u, 'regeneration');
  if (regen > 0) heal += regenHeal(regen);
  for (const slot of ['main', 'off', 'body', 'trinket', 'mount'] as const) {
    const it = u.equipment[slot];
    if (it && ITEMS[it].regen) heal += ITEMS[it].regen!;
  }
  if (u.poisoned && cures) { u.poisoned = false; delete u.poisonDamage; }
  if (u.poisoned) {
    // Poison bites first (never fatal), then whatever healing the unit gets.
    events.push(...applyDamage(state, u, poisonOn(u), 'poison', null, 1));
  }
  // Buff timers (before stats are read for max hp / mov).
  for (const bf of u.buffs) bf.turns--;
  u.buffs = u.buffs.filter((bf) => bf.turns > 0);
  const st = effectiveStats(state, u);
  if (u.hp > st.maxHp) u.hp = st.maxHp;
  if (heal > 0 && u.hp < st.maxHp) {
    const amount = Math.min(heal, st.maxHp - u.hp);
    u.hp += amount;
    events.push({ type: 'unitHealed', unit: u.id, amount });
  }
  for (const k of Object.keys(u.cooldowns) as (keyof Unit['cooldowns'])[]) {
    const v = (u.cooldowns[k] ?? 0) - 1;
    if (v > 0) u.cooldowns[k] = v; else delete u.cooldowns[k];
  }
  u.mp = Math.max(0, st.mov);
  u.acted = false;
  u.moved = false;
  delete u.justSpawned;
  delete u.moveEnded;
  return events;
}

/** Start-of-turn processing for `faction` (production, research, healing, poison, timers, cooldowns, mp reset, visibility, standing orders). Emits turnStarted first. */
export function startTurn(state: GameState, faction: FactionId): GameEvent[] {
  const events: GameEvent[] = [{ type: 'turnStarted', faction, round: state.round }];
  const fs = state.factions[faction];
  if (!fs || !fs.alive) return events;
  // A new turn: every unit on the map may retaliate again (DESIGN §4.5).
  clearReactions(state);

  // Recruit / craft counters.
  for (const k in state.buildings) {
    const b = state.buildings[k];
    if (b.owner === faction) { b.recruitedThisTurn = false; b.craftedThisTurn = 0; }
  }

  // Production & upkeep, then research (a pseudo-resource that feeds the current project).
  events.push(...applyProduction(state, faction));
  const pts = fs.income.research;
  if (pts > 0) events.push(...progressResearch(state, faction, pts));

  // Units: summons, poison, healing, timers, movement.
  for (const u of sortedUnitsOf(state, faction)) events.push(...unitTurnUpkeep(state, u));

  // Inspiring units teach their neighbours a little every turn, in the neighbour's own trade.
  for (const u of sortedUnitsOf(state, faction)) {
    const rank = augmentRank(u, 'inspiring');
    if (rank <= 0) continue;
    for (const o of sortedUnitsOf(state, faction)) {
      if (o.id !== u.id && hexDistance(o.pos, u.pos) === 1) events.push(...giveXp(state, o, mainXpCategory(o), inspireXp(rank)));
    }
  }

  // Faction timers.
  for (const k of Object.keys(fs.spellCooldowns) as (keyof typeof fs.spellCooldowns)[]) {
    const v = (fs.spellCooldowns[k] ?? 0) - 1;
    if (v > 0) fs.spellCooldowns[k] = v; else delete fs.spellCooldowns[k];
  }
  for (const f of fs.farsight) f.turns--;
  fs.farsight = fs.farsight.filter((f) => f.turns > 0);

  computeVisibility(state, faction);

  // Standing orders: healed units and units that see a hostile close by are ready for orders again.
  events.push(...checkStandingOrders(state, faction));

  // Level-up queue: the human picks in the modal; the AI decides right away.
  for (const u of sortedUnitsOf(state, faction)) {
    if (u.pendingLevelUps <= 0) continue;
    if (fs.isHuman) {
      while (u.levelUpOptions.length < u.pendingLevelUps) queueLevelOffer(state, u);
    } else {
      let guard = 20;
      while (u.pendingLevelUps > 0 && guard-- > 0) {
        if (!u.levelUpOptions.length) queueLevelOffer(state, u);
        const opt = aiChooseLevelOption(state, u);
        const before = u.pendingLevelUps;
        events.push(...applyLevelOption(state, u, opt));
        if (u.pendingLevelUps >= before) break; // safety: never spin on a rejected option
      }
    }
  }
  return events;
}

/**
 * End `faction`'s turn: construction & captures for it, advance currentTurn (skipping dead
 * factions); on round wrap: neutral turn (sim/neutral) and round++; then startTurn for the
 * next faction. Returns all events in order.
 */
export function endTurn(state: GameState, faction: FactionId): GameEvent[] {
  const events: GameEvent[] = [];
  if (state.gameOver) return events;
  const fs = state.factions[faction];
  if (fs?.alive) {
    events.push(...progressConstruction(state, faction));
    events.push(...captureBuildings(state, faction));
    for (const u of sortedUnitsOf(state, faction)) u.restedLastTurn = !u.moved && !u.acted;
  }
  events.push(...checkVictory(state));
  if (state.gameOver) return events;

  const n = state.turnOrder.length;
  let idx = state.currentTurn;
  for (let guard = 0; guard < n * 2 + 2; guard++) {
    idx++;
    if (idx >= n) {
      // Round wrap: the wilds stir, then a new round begins.
      idx = 0;
      events.push({ type: 'neutralPhase', round: state.round });
      events.push(...runNeutralTurn(state));
      state.round++;
      events.push(...checkVictory(state));
      if (state.gameOver) { state.currentTurn = idx; return events; }
    }
    if (state.factions[state.turnOrder[idx]]?.alive) break;
  }
  state.currentTurn = idx;
  const next = state.turnOrder[idx];
  if (!state.factions[next]?.alive) return events;
  events.push(...startTurn(state, next));
  return events;
}

/** Rough strength used to name the "winner" when the human falls with several AIs alive. */
/**
 * Sets winner/gameOver: human leader dead → gameOver (winner = the sole surviving house, else
 * null: no AI is crowned while two still stand); single non-neutral faction alive → it wins.
 * Never names a dead faction: a stale winner is recomputed.
 */
export function checkVictory(state: GameState): GameEvent[] {
  const reopened = state.gameOver;
  if (reopened) {
    if (state.winner === null || state.factions[state.winner]?.alive) return [];
    state.gameOver = false; // the named winner fell after the fact: decide again among the living
  }
  const alive = state.turnOrder.filter((f) => state.factions[f]?.alive);
  const human = state.turnOrder.find((f) => state.factions[f]?.isHuman) ?? null;
  let winner: FactionId | null | undefined;
  if (human && !state.factions[human].alive) {
    winner = alive.length === 1 ? alive[0] : null;
  } else if (alive.length <= 1) {
    winner = alive[0] ?? null;
  }
  if (winner === undefined) {
    if (!reopened) return [];
    winner = null; // (cannot normally happen) the game stays over, as a draw
  }
  state.gameOver = true;
  state.winner = winner;
  const events: GameEvent[] = [];
  if (human && winner === human) {
    events.push(logEvent(state, `Victory! ${FACTIONS[human].name} rules the region.`, 'info', human));
  } else if (human && !state.factions[human].alive) {
    const by = state.factions[human].eliminatedBy ?? null;
    const how = by && by !== 'neutral' ? `Your leader was slain by ${FACTIONS[by].name}.`
      : by === 'neutral' ? 'Your leader fell to the wilds.' : 'Your leader has fallen.';
    const rest = winner ? ` ${FACTIONS[winner].name} stands alone.` : alive.length === 0 ? ' No house remains.' : '';
    events.push(logEvent(state, `Defeat. ${how}${rest}`, 'warning', human));
  } else {
    events.push(logEvent(state, winner ? `${FACTIONS[winner].name} is victorious.` : 'The game has ended.', 'info', winner));
  }
  events.push({ type: 'gameOver', winner });
  return events;
}
