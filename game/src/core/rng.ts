// Deterministic RNG (mulberry32). The state lives in GameState.rngState so that
// sim outcomes are reproducible and serializable.
import type { GameState } from './types';

export function mulberry32Next(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}

/** Uniform [0,1) drawn from (and advancing) the game state's RNG. */
export function rand(state: GameState): number {
  const r = mulberry32Next(state.rngState);
  state.rngState = r.state;
  return r.value;
}

export function randInt(state: GameState, min: number, maxInclusive: number): number {
  return min + Math.floor(rand(state) * (maxInclusive - min + 1));
}

export function pick<T>(state: GameState, arr: readonly T[]): T {
  return arr[Math.floor(rand(state) * arr.length)];
}

/** Standalone seeded generator (for map generation / render variety). */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed | 0; }
  next(): number { const r = mulberry32Next(this.s); this.s = r.state; return r.value; }
  int(min: number, maxInclusive: number): number { return min + Math.floor(this.next() * (maxInclusive - min + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
}

/** Cheap deterministic hash → [0,1) for per-tile visual variety. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
