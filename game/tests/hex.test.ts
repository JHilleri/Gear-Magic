import { describe, expect, it } from 'vitest';
import {
  DIRS, hex, hexEq, hexKey, hexAdd, hexDistance, neighbors, ring, spiral, offsetToAxial, axialToOffset,
  inBounds, tileIndex, indexToHex, hexToWorld, worldToHex, hexRound, hexCorner, hexLine, HEX_SIZE,
} from '../src/core/hex';

describe('hex math', () => {
  it('basic helpers', () => {
    expect(hexEq(hex(1, 2), { q: 1, r: 2 })).toBe(true);
    expect(hexEq(hex(1, 2), hex(2, 1))).toBe(false);
    expect(hexKey(hex(-3, 4))).toBe('-3,4');
    expect(hexAdd(hex(1, 2), hex(-3, 5))).toEqual(hex(-2, 7));
  });

  it('distance is a metric and neighbors are at distance 1', () => {
    const o = hex(0, 0);
    expect(hexDistance(o, o)).toBe(0);
    expect(neighbors(o)).toHaveLength(6);
    for (const n of neighbors(o)) expect(hexDistance(o, n)).toBe(1);
    expect(new Set(neighbors(o).map(hexKey)).size).toBe(6);
    expect(hexDistance(hex(0, 0), hex(3, -1))).toBe(3);
    expect(hexDistance(hex(-2, 5), hex(4, -3))).toBe(8);
    for (let i = 0; i < 50; i++) {
      const a = hex((i * 7) % 11 - 5, (i * 3) % 13 - 6);
      const b = hex((i * 5) % 9 - 4, (i * 11) % 7 - 3);
      const c = hex((i * 2) % 5 - 2, (i * 13) % 9 - 4);
      expect(hexDistance(a, b)).toBe(hexDistance(b, a));
      expect(hexDistance(a, c)).toBeLessThanOrEqual(hexDistance(a, b) + hexDistance(b, c));
    }
    // The six directions sum to zero.
    expect(DIRS.reduce((s, d) => hexAdd(s, d), hex(0, 0))).toEqual(hex(0, 0));
  });

  it('ring and spiral sizes', () => {
    const c = hex(2, -1);
    expect(ring(c, 0)).toEqual([c]);
    for (let r = 1; r <= 6; r++) {
      const rg = ring(c, r);
      expect(rg).toHaveLength(6 * r);
      expect(new Set(rg.map(hexKey)).size).toBe(6 * r);
      for (const h of rg) expect(hexDistance(c, h)).toBe(r);
    }
    const sp = spiral(c, 4);
    expect(sp).toHaveLength(1 + 3 * 4 * 5);
    expect(sp[0]).toEqual(c);
    expect(new Set(sp.map(hexKey)).size).toBe(sp.length);
  });

  it('offset (odd-r) and index round-trips', () => {
    const w = 13, h = 9;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const a = offsetToAxial(col, row);
        expect(axialToOffset(a)).toEqual({ col, row });
        expect(inBounds(a, w, h)).toBe(true);
        const i = tileIndex(a, w);
        expect(i).toBe(row * w + col);
        expect(indexToHex(i, w)).toEqual(a);
      }
    }
    expect(inBounds(offsetToAxial(-1, 0), w, h)).toBe(false);
    expect(inBounds(offsetToAxial(w, 3), w, h)).toBe(false);
    expect(inBounds(offsetToAxial(2, h), w, h)).toBe(false);
    expect(inBounds(offsetToAxial(2, -1), w, h)).toBe(false);
    // Odd rows are shifted right: (0,1) is a neighbor of both (0,0) and (1,0).
    expect(hexDistance(offsetToAxial(0, 1), offsetToAxial(0, 0))).toBe(1);
    expect(hexDistance(offsetToAxial(0, 1), offsetToAxial(1, 0))).toBe(1);
    // Even rows are not: (1,2) neighbors (0,1) and (1,1).
    expect(hexDistance(offsetToAxial(1, 2), offsetToAxial(0, 1))).toBe(1);
    expect(hexDistance(offsetToAxial(1, 2), offsetToAxial(1, 1))).toBe(1);
  });

  it('world space conversion and rounding', () => {
    expect(hexToWorld(hex(0, 0))).toEqual({ x: 0, z: 0 });
    const p = hexToWorld(hex(1, 0));
    expect(p.x).toBeCloseTo(Math.sqrt(3) * HEX_SIZE);
    expect(p.z).toBeCloseTo(0);
    expect(hexToWorld(hex(0, 2)).z).toBeCloseTo(3 * HEX_SIZE);
    for (let q = -6; q <= 6; q++) {
      for (let r = -6; r <= 6; r++) {
        const w = hexToWorld(hex(q, r));
        expect(worldToHex(w.x, w.z)).toEqual(hex(q, r));
        // Points slightly inside the hex still map to it.
        expect(worldToHex(w.x + 0.3, w.z - 0.3)).toEqual(hex(q, r));
      }
    }
    expect(hexRound(0.1, -0.2)).toEqual(hex(0, 0));
    expect(hexRound(0.9, 0.05)).toEqual(hex(1, 0));
    // No negative zero.
    expect(Object.is(hexRound(-0.1, 0.1).q, -0)).toBe(false);
  });

  it('corners lie on the circumradius, pointy-top', () => {
    for (let i = 0; i < 6; i++) {
      const c = hexCorner(i);
      expect(Math.hypot(c.x, c.z)).toBeCloseTo(HEX_SIZE);
    }
    // Pointy-top: a corner straight "up" (−z) and "down" (+z).
    expect(hexCorner(5).x).toBeCloseTo(0);
    expect(hexCorner(2).x).toBeCloseTo(0);
  });

  it('lines are contiguous and include both ends', () => {
    const a = hex(-3, 2), b = hex(4, -1);
    const l = hexLine(a, b);
    expect(l).toHaveLength(hexDistance(a, b) + 1);
    expect(l[0]).toEqual(a);
    expect(l[l.length - 1]).toEqual(b);
    for (let i = 1; i < l.length; i++) expect(hexDistance(l[i - 1], l[i])).toBe(1);
    expect(hexLine(a, a)).toEqual([a]);
  });
});
