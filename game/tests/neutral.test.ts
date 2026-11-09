import { describe, expect, it } from 'vitest';
import type { GameEvent, Hex } from '../src/core/types';
import { hexDistance, tileIndex } from '../src/core/hex';
import { exploreRuins, runNeutralTurn, spawnInitialMonsters } from '../src/sim/neutral';
import { createGame, currentFaction } from '../src/sim/state';
import { applyAction } from '../src/sim/actions';
import { startTurn } from '../src/sim/turn';
import { at, makeTestBuilding, makeTestState, makeTestUnit, setTerrain } from './helpers';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });
const monsters = (s: ReturnType<typeof makeTestState>) => Object.values(s.units).filter((u) => u.faction === 'neutral');

describe('spawnInitialMonsters', () => {
  it('guards ruins with packs sized by remoteness, never near a start', () => {
    const s = makeTestState(30, 20);
    const start = at(2, 2);
    makeTestBuilding(s, 'castle', 'valen', start);
    makeTestUnit(s, 'valen', start, { isLeader: true });
    const near = at(6, 3);   // close to the start
    const mid = at(13, 3);
    const far = at(26, 17);
    for (const r of [near, mid, far]) setTerrain(s, r, 'ruins');
    spawnInitialMonsters(s, [near, mid, far]);
    const ms = monsters(s);
    for (const m of ms) {
      expect(m.monster).toBeDefined();
      expect(hexDistance(m.pos, start)).toBeGreaterThan(5);
      expect(m.home).toBeDefined();
      expect(hexDistance(m.pos, m.home!)).toBeLessThanOrEqual(2);
      expect(hexDistance(m.pos, m.home!)).toBeGreaterThanOrEqual(1);
    }
    const byHome = (h: Hex) => ms.filter((m) => hexDistance(m.home!, h) === 0);
    expect(byHome(far).length).toBe(3);
    expect(byHome(far).some((m) => m.monster === 'golem')).toBe(true);
    expect(byHome(mid).length).toBeGreaterThanOrEqual(1);
    expect(byHome(mid).length).toBeLessThanOrEqual(2);
    // No two monsters share a hex.
    expect(new Set(ms.map((m) => `${m.pos.q},${m.pos.r}`)).size).toBe(ms.length);
  });

  it('is deterministic for the same RNG state', () => {
    const mk = () => {
      const s = makeTestState(30, 20);
      const ruins = [at(15, 10), at(25, 4)];
      for (const r of ruins) setTerrain(s, r, 'ruins');
      spawnInitialMonsters(s, ruins);
      return JSON.stringify(s.units);
    };
    expect(mk()).toBe(mk());
  });
});

