// UI workbench (dev/ui.html, port 5193): a mock GameStore around a real GameState, a flat 2D
// hex view standing in for the 3D renderer, and a dev bar to open every screen and modal.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type {
  Action, ActionResult, ActiveId, AttackKind, Building, BuildingId, BuildingInstanceId, CombatForecast, FactionId, GameSettings, GameState, Hex,
  SpellId, Unit, UnitId, UnitOrder,
} from '../core/types';
import type { GameStore, ModalId, Toast, UiSettings, UiState } from '../game/store';
import { hexToWorld, inBounds, indexToHex, neighbors, spiral, tileIndex, worldToHex } from '../core/hex';
import { FACTIONS } from '../data/factions';
import { TERRAIN } from '../data/terrain';
import { BUILDINGS } from '../data/buildings';
import { applyAction, attackTargets, idleUnits } from '../sim/actions';
import { forecastCombat } from '../sim/combat';
import { reachable } from '../sim/pathfinding';
import { rollLevelOptions } from '../sim/progression';
import { createGame, deserialize, serialize } from '../sim/state';
import { createUnit } from '../sim/units';
import { computeAllVisibility } from '../sim/visibility';
import { mountUi } from '../ui/App';
import type { AssetLibrary, AssetManifest } from '../render/types';

const SQRT3 = Math.sqrt(3);
const SAVE_KEY = 'ui-dev-save';

// ───────────────────────────── dev scene ─────────────────────────────
function freeAround(s: GameState, center: Hex, ok: (h: Hex) => boolean): Hex | null {
  for (const h of spiral(center, 4)) {
    if (!inBounds(h, s.width, s.height)) continue;
    const t = s.tiles[tileIndex(h, s.width)];
    if (t.building != null) continue;
    if (Object.values(s.units).some((u) => u.pos.q === h.q && u.pos.r === h.r)) continue;
    if (ok(h)) return h;
  }
  return null;
}

function addBuilding(s: GameState, type: BuildingId, owner: FactionId, pos: Hex, opts: Partial<Building> = {}): Building {
  const id = s.nextId++;
  const b: Building = { id, type, owner, pos, level: 1, buildLeft: 0, upgrading: false, recruitedThisTurn: false, craftedThisTurn: 0, foundedRound: 0, ...opts };
  s.buildings[String(id)] = b;
  s.tiles[tileIndex(pos, s.width)].building = id;
  return b;
}

