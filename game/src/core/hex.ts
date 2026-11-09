// Pointy-top axial hex math. World: x = √3·(q + r/2)·S, z = 1.5·r·S (Y up).
import type { Hex } from './types';

export const HEX_SIZE = 1.0;
const SQRT3 = Math.sqrt(3);

export const DIRS: readonly Hex[] = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

export const hex = (q: number, r: number): Hex => ({ q, r });
export const hexEq = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;
export const hexKey = (h: Hex): string => `${h.q},${h.r}`;
export const hexAdd = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function neighbors(h: Hex): Hex[] {
  return DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

/** All hexes at exactly distance `radius` (radius 0 → [center]). */
export function ring(center: Hex, radius: number): Hex[] {
  if (radius === 0) return [{ ...center }];
  const out: Hex[] = [];
  let h: Hex = { q: center.q + DIRS[4].q * radius, r: center.r + DIRS[4].r * radius };
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      out.push(h);
      h = { q: h.q + DIRS[i].q, r: h.r + DIRS[i].r };
    }
  }
  return out;
}

/** All hexes within distance `radius` (inclusive), center first. */
export function spiral(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let k = 0; k <= radius; k++) out.push(...ring(center, k));
  return out;
}

// ── offset (odd-r) <-> axial: the map is stored as a W×H rectangle ──
export function offsetToAxial(col: number, row: number): Hex {
  return { q: col - (row - (row & 1)) / 2, r: row };
}
export function axialToOffset(h: Hex): { col: number; row: number } {
  return { col: h.q + (h.r - (h.r & 1)) / 2, row: h.r };
}
export function inBounds(h: Hex, width: number, height: number): boolean {
  const { col, row } = axialToOffset(h);
  return col >= 0 && col < width && row >= 0 && row < height;
}
export function tileIndex(h: Hex, width: number): number {
  const { col, row } = axialToOffset(h);
  return row * width + col;
}
export function indexToHex(i: number, width: number): Hex {
  return offsetToAxial(i % width, Math.floor(i / width));
}

// ── world space ──
export function hexToWorld(h: Hex): { x: number; z: number } {
  return { x: HEX_SIZE * SQRT3 * (h.q + h.r / 2), z: HEX_SIZE * 1.5 * h.r };
}

export function hexRound(qf: number, rf: number): Hex {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}

export function worldToHex(x: number, z: number): Hex {
  const qf = ((SQRT3 / 3) * x - (1 / 3) * z) / HEX_SIZE;
  const rf = ((2 / 3) * z) / HEX_SIZE;
  return hexRound(qf, rf);
}

/** Corner i (0..5) of a pointy-top hex in world space, relative to center. */
export function hexCorner(i: number): { x: number; z: number } {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return { x: HEX_SIZE * Math.cos(angle), z: HEX_SIZE * Math.sin(angle) };
}

/** Hexes on the straight line from a to b (inclusive). */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDistance(a, b);
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(hexRound(a.q + (b.q - a.q) * t + 1e-6, a.r + (b.r - a.r) * t + 1e-6));
  }
  return out;
}
