import { describe, expect, it } from 'vitest';
import { makeTestState, makeTestUnit, setTerrain, at } from './helpers';
import { moveCost, inEnemyZoc, reachable, findPath, pathTowards, truncatePathToMp, pathCost } from '../src/sim/pathfinding';
import { hexDistance, hexEq, hexKey, neighbors, tileIndex } from '../src/core/hex';
import { createUnit } from '../src/sim/units';
import type { GameState, Hex, Unit } from '../src/core/types';
import { generateMap } from '../src/sim/mapgen';

const keyset = (hs: Hex[]) => new Set(hs.map(hexKey));

/** Path validity: contiguous steps from `from`, each in bounds. */
function expectContiguous(from: Hex, path: Hex[]): void {
  let prev = from;
  for (const h of path) {
    expect(hexDistance(prev, h)).toBe(1);
    prev = h;
  }
}

describe('moveCost', () => {
  it('uses terrain costs and bounds', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(5, 5));
    setTerrain(s, at(1, 1), 'forest');
    setTerrain(s, at(2, 1), 'hills');
    setTerrain(s, at(3, 1), 'mountain');
    setTerrain(s, at(4, 1), 'swamp');
    setTerrain(s, at(5, 1), 'shallows');
    setTerrain(s, at(6, 1), 'water');
    expect(moveCost(s, u, at(0, 0))).toBe(1);
    expect(moveCost(s, u, at(1, 1))).toBe(2);
    expect(moveCost(s, u, at(2, 1))).toBe(2);
    expect(moveCost(s, u, at(3, 1))).toBe(3);
    expect(moveCost(s, u, at(4, 1))).toBe(3);
    expect(moveCost(s, u, at(5, 1))).toBe(3);
    expect(moveCost(s, u, at(6, 1))).toBe(Infinity);
    expect(moveCost(s, u, { q: -20, r: 3 })).toBe(Infinity);
    expect(moveCost(s, u, { q: 0, r: 99 })).toBe(Infinity);
  });

  it('applies mount rules and pathfinder', () => {
    const s = makeTestState();
    const k = makeTestUnit(s, 'valen', at(5, 5), { items: ['horse'] });
    setTerrain(s, at(1, 1), 'forest');
    setTerrain(s, at(2, 1), 'hills');
    setTerrain(s, at(3, 1), 'mountain');
    setTerrain(s, at(4, 1), 'swamp');
    expect(moveCost(s, k, at(1, 1))).toBe(3);
    expect(moveCost(s, k, at(2, 1))).toBe(2);
    expect(moveCost(s, k, at(3, 1))).toBe(Infinity);
    expect(moveCost(s, k, at(4, 1))).toBe(4);
    const p = makeTestUnit(s, 'valen', at(6, 5), { passives: ['pathfinder'] });
    expect(moveCost(s, p, at(1, 1))).toBe(1);
    expect(moveCost(s, p, at(2, 1))).toBe(1);
    expect(moveCost(s, p, at(3, 1))).toBe(3);
    k.passives.push('pathfinder');
    expect(moveCost(s, k, at(1, 1))).toBe(2); // pathfinder 1 + rider in the woods
  });
});

