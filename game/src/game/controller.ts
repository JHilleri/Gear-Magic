// Implements GameStore: owns GameState, input → actions → animated events, AI turns, saves.
// All state mutation goes through sim/actions.applyAction (and sim/turn inside the end-turn
// flow); the renderer and the UI only ever read.
import type {
  Action, ActionResult, ActiveId, BuildingInstanceId, CombatForecast, EffectPreview, FactionId, GameEvent, GameSettings,
  GameState, Hex, LogEntry, ReachInfo, SpellId, Unit, UnitId, UnitOrder,
} from '../core/types';
import { hexDistance, hexEq, inBounds } from '../core/hex';
import type { GameStore, InteractionMode, LastSeenMap, ModalId, NewGameSetup, Toast, UiSettings, UiState } from './store';
import { FogMemory } from './fogmemory';
import { beatDependencies, splitBeats, type OverlayState, type PlaybackPlan, type PlaybackStep, type WorldRenderer } from '../render/index';
import { DEFAULT_RUN_SPEED, FOOT_SPEED, RUN_CYCLE, walkTimeScale } from '../render/types';
import { applyAction, attackTargets, idleUnits } from '../sim/actions';
import { availableAttackKinds, canAttack, forecastCombat, tileDefense } from '../sim/combat';
import { moveCost, pathCost, pathTowards, reachable, truncatePathToMp } from '../sim/pathfinding';
import { canUseSkill, NO_SKILL_TARGET, previewSkill, skillBlocker, skillTargets } from '../sim/skills';
import { orderEndText, orderWakeWarning } from '../sim/orders';
import { canCast, knownSpells, previewSpell, towerRange, towersInRange } from '../sim/spells';
import {
  buildingAt, buildingsOf, createGame, currentFaction, deserialize, getBuilding, getUnit, serialize, unitAt, unitsOf,
} from '../sim/state';
import { endTurn as simEndTurn, startTurn } from '../sim/turn';
import { isFunctional } from '../sim/ruleutil';
import { canBuildWith, effectiveStats, getAttackDefs } from '../sim/units';
import { canUpgrade } from '../sim/economy';
import { computeVisibility, isExplored, isVisible } from '../sim/visibility';
import { aiNextAction, createAiMemory, type AiMemory } from '../sim/ai/index';
import { ACTIVES } from '../data/skills';
import { SPELLS } from '../data/spells';
import { FACTIONS } from '../data/factions';
import { BUILDINGS } from '../data/buildings';
import { TECHS } from '../data/research';
import { ITEMS } from '../data/items';
import {
  actionKey, altAttackOf, barSkills, buildMenuBlock, chooseAttackKind, cycleNext, effectAreaTone, END_TURN_GRACE_AFTER_FF_MS, END_TURN_GRACE_MS,
  endTurnAllowed, friendlyFire, hotkeyModalAction, levelUpsToOffer, pickApproach, resolveClick, returnTarget, skillSlotOf,
  type ApproachCandidate, type ClickIntent, type KeyCommand, type KindOption,
} from './interaction';
import { eliminationNotice, skippedOutcomeToasts } from './notices';
import { stuckTrip, type TowardPlan } from './trip';
import { unitsAwaitingOrders } from './duty';
import {
  deleteSave, hasSavedGame, loadGameState, loadSettings, saveGameState, saveInfo, savesInfo, saveSettings, type ExtraPrefs, type SaveSlot,
} from './session';
import { attachInput } from './input';
import { createDebugOverlay, type DebugOverlay } from './debug';
import { audio, playSfx, type SfxName } from '../audio/sfx';
import { music } from '../audio/music';

/** Controller API beyond GameStore, used by main.ts and input.ts. */
export interface GameController extends GameStore {
  setLoading(fraction: number, label: string): void;
  /** Assets are loaded: leave the loading screen. */
  ready(): void;
  hover(h: Hex | null): void;
  click(h: Hex | null, button: 'left' | 'right'): void;
  setShift(down: boolean): void;
  command(c: KeyCommand): void;
  readonly renderer: WorldRenderer;
  /** Debug: show the whole map. */
  setRevealMap(on: boolean): void;
  readonly revealMap: boolean;
}

// Timings of the renderer's animations at speed 1 (render/units.ts, render/fx.ts), used to
// place sounds on the playback timeline.
const HEX_STEP = Math.sqrt(3);   // world distance between neighbouring hex centres
const COMBAT_LEAD = 0.2;         // face each other before the first blow
const COMBAT_TAIL = 0.15;
const DEATH_TIME = 2.4;          // death clip + dissolve
const SKILL_TIME = 1.25;         // most skills play the 1.2 s cast clip
const SPAWN_TIME = 0.7;
const CONSTRUCT_TIME = 0.9;
const DESTROY_TIME = 1.0;

/** What the sound timeline needs to know about a unit (cached: dead units vanish from state). */
interface UnitLook { name: string; faction: FactionId; pos: Hex; monster?: Unit['monster']; mounted: boolean; main: Unit['equipment']['main'] }
function lookOf(u: Unit): UnitLook {
  return { name: u.name, faction: u.faction, pos: { ...u.pos }, monster: u.monster, mounted: !!u.equipment.mount, main: u.equipment.main };
}
/** On foot: one footfall sound per GLB run cycle (time-scaled to keep the feet planted). */
const FOOT_STEP = RUN_CYCLE / walkTimeScale(FOOT_SPEED, DEFAULT_RUN_SPEED);

/** World units per second and seconds per footstep while walking (mirrors animateMove). */
function gait(l: UnitLook | undefined): { speed: number; step: number; pitch: number; gain: number } {
  if (!l) return { speed: FOOT_SPEED, step: FOOT_STEP, pitch: 1, gain: 0.75 };
  switch (l.monster) {
    case 'wolf': return { speed: 2.9, step: 0.16, pitch: 1.35, gain: 0.45 };
    case 'spider': return { speed: 2.4, step: 0.12, pitch: 1.6, gain: 0.35 };
    case 'golem': case 'elemental': return { speed: 1.5, step: 0.45, pitch: 0.55, gain: 1.1 };
    default: break;
  }
  return l.mounted ? { speed: 2.9, step: 0.2, pitch: 0.7, gain: 0.9 } : { speed: FOOT_SPEED, step: FOOT_STEP, pitch: 1, gain: 0.75 };
}

/** Seconds from strike start to impact, and the strike's total length (mirrors units.strike). */
function strikeTiming(l: UnitLook | undefined, kind: 'melee' | 'ranged' | 'magic', dist: number): { impact: number; total: number; release: number } {
  if (l?.monster) {
    const dur = l.monster === 'golem' || l.monster === 'elemental' ? 0.85 : 0.62;
    return { impact: dur * 0.45, total: dur + 0.15, release: 0 };
  }
  if (kind === 'melee') {
    const thrust = l?.main === 'spear' || l?.main === 'staff';
    const punch = !l?.main || l.main === 'tools' || l.main === 'wand' || l.main === 'bow';
    const dur = l?.mounted ? 1.0 : punch ? 0.75 : thrust ? 0.9 : 1.0;
    const imp = l?.mounted ? 0.46 : thrust || punch ? 0.42 : 0.46;
    return { impact: dur * imp, total: dur * imp + dur * (1 - imp) * 0.6, release: 0 };
  }
  const dur = kind === 'magic' ? 1.2 : 1.1;
  const imp = kind === 'magic' ? 0.55 : 0.6;
  const d = dist * HEX_STEP + 0.3;
  const flight = kind === 'magic' ? 0.2 + d * 0.075 : 0.24 + d * 0.085;
  const release = dur * imp;
  return { impact: release + flight, total: release + flight + Math.max(0.12, dur * (1 - imp) * 0.35), release };
}

/**
 * Events the renderer actually animates (render/playback.ts): only these are worth gliding the
 * camera to. Construction progress, damage/heal numbers and bookkeeping events are not.
 */
const FRAMED_EVENTS: ReadonlySet<GameEvent['type']> = new Set<GameEvent['type']>([
  'unitMoved', 'combat', 'unitDied', 'unitSpawned', 'spellCast', 'skillUsed', 'buildingStarted',
  'buildingCompleted', 'buildingCaptured', 'buildingDestroyed', 'ruinsExplored',
]);

const AI_ACTION_CAP = 500;
const AI_FAIL_CAP = 40;

interface AttackPlan { from: Hex | null; option: KindOption }

const EMPTY_FORECAST_UI = {
  forecast: null as CombatForecast | null, forecastTarget: null as UnitId | null,
  forecastFrom: null as UiState['forecastFrom'], forecastAlt: null as UiState['forecastAlt'],
  effectPreview: null as EffectPreview | null, effectError: null as string | null,
  hoverToward: null as UiState['hoverToward'],
};


/** How long a notice banner (a house destroyed) stays up. */
const NOTICE_MS = 4200;

/** An AI action this far (hexes) from the player's units and buildings is "distant" (may be skipped). */
const NEAR_PLAYER = 4;
/** Enemy beats on screen that do not concern the player play this much faster than the set speed. */
const GLANCE_PACE = 1.6;
/** Enemy marches the camera frames play this much faster (the strike that may follow does not). */
const MARCH_PACE = 1.25;
/** Enemy attacks on a unit already struck earlier in the same batch (a pile-on) play this much faster. */
const PILE_ON_PACE = 1.3;
/** Playback speed of a fast-forwarded enemy turn. */
const FF_SPEED = 8;
/** Enemy actions gathered into one scheduled playback (independent ones play at the same time). */
const WAVE_ACTIONS = 40;
/** How a planned playback step is shown: a camera glide, framed, played in place, or applied at once. */
type StepTier = 'camera' | 'focus' | 'glance' | 'instant';
/** How long a friendly-fire warning waits for the confirming second click. */
const FRIENDLY_FIRE_CONFIRM_MS = 5000;
/** Toast key of a "select X first" hint, cleared once the window it asked for opens. */
const MODAL_HINT = 'modal-hint';

/**
 * Toast for a standing order that ended by itself (the chronicle has the sim's plainer line): who
 * woke the unit, so the player knows why it is back on Tab.
 */
function orderEndedText(s: GameState, u: Unit, ev: Extract<GameEvent, { type: 'orderEnded' }>): string {
  if (ev.reason === 'healed') return `${u.name} is fully healed and ready for orders.`;
  // The chronicle's own line (sim/orders.ts), so the toast and the log name the same hostile.
  return orderEndText(u, ev.order, ev.reason, ev.enemy !== undefined ? getUnit(s, ev.enemy) : null);
}

/** The HUD's copy of a unit while its fate is still being animated (only what combat changes). */
function heldCopy(u: Unit): Unit {
  return { ...u, xpByCat: { ...u.xpByCat }, levelXpByCat: { ...u.levelXpByCat }, buffs: [...u.buffs] };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Macrotask yield that is not throttled in background tabs (unlike setTimeout). */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(null);
  });
}

class Controller implements GameController {
  state: GameState | null = null;
  ui: UiState;
  readonly renderer: WorldRenderer;

  private listeners = new Set<() => void>();
  private notifyPending = false;
  private human: FactionId = 'valen';
  private shift = false;
  /** Bumped after every state change; keys memoised hover computations. */
  private version = 0;
  /** Bumped when the game is replaced/quit so running async loops stop. */
  private token = 0;
  private planCache = new Map<string, AttackPlan | null>();
  /**
   * Reach of own units that are not the one selected for moving, per unit for one state version
   * (the selection, Tab and the idle count ask about several units under standing orders).
   */
  private reachMemo: { version: number; byUnit: Map<UnitId, ReachInfo[]> } = { version: -1, byUnit: new Map() };
  /** Enemies each unit can attack this turn, per state version: the attack mode's targets. */
  private attackMemo = new Map<string, UnitId[]>();
  private overlays: OverlayState = {
    selectedUnit: null, hoverHex: null, reach: [], path: [], attackable: [], forecastTarget: null,
    areaCenter: null, areaRadius: 0, areaValid: false, spellRanges: [], showGrid: true,
  };
  private toastId = 0;
  private extra: ExtraPrefs;
  private endShown = false;
  private fastForward = false;
  private aiRunning = false;
  /** Snapshot of unit looks taken before each action (dead units are gone from state when their events play). */
  private unitInfo = new Map<UnitId, UnitLook>();
  private debug: DebugOverlay | null = null;
  private reveal = false;
  private lastAutosaveError = 0;
  /** What the player last saw under the fog (buildings, territory) for the UI. */
  private fog = new FogMemory();
  /** performance.now() when control last returned to the player (end-turn grace window). */
  private humanTurnStartedAt = -Infinity;
  private lastTurnFastForwarded = false;
  /** performance.now() of the last end-turn press (counted or not): bursts end at most one turn. */
  private lastEndTurnPressAt = -Infinity;
  /** The state at the start of the player's current turn (serialized), for "Retry" after a defeat. */
  private turnStartData: string | null = null;
  /** Units as they were before the action being applied (the HUD shows these until the animation lands). */
  private preUnits = new Map<UnitId, Unit>();
  /** HUD hold while an action animates: units shown as before, chronicle lines not yet revealed. */
  private held: { units: Map<UnitId, Unit>; hiddenLog: Set<LogEntry>; lastNamed: Map<UnitId, number> } | null = null;
  /** The enemy playback in progress: fast-forwarding changes the steps that have not started yet. */
  private live: { steps: PlaybackStep[]; tiers: StepTier[]; started: Set<number> } | null = null;
  /** A harmful cast / skill that would hit own units: armed by a first click, fired by a second. */
  private friendlyArm: { key: string; until: number } | null = null;
  private effectCache = new Map<string, EffectPreview | { error: string }>();
  private towardCache = new Map<string, TowardPlan>();
  /**
   * Level-up choices the player put off ("Decide later"): unit → how many were waiting then. They
   * wait behind the HUD reminder and the unit panel button instead of reopening every turn; only a
   * newer level-up offers the window by itself again (interaction.levelUpsToOffer).
   */
  private levelUpDeferred = new Map<UnitId, number>();

  constructor(renderer: WorldRenderer, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    const { settings, extra } = loadSettings();
    this.extra = extra;
    this.ui = {
      screen: 'loading', loadingProgress: 0, loadingLabel: 'Preparing…', modal: null, mode: { kind: 'idle' },
      selectedHex: null, hoverHex: null, reach: [], ...EMPTY_FORECAST_UI, busy: false,
      aiThinking: null, toasts: [], settings, recruitSite: null, forgeSite: null, levelUpUnit: null,
      hasSave: hasSavedGame(), saves: savesInfo(), skippedUnits: [], turnView: null, modalReturn: null,
      lastSetup: extra.newGame ?? null,
    };
    audio.setVolume(settings.volume);
    music.setEnabled(settings.music);
    music.setMood('title');
    audio.installUnlock();
    this.overlays.showGrid = settings.showGrid;
    try { renderer.setQuality(settings.quality); } catch (e) { console.warn('[controller] setQuality failed', e); }
    try { renderer.setOverlays({ showGrid: settings.showGrid }); } catch { /* renderer may not be ready */ }
    this.syncRendererMode();
    attachInput(canvas, this);
    if (typeof window !== 'undefined') {
      // Never lose a turn's progress when the tab closes, not even during the enemy turn.
      window.addEventListener('pagehide', () => this.autosave(true, true));
    }
  }

  get revealMap(): boolean { return this.reveal; }

  lastSeen(): LastSeenMap | null {
    return this.state ? this.fog : null;
  }

  /** Remember what the player sees now (after every applied action and render sync). */
  private rememberSeen(initial = false): void {
    const s = this.state;
    if (!s) return;
    try { this.fog.update(s, this.human, initial); } catch (e) { console.error('[controller] fog memory update failed', e); }
  }

