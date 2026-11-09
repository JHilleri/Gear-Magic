// Bottom-right minimap: terrain, fog, territory, buildings, units and (when the store exposes
// it) the camera footprint. Click or drag to move the camera.
import { useEffect, useRef } from 'preact/hooks';
import type { Building, FactionId, GameState, Hex } from '../../core/types';
import type { GameStore } from '../../game/store';
import { DIRS, hexToWorld, inBounds, indexToHex, tileIndex, worldToHex } from '../../core/hex';
import { hash2 } from '../../core/rng';
import { FACTIONS } from '../../data/factions';
import { TERRAIN } from '../../data/terrain';
import { computeTerritory } from '../../sim/economy';
import { useUi } from '../ctx';
import { safe, selectedUnitId, viewerOf } from '../util';

/**
 * Optional store extensions used for the camera rectangle: an explicit ground footprint
 * (world x/z polygon), or else the controller's public `renderer.pickHex`, sampled at the
 * screen corners.
 */
type FootprintStore = GameStore & {
  cameraFootprint?: () => { x: number; z: number }[] | null;
  renderer?: {
    pickHex?: (clientX: number, clientY: number) => Hex | null;
    /** Exact ground polygon of the view (not clamped to the map). */
    cameraFootprint?: () => { x: number; z: number }[] | null;
  };
};

function cameraFootprint(store: FootprintStore): { x: number; z: number }[] | null {
  if (typeof store.cameraFootprint === 'function') return store.cameraFootprint();
  if (typeof store.renderer?.cameraFootprint === 'function') return store.renderer.cameraFootprint();
  const pick = store.renderer?.pickHex;
  if (typeof pick !== 'function') return null;
  // Last resort: all four screen corners must hit the map (a partial polygon is not the view).
  const w = window.innerWidth, h = window.innerHeight;
  const pts: { x: number; z: number }[] = [];
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const hit = pick.call(store.renderer, x, y);
    if (!hit) return null;
    pts.push(hexToWorld(hit));
  }
  return pts;
}

const SQRT3 = Math.sqrt(3);
// Edge (corner pair) facing each axial direction in DIRS order, for pointy-top corners at 60i−30°.
const DIR_EDGE: [number, number][] = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
const CORNERS = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 180) * (60 * i - 30);
  return { x: Math.cos(a), z: Math.sin(a) };
});

interface Geo { minX: number; minZ: number; scale: number; w: number; h: number; dpr: number }

function geometry(s: GameState, cssW: number, dpr: number): Geo {
  const minX = -SQRT3 / 2, maxX = SQRT3 * s.width;
  const minZ = -1, maxZ = 1.5 * (s.height - 1) + 1;
  const scale = cssW / (maxX - minX);
  return { minX, minZ, scale, w: cssW, h: (maxZ - minZ) * scale, dpr };
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cz: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const x = cx + CORNERS[i].x * r, z = cz + CORNERS[i].z * r;
    if (i === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
  }
  ctx.closePath();
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

/** Terrain base layer: drawn once per game/size and reused. */
function drawTerrain(s: GameState, g: Geo): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(g.w * g.dpr));
  c.height = Math.max(1, Math.round(g.h * g.dpr));
  const ctx = c.getContext('2d')!;
  ctx.scale(g.dpr, g.dpr);
  const r = g.scale * 1.04;
  for (let i = 0; i < s.tiles.length; i++) {
    const t = s.tiles[i];
    const h = indexToHex(i, s.width);
    const w = hexToWorld(h);
    const def = TERRAIN[t.terrain];
    // Subtle per-tile brightness variation keeps large regions from looking flat.
    const v = 0.9 + hash2(h.q, h.r, 7) * 0.18 + (t.elevation - 0.5) * 0.1;
    hexPath(ctx, (w.x - g.minX) * g.scale, (w.z - g.minZ) * g.scale, r);
    ctx.fillStyle = shade(def?.color ?? '#555555', v);
    ctx.fill();
  }
  return c;
}