describe('reachable', () => {
  it('floods open ground up to mp', () => {
    const s = makeTestState(20, 20);
    const u = makeTestUnit(s, 'valen', at(10, 10), { mp: 3 });
    const r = reachable(s, u);
    // 3 rings around the unit: 6 + 12 + 18
    expect(r).toHaveLength(36);
    for (const info of r) {
      expect(info.cost).toBe(hexDistance(u.pos, info.hex));
      expect(info.mpLeft).toBe(3 - info.cost);
      expect(info.path).toHaveLength(info.cost);
      expect(hexEq(info.path[info.path.length - 1], info.hex)).toBe(true);
      expectContiguous(u.pos, info.path);
      expect(info.zocStop).toBe(false);
    }
    expect(r.some((x) => hexEq(x.hex, u.pos))).toBe(false);
  });

  it('returns nothing with no movement left', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(5, 5), { mp: 0 });
    expect(reachable(s, u)).toEqual([]);
    expect(findPath(s, u, at(5, 6))).toBeNull();
  });

  it('routes around water and pays terrain costs', () => {
    const s = makeTestState(12, 10);
    const u = makeTestUnit(s, 'valen', at(2, 5), { mp: 4 });
    // A wall of water with no gap in reach.
    for (let row = 0; row < 10; row++) setTerrain(s, at(4, row), 'water');
    const r = reachable(s, u);
    for (const info of r) {
      expect(s.tiles[tileIndex(info.hex, s.width)].terrain).not.toBe('water');
      expect(info.path.every((h) => s.tiles[tileIndex(h, s.width)].terrain !== 'water')).toBe(true);
    }
    expect(r.some((x) => hexEq(x.hex, at(5, 5)))).toBe(false);
    setTerrain(s, at(3, 5), 'forest');
    const f = findPath(s, u, at(3, 5));
    expect(f).toEqual([at(3, 5)]);
    expect(reachable(s, u).find((x) => hexEq(x.hex, at(3, 5)))?.cost).toBe(2);
  });

  it('passes through allies but never ends on them', () => {
    const s = makeTestState(12, 3);
    const u = makeTestUnit(s, 'valen', at(1, 1), { mp: 3 });
    // Corridor: row 1 only.
    for (let col = 0; col < 12; col++) { setTerrain(s, at(col, 0), 'water'); setTerrain(s, at(col, 2), 'water'); }
    makeTestUnit(s, 'valen', at(2, 1));
    const r = reachable(s, u);
    expect(r.some((x) => hexEq(x.hex, at(2, 1)))).toBe(false);
    const far = r.find((x) => hexEq(x.hex, at(4, 1)));
    expect(far?.cost).toBe(3);
    expect(far?.path).toEqual([at(2, 1), at(3, 1), at(4, 1)]);
    expect(findPath(s, u, at(2, 1))).toBeNull();
  });

  it('enemies block their hex and their ZOC ends movement', () => {
    const s = makeTestState(14, 14);
    const u = makeTestUnit(s, 'valen', at(3, 7), { mp: 5 });
    const e = makeTestUnit(s, 'thorn', at(6, 7));
    const r = reachable(s, u);
    expect(r.some((x) => hexEq(x.hex, e.pos))).toBe(false);
    const zocHexes = keyset(neighbors(e.pos));
    for (const info of r) {
      const inZoc = zocHexes.has(hexKey(info.hex));
      expect(info.zocStop).toBe(inZoc);
      if (inZoc) expect(info.mpLeft).toBe(0);
      // No path passes *through* a ZOC hex.
      for (const h of info.path.slice(0, -1)) expect(zocHexes.has(hexKey(h))).toBe(false);
    }
    // The hex directly behind the enemy needs a detour around the ZOC (cost > straight 4).
    const behind = r.find((x) => hexEq(x.hex, at(7, 7)));
    expect(behind === undefined || behind.cost > 4).toBe(true);
    expect(inEnemyZoc(s, u, at(5, 7))).toBe(true);
    expect(inEnemyZoc(s, u, at(3, 7))).toBe(false);
  });

  it('ZOC applies to neutral monsters, not to skirmishers', () => {
    const s = makeTestState(14, 14);
    const u = makeTestUnit(s, 'valen', at(3, 7), { mp: 5 });
    createUnit(s, { faction: 'neutral', pos: at(5, 7), monster: 'wolf' });
    expect(inEnemyZoc(s, u, at(4, 7))).toBe(true);
    expect(reachable(s, u).find((x) => hexEq(x.hex, at(4, 7)))?.zocStop).toBe(true);
    u.passives.push('skirmisher');
    expect(inEnemyZoc(s, u, at(4, 7))).toBe(false);
    const r = reachable(s, u);
    expect(r.every((x) => !x.zocStop)).toBe(true);
    expect(r.find((x) => hexEq(x.hex, at(6, 7)))).toBeDefined();
  });

  it('starting inside an enemy ZOC still allows leaving it', () => {
    const s = makeTestState(12, 12);
    const u = makeTestUnit(s, 'valen', at(5, 5), { mp: 3 });
    makeTestUnit(s, 'thorn', at(6, 5));
    const away = reachable(s, u).find((x) => hexEq(x.hex, at(3, 5)));
    expect(away?.cost).toBe(2);
    expect(away?.zocStop).toBe(false);
  });

  it('ignores enemies hidden in fog (actions.move handles the ambush)', () => {
    const s = makeTestState(14, 14);
    const u = makeTestUnit(s, 'valen', at(3, 7), { mp: 5 });
    const e = makeTestUnit(s, 'thorn', at(5, 7));
    s.factions.valen.visible[tileIndex(e.pos, s.width)] = 0;
    const r = reachable(s, u);
    expect(r.some((x) => hexEq(x.hex, e.pos))).toBe(true);
    expect(r.every((x) => !x.zocStop)).toBe(true);
    // Omniscient queries (AI planning, validation) see everything.
    const o = reachable(s, u, { omniscient: true });
    expect(o.some((x) => hexEq(x.hex, e.pos))).toBe(false);
    // Neutral monsters are never fog-limited.
    const w = createUnit(s, { faction: 'neutral', pos: at(9, 7), monster: 'wolf' });
    s.factions.neutral.visible = new Array(s.width * s.height).fill(0);
    expect(reachable(s, w).some((x) => hexEq(x.hex, e.pos))).toBe(false);
  });

  it('matches findPath for every reachable hex', () => {
    const m = generateMap({ mapSize: 'normal', seed: 3, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' }, 3);
    const s = makeTestState(m.width, m.height);
    s.tiles = m.tiles;
    const u = makeTestUnit(s, 'valen', m.starts[0], { mp: 7 });
    makeTestUnit(s, 'thorn', m.starts[1]);
    for (const info of reachable(s, u)) {
      const p = findPath(s, u, info.hex);
      expect(p).not.toBeNull();
      expect(pathCost(s, u, p!)).toBe(info.cost);
    }
  });

  it('is fast enough for hover (< 1 ms on a normal map)', () => {
    const m = generateMap({ mapSize: 'normal', seed: 9, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' }, 3);
    const s = makeTestState(m.width, m.height);
    s.tiles = m.tiles;
    const u = makeTestUnit(s, 'valen', m.starts[0], { mp: 8, items: ['horse'] });
    // A busy board: 40 units scattered around.
    for (let i = 0; i < 40; i++) {
      const h = { q: (i * 7) % 30 - 5, r: (i * 5) % 26 };
      if (!hexEq(h, u.pos)) makeTestUnit(s, i % 2 ? 'thorn' : 'valen', h);
    }
    for (let i = 0; i < 50; i++) reachable(s, u); // warm up the JIT
    const t0 = performance.now();
    const N = 300;
    for (let i = 0; i < N; i++) reachable(s, u);
    expect((performance.now() - t0) / N).toBeLessThan(1);
  });
});

describe('pathTowards', () => {
  function bigState(): GameState {
    const s = makeTestState(30, 20);
    // A mountain ridge with a single pass at row 15.
    for (let row = 0; row < 20; row++) if (row !== 15) setTerrain(s, at(15, row), 'mountain');
    for (let row = 0; row < 20; row++) if (row < 4) setTerrain(s, at(15, row), 'water');
    return s;
  }

  it('finds multi-turn paths through costly terrain', () => {
    const s = bigState();
    const u = makeTestUnit(s, 'valen', at(2, 5), { mp: 0 });
    const p = pathTowards(s, u, at(27, 5));
    expect(p).not.toBeNull();
    expectContiguous(u.pos, p!);
    expect(hexEq(p![p!.length - 1], at(27, 5))).toBe(true);
    expect(p!.every((h) => s.tiles[tileIndex(h, s.width)].terrain !== 'water')).toBe(true);
  });

  it('respects mount rules (riders take the pass)', () => {
    const s = bigState();
    const k = makeTestUnit(s, 'valen', at(2, 5), { items: ['horse'] });
    const p = pathTowards(s, k, at(27, 5))!;
    expect(p).not.toBeNull();
    expect(p.some((h) => hexEq(h, at(15, 15)))).toBe(true);
    expect(p.every((h) => s.tiles[tileIndex(h, s.width)].terrain !== 'mountain')).toBe(true);
  });

  it('avoids enemy units except on the goal, ignores allies', () => {
    const s = makeTestState(12, 3);
    for (let col = 0; col < 12; col++) { setTerrain(s, at(col, 0), 'water'); setTerrain(s, at(col, 2), 'water'); }
    const u = makeTestUnit(s, 'valen', at(1, 1));
    makeTestUnit(s, 'valen', at(3, 1));
    expect(pathTowards(s, u, at(8, 1))).toHaveLength(7);
    const e = makeTestUnit(s, 'thorn', at(8, 1));
    expect(pathTowards(s, u, at(8, 1))).toHaveLength(7); // goal may be occupied
    expect(pathTowards(s, u, at(10, 1))).toBeNull();       // blocked corridor
    expect(pathTowards(s, u, u.pos)).toEqual([]);
    void e;
  });

  it('ends next to an impassable goal and honours maxNodes', () => {
    const s = makeTestState(14, 14);
    setTerrain(s, at(10, 7), 'mountain');
    const k = makeTestUnit(s, 'valen', at(2, 7), { items: ['horse'] });
    const p = pathTowards(s, k, at(10, 7))!;
    expect(hexDistance(p[p.length - 1], at(10, 7))).toBe(1);
    expect(pathTowards(s, k, at(12, 12), 3)).toBeNull();
  });
});

describe('truncatePathToMp', () => {
  it('cuts a long path at the last legal stop for this turn', () => {
    const s = makeTestState(20, 5);
    const u = makeTestUnit(s, 'valen', at(1, 2), { mp: 4 });
    const full = pathTowards(s, u, at(15, 2))!;
    const part = truncatePathToMp(s, u, full);
    expect(part.length).toBe(4);
    makeTestUnit(s, 'valen', at(5, 2)); // ally on the 4th step: stop one earlier
    const p2 = pathTowards(s, u, at(15, 2))!;
    const t2 = truncatePathToMp(s, u, p2);
    expect(t2.length).toBeLessThanOrEqual(4);
    expect(t2.some((h) => hexEq(h, at(5, 2)) && t2[t2.length - 1] === h)).toBe(false);
    // Enemy ZOC stops the walk.
    const s3 = makeTestState(20, 5);
    const v = makeTestUnit(s3, 'valen', at(1, 2), { mp: 6 }) as Unit;
    makeTestUnit(s3, 'thorn', at(5, 1));
    const p3 = pathTowards(s3, v, at(10, 2))!;
    const t3 = truncatePathToMp(s3, v, p3);
    expect(t3.length).toBeLessThan(6);
    expect(hexDistance(t3[t3.length - 1], at(5, 1))).toBe(1);
  });
});
