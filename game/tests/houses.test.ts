// The three houses' economies (DESIGN §2): honor for the Thornwild, no food and dark-energy elites
// for the Ashen Covenant, the full gold-and-food economy for House Valen.
import { describe, expect, it } from 'vitest';
import type { GameState, Hex } from '../src/core/types';
import { at, makeTestBuilding, makeTestState, makeTestUnit, res, setTerrain } from './helpers';
import {
  ARENA_HONOR, baseOutput, buildingName, FIGHT_HONOR, factionCost, houseForbids, KILL_REWARD, MONSTER_HONOR_SHARE, recruitCost,
  resourcesOf, UNDEAD_CASTLE_MANA, unitUpkeep,
} from '../src/sim/houses';
import { applyProduction, buildingOutput, canBuildAt, factionIncome, workerOf } from '../src/sim/economy';
import { killUnit, resolveCombat } from '../src/sim/combat';
import { applyAction, validateAction } from '../src/sim/actions';
import { canEmpower, nextEliteCost } from '../src/sim/elites';
import { effectiveStats } from '../src/sim/units';
import { createGame, deserialize, serialize } from '../src/sim/state';
import { ELITE_UPKEEP } from '../src/data/elites';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });

/** A test map with the Ashen Covenant in play as well (the helper has Valen and the Thornwild). */
function withAshen(s: GameState): GameState {
  s.factions.ashen = { ...structuredClone(s.factions.thorn), id: 'ashen', resources: res({ gold: 100, mana: 50, wood: 50, stone: 50, iron: 30, crystal: 20 }) };
  s.turnOrder.push('ashen');
  return s;
}

describe('house resources and costs', () => {
  it('each house shows its own resources: honor for the orcs, no food and dark energy for the undead', () => {
    expect(resourcesOf('valen')).toEqual(['gold', 'food', 'wood', 'stone', 'iron', 'crystal', 'mana', 'research']);
    expect(resourcesOf('thorn')).toEqual(['honor', 'food', 'wood', 'stone', 'iron', 'crystal', 'mana', 'research']);
    expect(resourcesOf('ashen')).toEqual(['gold', 'wood', 'stone', 'iron', 'crystal', 'mana', 'research', 'dark']);
  });

  it('costs: orcs pay honor where others pay gold, the undead never pay food', () => {
    expect(factionCost('thorn', { gold: 6, wood: 8 })).toEqual({ honor: 6, wood: 8 });
    expect(factionCost('ashen', { food: 4, gold: 2 })).toEqual({ gold: 2 });
    expect(factionCost('valen', { food: 4, gold: 2 })).toEqual({ food: 4, gold: 2 });
    expect(recruitCost('valen', 'commoner')).toEqual({ gold: 15, food: 5 });
    expect(recruitCost('thorn', 'commoner')).toEqual({ honor: 15, food: 5 });
    expect(recruitCost('ashen', 'commoner')).toEqual({ gold: 8 }); // cheap dead
    expect(recruitCost('thorn', 'swordsman')).toEqual({ honor: 17, food: 9, wood: 4, iron: 6 }); // + sword and tunic
    expect(recruitCost('ashen', 'swordsman')).toEqual({ gold: 10, wood: 4, iron: 6 }); // the tunic's food dropped
  });

  it('yields: an orc castle makes honor, orc houses nothing, the Arena honor; the undead castle mana', () => {
    expect(baseOutput('castle', 'thorn')).toEqual({ honor: 3, food: 1, research: 3 });
    expect(baseOutput('house', 'thorn')).toEqual({});
    expect(baseOutput('training', 'thorn')).toEqual({ honor: ARENA_HONOR });
    expect(baseOutput('training', 'valen')).toEqual({});
    expect(baseOutput('castle', 'ashen')).toEqual({ gold: 3, mana: UNDEAD_CASTLE_MANA, research: 3 });
    expect(baseOutput('farm', 'ashen')).toEqual({});
    expect(buildingName('training', 'thorn')).toBe('Arena');
    expect(buildingName('training', 'valen')).toBe('Training Ground');
  });

  it('the undead start without a farm; the living with one', () => {
    for (const f of ['ashen', 'thorn'] as const) {
      const g = createGame({ mapSize: 'small', seed: 5, playerFaction: f, aiCount: 2, difficulty: 'normal' });
      const farms = (h: string) => Object.values(g.buildings).filter((b) => b.owner === h && b.type === 'farm').length;
      expect(farms('ashen')).toBe(0);
      expect(farms('valen')).toBe(1);
      expect(farms('thorn')).toBe(1);
    }
  });

  it('the dead do not farm', () => {
    const s = withAshen(makeTestState());
    const b = makeTestUnit(s, 'ashen', at(3, 3), { items: ['tools'] });
    makeTestBuilding(s, 'castle', 'ashen', at(4, 3));
    expect(houseForbids('farm', 'ashen')).toMatch(/do not farm/);
    expect(canBuildAt(s, b, 'farm')).toMatch(/do not farm/);
    expect(canBuildAt(s, b, 'house')).toBeNull();
  });

  it('an orc Arena yields honor only while a unit works it; Strength drives it', () => {
    const s = makeTestState();
    const arena = makeTestBuilding(s, 'training', 'thorn', at(5, 5));
    expect(buildingOutput(s, arena)).toEqual({}); // empty: nothing
    const w = makeTestUnit(s, 'thorn', arena.pos, { base: { maxHp: 30, str: 0, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } });
    expect(workerOf(s, arena)?.id).toBe(w.id);
    expect(buildingOutput(s, arena).honor).toBeCloseTo(ARENA_HONOR * 2, 6); // ×2 bare-handed, no Strength bonus at 0
    w.base.str = 10;
    expect(buildingOutput(s, arena).honor).toBeCloseTo(ARENA_HONOR * 2 * 1.3, 6);
  });
});

