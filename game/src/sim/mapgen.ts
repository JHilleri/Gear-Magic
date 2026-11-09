// Procedural region map. See DESIGN §3.
//
// Pipeline: noise fields (domain-warped simplex fBm elevation, ridged noise, moisture) →
// lakes / mountain ridges / hills / forests / grass & plains by quantile thresholds (stable
// proportions on every seed) → lake shallows rims → rivers (Dijkstra downhill with meander
// noise; deep lower course with fords) → swamps near water → crystal fields per quadrant →
// start positions (spread apart, balanced, terrain fixed up) → ruins → connectivity carving
// (passes through ridges, fords across water) → deposits → per-tile elevation & variety.
import type { DepositId, GameSettings, Hex, TerrainId, Tile } from '../core/types';
import { DIRS, hexDistance, hexToWorld, offsetToAxial } from '../core/hex';
import { Rng } from '../core/rng';

export interface GeneratedMap {
  width: number;
  height: number;
  tiles: Tile[];          // index = row * width + col (odd-r offset)
  starts: Hex[];          // one per faction, far apart, on grass/plains, balanced resources
  ruins: Hex[];
}

export const MAP_SIZES = { small: { w: 26, h: 20 }, normal: { w: 34, h: 26 }, large: { w: 42, h: 32 } } as const;

/** Radius around a start checked for (and guaranteed) starting resources. */
export const START_RADIUS = 5;
/** Ruins are never placed within this distance of a start. */
export const RUIN_START_CLEARANCE = 6;

