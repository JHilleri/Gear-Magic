// Standing orders (DESIGN §4.10): rest until healed, sentry. Validation, what clears them, what ends
// them by themselves (healed, a hostile close by, being attacked), the AI leaving them alone, Tab.
import { describe, expect, it } from 'vitest';
import type { Action, GameEvent, GameSettings, GameState, Hex, Unit } from '../src/core/types';
import { COMMONER_STATS } from '../src/data/presets';
import { applyAction, validateAction } from '../src/sim/actions';
import { applyDamage, resolveCombat } from '../src/sim/combat';
import { HEAL_ORDER_ALERT, checkStandingOrders, orderWakeThreat } from '../src/sim/orders';
import { FACTIONS, MONSTERS } from '../src/data/factions';
import { createGame, currentFaction, deserialize, serialize } from '../src/sim/state';
import { endTurn, startTurn } from '../src/sim/turn';
import { effectiveStats } from '../src/sim/units';
import { computeVisibility } from '../src/sim/visibility';
import { AI_STEP_CAP, aiNextAction, createAiMemory } from '../src/sim/ai/index';
import { dutyOf, unitsAtWork, unitsAwaitingOrders } from '../src/game/duty';
import { at, makeTestBuilding, makeTestState, makeTestUnit } from './helpers';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });
const ended = (evs: GameEvent[]) => evs.filter((e): e is Extract<GameEvent, { type: 'orderEnded' }> => e.type === 'orderEnded');
const logs = (evs: GameEvent[]) => evs.flatMap((e) => (e.type === 'log' ? [e.entry.text] : []));
/** A sturdy unit that survives a hit or two (so being attacked does not kill it). */
const tough = (hp = 150) => ({ base: { ...COMMONER_STATS, maxHp: 200 }, hp });

describe('order action', () => {
  it('validates: own unit, its turn, not a creature, heal only when hurt', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(3, 3), { hp: 10 });
    const full = makeTestUnit(s, 'valen', at(5, 3));
    const foe = makeTestUnit(s, 'thorn', at(9, 7), { hp: 5 });
    const golem = makeTestUnit(s, 'valen', at(3, 6), { monster: 'elemental', summonTurns: 5, hp: 5 });
    const order = (unit: Unit, o: 'heal' | 'sentry' | null): Action => ({ type: 'order', unit: unit.id, order: o });

    expect(validateAction(s, order(u, 'heal'))).toBeNull();
    expect(validateAction(s, order(foe, 'heal'))).toMatch(/Not your unit/);
    expect(validateAction(s, order(golem, 'sentry'))).toMatch(/Creatures/);
    expect(validateAction(s, order(full, 'heal'))).toMatch(/already at full health/);
    expect(validateAction(s, order(full, 'sentry'))).toBeNull();
    expect(validateAction(s, { type: 'order', unit: 999, order: 'sentry' })).toMatch(/No such unit/);
    expect(validateAction(s, { type: 'order', unit: u.id, order: 'nap' as 'heal' })).toMatch(/Unknown order/);

    // Free: no movement or action is spent, and null cancels.
    const mp = u.mp;
    const r = applyAction(s, order(u, 'heal'));
    expect(r).toEqual({ ok: true, events: [] });
    expect(u.order).toBe('heal');
    expect(u.mp).toBe(mp);
    expect(u.acted).toBe(false);
    expect(applyAction(s, order(u, 'sentry')).ok).toBe(true);
    expect(u.order).toBe('sentry');
    expect(applyAction(s, order(u, null)).ok).toBe(true);
    expect(u.order).toBeUndefined();
    expect(applyAction(s, order(u, null)).ok).toBe(true); // cancelling nothing is harmless

    // Not on someone else's turn.
    s.currentTurn = 1;
    expect(validateAction(s, order(u, 'sentry'))).toMatch(/Not your unit/);
    expect(validateAction(s, order(foe, 'heal'))).toBeNull();
  });

  it('move, attack, skill, build and upgrade clear it; other actions do not', () => {
    const s = makeTestState(14, 10);
    makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const mover = makeTestUnit(s, 'valen', at(1, 1), { order: 'sentry' });
    expect(applyAction(s, { type: 'move', unit: mover.id, to: at(2, 1) }).ok).toBe(true);
    expect(mover.order).toBeUndefined();

    const fighter = makeTestUnit(s, 'valen', at(10, 8), { items: ['sword'], order: 'sentry' });
    const foe = makeTestUnit(s, 'thorn', off(at(10, 8), 1), tough());
    computeVisibility(s, 'valen'); // (the move above refreshed the fog without the fighter)
    const r = applyAction(s, { type: 'attack', unit: fighter.id, target: foe.id, kind: 'melee' });
    expect(r.ok).toBe(true);
    expect(fighter.order).toBeUndefined();
    expect(ended(r.events)).toEqual([]); // cleared by its own command: no "order ended" news

    const guard = makeTestUnit(s, 'valen', at(1, 8), { actives: ['fortify'], order: 'sentry' });
    expect(applyAction(s, { type: 'skill', unit: guard.id, skill: 'fortify' }).ok).toBe(true);
    expect(guard.order).toBeUndefined();

    const builder = makeTestUnit(s, 'valen', off(at(5, 5), 1), { items: ['tools'], order: 'sentry' });
    expect(applyAction(s, { type: 'build', unit: builder.id, building: 'farm' }).ok).toBe(true);
    expect(builder.order).toBeUndefined();

    s.factions.valen.techs.push('architecture');
    const farm = makeTestBuilding(s, 'farm', 'valen', off(at(5, 5), -1));
    const mason = makeTestUnit(s, 'valen', farm.pos, { items: ['tools'], order: 'sentry' });
    expect(applyAction(s, { type: 'upgrade', unit: mason.id }).ok).toBe(true);
    expect(mason.order).toBeUndefined();

    // Learning a level or another unit's command leaves the order alone.
    const learner = makeTestUnit(s, 'valen', at(12, 1), {
      order: 'sentry', level: 2, pendingLevelUps: 1, levelUpOptions: [['stat_str', 'stat_dex', 'stat_int']],
    });
    expect(applyAction(s, { type: 'levelup', unit: learner.id, option: 'stat_str' }).ok).toBe(true);
    expect(learner.order).toBe('sentry');
  });
});