/** A real game, then enriched so every panel has something to show. */
function devScene(seed: number): GameState {
  const settings: GameSettings = { mapSize: 'small', seed, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' };
  const s = createGame(settings);
  const me = s.factions.valen;
  me.techs = ['mining', 'tanning', 'polearms', 'crystallore', 'arcana', 'writing', 'shieldcraft', 'spell_heal', 'spell_fireball', 'wandcraft'];
  me.researching = 'masonry';
  me.researchProgress = 22;
  Object.assign(me.resources, { gold: 142, food: 38, wood: 61, stone: 44, iron: 17, crystal: 12, mana: 46 });
  me.stockpile = { sword: 2, shield: 1, leather: 2, bow: 1, robe: 1, staff: 1, spear: 1 };
  me.spellCooldowns = { fireball: 1 };
  me.stats = { kills: 4, lost: 1, built: 5, researched: 10, spellsCast: 3 };

  const castle = s.buildings[String(me.castleId)];
  const leader = s.units[String(me.leaderId)];
  const open = (h: Hex) => ['grass', 'plains'].includes(s.tiles[tileIndex(h, s.width)].terrain);
  const land = (h: Hex) => TERRAIN[s.tiles[tileIndex(h, s.width)].terrain].buildable;
  const forgeHex = freeAround(s, castle.pos, open);
  if (forgeHex) addBuilding(s, 'forge', 'valen', forgeHex);
  const towerHex = freeAround(s, castle.pos, land);
  if (towerHex) addBuilding(s, 'magetower', 'valen', towerHex, { level: 2 });
  const libHex = freeAround(s, castle.pos, open);
  if (libHex) {
    addBuilding(s, 'library', 'valen', libHex, { buildLeft: 1.4 });
    const builder = Object.values(s.units).find((u) => u.faction === 'valen' && u.equipment.main === 'tools');
    if (builder) builder.pos = libHex;
  }

  // An archer with a pending level-up.
  const commoner = Object.values(s.units).find((u) => u.faction === 'valen' && !u.isLeader && u.equipment.main !== 'tools');
  if (commoner) {
    commoner.equipment.main = 'bow';
    commoner.equipment.body = 'leather';
    commoner.level = 3;
    commoner.xp = 31;
    commoner.levelXpByCat = { melee: 0, ranged: 24, building: 0, civic: 2, explore: 9, leader: 0, magic: 0 };
    commoner.xpByCat = { melee: 4, ranged: 57, building: 2, civic: 4, explore: 22, leader: 0, magic: 0 };
    commoner.pendingLevelUps = 1;
    let opts: string[] = ['stat_dex', 'eff_ranged', 'active_volley'];
    try { opts = rollLevelOptions(s, commoner); } catch { /* keep fallback */ }
    commoner.levelUpOptions = [opts];
    commoner.passives = ['marksman'];
  }
  // A knight next to the leader with skills and a blessing.
  const kHex = freeAround(s, leader.pos, open);
  if (kHex) {
    const k = createUnit(s, { faction: 'valen', pos: kHex, preset: 'knight', name: 'Ser Garrick' });
    k.level = 4; k.xp = 40; k.base.maxHp += 12; k.hp = k.base.maxHp - 9;
    k.levelXpByCat = { melee: 30, ranged: 0, building: 0, civic: 0, explore: 6, leader: 4, magic: 0 };
    k.passives = ['leadership', 'ironskin'];
    k.actives = ['powerstrike', 'rally', 'masonry'];
    k.cooldowns = { rally: 2 };
    k.efficiency = { attack: 1.25 };
    k.buffs = [{ id: 'bless', turns: 2, damageMult: 1.2, armor: 10 }];
    // An orc raider right next to him for forecasts.
    const eHex = freeAround(s, kHex, (h) => TERRAIN[s.tiles[tileIndex(h, s.width)].terrain].moveCost < 9);
    if (eHex) {
      const e = createUnit(s, { faction: 'thorn', pos: eHex, preset: 'swordsman', name: 'Urzog' });
      e.equipment.main = 'axe';
      e.level = 2;
    }
  }
  const mHex = towerHex ?? freeAround(s, leader.pos, land);
  if (mHex) {
    const m = createUnit(s, { faction: 'valen', pos: mHex, preset: 'battlemage', name: 'Ysolde' });
    m.level = 2; m.xp = 12; m.actives = ['firebolt']; m.poisoned = true;
    m.levelXpByCat = { melee: 2, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 10 };
  }
  for (const f of s.turnOrder) s.factions[f].explored.fill(1);
  try { computeAllVisibility(s); } catch { /* fog stays as created */ }
  const logs: [string, GameState['log'][number]['kind'], FactionId | null][] = [
    ['The war for the vale begins.', 'info', null],
    ['Ser Garrick strikes Urzog for 18 damage.', 'combat', 'valen'],
    ['Farm completed.', 'build', 'valen'],
    ['Research complete: Arcana.', 'research', 'valen'],
    ['Ysolde casts Fireball.', 'magic', 'valen'],
    ['Food stores are running low!', 'warning', 'valen'],
    ['Edric reached level 3!', 'levelup', 'valen'],
    ['The Thornwild Clans raze a watchtower.', 'combat', 'thorn'],
    ['Lich-Lord Morvain raises a Mage Tower.', 'build', 'ashen'],
  ];
  for (const [text, kind, faction] of logs) s.log.push({ round: s.round, faction, text, kind });
  return s;
}

// ───────────────────────────── mock store ─────────────────────────────
const DEFAULT_SETTINGS: UiSettings = { volume: 0.7, music: true, showGrid: true, animSpeed: 1, edgePan: false, quality: 'high', watchEnemyMoves: 'nearby' };

class MockStore implements GameStore {
  state: GameState | null = null;
  ui: UiState = {
    screen: 'loading', loadingProgress: 0, loadingLabel: 'Forging terrain textures…', modal: null, mode: { kind: 'idle' },
    selectedHex: null, hoverHex: null, reach: [], forecast: null, forecastTarget: null, forecastFrom: null, forecastAlt: null,
    effectPreview: null, effectError: null, hoverToward: null, busy: false, aiThinking: null, toasts: [],
    settings: { ...DEFAULT_SETTINGS }, recruitSite: null, forgeSite: null, levelUpUnit: null, hasSave: false,
    saves: { manual: null, auto: null }, skippedUnits: [], turnView: null, modalReturn: null, lastSetup: null,
  };
  private subs = new Set<() => void>();
  private toastId = 0;
  cameraCenter: Hex = { q: 6, r: 6 };

  constructor() {
    try { this.ui.hasSave = !!localStorage.getItem(SAVE_KEY); } catch { /* no storage */ }
  }
  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  notify() { this.subs.forEach((f) => f()); }
  set(p: Partial<UiState>) { this.ui = { ...this.ui, ...p }; this.notify(); }

  /** Footprint for the minimap: an approximate 16×10 world-unit view around the camera centre. */
  cameraFootprint() {
    const c = hexToWorld(this.cameraCenter);
    return [{ x: c.x - 9, z: c.z - 6 }, { x: c.x + 9, z: c.z - 6 }, { x: c.x + 11, z: c.z + 6 }, { x: c.x - 11, z: c.z + 6 }];
  }

  newGame(settings: GameSettings) {
    const s = devScene(settings.seed);
    s.settings = { ...s.settings, ...settings };
    this.state = s;
    const leader = s.units[String(s.factions.valen.leaderId)];
    this.cameraCenter = leader.pos;
    this.set({ screen: 'game', modal: null, mode: { kind: 'idle' }, selectedHex: null, reach: [], forecast: null });
  }
  saveGame() {
    if (!this.state) return;
    try { localStorage.setItem(SAVE_KEY, serialize(this.state)); this.set({ hasSave: true }); this.toast('Game saved', 'good'); } catch { this.toast('Saving failed', 'bad'); }
  }
  loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      this.state = deserialize(raw);
      this.set({ screen: 'game', modal: null, mode: { kind: 'idle' } });
      return true;
    } catch { return false; }
  }
  quitToTitle() { this.state = null; this.set({ screen: 'title', modal: null, mode: { kind: 'idle' }, selectedHex: null }); }
  retryLastTurn() { this.loadGame(); }
  skipUnit() {
    const m = this.ui.mode;
    if (m.kind === 'unit') this.set({ skippedUnits: [...this.ui.skippedUnits, m.unit] });
    this.nextIdleUnit();
  }
  requestEndTurn() {
    if (this.state?.gameOver) { if (!this.ui.modal) this.openModal('end'); return; }
    void this.endTurn();
  }

  selectUnit(id: UnitId | null) {
    const s = this.state;
    if (!s || id == null) { this.set({ mode: { kind: 'idle' }, reach: [], forecast: null, forecastTarget: null }); return; }
    const u = s.units[String(id)];
    if (!u) return;
    let reach: UiState['reach'] = [];
    if (u.faction === 'valen') { try { reach = reachable(s, u); } catch { /* */ } }
    this.set({ mode: { kind: 'unit', unit: id }, selectedHex: u.pos, reach, forecast: null, forecastTarget: null });
  }
  async selectHex(h: Hex | null) {
    const s = this.state;
    if (!s || !h) { this.set({ selectedHex: null, mode: { kind: 'idle' }, reach: [] }); return; }
    const m = this.ui.mode;
    const here = Object.values(s.units).find((u) => u.pos.q === h.q && u.pos.r === h.r);
    if (m.kind === 'cast') { await this.dispatch({ type: 'cast', faction: 'valen', spell: m.spell, tower: m.tower ?? Number(Object.values(s.buildings).find((b) => b.type === 'magetower' && b.owner === 'valen')?.id), target: h }); this.set({ mode: { kind: 'idle' } }); return; }
    if (m.kind === 'skill') { await this.dispatch({ type: 'skill', unit: m.unit, skill: m.skill, target: h }); this.set({ mode: { kind: 'unit', unit: m.unit } }); return; }
    if (m.kind === 'unit') {
      const sel = s.units[String(m.unit)];
      if (sel && sel.faction === 'valen') {
        if (here && here.faction !== 'valen' && this.ui.forecastTarget === here.id && this.ui.forecast) {
          await this.dispatch({ type: 'attack', unit: sel.id, target: here.id, kind: this.ui.forecast.attacker.kind });
          return;
        }
        if (!here && this.ui.reach.some((r) => r.hex.q === h.q && r.hex.r === h.r)) {
          await this.dispatch({ type: 'move', unit: sel.id, to: h });
          this.selectUnit(sel.id);
          return;
        }
      }
    }
    if (here) { this.selectUnit(here.id); return; }
    this.set({ selectedHex: h, mode: { kind: 'idle' }, reach: [], forecast: null, forecastTarget: null });
  }
  hover(h: Hex | null) {
    const s = this.state;
    if (!s) return;
    if (h && this.ui.hoverHex && h.q === this.ui.hoverHex.q && h.r === this.ui.hoverHex.r) return;
    let forecast: CombatForecast | null = null;
    let target: UnitId | null = null;
    const m = this.ui.mode;
    if (h && m.kind === 'unit') {
      const sel = s.units[String(m.unit)];
      const t = Object.values(s.units).find((u) => u.pos.q === h.q && u.pos.r === h.r);
      if (sel && t && sel.faction === 'valen' && t.faction !== 'valen') {
        let kinds: AttackKind[] = [];
        try { kinds = attackTargets(s, sel).find((a) => a.unit === t.id)?.kinds ?? []; } catch { /* */ }
        if (kinds.length) { try { forecast = forecastCombat(s, sel, t, kinds[0]); target = t.id; } catch { /* */ } }
      }
    }
    this.set({ hoverHex: h, forecast, forecastTarget: target });
  }
  nextIdleUnit() {
    const s = this.state;
    if (!s) return;
    let ids: UnitId[] = [];
    try { ids = idleUnits(s); } catch { /* */ }
    if (!ids.length) return;
    const cur = this.ui.mode.kind === 'unit' ? ids.indexOf(this.ui.mode.unit) : -1;
    const id = ids[(cur + 1) % ids.length];
    this.selectUnit(id);
    this.focusHex(s.units[String(id)].pos);
  }
  async dispatch(action: Action): Promise<ActionResult> {
    const s = this.state;
    if (!s) return { ok: false, error: 'No game', events: [] };
    let r: ActionResult;
    try { r = applyAction(s, action); } catch (e) { r = { ok: false, error: String(e), events: [] }; }
    if (!r.ok) this.toast(r.error ?? 'Not possible', 'warning');
    if (r.ok && action.type === 'levelup') {
      const u = s.units[String(action.unit)];
      if (u && u.pendingLevelUps === 0 && this.ui.modal === 'levelup') this.closeModal();
    }
    if (this.ui.mode.kind === 'unit') this.selectUnit(this.ui.mode.unit); else this.notify();
    return r;
  }
  async endTurn() {
    const s = this.state;
    if (!s || this.ui.busy) return;
    this.set({ busy: true, mode: { kind: 'idle' }, reach: [], forecast: null });
    try { applyAction(s, { type: 'endTurn', faction: 'valen' }); } catch (e) { console.warn(e); }
    // Stand-in AI: show the indicator for each rival, then pass.
    for (let guard = 0; guard < 4 && s.turnOrder[s.currentTurn] !== 'valen' && !s.gameOver; guard++) {
      const f = s.turnOrder[s.currentTurn];
      this.set({ aiThinking: FACTIONS[f].name });
      await new Promise((res) => setTimeout(res, 900));
      try { applyAction(s, { type: 'endTurn', faction: f }); } catch (e) { console.warn(e); break; }
    }
    this.set({ busy: false, aiThinking: null });
  }
  beginCast(spell: SpellId) {
    const tower = this.state ? Object.values(this.state.buildings).find((b) => b.type === 'magetower' && b.owner === 'valen') : undefined;
    this.set({ mode: { kind: 'cast', spell, tower: tower?.id ?? null }, modal: null });
  }
  beginSkill(unit: UnitId, skill: ActiveId) {
    const s = this.state!;
    if (['powerstrike', 'rally', 'fortify'].includes(skill)) { void this.dispatch({ type: 'skill', unit, skill }); return; }
    void s;
    this.set({ mode: { kind: 'skill', unit, skill }, modal: null });
  }
  beginAttack(unit: UnitId) {
    this.set({ mode: { kind: 'attack', unit }, modal: null });
  }
  giveOrder(unit: UnitId, order: UnitOrder | null) {
    void this.dispatch({ type: 'order', unit, order });
  }
  cancelMode() {
    const m = this.ui.mode;
    if (m.kind === 'skill' || m.kind === 'attack') this.set({ mode: { kind: 'unit', unit: m.unit } });
    else this.set({ mode: { kind: 'idle' }, reach: [], forecast: null });
  }
  openModal(m: ModalId, opts?: { site?: BuildingInstanceId; unit?: UnitId }) {
    const p: Partial<UiState> = { modal: m, modalReturn: this.ui.modal === 'menu' && (m === 'settings' || m === 'help') ? 'menu' : null };
    const s = this.state;
    if (m === 'recruit') p.recruitSite = opts?.site ?? (s ? s.factions.valen.castleId : null);
    if (m === 'forge') p.forgeSite = opts?.site ?? null;
    if (m === 'levelup') p.levelUpUnit = opts?.unit ?? null;
    if (m === 'unitsheet') p.sheetUnit = opts?.unit ?? null;
    if ((m === 'equip' || m === 'build') && opts?.unit != null && s) { p.mode = { kind: 'unit', unit: opts.unit }; p.selectedHex = s.units[String(opts.unit)]?.pos ?? null; }
    this.set(p);
  }
  closeModal() {
    const back = this.ui.modalReturn === 'menu' && (this.ui.modal === 'settings' || this.ui.modal === 'help') && this.state ? 'menu' : null;
    this.set({ modal: back, modalReturn: null });
  }
  toast(text: string, kind: Toast['kind'] = 'info') {
    const now = Date.now();
    const t: Toast = { id: ++this.toastId, text, kind, until: now + 3500 };
    this.set({ toasts: [...this.ui.toasts.filter((x) => x.until > now), t].slice(-5) });
    setTimeout(() => this.set({ toasts: this.ui.toasts.filter((x) => x.until > Date.now()) }), 3600);
  }
  focusHex(h: Hex) { this.cameraCenter = h; this.notify(); }
  setSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]) { this.set({ settings: { ...this.ui.settings, [key]: value } }); }
}

