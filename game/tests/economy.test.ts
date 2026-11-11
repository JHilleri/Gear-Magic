import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState, Hex } from '../src/core/types';
import { hexDistance, neighbors, spiral, tileIndex } from '../src/core/hex';
import {
  buildingOutput, buildingXpPerTurn, canAfford, canBuildAt, canCraft, canRecruit, canUpgrade, captureBuildings, computeTerritory, craft,
  emptyResources, factionIncome, formatCost, maxBuildingLevel, pay, presetCost, progressConstruction, recruit, scaleCost,
  startBuilding, startUpgrade, territoryOwner, applyProduction, upgradeCost, BUILD_XP, WORK_XP, buildingCost, BUILDING_COST_STEP,
} from '../src/sim/economy';
import { BUILDINGS } from '../src/data/buildings';
import { at, makeTestBuilding, makeTestState, makeTestUnit, res, setTerrain } from './helpers';

const C = at(5, 5);
const step = (h: Hex, dq: number, dr: number): Hex => ({ q: h.q + dq, r: h.r + dr });

function base() {
  const s = makeTestState(14, 12);
  const castle = makeTestBuilding(s, 'castle', 'valen', C);
  return { s, castle };
}

describe('resource helpers', () => {
  it('afford / pay / scale / format', () => {
    const r = res({ wood: 10, stone: 4 });
    expect(canAfford(r, { wood: 8, stone: 4 })).toBe(true);
    expect(canAfford(r, { wood: 11 })).toBe(false);
    pay(r, { wood: 8, stone: 4 });
    expect(r.wood).toBe(2);
    expect(r.stone).toBe(0);
    expect(scaleCost({ wood: 8, stone: 4 }, 2)).toEqual({ wood: 16, stone: 8 });
    expect(formatCost({ stone: 4, wood: 8 })).toBe('8 wood, 4 stone');
    expect(formatCost({})).toBe('free');
    expect(emptyResources()).toEqual(res());
  });

  it('preset cost = commoner + items', () => {
    expect(presetCost('commoner')).toEqual({ gold: 15, food: 5 });
    expect(presetCost('swordsman')).toEqual({ gold: 17, food: 9, wood: 4, iron: 6 });
  });
});

describe('territory', () => {
  it('castle radius 2, others radius 1, older wins, sites claim only their hex', () => {
    const { s } = base();
    const terr = computeTerritory(s);
    expect(terr.filter((x) => x === 'valen').length).toBe(19);
    const far = at(10, 5);
    const thornHouse = makeTestBuilding(s, 'house', 'thorn', far, { foundedRound: 3 });
    expect(territoryOwner(s, far)).toBe('thorn');
    // An older thorn farm next to our castle edge keeps its overlap.
    const edge = step(C, 3, 0);
    makeTestBuilding(s, 'farm', 'thorn', edge, { foundedRound: -1 });
    expect(territoryOwner(s, step(C, 2, 0))).toBe('thorn');
    // Construction site claims its own hex only.
    const site = at(2, 10);
    makeTestBuilding(s, 'house', 'valen', site, { buildLeft: 2 });
    expect(territoryOwner(s, site)).toBe('valen');
    expect(neighbors(site).every((n) => territoryOwner(s, n) !== 'valen')).toBe(true);
    // Abandoned buildings claim nothing.
    thornHouse.owner = null;
    expect(territoryOwner(s, far)).toBeNull();
  });

  it('an older construction site keeps its hex against a newer completed neighbour', () => {
    const { s } = base();
    const site = makeTestBuilding(s, 'farm', 'valen', at(10, 8), { buildLeft: 2, foundedRound: 1 });
    makeTestBuilding(s, 'house', 'thorn', step(site.pos, 1, 0), { foundedRound: 5 });
    expect(territoryOwner(s, site.pos)).toBe('valen');
    expect(territoryOwner(s, step(site.pos, 1, 0))).toBe('thorn');
    // A newer site loses its hex to an older completed claim, as before.
    const s2 = base().s;
    const late = makeTestBuilding(s2, 'farm', 'valen', at(10, 8), { buildLeft: 2, foundedRound: 6 });
    makeTestBuilding(s2, 'house', 'thorn', step(late.pos, 1, 0), { foundedRound: 5 });
    expect(territoryOwner(s2, late.pos)).toBe('thorn');
  });
});

