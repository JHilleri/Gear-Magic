import { describe, expect, it } from 'vitest';
import { generateMap, MAP_SIZES, START_RADIUS, type GeneratedMap } from '../src/sim/mapgen';
import { hexDistance, inBounds, neighbors, spiral, tileIndex, indexToHex, axialToOffset } from '../src/core/hex';
import type { GameSettings, Hex, TerrainId } from '../src/core/types';
import { TERRAIN } from '../src/data/terrain';

const settings = (seed: number, mapSize: GameSettings['mapSize'] = 'normal'): GameSettings =>
  ({ mapSize, seed, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });

const tileAt = (m: GeneratedMap, h: Hex) => m.tiles[tileIndex(h, m.width)];
const area = (m: GeneratedMap, c: Hex, r: number) => spiral(c, r).filter((h) => inBounds(h, m.width, m.height) && hexDistance(h, c) > 0);

/** Flood fill over tiles accepted by `pass`, from `from`. */
function flood(m: GeneratedMap, from: Hex, pass: (t: TerrainId) => boolean): Set<number> {
  const seen = new Set<number>([tileIndex(from, m.width)]);
  const stack = [from];
  while (stack.length) {
    const h = stack.pop()!;
    for (const n of neighbors(h)) {
      if (!inBounds(n, m.width, m.height)) continue;
      const i = tileIndex(n, m.width);
      if (seen.has(i) || !pass(m.tiles[i].terrain)) continue;
      seen.add(i);
      stack.push(n);
    }
  }
  return seen;
}

const DEPOSIT_TERRAIN: Record<string, TerrainId[]> = {
  iron: ['hills', 'mountain'],
  stone: ['hills'],
  crystal: ['crystal', 'mountain'],
  fertile: ['grass', 'plains'],
};

/** Every structural guarantee of DESIGN §3 / the mapgen contract. Returns a list of violations. */
function violations(m: GeneratedMap, k: number, size: keyof typeof MAP_SIZES): string[] {
  const errs: string[] = [];
  const check = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  const { w, h } = MAP_SIZES[size];
  check(m.width === w && m.height === h, 'dimensions');
  check(m.tiles.length === w * h, 'tile count');
  m.tiles.forEach((t, i) => {
    check(!!TERRAIN[t.terrain], `terrain ${i}`);
    check(t.building === null, `building ${i}`);
    check(t.elevation >= 0 && t.elevation <= 1, `elevation ${i}`);
    check(Number.isInteger(t.variant), `variant ${i}`);
    if (t.deposit) check(DEPOSIT_TERRAIN[t.deposit].includes(t.terrain), `deposit ${t.deposit} on ${t.terrain} @${i}`);
    if (t.terrain === 'crystal') check(t.deposit === 'crystal', `crystal field without deposit @${i}`);
  });

  // Starts
  check(m.starts.length === k, 'start count');
  m.starts.forEach((s, si) => {
    check(inBounds(s, w, h), `start ${si} out of bounds`);
    check(['grass', 'plains'].includes(tileAt(m, s).terrain), `start ${si} on ${tileAt(m, s).terrain}`);
    const around = area(m, s, START_RADIUS).map((x) => tileAt(m, x));
    check(around.filter((t) => t.terrain === 'forest').length >= 2, `start ${si} forest`);
    check(around.filter((t) => t.terrain === 'hills').length >= 1, `start ${si} hills`);
    check(around.filter((t) => t.deposit === 'iron').length >= 1, `start ${si} iron`);
    // Farm + house fit inside the castle's own territory.
    const near = area(m, s, 2).map((x) => tileAt(m, x));
    check(near.filter((t) => t.terrain === 'grass' || t.terrain === 'plains').length >= 2, `start ${si} farmland`);
    // Room to spawn the starting units.
    const free = neighbors(s).filter((n) => inBounds(n, w, h) && tileAt(m, n).terrain !== 'water' && tileAt(m, n).terrain !== 'mountain');
    check(free.length >= 3, `start ${si} spawn room`);
  });
  // Far apart.
  const minSep = Math.floor(k === 2 ? (w + h) * 0.45 : (w + h) * 0.3);
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
    const d = hexDistance(m.starts[a], m.starts[b]);
    check(d >= minSep, `starts ${a},${b} only ${d} apart (< ${minSep})`);
  }

  // Ruins
  check(m.ruins.length >= 6 && m.ruins.length <= 10, `ruin count ${m.ruins.length}`);
  for (const r of m.ruins) {
    check(tileAt(m, r).terrain === 'ruins', 'ruin terrain');
    for (const s of m.starts) check(hexDistance(r, s) > 5, 'ruin too close to a start');
  }
  check(m.tiles.filter((t) => t.terrain === 'ruins').length === m.ruins.length, 'stray ruins tiles');
  check(new Set(m.ruins.map((r) => `${r.q},${r.r}`)).size === m.ruins.length, 'duplicate ruins');

  // Connectivity: every start and ruin reachable by riders (no water, no mountains).
  const reach = flood(m, m.starts[0], (t) => t !== 'water' && t !== 'mountain');
  m.starts.forEach((s, si) => check(reach.has(tileIndex(s, w)), `start ${si} unreachable`));
  m.ruins.forEach((r, ri) => check(reach.has(tileIndex(r, w)), `ruin ${ri} unreachable`));
  // ...and no dry land is stranded from the starts on foot.
  const foot = flood(m, m.starts[0], (t) => t !== 'water');
  m.tiles.forEach((t, i) => { if (t.terrain !== 'water') check(foot.has(i), `stranded land @${i}`); });

  // Crystal fields in every quadrant.
  for (let qy = 0; qy < 2; qy++) for (let qx = 0; qx < 2; qx++) {
    const n = m.tiles.filter((t, i) => {
      const { col, row } = axialToOffset(indexToHex(i, w));
      return t.terrain === 'crystal' && (col < w / 2 ? 0 : 1) === qx && (row < h / 2 ? 0 : 1) === qy;
    }).length;
    check(n >= 1, `no crystal in quadrant ${qx},${qy}`);
  }
  return errs;
}

