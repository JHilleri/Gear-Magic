import { describe, expect, it } from 'vitest';
import { makeTestState, makeTestUnit, makeTestBuilding, setTerrain, at } from './helpers';
import { computeVisibility, computeAllVisibility, isVisible, isExplored } from '../src/sim/visibility';
import { hexDistance, indexToHex, tileIndex } from '../src/core/hex';
import type { GameState, Hex } from '../src/core/types';
import { COMMONER_STATS } from '../src/data/presets';

function fogged(w = 20, h = 20): GameState {
  const s = makeTestState(w, h);
  for (const f of Object.values(s.factions)) {
    f.explored = new Array(w * h).fill(0);
    f.visible = new Array(w * h).fill(0);
  }
  return s;
}

const visibleSet = (s: GameState, f: 'valen' | 'thorn') =>
  s.factions[f].visible.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

/** Every tile within `r` of `c` (and nothing else among `idx`). */
function expectDisc(s: GameState, idx: number[], centers: { c: Hex; r: number }[]): void {
  const want = new Set<number>();
  for (let i = 0; i < s.width * s.height; i++) {
    const h = indexToHex(i, s.width);
    if (centers.some(({ c, r }) => hexDistance(c, h) <= r)) want.add(i);
  }
  expect(new Set(idx)).toEqual(want);
}

describe('computeVisibility', () => {
  it('reveals a disc of the unit vision radius and ORs into explored', () => {
    const s = fogged();
    const u = makeTestUnit(s, 'valen', at(10, 10));
    const fresh = computeVisibility(s, 'valen');
    const vis = visibleSet(s, 'valen');
    expectDisc(s, vis, [{ c: u.pos, r: COMMONER_STATS.vis }]);
    expect(fresh).toBe(vis.length);
    expect(computeVisibility(s, 'valen')).toBe(0); // nothing new the second time
    // Move away: old area stays explored but is no longer visible.
    u.pos = at(3, 3);
    const fresh2 = computeVisibility(s, 'valen');
    expect(fresh2).toBeGreaterThan(0);
    expect(isVisible(s, 'valen', at(10, 10))).toBe(false);
    expect(isExplored(s, 'valen', at(10, 10))).toBe(true);
    expect(isVisible(s, 'valen', at(3, 3))).toBe(true);
    expect(s.factions.valen.visible).toHaveLength(s.width * s.height);
    expect(s.factions.valen.explored.every((v) => v === 0 || v === 1)).toBe(true);
  });

  it('hills and mountains extend sight by one', () => {
    const s = fogged();
    const u = makeTestUnit(s, 'valen', at(10, 10));
    setTerrain(s, u.pos, 'hills');
    computeVisibility(s, 'valen');
    expectDisc(s, visibleSet(s, 'valen'), [{ c: u.pos, r: COMMONER_STATS.vis + 1 }]);
    setTerrain(s, u.pos, 'mountain');
    computeVisibility(s, 'valen');
    expectDisc(s, visibleSet(s, 'valen'), [{ c: u.pos, r: COMMONER_STATS.vis + 1 }]);
  });

  it('buildings see radius 2; finished watchtowers add their bonus', () => {
    const s = fogged(24, 24);
    makeTestBuilding(s, 'farm', 'valen', at(4, 4));
    const t = makeTestBuilding(s, 'watchtower', 'valen', at(15, 15), { buildLeft: 2 });
    computeVisibility(s, 'valen');
    expectDisc(s, visibleSet(s, 'valen'), [{ c: at(4, 4), r: 2 }, { c: t.pos, r: 2 }]);
    t.buildLeft = 0;
    computeVisibility(s, 'valen');
    expectDisc(s, visibleSet(s, 'valen'), [{ c: at(4, 4), r: 2 }, { c: t.pos, r: 5 }]);
    // Abandoned / enemy buildings don't count.
    makeTestBuilding(s, 'house', null, at(20, 4));
    makeTestBuilding(s, 'house', 'thorn', at(20, 10));
    computeVisibility(s, 'valen');
    expect(isVisible(s, 'valen', at(20, 4))).toBe(false);
    expect(isVisible(s, 'valen', at(20, 10))).toBe(false);
  });

  it('includes active farsight areas only', () => {
    const s = fogged();
    s.factions.valen.farsight = [{ hex: at(15, 15), turns: 2 }, { hex: at(3, 3), turns: 0 }];
    computeVisibility(s, 'valen');
    expectDisc(s, visibleSet(s, 'valen'), [{ c: at(15, 15), r: 4 }]);
  });

  it('uses effective vision (items/levels) and ignores other factions', () => {
    const s = fogged();
    const u = makeTestUnit(s, 'valen', at(10, 10), { base: { ...COMMONER_STATS, vis: 2 } });
    makeTestUnit(s, 'thorn', at(2, 2));
    computeVisibility(s, 'valen');
    expectDisc(s, visibleSet(s, 'valen'), [{ c: u.pos, r: 2 }]);
    expect(isVisible(s, 'thorn', at(2, 2))).toBe(false); // not recomputed for thorn yet
    computeAllVisibility(s);
    expect(isVisible(s, 'thorn', at(2, 2))).toBe(true);
    expect(isVisible(s, 'thorn', u.pos)).toBe(false);
  });

  it('a dead faction sees nothing but keeps its map knowledge', () => {
    const s = fogged();
    makeTestUnit(s, 'valen', at(10, 10));
    computeVisibility(s, 'valen');
    s.factions.valen.alive = false;
    computeVisibility(s, 'valen');
    expect(visibleSet(s, 'valen')).toEqual([]);
    expect(isExplored(s, 'valen', at(10, 10))).toBe(true);
  });

  it('neutral sees everything; out-of-bounds is never visible', () => {
    const s = fogged();
    expect(isVisible(s, 'neutral', at(5, 5))).toBe(true);
    expect(isExplored(s, 'neutral', at(5, 5))).toBe(true);
    expect(isVisible(s, 'valen', { q: -50, r: 0 })).toBe(false);
    expect(isExplored(s, 'valen', { q: 0, r: 50 })).toBe(false);
    computeAllVisibility(s); // skips neutral, doesn't throw
    expect(s.factions.neutral.visible.every((v) => v === 0)).toBe(true);
  });

  it('repairs a missing explored array and handles map edges', () => {
    const s = fogged(8, 6);
    s.factions.valen.explored = [];
    makeTestUnit(s, 'valen', at(0, 0));
    computeVisibility(s, 'valen');
    expect(s.factions.valen.explored).toHaveLength(48);
    expect(s.factions.valen.explored[tileIndex(at(0, 0), 8)]).toBe(1);
  });
});