describe('building rules', () => {
  it('requires tools, an action, fitting terrain and an empty hex', () => {
    const { s } = base();
    const h = step(C, 1, 0);
    const u = makeTestUnit(s, 'valen', h);
    expect(canBuildAt(s, u, 'farm')).toMatch(/Tools/);
    u.equipment.main = 'tools';
    expect(canBuildAt(s, u, 'farm')).toBeNull();
    u.acted = true;
    expect(canBuildAt(s, u, 'farm')).toMatch(/acted/);
    u.acted = false;
    setTerrain(s, h, 'forest');
    expect(canBuildAt(s, u, 'farm')).toMatch(/Forest/);
    expect(canBuildAt(s, u, 'lumber')).toBeNull();
    setTerrain(s, h, 'shallows');
    expect(canBuildAt(s, u, 'farm')).toMatch(/Shallows/);
    setTerrain(s, h, 'grass');
    makeTestBuilding(s, 'house', 'valen', h);
    expect(canBuildAt(s, u, 'farm')).toMatch(/already a building/);
  });

  it('tech and deposit requirements', () => {
    const { s } = base();
    const h = step(C, 0, 1);
    setTerrain(s, h, 'hills');
    const u = makeTestUnit(s, 'valen', h, { items: ['tools'] });
    expect(canBuildAt(s, u, 'mine')).toMatch(/Mining/);
    s.factions.valen.techs.push('mining');
    expect(canBuildAt(s, u, 'mine')).toMatch(/iron deposit/);
    s.tiles[tileIndex(h, s.width)].deposit = 'iron';
    expect(canBuildAt(s, u, 'mine')).toBeNull();
    expect(canBuildAt(s, u, 'quarry')).toBeNull();
  });

  it('skill buildings need a unit with the skill', () => {
    const { s } = base();
    const u = makeTestUnit(s, 'valen', step(C, 1, 0), { items: ['tools'] });
    expect(canBuildAt(s, u, 'watchtower')).toMatch(/Masonry skill/);
    u.actives.push('masonry');
    expect(canBuildAt(s, u, 'watchtower')).toBeNull();
    expect(canBuildAt(s, u, 'shrine')).toMatch(/Devotion/);
  });

  it('inside or adjacent to own territory, never in enemy land', () => {
    const { s } = base();
    const u = makeTestUnit(s, 'valen', step(C, 3, 0), { items: ['tools'] }); // adjacent to radius-2 territory
    expect(territoryOwner(s, u.pos)).toBeNull();
    expect(canBuildAt(s, u, 'farm')).toBeNull();
    u.pos = step(C, 5, 0);
    expect(canBuildAt(s, u, 'farm')).toMatch(/territory/);
    makeTestBuilding(s, 'farm', 'thorn', step(C, 6, 0));
    expect(canBuildAt(s, u, 'house')).toMatch(/another faction/);
  });

  it('checks cost', () => {
    const { s } = base();
    const u = makeTestUnit(s, 'valen', step(C, 1, 0), { items: ['tools'] });
    s.factions.valen.resources = res({ wood: 9, stone: 6, gold: 6 }); // a house costs 10 wood, 6 stone, 6 gold
    expect(canBuildAt(s, u, 'house')).toMatch(/Not enough.*need 1 wood more/);
  });

  it('startBuilding pays and places a site; progress at end of turn completes it', () => {
    const { s } = base();
    const u = makeTestUnit(s, 'valen', step(C, 1, 0), { items: ['tools'] });
    const { wood: wood0, gold: gold0 } = s.factions.valen.resources;
    const evs = startBuilding(s, u, 'farm');
    const b = Object.values(s.buildings).find((x) => x.type === 'farm')!;
    expect(evs[0]).toEqual({ type: 'buildingStarted', building: b.id });
    // The house's first farm: its base cost, 8 wood and 6 gold.
    expect(s.factions.valen.resources.wood).toBe(wood0 - 8);
    expect(s.factions.valen.resources.gold).toBe(gold0 - 6);
    expect(b.buildLeft).toBe(2);
    expect(u.mp).toBe(0);
    // Level 1 builder: 1 × (1 + 0.1) = 1.1 per turn.
    let ev = progressConstruction(s, 'valen');
    expect(b.buildLeft).toBeCloseTo(0.9);
    expect(ev.some((e) => e.type === 'buildingProgress')).toBe(true);
    expect(BUILD_XP).toBe(5); // the rule's number (DESIGN §5), pinned once
    expect(u.xpByCat.building).toBe(BUILD_XP);
    // A builder that acted does not work.
    u.acted = true;
    progressConstruction(s, 'valen');
    expect(b.buildLeft).toBeCloseTo(0.9);
    u.acted = false;
    ev = progressConstruction(s, 'valen');
    expect(b.buildLeft).toBe(0);
    expect(ev.some((e) => e.type === 'buildingCompleted')).toBe(true);
    expect(s.factions.valen.stats.built).toBe(1);
    // Working a complete building: +WORK_XP civic (a farm), building XP stays with the construction.
    progressConstruction(s, 'valen');
    expect(u.xpByCat.building).toBe(2 * BUILD_XP);
    expect(u.xpByCat.civic).toBe(WORK_XP);
  });

  it('building efficiency speeds construction', () => {
    const { s } = base();
    const u = makeTestUnit(s, 'valen', step(C, 1, 0), { items: ['tools'], level: 3, efficiency: { building: 1.25 } });
    startBuilding(s, u, 'forge');
    progressConstruction(s, 'valen');
    const b = Object.values(s.buildings).find((x) => x.type === 'forge')!;
    expect(b.buildLeft).toBeCloseTo(3 - 1.25 * 1.3);
  });

  it('a second castle moves the seat (old one destroyed)', () => {
    const { s, castle } = base();
    const u = makeTestUnit(s, 'valen', step(C, 2, 0), { items: ['tools'] });
    expect(canBuildAt(s, u, 'castle')).toBeNull();
    const evs = startBuilding(s, u, 'castle');
    expect(s.buildings[String(castle.id)]).toBeUndefined();
    expect(s.tiles[tileIndex(C, s.width)].building).toBeNull();
    expect(evs.some((e) => e.type === 'buildingDestroyed')).toBe(true);
    const nc = Object.values(s.buildings).find((b) => b.type === 'castle')!;
    expect(s.factions.valen.castleId).toBe(nc.id);
    // The chronicle says what was lost (a warning: the player also gets a toast), then the new build.
    const logs = evs.filter((e) => e.type === 'log') as Extract<GameEvent, { type: 'log' }>[];
    const demolish = logs.findIndex((e) => e.entry.kind === 'warning' && /demolished/.test(e.entry.text));
    const begins = logs.findIndex((e) => /begins building/.test(e.entry.text));
    expect(demolish).toBeGreaterThanOrEqual(0);
    expect(begins).toBeGreaterThan(demolish);
    expect(logs[demolish].entry.text).toMatch(/recruiting and the \+10% seat bonus are lost/);
  });

  it('moving an unfinished castle site says the site is abandoned', () => {
    const s = makeTestState(14, 12);
    makeTestBuilding(s, 'castle', 'valen', C, { buildLeft: 4 });
    makeTestBuilding(s, 'farm', 'valen', step(C, 1, 0)); // territory to build in
    const u = makeTestUnit(s, 'valen', step(C, 2, 0), { items: ['tools'] });
    expect(canBuildAt(s, u, 'castle')).toBeNull();
    const evs = startBuilding(s, u, 'castle');
    const texts = evs.filter((e) => e.type === 'log').map((e) => (e as Extract<GameEvent, { type: 'log' }>).entry.text);
    expect(texts.some((t) => /unfinished castle site is abandoned/.test(t))).toBe(true);
    expect(texts.some((t) => /demolished/.test(t))).toBe(false);
  });

  it('a house without a castle may found one wherever its leader stands', () => {
    const s = makeTestState(14, 12);
    const leader = makeTestUnit(s, 'valen', at(10, 8), { isLeader: true });
    expect(canBuildAt(s, leader, 'castle')).toBeNull();
    expect(canBuildAt(s, leader, 'farm')).toMatch(/Tools/);
    startBuilding(s, leader, 'castle');
    expect(s.factions.valen.castleId).not.toBeNull();
    // Once a seat exists (even under construction) the leader may still move it — without
    // tools — but only within reach of its territory.
    leader.pos = at(2, 2);
    expect(canBuildAt(s, leader, 'castle')).toMatch(/territory/);
  });

  it('the leader raises its own castle site without tools', () => {
    const s = makeTestState(14, 12);
    const leader = makeTestUnit(s, 'valen', at(6, 6), { isLeader: true });
    startBuilding(s, leader, 'castle');
    const site = Object.values(s.buildings).find((b) => b.type === 'castle')!;
    const before = site.buildLeft;
    progressConstruction(s, 'valen');
    expect(site.buildLeft).toBeLessThan(before);
  });
});

