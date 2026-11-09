// The seven kinds of experience (DESIGN §4.7): where each XP source lands, bare-handed workers
// (DESIGN §5), and loading saves made before 'fight' and 'civil' were split.
import { describe, expect, it } from 'vitest';
import type { GameEvent, Hex, Unit, XpCategory } from '../src/core/types';
import { tileIndex } from '../src/core/hex';
import { applyAction } from '../src/sim/actions';
import { killUnit, resolveCombat } from '../src/sim/combat';
import {
  BARE_WORKER_MULT, WORKER_MULT, buildingOutput, buildingXpPerTurn, craft, progressConstruction, recruit, startBuilding, workerOf,
  workerResourceMult,
} from '../src/sim/economy';
import { migrateUnitXp, deserialize, serialize } from '../src/sim/state';
import { computeVisibility } from '../src/sim/visibility';
import { mainXpCategory } from '../src/sim/progression';
import { XP_CATEGORIES } from '../src/data/skills';
import { at, makeTestBuilding, makeTestState, makeTestUnit, setTerrain } from './helpers';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });
const big = () => ({ maxHp: 200, str: 4, dex: 4, int: 3, armor: 0, mov: 5, vis: 4 });

/** Categories with any lifetime XP. */
const earned = (u: Unit): XpCategory[] => XP_CATEGORIES.filter((c) => (u.xpByCat[c] ?? 0) > 0);

describe('combat XP follows the attack kind', () => {
  it('melee, ranged and magic attacks teach their own kind', () => {
    for (const [item, kind, dist] of [['sword', 'melee', 1], ['bow', 'ranged', 2], ['staff', 'magic', 2]] as const) {
      const s = makeTestState();
      const a = makeTestUnit(s, 'valen', at(3, 3), { items: [item] });
      const d = makeTestUnit(s, 'thorn', off(at(3, 3), dist), { base: big(), hp: 200 });
      resolveCombat(s, a, d, kind);
      expect(earned(a)).toEqual([kind]);
    }
  });

  it('a kill gives its XP in the kind of the killing blow', () => {
    const s = makeTestState();
    const archer = makeTestUnit(s, 'valen', at(3, 3), { items: ['bow'] });
    const victim = makeTestUnit(s, 'thorn', off(archer.pos, 2), { level: 2 });
    killUnit(s, victim, archer, 'ranged');
    expect(archer.xpByCat.ranged).toBe(16);
    // With no attack named (a skill or poison credit), the killer's own weapon decides.
    const mage = makeTestUnit(s, 'valen', at(6, 3), { items: ['wand'] });
    killUnit(s, makeTestUnit(s, 'thorn', off(mage.pos, 1)), mage);
    expect(earned(mage)).toEqual(['magic']);
  });

  it('Volley teaches ranged XP, its kills too', () => {
    const s = makeTestState();
    const c = at(3, 5);
    const u = makeTestUnit(s, 'valen', c, { items: ['bow'], actives: ['volley'], passives: ['marksman'] });
    makeTestUnit(s, 'thorn', off(c, 2), { hp: 1, level: 2 });
    s.rngState = 4242;
    expect(applyAction(s, { type: 'skill', unit: u.id, skill: 'volley', target: off(c, 2) }).ok).toBe(true);
    expect(earned(u)).toEqual(['ranged']);
    expect(u.xpByCat.ranged).toBeGreaterThanOrEqual(2);
  });
});