describe('generateMap', () => {
  it('is deterministic for (seed, size, factionCount)', () => {
    const a = generateMap(settings(1234), 3);
    const b = generateMap(settings(1234), 3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateMap(settings(1235), 3);
    expect(JSON.stringify(c.tiles)).not.toBe(JSON.stringify(a.tiles));
    const d = generateMap(settings(1234), 2);
    expect(d.starts).toHaveLength(2);
  });

  it('ignores unrelated settings (player faction, difficulty)', () => {
    const a = generateMap(settings(77), 3);
    const b = generateMap({ ...settings(77), playerFaction: 'ashen', difficulty: 'hard' }, 3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  for (const size of ['small', 'normal', 'large'] as const) {
    for (const k of [2, 3]) {
      it(`satisfies all guarantees on ${size} maps with ${k} factions (many seeds)`, () => {
        const failures: string[] = [];
        for (let seed = 1; seed <= 40; seed++) {
          const m = generateMap(settings(seed * 7919 + k, size), k);
          for (const e of violations(m, k, size)) failures.push(`seed ${seed * 7919 + k}: ${e}`);
        }
        expect(failures).toEqual([]);
      });
    }
  }

  it('has a natural mix of terrain', () => {
    const totals: Record<string, number> = {};
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = generateMap(settings(seed), 3);
      for (const t of m.tiles) totals[t.terrain] = (totals[t.terrain] ?? 0) + 1;
      n += m.tiles.length;
      // Every map has lakes, mountains, forests and some swamp.
      const has = (t: TerrainId) => m.tiles.some((x) => x.terrain === t);
      expect(has('water')).toBe(true);
      expect(has('shallows')).toBe(true);
      expect(has('mountain')).toBe(true);
      expect(has('forest')).toBe(true);
      expect(has('hills')).toBe(true);
    }
    const share = (t: string) => (totals[t] ?? 0) / n;
    expect(share('water')).toBeGreaterThan(0.03);
    expect(share('water')).toBeLessThan(0.12);
    expect(share('mountain')).toBeGreaterThan(0.04);
    expect(share('mountain')).toBeLessThan(0.12);
    expect(share('hills')).toBeGreaterThan(0.08);
    expect(share('forest')).toBeGreaterThan(0.14);
    expect(share('forest')).toBeLessThan(0.32);
    expect(share('swamp')).toBeGreaterThan(0.015);
    expect(share('swamp')).toBeLessThan(0.08);
    expect(share('grass') + share('plains')).toBeGreaterThan(0.3);
  });

  it('places deposits at roughly the specified rates', () => {
    let hills = 0, hillIron = 0, mtn = 0, mtnIron = 0, mtnCrystal = 0, farm = 0, fertile = 0, hillStone = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = generateMap(settings(seed), 2);
      for (const t of m.tiles) {
        if (t.terrain === 'hills') { hills++; if (t.deposit === 'iron') hillIron++; if (t.deposit === 'stone') hillStone++; }
        if (t.terrain === 'mountain') { mtn++; if (t.deposit === 'iron') mtnIron++; if (t.deposit === 'crystal') mtnCrystal++; }
        if (t.terrain === 'grass' || t.terrain === 'plains') { farm++; if (t.deposit === 'fertile') fertile++; }
      }
    }
    expect(hillIron / hills).toBeGreaterThan(0.27);
    expect(hillIron / hills).toBeLessThan(0.45);
    expect(hillStone / hills).toBeGreaterThan(0.15);
    expect(mtnIron / mtn).toBeGreaterThan(0.4);
    expect(mtnIron / mtn).toBeLessThan(0.6);
    expect(mtnCrystal / mtn).toBeGreaterThan(0.04);
    expect(mtnCrystal / mtn).toBeLessThan(0.17);
    expect(fertile / farm).toBeGreaterThan(0.2);
    expect(fertile / farm).toBeLessThan(0.3);
  });

  it('carves winding rivers that reach water or the map edge', () => {
    // A river shows up as a long chain of shallows / deep water hexes; at least one map in a
    // batch must contain a wet chain spanning a good part of the map.
    let longest = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const m = generateMap(settings(seed), 3);
      const wet = (i: number) => m.tiles[i].terrain === 'shallows' || m.tiles[i].terrain === 'water';
      const seen = new Set<number>();
      for (let i = 0; i < m.tiles.length; i++) {
        if (!wet(i) || seen.has(i)) continue;
        // Bounding extent of this wet component.
        const stack = [i];
        seen.add(i);
        let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
        while (stack.length) {
          const c = stack.pop()!;
          const hx = indexToHex(c, m.width);
          const { col, row } = axialToOffset(hx);
          lo = Math.min(lo, col); hi = Math.max(hi, col); lo2 = Math.min(lo2, row); hi2 = Math.max(hi2, row);
          for (const nb of neighbors(hx)) {
            if (!inBounds(nb, m.width, m.height)) continue;
            const j = tileIndex(nb, m.width);
            if (!seen.has(j) && wet(j)) { seen.add(j); stack.push(j); }
          }
        }
        longest = Math.max(longest, Math.max(hi - lo, hi2 - lo2));
      }
    }
    expect(longest).toBeGreaterThanOrEqual(10);
  });

  it('supports 1 and 4 factions without failing', () => {
    expect(generateMap(settings(5), 1).starts).toHaveLength(1);
    const m = generateMap(settings(5, 'large'), 4);
    expect(m.starts).toHaveLength(4);
  });

  it('generates quickly', () => {
    generateMap(settings(1, 'large'), 3); // warm up
    const t0 = performance.now();
    for (let s = 0; s < 10; s++) generateMap(settings(100 + s, 'large'), 3);
    expect((performance.now() - t0) / 10).toBeLessThan(150);
  });
});