  // ───────────────────────────── store plumbing ─────────────────────────────

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    if (this.notifyPending) return;
    this.notifyPending = true;
    queueMicrotask(() => {
      this.notifyPending = false;
      for (const fn of [...this.listeners]) {
        try { fn(); } catch (e) { console.error('[controller] subscriber failed', e); }
      }
    });
  }

  private setUi(patch: Partial<UiState>): void {
    this.ui = { ...this.ui, ...patch };
    this.syncRendererMode();
    this.notify();
  }

  /**
   * The map only pans at the screen edge in play (not under a modal), and is not drawn at all
   * behind the opaque title / loading / results screens.
   */
  private syncRendererMode(): void {
    const inGame = this.ui.screen === 'game';
    const r = this.renderer as unknown as { edgePan?: boolean };
    if ('edgePan' in r) r.edgePan = this.ui.settings.edgePan && inGame && !this.ui.modal;
    try { this.renderer.setActive(inGame && this.ui.modal !== 'end'); } catch (e) { console.error('[controller] setActive failed', e); }
  }

  private setOverlays(patch: Partial<OverlayState>): void {
    Object.assign(this.overlays, patch);
    try { this.renderer.setOverlays(patch); } catch (e) { console.error('[controller] setOverlays failed', e); }
  }

  setLoading(fraction: number, label: string): void {
    this.setUi({ loadingProgress: clamp(fraction, 0, 1), loadingLabel: label });
  }

  /** Re-read what the save slots hold (title Continue, menu Load). */
  private refreshSaves(): void {
    this.setUi({ saves: savesInfo(), hasSave: hasSavedGame() });
  }

  hexToScreen(h: Hex): { x: number; y: number; visible: boolean } | null {
    try { return this.renderer.hexToScreen(h); } catch { return null; }
  }

  shownUnit(id: UnitId): Unit | undefined {
    return this.held?.units.get(id);
  }

  logShown(e: LogEntry): boolean {
    return !this.held?.hiddenLog.has(e);
  }

  ready(): void {
    this.setUi({ screen: 'title', loadingProgress: 1 });
    this.refreshSaves();
    music.setMood('title');
    music.start();
  }

  private get myTurn(): boolean {
    const s = this.state;
    return !!s && !s.gameOver && !this.ui.busy && this.ui.screen === 'game' && currentFaction(s) === this.human;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  newGame(settings: GameSettings): void {
    // The setup screen starts from these choices next time.
    const setup: NewGameSetup = {
      playerFaction: settings.playerFaction, aiCount: settings.aiCount === 1 ? 1 : 2, mapSize: settings.mapSize, difficulty: settings.difficulty,
    };
    this.extra.newGame = setup;
    saveSettings(this.ui.settings, this.extra);
    this.setUi({ lastSetup: setup });
    void this.startNewGame(settings);
  }

  private async startNewGame(settings: GameSettings): Promise<void> {
    const token = ++this.token;
    this.aiRunning = false;
    this.setUi({ screen: 'loading', loadingProgress: 0.35, loadingLabel: 'Shaping the land…', modal: null, busy: true, aiThinking: null });
    await sleep(30); // let the loading screen paint before the (synchronous) world generation
    if (token !== this.token) return;
    let state: GameState;
    try {
      state = createGame(settings);
    } catch (e) {
      console.error('[controller] createGame failed', e);
      this.setUi({ screen: 'title', busy: false });
      this.toast('The world could not be generated. Try another seed.', 'bad');
      return;
    }
    this.setLoading(0.5, 'Shaping the land…');
    // the terrain's heights and colours, in slices (the loading screen keeps animating)
    try { await this.renderer.prepareGame?.(state); } catch (e) { console.warn('[controller] prepareGame failed', e); }
    if (token !== this.token) return;
    this.setLoading(0.7, 'Raising castles…');
    await sleep(16);
    if (token !== this.token) return;
    this.levelUpDeferred.clear();
    this.installState(state);
    const first = state.turnOrder[state.currentTurn];
    let events: GameEvent[] = [];
    try {
      events = startTurn(state, first);
      this.version++;
    } catch (e) {
      console.error('[controller] startTurn failed', e);
    }
    this.focusHome(true);
    // Compile the new world's shaders and draw one hidden frame while the loading screen is up.
    this.setLoading(0.85, 'Kindling the aether…');
    try { await this.renderer.warmup?.((f, l) => this.setLoading(0.85 + f * 0.15, l)); } catch (e) { console.warn('[controller] renderer warmup failed', e); }
    if (token !== this.token) return;
    this.setUi({ screen: 'game', busy: true });
    music.setMood('game');
    await this.present(events, false, token);
    if (token !== this.token) return;
    this.syncRenderer();
    this.setUi({ busy: false });
    if (currentFaction(state) !== this.human) await this.runAiTurns(token);
    else this.onHumanTurnStart(true);
  }

  /** Swap in a state (new or loaded) and reset all transient UI. */
  private installState(state: GameState): void {
    this.state = state;
    const human = state.turnOrder.find((f) => state.factions[f]?.isHuman) ?? state.settings.playerFaction;
    this.human = human;
    this.version++;
    this.planCache.clear();
    this.endShown = state.gameOver;
    this.fastForward = false;
    this.held = null;
    this.friendlyArm = null;
    this.turnStartData = null;
    this.effectCache.clear();
    this.towardCache.clear();
    this.refreshNames();
    this.applyReveal();
    this.fog.clear();
    this.rememberSeen(true);
    try {
      this.renderer.setGame(state, human);
    } catch (e) {
      console.error('[controller] renderer.setGame failed', e);
    }
    this.setOverlays({
      selectedUnit: null, hoverHex: null, reach: [], path: [], attackable: [], forecastTarget: null,
      areaCenter: null, areaRadius: 0, areaValid: false, spellRanges: [], showGrid: this.ui.settings.showGrid,
    });
    this.setUi({
      modal: null, mode: { kind: 'idle' }, selectedHex: null, hoverHex: null, reach: [], ...EMPTY_FORECAST_UI,
      aiThinking: null, recruitSite: null, forgeSite: null, levelUpUnit: null, skippedUnits: [], turnView: null, modalReturn: null,
      gameOverHeld: false, notice: null,
    });
  }

  saveGame(): void {
    const s = this.state;
    if (!s) return;
    if (s.gameOver) { this.toast('The war is over — nothing to save.', 'warning'); return; }
    if (this.ui.busy || currentFaction(s) !== this.human) { this.toast('Wait until your turn to save.', 'warning'); return; }
    const r = saveGameState(s, false);
    if (r.ok) {
      this.toast(`Game saved (round ${s.round})`, 'good');
      this.refreshSaves();
    } else {
      this.toast(r.error, 'bad');
    }
  }

  loadGame(slot?: SaveSlot): boolean {
    const r = loadGameState(slot ?? null);
    if (!r.ok) {
      this.toast(r.error, 'warning');
      this.refreshSaves();
      return false;
    }
    // (a retry keeps the level-up choices put off: same war, same units)
    this.levelUpDeferred.clear();
    this.enterState(r.state, r.slot === 'auto' ? 'autosave' : 'save');
    return true;
  }

  /** After a defeat: replay the player's last turn from its start (this session's snapshot, else the autosave). */
  retryLastTurn(): void {
    const data = this.turnStartData;
    if (data) {
      try {
        const state = deserialize(data);
        this.toast(`Retrying round ${state.round}`, 'info');
        this.enterState(state, null);
        return;
      } catch (e) {
        console.error('[controller] retry snapshot unusable', e);
      }
    }
    const meta = saveInfo('auto');
    if (!meta) { this.warn('There is no autosave to retry from.'); return; }
    this.loadGame('auto');
  }

  private enterState(state: GameState, from: 'save' | 'autosave' | null): void {
    const token = ++this.token;
    this.aiRunning = false;
    this.installState(state);
    void this.enterLoadedGame(state, token, from);
  }

  /** After loadGame(): compile the world's shaders behind the loading screen (as startNewGame does), then play. */
  private async enterLoadedGame(state: GameState, token: number, from: 'save' | 'autosave' | null = 'save'): Promise<void> {
    if (this.renderer.warmup) {
      this.setUi({ screen: 'loading', loadingProgress: 0.85, loadingLabel: 'Kindling the aether…', busy: true });
      this.focusHome(true);
      try { await this.renderer.warmup((f, l) => this.setLoading(0.85 + f * 0.15, l)); } catch (e) { console.warn('[controller] renderer warmup failed', e); }
      if (token !== this.token) return;
    }
    const r = { state };
    this.setUi({ screen: 'game', busy: false });
    this.refreshSaves();
    music.setMood('game');
    this.focusHome(true);
    this.syncRenderer();
    if (r.state.gameOver) {
      this.checkGameOver();
    } else if (currentFaction(r.state) !== this.human) {
      void this.runAiTurns(token);
    } else {
      if (from) this.toast(`Round ${r.state.round} — ${from === 'autosave' ? 'autosave' : 'your save'} loaded. Welcome back, ${FACTIONS[this.human].leaderName}.`, 'info');
      this.onHumanTurnStart(false);
    }
  }

  quitToTitle(): void {
    // Saved even mid enemy turn or mid animation: the state is consistent between awaits, and
    // loading resumes an AI turn (the RNG lives in the state).
    this.autosave(false, true);
    ++this.token;
    this.aiRunning = false;
    this.held = null;
    this.turnStartData = null;
    this.state = null;
    this.fog.clear();
    this.version++;
    this.planCache.clear();
    this.renderer.keyState.clear();
    try { this.renderer.clearGame(); } catch (e) { console.error('[controller] renderer.clearGame failed', e); }
    this.setOverlays({ selectedUnit: null, hoverHex: null, reach: [], path: [], attackable: [], forecastTarget: null, areaCenter: null, spellRanges: [] });
    this.setUi({
      screen: 'title', modal: null, mode: { kind: 'idle' }, selectedHex: null, hoverHex: null, reach: [],
      ...EMPTY_FORECAST_UI, busy: false, aiThinking: null, skippedUnits: [], turnView: null, modalReturn: null,
    });
    this.refreshSaves();
    music.setMood('title');
  }

  /**
   * Write the auto slot (never the manual one). `force`: also during the enemy turn or an
   * animation (quitting, closing the tab), otherwise only at a calm point of the player's turn.
   */
  private autosave(silent: boolean, force = false): void {
    const s = this.state;
    if (!s || s.gameOver) return;
    if (!force && (this.ui.busy || currentFaction(s) !== this.human)) return;
    const r = saveGameState(s, true);
    if (r.ok) {
      this.refreshSaves();
    } else if (!silent && Date.now() - this.lastAutosaveError > 60000) {
      this.lastAutosaveError = Date.now();
      this.toast(`Autosave failed: ${r.error}`, 'warning');
    }
  }

  // ───────────────────────────── selection & modes ─────────────────────────────

  selectUnit(id: UnitId | null): void {
    const s = this.state;
    if (!s) return;
    if (id === null) { this.clearSelection(); return; }
    const u = getUnit(s, id);
    if (!u) return;
    if (u.faction !== this.human && !this.visible(u.pos)) return;
    const already = this.ui.mode.kind === 'unit' && this.ui.mode.unit === id;
    this.setUi({ mode: { kind: 'unit', unit: id }, selectedHex: u.pos, ...EMPTY_FORECAST_UI });
    this.refreshSelection();
    if (!already) playSfx(u.faction === this.human ? 'select' : 'click', { pan: this.panFor(u.pos) });
  }

  selectHex(h: Hex | null): void {
    if (!this.state) return;
    const mode = this.ui.mode;
    if (mode.kind !== 'idle') this.clearOverlaysForIdle();
    this.setUi({ mode: { kind: 'idle' }, selectedHex: h, reach: [], ...EMPTY_FORECAST_UI });
  }

  private clearSelection(): void {
    this.clearOverlaysForIdle();
    this.setUi({ mode: { kind: 'idle' }, reach: [], ...EMPTY_FORECAST_UI });
  }

  private clearOverlaysForIdle(): void {
    this.setOverlays({
      selectedUnit: null, reach: [], path: [], attackable: [], forecastTarget: null,
      areaCenter: null, areaRadius: 0, areaValid: false, spellRanges: [],
    });
  }

  /** Recompute reach / attackable overlays for the current mode (after any state change). */
  private refreshSelection(): void {
    const s = this.state;
    if (!s) return;
    const mode = this.ui.mode;
    if (mode.kind === 'unit' || mode.kind === 'attack') {
      const u = getUnit(s, mode.unit);
      if (!u || (u.faction !== this.human && !this.visible(u.pos))) { this.clearSelection(); return; }
      const own = u.faction === this.human && this.myTurnIgnoringBusy();
      let reach: ReachInfo[] = [];
      if (own && u.mp > 0) {
        try { reach = reachable(s, u); } catch (e) { console.error('[controller] reachable failed', e); }
      }
      // (reach first: the attack plans below read it)
      this.setUi({ reach, selectedHex: u.pos });
      if (mode.kind === 'attack') {
        // Only the enemies it can really strike this turn are marked; no move tint.
        const targets = own ? this.attackTargetIds(u) : [];
        if (targets.length) {
          this.setOverlays({
            selectedUnit: u.id, reach: [], attackable: targets, path: [], forecastTarget: null,
            areaCenter: null, areaRadius: 0, areaValid: false, spellRanges: [],
          });
          this.updateHover();
          return;
        }
        // Nothing left to attack (it acted, the target fell, the turn ended): back to the unit.
        this.setUi({ mode: { kind: 'unit', unit: u.id } });
      }
      const attackable = own ? this.attackableFor(u, reach) : [];
      this.setOverlays({
        selectedUnit: u.id, reach, attackable, path: [], forecastTarget: null,
        areaCenter: null, areaRadius: 0, areaValid: false, spellRanges: [],
      });
    } else if (mode.kind === 'skill') {
      const u = getUnit(s, mode.unit);
      if (!u) { this.clearSelection(); return; }
      let targets: Hex[] = [];
      try { targets = skillTargets(s, u, mode.skill); } catch (e) { console.error('[controller] skillTargets failed', e); }
      const def = ACTIVES[mode.skill];
      const enemyIds = def.target === 'enemy'
        ? targets.map((h) => unitAt(s, h)).filter((x): x is Unit => !!x && x.faction !== this.human).map((x) => x.id)
        : [];
      this.setUi({ reach: [], selectedHex: u.pos });
      this.setOverlays({
        selectedUnit: u.id, path: [], forecastTarget: null, attackable: enemyIds, spellRanges: [],
        reach: targets.map((hex) => ({ hex, cost: 0, mpLeft: 0, path: [], zocStop: false })),
      });
    } else if (mode.kind === 'cast') {
      const towers = this.ownTowers();
      if (towers.length === 0) { this.clearSelection(); return; }
      // Each tower shows its own reach (its channeller's intellect extends it).
      const spellRanges = towers.map((t) => {
        let range = 0;
        try { range = towerRange(s, t.id, mode.spell); } catch { /* */ }
        return { pos: t.pos, range };
      });
      this.setUi({ reach: [] });
      this.setOverlays({ selectedUnit: null, reach: [], path: [], attackable: [], forecastTarget: null, spellRanges });
    }
    this.updateHover();
  }

  /** Like myTurn but true while an own action animates (selection survives the animation). */
  private myTurnIgnoringBusy(): boolean {
    const s = this.state;
    return !!s && !s.gameOver && !this.aiRunning && currentFaction(s) === this.human;
  }

  /** Mage Towers that can cast: completed, or upgrading (an upgrade keeps the current level working). */
  private ownTowers() {
    const s = this.state!;
    return buildingsOf(s, this.human).filter((b) => b.type === 'magetower' && isFunctional(b));
  }

  /** Enemy ids the unit can attack now or after moving (red outlines). */
  private attackableFor(u: Unit, reach: readonly ReachInfo[]): UnitId[] {
    const s = this.state!;
    const ids = new Set<UnitId>();
    try { for (const t of attackTargets(s, u)) if (this.unitVisible(t.unit)) ids.add(t.unit); } catch (e) { console.error('[controller] attackTargets failed', e); }
    if (!u.acted && reach.length > 0) {
      const maxRange = this.maxRange(u);
      for (const e of Object.values(s.units)) {
        if (e.faction === u.faction || ids.has(e.id) || !this.visible(e.pos)) continue;
        if (hexDistance(e.pos, u.pos) > u.mp + maxRange + 1) continue;
        if (reach.some((r) => hexDistance(r.hex, e.pos) <= maxRange)) ids.add(e.id);
      }
    }
    return [...ids];
  }

  private maxRange(u: Unit): number {
    let r = 1;
    try { for (const a of getAttackDefs(u)) r = Math.max(r, a.range); } catch { /* */ }
    return r;
  }

  /**
   * Where an own unit can move this turn, for move-then-attack plans: the selection's reach for
   * the unit selected (unit / attack mode), else computed once per state version. The same rule as
   * refreshSelection, so plans cached per version agree whichever way they were reached.
   */
  private reachFor(u: Unit): readonly ReachInfo[] {
    const m = this.ui.mode;
    if ((m.kind === 'unit' || m.kind === 'attack') && m.unit === u.id) return this.ui.reach;
    if (u.faction !== this.human || !this.myTurnIgnoringBusy() || u.mp <= 0) return [];
    if (this.reachMemo.version !== this.version) this.reachMemo = { version: this.version, byUnit: new Map() };
    let reach = this.reachMemo.byUnit.get(u.id);
    if (!reach) {
      reach = [];
      try { reach = reachable(this.state!, u); } catch (e) { console.error('[controller] reachable failed', e); }
      this.reachMemo.byUnit.set(u.id, reach);
    }
    return reach;
  }

  /**
   * Enemies the own unit can attack this turn, from where it stands or after moving (a real plan
   * exists, unlike attackableFor's quick outline test): the attack mode's targets.
   */
  private attackTargetIds(u: Unit): UnitId[] {
    const s = this.state!;
    if (u.acted || u.faction !== this.human) return [];
    const key = `${this.version}|${u.id}|${this.reachFor(u).length}`;
    const memo = this.attackMemo.get(key);
    if (memo) return memo;
    const ids = this.attackableFor(u, this.reachFor(u)).filter((id) => {
      const t = getUnit(s, id);
      return !!t && this.planAttack(u, t, false) !== null;
    });
    // (keys carry the version: drop the old versions' entries once a new one is asked for)
    if (![...this.attackMemo.keys()].every((k) => k.startsWith(`${this.version}|`))) this.attackMemo.clear();
    this.attackMemo.set(key, ids);
    return ids;
  }

  attackableTargets(unit: UnitId): UnitId[] {
    const s = this.state;
    // (never while an action animates: the state is ahead of the selection's reach then)
    if (!s || this.ui.busy || !this.myTurn) return [];
    const u = getUnit(s, unit);
    return u ? this.attackTargetIds(u) : [];
  }

  /**
   * Own units that still need orders (builders on sites, workers, drilling units, the seated leader
   * and skipped units excluded). A unit under a standing order comes back when the Attack button
   * has a target for it (moving first included), so Tab and the bar agree.
   */
  private awaitingOrders(): UnitId[] {
    const s = this.state;
    if (!s) return [];
    try { return unitsAwaitingOrders(s, new Set(this.ui.skippedUnits), (u) => this.attackableTargets(u.id).length > 0); } catch (e) { console.error('[controller] unitsAwaitingOrders failed', e); return []; }
  }

  nextIdleUnit(): void {
    const s = this.state;
    if (!s || !this.myTurn) return;
    const ids = this.awaitingOrders();
    if (ids.length === 0) {
      let anyIdle = false;
      try { anyIdle = idleUnits(s).length > 0; } catch { /* */ }
      this.toast(anyIdle ? 'The remaining units are working or waiting — press Space to end the turn.'
        : 'Every unit has acted — press Space to end the turn.', 'info', { key: 'next-unit' });
      return;
    }
    const m = this.ui.mode;
    const cur = m.kind === 'unit' || m.kind === 'attack' ? m.unit : null;
    const next = cycleNext(ids, cur);
    if (next === null) return;
    this.selectUnit(next);
    const u = getUnit(s, next);
    if (u) this.renderer.focus(u.pos);
  }

  skipUnit(): void {
    const s = this.state;
    if (!s || !this.myTurn) return;
    const u = this.selectedOwnUnit();
    if (!u) { this.warn('Select one of your units to skip it this turn.'); return; }
    if (!this.ui.skippedUnits.includes(u.id)) this.setUi({ skippedUnits: [...this.ui.skippedUnits, u.id] });
    playSfx('deselect');
    if (this.awaitingOrders().length) this.nextIdleUnit();
    else this.toast(`${u.name} waits. Every unit has its orders — press Space to end the turn.`, 'info', { key: 'next-unit' });
  }

  beginCast(spell: SpellId): void {
    const s = this.state;
    if (!s || !this.myTurn) return;
    const def = SPELLS[spell];
    const fs = s.factions[this.human];
    let known: SpellId[] = [];
    try { known = knownSpells(s, this.human); } catch (e) { console.error(e); }
    if (!known.includes(spell)) { this.warn(`${def.name} has not been researched yet.`); return; }
    if (this.ownTowers().length === 0) { this.warn('You need a completed Mage Tower to cast spells.'); return; }
    if (fs.resources.mana < def.mana) { this.warn(`Not enough mana: ${def.name} needs ${def.mana}.`); return; }
    const cd = fs.spellCooldowns[spell] ?? 0;
    if (cd > 0) { this.warn(`${def.name} is recharging (${cd} turn${cd > 1 ? 's' : ''}).`); return; }
    this.dropToast('friendly-fire');
    this.setUi({ mode: { kind: 'cast', spell, tower: null }, modal: null, modalReturn: null, ...EMPTY_FORECAST_UI });
    playSfx('magicCast', { gain: 0.35 });
    // (The targeting panel says what to pick; a toast would outlive the cast.)
    this.refreshSelection();
  }

  beginSkill(unit: UnitId, skill: ActiveId): void {
    const s = this.state;
    if (!s || !this.myTurn) return;
    const u = getUnit(s, unit);
    if (!u || u.faction !== this.human) return;
    const def = ACTIVES[skill];
    if (!u.actives.includes(skill)) { this.warn(`${u.name} does not know ${def.name}.`); return; }
    if (def.cooldown === 0) { this.toast(`${def.name} is a permanent skill — no need to activate it.`, 'info'); return; }
    const cd = u.cooldowns[skill] ?? 0;
    if (cd > 0) { this.warn(`${def.name} is on cooldown (${cd} turn${cd > 1 ? 's' : ''}).`); return; }
    if (def.target === 'none') {
      void this.dispatch({ type: 'skill', unit, skill });
      return;
    }
    let targets: Hex[] = [];
    try { targets = skillTargets(s, u, skill); } catch (e) { console.error(e); }
    if (targets.length === 0) {
      // A real blocker (already acted…) else the bar's wording: canUseSkill without a target would
      // read like an instruction ("Choose an ally").
      let reason: string | null = null;
      try { reason = skillBlocker(s, u, skill); } catch { /* */ }
      this.warn(`${reason ?? NO_SKILL_TARGET}.`);
      return;
    }
    this.dropToast('friendly-fire');
    this.setUi({ mode: { kind: 'skill', unit, skill }, modal: null, modalReturn: null, ...EMPTY_FORECAST_UI });
    this.refreshSelection();
  }

  beginAttack(unit: UnitId): void {
    const s = this.state;
    if (!s || !this.myTurn) return;
    const u = getUnit(s, unit);
    if (!u || u.faction !== this.human) return;
    if (u.acted) { this.warn(`${u.name} has already acted this turn.`); return; }
    this.dropToast('friendly-fire');
    this.friendlyArm = null;
    this.setUi({ mode: { kind: 'attack', unit }, modal: null, modalReturn: null, ...EMPTY_FORECAST_UI });
    // (refreshSelection falls back to the plain selection when no enemy can be reached)
    this.refreshSelection();
    if (this.ui.mode.kind !== 'attack') this.warn(`No enemy in reach of ${u.name} this turn.`);
    else playSfx('select', { gain: 0.6, pan: this.panFor(u.pos) });
  }

  giveOrder(unit: UnitId, order: UnitOrder | null): void {
    void this.giveOrderAsync(unit, order);
  }

  private async giveOrderAsync(unit: UnitId, order: UnitOrder | null): Promise<void> {
    const s = this.state;
    if (!s || !this.myTurn) return;
    const u = getUnit(s, unit);
    if (!u || u.faction !== this.human) return;
    // (read before the order is set: a hostile already in range ends it at the next turn start)
    let wake: string | null = null;
    try { wake = order ? orderWakeWarning(s, u, order) : null; } catch { /* */ }
    const r = await this.dispatch({ type: 'order', unit, order });
    if (!r.ok || this.state !== s || order === null) return;
    playSfx('deselect');
    if (wake) this.toast(wake, 'warning');
    // Like Skip: the unit has its orders, so the selection moves on (when it still shows this unit).
    const m = this.ui.mode;
    if (m.kind === 'idle' || m.kind === 'cast' || m.unit !== unit) return;
    if (this.awaitingOrders().some((id) => id !== unit)) this.nextIdleUnit();
    else this.toast(`${u.name} ${order === 'heal' ? 'rests' : 'keeps watch'}. Every unit has its orders — press Space to end the turn.`, 'info', { key: 'next-unit' });
  }

  /** The own unit the command hotkeys act on: selected (also while it picks a skill or attack target). */
  private selectedOwnUnit(): Unit | null {
    const s = this.state;
    const m = this.ui.mode;
    if (!s || m.kind === 'idle' || m.kind === 'cast') return null;
    const u = getUnit(s, m.unit);
    return u && u.faction === this.human ? u : null;
  }

  /** The unit the panel shows (selected, else a visible unit on the selected hex): what Details opens. */
  private shownUnitForSheet(): Unit | null {
    const s = this.state;
    if (!s) return null;
    const m = this.ui.mode;
    if (m.kind !== 'idle' && m.kind !== 'cast') {
      const u = getUnit(s, m.unit);
      if (u) return u;
    }
    const h = this.ui.selectedHex;
    if (!h) return null;
    const u = this.visibleUnitAt(h);
    return u ?? null;
  }

  /** Remove a keyed toast at once (its message no longer applies). */
  private dropToast(key: string): void {
    if (this.ui.toasts.some((t) => t.key === key)) this.setUi({ toasts: this.ui.toasts.filter((t) => t.key !== key) });
  }

  cancelMode(): void {
    const mode = this.ui.mode;
    this.friendlyArm = null;
    this.dropToast('friendly-fire');
    if (mode.kind === 'skill') {
      this.setUi({ mode: { kind: 'unit', unit: mode.unit } });
      this.setOverlays({ areaCenter: null, areaRadius: 0, areaValid: false });
      this.refreshSelection();
      playSfx('deselect');
    } else if (mode.kind === 'attack') {
      // Back to the unit (still selected, its move range shown again).
      this.setUi({ mode: { kind: 'unit', unit: mode.unit }, ...EMPTY_FORECAST_UI });
      this.refreshSelection();
      playSfx('deselect');
    } else if (mode.kind === 'cast') {
      this.clearSelection();
      playSfx('deselect');
    } else if (mode.kind === 'unit') {
      // Deselect fully: the unit panel falls back to the unit on selectedHex.
      this.clearSelection();
      this.setUi({ selectedHex: null });
      playSfx('deselect');
    } else if (this.ui.selectedHex) {
      this.setUi({ selectedHex: null });
    }
  }

  // ───────────────────────────── hover ─────────────────────────────

  hover(h: Hex | null): void {
    const cur = this.ui.hoverHex;
    if ((cur === null && h === null) || (cur && h && hexEq(cur, h))) return;
    this.setUi({ hoverHex: h });
    this.updateHover();
    this.debug?.setHover(this.state, h);
  }

  setShift(down: boolean): void {
    if (down === this.shift) return;
    this.shift = down;
    this.updateHover();
  }

  /** Path preview, combat forecast and AoE preview for the hovered hex. */
  private updateHover(): void {
    const s = this.state;
    const h = this.ui.hoverHex;
    const mode = this.ui.mode;
    const clear = () => {
      this.setOverlays({ hoverHex: h, path: [], forecastTarget: null, areaCenter: null, areaValid: false });
      if (this.ui.forecast || this.ui.forecastTarget !== null || this.ui.effectPreview || this.ui.effectError || this.ui.hoverToward) {
        this.setUi({ ...EMPTY_FORECAST_UI });
      }
    };
    if (!s || !h || this.ui.busy || this.ui.modal || this.ui.screen !== 'game') { clear(); return; }

    if (mode.kind === 'attack') {
      // Only the targets get a forecast; any other hex just shows the hover outline.
      const u = getUnit(s, mode.unit);
      const other = this.visibleUnitAt(h);
      if (u && u.faction === this.human && this.myTurn && other && other.faction !== this.human
        && this.attackTargetIds(u).includes(other.id) && this.hoverAttack(u, other, h)) return;
      clear();
      return;
    }

    if (mode.kind === 'unit') {
      const u = getUnit(s, mode.unit);
      if (!u || u.faction !== this.human || !this.myTurn) { clear(); return; }
      const other = this.visibleUnitAt(h);
      if (other && other.faction !== this.human) {
        if (!this.hoverAttack(u, other, h)) clear();
        return;
      }
      const r = other ? undefined : this.ui.reach.find((x) => hexEq(x.hex, h));
      if (!r && !other && !hexEq(h, u.pos) && this.canHeadOut(u)) {
        // Past this turn's reach: preview the part of the trip walked now.
        const t = this.towardPlan(u, h);
        this.setOverlays({ hoverHex: h, path: 'error' in t ? [] : t.path, forecastTarget: null, areaCenter: null });
        this.setUi({
          ...EMPTY_FORECAST_UI,
          hoverToward: 'error' in t ? (t.wait ? { turns: t.wait.turns, wait: t.wait.why } : { error: t.error }) : { turns: t.turns },
        });
        return;
      }
      this.setOverlays({ hoverHex: h, path: r ? r.path : [], forecastTarget: null, areaCenter: null });
      if (this.ui.forecast || this.ui.hoverToward) this.setUi({ ...EMPTY_FORECAST_UI });
      return;
    }

    if (mode.kind === 'cast') {
      const def = SPELLS[mode.spell];
      const p = this.castPreview(mode.spell, h);
      const ok = !('error' in p);
      this.setOverlays({
        hoverHex: h, path: [], forecastTarget: null, areaCenter: h, areaRadius: def.radius, areaValid: ok,
        areaTone: ok ? effectAreaTone(p) : undefined,
      });
      this.setUi({ ...EMPTY_FORECAST_UI, effectPreview: ok ? p : null, effectError: ok ? null : p.error });
      return;
    }

    if (mode.kind === 'skill') {
      const u = getUnit(s, mode.unit);
      if (!u) { clear(); return; }
      const p = this.skillPreview(u, mode.skill, h);
      const ok = !('error' in p);
      const struck = ok && mode.skill === 'firebolt' ? p.entries[0]?.unit ?? null : null;
      this.setOverlays({
        hoverHex: h, path: [], forecastTarget: struck, areaCenter: h,
        areaRadius: mode.skill === 'volley' ? 1 : 0, areaValid: ok, areaTone: ok ? effectAreaTone(p) : undefined,
      });
      this.setUi({ ...EMPTY_FORECAST_UI, effectPreview: ok ? p : null, effectError: ok ? null : p.error });
      return;
    }

    clear();
  }

  /** Forecast (and approach path) for `u` attacking the hovered enemy; false when it cannot. */
  private hoverAttack(u: Unit, other: Unit, h: Hex): boolean {
    const plan = this.planAttack(u, other, this.shift);
    if (!plan) return false;
    const reachInfo = plan.from ? this.ui.reach.find((r) => hexEq(r.hex, plan.from!)) : undefined;
    const path = reachInfo?.path ?? [];
    // Is there really another attack for Shift? (Same kind both ways: no.)
    const base = this.shift ? this.planAttack(u, other, false) : plan;
    const swapped = this.shift ? plan : this.planAttack(u, other, true);
    const alt = altAttackOf(base, swapped);
    const other2 = alt ? (this.shift ? base : swapped) : null;
    this.setOverlays({ hoverHex: h, path, forecastTarget: other.id, areaCenter: null });
    this.setUi({
      ...EMPTY_FORECAST_UI,
      forecast: plan.option.forecast, forecastTarget: other.id,
      forecastFrom: plan.from && reachInfo ? { hex: plan.from, mpLeft: reachInfo.mpLeft } : null,
      forecastAlt: other2 ? { name: other2.option.forecast.attacker?.name ?? other2.option.kind, active: this.shift } : null,
    });
    return true;
  }

  /** Spell preview (or why the hex is not a target), memoised per state version. */
  private castPreview(spell: SpellId, h: Hex): EffectPreview | { error: string } {
    const key = `${this.version}|cast|${spell}|${h.q},${h.r}`;
    const hit = this.effectCache.get(key);
    if (hit) return hit;
    const r = this.castCheck(spell, h);
    let out: EffectPreview | { error: string };
    if ('error' in r) out = r;
    else {
      try { out = previewSpell(this.state!, this.human, spell, h); } catch (e) { console.error('[controller] previewSpell failed', e); out = { tone: 'neutral', entries: [], notes: [] }; }
    }
    if (this.effectCache.size > 300) this.effectCache.clear();
    this.effectCache.set(key, out);
    return out;
  }

  private skillPreview(u: Unit, skill: ActiveId, h: Hex): EffectPreview | { error: string } {
    const key = `${this.version}|skill|${u.id}|${skill}|${h.q},${h.r}`;
    const hit = this.effectCache.get(key);
    if (hit) return hit;
    const err = this.skillCheck(u, skill, h);
    let out: EffectPreview | { error: string };
    if (err) out = { error: err };
    else {
      try { out = previewSkill(this.state!, u, skill, h); } catch (e) { console.error('[controller] previewSkill failed', e); out = { tone: 'neutral', entries: [], notes: [] }; }
    }
    if (this.effectCache.size > 300) this.effectCache.clear();
    this.effectCache.set(key, out);
    return out;
  }

  /** Can the selected unit still head anywhere this turn (else a far click just inspects the tile)? */
  private canHeadOut(u: Unit): boolean {
    return u.faction === this.human && u.mp > 0 && !u.moveEnded && !u.justSpawned && this.myTurn;
  }

  /**
   * Multi-turn trip toward an empty hex: this turn's leg (as far as the unit can legally stop) and
   * how many turns the whole trip takes, or why the unit cannot head there.
   */
  private towardPlan(u: Unit, to: Hex): TowardPlan {
    const s = this.state!;
    const key = `${this.version}|${u.id}|${to.q},${to.r}`;
    const hit = this.towardCache.get(key);
    if (hit) return hit;
    let out: TowardPlan;
    try {
      if (!this.hexKnown(to)) out = { error: 'That land is unexplored' };
      else if (!Number.isFinite(moveCost(s, u, to))) out = { error: `${u.name} cannot go there` };
      else {
        const full = pathTowards(s, u, to);
        if (!full || full.length === 0) out = { error: 'No way there' };
        else {
          const leg = truncatePathToMp(s, u, full);
          if (leg.length === 0) out = stuckTrip(s, u, full, this.unitMov(u));
          else {
            const rest = pathCost(s, u, full.slice(leg.length));
            out = { path: leg, turns: 1 + Math.ceil(rest / this.unitMov(u)) };
          }
        }
      }
    } catch (e) {
      console.error('[controller] towardPlan failed', e);
      out = { error: 'No way there' };
    }
    if (this.towardCache.size > 200) this.towardCache.clear();
    this.towardCache.set(key, out);
    return out;
  }

  /** Movement points per turn (effective stats), for trip estimates. */
  private unitMov(u: Unit): number {
    try { return Math.max(1, effectiveStats(this.state!, u).mov); } catch { return Math.max(1, u.base.mov); }
  }

  private hexKnown(h: Hex): boolean {
    const s = this.state!;
    if (this.reveal) return true;
    if (!inBounds(h, s.width, s.height)) return false;
    try { return isExplored(s, this.human, h); } catch { return false; }
  }

  private castCheck(spell: SpellId, target: Hex): { tower: BuildingInstanceId } | { error: string } {
    const s = this.state!;
    try {
      const towers = towersInRange(s, this.human, spell, target);
      if (towers.length === 0) return { error: 'Out of range of your Mage Towers.' };
      let firstErr: string | null = null;
      for (const t of towers) {
        const err = canCast(s, this.human, spell, t, target);
        if (!err) return { tower: t };
        firstErr ??= err;
      }
      return { error: firstErr ?? 'Cannot cast there.' };
    } catch (e) {
      console.error('[controller] castCheck failed', e);
      return { error: 'Cannot cast there.' };
    }
  }

  private skillCheck(u: Unit, skill: ActiveId, target: Hex): string | null {
    try { return canUseSkill(this.state!, u, skill, target); } catch (e) { console.error(e); return 'Invalid target.'; }
  }

  // ───────────────────────────── attack planning ─────────────────────────────

  private kindOptions(attacker: Unit, defender: Unit): KindOption[] {
    const s = this.state!;
    const out: KindOption[] = [];
    let kinds: ReturnType<typeof availableAttackKinds> = [];
    try { kinds = availableAttackKinds(s, attacker, defender); } catch (e) { console.error(e); return out; }
    for (const kind of kinds) {
      try {
        const f = forecastCombat(s, attacker, defender, kind);
        if (f) out.push({ kind, forecast: f });
      } catch (e) { console.error('[controller] forecastCombat failed', e); }
    }
    return out;
  }

  /**
   * Best way to attack `target` with `u`: from the current hex when possible, else from the
   * best reachable hex (forecasts computed with a virtual copy of the unit standing there).
   */
  private planAttack(u: Unit, target: Unit, swap: boolean): AttackPlan | null {
    const key = `${this.version}|${u.id}|${target.id}|${swap ? 1 : 0}`;
    if (this.planCache.has(key)) return this.planCache.get(key)!;
    const plan = this.computePlan(u, target, swap);
    if (this.planCache.size > 400) this.planCache.clear();
    this.planCache.set(key, plan);
    return plan;
  }

  private computePlan(u: Unit, target: Unit, swap: boolean): AttackPlan | null {
    const s = this.state!;
    if (u.acted) return null;
    const legalHere = this.kindOptions(u, target).filter((o) => {
      try { return canAttack(s, u, target, o.kind) === null; } catch { return false; }
    });
    if (legalHere.length) {
      const o = chooseAttackKind(legalHere, swap);
      return o ? { from: null, option: o } : null;
    }
    const reach = this.reachFor(u);
    if (!reach.length) return null;
    const maxRange = this.maxRange(u);
    const cands: ApproachCandidate[] = [];
    for (const r of reach) {
      const d = hexDistance(r.hex, target.pos);
      if (d < 1 || d > maxRange) continue;
      if (unitAt(s, r.hex)) continue;
      const virtual: Unit = { ...u, pos: r.hex, mp: r.mpLeft, moved: true };
      const options = this.kindOptions(virtual, target);
      if (!options.length) continue;
      let defense = 0;
      try { defense = tileDefense(s, virtual, r.hex); } catch { /* */ }
      cands.push({ hex: r.hex, cost: r.cost, defense, options });
    }
    const pick = pickApproach(cands, swap);
    return pick ? { from: pick.hex, option: pick.option } : null;
  }

  // ───────────────────────────── clicks ─────────────────────────────

  click(h: Hex | null, button: 'left' | 'right'): void {
    const s = this.state;
    if (!s || this.ui.screen !== 'game' || this.ui.busy) return;
    if (this.ui.modal) {
      // A click on the map dismisses light-weight panels; decisions (level-up, end, menus) stay.
      if (!['levelup', 'end', 'newgame', 'menu', 'settings'].includes(this.ui.modal)) this.closeModal();
      return;
    }
    if (!h) {
      if (button === 'right') this.cancelMode();
      return;
    }
    const mode = this.ui.mode;
    const sel = mode.kind === 'unit' || mode.kind === 'attack' ? getUnit(s, mode.unit) ?? null : null;
    const other = this.visibleUnitAt(h);
    const intent = resolveClick({
      hex: h,
      button,
      swap: this.shift,
      mode,
      human: this.human,
      myTurn: this.myTurn,
      unitAt: other ? { id: other.id, faction: other.faction } : null,
      selected: sel ? { id: sel.id, faction: sel.faction } : null,
      reach: this.ui.reach,
      attackFromHere: (target, swap) => {
        const t = getUnit(s, target);
        if (!sel || !t) return null;
        const p = this.planAttack(sel, t, swap);
        return p && p.from === null ? p.option : null;
      },
      approach: (target, swap) => {
        const t = getUnit(s, target);
        if (!sel || !t) return null;
        const p = this.planAttack(sel, t, swap);
        return p && p.from ? { hex: p.from, option: p.option } : null;
      },
      castCheck: mode.kind === 'cast' ? (target) => this.castCheck(mode.spell, target) : undefined,
      skillCheck: mode.kind === 'skill' ? (target) => {
        const u = getUnit(s, mode.unit);
        return u ? this.skillCheck(u, mode.skill, target) : 'The unit is gone.';
      } : undefined,
      towardCheck: sel && mode.kind === 'unit' && this.canHeadOut(sel) ? (target) => {
        const t = this.towardPlan(sel, target);
        return 'error' in t ? t.error : null;
      } : undefined,
    });
    if (!this.confirmFriendlyFire(intent)) return;
    // The attack command is spent once it picks a target: the unit stays selected.
    if (mode.kind === 'attack' && (intent.kind === 'attack' || intent.kind === 'moveAttack')) {
      this.setUi({ mode: { kind: 'unit', unit: mode.unit } });
    }
    void this.execIntent(intent);
  }

  /**
   * A harmful spell or skill that would also hit own units needs a second click on the same hex
   * (a leader caught in a Fireball loses the war). True when the intent may go ahead now.
   */
  private confirmFriendlyFire(intent: ClickIntent): boolean {
    if (intent.kind !== 'cast' && intent.kind !== 'skill') { this.friendlyArm = null; return true; }
    const s = this.state!;
    const h = intent.target;
    let p: EffectPreview | { error: string };
    if (intent.kind === 'cast') p = this.castPreview(intent.spell, h);
    else {
      const u = getUnit(s, intent.unit);
      if (!u) return true;
      p = this.skillPreview(u, intent.skill, h);
    }
    const hurt = 'error' in p ? [] : friendlyFire(p);
    if (hurt.length === 0) { this.friendlyArm = null; return true; }
    const key = `${this.version}|${intent.kind}|${intent.kind === 'cast' ? intent.spell : intent.skill}|${h.q},${h.r}`;
    const now = Date.now();
    if (this.friendlyArm && this.friendlyArm.key === key && now < this.friendlyArm.until) { this.friendlyArm = null; return true; }
    this.friendlyArm = { key, until: now + FRIENDLY_FIRE_CONFIRM_MS };
    const names = hurt.map((e) => getUnit(s, e.unit)).filter((u): u is Unit => !!u);
    const leader = names.find((u) => u.isLeader);
    const lethal = hurt.some((e) => e.killChance > 0);
    const who = leader ? `your leader ${leader.name}${names.length > 1 ? ` and ${names.length - 1} more of your units` : ''}`
      : names.length === 1 ? `your ${names[0].name}` : `${names.length} of your units`;
    this.toast(`This would hit ${who}${lethal ? ' — fatally' : ''}. Click the same hex again to go ahead.`, leader || lethal ? 'bad' : 'warning', { key: 'friendly-fire' });
    playSfx('error', { gain: 0.8 });
    return false;
  }

  private async execIntent(intent: ClickIntent): Promise<void> {
    const s = this.state;
    if (!s) return;
    switch (intent.kind) {
      case 'none': return;
      case 'cancel': this.cancelMode(); return;
      case 'select': this.selectUnit(intent.unit); return;
      case 'tile':
        this.selectHex(intent.hex);
        playSfx('click', { gain: 0.6, pan: this.panFor(intent.hex) });
        return;
      case 'invalid': this.warn(intent.reason); return;
      case 'move':
        await this.dispatch({ type: 'move', unit: intent.unit, to: intent.to });
        return;
      case 'moveToward': {
        const u = getUnit(s, intent.unit);
        if (!u) return;
        const t = this.towardPlan(u, intent.to);
        if ('error' in t) { this.warn(t.error); return; }
        const stop = t.path[t.path.length - 1];
        const r = await this.dispatch({ type: 'move', unit: u.id, to: stop });
        if (r.ok && this.state === s && t.turns > 1) {
          this.toast(`${u.name} heads that way — about ${t.turns - 1} more turn${t.turns - 1 === 1 ? '' : 's'} to get there.`, 'info', { key: 'toward' });
        }
        return;
      }
      case 'attack':
        await this.dispatch({ type: 'attack', unit: intent.unit, target: intent.target, kind: intent.attack });
        return;
      case 'moveAttack': {
        const r = await this.dispatch({ type: 'move', unit: intent.unit, to: intent.to });
        if (!r.ok || !this.state || this.state !== s) return;
        const u = getUnit(s, intent.unit);
        const t = getUnit(s, intent.target);
        if (!u || !t) return;
        if (!hexEq(u.pos, intent.to)) { this.toast(`${u.name} was stopped before reaching the target.`, 'warning'); return; }
        let kind = intent.attack;
        let legal = false;
        try { legal = canAttack(s, u, t, kind) === null; } catch { legal = false; }
        if (!legal) {
          const opt = chooseAttackKind(this.kindOptions(u, t).filter((o) => { try { return canAttack(s, u, t, o.kind) === null; } catch { return false; } }), this.shift);
          if (!opt) return;
          kind = opt.kind;
        }
        await this.dispatch({ type: 'attack', unit: u.id, target: t.id, kind });
        return;
      }
      case 'cast':
        await this.dispatch({ type: 'cast', faction: this.human, spell: intent.spell, tower: intent.tower, target: intent.target });
        return;
      case 'skill':
        await this.dispatch({ type: 'skill', unit: intent.unit, skill: intent.skill, target: intent.target });
        return;
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  async dispatch(action: Action): Promise<ActionResult> {
    const s = this.state;
    const fail = (error: string): ActionResult => ({ ok: false, error, events: [] });
    if (!s) return fail('No game in progress.');
    if (action.type === 'endTurn') { await this.endTurn(); return { ok: true, events: [] }; }
    if (this.ui.busy) return fail('Please wait for the current action to finish.');
    if (s.gameOver) return fail('The game is over.');
    if (currentFaction(s) !== this.human) return fail('It is not your turn.');
    const token = this.token;
    const modeBefore = this.ui.mode;
    this.refreshNames();
    let res: ActionResult;
    try {
      res = applyAction(s, action);
    } catch (e) {
      console.error('[controller] applyAction threw', action, e);
      this.warn('That action failed unexpectedly.');
      return fail('internal error');
    }
    if (!res.ok) {
      this.warn(res.error ?? 'That is not possible.');
      return res;
    }
    this.version++;
    this.planCache.clear();
    // Cast / skill modes end once used.
    if (action.type === 'cast' && modeBefore.kind === 'cast') {
      this.clearOverlaysForIdle(); // incl. the tower range tint
      this.setUi({ mode: { kind: 'idle' } });
    }
    if (action.type === 'skill' && modeBefore.kind === 'skill') this.setUi({ mode: { kind: 'unit', unit: modeBefore.unit } });
    if (action.type === 'cast' || action.type === 'skill') { this.friendlyArm = null; this.dropToast('friendly-fire'); }
    this.setUi({ busy: true, ...EMPTY_FORECAST_UI });
    this.setOverlays({ path: [], forecastTarget: null, areaCenter: null });
    try {
      await this.present(res.events, false, token);
    } finally {
      if (token === this.token) {
        this.setUi({ busy: false });
        this.afterChange();
      }
    }
    if (token !== this.token) return res;
    this.afterAction(action, res.events);
    return res;
  }

  /** Post-dispatch UI flow: level-up modal handling and selection fix-ups. */
  private afterAction(action: Action, events: GameEvent[]): void {
    const s = this.state!;
    if (action.type === 'levelup') {
      // The unit's next queued choice, else the next one not put off; put-off ones stay waiting.
      const u = getUnit(s, action.unit);
      if (u && u.pendingLevelUps > 0) this.setUi({ levelUpUnit: u.id, modal: 'levelup' });
      else {
        const next = this.levelUpOffers()[0];
        if (next !== undefined) this.setUi({ levelUpUnit: next, modal: 'levelup' });
        else if (this.ui.modal === 'levelup') this.closeModal();
      }
      return;
    }
    const leveled = events.find((e): e is Extract<GameEvent, { type: 'unitLeveled' }> =>
      e.type === 'unitLeveled' && getUnit(s, e.unit)?.faction === this.human);
    if (leveled && !this.ui.modal && !s.gameOver && this.levelUpOffers().includes(leveled.unit)) {
      this.openModal('levelup', { unit: leveled.unit });
    }
  }

  private pendingLevelUpUnits(): UnitId[] {
    const s = this.state;
    if (!s) return [];
    return unitsOf(s, this.human).filter((u) => u.pendingLevelUps > 0).map((u) => u.id);
  }

  /** Own units whose level-up window may open by itself (pending, not put off). */
  private levelUpOffers(): UnitId[] {
    const s = this.state;
    if (!s) return [];
    const units = unitsOf(s, this.human);
    // A choice taken since (or the unit gone) lowers what was put off: only newer level-ups count.
    for (const [id, n] of [...this.levelUpDeferred]) {
      const u = units.find((x) => x.id === id);
      if (!u || u.pendingLevelUps <= 0) this.levelUpDeferred.delete(id);
      else if (u.pendingLevelUps < n) this.levelUpDeferred.set(id, u.pendingLevelUps);
    }
    return levelUpsToOffer(units, this.levelUpDeferred);
  }

  /** "Decide later": every choice waiting now is put off (the HUD reminder and unit panel keep them). */
  private deferLevelUps(): void {
    const s = this.state;
    if (!s) return;
    for (const u of unitsOf(s, this.human)) if (u.pendingLevelUps > 0) this.levelUpDeferred.set(u.id, u.pendingLevelUps);
  }

  private maybeOpenLevelUp(onlyIfFree: boolean): void {
    if (onlyIfFree && this.ui.modal) return;
    const next = this.levelUpOffers()[0];
    if (next !== undefined) this.openModal('levelup', { unit: next });
  }

  /** Sync renderer + selection after state changed. */
  private afterChange(): void {
    if (!this.state) return;
    this.refreshNames();
    this.syncRenderer();
    this.refreshSelection();
    this.checkGameOver();
    this.notify();
  }

  private syncRenderer(): void {
    const s = this.state;
    if (!s) return;
    this.applyReveal();
    this.rememberSeen();
    try { this.renderer.sync(s); } catch (e) { console.error('[controller] renderer.sync failed', e); }
  }

  private checkGameOver(): void {
    const s = this.state;
    if (!s || !s.gameOver || this.endShown) return;
    this.endShown = true;
    const won = s.winner === this.human;
    playSfx(won ? 'victory' : 'defeat');
    music.duck(6);
    // A won war is over for good. After a defeat the saves stay: the player may retry the last
    // turn (same dice for the same moves: DESIGN §11) or load an older save.
    if (won) deleteSave();
    this.clearOverlaysForIdle();
    // The results screen says it all: the outcome toasts of the last blow go (DESIGN §10).
    this.setUi({
      modal: 'end', mode: { kind: 'idle' }, reach: [], ...EMPTY_FORECAST_UI, aiThinking: null, turnView: null, gameOverHeld: false,
      toasts: [], notice: null,
    });
    this.refreshSaves();
  }

  // ───────────────────────────── end turn & AI ─────────────────────────────

  async endTurn(): Promise<void> {
    const s = this.state;
    if (!s || s.gameOver || this.ui.busy || currentFaction(s) !== this.human) return;
    const token = this.token;
    this.clearOverlaysForIdle();
    // The end-of-turn resolution (construction, captures) is still the player's turn on screen.
    this.setUi({ mode: { kind: 'idle' }, modal: null, modalReturn: null, reach: [], ...EMPTY_FORECAST_UI, busy: true, turnView: { round: s.round, faction: this.human } });
    this.refreshNames();
    let res: ActionResult;
    try {
      res = applyAction(s, { type: 'endTurn', faction: this.human });
    } catch (e) {
      console.error('[controller] endTurn threw', e);
      res = { ok: false, error: 'internal error', events: [] };
    }
    if (!res.ok) {
      this.setUi({ busy: false, turnView: null });
      this.warn(res.error ?? 'Cannot end the turn now.');
      return;
    }
    this.version++;
    this.planCache.clear();
    this.aiRunning = true;
    try {
      await this.present(res.events, true, token);
      if (token !== this.token) return;
      this.syncRenderer();
      await this.runAiTurns(token);
    } catch (e) {
      console.error('[controller] turn flow failed', e);
    } finally {
      if (token === this.token) {
        this.aiRunning = false;
        this.setUi({ busy: false, aiThinking: null, turnView: null });
      }
    }
    if (token !== this.token || !this.state) return;
    this.afterChange();
    if (!this.state.gameOver && currentFaction(this.state) === this.human) this.onHumanTurnStart(true);
  }

  requestEndTurn(): void {
    const s = this.state;
    if (!s || this.ui.screen !== 'game') return;
    const now = performance.now();
    const prevPress = this.lastEndTurnPressAt;
    this.lastEndTurnPressAt = now;
    if (s.gameOver && !this.ui.gameOverHeld) {
      // Nothing left to end: show the results again (they may have been closed with "View the map").
      if (!this.ui.modal) this.openModal('end');
      return;
    }
    if (this.aiRunning) {
      if (!this.fastForward) {
        this.fastForward = true;
        this.applyFastForward();
        this.toast('Fast-forwarding the enemy turn…', 'info', { key: 'fast-forward' });
      }
      return;
    }
    // The level-up window opens by itself; it must not hold the turn: ending the turn puts the
    // choice off (as "Decide later" does). Other windows the player opened keep Space to themselves.
    if ((this.ui.modal && this.ui.modal !== 'levelup') || this.ui.busy) return;
    const grace = this.lastTurnFastForwarded ? END_TURN_GRACE_AFTER_FF_MS : END_TURN_GRACE_MS;
    if (!endTurnAllowed(now, this.humanTurnStartedAt, grace, prevPress)) return; // a stray second press
    if (this.ui.modal === 'levelup') this.closeModal();
    void this.endTurn();
  }

  /** Play every AI faction until it is the human's turn again (or the game ends). */
  private async runAiTurns(token: number): Promise<void> {
    const s = this.state;
    if (!s) return;
    const wasRunning = this.aiRunning;
    this.aiRunning = true;
    if (!this.ui.busy) this.setUi({ busy: true });
    let guard = 0;
    try {
      while (token === this.token && !s.gameOver && currentFaction(s) !== this.human && guard++ < 16) {
        await this.runAiFaction(currentFaction(s), token);
      }
      if (guard >= 16) console.error('[controller] AI turn loop did not return to the player');
    } finally {
      if (!wasRunning && token === this.token) {
        // Called directly (load / new game): finish the flow here.
        this.aiRunning = false;
        this.setUi({ busy: false, aiThinking: null, turnView: null });
        this.afterChange();
        if (!s.gameOver && currentFaction(s) === this.human) this.onHumanTurnStart(true);
      }
    }
  }

  private async runAiFaction(f: FactionId, token: number): Promise<void> {
    const s = this.state!;
    this.setUi({ aiThinking: FACTIONS[f]?.name ?? f, turnView: { round: s.round, faction: f } });
    let mem: AiMemory | null = null;
    try { mem = createAiMemory(s, f); } catch (e) { console.error('[ai] createAiMemory failed', e); }
    let count = 0;
    let fails = 0;
    let lastYield = performance.now();
    // The faction's actions are gathered into waves, each played as one schedule: independent
    // marches and fights play at the same time (the sim does not depend on the playback).
    let wave: GameEvent[] = [];
    let waveActions = 0;
    const playWave = async () => {
      const evs = wave;
      wave = [];
      waveActions = 0;
      if (evs.length && token === this.token) await this.present(evs, true, token);
    };
    while (mem && token === this.token && !s.gameOver && currentFaction(s) === f && count < AI_ACTION_CAP) {
      let a: Action | null;
      try {
        a = aiNextAction(s, mem);
      } catch (e) {
        console.error(`[ai] ${f} crashed — ending its turn`, e);
        break;
      }
      if (!a || a.type === 'endTurn') break;
      count++;
      // looks before this action; HUD copies from before the wave
      this.refreshNames(wave.length === 0);
      let r: ActionResult;
      try {
        r = applyAction(s, a);
      } catch (e) {
        console.error('[ai] action threw', a, e);
        r = { ok: false, error: 'threw', events: [] };
      }
      if (!r.ok) {
        mem.failed.add(actionKey(a));
        if (++fails > AI_FAIL_CAP) { console.warn(`[ai] ${f}: too many failed actions, ending turn`); break; }
        continue;
      }
      this.version++;
      if (r.events.length) {
        for (const ev of r.events) wave.push(ev);
        waveActions++;
        // Until the wave plays, the HUD keeps showing the units (and the war) as they were.
        this.holdOutcome(r.events, null);
        if (s.gameOver && !this.ui.gameOverHeld) this.setUi({ gameOverHeld: true });
      }
      // (the renderer re-syncs at the end of every playEvents call)
      if (waveActions >= WAVE_ACTIONS || s.gameOver) await playWave();
      if (performance.now() - lastYield > 12) {
        await yieldTask();
        lastYield = performance.now();
      }
    }
    await playWave();
    if (count >= AI_ACTION_CAP) console.warn(`[ai] ${f}: action cap reached`);
    if (token !== this.token || s.gameOver) return;
    if (currentFaction(s) === f) await this.forceEndTurn(f, token);
    // Always resync once per AI turn: hidden changes (territory, captures in the fog) too.
    this.syncRenderer();
  }

  /** End an AI faction's turn; falls back to sim/turn and finally a hard skip so the game never stalls. */
  private async forceEndTurn(f: FactionId, token: number): Promise<void> {
    const s = this.state!;
    let r: ActionResult | null = null;
    this.refreshNames();
    try { r = applyAction(s, { type: 'endTurn', faction: f }); } catch (e) { console.error('[ai] endTurn threw', e); }
    if (r && r.ok) {
      this.version++;
      await this.present(r.events, true, token);
      return;
    }
    console.error(`[ai] endTurn for ${f} rejected:`, r?.error);
    try {
      const ev = simEndTurn(s, f);
      this.version++;
      await this.present(ev, true, token);
      return;
    } catch (e) {
      console.error('[ai] sim endTurn failed', e);
    }
    // Last resort: hand the turn straight back to the player.
    const idx = s.turnOrder.indexOf(this.human);
    if (idx >= 0) {
      s.currentTurn = idx;
      try { await this.present(startTurn(s, this.human), true, token); } catch (e) { console.error(e); }
    }
  }

  private onHumanTurnStart(autosave: boolean): void {
    const s = this.state;
    if (!s) return;
    // End-turn presses right after control returns (a double tap, a fast-forward press landing
    // late) must not end this new turn: see requestEndTurn.
    this.lastTurnFastForwarded = this.fastForward;
    this.humanTurnStartedAt = performance.now();
    this.fastForward = false;
    this.friendlyArm = null;
    // The UI shows its own "Your Turn" banner. Nothing stays selected from the last turn: the panels
    // would show that hex's unit while the camera goes to the first unit awaiting orders.
    if (this.ui.mode.kind !== 'idle') this.clearSelection();
    this.clearOverlaysForIdle();
    this.setUi({ aiThinking: null, turnView: null, skippedUnits: [], selectedHex: null, gameOverHeld: false });
    if (autosave) this.autosave(false);
    try { this.turnStartData = serialize(s); } catch (e) { console.error('[controller] turn snapshot failed', e); this.turnStartData = null; }
    let focusHex: Hex | null = null;
    const first = this.awaitingOrders().map((id) => getUnit(s, id)).find(Boolean);
    if (first) focusHex = first.pos;
    if (!focusHex) {
      const leaderId = s.factions[this.human]?.leaderId;
      const leader = leaderId !== null && leaderId !== undefined ? getUnit(s, leaderId) : undefined;
      if (leader) focusHex = leader.pos;
    }
    if (focusHex) this.renderer.focus(focusHex);
    // Music follows the threat level: visible hostile armies near the player raise intensity.
    const threats = Object.values(s.units).filter((u) => u.faction !== this.human && u.faction !== 'neutral' && this.visible(u.pos)).length;
    if (threats >= 2) music.pulse(Math.min(0.5, threats * 0.08));
    this.maybeOpenLevelUp(true);
  }

  private focusHome(instant: boolean): void {
    const s = this.state;
    if (!s) return;
    const fs = s.factions[this.human];
    const castle = fs?.castleId !== null && fs?.castleId !== undefined ? getBuilding(s, fs.castleId) : undefined;
    const leader = fs?.leaderId !== null && fs?.leaderId !== undefined ? getUnit(s, fs.leaderId) : undefined;
    const h = castle?.pos ?? leader?.pos;
    if (h) {
      try { this.renderer.focus(h, instant); } catch (e) { console.error(e); }
    }
  }

  // ───────────────────────────── event presentation ─────────────────────────────

  /**
   * Animate a batch of events (the renderer plays the whole batch against its display model, so the
   * list is never split), with sounds placed on an estimated timeline. Enemy batches are planned
   * (planEnemy): independent beats play at the same time, the camera glides to what concerns the
   * player, the rest plays faster or is applied at once. Returns whether anything was visible.
   */
  private async present(events: GameEvent[], ai: boolean, token: number): Promise<boolean> {
    const s = this.state;
    if (!s || events.length === 0) return false;
    this.rememberSeen();
    // The war is over in the sim; the HUD says so only once the playback gets there.
    const overAt = events.findIndex((ev) => ev.type === 'gameOver');
    if (overAt >= 0 && !this.ui.gameOverHeld) this.setUi({ gameOverHeld: true });
    const visible = events.some((ev) => this.eventVisible(ev));
    // Outcome toasts (deaths, captures, level-ups…) wait for the animation that shows them.
    const cues = this.eventSideEffects(events, visible);
    this.addPhaseCues(events, cues);
    if (overAt >= 0) Controller.addCue(cues, overAt, () => { if (this.ui.gameOverHeld) this.setUi({ gameOverHeld: false }); });
    const speed = ai && this.fastForward ? FF_SPEED : this.ui.settings.animSpeed;
    const { steps, tiers, frames } = ai
      ? this.planEnemy(events, speed)
      : { steps: [{ events: events.map((_, i) => i), after: [] }] as PlaybackStep[], tiers: ['focus'] as StepTier[], frames: [null] };
    if (visible) this.holdOutcome(events, cues);
    else this.held = null;
    const fire = (i: number) => {
      const f = cues.get(i);
      if (!f) return;
      cues.delete(i);
      f();
    };
    const stops = new Map<number, () => void>();
    const live = { steps, tiers, started: new Set<number>() };
    if (ai) this.live = live;
    const plan: PlaybackPlan = {
      steps,
      onStepStart: async (k) => {
        live.started.add(k);
        if (token !== this.token) return;
        const step = steps[k];
        const at = frames[k];
        if (at) {
          // Glide to the next place of interest; the action starts as the camera settles.
          const pace = Math.max(1, (this.fastForward ? FF_SPEED : speed) ** 0.75);
          let dur = 0;
          try { dur = this.renderer.focus(at, false, pace) ?? 0; } catch (e) { console.error(e); }
          if (dur > 0) await sleep(dur * 700);
          return;
        }
        if (step.instant || step.events.length === 0) return;
        stops.set(k, this.scheduleSfx(events, step.events, step.speed ?? speed, cues.size ? fire : undefined));
      },
      onStepEnd: (k) => {
        stops.get(k)?.();
        stops.delete(k);
        if (token !== this.token) return;
        const step = steps[k];
        if (step.instant) this.settleHold(events, step.events);
        // whatever the step's timeline did not reach (hidden events, estimates running long) shows now
        for (const i of step.events) fire(i);
      },
    };
    try {
      await this.renderer.playEvents(s, events, speed, plan);
    } catch (e) {
      console.error('[controller] playEvents failed', e);
    } finally {
      for (const stop of stops.values()) stop();
      if (this.live === live) this.live = null;
      if (this.held) { this.held = null; this.notify(); }
      if (token === this.token) for (const i of [...cues.keys()].sort((a, b) => a - b)) fire(i);
    }
    return visible;
  }

  /**
   * Schedule an enemy batch: split it into beats (render/playback.splitBeats), each waiting only for
   * the earlier beats it shares a unit, hex or building with. Beats that concern the player are
   * framed: each joins the first camera view (from the one its dependencies end in) that shows it,
   * else opens a new one; a view's camera step glides there once the previous view's framed beats
   * have played, and its beats wait for the glide. Other beats in view play faster; the rest (off
   * screen, unseen) is applied at once. With *Watch all* every visible beat is framed.
   */
  private planEnemy(events: GameEvent[], speed: number): { steps: PlaybackStep[]; tiers: StepTier[]; frames: (Hex | null)[] } {
    const s = this.state!;
    const beats = splitBeats(events, {
      unitPos: (id) => this.preUnits.get(id)?.pos ?? this.unitInfo.get(id)?.pos ?? getUnit(s, id)?.pos,
      buildingPos: (id) => getBuilding(s, id)?.pos,
      unitSpeed: (id) => gait(this.unitInfo.get(id) ?? (getUnit(s, id) ? lookOf(getUnit(s, id)!) : undefined)).speed,
    });
    const deps = beatDependencies(beats);
    const watchAll = this.ui.settings.watchEnemyMoves === 'all' && !this.fastForward;
    // views[0]: where the camera is (heading) now; later ones: centred on a framed beat
    const views: { at: Hex | null; framed: number[] }[] = [{ at: null, framed: [] }];
    const viewOf: number[] = [];
    const tierOf: Exclude<StepTier, 'camera'>[] = [];
    beats.forEach((b, j) => {
      const evs = b.events.map((i) => events[i]);
      const from = [...deps[j].after, ...deps[j].lag.map(([d]) => d)].reduce((m, d) => Math.max(m, viewOf[d]), 0);
      let tier = this.beatKind(evs, watchAll);
      let v = from;
      if (tier === 'focus') {
        const h = this.frameHex(evs);
        if (h) {
          v = -1;
          for (let k = from; k < views.length && v < 0; k++) if (this.inView(h, views[k].at)) v = k;
          if (v < 0) { views.push({ at: h, framed: [] }); v = views.length - 1; }
        }
        views[v].framed.push(j);
      } else if (tier === 'glance') {
        v = -1;
        for (let k = from; k < views.length && v < 0; k++) if (this.seenIn(evs, views[k].at)) v = k;
        if (v < 0) { tier = 'instant'; v = from; }
      }
      viewOf[j] = v;
      tierOf[j] = tier;
    });
    // Emit view by view (sequence order inside a view): every dependency comes first.
    const order = beats.map((_, j) => j).sort((x, y) => viewOf[x] - viewOf[y] || x - y);
    const steps: PlaybackStep[] = [];
    const tiers: StepTier[] = [];
    const frames: (Hex | null)[] = [];
    const stepOf: number[] = [];
    let view = 0;
    let camera = -1;
    const struck = new Set<UnitId>();
    for (const j of order) {
      while (view < viewOf[j]) {
        // the camera moves on once what concerns the player in the last view has played (not side shows)
        const after = views[view].framed.map((x) => stepOf[x]);
        if (camera >= 0) after.push(camera);
        view++;
        steps.push({ events: [], after: after.sort((x, y) => x - y) });
        tiers.push('camera');
        frames.push(views[view].at);
        camera = steps.length - 1;
      }
      const tier = tierOf[j];
      const after = new Set(deps[j].after.map((d) => stepOf[d]));
      if (tier !== 'instant' && camera >= 0) after.add(camera);
      const march = beats[j].events.every((i) => events[i].type === 'unitMoved' || events[i].type === 'log');
      let pileOn = false;
      for (const i of beats[j].events) {
        const ev = events[i];
        if (ev.type !== 'combat') continue;
        if (struck.has(ev.defender)) pileOn = true;
        struck.add(ev.defender);
      }
      steps.push({
        events: beats[j].events, after: [...after].sort((x, y) => x - y),
        ...(deps[j].lag.length ? { lag: deps[j].lag.map(([d, t]) => [stepOf[d], t] as [number, number]) } : {}),
        instant: tier === 'instant', speed: speed * (tier === 'glance' ? GLANCE_PACE : march ? MARCH_PACE : pileOn ? PILE_ON_PACE : 1),
      });
      tiers.push(tier);
      frames.push(null);
      stepOf[j] = steps.length - 1;
    }
    return { steps, tiers, frames };
  }

  /** How an enemy beat is shown (see planEnemy); 'glance' still needs a view that shows it. */
  private beatKind(evs: GameEvent[], watchAll: boolean): Exclude<StepTier, 'camera'> {
    const seen = evs.filter((ev) => this.eventVisible(ev));
    if (seen.length === 0) return 'instant';
    if (watchAll || seen.some((ev) => this.concernsHuman(ev))) return 'focus';
    return this.fastForward ? 'instant' : 'glance';
  }

  /** Some visible part of the beat is on screen in that view. */
  private seenIn(evs: GameEvent[], view: Hex | null): boolean {
    return evs.some((ev) => this.eventVisible(ev) && (ev.type === 'unitMoved' ? ev.path : [this.eventHex(ev)])
      .some((h) => !!h && this.visible(h) && this.inView(h, view)));
  }

  /** Fast-forward: the steps not started yet play at FF speed, and only what concerns the player is animated. */
  private applyFastForward(): void {
    const live = this.live;
    if (!live) return;
    live.steps.forEach((st, k) => {
      if (live.started.has(k)) return;
      st.speed = FF_SPEED;
      if (live.tiers[k] === 'glance') st.instant = true;
    });
  }

  /** Add `fn` to the cue of event i (several effects may share one event). */
  private static addCue(cues: Map<number, () => void>, i: number, fn: () => void): void {
    const prev = cues.get(i);
    cues.set(i, prev ? () => { prev(); fn(); } : fn);
  }

  /**
   * Turn indicators follow the playback, not the sim (which has already advanced): the wild
   * monsters' phase and each faction's turn start are shown when the timeline reaches them.
   */
  private addPhaseCues(events: GameEvent[], cues: Map<number, () => void>): void {
    events.forEach((ev, i) => {
      if (ev.type === 'neutralPhase') {
        Controller.addCue(cues, i, () => this.setUi({ turnView: { round: ev.round, faction: 'neutral' }, aiThinking: FACTIONS.neutral?.name ?? 'The Wilds' }));
      } else if (ev.type === 'turnStarted') {
        Controller.addCue(cues, i, () => this.setUi({
          turnView: { round: ev.round, faction: ev.faction },
          aiThinking: ev.faction === this.human ? null : FACTIONS[ev.faction]?.name ?? ev.faction,
        }));
      }
    });
  }

  /**
   * Hold the HUD-visible outcome back (unit panel HP / XP / level, chronicle lines) until the
   * animation shows it: units named by the batch are shown as they were before it, and
   * scheduleSfx releases them on the same timeline as the sounds. Without cues (an enemy wave still
   * being gathered) the hold is extended instead of replaced.
   */
  private holdOutcome(events: GameEvent[], cues: Map<number, () => void> | null): void {
    const prev = cues ? null : this.held;
    const units = prev?.units ?? new Map<UnitId, Unit>();
    const hiddenLog = prev?.hiddenLog ?? new Set<LogEntry>();
    const lastNamed = new Map<UnitId, number>();
    const grab = (id: UnitId, i: number) => {
      lastNamed.set(id, i);
      if (units.has(id)) return;
      const pre = this.preUnits.get(id);
      if (pre) units.set(id, heldCopy(pre));
    };
    events.forEach((ev, i) => {
      switch (ev.type) {
        case 'combat': grab(ev.attacker, i); grab(ev.defender, i); break;
        case 'unitDamaged': case 'unitHealed': case 'unitLeveled': case 'unitDied': grab(ev.unit, i); break;
        case 'log': {
          const entry = ev.entry;
          hiddenLog.add(entry);
          if (cues) Controller.addCue(cues, i, () => { if (this.held?.hiddenLog.delete(entry)) this.notify(); });
          break;
        }
        default: break;
      }
    });
    this.held = units.size || hiddenLog.size ? { units, hiddenLog, lastNamed } : null;
  }

  /** An instant step (not animated): its outcome reaches the held HUD copies at once. */
  private settleHold(events: GameEvent[], idx: readonly number[]): void {
    const hd = this.held;
    if (!hd) return;
    const before = hd.units.size;
    let changed = false;
    for (const i of idx) {
      const ev = events[i];
      const u = (id: UnitId) => hd.units.get(id);
      switch (ev.type) {
        case 'combat': {
          const a = u(ev.attacker), d = u(ev.defender);
          if (a) a.hp = ev.attackerHp;
          if (d) d.hp = ev.defenderHp;
          changed ||= !!(a || d);
          break;
        }
        case 'unitDamaged': { const v = u(ev.unit); if (v) { v.hp = Math.max(0, v.hp - ev.amount); changed = true; } break; }
        case 'unitHealed': { const v = u(ev.unit); if (v) { v.hp += ev.amount; v.poisoned = false; changed = true; } break; }
        case 'unitDied': case 'unitLeveled': hd.units.delete(ev.unit); break;
        default: break;
      }
    }
    if (changed || hd.units.size !== before) this.notify();
  }

  /** A held unit may show its live state from event i on: nothing later in the batch names it. */
  private releasable(id: UnitId, i: number): boolean {
    const last = this.held?.lastNamed.get(id);
    return last === undefined || last <= i;
  }

  /** Events the player must see play out: attacks on them, losses, threats near their holdings. */
  private concernsHuman(ev: GameEvent): boolean {
    const s = this.state!;
    const factionOf = (id: UnitId) => getUnit(s, id)?.faction ?? this.unitInfo.get(id)?.faction;
    switch (ev.type) {
      case 'combat': return factionOf(ev.attacker) === this.human || factionOf(ev.defender) === this.human;
      case 'unitDied': return ev.faction === this.human;
      case 'buildingCaptured': return ev.from === this.human;
      case 'factionEliminated': case 'gameOver': return true;
      case 'spellCast': return ev.affected.some((id) => factionOf(id) === this.human) || this.nearHuman(ev.target);
      case 'skillUsed': return (ev.targets ?? []).some((id) => factionOf(id) === this.human) || (!!ev.target && this.nearHuman(ev.target));
      case 'unitDamaged': return factionOf(ev.unit) === this.human && (ev.source === 'spell' || ev.source === 'skill');
      case 'unitMoved': return ev.path.length > 0 && this.nearHuman(ev.path[ev.path.length - 1]);
      case 'buildingDestroyed': case 'unitSpawned': return this.nearHuman(ev.pos);
      default: return false;
    }
  }

  /** Within NEAR_PLAYER hexes of one of the player's units or buildings. */
  private nearHuman(h: Hex): boolean {
    const s = this.state!;
    for (const k in s.units) { const u = s.units[k]; if (u.faction === this.human && hexDistance(u.pos, h) <= NEAR_PLAYER) return true; }
    for (const k in s.buildings) { const b = s.buildings[k]; if (b.owner === this.human && hexDistance(b.pos, h) <= NEAR_PLAYER) return true; }
    return false;
  }

  /**
   * Comfortably inside the view (not at the edges, where the camera would glide) once the camera
   * settles: where it is heading now, or (with `view`) centred on that hex.
   */
  private inView(h: Hex, view: Hex | null = null): boolean {
    if (typeof window === 'undefined') return false;
    let p: { x: number; y: number; visible: boolean };
    try { p = this.renderer.hexToView(h, view ?? undefined); } catch { return false; }
    const w = window.innerWidth, hh = window.innerHeight;
    return p.visible && p.x > w * 0.12 && p.x < w * 0.88 && p.y > hh * 0.14 && p.y < hh * 0.86;
  }

  private eventHex(ev: GameEvent): Hex | null {
    const s = this.state!;
    switch (ev.type) {
      case 'unitMoved': return ev.path.length ? ev.path[ev.path.length - 1] : getUnit(s, ev.unit)?.pos ?? null;
      case 'combat': return this.unitPos(ev.defender) ?? this.unitPos(ev.attacker);
      case 'unitDied': return ev.pos;
      case 'unitDamaged': case 'unitHealed': case 'unitEquipped': case 'unitLeveled': return getUnit(s, ev.unit)?.pos ?? null;
      case 'unitSpawned': return ev.pos;
      case 'skillUsed': return ev.target ?? getUnit(s, ev.unit)?.pos ?? null;
      case 'buildingStarted': case 'buildingProgress': case 'buildingCompleted': case 'buildingCaptured':
        return getBuilding(s, ev.building)?.pos ?? null;
      case 'buildingDestroyed': return ev.pos;
      case 'spellCast': return ev.target;
      case 'ruinsExplored': return ev.pos;
      default: return null;
    }
  }

  private eventVisible(ev: GameEvent): boolean {
    const s = this.state!;
    if (this.reveal) return true;
    switch (ev.type) {
      case 'unitMoved': return ev.path.some((h) => this.visible(h));
      case 'combat': {
        // a unit killed in this batch is gone from state: use its look from before the action
        const a = getUnit(s, ev.attacker) ?? this.unitInfo.get(ev.attacker);
        const d = getUnit(s, ev.defender) ?? this.unitInfo.get(ev.defender);
        return (!!a && this.visible(a.pos)) || (!!d && this.visible(d.pos)) || a?.faction === this.human || d?.faction === this.human;
      }
      // the player always sees its own units fall, even where nothing of theirs still looks
      case 'unitDied': return ev.faction === this.human || this.visible(ev.pos);
      case 'spellCast': return ev.faction === this.human || this.visible(ev.target) || this.visible(ev.from);
      case 'turnStarted': return ev.faction === this.human;
      case 'researchCompleted': case 'itemCrafted': return ev.faction === this.human;
      case 'factionEliminated': case 'gameOver': return true;
      case 'log': return false;
      default: {
        const h = this.eventHex(ev);
        return !!h && this.visible(h);
      }
    }
  }

  /** Where the camera should look for a beat: its first visible animated event (a march: where it is first seen). */
  private frameHex(events: GameEvent[]): Hex | null {
    const lead = events.find((ev) => FRAMED_EVENTS.has(ev.type) && this.eventVisible(ev));
    if (!lead) return null;
    let h: Hex | null = null;
    if (lead.type === 'unitMoved') h = lead.path.find((p) => this.visible(p)) ?? null;
    return h ?? this.eventHex(lead);
  }

  private panFor(h: Hex | null): number {
    if (!h || typeof window === 'undefined') return 0;
    try {
      const p = this.renderer.hexToScreen(h);
      return clamp((p.x / Math.max(1, window.innerWidth)) * 2 - 1, -1, 1) * 0.65;
    } catch {
      return 0;
    }
  }

  /**
   * Schedule the sounds of an event sequence on a timeline that mirrors the renderer's
   * playback (only visible events take time). Returns a canceller run when playback ends:
   * anything not yet played by then (footsteps, late hits) is dropped rather than heard late.
   * `onEvent(i)` is called when the timeline reaches visible event i (outcome toasts). `idx`: the
   * events of one playback step (its timeline starts now).
   */
  private scheduleSfx(events: GameEvent[], idx: readonly number[], speed: number, onEvent?: (i: number) => void): () => void {
    const s = this.state!;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (sec: number, name: SfxName, h: Hex | null, gain = 1, pitch = 1) => {
      timers.push(setTimeout(() => playSfx(name, { pan: this.panFor(h), gain, pitch }), Math.max(0, (sec / speed) * 1000)));
    };
    const cue = (sec: number, i: number) => {
      if (onEvent) timers.push(setTimeout(() => onEvent(i), Math.max(0, (sec / speed) * 1000)));
    };
    /** Update the HUD hold (unit panel numbers) at a point of the timeline. */
    const hold = (sec: number, fn: (h: NonNullable<Controller['held']>) => void) => {
      if (!this.held) return;
      timers.push(setTimeout(() => { if (this.held) { fn(this.held); this.notify(); } }, Math.max(0, (sec / speed) * 1000)));
    };
    const posOf = (id: UnitId): Hex | null => this.unitPos(id);
    const look = (id: UnitId): UnitLook | undefined => this.unitInfo.get(id) ?? (getUnit(s, id) ? lookOf(getUnit(s, id)!) : undefined);
    let t = 0;
    for (let p = 0; p < idx.length; p++) {
      const i = idx[p];
      const ev = events[i];
      // Chronicle lines and turn markers take no time: they show where the timeline reaches them.
      if (ev.type === 'log' || ev.type === 'neutralPhase' || ev.type === 'turnStarted') cue(t, i);
      if (!this.eventVisible(ev)) continue;
      cue(t, i);
      switch (ev.type) {
        case 'unitMoved': {
          const g = gait(look(ev.unit));
          const dur = (ev.path.length * HEX_STEP) / g.speed;
          const steps = Math.max(1, Math.floor(dur / g.step));
          for (let k = 0; k < steps; k++) {
            const h = ev.path[Math.min(ev.path.length - 1, Math.floor((k / steps) * ev.path.length))];
            if (this.visible(h)) at(t + k * g.step + 0.05, 'step', h, g.gain, g.pitch * (0.94 + Math.random() * 0.12));
          }
          t += dur;
          break;
        }
        case 'combat': {
          const aPos = posOf(ev.attacker);
          // the defender may be dead by now: its death event carries the position
          const died = events.find((e, k) => k > i && e.type === 'unitDied' && e.unit === ev.defender) as Extract<GameEvent, { type: 'unitDied' }> | undefined;
          const dPos = posOf(ev.defender) ?? died?.pos ?? null;
          const dist = aPos && dPos ? hexDistance(aPos, dPos) : 1;
          const aLook = look(ev.attacker);
          const dLook = look(ev.defender);
          const dMain = dLook?.main;
          const defKind = ev.kind === 'melee' ? 'melee' : dMain === 'staff' || dMain === 'wand' ? 'magic' : dMain === 'bow' ? 'ranged' : ev.kind;
          let c = t + COMBAT_LEAD;
          for (const st of ev.strikes) {
            const byA = st.by === 'attacker';
            const kind = byA ? ev.kind : defKind;
            const who = byA ? aLook : dLook;
            const target = byA ? dPos : aPos;
            const src = byA ? aPos : dPos;
            const tm = strikeTiming(who, kind, dist);
            if (st.hit && (st.damage > 0 || st.drained || st.poisoned)) {
              const victim = byA ? ev.defender : ev.attacker, striker = byA ? ev.attacker : ev.defender;
              hold(c + tm.impact, (hd) => {
                const v = hd.units.get(victim);
                if (v) { v.hp = Math.max(0, v.hp - st.damage); if (st.poisoned) v.poisoned = true; }
                const sk = hd.units.get(striker);
                if (sk && st.drained) sk.hp += st.drained;
              });
            }
            if (kind === 'melee') {
              if (st.hit) {
                at(c + tm.impact, who?.monster ? 'hit' : Math.random() < 0.6 ? 'clash' : 'hit', target);
                if (st.poisoned) at(c + tm.impact + 0.1, 'poison', target, 0.7);
              } else at(c + tm.impact - 0.08, 'miss', target);
            } else if (kind === 'ranged') {
              at(c + tm.release - 0.04, 'bow', src);
              at(c + tm.release + 0.05, 'arrowWhoosh', target, 0.8);
              at(c + tm.impact, st.hit ? 'arrowHit' : 'miss', target, st.hit ? 1 : 0.5);
            } else {
              at(c + tm.release - 0.05, 'magicWhoosh', src);
              at(c + tm.impact, st.hit ? 'magicHit' : 'miss', target, st.hit ? 1 : 0.5);
            }
            c += tm.total;
          }
          t = c + COMBAT_TAIL;
          // Exchange over: exact HP; survivors fall back to the live state (XP, level).
          hold(t, (hd) => {
            const a = hd.units.get(ev.attacker), d = hd.units.get(ev.defender);
            if (a) a.hp = ev.attackerHp;
            if (d) d.hp = ev.defenderHp;
            if (getUnit(s, ev.attacker) && this.releasable(ev.attacker, i)) hd.units.delete(ev.attacker);
            if (getUnit(s, ev.defender) && this.releasable(ev.defender, i)) hd.units.delete(ev.defender);
          });
          music.pulse(0.18);
          break;
        }
        case 'unitDied': {
          at(t + 0.05, 'death', ev.pos, look(ev.unit)?.monster ? 0.8 : 1, look(ev.unit)?.monster ? 0.75 : 1);
          const dying = [ev.unit];
          // consecutive deaths play together in the renderer
          while (p + 1 < idx.length && events[idx[p + 1]].type === 'unitDied') {
            const k = idx[++p];
            cue(t, k);
            dying.push((events[k] as Extract<GameEvent, { type: 'unitDied' }>).unit);
          }
          hold(t, (hd) => { for (const id of dying) { const d = hd.units.get(id); if (d) d.hp = 0; } });
          t += look(ev.unit)?.monster ? 1.75 : DEATH_TIME;
          // the fallen stay in the unit panel until their death animation has played
          hold(t, (hd) => { for (const id of dying) hd.units.delete(id); });
          break;
        }
        case 'spellCast': {
          at(t, 'magicCast', ev.from);
          const d = hexDistance(ev.from, ev.target) * HEX_STEP;
          switch (ev.spell) {
            case 'fireball': {
              const flight = Math.min(0.85, 0.35 + d * 0.05);
              at(t + 0.2, 'magicWhoosh', ev.from);
              at(t + 0.22 + flight, 'explosion', ev.target);
              t += 0.22 + flight + 0.5;
              music.pulse(0.15);
              break;
            }
            case 'storm':
              for (let k = 0; k < 4; k++) at(t + 0.35 + k * 0.24, 'lightning', ev.target, 0.8);
              t += 1.61;
              music.pulse(0.15);
              break;
            case 'heal': at(t + 0.15, 'heal', ev.target); t += 1.3; break;
            case 'bless': at(t + 0.15, 'bless', ev.target); t += 1.3; break;
            case 'haste': at(t + 0.12, 'haste', ev.target); t += 1.02; break;
            case 'farsight': at(t + 0.1, 'farsight', ev.target); t += 1.6; break;
            case 'summon': at(t + 0.1, 'summon', ev.target); t += 1.15; break;
          }
          break;
        }
        case 'skillUsed': {
          if (ev.skill === 'masonry' || ev.skill === 'devotion') break;
          const h = ev.target ?? posOf(ev.unit);
          const from = posOf(ev.unit);
          let dur = SKILL_TIME;
          switch (ev.skill) {
            case 'volley': {
              const flight = 0.24 + ((h && from ? hexDistance(h, from) : 2) * HEX_STEP + 0.3) * 0.085;
              at(t + 0.22, 'bow', from, 0.8);
              at(t + 0.3, 'bow', from, 0.6, 1.06);
              at(t + 0.3, 'arrowWhoosh', h);
              (ev.targets ?? []).forEach((_, k) => at(t + 0.26 + k * 0.07 + flight, 'arrowHit', h, 0.8));
              dur = 1.1;
              break;
            }
            case 'heal': at(t + 0.25, 'heal', h); break;
            case 'firebolt': {
              const flight = 0.2 + ((h && from ? hexDistance(h, from) : 2) * HEX_STEP + 0.3) * 0.075;
              at(t + 0.3, 'magicCast', from, 0.5);
              at(t + 1.2, 'magicWhoosh', from);
              at(t + 1.2 + flight, 'explosion', h, 0.55);
              dur = 1.2 + flight;
              break;
            }
            case 'rally': at(t + 0.1, 'turnHorn', from, 0.7); break;
            case 'fortify': at(t, 'equip', from); at(t + 0.15, 'bless', from, 0.7); break;
            case 'powerstrike': at(t, 'magicCast', from, 0.6, 0.6); break;
            case 'blink': at(t + 0.1, 'spawn', from); at(t + 1.2, 'spawn', h, 0.7, 1.2); break;
            default: break;
          }
          t += dur;
          break;
        }
        case 'unitSpawned':
          if (ev.reason === 'recruit') { at(t, 'coin', ev.pos); at(t + 0.1, 'spawn', ev.pos); }
          else if (ev.reason === 'summon') at(t, 'spawn', ev.pos);
          t += SPAWN_TIME;
          break;
        case 'unitDamaged': {
          if (ev.source === 'poison') at(t, 'poison', posOf(ev.unit), 0.6);
          const id = ev.unit, amount = ev.amount;
          hold(t, (hd) => { const u = hd.units.get(id); if (u) u.hp = Math.max(0, u.hp - amount); });
          break;
        }
        case 'unitHealed': {
          const id = ev.unit, amount = ev.amount;
          hold(t, (hd) => { const u = hd.units.get(id); if (u) { u.hp += amount; u.poisoned = false; } });
          break;
        }
        case 'buildingStarted': at(t, 'hammer', getBuilding(s, ev.building)?.pos ?? null); t += 0.22; break;
        case 'buildingCompleted': at(t, 'buildComplete', getBuilding(s, ev.building)?.pos ?? null); t += CONSTRUCT_TIME; break;
        case 'buildingCaptured': at(t, 'capture', getBuilding(s, ev.building)?.pos ?? null); t += 0.3; break;
        case 'buildingDestroyed': at(t, 'destroy', ev.pos); t += DESTROY_TIME; break;
        case 'researchCompleted': at(t, 'research', null); break;
        case 'itemCrafted': at(t, 'craft', null); break;
        case 'unitEquipped': at(t, 'equip', posOf(ev.unit)); break;
        case 'unitLeveled': {
          at(t, 'levelUp', posOf(ev.unit));
          const id = ev.unit;
          hold(t, (hd) => { if (this.releasable(id, i)) hd.units.delete(id); });
          t += 0.25;
          break;
        }
        case 'ruinsExplored': at(t, 'coin', ev.pos); at(t + 0.15, 'research', ev.pos, 0.7); t += 0.45; break;
        case 'turnStarted': if (ev.faction === this.human) at(t, 'turnHorn', null); break;
        case 'factionEliminated': if (ev.faction !== this.human) at(t, 'capture', null); break;
        default: break;
      }
    }
    return () => { for (const id of timers) clearTimeout(id); };
  }

  /**
   * Toasts, music and bookkeeping for a beat (independent of visibility where it matters to the
   * player). Research, crafting and warnings show at once; outcome toasts are returned keyed by
   * event index, for present() to show when the animation reaches that event.
   */
  private eventSideEffects(chunk: GameEvent[], visible: boolean): Map<number, () => void> {
    const s = this.state!;
    const cues = new Map<number, () => void>();
    // One line for a fallen leader, not one per unit swept away with them; nothing once the
    // player's own house falls (the results screen says it) or while the results are up.
    const skip = skippedOutcomeToasts(chunk, this.human);
    const later = (i: number, text: string, kind: Toast['kind'], also?: () => void) => {
      if (skip.has(i)) return;
      Controller.addCue(cues, i, () => { if (this.ui.modal !== 'end') this.toast(text, kind); also?.(); });
    };
    chunk.forEach((ev, i) => {
      switch (ev.type) {
        case 'researchCompleted':
          // (part of the player's turn start, which may come after the wilds' phase in this batch)
          if (ev.faction === this.human) later(i, `Research complete: ${TECHS[ev.tech]?.name ?? ev.tech}`, 'good');
          break;
        case 'buildingCompleted': {
          const b = getBuilding(s, ev.building);
          if (b?.owner === this.human) later(i, `${BUILDINGS[b.type].name} completed`, 'good');
          break;
        }
        case 'buildingCaptured': {
          const b = getBuilding(s, ev.building);
          const name = b ? BUILDINGS[b.type].name : 'building';
          if (ev.to === this.human) later(i, `Captured ${name}`, 'good');
          else if (ev.from === this.human) later(i, `${FACTIONS[ev.to]?.name ?? ev.to} captured your ${name}!`, 'bad');
          break;
        }
        case 'unitDied':
          if (ev.faction === this.human) later(i, `${this.unitInfo.get(ev.unit)?.name ?? 'A unit'} has fallen`, 'bad', () => music.pulse(0.2));
          break;
        case 'unitLeveled': {
          const u = getUnit(s, ev.unit);
          if (u?.faction === this.human) later(i, `${u.name} reached level ${ev.level}!`, 'good');
          break;
        }
        case 'ruinsExplored': {
          const u = getUnit(s, ev.unit);
          if (u?.faction === this.human) later(i, `Ruins explored: ${ev.reward}`, 'good');
          break;
        }
        case 'factionEliminated':
          if (ev.faction !== this.human && ev.faction !== 'neutral') {
            const n = eliminationNotice(ev.faction, ev.by, this.human);
            const f = ev.faction;
            // (the war's last fall goes straight to the results screen: no banner over it)
            later(i, n.toast, 'good', () => { if (!s.gameOver) this.showNotice(n.title, n.sub, f); });
          }
          break;
        case 'itemCrafted':
          if (ev.faction === this.human) later(i, `Crafted ${ITEMS[ev.item]?.name ?? ev.item}`, 'good');
          break;
        case 'unitSpawned':
          if (ev.reason === 'recruit' || ev.reason === 'summon') {
            const u = getUnit(s, ev.unit);
            if (u) this.unitInfo.set(u.id, lookOf(u));
          }
          break;
        case 'combat':
          if (visible) music.pulse(0.06);
          break;
        case 'log':
          if (ev.entry.kind === 'warning' && ev.entry.faction === this.human) later(i, ev.entry.text, 'warning');
          break;
        case 'orderEnded': {
          const u = getUnit(s, ev.unit);
          if (u?.faction !== this.human) break;
          // (the unit is back on Tab: drop a Skip that would still pass it by this turn)
          const id = u.id;
          later(i, orderEndedText(s, u, ev), ev.reason === 'healed' ? 'good' : 'warning', () => {
            if (this.ui.skippedUnits.includes(id)) this.setUi({ skippedUnits: this.ui.skippedUnits.filter((x) => x !== id) });
          });
          break;
        }
        default: break;
      }
    });
    return cues;
  }

  /**
   * Snapshot unit looks (and HUD copies) before an action: dead units vanish from state. Within an
   * enemy wave (`reset` false) the looks follow each action while the HUD copies stay as they were
   * before the wave (its playback starts from there).
   */
  private refreshNames(reset = true): void {
    const s = this.state;
    if (!s) return;
    if (reset) {
      this.unitInfo.clear();
      this.preUnits.clear();
    }
    for (const u of Object.values(s.units)) {
      this.unitInfo.set(u.id, lookOf(u));
      if (!this.preUnits.has(u.id)) this.preUnits.set(u.id, heldCopy(u));
    }
  }

  // ───────────────────────────── visibility helpers ─────────────────────────────

  private visible(h: Hex): boolean {
    const s = this.state;
    if (!s) return false;
    if (this.reveal) return true;
    try { return isVisible(s, this.human, h); } catch { return false; }
  }

  /** Where a unit is, or (killed in the batch being presented) where it was before the action. */
  private unitPos(id: UnitId): Hex | null {
    return (this.state ? getUnit(this.state, id)?.pos : undefined) ?? this.unitInfo.get(id)?.pos ?? null;
  }

  private unitVisible(id: UnitId): boolean {
    const u = this.state ? getUnit(this.state, id) : undefined;
    return !!u && (u.faction === this.human || this.visible(u.pos));
  }

  private visibleUnitAt(h: Hex): Unit | null {
    const s = this.state;
    if (!s) return null;
    let u: Unit | undefined;
    try { u = unitAt(s, h); } catch { return null; }
    if (!u) return null;
    if (u.faction !== this.human && !this.visible(h)) return null;
    return u;
  }

  setRevealMap(on: boolean): void {
    this.reveal = on;
    const s = this.state;
    if (!s) return;
    if (!on) {
      try { computeVisibility(s, this.human); } catch (e) { console.error(e); }
    }
    this.version++;
    this.planCache.clear();
    this.syncRenderer();
    this.refreshSelection();
    this.toast(on ? 'Debug: map revealed' : 'Debug: fog of war restored', 'info', { key: 'debug-fog' });
  }

  /** Debug reveal: mark everything visible/explored for the player before each render sync. */
  private applyReveal(): void {
    const s = this.state;
    if (!this.reveal || !s) return;
    const fs = s.factions[this.human];
    if (!fs) return;
    fs.visible.fill(1);
    fs.explored.fill(1);
  }

  // ───────────────────────────── UI chrome ─────────────────────────────

  openModal(m: ModalId, opts?: { site?: BuildingInstanceId; unit?: UnitId }): void {
    const s = this.state;
    if (m === null) { this.closeModal(); return; }
    const patch: Partial<UiState> = { modal: m, ...EMPTY_FORECAST_UI };
    switch (m) {
      case 'recruit': {
        if (!s) return;
        let site = opts?.site ?? null;
        if (site === null && this.ui.selectedHex) {
          const b = buildingAt(s, this.ui.selectedHex);
          if (b && b.owner === this.human && BUILDINGS[b.type].recruits?.length) site = b.id;
        }
        if (site === null) { this.warn('Select one of your castles, houses, training grounds or mage towers to recruit.', MODAL_HINT); return; }
        patch.recruitSite = site;
        break;
      }
      case 'forge': {
        if (!s) return;
        let site = opts?.site ?? null;
        if (site === null) {
          const forge = buildingsOf(s, this.human).find((b) => b.type === 'forge' && b.buildLeft === 0 && !b.upgrading)
            ?? buildingsOf(s, this.human).find((b) => b.type === 'forge');
          site = forge?.id ?? null;
        }
        // Without a forge the modal still opens as a stockpile view (crafting disabled).
        patch.forgeSite = site;
        break;
      }
      case 'levelup': {
        if (!s) return;
        const unit = opts?.unit ?? this.pendingLevelUpUnits()[0];
        if (unit === undefined) return;
        patch.levelUpUnit = unit;
        break;
      }
      case 'equip': case 'build': {
        if (!s) return;
        const unit = opts?.unit ?? this.selectedOwnUnit()?.id;
        if (unit === undefined) { this.warn('Select a unit first.', MODAL_HINT); return; }
        const u = getUnit(s, unit);
        if (!u || u.faction !== this.human) return;
        const blocked = m === 'build' ? buildMenuBlock(u, canBuildWith(u)) : null;
        if (blocked) { this.warn(blocked, MODAL_HINT); return; }
        patch.mode = { kind: 'unit', unit };
        patch.selectedHex = u.pos;
        break;
      }
      case 'unitsheet': {
        // Any unit the player can see (enemies read-only): the one asked for, else the selection.
        if (!s) return;
        const m = this.ui.mode;
        const atHex = this.ui.selectedHex ? unitAt(s, this.ui.selectedHex) : undefined;
        const unit = opts?.unit ?? (m.kind === 'unit' || m.kind === 'skill' || m.kind === 'attack' ? m.unit : atHex?.id);
        const u = unit !== undefined ? getUnit(s, unit) : undefined;
        if (!u || (u.faction !== this.human && !isVisible(s, this.human, u.pos))) { this.warn('Select a unit first.', MODAL_HINT); return; }
        patch.sheetUnit = u.id;
        break;
      }
      default: break;
    }
    const wasOpen = this.ui.modal;
    if (wasOpen !== m) patch.modalReturn = returnTarget(wasOpen, m);
    // The "select X first" hint is answered once the window opens.
    if (this.ui.toasts.some((t) => t.key === MODAL_HINT)) patch.toasts = this.ui.toasts.filter((t) => t.key !== MODAL_HINT);
    this.setUi(patch);
    // (The map hover outline goes too; closing the window restores it under a still cursor.)
    this.setOverlays({ path: [], forecastTarget: null, areaCenter: null, hoverHex: null });
    if (patch.mode) this.refreshSelection();
    if (wasOpen !== m) playSfx('modalOpen');
  }

  closeModal(): void {
    if (!this.ui.modal) return;
    if (this.ui.modal === 'levelup') this.deferLevelUps();
    // Settings and Help opened from the pause menu go back to it; Equip and Level up opened from a
    // unit sheet go back to the sheet (its unit is still ui.sheetUnit).
    const ret = this.ui.modalReturn;
    const back = ret && returnTarget(ret, this.ui.modal) === ret && this.ui.screen === 'game' && !!this.state ? ret : null;
    this.setUi({ modal: back, modalReturn: null });
    playSfx('modalClose');
    this.updateHover();
  }

  toast(text: string, kind: Toast['kind'] = 'info', opts?: { key?: string }): void {
    const dur = (kind === 'bad' || kind === 'warning' ? 4200 : 3200) + Math.min(3000, text.length * 25);
    const now = Date.now();
    const key = opts?.key;
    const existing = this.ui.toasts.find((t) => t.text === text && t.until > now);
    let toasts: Toast[];
    if (existing && (!key || existing.key === key)) {
      toasts = this.ui.toasts.map((t) => (t === existing ? { ...t, until: now + dur } : t));
    } else {
      // A keyed toast replaces the live one with the same key ("Sound muted" → "Sound on").
      const keep = this.ui.toasts.filter((t) => t.until > now && (!key || t.key !== key) && t !== existing);
      toasts = [...keep, { id: ++this.toastId, text, kind, until: now + dur, ...(key ? { key } : {}) }].slice(-5);
    }
    this.setUi({ toasts });
    setTimeout(() => {
      const n = Date.now();
      const left = this.ui.toasts.filter((t) => t.until > n);
      if (left.length !== this.ui.toasts.length) this.setUi({ toasts: left });
    }, dur + 50);
  }

  private warn(text: string, key?: string): void {
    this.toast(text, 'warning', key ? { key } : undefined);
    playSfx('error', { gain: 0.8 });
  }

  private noticeId = 0;

  /** A banner over the map for a few seconds (a house destroyed); the next one replaces it. */
  private showNotice(title: string, sub: string, faction: FactionId): void {
    const id = ++this.noticeId;
    this.setUi({ notice: { id, title, sub, faction } });
    setTimeout(() => { if (this.ui.notice?.id === id) this.setUi({ notice: null }); }, NOTICE_MS);
  }

  focusHex(h: Hex): void {
    try { this.renderer.focus(h); } catch (e) { console.error(e); }
  }

  setSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void {
    const settings = { ...this.ui.settings, [key]: value } as UiSettings;
    switch (key) {
      case 'volume':
        audio.setVolume(settings.volume);
        if (settings.volume > 0) this.extra.lastVolume = settings.volume;
        break;
      case 'music': music.setEnabled(settings.music); break;
      case 'showGrid': this.setOverlays({ showGrid: settings.showGrid }); break;
      case 'quality': try { this.renderer.setQuality(settings.quality); } catch (e) { console.error(e); } break;
      default: break;
    }
    this.setUi({ settings });
    saveSettings(settings, this.extra);
  }

  // ───────────────────────────── keyboard commands ─────────────────────────────

  command(c: KeyCommand): void {
    const inGame = this.ui.screen === 'game' && !!this.state;
    switch (c) {
      case 'escape':
        if (this.ui.modal) {
          if (this.ui.modal === 'end') return;
          this.closeModal();
        } else if (!inGame) {
          return;
        } else if (this.ui.mode.kind !== 'idle') {
          this.cancelMode();
        } else if (this.ui.selectedHex) {
          this.setUi({ selectedHex: null });
        } else {
          this.openModal('menu');
        }
        return;
      case 'mute': {
        const v = this.ui.settings.volume;
        if (v > 0) {
          this.extra.lastVolume = v;
          this.setSetting('volume', 0);
          this.toast('Sound muted (N)', 'info', { key: 'sound' });
        } else {
          this.setSetting('volume', this.extra.lastVolume > 0 ? this.extra.lastVolume : 0.7);
          this.toast('Sound on', 'info', { key: 'sound' });
        }
        return;
      }
      case 'debug':
        if (!this.debug) this.debug = createDebugOverlay(this);
        this.debug.toggle();
        return;
      case 'grid':
        if (!inGame) return;
        this.setSetting('showGrid', !this.ui.settings.showGrid);
        return;
      case 'help':
        if (this.ui.screen === 'loading') return;
        this.toggleModal('help');
        return;
      default: break;
    }
    if (!inGame) return;
    if (c === 'endTurn') { this.requestEndTurn(); return; }
    if (this.ui.busy) return;
    switch (c) {
      case 'nextUnit': if (!this.ui.modal) this.nextIdleUnit(); return;
      case 'skipUnit': if (!this.ui.modal) this.skipUnit(); return;
      case 'research': this.toggleModal('research'); return;
      case 'spellbook': this.toggleModal('spellbook'); return;
      case 'forge': this.toggleModal('forge'); return;
      case 'build': {
        const a = hotkeyModalAction(this.ui.modal, 'build');
        if (a === 'close') { this.closeModal(); return; }
        if (a === 'none') return;
        const u = this.selectedOwnUnit();
        if (!u) { this.warn("Select your leader or a unit with Builder's Tools to build.", MODAL_HINT); return; }
        this.openModal('build', { unit: u.id });
        return;
      }
      case 'save': this.saveGame(); return;
      case 'details': {
        const u = this.shownUnitForSheet();
        if (!u) return;
        const a = hotkeyModalAction(this.ui.modal, 'unitsheet');
        if (a === 'close') this.closeModal();
        else if (a === 'open') this.openModal('unitsheet', { unit: u.id });
        return;
      }
      case 'levelUp': {
        const a = hotkeyModalAction(this.ui.modal, 'levelup');
        if (a === 'close') { this.closeModal(); return; }
        const u = this.selectedOwnUnit();
        if (a === 'none' || !u || !this.myTurn) return;
        if (u.pendingLevelUps > 0) this.openModal('levelup', { unit: u.id });
        else this.warn(`${u.name} has no level-up reward waiting.`);
        return;
      }
      default: break;
    }
    // The selected unit's commands (the command bar): own unit, own turn, no window open.
    if (this.ui.modal || !this.myTurn) return;
    const u = this.selectedOwnUnit();
    if (!u) return;
    const slot = skillSlotOf(c);
    if (slot !== null) {
      const skill = barSkills(u.actives, (a) => ACTIVES[a]?.cooldown)[slot];
      if (!skill) return;
      const m = this.ui.mode;
      if (m.kind === 'skill' && m.unit === u.id && m.skill === skill) this.cancelMode();
      else this.beginSkill(u.id, skill);
      return;
    }
    switch (c) {
      case 'attack': {
        const m = this.ui.mode;
        if (m.kind === 'attack' && m.unit === u.id) this.cancelMode();
        else this.beginAttack(u.id);
        return;
      }
      case 'orderHeal': this.giveOrder(u.id, u.order === 'heal' ? null : 'heal'); return;
      case 'orderSentry': this.giveOrder(u.id, u.order === 'sentry' ? null : 'sentry'); return;
      case 'upgrade': {
        let why: string | null = null;
        try { why = canUpgrade(this.state!, u); } catch { why = 'Cannot upgrade here.'; }
        if (why) { this.warn(why); return; }
        void this.dispatch({ type: 'upgrade', unit: u.id });
        return;
      }
      default: return;
    }
  }

  /** Window hotkeys share one rule: switch between light windows, never replace a decision (results, level-up…). */
  private toggleModal(m: Exclude<ModalId, null>): void {
    const a = hotkeyModalAction(this.ui.modal, m);
    if (a === 'close') this.closeModal();
    else if (a === 'open') this.openModal(m);
  }
}

export function createController(renderer: WorldRenderer, canvas: HTMLCanvasElement): GameController {
  return new Controller(renderer, canvas);
}

