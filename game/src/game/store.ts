// UI-facing store: the only object Preact components talk to.
// Implemented by game/controller.ts (class GameController implements GameStore).
import type {
  ActiveId, Action, ActionResult, Building, BuildingInstanceId, CombatForecast, Difficulty, EffectPreview, FactionId, GameSettings,
  GameState, Hex, LogEntry, ReachInfo, SpellId, Unit, UnitId, UnitOrder,
} from '../core/types';
import type { SaveSlot, SavesInfo } from './session';

export type ModalId =
  | null | 'menu' | 'newgame' | 'research' | 'spellbook' | 'forge' | 'recruit' | 'levelup'
  | 'equip' | 'build' | 'help' | 'end' | 'settings' | 'unitsheet';

export type InteractionMode =
  | { kind: 'idle' }
  | { kind: 'unit'; unit: UnitId }                                   // unit selected: hover shows path / forecast
  | { kind: 'cast'; spell: SpellId; tower: BuildingInstanceId | null } // picking a spell target hex
  | { kind: 'skill'; unit: UnitId; skill: ActiveId }                  // picking a skill target
  /** Attack command (T, the command bar): only enemies attackable this turn are targets; any other click cancels. */
  | { kind: 'attack'; unit: UnitId };

export interface Toast {
  id: number; text: string; kind: 'info' | 'warning' | 'good' | 'bad'; until: number;
  /** Toasts sharing a key replace each other (e.g. "Sound muted" / "Sound on"). */
  key?: string;
}

/** Banner over the map (see UiState.notice). */
export interface Notice { id: number; title: string; sub: string; faction: FactionId }

/** The New Game choices last used (the setup screen starts from them). */
export interface NewGameSetup {
  playerFaction: FactionId;
  aiCount: 1 | 2;
  mapSize: GameSettings['mapSize'];
  difficulty: Difficulty;
}

export interface UiSettings {
  volume: number;          // 0..1
  music: boolean;
  showGrid: boolean;
  animSpeed: 1 | 2 | 4;    // AI / animation speed multiplier
  edgePan: boolean;
  quality: 'low' | 'high';
  /** Enemy turns: 'all' animates every visible action; 'nearby' skips distant marches and fights off screen. */
  watchEnemyMoves: 'all' | 'nearby';
}

export interface UiState {
  screen: 'loading' | 'title' | 'game';
  loadingProgress: number;           // 0..1 asset loading
  loadingLabel: string;
  modal: ModalId;
  mode: InteractionMode;
  selectedHex: Hex | null;
  hoverHex: Hex | null;
  reach: ReachInfo[];                // for the selected unit (own, current turn)
  forecast: CombatForecast | null;   // when hovering an attackable enemy
  forecastTarget: UnitId | null;
  /** Where the attacker strikes from when it must move first (null: from where it stands), with MP left there. */
  forecastFrom: { hex: Hex; mpLeft: number } | null;
  /** The other attack kind Shift would use against the hovered target (null: there is no other). */
  forecastAlt: { name: string; active: boolean } | null;
  /** Spell / skill targeting: what the hovered target would do, or why it is not a valid target. */
  effectPreview: EffectPreview | null;
  effectError: string | null;
  /**
   * Unit selected, hovering an empty hex past this turn's reach: trip length (turns, this one
   * included), or why it cannot go. `wait`: it cannot set out this turn because the first step
   * costs more MP than it has left (e.g. "Mountains take 3 MP, 1 left"); `turns` then counts from
   * this turn as well.
   */
  hoverToward: { turns: number; wait?: string } | { error: string } | null;
  busy: boolean;                     // animations / AI turn playing; input locked
  aiThinking: string | null;         // faction name while AI plays
  toasts: Toast[];
  settings: UiSettings;
  /** Site chosen for the recruit modal / forge chosen for the forge modal. */
  recruitSite: BuildingInstanceId | null;
  forgeSite: BuildingInstanceId | null;
  levelUpUnit: UnitId | null;
  /** Unit the unit sheet ('unitsheet') shows; absent / null: the selected unit. */
  sheetUnit?: UnitId | null;
  hasSave: boolean;
  /** What the manual and auto save slots hold. */
  saves: SavesInfo;
  /**
   * A short banner over the map for a moment that changes the war (a house destroyed): id keys
   * the animation, `faction` colours it. Null: none showing.
   */
  notice?: Notice | null;
  /** Own units told to wait this turn (Skip, X): left out of Tab and the idle count until next turn. */
  skippedUnits: UnitId[];
  /**
   * Whose turn the playing animations show (round, faction; 'neutral' = the wild monsters). Null:
   * follow the live state. The sim advances the turn at once, the playback catches up later.
   */
  turnView: { round: number; faction: FactionId } | null;
  /** Modal to go back to when this one closes (Settings / Help opened from the pause menu). */
  modalReturn: ModalId;
  /** New Game choices last used, or null. */
  lastSetup: NewGameSetup | null;
  /**
   * The war is over in the sim but the playback has not shown it yet (the killing blow is still
   * animating): the HUD keeps showing the war as running until then.
   */
  gameOverHeld?: boolean;
}