describe('building cost escalation', () => {
  it('each building of a producing type the house owns (sites too) makes the next 25% dearer, rounded up', () => {
    const { s } = base();
    expect(BUILDING_COST_STEP).toBe(0.25);
    expect(buildingCost(s, 'valen', 'farm')).toEqual({ wood: 8, gold: 6 });
    makeTestBuilding(s, 'farm', 'valen', step(C, 1, 0));
    expect(buildingCost(s, 'valen', 'farm')).toEqual({ wood: 10, gold: 8 }); // ×1.25: 10, 7.5 → 8
    makeTestBuilding(s, 'farm', 'valen', step(C, -1, 0), { buildLeft: 2 }); // a site counts as well
    expect(buildingCost(s, 'valen', 'farm')).toEqual({ wood: 12, gold: 9 }); // ×1.5
    expect(buildingCost(s, 'valen', 'farm', 1)).toEqual({ wood: 14, gold: 11 }); // one more planned: ×1.75, 10.5 → 11
    // Another house's farms and other types do not count.
    makeTestBuilding(s, 'farm', 'thorn', at(11, 9));
    expect(buildingCost(s, 'valen', 'farm')).toEqual({ wood: 12, gold: 9 });
    expect(buildingCost(s, 'thorn', 'farm')).toEqual({ wood: 10, gold: 8 });
    expect(buildingCost(s, 'valen', 'house')).toEqual(BUILDINGS.house.cost);
  });

  it('the castle, forge, training ground and wall keep their base cost', () => {
    const { s } = base(); // already holds a castle
    makeTestBuilding(s, 'forge', 'valen', step(C, 1, 0));
    makeTestBuilding(s, 'forge', 'valen', step(C, -1, 0));
    makeTestBuilding(s, 'training', 'valen', step(C, 0, 1));
    makeTestBuilding(s, 'wall', 'valen', step(C, 0, -1));
    for (const t of ['castle', 'forge', 'training', 'wall'] as const) expect(buildingCost(s, 'valen', t)).toEqual(BUILDINGS[t].cost);
  });

  it('canBuildAt asks for and startBuilding pays the escalated price', () => {
    const { s } = base();
    makeTestBuilding(s, 'farm', 'valen', step(C, 2, 0));
    const u = makeTestUnit(s, 'valen', step(C, 1, 0), { items: ['tools'] });
    s.factions.valen.resources = res({ wood: 10, gold: 7 });
    expect(canBuildAt(s, u, 'farm')).toMatch(/Not enough.*need 1 gold more/);
    s.factions.valen.resources.gold = 8;
    expect(canBuildAt(s, u, 'farm')).toBeNull();
    startBuilding(s, u, 'farm');
    expect(s.factions.valen.resources).toEqual(res()); // paid 10 wood, 8 gold
  });
});