// ───────────────────────────── flat map view (stands in for the renderer) ─────────────────────────────
function mapView(canvas: HTMLCanvasElement, store: MockStore): void {
  const ctx = canvas.getContext('2d')!;
  const size = 34; // px per hex radius
  const view = () => {
    const c = hexToWorld(store.cameraCenter);
    return { ox: canvas.width / 2 - c.x * size, oz: canvas.height / 2 - c.z * size };
  };
  const toHex = (x: number, y: number): Hex | null => {
    const s = store.state;
    if (!s) return null;
    const v = view();
    const h = worldToHex((x - v.ox) / size, (y - v.oz) / size);
    return inBounds(h, s.width, s.height) ? h : null;
  };
  const draw = () => {
    canvas.width = innerWidth; canvas.height = innerHeight;
    const s = store.state;
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!s) return;
    const v = view();
    const reach = new Set(store.ui.reach.map((r) => `${r.hex.q},${r.hex.r}`));
    for (let i = 0; i < s.tiles.length; i++) {
      const h = indexToHex(i, s.width);
      const w = hexToWorld(h);
      const x = v.ox + w.x * size, z = v.oz + w.z * size;
      if (x < -60 || z < -60 || x > canvas.width + 60 || z > canvas.height + 60) continue;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 30);
        const px = x + Math.cos(a) * size, pz = z + Math.sin(a) * size;
        if (k === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
      }
      ctx.closePath();
      ctx.fillStyle = TERRAIN[s.tiles[i].terrain].color;
      ctx.fill();
      if (!s.factions.valen.visible[i]) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill(); }
      if (reach.has(`${h.q},${h.r}`)) { ctx.fillStyle = 'rgba(255,240,190,0.22)'; ctx.fill(); }
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
      const sel = store.ui.selectedHex;
      if (sel && sel.q === h.q && sel.r === h.r) { ctx.strokeStyle = '#f3d98b'; ctx.lineWidth = 3; ctx.stroke(); }
    }
    for (const b of Object.values(s.buildings)) {
      const w = hexToWorld(b.pos);
      const x = v.ox + w.x * size, z = v.oz + w.z * size;
      ctx.fillStyle = b.owner ? FACTIONS[b.owner].color : '#888';
      ctx.fillRect(x - 13, z - 13, 26, 26);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(BUILDINGS[b.type].name.slice(0, 4), x, z + 4);
    }
    for (const u of Object.values(s.units)) {
      const i = tileIndex(u.pos, s.width);
      if (u.faction !== 'valen' && !s.factions.valen.visible[i]) continue;
      const w = hexToWorld(u.pos);
      const x = v.ox + w.x * size + 9, z = v.oz + w.z * size + 9;
      ctx.beginPath(); ctx.arc(x, z, 11, 0, Math.PI * 2);
      ctx.fillStyle = FACTIONS[u.faction].color; ctx.fill();
      ctx.strokeStyle = u.isLeader ? '#f3d98b' : '#000'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(u.name.slice(0, 2), x, z + 4);
    }
  };
  store.subscribe(() => requestAnimationFrame(draw));
  addEventListener('resize', draw);
  canvas.addEventListener('pointermove', (e) => store.hover(toHex(e.clientX, e.clientY)));
  canvas.addEventListener('click', (e) => void store.selectHex(toHex(e.clientX, e.clientY)));
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); store.cancelMode(); });
  addEventListener('keydown', (e) => {
    const c = store.cameraCenter;
    const d: Record<string, Hex> = { w: { q: 0, r: -1 }, s: { q: 0, r: 1 }, a: { q: -1, r: 0 }, d: { q: 1, r: 0 } };
    if (d[e.key]) { store.focusHex({ q: c.q + d[e.key].q, r: c.r + d[e.key].r }); }
    if (e.key === ' ' && store.ui.screen === 'game' && !store.ui.modal) { e.preventDefault(); store.requestEndTurn(); }
    if (e.key === 'Tab') { e.preventDefault(); store.nextIdleUnit(); }
    if (e.key === 'Escape' && !store.ui.modal && store.ui.screen === 'game') {
      if (store.ui.mode.kind !== 'idle') store.cancelMode(); else store.openModal('menu');
    }
  });
  draw();
}