/** What the human last saw of each tile, indexed by tile index (null: no building / unclaimed). */
export interface LastSeenMap {
  readonly buildings: readonly (Building | null)[];
  readonly territory: readonly (FactionId | null)[];
}

export interface GameStore {
  readonly state: GameState | null;  // null until a game is started
  readonly ui: UiState;
  /**
   * Last-seen memory for explored but fogged tiles; the UI shows it there instead of the live
   * state. Optional so that dev stores may omit it (the UI then falls back to the live state).
   */
  lastSeen?(): LastSeenMap | null;
  /** Re-render subscription; returns unsubscribe. Called after every state/ui change. */
  subscribe(fn: () => void): () => void;

  // game lifecycle
  newGame(settings: GameSettings): void;
  saveGame(): void;
  /** Load a save slot; with no slot, the most recent save. */
  loadGame(slot?: SaveSlot): boolean;
  /** After a defeat: reload the start of the player's last turn. */
  retryLastTurn(): void;
  quitToTitle(): void;

  // interaction
  selectUnit(id: UnitId | null): void;
  selectHex(h: Hex | null): void;
  nextIdleUnit(): void;
  /** Leave the selected own unit be for the rest of this turn (out of Tab and the idle count). */
  skipUnit(): void;
  /** Apply an action for the human player, animate its events, re-sync. */
  dispatch(action: Action): Promise<ActionResult>;
  endTurn(): Promise<void>;
  /**
   * The player asked to end the turn (button, Space, Enter). During an enemy turn it fast-forwards
   * the playback instead; presses in the first ~0.7 s of the player's turn, and presses under
   * ~0.45 s after the previous one, are ignored, so a double press or mashing (or a press meant to
   * fast-forward) cannot skip the new turn. After the game ends it opens the
   * results. Other open windows hold it, except the level-up window (it opens by itself): ending the
   * turn puts that choice off, as "Decide later" does. endTurn() itself stays unguarded for scripts
   * and tests.
   */
  requestEndTurn(): void;
  beginCast(spell: SpellId): void;
  beginSkill(unit: UnitId, skill: ActiveId): void;
  /** Pick a target for the unit's attack (warns instead when it has acted or nothing is in reach). */
  beginAttack(unit: UnitId): void;
  /**
   * Give or clear (null) a standing order (DESIGN §4.10). Giving one moves the selection on to the
   * next unit awaiting orders, as Skip does.
   */
  giveOrder(unit: UnitId, order: UnitOrder | null): void;
  /**
   * Enemies the own unit can attack this turn, from where it stands or after moving (empty when
   * busy or not the player's turn). Optional for dev stores (the UI then counts targets from here).
   */
  attackableTargets?(unit: UnitId): UnitId[];
  cancelMode(): void;

  // UI chrome
  openModal(m: ModalId, opts?: { site?: BuildingInstanceId; unit?: UnitId }): void;
  closeModal(): void;
  toast(text: string, kind?: Toast['kind'], opts?: { key?: string }): void;
  focusHex(h: Hex): void;            // move the camera
  /** Project a hex to client pixels (for placing DOM panels); optional for dev stores. */
  hexToScreen?(h: Hex): { x: number; y: number; visible: boolean } | null;
  /**
   * The unit as the playing animation currently shows it (HP, XP, level held back until the
   * strike that changes them lands), or undefined to use the live state. Optional for dev stores.
   */
  shownUnit?(id: UnitId): Unit | undefined;
  /** False for a chronicle entry whose event has not been animated yet. Optional for dev stores. */
  logShown?(e: LogEntry): boolean;
  setSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void;
}