describe('drill grounds', () => {
  it('Training Ground XP grows with its level (5/8/10); Mage Tower 3/5/6', () => {
    const { s } = base();
    const tg = makeTestBuilding(s, 'training', 'valen', step(C, 1, 0));
    const u = makeTestUnit(s, 'valen', tg.pos, { items: ['sword'] });
    progressConstruction(s, 'valen');
    expect(u.xpByCat.melee).toBe(5);
    tg.level = 2;
    progressConstruction(s, 'valen');
    expect(u.xpByCat.melee).toBe(5 + 8);
    tg.level = 3;
    progressConstruction(s, 'valen');
    expect(u.xpByCat.melee).toBe(5 + 8 + 10);
    const tower = makeTestBuilding(s, 'magetower', 'valen', step(C, -1, 0));
    expect([1, 2, 3].map((level) => buildingXpPerTurn({ ...tower, level })?.amount)).toEqual([3, 5, 6]);
    expect(buildingXpPerTurn(makeTestBuilding(s, 'farm', 'valen', step(C, 0, 1)))).toBeNull();
  });
});

describe('upgrades', () => {
  it('need Architecture, cost × level, complete to level 2', () => {
    const { s } = base();
    const h = step(C, 1, 0);
    const farm = makeTestBuilding(s, 'farm', 'valen', h);
    const u = makeTestUnit(s, 'valen', h, { items: ['tools'] });
    expect(maxBuildingLevel(s, 'valen')).toBe(1);
    expect(canUpgrade(s, u)).toMatch(/Architecture/);
    s.factions.valen.techs.push('mining', 'masonry', 'architecture');
    expect(maxBuildingLevel(s, 'valen')).toBe(2);
    expect(canUpgrade(s, u)).toBeNull();
    expect(upgradeCost(farm)).toEqual({ wood: 8, gold: 6 }); // the farm's base cost × level 1
    const { wood: wood0, gold: gold0 } = s.factions.valen.resources;
    startUpgrade(s, u);
    expect(s.factions.valen.resources.wood).toBe(wood0 - 8);
    expect(s.factions.valen.resources.gold).toBe(gold0 - 6);
    expect(farm.upgrading).toBe(true);
    expect(farm.buildLeft).toBe(2);
    expect(canUpgrade(s, u)).toMatch(/Already/);
    // Still producing at level 1 (with the worker bonus: 3 × 2.5 Builder's Tools) during the upgrade.
    expect(buildingOutput(s, farm).food).toBe(7.5);
    progressConstruction(s, 'valen');
    progressConstruction(s, 'valen');
    expect(farm.level).toBe(2);
    expect(farm.upgrading).toBe(false);
    expect(canUpgrade(s, u)).toMatch(/Grand Architecture/);
    expect(upgradeCost(farm)).toEqual({ wood: 16, gold: 12 }); // × level 2
  });
});

