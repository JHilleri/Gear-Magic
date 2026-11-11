import { describe, expect, it, vi } from 'vitest';

// Monster placement belongs to sim/neutral: stub it so these tests cover state setup only.
vi.mock('../src/sim/neutral', () => ({
  spawnInitialMonsters: vi.fn(),
  runNeutralTurn: vi.fn(() => []),
  exploreRuins: vi.fn(() => []),
}));

import { spawnInitialMonsters } from '../src/sim/neutral';
import {
  createGame, getTile, unitAt, buildingAt, getUnit, getBuilding, unitsOf, buildingsOf, faction, currentFaction,
  humanFaction, newId, addLog, isEnemy, cloneState, serialize, deserialize, STARTING_RESOURCES, LOG_CAP, migrateUnitBalance,
} from '../src/sim/state';
import { COMMONER_STATS, LEADER_STATS } from '../src/data/presets';
import { MONSTERS } from '../src/data/factions';
import { at, makeTestState, makeTestUnit } from './helpers';
import { effectiveStats } from '../src/sim/units';
import { buildingUnlocked, itemUnlocked, presetUnlocked } from '../src/sim/research';
import { hexDistance, hexEq, tileIndex } from '../src/core/hex';
import { BUILDINGS } from '../src/data/buildings';
import { FACTIONS } from '../src/data/factions';
import type { GameSettings, GameState, Unit, UnitStats } from '../src/core/types';

const settings = (over: Partial<GameSettings> = {}): GameSettings =>
  ({ mapSize: 'normal', seed: 42, playerFaction: 'valen', aiCount: 2, difficulty: 'normal', ...over });

