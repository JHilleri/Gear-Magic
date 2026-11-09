// Dev harness for the world renderer: real map from sim/state.createGame (or a hand-built
// fallback), fog toggles, grid, quality, picking readout. Not part of the shipped game.
import type { GameEvent, GameState, Hex, TerrainId, Tile } from '../core/types';
import { offsetToAxial, tileIndex, neighbors, inBounds } from '../core/hex';
import { TERRAIN } from '../data/terrain';
import { createWorldRenderer } from '../render/world';
import { createGame } from '../sim/state';

const params = new URLSearchParams(location.search);
let seed = Number(params.get('seed') ?? 1234);
const size = (params.get('size') ?? 'normal') as 'small' | 'normal' | 'large';
let revealAll = params.get('reveal') === '1';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const info = document.getElementById('info')!;
const load = document.getElementById('load')!;
const renderer = createWorldRenderer(canvas);
(window as any).renderer = renderer;

function fallbackState(): GameState {
  const W = 34, H = 26, n = W * H;
  const terrains: TerrainId[] = ['grass', 'plains', 'forest', 'hills', 'mountain', 'swamp', 'shallows', 'water', 'crystal', 'ruins'];
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % W, row = Math.floor(i / W);
    const v = Math.sin(col * 0.35) + Math.cos(row * 0.4) + Math.sin((col + row) * 0.2);
    const t = v > 1.6 ? 'mountain' : v > 1.0 ? 'hills' : v > 0.4 ? 'forest' : v > -0.6 ? (col % 7 === 0 ? 'plains' : 'grass') : v > -1.0 ? 'swamp' : v > -1.4 ? 'shallows' : 'water';
    tiles.push({ terrain: (i % 97 === 0 ? terrains[8] : t) as TerrainId, deposit: null, elevation: (Math.sin(i * 12.9898) * 0.5 + 0.5), building: null, variant: i % 13 });
  }
  const fs = (id: 'valen' | 'thorn' | 'neutral', human: boolean) => ({
    id, isHuman: human, alive: true, resources: { gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0 },
    income: { gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0 }, stockpile: {}, techs: [], researching: null,
    researchProgress: 0, spellCooldowns: {}, explored: new Array(n).fill(1), visible: new Array(n).fill(1), farsight: [], leaderId: null, castleId: null,
    stats: { kills: 0, lost: 0, built: 0, researched: 0, spellsCast: 0 },
  });
  return {
    version: 1, settings: { mapSize: 'normal', seed, playerFaction: 'valen', aiCount: 1, difficulty: 'normal' }, width: W, height: H, tiles,
    units: {}, buildings: {}, factions: { valen: fs('valen', true), thorn: fs('thorn', false), neutral: fs('neutral', false) },
    turnOrder: ['valen', 'thorn'], currentTurn: 0, round: 1, nextId: 1, rngState: 1, log: [], winner: null, gameOver: false,
  } as GameState;
}

function makeState(): GameState {
  try {
    return createGame({ mapSize: size, seed, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });
  } catch (e) {
    console.warn('createGame unavailable, using fallback map', e);
    return fallbackState();
  }
}

let state: GameState;
let showGrid = false;
let quality: 'low' | 'high' = 'high';
let savedVisibility: { explored: number[]; visible: number[] } | null = null;

function applyReveal() {
  const f = state.factions.valen;
  if (revealAll) {
    savedVisibility = { explored: f.explored.slice(), visible: f.visible.slice() };
    f.explored.fill(1);
    f.visible.fill(1);
  } else if (savedVisibility) {
    f.explored = savedVisibility.explored.slice();
    f.visible = savedVisibility.visible.slice();
  }
}

function newGame() {
  state = makeState();
  savedVisibility = null;
  applyReveal();
  renderer.setGame(state, 'valen');
  (window as any).state = state;
}

const keys = renderer.keyState;
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyG') toggleGrid();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function toggleGrid() { showGrid = !showGrid; renderer.setOverlays({ showGrid }); }
document.getElementById('grid')!.onclick = toggleGrid;
document.getElementById('reveal')!.onclick = () => { revealAll = !revealAll; applyReveal(); renderer.sync(state); };
document.getElementById('quality')!.onclick = () => { quality = quality === 'high' ? 'low' : 'high'; renderer.setQuality(quality); };
document.getElementById('reseed')!.onclick = () => { seed = (seed * 7919 + 13) % 100000; newGame(); };
document.getElementById('fog')!.onclick = () => {
  // Reveal a growing ring around the player's start to show the fade.
  const f = state.factions.valen;
  const lead = f.leaderId != null ? state.units[String(f.leaderId)] : null;
  if (!lead) return;
  const n = state.width * state.height;
  for (let i = 0; i < n; i++) {
    const h = offsetToAxial(i % state.width, Math.floor(i / state.width));
    const d = (Math.abs(h.q - lead.pos.q) + Math.abs(h.r - lead.pos.r) + Math.abs(h.q + h.r - lead.pos.q - lead.pos.r)) / 2;
    if (d <= 7 + Math.floor(Math.random() * 3)) f.explored[i] = 1;
    f.visible[i] = d <= 5 ? 1 : 0;
  }
  renderer.sync(state);
};
document.getElementById('events')!.onclick = async () => {
  // Move the leader one step back and forth (exercises playEvents with whatever layers exist).
  const f = state.factions.valen;
  const lead = f.leaderId != null ? state.units[String(f.leaderId)] : null;
  if (!lead) return;
  const to = neighbors(lead.pos).find((h) => inBounds(h, state.width, state.height) && TERRAIN[state.tiles[tileIndex(h, state.width)].terrain].moveCost < 3);
  if (!to) return;
  lead.pos = to;
  const evs: GameEvent[] = [{ type: 'unitMoved', unit: lead.id, path: [to] }];
  await renderer.playEvents(state, evs, 1);
};

canvas.addEventListener('pointermove', (e) => {
  const h: Hex | null = renderer.pickHex(e.clientX, e.clientY);
  if (!h || !state) { info.textContent = ''; return; }
  const t = state.tiles[tileIndex(h, state.width)];
  const s = renderer.hexToScreen(h);
  info.textContent = `hex ${h.q},${h.r}  ${t.terrain}${t.deposit ? ' (' + t.deposit + ')' : ''}  elev ${t.elevation.toFixed(2)}\nscreen ${s.x.toFixed(0)},${s.y.toFixed(0)} ${s.visible ? 'on' : 'off'}`;
  renderer.setOverlays({ hoverHex: h });
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const h = renderer.pickHex(e.clientX, e.clientY);
  if (h) renderer.focus(h);
});

const t0 = performance.now();
await renderer.init((f, label) => { load.textContent = `${label} — ${Math.round(f * 100)}%`; });
newGame();
load.remove();
console.log(`world ready in ${Math.round(performance.now() - t0)} ms`);

// tiny FPS readout
let frames = 0, lastT = performance.now();
const fpsEl = document.createElement('div');
document.getElementById('hud')!.appendChild(fpsEl);
const tick = () => {
  frames++;
  const now = performance.now();
  if (now - lastT > 1000) { fpsEl.textContent = `${Math.round((frames * 1000) / (now - lastT))} fps`; frames = 0; lastT = now; }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