describe('production', () => {
  it('level, fertile, worker, leader on castle, tech, difficulty', () => {
    const { s } = base();
    const h = step(C, 1, 0);
    const farm = makeTestBuilding(s, 'farm', 'valen', h);
    expect(buildingOutput(s, farm)).toEqual({ food: 3 });
    s.tiles[tileIndex(h, s.width)].deposit = 'fertile';
    expect(buildingOutput(s, farm)).toEqual({ food: 4 });
    s.tiles[tileIndex(h, s.width)].deposit = null;
    farm.level = 2;
    expect(buildingOutput(s, farm)).toEqual({ food: 4.5 });
    farm.level = 1;
    const w = makeTestUnit(s, 'valen', h, { items: ['tools'] });
    expect(buildingOutput(s, farm)).toEqual({ food: 7.5 }); // 3 × 2.5 (worked with Builder's Tools)
    w.efficiency.farming = 1.25;
    // Each efficiency pick is a clean +25% of the worked building's whole output.
    // (Outputs keep 2 decimals: 3 × 2.5 × 1.25 = 9.375 → 9.38.)
    expect(buildingOutput(s, farm).food).toBeCloseTo(9.38, 6);
    w.efficiency.building = 1.25;
    expect(buildingOutput(s, farm).food).toBeCloseTo(11.72, 6); // 3 × 2.5 × 1.25 × 1.25 = 11.71875
    w.efficiency = {};
    w.pos = step(C, -3, 0);
    makeTestUnit(s, 'valen', C, { isLeader: true });
    expect(buildingOutput(s, farm).food).toBeCloseTo(3.3);
    s.factions.valen.techs.push('croprotation');
    expect(buildingOutput(s, farm).food).toBeCloseTo(3 * 1.1 * 1.25, 2);
    // An enemy worker does not help; construction sites produce nothing.
    farm.buildLeft = 1;
    expect(buildingOutput(s, farm)).toEqual({});
  });

  it('AI difficulty multiplies AI income', () => {
    const s = makeTestState(14, 12);
    const farm = makeTestBuilding(s, 'farm', 'thorn', at(8, 8));
    expect(buildingOutput(s, farm).food).toBe(3);
    s.settings.difficulty = 'hard';
    expect(buildingOutput(s, farm).food).toBeCloseTo(3.9);
    s.settings.difficulty = 'easy';
    expect(buildingOutput(s, farm).food).toBeCloseTo(2.4);
    const hf = makeTestBuilding(s, 'farm', 'valen', at(2, 2));
    expect(buildingOutput(s, hf).food).toBe(3); // the human is never scaled
  });

  it('faction income: buildings + items/passives − upkeep (leader free, undead half)', () => {
    const { s } = base();
    makeTestBuilding(s, 'farm', 'valen', step(C, 1, 0));
    makeTestUnit(s, 'valen', C, { isLeader: true });
    makeTestUnit(s, 'valen', step(C, -1, 0), { items: ['wand', 'robe'], passives: ['scholar', 'harvester'] });
    makeTestUnit(s, 'valen', step(C, 0, -1));
    const inc = factionIncome(s, 'valen');
    // castle 3g 1f 3r ×2 (the leader works it bare-handed) ×1.1 (leader on it); farm 3 ×1.1;
    // mana 2; research +1; food +1 − 2
    expect(inc.gold).toBeCloseTo(3 * 2 * 1.1);
    expect(inc.food).toBeCloseTo(1 * 2 * 1.1 + 3.3 + 1 - 2);
    expect(inc.mana).toBe(2);
    expect(inc.research).toBeCloseTo(3 * 2 * 1.1 + 1);

    const s2 = makeTestState(10, 8) as GameState;
    s2.factions.ashen = { ...structuredClone(s2.factions.thorn), id: 'ashen' };
    s2.turnOrder.push('ashen');
    makeTestUnit(s2, 'ashen', at(2, 2));
    makeTestUnit(s2, 'ashen', at(3, 2));
    makeTestUnit(s2, 'ashen', at(4, 2), { monster: 'elemental', summonTurns: 5 });
    expect(factionIncome(s2, 'ashen').food).toBe(-1);
  });

  it('applyProduction adds income, starves, clamps mana', () => {
    const { s } = base();
    const u = makeTestUnit(s, 'valen', step(C, 2, 0), { hp: 2 });
    const v = makeTestUnit(s, 'valen', step(C, 2, -1));
    s.factions.valen.resources = res({ food: 0, mana: 99, gold: 10 });
    for (let i = 0; i < 3; i++) makeTestUnit(s, 'valen', step(C, -2, i), { items: ['wand'] });
    const evs = applyProduction(s, 'valen');
    expect(s.factions.valen.resources.gold).toBe(13);
    expect(s.factions.valen.resources.food).toBe(0); // 1 − 5 < 0 → starvation, reset to 0
    expect(u.hp).toBe(1);
    expect(v.hp).toBe(26); // 30 − 4 (starvation)
    expect(evs.filter((e) => e.type === 'unitDamaged' && e.source === 'starvation').length).toBe(5);
    expect(s.factions.valen.resources.mana).toBe(100);
    expect(s.factions.valen.income.food).toBe(1 - 5);
    expect(s.factions.valen.resources.research).toBe(0);
  });
});