// ───────────────────────────── dev bar ─────────────────────────────
function DevBar({ store }: { store: MockStore }) {
  const [, setT] = useState(0);
  const [open, setOpen] = useState(true);
  useEffect(() => store.subscribe(() => setT((t) => t + 1)), []);
  const modals: ModalId[] = ['newgame', 'research', 'spellbook', 'forge', 'recruit', 'levelup', 'equip', 'build', 'help', 'settings', 'menu', 'end', 'unitsheet'];
  const firstOwn = (pred: (u: Unit) => boolean) => store.state ? Object.values(store.state.units).find((u) => u.faction === 'valen' && pred(u)) : undefined;
  const btn = (label: string, fn: () => void) => <button onClick={fn} style={{ margin: 2, padding: '2px 6px', font: '11px monospace', background: '#222', color: '#ddd', border: '1px solid #555', borderRadius: 3, cursor: 'pointer' }}>{label}</button>;
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 4, transform: 'translateX(-50%)', zIndex: 5000, background: 'rgba(0,0,0,0.82)', padding: 4, borderRadius: 6, maxWidth: '62vw', pointerEvents: 'auto', font: '11px monospace', color: '#aaa' }}>
      {btn(open ? '▾ dev' : '▴ dev', () => setOpen(!open))}
      {open && <>
        {btn('loading', () => { store.set({ screen: 'loading', loadingProgress: 0.62 }); })}
        {btn('title', () => store.quitToTitle())}
        {btn('game', () => store.newGame({ mapSize: 'small', seed: 7, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' }))}
        {modals.map((m) => btn(m!, () => {
          if (m === 'equip' || m === 'build') {
            const u = m === 'build' ? firstOwn((x) => x.equipment.main === 'tools') : firstOwn((x) => x.isLeader);
            store.openModal(m, { unit: u?.id });
          } else store.openModal(m);
        }))}
        {btn('knight', () => { const u = firstOwn((x) => x.name === 'Ser Garrick'); if (u) store.selectUnit(u.id); })}
        {btn('archer', () => { const u = firstOwn((x) => x.equipment.main === 'bow'); if (u) store.selectUnit(u.id); })}
        {btn('mage', () => { const u = firstOwn((x) => x.equipment.main === 'staff'); if (u) store.selectUnit(u.id); })}
        {btn('forecast', () => {
          const s = store.state; const k = firstOwn((x) => x.name === 'Ser Garrick'); if (!s || !k) return;
          store.selectUnit(k.id);
          const e = Object.values(s.units).find((u) => u.faction === 'thorn' && neighbors(k.pos).some((n) => n.q === u.pos.q && n.r === u.pos.r));
          if (e) store.hover(e.pos);
        })}
        {btn('busy/ai', () => store.set({ busy: !store.ui.aiThinking, aiThinking: store.ui.aiThinking ? null : 'Thornwild Clans' }))}
        {btn('toasts', () => { store.toast('Research complete: Arcana', 'good'); store.toast('Not enough iron', 'warning'); store.toast('Your farm was captured!', 'bad'); store.toast('Choose a target for Fireball', 'info'); })}
        {btn('banner', () => { if (store.state) { store.state.round++; store.notify(); } })}
        {btn('cast', () => store.beginCast('fireball'))}
        {btn('victory', () => { if (store.state) { store.state.winner = 'valen'; store.state.gameOver = true; store.openModal('end'); } })}
        {btn('defeat', () => { if (store.state) { store.state.winner = null; store.state.gameOver = true; store.state.factions.valen.alive = false; store.state.factions.valen.eliminatedBy = 'thorn'; store.openModal('end'); } })}
      </>}
    </div>
  );
}

// ───────────────────────────── boot ─────────────────────────────
if (location.search.includes('noanim')) {
  // Screenshot mode: background tabs pause animations mid-way, so turn them off.
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
  document.head.appendChild(st);
}
const store = new MockStore();
(window as unknown as { __dev: MockStore }).__dev = store;
// Light asset library: icon/portrait lookups from manifest.json (no models), like render/assets.
let devAssets: AssetLibrary | null = null;
void fetch('/assets/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((m: Partial<AssetManifest> | null) => {
  const manifest = { units: {}, items: {}, mounts: {}, buildings: {}, props: {}, monsters: {}, textures: {}, icons: {}, portraits: {}, ...(m && typeof m === 'object' ? m : {}) } as AssetManifest;
  const look = (sec: Record<string, string>, key: string) => { const hit = sec[key] ?? sec[key.replace(/\.(png|jpg)$/i, '')]; return hit ? '/assets/' + hit.replace(/^\/+/, '') : null; };
  devAssets = {
    manifest, model: () => null, skinned: () => null, texture: () => null,
    iconUrl: (k) => look(manifest.icons, k), portraitUrl: (k) => look(manifest.portraits, k),
  };
  store.notify();
});
mountUi(document.getElementById('ui-root')!, store, () => devAssets);
mapView(document.getElementById('scene') as HTMLCanvasElement, store);
const bar = document.createElement('div');
document.body.appendChild(bar);
if (!location.search.includes('nobar')) render(<DevBar store={store} />, bar);

// Simulated asset loading, then the title screen (or straight into a game with ?game).
let p = 0;
const labels = ['Forging terrain textures…', 'Raising castles…', 'Rigging the soldiers…', 'Brewing aether…'];
const timer = setInterval(() => {
  p = Math.min(1, p + 0.09);
  store.set({ loadingProgress: p, loadingLabel: labels[Math.min(labels.length - 1, Math.floor(p * labels.length))] });
  if (p >= 1) {
    clearInterval(timer);
    if (location.search.includes('game')) store.newGame({ mapSize: 'small', seed: 7, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });
    else store.set({ screen: 'title' });
  }
}, location.search.includes('fast') ? 10 : 160);