describe('orders ending by themselves', () => {
  it('rest until healed ends once at full health (chronicle line for the human only)', () => {
    const s = makeTestState(14, 10);
    const u = makeTestUnit(s, 'valen', at(2, 2), { hp: COMMONER_STATS.maxHp - 2 });
    const slow = makeTestUnit(s, 'valen', at(4, 2), { hp: COMMONER_STATS.maxHp - 6 });
    expect(applyAction(s, { type: 'order', unit: u.id, order: 'heal' }).ok).toBe(true);
    expect(applyAction(s, { type: 'order', unit: slow.id, order: 'heal' }).ok).toBe(true);
    // valen ends → thorn plays → the round wraps → valen's turn starts: rest heals +2.
    let evs = endTurn(s, 'valen');
    expect(ended(evs)).toEqual([]);
    evs = endTurn(s, 'thorn');
    expect(currentFaction(s)).toBe('valen');
    expect(u.hp).toBe(effectiveStats(s, u).maxHp);
    expect(ended(evs)).toEqual([{ type: 'orderEnded', unit: u.id, order: 'heal', reason: 'healed' }]);
    expect(logs(evs)).toContain(`${u.name} is fully healed.`);
    expect(u.order).toBeUndefined();
    expect(slow.order).toBe('heal'); // still 4 short: keeps resting
    // The healed event comes after the heal itself.
    const healIdx = evs.findIndex((e) => e.type === 'unitHealed' && e.unit === u.id);
    const endIdx = evs.findIndex((e) => e.type === 'orderEnded');
    expect(healIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(healIdx);

    // An AI unit's order (never given by the AI itself) ends the same way, without a chronicle line.
    const t = makeTestUnit(s, 'thorn', at(12, 8), { hp: COMMONER_STATS.maxHp - 1, order: 'heal', restedLastTurn: true });
    const tevs = startTurn(s, 'thorn');
    expect(ended(tevs)).toEqual([{ type: 'orderEnded', unit: t.id, order: 'heal', reason: 'healed' }]);
    expect(logs(tevs).some((x) => x.includes(t.name))).toBe(false);
  });

  it('sentry wakes on a hostile it can see within its sight, not beyond', () => {
    const s = makeTestState(16, 10);
    const sentry = makeTestUnit(s, 'valen', at(2, 5), { order: 'sentry' });
    const vis = effectiveStats(s, sentry).vis; // grass: no hill bonus
    const far = makeTestUnit(s, 'neutral', off(sentry.pos, vis + 1), { monster: 'wolf' });
    let evs = startTurn(s, 'valen');
    expect(ended(evs)).toEqual([]);
    expect(sentry.order).toBe('sentry');

    // Seen (a scout stands next to it) but still beyond the sentry's own sight: no alarm.
    makeTestUnit(s, 'valen', off(far.pos, 1));
    evs = startTurn(s, 'valen');
    expect(ended(evs)).toEqual([]);

    // A wild monster steps to the edge of its sight: the watch is over.
    far.pos = off(sentry.pos, vis);
    evs = startTurn(s, 'valen');
    expect(ended(evs)).toEqual([{ type: 'orderEnded', unit: sentry.id, order: 'sentry', reason: 'enemy', enemy: far.id }]);
    // The chronicle names what it saw, as the toast does.
    expect(logs(evs)).toContain(`${sentry.name} spots a ${MONSTERS.wolf.name}!`);
    expect(sentry.order).toBeUndefined();
  });

  it('a resting unit wakes on a seen hostile within 2 hexes, not on one farther or unseen', () => {
    const s = makeTestState(16, 10);
    const u = makeTestUnit(s, 'valen', at(2, 5), { hp: 5, order: 'heal' });
    const foe = makeTestUnit(s, 'thorn', off(u.pos, HEAL_ORDER_ALERT + 1));
    expect(ended(startTurn(s, 'valen'))).toEqual([]); // in sight (vision 4) but 3 hexes away
    expect(u.order).toBe('heal');

    foe.pos = off(u.pos, HEAL_ORDER_ALERT);
    const evs = startTurn(s, 'valen');
    expect(ended(evs)).toEqual([{ type: 'orderEnded', unit: u.id, order: 'heal', reason: 'enemy', enemy: foe.id }]);
    // A rester's line says it stops resting, and who woke it.
    expect(logs(evs)).toContain(`${u.name} stops resting: ${foe.name} (${FACTIONS.thorn.name}) is near!`);

    // Short-sighted and alone: a hostile 2 hexes away it cannot see does not wake it.
    const s2 = makeTestState(16, 10);
    const blind = makeTestUnit(s2, 'valen', at(2, 5), { base: { ...COMMONER_STATS, vis: 1 }, hp: 5, order: 'heal' });
    const lurker = makeTestUnit(s2, 'thorn', off(blind.pos, 2));
    expect(ended(startTurn(s2, 'valen'))).toEqual([]);
    expect(blind.order).toBe('heal');
    // Once something of valen's sees it, it counts.
    makeTestUnit(s2, 'valen', off(lurker.pos, 1));
    computeVisibility(s2, 'valen');
    expect(ended(checkStandingOrders(s2, 'valen'))).toMatchObject([{ unit: blind.id, reason: 'enemy', enemy: lurker.id }]);
  });

  it('a hostile close by takes precedence over being healed', () => {
    const s = makeTestState(16, 10);
    const u = makeTestUnit(s, 'valen', at(2, 5), { hp: COMMONER_STATS.maxHp - 1, order: 'heal', restedLastTurn: true });
    const foe = makeTestUnit(s, 'thorn', off(u.pos, 2));
    expect(ended(startTurn(s, 'valen'))).toEqual([{ type: 'orderEnded', unit: u.id, order: 'heal', reason: 'enemy', enemy: foe.id }]);
  });

  it('being attacked ends it: combat, hostile spells and skills; not friendly fire', () => {
    const s = makeTestState(16, 10);
    s.currentTurn = 1; // thorn's turn
    const v = makeTestUnit(s, 'valen', at(4, 4), { ...tough(), order: 'sentry' });
    const t = makeTestUnit(s, 'thorn', off(v.pos, 1), { items: ['sword'] });
    const r = applyAction(s, { type: 'attack', unit: t.id, target: v.id, kind: 'melee' });
    expect(r.ok).toBe(true);
    expect(ended(r.events)).toEqual([{ type: 'orderEnded', unit: v.id, order: 'sentry', reason: 'attacked' }]);
    expect(logs(r.events)).toContain(`${v.name} is attacked and leaves the watch.`);
    expect(v.order).toBeUndefined();

    // Firebolt from a thorn mage.
    const resting = makeTestUnit(s, 'valen', at(10, 4), { ...tough(), order: 'heal' });
    const mage = makeTestUnit(s, 'thorn', off(resting.pos, 2), { actives: ['firebolt'] });
    computeVisibility(s, 'thorn');
    const fr = applyAction(s, { type: 'skill', unit: mage.id, skill: 'firebolt', target: { ...resting.pos } });
    expect(fr.ok).toBe(true);
    expect(ended(fr.events)).toEqual([{ type: 'orderEnded', unit: resting.id, order: 'heal', reason: 'attacked' }]);
    expect(logs(fr.events)).toContain(`${resting.name} is attacked and stops resting.`);

    // Spells: the house's own Fireball on its lines is no attack; an enemy's is.
    resting.order = 'heal';
    expect(ended(applyDamage(s, resting, 5, 'spell', null, undefined, { by: 'valen' }))).toEqual([]);
    expect(resting.order).toBe('heal');
    expect(ended(applyDamage(s, resting, 5, 'spell', null, undefined, { by: 'thorn' }))).toHaveLength(1);
    expect(resting.order).toBeUndefined();
    // Poison and hunger are not attacks.
    resting.order = 'heal';
    expect(ended(applyDamage(s, resting, 3, 'poison', null, 1))).toEqual([]);
    expect(resting.order).toBe('heal');

    // A unit that dies with its order gets no "order ended" news.
    const frail = makeTestUnit(s, 'valen', at(1, 8), { hp: 1, order: 'sentry' });
    const brute = makeTestUnit(s, 'thorn', off(frail.pos, 1), { items: ['axe'], base: { ...COMMONER_STATS, str: 40 } });
    let evs: GameEvent[] = [];
    for (let i = 0; i < 30 && s.units[String(frail.id)]; i++) {
      frail.order = 'sentry';
      brute.acted = false;
      evs = resolveCombat(s, brute, frail, 'melee');
    }
    expect(s.units[String(frail.id)]).toBeUndefined();
    expect(evs.some((e) => e.type === 'unitDied' && e.unit === frail.id)).toBe(true);
    expect(ended(evs)).toEqual([]);
    const doomed = makeTestUnit(s, 'valen', at(14, 8), { hp: 3, order: 'heal' });
    const fatal = applyDamage(s, doomed, 10, 'skill', brute);
    expect(fatal.some((e) => e.type === 'unitDied')).toBe(true);
    expect(ended(fatal)).toEqual([]);
  });
});

describe('standing orders and Tab', () => {
  it('ordered units read as on duty and are skipped, unless an enemy is in reach', () => {
    const s = makeTestState(16, 10);
    const farm = makeTestBuilding(s, 'farm', 'valen', at(8, 2));
    const resting = makeTestUnit(s, 'valen', at(2, 2), { hp: 5, order: 'heal' });
    const sentry = makeTestUnit(s, 'valen', at(2, 6), { order: 'sentry' });
    const onFarm = makeTestUnit(s, 'valen', farm.pos, { order: 'sentry' });
    const free = makeTestUnit(s, 'valen', at(12, 6));
    expect(dutyOf(s, resting)).toBe('Resting until healed');
    expect(dutyOf(s, sentry)).toBe('On sentry');
    expect(dutyOf(s, onFarm)).toBe('On sentry'); // the order reads first (it still works the farm)
    expect(unitsAwaitingOrders(s)).toEqual([free.id]);
    expect(unitsAtWork(s)).toBe(3);

    // An enemy within attack reach from where it stands: it needs orders again.
    makeTestUnit(s, 'thorn', off(sentry.pos, 1));
    expect(unitsAwaitingOrders(s)).toEqual([sentry.id, free.id]);
    // Once the order ends, Tab finds it like any idle unit.
    delete resting.order;
    expect(unitsAwaitingOrders(s)).toContain(resting.id);
  });

  it('with the HUD\'s move-then-attack test, an ordered unit comes back when its Attack button would be lit', () => {
    const s = makeTestState(16, 10);
    const farm = makeTestBuilding(s, 'farm', 'valen', at(8, 2));
    const resting = makeTestUnit(s, 'valen', at(2, 5), { hp: 5, order: 'heal' });
    const sentry = makeTestUnit(s, 'valen', at(12, 6), { order: 'sentry' });
    const worker = makeTestUnit(s, 'valen', farm.pos);
    // Pretend every unit has an enemy a few hexes off (reachable by moving, not from where it stands).
    const strikes = () => true;
    expect(unitsAwaitingOrders(s)).toEqual([]);
    expect(unitsAwaitingOrders(s, new Set(), strikes)).toEqual([resting.id, sentry.id]);
    expect(unitsAtWork(s, new Set(), strikes)).toBe(1);
    // Only the order is lifted for it: a worker keeps its job, and a unit that acted is done.
    expect(unitsAwaitingOrders(s, new Set(), strikes)).not.toContain(worker.id);
    resting.acted = true;
    expect(unitsAwaitingOrders(s, new Set(), (u) => u.id === resting.id)).toEqual([]);
  });

  it('warns of a hostile that would end a new order at once', () => {
    const s = makeTestState(16, 10);
    const u = makeTestUnit(s, 'valen', at(2, 5), { hp: 5 });
    const foe = makeTestUnit(s, 'thorn', off(u.pos, HEAL_ORDER_ALERT + 1));
    computeVisibility(s, 'valen');
    expect(orderWakeThreat(s, u, 'heal')).toBeNull();   // 3 hexes: a rester sleeps on
    expect(orderWakeThreat(s, u, 'sentry')).toBe(foe);  // within its sight: a sentry would wake
    foe.pos = off(u.pos, HEAL_ORDER_ALERT);
    expect(orderWakeThreat(s, u, 'heal')).toBe(foe);
  });
});

describe('AI and saves', () => {
  it('the AI never gives standing orders', () => {
    const settings: GameSettings = { mapSize: 'small', seed: 4242, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' };
    const s = createGame(settings);
    s.factions.valen.isHuman = false; // every house is played by the AI
    startTurn(s, currentFaction(s));
    const types = new Set<string>();
    for (let turn = 0; turn < 3 * 6 && !s.gameOver; turn++) {
      const f = currentFaction(s);
      const mem = createAiMemory(s, f);
      for (let i = 0; i < AI_STEP_CAP; i++) {
        const a = aiNextAction(s, mem);
        if (!a || a.type === 'endTurn') break;
        types.add(a.type);
        if (!applyAction(s, a).ok) break;
      }
      const evs = applyAction(s, { type: 'endTurn', faction: f }).events;
      expect(ended(evs)).toEqual([]);
      expect(Object.values(s.units).filter((u) => u.order !== undefined)).toEqual([]);
    }
    expect(types.has('order')).toBe(false);
    expect(types.size).toBeGreaterThan(2); // (it did play)
  });

  it('old saves without orders or level history load; bad orders are dropped', () => {
    const s = createGame({ mapSize: 'small', seed: 9, playerFaction: 'valen', aiCount: 1, difficulty: 'normal' });
    const raw = JSON.parse(serialize(s)) as GameState;
    const ids = Object.keys(raw.units);
    for (const k of ids) { delete raw.units[k].learned; delete raw.units[k].order; }
    const mine = Object.values(raw.units).find((u) => u.faction === 'valen' && !u.isLeader)!;
    mine.order = 'heal';
    const beast = Object.values(raw.units).find((u) => u.monster);
    if (beast) beast.order = 'sentry';
    const leader = Object.values(raw.units).find((u) => u.isLeader && u.faction === 'valen')!;
    (leader as { order?: string }).order = 'dance';
    const back = deserialize(JSON.stringify(raw));
    for (const u of Object.values(back.units)) expect(u.learned).toEqual([]);
    expect(back.units[String(mine.id)].order).toBe('heal');
    if (beast) expect(back.units[String(beast.id)].order).toBeUndefined();
    expect(back.units[String(leader.id)].order).toBeUndefined();
    // And the game goes on from it.
    expect(applyAction(back, { type: 'endTurn', faction: 'valen' }).ok).toBe(true);
  });
});