describe('captures', () => {
  it('flip buildings, raze castles, ignore walls', () => {
    const { s, castle } = base();
    const house = makeTestBuilding(s, 'house', 'valen', step(C, 1, 0), { buildLeft: 1 });
    const wall = makeTestBuilding(s, 'wall', 'valen', step(C, 0, 1));
    makeTestUnit(s, 'thorn', house.pos);
    makeTestUnit(s, 'thorn', C);
    makeTestUnit(s, 'thorn', wall.pos);
    expect(captureBuildings(s, 'valen')).toEqual([]);
    const evs = captureBuildings(s, 'thorn');
    expect(house.owner).toBe('thorn');
    expect(house.buildLeft).toBe(1);
    expect(evs).toContainEqual({ type: 'buildingCaptured', building: house.id, from: 'valen', to: 'thorn' });
    expect(s.buildings[String(castle.id)]).toBeUndefined();
    expect(s.factions.valen.castleId).toBeNull();
    expect(evs.some((e) => e.type === 'buildingDestroyed' && e.building === castle.id)).toBe(true);
    expect(wall.owner).toBe('valen');
  });

  it('abandoned buildings can be taken by anyone', () => {
    const { s } = base();
    const lib = makeTestBuilding(s, 'library', null, at(10, 9));
    makeTestUnit(s, 'thorn', lib.pos);
    captureBuildings(s, 'thorn');
    expect(lib.owner).toBe('thorn');
  });
});