describe('upkeep', () => {
  it('per unit: Valen 1 food; Thornwild 1 food + 0.5 honor; Ashen 0.5 mana, +0.5 per elite rank; leaders free', () => {
    const s = withAshen(makeTestState());
    expect(unitUpkeep(makeTestUnit(s, 'valen', at(1, 1)))).toEqual({ food: 1 });
    expect(unitUpkeep(makeTestUnit(s, 'thorn', at(2, 1)))).toEqual({ food: 1, honor: 0.5 });
    expect(unitUpkeep(makeTestUnit(s, 'ashen', at(3, 1)))).toEqual({ mana: 0.5 });
    expect(unitUpkeep(makeTestUnit(s, 'ashen', at(4, 1), { elite: { vigor: 2, might: 1 } }))).toEqual({ mana: 0.5 + 3 * ELITE_UPKEEP });
    expect(unitUpkeep(makeTestUnit(s, 'thorn', at(5, 1), { isLeader: true }))).toEqual({});
  });

  it('an unpaid honor or mana upkeep hurts the units that draw it, like hunger', () => {
    const s = withAshen(makeTestState());
    s.factions.thorn.resources = res({ food: 50, honor: 0 });
    const orc = makeTestUnit(s, 'thorn', at(2, 2));
    const before = orc.hp;
    applyProduction(s, 'thorn');
    expect(orc.hp).toBe(before - 4);
    expect(s.factions.thorn.resources.honor).toBe(0);
    s.factions.ashen.resources = res({ gold: 50, mana: 0 });
    const dead = makeTestUnit(s, 'ashen', at(6, 6));
    const dhp = dead.hp;
    applyProduction(s, 'ashen');
    expect(dead.hp).toBe(dhp - 4);
    expect(factionIncome(s, 'ashen').food).toBe(0); // the dead never eat
  });
});