describe('createGame', () => {
  it('sets up factions, turn order and neutral', () => {
    const s = createGame(settings());
    expect(s.version).toBe(1);
    expect(s.turnOrder).toEqual(['valen', 'thorn', 'ashen']);
    expect(Object.keys(s.factions).sort()).toEqual(['ashen', 'neutral', 'thorn', 'valen']);
    expect(s.factions.valen.isHuman).toBe(true);
    expect(s.factions.thorn.isHuman).toBe(false);
    expect(s.factions.neutral.isHuman).toBe(false);
    expect(s.factions.neutral.alive).toBe(true);
    expect(s.turnOrder).not.toContain('neutral');
    expect(s.currentTurn).toBe(0);
    expect(s.round).toBe(1);
    expect(s.winner).toBeNull();
    expect(s.gameOver).toBe(false);
    expect(currentFaction(s)).toBe('valen');
    expect(humanFaction(s)).toBe('valen');
    expect(s.tiles).toHaveLength(s.width * s.height);
  });

  it('respects the chosen faction and AI count', () => {
    const s = createGame(settings({ playerFaction: 'ashen', aiCount: 1 }));
    expect(s.turnOrder).toEqual(['ashen', 'valen']);
    expect(humanFaction(s)).toBe('ashen');
    expect(s.factions.thorn).toBeUndefined();
    const t = createGame(settings({ playerFaction: 'thorn', aiCount: 5 }));
    expect(t.turnOrder).toEqual(['thorn', 'valen', 'ashen']);
    expect(t.settings.aiCount).toBe(2);
  });

  it('gives every faction the DESIGN §2 opening', () => {
    const s = createGame(settings());
    for (const f of s.turnOrder) {
      const fs = s.factions[f];
      expect(fs.resources).toEqual(STARTING_RESOURCES);
      expect(fs.techs).toEqual(FACTIONS[f].startingTechs ?? []);
      expect(fs.stats.researched).toBe(0);
      expect(fs.researching).toBeNull();
      expect(fs.stockpile).toEqual({});

      const castle = getBuilding(s, fs.castleId!)!;
      expect(castle.type).toBe('castle');
      expect(castle.owner).toBe(f);
      expect(castle.buildLeft).toBe(0);
      const blds = buildingsOf(s, f);
      expect(blds.map((b) => b.type).sort()).toEqual(['castle', 'farm', 'house']);
      for (const b of blds) {
        const tile = getTile(s, b.pos)!;
        expect(tile.building).toBe(b.id);
        expect(BUILDINGS[b.type].terrains).toContain(tile.terrain);
        expect(hexDistance(b.pos, castle.pos)).toBeLessThanOrEqual(2);
        expect(b.level).toBe(1);
      }

      const units = unitsOf(s, f);
      expect(units).toHaveLength(3);
      const leader = getUnit(s, fs.leaderId!)!;
      expect(leader.isLeader).toBe(true);
      expect(leader.level).toBe(2);
      expect(leader.name).toBe(FACTIONS[f].leaderName);
      expect(leader.equipment.main).toBe('sword');
      expect(leader.equipment.body).toBe('tunic');
      expect(hexEq(leader.pos, castle.pos)).toBe(true);
      expect(leader.hp).toBe(effectiveStats(s, leader).maxHp);

      const commoners = units.filter((u) => !u.isLeader);
      expect(commoners.map((u) => u.equipment.main).sort()).toEqual([null, 'tools'].sort());
      expect(new Set(units.map((u) => u.name)).size).toBe(3);
      for (const u of units) {
        expect(u.mp).toBe(effectiveStats(s, u).mov);
        expect(u.acted).toBe(false);
        expect(u.level).toBeGreaterThanOrEqual(1);
        expect(hexDistance(u.pos, castle.pos)).toBeLessThanOrEqual(2);
        const t = getTile(s, u.pos)!.terrain;
        expect(t).not.toBe('water');
        expect(t).not.toBe('mountain');
      }
      // No two units share a hex.
      const occupied = new Set(Object.values(s.units).map((u) => `${u.pos.q},${u.pos.r}`));
      expect(occupied.size).toBe(Object.keys(s.units).length);
      // The opening is visible and explored.
      expect(fs.visible[tileIndex(castle.pos, s.width)]).toBe(1);
      expect(fs.explored.filter((v) => v === 1).length).toBeGreaterThan(30);
      expect(fs.explored).toHaveLength(s.width * s.height);
    }
    expect(spawnInitialMonsters).toHaveBeenCalled();
    const ruinsArg = vi.mocked(spawnInitialMonsters).mock.calls.at(-1)![1];
    expect(ruinsArg.length).toBeGreaterThanOrEqual(6);
    for (const r of ruinsArg) expect(getTile(s, r)!.terrain).toBe('ruins');
  });

  it('each house starts with its signature tech: Valen can raise archers on turn 1', () => {
    const s = createGame(settings());
    expect(s.factions.valen.techs).toEqual(['tanning']);
    expect(s.factions.thorn.techs).toEqual(['polearms']);
    expect(s.factions.ashen.techs).toEqual(['crystallore']);
    expect(presetUnlocked(s, 'valen', 'archer')).toBe(true);
    expect(presetUnlocked(s, 'thorn', 'archer')).toBe(false);
    expect(presetUnlocked(s, 'thorn', 'spearman')).toBe(false); // spear yes, leather needs Tanning
    expect(itemUnlocked(s, 'thorn', 'axe')).toBe(true);
    expect(buildingUnlocked(s, 'ashen', 'crystalmine')).toBe(true);
  });

  it('does not reveal enemy starts to each other', () => {
    const s = createGame(settings());
    const enemyCastle = getBuilding(s, s.factions.thorn.castleId!)!;
    expect(s.factions.valen.visible[tileIndex(enemyCastle.pos, s.width)]).toBe(0);
    expect(s.factions.neutral.visible.every((v) => v === 1)).toBe(true);
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const a = serialize(createGame(settings({ seed: 9 })));
    const b = serialize(createGame(settings({ seed: 9 })));
    expect(a).toBe(b);
    expect(serialize(createGame(settings({ seed: 10 })))).not.toBe(a);
  });

  it('works for every map size, faction and opponent count', () => {
    for (const mapSize of ['small', 'normal', 'large'] as const) {
      for (const playerFaction of ['valen', 'thorn', 'ashen'] as const) {
        for (const aiCount of [1, 2]) {
          const s = createGame(settings({ mapSize, playerFaction, aiCount, seed: aiCount * 13 + mapSize.length }));
          expect(s.turnOrder).toHaveLength(aiCount + 1);
          expect(s.turnOrder[0]).toBe(playerFaction);
          for (const f of s.turnOrder) expect(buildingsOf(s, f)).toHaveLength(3);
        }
      }
    }
  });

  it('integrates with the real neutral spawner', async () => {
    const real = await vi.importActual<typeof import('../src/sim/neutral')>('../src/sim/neutral');
    vi.mocked(spawnInitialMonsters).mockImplementationOnce(real.spawnInitialMonsters);
    const s = createGame(settings({ seed: 5 }));
    const monsters = unitsOf(s, 'neutral');
    expect(monsters.length).toBeGreaterThan(0);
    for (const m of monsters) {
      expect(m.monster).toBeDefined();
      expect(m.mp).toBe(effectiveStats(s, m).mov);
    }
  });
});