function draw(canvas: HTMLCanvasElement, store: FootprintStore, cache: { key: string; base: HTMLCanvasElement | null }): void {
  const s = store.state;
  if (!s) return;
  const cssW = canvas.clientWidth;
  if (cssW <= 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const g = geometry(s, cssW, dpr);
  const pw = Math.round(g.w * dpr), ph = Math.round(g.h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  canvas.style.height = `${g.h}px`;

  const key = `${s.settings.seed}:${s.width}x${s.height}:${pw}x${ph}:${s.tiles.length}`;
  if (cache.key !== key || !cache.base) { cache.base = drawTerrain(s, g); cache.key = key; }

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.drawImage(cache.base, 0, 0);
  ctx.scale(dpr, dpr);

  const viewer = viewerOf(s);
  const fs = s.factions[viewer];
  const explored = fs?.explored ?? [];
  const visible = fs?.visible ?? [];
  const r = g.scale * 1.04;
  const px = (h: Hex) => { const w = hexToWorld(h); return { x: (w.x - g.minX) * g.scale, z: (w.z - g.minZ) * g.scale }; };

  const live = safe(() => computeTerritory(s), [] as (FactionId | null)[]);
  // Fogged tiles show what was last seen there (the live state when the store keeps no memory).
  const mem = safe(() => store.lastSeen?.() ?? null, null);
  const territory = mem ? live.map((o, i) => (visible[i] ? o : mem.territory[i] ?? null)) : live;

  // Territory tint + borders (only where explored).
  for (let i = 0; i < s.tiles.length; i++) {
    const owner = territory[i];
    if (!owner || !explored[i]) continue;
    const h = indexToHex(i, s.width);
    const c = px(h);
    const col = FACTIONS[owner]?.color ?? '#888888';
    hexPath(ctx, c.x, c.z, r);
    ctx.fillStyle = col + '4d';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, g.scale * 0.22);
    for (let d = 0; d < 6; d++) {
      const n = { q: h.q + DIRS[d].q, r: h.r + DIRS[d].r };
      const no = inBounds(n, s.width, s.height) ? territory[tileIndex(n, s.width)] : null;
      if (no === owner) continue;
      const [a, b] = DIR_EDGE[d];
      ctx.beginPath();
      ctx.moveTo(c.x + CORNERS[a].x * g.scale, c.z + CORNERS[a].z * g.scale);
      ctx.lineTo(c.x + CORNERS[b].x * g.scale, c.z + CORNERS[b].z * g.scale);
      ctx.stroke();
    }
  }

  // Fog: unexplored = near-black with faint cloud noise; explored-but-unseen = darkened.
  for (let i = 0; i < s.tiles.length; i++) {
    if (visible[i]) continue;
    const h = indexToHex(i, s.width);
    const c = px(h);
    hexPath(ctx, c.x, c.z, r);
    if (!explored[i]) {
      const n = hash2(h.q >> 1, h.r >> 1, 3) * 0.5 + hash2(h.q, h.r, 11) * 0.5;
      ctx.fillStyle = `rgb(${10 + n * 10},${12 + n * 11},${16 + n * 13})`;
    } else ctx.fillStyle = 'rgba(8,10,14,0.5)';
    ctx.fill();
  }

  // Buildings: live where seen, remembered under the fog.
  const shown: Building[] = [];
  for (const k in s.buildings) {
    const b = s.buildings[k];
    const i = tileIndex(b.pos, s.width);
    if (explored[i] && (!mem || visible[i])) shown.push(b);
  }
  if (mem) for (let i = 0; i < s.tiles.length; i++) {
    const b = mem.buildings[i];
    if (b && explored[i] && !visible[i]) shown.push(b);
  }
  for (const b of shown) {
    const c = px(b.pos);
    const col = b.owner ? FACTIONS[b.owner]?.color ?? '#999999' : '#8d8d8d';
    const castle = b.type === 'castle';
    const sz = g.scale * (castle ? 1.2 : 0.75);
    ctx.fillStyle = b.buildLeft > 0 && !b.upgrading ? 'rgba(20,20,20,0.6)' : col;
    ctx.strokeStyle = castle ? '#f3d98b' : 'rgba(0,0,0,0.75)';
    ctx.lineWidth = castle ? Math.max(1.2, g.scale * 0.28) : 1;
    ctx.beginPath();
    ctx.rect(c.x - sz / 2, c.z - sz / 2, sz, sz);
    ctx.fill();
    ctx.stroke();
  }

  // Units (own always, others only when visible).
  const sel = selectedUnitId(s, store.ui);
  for (const k in s.units) {
    const u = s.units[k];
    if (u.hp <= 0) continue;
    const i = tileIndex(u.pos, s.width);
    if (u.faction !== viewer && !visible[i]) continue;
    const c = px(u.pos);
    const rad = g.scale * (u.isLeader ? 0.62 : 0.48);
    ctx.beginPath();
    ctx.arc(c.x, c.z, rad, 0, Math.PI * 2);
    ctx.fillStyle = FACTIONS[u.faction]?.color ?? '#aaaaaa';
    ctx.fill();
    ctx.lineWidth = u.isLeader ? Math.max(1.2, g.scale * 0.25) : 1;
    ctx.strokeStyle = u.isLeader ? '#f3d98b' : 'rgba(0,0,0,0.85)';
    ctx.stroke();
    if (u.id === sel) {
      ctx.beginPath();
      ctx.arc(c.x, c.z, rad + g.scale * 0.45, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Camera footprint, if the store provides it.
  const fp = safe(() => cameraFootprint(store), null);
  if (fp && fp.length >= 3) {
    // the off-map part of the view is cut at the minimap edge, not pulled into the map
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, g.w, g.h);
    ctx.clip();
    ctx.beginPath();
    fp.forEach((p, i) => {
      const x = (p.x - g.minX) * g.scale, z = (p.z - g.minZ) * g.scale;
      if (i === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,240,200,0.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,240,200,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }
}

export function Minimap() {
  const { store } = useUi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef<{ key: string; base: HTMLCanvasElement | null }>({ key: '', base: null });
  const pending = useRef(0);
  const last = useRef(0);
  const dragging = useRef(false);

  // Throttled redraw after every UI update (state is mutated in place, so no cheap diff).
  const schedule = () => {
    if (pending.current) return;
    const wait = Math.max(0, 120 - (performance.now() - last.current));
    pending.current = window.setTimeout(() => {
      pending.current = 0;
      last.current = performance.now();
      if (canvasRef.current) draw(canvasRef.current, store as FootprintStore, cache.current);
    }, wait);
  };
  useEffect(schedule);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(el);
    // Keep the camera rectangle live while the player pans without other UI changes.
    const fs = store as FootprintStore;
    const fpTimer = fs.cameraFootprint || fs.renderer?.cameraFootprint || fs.renderer?.pickHex ? window.setInterval(schedule, 250) : 0;
    return () => { ro.disconnect(); window.clearTimeout(pending.current); pending.current = 0; if (fpTimer) window.clearInterval(fpTimer); };
  }, [store]);

  const jump = (e: PointerEvent) => {
    const s = store.state;
    const el = canvasRef.current;
    if (!s || !el) return;
    const rect = el.getBoundingClientRect();
    const g = geometry(s, rect.width, 1);
    const x = g.minX + (e.clientX - rect.left) / g.scale;
    const z = g.minZ + (e.clientY - rect.top) / g.scale;
    let h = worldToHex(x, z);
    if (!inBounds(h, s.width, s.height)) {
      // Clamp to the nearest in-bounds hex along the click.
      const col = Math.max(0, Math.min(s.width - 1, Math.round(x / SQRT3)));
      const row = Math.max(0, Math.min(s.height - 1, Math.round(z / 1.5)));
      h = { q: col - (row - (row & 1)) / 2, r: row };
    }
    store.focusHex(h);
  };

  if (!store.state) return null;
  return (
    <div class="minimap panel">
      <canvas ref={canvasRef} class="minimap-canvas"
        onPointerDown={(e) => { dragging.current = true; (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId); jump(e); }}
        onPointerMove={(e) => { if (dragging.current) jump(e); }}
        onPointerUp={(e) => { dragging.current = false; (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