describe('building, civic, research & magic, leadership XP', () => {
  it('construction with Builder\'s Tools is building XP; the leader raising its castle too', () => {
    const s = makeTestState(14, 12);
    makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const u = makeTestUnit(s, 'valen', off(at(5, 5), 1), { items: ['tools'] });
    startBuilding(s, u, 'farm');
    progressConstruction(s, 'valen');
    expect(u.xpByCat.building).toBe(3);
    expect(earned(u)).toEqual(['building']);

    const s2 = makeTestState(14, 12);
    const leader = makeTestUnit(s2, 'valen', at(6, 6), { isLeader: true });
    startBuilding(s2, leader, 'castle');
    progressConstruction(s2, 'valen');
    expect(earned(leader)).toEqual(['building']);
  });

  it('working a building needs no tools: civic on a farm, magic in a library, leadership on the castle', () => {
    const s = makeTestState(14, 12);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const farm = makeTestBuilding(s, 'farm', 'valen', off(castle.pos, 2));
    const lib = makeTestBuilding(s, 'library', 'valen', off(castle.pos, -2));
    const shrine = makeTestBuilding(s, 'shrine', 'valen', off(castle.pos, 0, 2));
    const hand = makeTestUnit(s, 'valen', farm.pos);
    const scholar = makeTestUnit(s, 'valen', lib.pos, { items: ['sword'] });
    const monk = makeTestUnit(s, 'valen', shrine.pos, { items: ['tools'] });
    const leader = makeTestUnit(s, 'valen', castle.pos, { isLeader: true });
    expect(workerOf(s, farm)).toBe(hand);
    progressConstruction(s, 'valen');
    expect(hand.xpByCat.civic).toBe(2);
    expect(earned(hand)).toEqual(['civic']);
    expect(earned(scholar)).toEqual(['magic']);
    expect(scholar.xpByCat.magic).toBe(2);
    expect(earned(monk)).toEqual(['magic']);
    expect(earned(leader)).toEqual(['leader']);
    expect(leader.xpByCat.leader).toBe(2); // 2 × 1.3 = 2.6 → 2, the 0.6 carries
    // A worker that acted this turn earns nothing for it.
    hand.acted = true;
    progressConstruction(s, 'valen');
    expect(hand.xpByCat.civic).toBe(2);
  });

  it('the castle teaches its leader leadership and anyone else civic, never magic', () => {
    const s = makeTestState(14, 12);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const watch = makeTestBuilding(s, 'watchtower', 'valen', off(castle.pos, 3));
    const steward = makeTestUnit(s, 'valen', castle.pos, { items: ['bow'] });
    const lookout = makeTestUnit(s, 'valen', watch.pos);
    expect(workerOf(s, castle)).toBe(steward);
    progressConstruction(s, 'valen');
    expect(earned(steward)).toEqual(['civic']);
    expect(steward.xpByCat.civic).toBe(2);
    // Other research buildings still teach research & magic.
    expect(earned(lookout)).toEqual(['magic']);
  });

  it('a unit that appeared this turn earns no work XP yet', () => {
    const s = makeTestState(14, 12);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const house = makeTestBuilding(s, 'house', 'valen', off(castle.pos, 3));
    const leader = makeTestUnit(s, 'valen', castle.pos, { isLeader: true });
    recruit(s, house.id, 'commoner');
    const rookie = Object.values(s.units).find((u) => u.id !== leader.id && u.pos.q === house.pos.q && u.pos.r === house.pos.r)!;
    expect(rookie.justSpawned).toBe(true);
    rookie.acted = false; // (even a recruit that somehow has not "acted")
    progressConstruction(s, 'valen');
    expect(earned(rookie)).toEqual([]);
    delete rookie.justSpawned;
    progressConstruction(s, 'valen');
    expect(earned(rookie)).toEqual(['civic']);
  });

  it('a unit that is not a worker earns no work XP: enemies, summons, idle buildings', () => {
    const s = makeTestState(14, 12);
    const farm = makeTestBuilding(s, 'farm', 'valen', at(3, 3));
    const forge = makeTestBuilding(s, 'forge', 'valen', at(6, 3));
    const site = makeTestBuilding(s, 'house', 'valen', at(9, 3), { buildLeft: 2 });
    const golem = makeTestUnit(s, 'valen', farm.pos, { monster: 'elemental', summonTurns: 5 });
    const smith = makeTestUnit(s, 'valen', forge.pos, { items: ['tools'] });
    const idler = makeTestUnit(s, 'valen', site.pos);
    expect(workerOf(s, farm)).toBeNull();
    expect(workerOf(s, forge)).toBeNull();
    expect(workerOf(s, site)).toBeNull();
    progressConstruction(s, 'valen');
    expect(earned(golem)).toEqual([]);
    expect(earned(smith)).toEqual([]);
    expect(earned(idler)).toEqual([]);
    golem.pos = at(1, 1);
    const enemy = makeTestUnit(s, 'thorn', farm.pos);
    expect(workerOf(s, farm)).toBeNull();
    progressConstruction(s, 'thorn');
    expect(earned(enemy)).toEqual([]);
  });

  it('a bare-handed worker keeps working an upgrading building at its current level', () => {
    const s = makeTestState(14, 12);
    const farm = makeTestBuilding(s, 'farm', 'valen', at(3, 3), { upgrading: true, buildLeft: 2 });
    const hand = makeTestUnit(s, 'valen', farm.pos);
    progressConstruction(s, 'valen');
    expect(farm.buildLeft).toBe(2);
    expect(earned(hand)).toEqual(['civic']);
  });

  it('the smith on the forge learns civic XP', () => {
    const s = makeTestState(14, 12);
    const forge = makeTestBuilding(s, 'forge', 'valen', at(3, 3));
    const smith = makeTestUnit(s, 'valen', forge.pos);
    craft(s, forge.id, 'sword');
    expect(earned(smith)).toEqual(['civic']);
  });

  it('recruiting teaches the leader leadership', () => {
    const s = makeTestState(14, 12);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const leader = makeTestUnit(s, 'valen', castle.pos, { isLeader: true });
    recruit(s, castle.id, 'commoner');
    expect(earned(leader)).toEqual(['leader']);
  });
});