describe('recruiting', () => {
  it('castle needs the leader; recruit spawns next to it, cannot move, leader gains XP', () => {
    const { s, castle } = base();
    expect(canRecruit(s, castle.id, 'swordsman')).toMatch(/leader/);
    const leader = makeTestUnit(s, 'valen', C, { isLeader: true });
    expect(canRecruit(s, castle.id, 'swordsman')).toBeNull();
    const before = { ...s.factions.valen.resources };
    const evs = recruit(s, castle.id, 'swordsman');
    const sp = evs.find((e) => e.type === 'unitSpawned') as any;
    const u = s.units[String(sp.unit)];
    expect(hexDistance(u.pos, C)).toBe(1);
    expect(u.equipment.main).toBe('sword');
    expect(u.equipment.body).toBe('tunic');
    expect(u.mp).toBe(0);
    expect(u.acted).toBe(true);
    expect(castle.recruitedThisTurn).toBe(true);
    expect(s.factions.valen.resources.gold).toBe(before.gold - 17);
    expect(s.factions.valen.resources.iron).toBe(before.iron - 6);
    expect(leader.xpByCat.leader).toBe(2); // 2 × 1.3 = 2.6: 2 now, the 0.6 carries to the next grant
    expect(leader.xpFrac).toBeCloseTo(0.6);
    expect(canRecruit(s, castle.id, 'archer')).toMatch(/Already recruited/);
  });

  it('a locked preset names every missing research, once each', () => {
    const { s, castle } = base();
    makeTestUnit(s, 'valen', C, { isLeader: true });
    expect(canRecruit(s, castle.id, 'knight')).toBe('Requires research: Shieldcraft, Plate Smithing, Horsemanship');
    expect(canRecruit(s, castle.id, 'apprentice')).toBe('Requires research: Wandcraft, Arcana');
    s.factions.valen.techs.push('tanning', 'shieldcraft', 'mining', 'platesmithing', 'polearms', 'horsemanship');
    expect(canRecruit(s, castle.id, 'knight') ?? '').not.toMatch(/research/);
    s.factions.valen.techs.push('crystallore');
    const tower = makeTestBuilding(s, 'magetower', 'valen', step(C, 3, 0));
    expect(canRecruit(s, tower.id, 'battlemage')).toBe('Requires research: Arcana, Jewelcraft');
  });

  it('spawns on the site hex when free, checks unlocks, site lists and space', () => {
    const { s } = base();
    const house = makeTestBuilding(s, 'house', 'valen', step(C, 4, 0));
    expect(canRecruit(s, house.id, 'swordsman')).toMatch(/cannot train/);
    const evs = recruit(s, house.id, 'builder');
    const sp = evs.find((e) => e.type === 'unitSpawned') as any;
    expect(sp.pos).toEqual(house.pos);
    const tg = makeTestBuilding(s, 'training', 'valen', step(C, -3, 2));
    expect(canRecruit(s, tg.id, 'spearman')).toBe('Requires research: Polearms, Tanning');
    s.factions.valen.techs.push('polearms');
    expect(canRecruit(s, tg.id, 'spearman')).toMatch(/Tanning/);
    s.factions.valen.techs.push('tanning');
    expect(canRecruit(s, tg.id, 'spearman')).toBeNull();
    const site = makeTestBuilding(s, 'house', 'valen', step(C, 0, 4), { buildLeft: 2 });
    expect(canRecruit(s, site.id, 'commoner')).toMatch(/construction/);
    // Fully surrounded: no space.
    const h2 = makeTestBuilding(s, 'house', 'valen', at(11, 9));
    for (const h of spiral(h2.pos, 1)) makeTestUnit(s, 'valen', h);
    expect(canRecruit(s, h2.id, 'commoner')).toMatch(/No free space/);
    s.factions.valen.resources.gold = 1;
    expect(canRecruit(s, tg.id, 'commoner')).toMatch(/Not enough/);
  });

  it('a recruit never appears on (and so never takes) another faction\'s building', () => {
    const { s } = base();
    const house = makeTestBuilding(s, 'house', 'valen', at(10, 8));
    makeTestUnit(s, 'valen', house.pos); // the site hex is taken
    const ns = neighbors(house.pos);
    for (const n of ns.slice(1)) setTerrain(s, n, 'water');
    const farm = makeTestBuilding(s, 'farm', 'thorn', ns[0]);
    expect(canRecruit(s, house.id, 'commoner')).toMatch(/No free space/);
    // An own building next door is fine; the recruit cannot capture on its spawn turn anyway.
    farm.owner = 'valen';
    expect(canRecruit(s, house.id, 'commoner')).toBeNull();
    recruit(s, house.id, 'commoner');
    farm.owner = 'thorn';
    captureBuildings(s, 'valen');
    expect(farm.owner).toBe('thorn');
  });

  it('mounted recruits never spawn on mountains', () => {
    const { s, castle } = base();
    s.factions.valen.techs.push('tanning', 'shieldcraft', 'mining', 'platesmithing', 'polearms', 'horsemanship');
    makeTestUnit(s, 'valen', C, { isLeader: true });
    for (const n of neighbors(C)) setTerrain(s, n, 'mountain');
    expect(canRecruit(s, castle.id, 'knight')).toMatch(/No free space/);
    setTerrain(s, neighbors(C)[3], 'plains');
    const evs = recruit(s, castle.id, 'knight');
    expect((evs[0] as any).pos).toEqual(neighbors(C)[3]);
  });
});

describe('crafting', () => {
  it('forge crafts level + 1 items per turn into the stockpile', () => {
    const { s } = base();
    const forge = makeTestBuilding(s, 'forge', 'valen', step(C, 1, 1));
    expect(canCraft(s, forge.id, 'spear')).toMatch(/Polearms/);
    expect(canCraft(s, forge.id, 'sword')).toBeNull();
    const iron = s.factions.valen.resources.iron;
    craft(s, forge.id, 'sword');
    craft(s, forge.id, 'bow');
    expect(s.factions.valen.stockpile.sword).toBe(1);
    expect(s.factions.valen.stockpile.bow).toBe(1);
    expect(s.factions.valen.resources.iron).toBe(iron - 7);
    expect(canCraft(s, forge.id, 'tunic')).toMatch(/crafted its 2/);
    forge.level = 2;
    expect(canCraft(s, forge.id, 'tunic')).toBeNull();
    const notForge = makeTestBuilding(s, 'house', 'valen', step(C, -1, 1));
    expect(canCraft(s, notForge.id, 'sword')).toMatch(/Not a forge/);
    s.factions.valen.resources.iron = 0;
    expect(canCraft(s, forge.id, 'sword')).toMatch(/Not enough/);
  });
});