// ───────────────────────────── noise ─────────────────────────────
type Noise2 = (x: number, y: number) => number;
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD: readonly (readonly [number, number])[] = [
  [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** Seeded 2D simplex noise (Gustavson), output roughly in [-1, 1]. */
function makeSimplex(rng: Rng): Noise2 {
  const base = Array.from({ length: 256 }, (_, i) => i);
  rng.shuffle(base);
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return (xin, yin) => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = GRAD[p[ii + p[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = GRAD[p[ii + i1 + p[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = GRAD[p[ii + 1 + p[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  };
}

/** Fractal Brownian motion; each octave is offset so octaves don't correlate at the origin. */
function fbm(noise: Noise2, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq + o * 17.31, y * freq - o * 9.17);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function normalize01(a: Float64Array): void {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / span;
}

/** Value v such that about `frac` of `values` are ≥ v. */
function topThreshold(values: number[], frac: number): number {
  if (values.length === 0) return Infinity;
  const s = [...values].sort((a, b) => b - a);
  const k = Math.max(0, Math.min(s.length - 1, Math.floor(frac * s.length) - 1));
  return s[k];
}

/** Value v such that about `frac` of `values` are < v. */
function bottomThreshold(values: number[], frac: number): number {
  if (values.length === 0) return -Infinity;
  const s = [...values].sort((a, b) => a - b);
  const k = Math.max(0, Math.min(s.length - 1, Math.floor(frac * s.length)));
  return s[k];
}

// ───────────────────────────── grid ─────────────────────────────
interface Grid {
  w: number;
  h: number;
  n: number;
  hex: Hex[];
  col: Int32Array;
  row: Int32Array;
  /** 6 neighbor indices per tile (-1 = off-map), in DIRS order. */
  nb: Int32Array;
  x: Float64Array;
  z: Float64Array;
}

function makeGrid(w: number, h: number): Grid {
  const n = w * h;
  const hex: Hex[] = new Array(n);
  const col = new Int32Array(n);
  const row = new Int32Array(n);
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    col[i] = i % w;
    row[i] = Math.floor(i / w);
    hex[i] = offsetToAxial(col[i], row[i]);
    const p = hexToWorld(hex[i]);
    x[i] = p.x;
    z[i] = p.z;
  }
  const nb = new Int32Array(n * 6).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 6; d++) {
      const r = hex[i].r + DIRS[d].r;
      if (r < 0 || r >= h) continue;
      const c = hex[i].q + DIRS[d].q + (r - (r & 1)) / 2;
      if (c < 0 || c >= w) continue;
      nb[i * 6 + d] = r * w + c;
    }
  }
  return { w, h, n, hex, col, row, nb, x, z };
}

function neighborsOf(g: Grid, i: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 6; d++) { const j = g.nb[i * 6 + d]; if (j >= 0) out.push(j); }
  return out;
}

/** Tile indices within `radius` of tile `i` (inclusive, in bounds). */
function within(g: Grid, i: number, radius: number): number[] {
  const c = g.hex[i];
  const out: number[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const lo = Math.max(-radius, -dq - radius);
    const hi = Math.min(radius, -dq + radius);
    for (let dr = lo; dr <= hi; dr++) {
      const r = c.r + dr;
      if (r < 0 || r >= g.h) continue;
      const col = c.q + dq + (r - (r & 1)) / 2;
      if (col < 0 || col >= g.w) continue;
      out.push(r * g.w + col);
    }
  }
  return out;
}

const dist = (g: Grid, a: number, b: number): number => hexDistance(g.hex[a], g.hex[b]);
const edgeDist = (g: Grid, i: number): number => Math.min(g.col[i], g.w - 1 - g.col[i], g.row[i], g.h - 1 - g.row[i]);

/** Multi-source BFS hex-step distance to the nearest tile matching `isSource`. */
function distanceField(g: Grid, isSource: (i: number) => boolean): Int32Array {
  const d = new Int32Array(g.n).fill(1 << 20);
  const queue: number[] = [];
  for (let i = 0; i < g.n; i++) if (isSource(i)) { d[i] = 0; queue.push(i); }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (let k = 0; k < 6; k++) {
      const j = g.nb[c * 6 + k];
      if (j >= 0 && d[j] > d[c] + 1) { d[j] = d[c] + 1; queue.push(j); }
    }
  }
  return d;
}

/** Connected component labels over tiles matching `pass` (-1 elsewhere). */
function components(g: Grid, pass: (i: number) => boolean): Int32Array {
  const lab = new Int32Array(g.n).fill(-1);
  let next = 0;
  for (let s = 0; s < g.n; s++) {
    if (lab[s] !== -1 || !pass(s)) continue;
    const stack = [s];
    lab[s] = next;
    while (stack.length) {
      const c = stack.pop()!;
      for (let k = 0; k < 6; k++) {
        const j = g.nb[c * 6 + k];
        if (j >= 0 && lab[j] === -1 && pass(j)) { lab[j] = next; stack.push(j); }
      }
    }
    next++;
  }
  return lab;
}

/** Tiny binary heap for the generator's Dijkstra searches. */
class Heap {
  private i: number[] = [];
  private p: number[] = [];
  get size(): number { return this.i.length; }
  push(idx: number, pri: number): void {
    const I = this.i, P = this.p;
    let n = I.length;
    I.push(idx); P.push(pri);
    while (n > 0) {
      const par = (n - 1) >> 1;
      if (P[par] <= pri) break;
      I[n] = I[par]; P[n] = P[par]; n = par;
    }
    I[n] = idx; P[n] = pri;
  }
  pop(): number {
    const I = this.i, P = this.p;
    const top = I[0];
    const li = I.pop()!, lp = P.pop()!;
    const n = I.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && P[r] < P[l] ? r : l;
        if (P[c] >= lp) break;
        I[k] = I[c]; P[k] = P[c]; k = c;
      }
      I[k] = li; P[k] = lp;
    }
    return top;
  }
}

// ───────────────────────────── generator ─────────────────────────────
interface Ctx {
  g: Grid;
  rng: Rng;
  T: TerrainId[];
  dep: (DepositId | null)[];
  E: Float64Array;   // elevation 0..1
  R: Float64Array;   // ridge strength 0..1
  M: Float64Array;   // moisture 0..1
  F: Float64Array;   // patchiness / meander noise 0..1
}

const OPEN_LAND: ReadonlySet<TerrainId> = new Set(['grass', 'plains', 'forest', 'hills', 'crystal']);
const FLAT_FARMLAND: ReadonlySet<TerrainId> = new Set(['grass', 'plains']);
const isWet = (t: TerrainId): boolean => t === 'water' || t === 'shallows';
/** Passable for every unit, mounted included. */
const isOpenPassable = (t: TerrainId): boolean => t !== 'water' && t !== 'mountain';

function buildFields(c: Ctx): void {
  const { g, rng } = c;
  const nE = makeSimplex(rng), nW1 = makeSimplex(rng), nW2 = makeSimplex(rng);
  const nR = makeSimplex(rng), nM = makeSimplex(rng), nF = makeSimplex(rng);
  // Feature scale follows the map's world size so every map size gets ~2–3 major landforms.
  const worldW = Math.sqrt(3) * (g.w + 0.5);
  const worldH = 1.5 * g.h;
  const unit = Math.sqrt(worldW * worldH);
  const fE = 2.1 / unit;
  const fR = 2.6 / unit;
  const fM = 2.8 / unit;
  const fF = 6.5 / unit;
  const ox = rng.next() * 1000, oz = rng.next() * 1000;
  for (let i = 0; i < g.n; i++) {
    const x = g.x[i] + ox, z = g.z[i] + oz;
    // Domain warp gives lakes and highlands organic, non-blobby outlines.
    const wx = x + 5.5 * fbm(nW1, x * fE * 1.4, z * fE * 1.4, 2);
    const wz = z + 5.5 * fbm(nW2, x * fE * 1.4, z * fE * 1.4, 2);
    c.E[i] = fbm(nE, wx * fE, wz * fE, 5);
    const ridge = 1 - Math.abs(fbm(nR, wx * fR, wz * fR, 3, 2.1, 0.45));
    c.R[i] = ridge * ridge * ridge;
    c.M[i] = fbm(nM, x * fM, z * fM, 4);
    c.F[i] = fbm(nF, x * fF, z * fF, 2);
  }
  normalize01(c.E);
  normalize01(c.R);
  normalize01(c.M);
  normalize01(c.F);
}

function classifyBase(c: Ctx): void {
  const { g, rng, T, E, R, M, F } = c;
  const all = Array.from({ length: g.n }, (_, i) => i);

  // Lakes: lowest elevations.
  const waterQ = 0.05 + rng.next() * 0.03;
  const waterThr = bottomThreshold(all.map((i) => E[i]), waterQ);
  for (const i of all) T[i] = E[i] < waterThr ? 'water' : 'grass';

  // Mountain ridges: ridged noise biased toward high ground.
  const land = all.filter((i) => T[i] !== 'water');
  const MS = new Float64Array(g.n);
  for (const i of land) MS[i] = 0.7 * R[i] + 0.3 * E[i];
  const mtnFrac = (0.075 + rng.next() * 0.02) * g.n / land.length;
  const mtnThr = topThreshold(land.map((i) => MS[i]), mtnFrac);
  for (const i of land) if (MS[i] >= mtnThr) T[i] = 'mountain';

  // Hills: ridge flanks and the remaining high ground.
  const rest = land.filter((i) => T[i] !== 'mountain');
  const HS = new Float64Array(g.n);
  for (const i of rest) {
    let adjM = 0;
    for (const j of neighborsOf(g, i)) if (T[j] === 'mountain') adjM++;
    HS[i] = 0.45 * MS[i] + 0.4 * E[i] + 0.12 * Math.min(adjM, 2) + 0.1 * F[i];
  }
  const hillFrac = (0.11 + rng.next() * 0.03) * g.n / rest.length;
  const hillThr = topThreshold(rest.map((i) => HS[i]), hillFrac);
  for (const i of rest) if (HS[i] >= hillThr) T[i] = 'hills';

  // Forests: wet, patchy clusters.
  const flats = rest.filter((i) => T[i] === 'grass');
  const FS = new Float64Array(g.n);
  for (const i of flats) FS[i] = 0.6 * M[i] + 0.4 * F[i];
  const forestFrac = Math.min(0.6, (0.22 + rng.next() * 0.05) * g.n / Math.max(1, flats.length));
  const forestThr = topThreshold(flats.map((i) => FS[i]), forestFrac);
  for (const i of flats) if (FS[i] >= forestThr) T[i] = 'forest';

  // Grass where it is wetter, dry plains elsewhere.
  const open = flats.filter((i) => T[i] === 'grass');
  const plainThr = bottomThreshold(open.map((i) => M[i]), 0.42 + rng.next() * 0.08);
  for (const i of open) T[i] = M[i] < plainThr ? 'plains' : 'grass';
}

/** Remove puddle lakes and give lakes natural shallows rims. */
function shapeLakes(c: Ctx): void {
  const { g, rng, T, E } = c;
  const lab = components(g, (i) => T[i] === 'water');
  const sizes = new Map<number, number>();
  for (let i = 0; i < g.n; i++) if (lab[i] >= 0) sizes.set(lab[i], (sizes.get(lab[i]) ?? 0) + 1);
  for (let i = 0; i < g.n; i++) if (lab[i] >= 0 && (sizes.get(lab[i]) ?? 0) <= 2) T[i] = 'shallows';

  const rimThr = bottomThreshold(Array.from(E), 0.13);
  const rim: number[] = [];
  for (let i = 0; i < g.n; i++) {
    if (T[i] !== 'water') continue;
    for (const j of neighborsOf(g, i)) {
      const t = T[j];
      if (t !== 'grass' && t !== 'plains' && t !== 'forest') continue;
      if (E[j] < rimThr || rng.next() < 0.3) rim.push(j);
    }
  }
  for (const j of rim) T[j] = 'shallows';
}

/** Rivers wind from the foot of a mountain ridge down to a lake or the map edge. */
function carveRivers(c: Ctx): void {
  const { g, rng, T, E } = c;
  const count = g.n > 1100 ? 2 : rng.next() < 0.7 ? 2 : 1;
  const isRiver = new Uint8Array(g.n);
  const minLen = 6;
  const idealLen = Math.round(Math.min(g.w, g.h) * 0.6);
  for (let r = 0; r < count; r++) {
    const dWater = distanceField(g, (i) => isWet(T[i]));
    const dRiver = distanceField(g, (i) => isRiver[i] === 1);
    const sources: number[] = [];
    for (let i = 0; i < g.n; i++) {
      const t = T[i];
      if (t === 'water' || t === 'shallows' || t === 'mountain') continue;
      if (edgeDist(g, i) < 2 || dWater[i] < 5 || dRiver[i] < 7) continue;
      if (!neighborsOf(g, i).some((j) => T[j] === 'mountain')) continue;
      sources.push(i);
    }
    if (sources.length === 0) return;
    sources.sort((a, b) => E[b] - E[a]);
    const top = sources.slice(0, Math.max(4, Math.ceil(sources.length * 0.4)));
    rng.shuffle(top);
    // Of a few candidate sources, keep the river whose length is closest to the ideal.
    let best: number[] | null = null;
    for (const src of top.slice(0, 16)) {
      const path = riverPath(c, src, isRiver);
      if (!path || path.length < minLen) continue;
      if (!best || Math.abs(path.length - idealLen) < Math.abs(best.length - idealLen)) best = path;
    }
    if (best) applyRiver(c, best, isRiver);
  }
}

/** Cheapest "downhill" route from src to water / an existing river / the map edge. */
function riverPath(c: Ctx, src: number, isRiver: Uint8Array): number[] | null {
  const { g, T, E, F } = c;
  const d = new Float64Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const heap = new Heap();
  d[src] = 0;
  heap.push(src, 0);
  let end = -1;
  let includeEnd = false;
  while (heap.size) {
    const cur = heap.pop();
    const t = T[cur];
    if (cur !== src) {
      if (t === 'water' || isRiver[cur]) { end = cur; includeEnd = false; break; }
      if (t === 'shallows') { end = cur; includeEnd = true; break; }
      if (edgeDist(g, cur) === 0) { end = cur; includeEnd = true; break; }
    }
    for (let k = 0; k < 6; k++) {
      const j = g.nb[cur * 6 + k];
      if (j < 0 || T[j] === 'mountain') continue;
      let cost = 1 + 2.2 * E[j] + 1.8 * F[j] + 3 * Math.max(0, E[j] - E[cur]);
      // Keep two rivers from hugging each other.
      if (!isRiver[j] && neighborsOf(g, j).some((x) => isRiver[x])) cost += 4;
      const nd = d[cur] + cost;
      if (nd < d[j]) { d[j] = nd; prev[j] = cur; heap.push(j, nd); }
    }
  }
  if (end < 0) return null;
  const path: number[] = [];
  let x = includeEnd ? end : prev[end];
  while (x >= 0) { path.push(x); if (x === src) break; x = prev[x]; }
  path.reverse();
  return path;
}

function applyRiver(c: Ctx, path: number[], isRiver: Uint8Array): void {
  const { rng, T } = c;
  const L = path.length;
  // Upper course: a shallow stream. Lower course: deep water with fords every few hexes.
  const deepFrom = L >= 9 ? Math.floor(L * 0.45) : L;
  let sinceFord = 0;
  let gap = rng.int(2, 3);
  for (let k = 0; k < L; k++) {
    const i = path[k];
    isRiver[i] = 1;
    const isMouth = k === L - 1;
    if (k < deepFrom || isMouth) { T[i] = 'shallows'; continue; }
    if (sinceFord >= gap) {
      T[i] = 'shallows'; // ford
      sinceFord = 0;
      gap = rng.int(2, 3);
    } else {
      T[i] = 'water';
      sinceFord++;
    }
  }
}

/** Marshes form in wet lowlands next to lakes and rivers. */
function placeSwamps(c: Ctx): void {
  const { g, rng, T, E, M } = c;
  const dW = distanceField(g, (i) => isWet(T[i]));
  const eMid = bottomThreshold(Array.from(E), 0.55);
  const cands: { i: number; s: number }[] = [];
  for (let i = 0; i < g.n; i++) {
    const t = T[i];
    if (t !== 'grass' && t !== 'plains' && t !== 'forest') continue;
    if (dW[i] < 1 || dW[i] > 2 || E[i] >= eMid) continue;
    cands.push({ i, s: 0.7 * M[i] + (dW[i] === 1 ? 0.25 : 0) + 0.25 * rng.next() });
  }
  cands.sort((a, b) => b.s - a.s);
  const want = Math.round(g.n * (0.03 + rng.next() * 0.02));
  for (const { i } of cands.slice(0, want)) T[i] = 'swamp';
}

/** 1–2 crystal fields (clusters of 1–3 tiles) per map quadrant. */
function placeCrystalFields(c: Ctx): void {
  const { g, rng, T, R } = c;
  const centers: number[] = [];
  const halfW = g.w / 2, halfH = g.h / 2;
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      const fields = rng.int(1, 2);
      for (let f = 0; f < fields; f++) {
        const cands: { i: number; s: number }[] = [];
        for (let i = 0; i < g.n; i++) {
          if ((g.col[i] < halfW ? 0 : 1) !== qx || (g.row[i] < halfH ? 0 : 1) !== qy) continue;
          if (edgeDist(g, i) < 1 || !OPEN_LAND.has(T[i]) || T[i] === 'crystal') continue;
          if (centers.some((o) => dist(g, o, i) < 5)) continue;
          // Crystals breach the soil near the ridges.
          cands.push({ i, s: 0.5 * R[i] + 0.5 * rng.next() });
        }
        if (cands.length === 0) {
          if (f === 0) {
            // Guarantee at least one field: fall back to any dry land in the quadrant.
            for (let i = 0; i < g.n; i++) {
              if ((g.col[i] < halfW ? 0 : 1) !== qx || (g.row[i] < halfH ? 0 : 1) !== qy) continue;
              if (T[i] !== 'water' && T[i] !== 'shallows') cands.push({ i, s: rng.next() });
            }
          }
          if (cands.length === 0) continue;
        }
        cands.sort((a, b) => b.s - a.s);
        const center = cands[0].i;
        centers.push(center);
        T[center] = 'crystal';
        const extra = rng.int(0, 2);
        const around = neighborsOf(g, center).filter((j) => T[j] === 'grass' || T[j] === 'plains' || T[j] === 'forest');
        rng.shuffle(around);
        for (const j of around.slice(0, extra)) T[j] = 'crystal';
      }
    }
  }
}

// ───────────────────────────── starts ─────────────────────────────
interface StartScore { i: number; q: number }

function startQuality(c: Ctx, i: number): number {
  const { g, T } = c;
  let forest = 0, hills = 0, ore = 0, farm = 0, wet = 0, swamp = 0, mtn = 0, near = 0;
  for (const j of within(g, i, START_RADIUS)) {
    if (j === i) continue;
    const t = T[j];
    const d = dist(g, i, j);
    if (t === 'forest') forest++;
    else if (t === 'hills') { hills++; ore++; }
    else if (t === 'mountain') { ore++; mtn++; }
    else if (t === 'grass' || t === 'plains') { farm++; if (d <= 2) near++; }
    else if (t === 'swamp') swamp++;
    else if (isWet(t)) wet++;
  }
  return Math.min(forest, 5) * 0.5 + Math.min(hills, 3) * 0.7 + Math.min(ore, 4) * 0.35 + Math.min(farm, 14) * 0.18
    + Math.min(near, 6) * 0.3 - wet * 0.08 - swamp * 0.12 - Math.max(0, mtn - 4) * 0.2;
}

function startCandidates(c: Ctx, relax: number): StartScore[] {
  const { g, T } = c;
  const margin = relax >= 2 ? 1 : g.w >= 30 ? 3 : 2;
  const minOpen = relax >= 1 ? 3 : 4;
  const out: StartScore[] = [];
  for (let i = 0; i < g.n; i++) {
    if (!FLAT_FARMLAND.has(T[i]) && !(relax >= 2 && OPEN_LAND.has(T[i]))) continue;
    if (edgeDist(g, i) < margin) continue;
    const nbs = neighborsOf(g, i);
    if (nbs.length < 6) continue;
    const open = nbs.filter((j) => OPEN_LAND.has(T[j])).length;
    if (open < minOpen) continue;
    let blocked = 0;
    for (const j of within(g, i, 2)) if (T[j] === 'water' || T[j] === 'mountain') blocked++;
    if (relax === 0 && blocked > 5) continue;
    out.push({ i, q: startQuality(c, i) });
  }
  return out;
}

/** Choose k candidates maximising the minimum pairwise distance, then quality & balance. */
function chooseStarts(c: Ctx, cands: StartScore[], k: number): number[] | null {
  const { g, rng } = c;
  if (cands.length < k) return null;
  if (k === 1) return [cands.reduce((a, b) => (b.q > a.q ? b : a)).i];
  const score = (set: StartScore[]): number => {
    let minD = Infinity;
    for (let a = 0; a < set.length; a++) for (let b = a + 1; b < set.length; b++) minD = Math.min(minD, dist(g, set[a].i, set[b].i));
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const s of set) { lo = Math.min(lo, s.q); hi = Math.max(hi, s.q); sum += s.q; }
    return minD + 0.3 * (sum / set.length) - 0.25 * (hi - lo);
  };
  const seeds = cands.length <= 48 ? [...cands] : rng.shuffle([...cands]).slice(0, 48);
  let best: StartScore[] | null = null;
  let bestScore = -Infinity;
  for (const s of seeds) {
    const set = [s];
    while (set.length < k) {
      let pick: StartScore | null = null;
      let ps = -Infinity;
      for (const cand of cands) {
        if (set.includes(cand)) continue;
        let md = Infinity;
        for (const o of set) md = Math.min(md, dist(g, o.i, cand.i));
        const v = md + 0.3 * cand.q;
        if (v > ps) { ps = v; pick = cand; }
      }
      if (!pick) break;
      set.push(pick);
    }
    if (set.length < k) continue;
    const sc = score(set);
    if (sc > bestScore) { bestScore = sc; best = set; }
  }
  if (!best) return null;
  // Local refinement: try swapping each start for any candidate.
  for (let pass = 0; pass < 5; pass++) {
    let improved = false;
    for (let a = 0; a < best.length; a++) {
      for (const cand of cands) {
        if (best.includes(cand)) continue;
        const trial = best.slice();
        trial[a] = cand;
        const sc = score(trial);
        if (sc > bestScore + 1e-9) { bestScore = sc; best = trial; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best.map((s) => s.i);
}

/** Make every start a fair opening: farmland by the castle, forest, hills and room to spawn. */
function fixupStart(c: Ctx, s: number, protectedTiles: Set<number>): void {
  const { g, T, E, M } = c;
  T[s] = T[s] === 'plains' ? 'plains' : 'grass';
  const area = within(g, s, START_RADIUS).filter((j) => j !== s);
  const count = (pred: (t: TerrainId) => boolean, maxD = START_RADIUS) =>
    area.filter((j) => dist(g, s, j) <= maxD && pred(T[j])).length;
  const convert = (to: TerrainId, need: number, cands: number[], key: (j: number) => number): void => {
    const sorted = cands.filter((j) => !protectedTiles.has(j)).sort((a, b) => key(b) - key(a));
    for (const j of sorted.slice(0, Math.max(0, need))) T[j] = to;
  };

  // No mud around the castle gate.
  for (const j of neighborsOf(g, s)) if (T[j] === 'swamp') T[j] = 'grass';

  // Farmland inside the castle's territory for the starting farm and house.
  const nearFarm = count((t) => FLAT_FARMLAND.has(t), 2);
  if (nearFarm < 3) {
    convert('grass', 3 - nearFarm,
      area.filter((j) => dist(g, s, j) <= 2 && (T[j] === 'forest' || T[j] === 'swamp' || T[j] === 'hills' || T[j] === 'shallows')),
      (j) => (T[j] === 'swamp' ? 3 : T[j] === 'forest' ? 2 : T[j] === 'shallows' ? 1 : 0) - dist(g, s, j) * 0.1);
  }
  // Tiles a fixup may repurpose, never eating into the farmland next to the castle.
  const spare = (j: number): boolean => {
    const d = dist(g, s, j);
    if (d >= 3) return true;
    return d === 2 && count((t) => FLAT_FARMLAND.has(t), 2) > 3;
  };
  // At least 3 forest hexes for lumber.
  const forest = count((t) => t === 'forest');
  if (forest < 3) {
    convert('forest', 3 - forest,
      area.filter((j) => spare(j) && (FLAT_FARMLAND.has(T[j]) || T[j] === 'swamp')),
      (j) => M[j] + (neighborsOf(g, j).some((x) => T[x] === 'forest') ? 0.5 : 0) + (T[j] === 'swamp' ? 0.3 : 0)
        - Math.abs(dist(g, s, j) - 4) * 0.1 - (dist(g, s, j) < 3 ? 2 : 0));
  }
  // Hills for a quarry and a mine (at least one hill, two ore-bearing hexes).
  const hills = count((t) => t === 'hills');
  const ore = count((t) => t === 'hills' || t === 'mountain');
  const needHills = Math.max(hills < 1 ? 1 : 0, 2 - ore);
  if (needHills > 0) {
    convert('hills', needHills,
      area.filter((j) => spare(j) && (FLAT_FARMLAND.has(T[j]) || T[j] === 'forest' || T[j] === 'swamp')),
      (j) => E[j] + (T[j] === 'forest' ? -0.5 : 0) + (neighborsOf(g, j).some((x) => T[x] === 'mountain' || T[x] === 'hills') ? 0.3 : 0)
        - (dist(g, s, j) < 3 ? 2 : 0));
  }
  // Re-check forests in case hills took one.
  const forest2 = count((t) => t === 'forest');
  if (forest2 < 2) {
    convert('forest', 2 - forest2, area.filter((j) => spare(j) && (FLAT_FARMLAND.has(T[j]) || T[j] === 'swamp' || T[j] === 'shallows')), (j) => M[j] - (dist(g, s, j) < 3 ? 2 : 0));
  }
  for (const j of within(g, s, 2)) protectedTiles.add(j);
}

// ───────────────────────────── ruins ─────────────────────────────
function placeRuins(c: Ctx, starts: number[], sizeKey: keyof typeof MAP_SIZES): number[] {
  const { g, rng, T } = c;
  const want = sizeKey === 'small' ? rng.int(6, 7) : sizeKey === 'normal' ? rng.int(7, 9) : rng.int(9, 10);
  const okTerrain = (t: TerrainId) => t === 'grass' || t === 'plains' || t === 'forest' || t === 'hills';
  const collect = (minRoom: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < g.n; i++) {
      if (!okTerrain(T[i]) || edgeDist(g, i) < 1) continue;
      if (starts.some((s) => dist(g, s, i) < RUIN_START_CLEARANCE)) continue;
      // Guardians need room around the ruin.
      if (neighborsOf(g, i).filter((j) => isOpenPassable(T[j]) && T[j] !== 'shallows').length < minRoom) continue;
      out.push(i);
    }
    return out;
  };
  let cands = collect(4);
  if (cands.length < want * 2) cands = collect(2);
  const chosen: number[] = [];
  for (let spacing = 5; spacing >= 2 && chosen.length < want; spacing--) {
    while (chosen.length < want) {
      let best = -1, bestScore = -Infinity;
      for (const i of cands) {
        if (chosen.includes(i)) continue;
        let dr = 99;
        for (const o of chosen) dr = Math.min(dr, dist(g, o, i));
        if (dr < spacing) continue;
        let ds = 99;
        for (const s of starts) ds = Math.min(ds, dist(g, s, i));
        const sc = Math.min(dr, 12) + 0.6 * Math.min(ds, 10) + 2.5 * rng.next();
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      if (best < 0) break;
      chosen.push(best);
    }
  }
  for (const i of chosen) T[i] = 'ruins';
  return chosen;
}

// ───────────────────────────── connectivity ─────────────────────────────
/**
 * Carve the cheapest corridor from `from`'s component to `target` across blocking terrain:
 * mountains become hills (a pass), water becomes shallows (a ford).
 */
function carveCorridor(c: Ctx, pass: (t: TerrainId) => boolean, lab: Int32Array, fromLabel: number, target: number): void {
  const { g, T } = c;
  const toLabel = lab[target];
  const d = new Float64Array(g.n).fill(Infinity);
  const prev = new Int32Array(g.n).fill(-1);
  const heap = new Heap();
  for (let i = 0; i < g.n; i++) if (lab[i] === fromLabel) { d[i] = 0; heap.push(i, 0); }
  const stepCost = (t: TerrainId) => (pass(t) ? 1 : t === 'mountain' ? 6 : 9);
  let end = -1;
  while (heap.size) {
    const cur = heap.pop();
    if (toLabel >= 0 ? lab[cur] === toLabel : cur === target) { end = cur; break; }
    for (let k = 0; k < 6; k++) {
      const j = g.nb[cur * 6 + k];
      if (j < 0) continue;
      const nd = d[cur] + stepCost(T[j]) + (edgeDist(g, j) === 0 ? 0.5 : 0);
      if (nd < d[j]) { d[j] = nd; prev[j] = cur; heap.push(j, nd); }
    }
  }
  for (let x = end; x >= 0 && lab[x] !== fromLabel; x = prev[x]) {
    if (T[x] === 'mountain') T[x] = 'hills';
    else if (T[x] === 'water') T[x] = 'shallows';
  }
}

function ensureConnectivity(c: Ctx, starts: number[], ruins: number[]): void {
  const { g, T } = c;
  // 1) No stranded islands: every dry patch reachable on foot (tiny islets drown into shallows).
  for (let guard = 0; guard < 64; guard++) {
    const foot = (t: TerrainId) => t !== 'water';
    const lab = components(g, (i) => foot(T[i]));
    const main = lab[starts[0]];
    const sizes = new Map<number, number>();
    for (let i = 0; i < g.n; i++) if (lab[i] >= 0) sizes.set(lab[i], (sizes.get(lab[i]) ?? 0) + 1);
    let other = -1;
    for (let i = 0; i < g.n; i++) if (lab[i] >= 0 && lab[i] !== main) { other = i; break; }
    if (other < 0) break;
    const members: number[] = [];
    for (let i = 0; i < g.n; i++) if (lab[i] === lab[other]) members.push(i);
    const special = members.some((i) => starts.includes(i) || ruins.includes(i) || T[i] === 'crystal');
    if (members.length <= 2 && !special) {
      for (const i of members) T[i] = 'water'; // a rock in the lake, not worth a ford
    } else {
      carveCorridor(c, foot, lab, main, other);
    }
  }
  // 2) Every start and ruin reachable by every unit, riders included (no mountains, no water).
  for (const target of [...starts.slice(1), ...ruins]) {
    for (let guard = 0; guard < 4; guard++) {
      const lab = components(g, (i) => isOpenPassable(T[i]));
      if (lab[target] === lab[starts[0]]) break;
      carveCorridor(c, isOpenPassable, lab, lab[starts[0]], target);
    }
  }
}

// ───────────────────────────── deposits ─────────────────────────────
function placeDeposits(c: Ctx, starts: number[]): void {
  const { g, rng, T, M, dep } = c;
  const farmland: number[] = [];
  for (let i = 0; i < g.n; i++) {
    dep[i] = null;
    const r = rng.next();
    switch (T[i]) {
      case 'hills':
        if (r < 0.35) dep[i] = 'iron';
        else if (r < 0.35 + 0.65 * 0.45) dep[i] = 'stone';
        break;
      case 'mountain':
        if (r < 0.5) dep[i] = 'iron';
        else if (r < 0.6) dep[i] = 'crystal';
        break;
      case 'crystal':
        dep[i] = 'crystal';
        break;
      case 'grass':
      case 'plains':
        farmland.push(i);
        break;
      default:
        break;
    }
  }
  // Fertile soil clusters in wetter farmland (~25%).
  const scored = farmland.map((i) => ({ i, s: 0.55 * M[i] + 0.45 * rng.next() }));
  scored.sort((a, b) => b.s - a.s);
  for (const { i } of scored.slice(0, Math.round(farmland.length * 0.25))) dep[i] = 'fertile';

  for (const s of starts) {
    dep[s] = null;
    const area = within(g, s, START_RADIUS).filter((j) => j !== s);
    if (!area.some((j) => dep[j] === 'iron')) {
      // Promise of iron: prefer a hill at a comfortable distance.
      const ore = area.filter((j) => T[j] === 'hills' || T[j] === 'mountain')
        .sort((a, b) => (T[a] === 'hills' ? 0 : 1) - (T[b] === 'hills' ? 0 : 1) || Math.abs(dist(g, s, a) - 3.5) - Math.abs(dist(g, s, b) - 3.5));
      if (ore.length > 0) dep[ore[0]] = 'iron';
    }
    // And at least one fertile field next to the castle.
    const near = area.filter((j) => dist(g, s, j) <= 2 && FLAT_FARMLAND.has(T[j]));
    if (near.length > 0 && !near.some((j) => dep[j] === 'fertile')) dep[near[0]] = 'fertile';
  }
}

// ───────────────────────────── main ─────────────────────────────
function mixSeed(seed: number, size: number, k: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (size * 0x27d4eb2d), 0xc2b2ae35);
  h ^= Math.imul(k + 1, 0x165667b1);
  return (h ^ (h >>> 16)) | 0;
}

function tryGenerate(seed: number, sizeKey: keyof typeof MAP_SIZES, k: number, relax: number): GeneratedMap | null {
  const { w, h } = MAP_SIZES[sizeKey];
  const g = makeGrid(w, h);
  const c: Ctx = {
    g, rng: new Rng(seed), T: new Array(g.n).fill('grass'), dep: new Array(g.n).fill(null),
    E: new Float64Array(g.n), R: new Float64Array(g.n), M: new Float64Array(g.n), F: new Float64Array(g.n),
  };
  buildFields(c);
  classifyBase(c);
  shapeLakes(c);
  carveRivers(c);
  placeSwamps(c);
  placeCrystalFields(c);

  const cands = startCandidates(c, relax);
  const picked = chooseStarts(c, cands, k);
  if (!picked) return null;
  const starts = c.rng.shuffle(picked.slice());
  const protectedTiles = new Set<number>();
  for (const s of starts) fixupStart(c, s, protectedTiles);
  const ruins = placeRuins(c, starts, sizeKey);
  ensureConnectivity(c, starts, ruins);
  placeDeposits(c, starts);

  const { T, E, R, dep, rng } = c;
  const tiles: Tile[] = new Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const t = T[i];
    let e: number;
    if (t === 'water') e = 0.04 + 0.16 * E[i];
    else if (t === 'shallows') e = 0.14 + 0.16 * E[i];
    else if (t === 'mountain') e = 0.7 + 0.3 * Math.max(R[i], E[i]);
    else if (t === 'hills') e = 0.48 + 0.25 * E[i];
    else e = 0.24 + 0.3 * E[i];
    const tile: Tile = { terrain: t, deposit: dep[i], elevation: Math.round(Math.min(1, Math.max(0, e)) * 1000) / 1000, building: null, variant: rng.int(0, 9999) };
    if (t === 'ruins') tile.ruinsLooted = false;
    tiles[i] = tile;
  }
  return { width: w, height: h, tiles, starts: starts.map((i) => ({ ...g.hex[i] })), ruins: ruins.map((i) => ({ ...g.hex[i] })) };
}

/** Deterministic for (settings.seed, settings.mapSize, factionCount). */
export function generateMap(settings: GameSettings, factionCount: number): GeneratedMap {
  const sizeKey: keyof typeof MAP_SIZES = settings.mapSize in MAP_SIZES ? settings.mapSize : 'normal';
  const k = Math.max(1, Math.min(4, Math.floor(factionCount) || 1));
  const base = mixSeed(settings.seed, ['small', 'normal', 'large'].indexOf(sizeKey), k);
  // A handful of retries (new noise) before relaxing start constraints; practically never needed.
  for (let relax = 0; relax <= 2; relax++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const m = tryGenerate((base + Math.imul(attempt + relax * 6, 0x2f6b3a1d)) | 0, sizeKey, k, relax);
      if (m) return m;
    }
  }
  throw new Error('Map generation failed to place start positions.');
}