describe('runNeutralTurn', () => {
  it('monsters attack an adjacent intruder', () => {
    const s = makeTestState(16, 12);
    const ruin = at(8, 6);
    setTerrain(s, ruin, 'ruins');
    const wolf = makeTestUnit(s, 'neutral', off(ruin, 1), { monster: 'wolf', home: ruin, race: 'monster' });
    const victim = makeTestUnit(s, 'valen', off(ruin, 2), { hp: 10 });
    const evs = runNeutralTurn(s);
    const c = evs.find((e) => e.type === 'combat') as Extract<GameEvent, { type: 'combat' }>;
    expect(c).toBeDefined();
    expect(c.attacker).toBe(wolf.id);
    expect(c.defender).toBe(victim.id);
  });

  it('monsters close in on intruders near their lair and attack from reach', () => {
    const s = makeTestState(16, 12);
    const ruin = at(8, 6);
    const wolf = makeTestUnit(s, 'neutral', ruin, { monster: 'wolf', home: ruin, race: 'monster', base: { maxHp: 20, str: 4, dex: 2, int: 0, armor: 0, mov: 7, vis: 5 } });
    makeTestUnit(s, 'valen', off(ruin, 3), { hp: 8 });
    const evs = runNeutralTurn(s);
    expect(evs.some((e) => e.type === 'unitMoved' && e.unit === wolf.id)).toBe(true);
    expect(evs.some((e) => e.type === 'combat' && e.attacker === wolf.id)).toBe(true);
  });

  it('ignores troops far from the lair and stays within its guard area', () => {
    const s = makeTestState(24, 16);
    const ruin = at(5, 8);
    const wolf = makeTestUnit(s, 'neutral', off(ruin, 1), { monster: 'wolf', home: ruin, race: 'monster' });
    makeTestUnit(s, 'valen', off(ruin, 12), { hp: 1 });
    for (let i = 0; i < 20; i++) {
      s.round = 1 + i;
      const evs = runNeutralTurn(s);
      expect(evs.some((e) => e.type === 'combat')).toBe(false);
      expect(hexDistance(wolf.pos, ruin)).toBeLessThanOrEqual(3);
    }
  });

  it('never raids inside a castle sanctuary (3 hexes): castle territory is safe', () => {
    const s = makeTestState(24, 16);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(6, 8));
    const ruin = off(castle.pos, 6);
    setTerrain(s, ruin, 'ruins');
    const wolf = makeTestUnit(s, 'neutral', off(ruin, -1), {
      monster: 'wolf', home: ruin, race: 'monster', base: { maxHp: 20, str: 4, dex: 2, int: 0, armor: 0, mov: 7, vis: 5 },
    });
    const worker = makeTestUnit(s, 'valen', off(castle.pos, 1), { hp: 4 });
    for (let i = 0; i < 6; i++) {
      s.round = 10 + i;
      const evs = runNeutralTurn(s);
      expect(evs.some((e) => e.type === 'combat' && e.defender === worker.id)).toBe(false);
      expect(hexDistance(wolf.pos, castle.pos)).toBeGreaterThan(3);
    }
    // Just outside the sanctuary, next to the lair, is fair game.
    const scout = makeTestUnit(s, 'valen', off(ruin, 1), { hp: 4 });
    const evs = runNeutralTurn(s);
    expect(evs.some((e) => e.type === 'combat' && e.defender === scout.id)).toBe(true);
  });

  it('in rounds 1-3 monsters only defend their lair', () => {
    const s = makeTestState(24, 16);
    const ruin = at(12, 8);
    const wolf = makeTestUnit(s, 'neutral', ruin, {
      monster: 'wolf', home: ruin, race: 'monster', base: { maxHp: 20, str: 4, dex: 2, int: 0, armor: 0, mov: 7, vis: 5 },
    });
    // 5 hexes out: reachable from the leash edge, but outside the lair's guard area.
    const worker = makeTestUnit(s, 'valen', off(ruin, 5), { hp: 4 });
    for (let r = 1; r <= 3; r++) {
      s.round = r;
      expect(runNeutralTurn(s).some((e) => e.type === 'combat')).toBe(false);
      expect(hexDistance(wolf.pos, ruin)).toBeLessThanOrEqual(4);
    }
    s.round = 5;
    wolf.pos = { ...ruin };
    expect(runNeutralTurn(s).some((e) => e.type === 'combat' && e.defender === worker.id)).toBe(true);
  });

  it('a monster dragged far from home walks back', () => {
    const s = makeTestState(24, 16);
    const ruin = at(5, 8);
    const wolf = makeTestUnit(s, 'neutral', off(ruin, 8), { monster: 'wolf', home: ruin, race: 'monster' });
    const d0 = hexDistance(wolf.pos, ruin);
    runNeutralTurn(s);
    expect(hexDistance(wolf.pos, ruin)).toBeLessThan(d0);
  });

  it('monsters regenerate and refresh their movement', () => {
    const s = makeTestState(16, 12);
    const golem = makeTestUnit(s, 'neutral', at(8, 6), { monster: 'golem', home: at(8, 6), race: 'monster', passives: ['regeneration'], hp: 10, mp: 0 });
    runNeutralTurn(s);
    expect(golem.hp).toBeGreaterThanOrEqual(14);
  });

  it('respawns at unguarded ruins every 12 rounds', () => {
    const s = makeTestState(20, 14);
    const ruin = at(10, 7);
    setTerrain(s, ruin, 'ruins');
    s.round = 11;
    runNeutralTurn(s);
    expect(monsters(s).length).toBe(0);
    s.round = 12;
    const evs = runNeutralTurn(s);
    expect(monsters(s).length).toBe(1);
    expect(evs.some((e) => e.type === 'unitSpawned' && e.reason === 'monster')).toBe(true);
    // Troops camping by the ruins prevent respawns.
    const s2 = makeTestState(20, 14);
    setTerrain(s2, ruin, 'ruins');
    makeTestUnit(s2, 'valen', off(ruin, 2));
    s2.round = 24;
    runNeutralTurn(s2);
    expect(monsters(s2).length).toBe(0);
  });
});