describe('queries', () => {
  function game(): GameState { return createGame(settings({ mapSize: 'small', aiCount: 1 })); }

  it('finds tiles, units and buildings by position and id', () => {
    const s = game();
    const leader = getUnit(s, s.factions.valen.leaderId!)!;
    expect(unitAt(s, leader.pos)).toBe(leader);
    expect(buildingAt(s, leader.pos)?.type).toBe('castle');
    expect(getTile(s, { q: -100, r: 0 })).toBeUndefined();
    expect(unitAt(s, { q: -100, r: 0 })).toBeUndefined();
    expect(buildingAt(s, { q: -100, r: 0 })).toBeUndefined();
    expect(getUnit(s, 99999)).toBeUndefined();
    expect(getBuilding(s, 99999)).toBeUndefined();
    leader.hp = 0; // dead units don't occupy hexes
    expect(unitAt(s, leader.pos)).toBeUndefined();
    expect(unitsOf(s, 'valen').includes(leader)).toBe(false);
  });

  it('faction(), ids, hostility', () => {
    const s = game();
    expect(faction(s, 'valen').id).toBe('valen');
    expect(() => faction(s, 'ashen')).toThrow(); // not in a 1-AI game
    const a = newId(s), b = newId(s);
    expect(b).toBe(a + 1);
    expect(isEnemy('valen', 'thorn')).toBe(true);
    expect(isEnemy('valen', 'neutral')).toBe(true);
    expect(isEnemy('neutral', 'neutral')).toBe(false);
    expect(isEnemy('ashen', 'ashen')).toBe(false);
  });

  it('caps the log at 300 entries, keeping the newest', () => {
    const s = game();
    for (let i = 0; i < LOG_CAP + 50; i++) addLog(s, `entry ${i}`, 'info', 'valen');
    expect(s.log).toHaveLength(LOG_CAP);
    expect(s.log.at(-1)!.text).toBe(`entry ${LOG_CAP + 49}`);
    const e = addLog(s, 'x', 'combat');
    expect(e).toEqual({ round: s.round, faction: null, text: 'x', kind: 'combat' });
  });

  it('clones deeply and round-trips through JSON', () => {
    const s = game();
    const c = cloneState(s);
    expect(c).toEqual(s);
    c.units[String(s.factions.valen.leaderId)].hp = 1;
    expect(s.units[String(s.factions.valen.leaderId)].hp).not.toBe(1);
    const r = deserialize(serialize(s));
    expect(r).toEqual(s);
  });

  it('rejects malformed saves and back-fills missing arrays', () => {
    expect(() => deserialize('not json')).toThrow();
    expect(() => deserialize('{"version":2}')).toThrow(/version/);
    expect(() => deserialize('{"version":1}')).toThrow();
    const s = game();
    const raw = JSON.parse(serialize(s));
    delete raw.factions.valen.farsight;
    raw.factions.valen.visible = [];
    const r = deserialize(JSON.stringify(raw));
    expect(r.factions.valen.farsight).toEqual([]);
    expect(r.factions.valen.visible).toHaveLength(s.width * s.height);
  });
});