describe('drill grounds', () => {
  it('the Training Ground drills archers in ranged XP and everyone else in melee; the Mage Tower in magic', () => {
    const s = makeTestState(14, 12);
    const tg = makeTestBuilding(s, 'training', 'valen', at(3, 3));
    const tg2 = makeTestBuilding(s, 'training', 'valen', at(6, 3));
    const tower = makeTestBuilding(s, 'magetower', 'valen', at(9, 3));
    const archer = makeTestUnit(s, 'valen', tg.pos, { items: ['bow'] });
    const sword = makeTestUnit(s, 'valen', tg2.pos, { items: ['sword'] });
    const mage = makeTestUnit(s, 'valen', tower.pos, { items: ['staff'] });
    expect(buildingXpPerTurn(tg, archer)).toEqual({ cat: 'ranged', amount: 5 });
    expect(buildingXpPerTurn(tg, sword)).toEqual({ cat: 'melee', amount: 5 });
    expect(buildingXpPerTurn(tg)).toEqual({ cat: 'melee', amount: 5 });
    progressConstruction(s, 'valen');
    expect(archer.xpByCat).toMatchObject({ ranged: 5, melee: 0 });
    expect(sword.xpByCat).toMatchObject({ melee: 5, ranged: 0 });
    // A mage in its tower: drill (3) plus working a mana building (2), all research & magic.
    expect(earned(mage)).toEqual(['magic']);
    expect(mage.xpByCat.magic).toBe(3 + 2);
  });
});

describe('exploration XP', () => {
  it('new tiles and ruins are exploration XP', () => {
    const s = makeTestState(20, 12);
    const u = makeTestUnit(s, 'valen', at(2, 5));
    s.factions.valen.explored = new Array(s.width * s.height).fill(0);
    computeVisibility(s, 'valen');
    const ruin = off(u.pos, 3);
    setTerrain(s, ruin, 'ruins');
    const r = applyAction(s, { type: 'move', unit: u.id, to: ruin });
    expect(r.events.some((e: GameEvent) => e.type === 'ruinsExplored')).toBe(true);
    expect(s.tiles[tileIndex(ruin, s.width)].ruinsLooted).toBe(true);
    expect(earned(u)).toEqual(['explore']);
  });
});

describe('main XP category fallback by kit', () => {
  it('builder → building, archer → ranged, fighter → melee, mage → magic, leader → leader', () => {
    const s = makeTestState();
    expect(mainXpCategory(makeTestUnit(s, 'valen', at(1, 1), { items: ['tools'] }))).toBe('building');
    expect(mainXpCategory(makeTestUnit(s, 'valen', at(2, 1), { items: ['bow'] }))).toBe('ranged');
    expect(mainXpCategory(makeTestUnit(s, 'valen', at(3, 1), { items: ['axe'] }))).toBe('melee');
    expect(mainXpCategory(makeTestUnit(s, 'valen', at(4, 1), { items: ['wand'] }))).toBe('magic');
    expect(mainXpCategory(makeTestUnit(s, 'valen', at(5, 1), { isLeader: true }))).toBe('leader');
  });
});