describe('exploreRuins', () => {
  it('rewards the first visitor once', () => {
    const s = makeTestState();
    const ruin = at(5, 5);
    setTerrain(s, ruin, 'ruins');
    const u = makeTestUnit(s, 'valen', ruin);
    const before = JSON.stringify(s.factions.valen.resources) + JSON.stringify(s.factions.valen.stockpile);
    const evs = exploreRuins(s, u.id);
    const ev = evs.find((e) => e.type === 'ruinsExplored') as Extract<GameEvent, { type: 'ruinsExplored' }>;
    expect(ev).toBeDefined();
    expect(ev.reward.length).toBeGreaterThan(0);
    expect(s.tiles[tileIndex(ruin, s.width)].ruinsLooted).toBe(true);
    expect(u.xpByCat.explore).toBe(12);
    const after = JSON.stringify(s.factions.valen.resources) + JSON.stringify(s.factions.valen.stockpile);
    const researchGain = s.factions.valen.researchProgress > 0;
    expect(after !== before || researchGain).toBe(true);
    expect(exploreRuins(s, u.id)).toEqual([]);
  });

  it('rewards vary with the RNG and cover every outcome', () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const s = makeTestState();
      s.rngState = i * 7777 + 3;
      const ruin = at(5, 5);
      setTerrain(s, ruin, 'ruins');
      const u = makeTestUnit(s, 'valen', ruin);
      const ev = exploreRuins(s, u.id).find((e) => e.type === 'ruinsExplored') as Extract<GameEvent, { type: 'ruinsExplored' }>;
      kinds.add(ev.reward.includes('gold') ? 'gold' : ev.reward.includes('wood') ? 'res' : ev.reward.includes('stockpile') ? 'item' : 'other');
    }
    expect(kinds.size).toBe(4);
  });

  it('monsters and plain tiles do nothing', () => {
    const s = makeTestState();
    const ruin = at(5, 5);
    setTerrain(s, ruin, 'ruins');
    const m = makeTestUnit(s, 'neutral', ruin, { monster: 'wolf', race: 'monster' });
    expect(exploreRuins(s, m.id)).toEqual([]);
    const u = makeTestUnit(s, 'valen', at(2, 2));
    expect(exploreRuins(s, u.id)).toEqual([]);
  });
});

describe('starting bases are safe from monsters', () => {
  it('no monster strikes a unit within 2 hexes of its own castle in rounds 1-3 (seeds 1-20)', () => {
    let attacksNearHome = 0;
    let games = 0;
    for (const mapSize of ['small', 'normal'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const st = createGame({ mapSize, seed, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });
        startTurn(st, st.turnOrder[st.currentTurn]);
        games++;
        while (st.round <= 3 && !st.gameOver) {
          const f = currentFaction(st);
          const r = applyAction(st, { type: 'endTurn', faction: f });
          for (const e of r.events) {
            if (e.type !== 'combat' || st.units[String(e.attacker)]?.faction !== 'neutral') continue;
            const v = st.units[String(e.defender)];
            const fs = v ? st.factions[v.faction] : undefined;
            const c = fs?.castleId != null ? st.buildings[String(fs.castleId)] : undefined;
            if (v && c && hexDistance(v.pos, c.pos) <= 2) attacksNearHome++;
          }
        }
      }
    }
    expect(games).toBe(40);
    expect(attacksNearHome).toBe(0);
  });
});