describe('honor and dark energy', () => {
  it('orcs win honor in every fight they take part in, won or lost, and for kills (half for a monster)', () => {
    const s = makeTestState();
    s.factions.thorn.resources.honor = 0;
    s.factions.valen.resources.honor = 0;
    const a = makeTestUnit(s, 'thorn', at(4, 4), { items: ['sword'], hp: 200, base: { maxHp: 200, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } });
    const d = makeTestUnit(s, 'valen', off(a.pos, 1), { items: ['sword'], hp: 200, base: { maxHp: 200, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } });
    resolveCombat(s, a, d, 'melee');
    expect(s.factions.thorn.resources.honor).toBe(FIGHT_HONOR); // however many blows landed
    expect(s.factions.valen.resources.honor).toBe(0); // only the honor-bound gain it
    // A kill: +2 per level of the victim (a level-2 victim: +4), half for a monster.
    let before = s.factions.thorn.resources.honor;
    const victim = makeTestUnit(s, 'valen', at(8, 8), { level: 2 });
    killUnit(s, victim, a);
    expect(s.factions.thorn.resources.honor).toBe(before + 2 * KILL_REWARD.thorn!.honor!);
    before = s.factions.thorn.resources.honor;
    const beast = makeTestUnit(s, 'neutral', at(9, 9), { level: 2, monster: 'wolf' });
    killUnit(s, beast, a);
    expect(s.factions.thorn.resources.honor).toBe(before + 2 * KILL_REWARD.thorn!.honor! * MONSTER_HONOR_SHARE);
  });

  it('only killing brings the undead dark energy', () => {
    const s = withAshen(makeTestState());
    const k = makeTestUnit(s, 'ashen', at(4, 4), { items: ['sword'] });
    const v = makeTestUnit(s, 'valen', at(9, 9), { level: 3 });
    killUnit(s, v, k);
    expect(s.factions.ashen.resources.dark).toBe(3 * KILL_REWARD.ashen!.dark!);
  });

  it('the undead are immune to poison', () => {
    const s = withAshen(makeTestState());
    const a = makeTestUnit(s, 'valen', at(4, 4), { items: ['sword'], passives: ['poison'] });
    const d = makeTestUnit(s, 'ashen', off(a.pos, 1), { hp: 200, base: { maxHp: 200, str: 0, dex: 0, int: 0, armor: 0, block: 0, mov: 5, vis: 4 } });
    s.rngState = 3;
    for (let i = 0; i < 4; i++) { a.acted = false; resolveCombat(s, a, d, 'melee'); }
    expect(d.poisoned).toBe(false);
  });
});

describe('undead elites', () => {
  it('bought with dark energy on the castle or a mage tower; stats, cost and upkeep grow per rank', () => {
    const s = withAshen(makeTestState());
    s.currentTurn = s.turnOrder.indexOf('ashen');
    const castle = makeTestBuilding(s, 'castle', 'ashen', at(5, 5));
    const u = makeTestUnit(s, 'ashen', at(2, 2));
    s.factions.ashen.resources.dark = 25;
    expect(canEmpower(s, u, 'might')).toMatch(/castle or a mage tower/);
    u.pos = { ...castle.pos };
    expect(nextEliteCost(u, 'might')).toBe(10);
    const str = effectiveStats(s, u).str;
    expect(applyAction(s, { type: 'empower', unit: u.id, elite: 'might' }).ok).toBe(true);
    expect(effectiveStats(s, u).str).toBe(str + 4);
    expect(s.factions.ashen.resources.dark).toBe(15);
    expect(nextEliteCost(u, 'might')).toBe(20);
    expect(validateAction(s, { type: 'empower', unit: u.id, elite: 'might' })).toMatch(/dark energy/);
    const hp = u.hp;
    expect(applyAction(s, { type: 'empower', unit: u.id, elite: 'vigor' }).ok).toBe(true);
    expect(u.hp).toBe(hp + 10); // the new hit points come at once
    expect(unitUpkeep(u).mana).toBe(0.5 + 2 * ELITE_UPKEEP);
    // Only the Ashen Covenant raises elites.
    const v = makeTestUnit(s, 'valen', at(7, 7));
    expect(canEmpower(s, v, 'might')).toMatch(/Ashen/);
  });
});

describe('older saves', () => {
  it('an orc house\'s gold becomes honor; honor and dark energy start at 0', () => {
    const s = makeTestState();
    for (const fs of Object.values(s.factions)) {
      delete (fs.resources as Partial<typeof fs.resources>).honor;
      delete (fs.resources as Partial<typeof fs.resources>).dark;
    }
    s.factions.thorn.resources.gold = 42;
    const t = deserialize(serialize(s));
    expect([t.factions.thorn.resources.gold, t.factions.thorn.resources.honor]).toEqual([0, 42]);
    expect(t.factions.valen.resources.honor).toBe(0);
    expect(t.factions.valen.resources.dark).toBe(0);
  });
});

void setTerrain;