describe('save migration: the block stat', () => {
  /** Turn `u` into a unit from a save made before block existed: no block on its base. */
  const preBlock = (u: Unit, base: Omit<UnitStats, 'block'>, hp: number): Unit => {
    u.base = { ...base } as UnitStats;
    u.hp = hp;
    return u;
  };

  it('gives an old commoner the new base hit points, keeping its wounds', () => {
    const s = makeTestState();
    const u = preBlock(makeTestUnit(s, 'valen', at(1, 1)), { maxHp: 22, str: 4, dex: 4, int: 3, armor: 0, mov: 5, vis: 4 }, 15);
    migrateUnitBalance(u);
    expect(u.base).toEqual(COMMONER_STATS); // maxHp 22 → 30, block 0
    expect(u.hp).toBe(23); // 15 + 8: the wound stays the same size
    migrateUnitBalance(u); // already on the current numbers: left alone
    expect(u.base.maxHp).toBe(30);
    expect(u.hp).toBe(23);
  });

  it('leaders, the Thornwild\'s +5 HP, reworked level picks and monsters', () => {
    const s = makeTestState();
    // An old thorn leader: 34 + 4 (house) + 4 (level 2) + 6 (+Max HP pick) hp; armor 10 + 6 (+Armor pick).
    const leader = preBlock(makeTestUnit(s, 'thorn', at(1, 1), {
      isLeader: true, level: 3, learned: [{ level: 2, option: 'stat_hp' }, { level: 3, option: 'stat_armor' }],
    }), { maxHp: 34 + 4 + 4 + 6, str: 7, dex: 5, int: 4, armor: 16, mov: 5, vis: 5 }, 40);
    migrateUnitBalance(leader);
    // 46 + 5 (house) + 4 (level) + 8 (pick); armor 10 + 5 and block 1 + 1.
    expect(leader.base).toMatchObject({ maxHp: 46 + 5 + 4 + 8, armor: 15, block: LEADER_STATS.block + 1 });
    expect(leader.hp).toBe(40 + 15);
    // An old golem: 48 hp, 30 armor → 64, 20 armor, 3 block.
    const golem = preBlock(makeTestUnit(s, 'neutral', at(3, 3), { monster: 'golem', race: 'monster' }),
      { maxHp: 48, str: 8, dex: 0, int: 0, armor: 30, mov: 3, vis: 3 }, 10);
    migrateUnitBalance(golem);
    expect(golem.base).toEqual(MONSTERS.golem.stats);
    expect(golem.hp).toBe(26);
  });

  it('deserialize grants the levels an old save\'s XP already pays for under the lower thresholds', () => {
    const s = makeTestState();
    // Saved at level 2 with 45 XP: short of the old 25 + 15 × 2 = 55, past the new 20 + 10 × 2 = 40.
    const u = preBlock(makeTestUnit(s, 'valen', at(1, 1), { level: 2, xp: 45 }), { maxHp: 26, str: 4, dex: 4, int: 3, armor: 0, mov: 5, vis: 4 }, 26);
    u.levelXpByCat.melee = 45;
    const fresh = makeTestUnit(s, 'valen', at(2, 2), { level: 2, xp: 45 }); // already on the new numbers: left alone
    const r = deserialize(serialize(s));
    const v = r.units[String(u.id)];
    expect(v.level).toBe(3);
    expect(v.xp).toBe(5);
    expect(v.pendingLevelUps).toBe(1);
    expect(v.levelUpOptions).toHaveLength(1);
    expect(v.levelUpOptions[0]).toHaveLength(3);
    expect(v.base.maxHp).toBe(30 + 4 + 4); // new base (level 2 kept) + the new level's 4
    expect(v.levelXpByCat.melee).toBe(5); // the overflow starts the next level's tally
    const f = r.units[String(fresh.id)];
    expect([f.level, f.xp, f.pendingLevelUps]).toEqual([2, 45, 0]);
  });

  it('deserialize brings old units up to date', () => {
    const s = makeTestState();
    const u = preBlock(makeTestUnit(s, 'valen', at(1, 1)), { maxHp: 22, str: 4, dex: 4, int: 3, armor: 0, mov: 5, vis: 4 }, 22);
    const r = deserialize(serialize(s));
    expect(r.units[String(u.id)].base).toEqual(COMMONER_STATS);
    expect(r.units[String(u.id)].hp).toBe(30);
  });
});