describe('worker output', () => {
  it('bare-handed ×1.25, Builder\'s Tools ×1.5, both × the worker\'s efficiencies', () => {
    expect(BARE_WORKER_MULT).toBe(1.25);
    expect(WORKER_MULT).toBe(1.5);
    const s = makeTestState(14, 12);
    const farm = makeTestBuilding(s, 'farm', 'valen', at(3, 3));
    expect(buildingOutput(s, farm)).toEqual({ food: 3 });
    const w = makeTestUnit(s, 'valen', farm.pos);
    expect(buildingOutput(s, farm).food).toBeCloseTo(3 * 1.25, 2);
    w.efficiency = { farming: 1.25, building: 1.25 };
    expect(buildingOutput(s, farm).food).toBeCloseTo(3 * 1.25 * 1.25 * 1.25, 2);
    // The tile panel's "worked by" line reads the same multiplier, per resource.
    expect(workerResourceMult(w, 'food')).toBeCloseTo(1.25 * 1.25 * 1.25, 6);
    expect(workerResourceMult(w, 'gold')).toBeCloseTo(1.25 * 1.25, 6);
    w.equipment.main = 'tools';
    expect(buildingOutput(s, farm).food).toBeCloseTo(3 * 1.5 * 1.25 * 1.25, 2);
    w.efficiency = {};
    w.equipment.main = 'sword';
    expect(buildingOutput(s, farm).food).toBeCloseTo(3.75, 2); // any weapon works it bare-handed
    // The leader holding its castle works it (and still gives every building +10%).
    const castle = makeTestBuilding(s, 'castle', 'valen', at(8, 6));
    makeTestUnit(s, 'valen', castle.pos, { isLeader: true });
    expect(buildingOutput(s, castle).gold).toBeCloseTo(3 * 1.25 * 1.1, 2);
    expect(buildingOutput(s, farm).food).toBeCloseTo(3 * 1.25 * 1.1, 2);
  });
});

describe('save migration', () => {
  it('maps old fight/civil tallies onto the new categories and back-fills the rest', () => {
    const s = makeTestState();
    const archer = makeTestUnit(s, 'valen', at(1, 1), { items: ['bow'] });
    const knight = makeTestUnit(s, 'valen', at(2, 1), { items: ['sword'] });
    const old = (u: Unit, fight: number, civil: number) => {
      (u as any).xpByCat = { civil, fight, magic: 1, explore: 2, leader: 0 };
      (u as any).levelXpByCat = { civil, fight };
      (u as any).levelUpXp = [{ civil: 3, fight: 4, magic: 0, explore: 0, leader: 0 }];
    };
    old(archer, 10, 5);
    old(knight, 7, 0);
    const loaded = deserialize(serialize(s));
    const a = loaded.units[String(archer.id)];
    const k = loaded.units[String(knight.id)];
    expect(a.xpByCat).toEqual({ melee: 0, ranged: 10, building: 0, civic: 5, explore: 2, leader: 0, magic: 1 });
    expect(a.levelXpByCat).toEqual({ melee: 0, ranged: 10, building: 0, civic: 5, explore: 0, leader: 0, magic: 0 });
    expect(a.levelUpXp).toEqual([{ melee: 0, ranged: 4, building: 0, civic: 3, explore: 0, leader: 0, magic: 0 }]);
    expect(k.xpByCat).toEqual({ melee: 7, ranged: 0, building: 0, civic: 0, explore: 2, leader: 0, magic: 1 });
    // Missing tallies become zeroes; current saves pass through untouched.
    const u = makeTestUnit(s, 'valen', at(3, 1));
    delete (u as any).xpByCat;
    migrateUnitXp(u);
    expect(u.xpByCat).toEqual({ melee: 0, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 });
    const fresh = { ...k.xpByCat };
    migrateUnitXp(k);
    expect(k.xpByCat).toEqual(fresh);
  });
});
