// Save/load (versioned JSON envelope in localStorage) and persisted UI settings.
// Storage access is always guarded: private windows / disabled storage / quota errors must
// never break the game, they only surface as a failed save.
import type { FactionId, GameState } from '../core/types';
import { deserialize, serialize } from '../sim/state';
import { PLAYABLE_FACTIONS } from '../data/factions';
import type { NewGameSetup, UiSettings } from './store';

/** Manual save slot (menu "Save game" / Ctrl+S). Kept at the original key so older saves still load. */
export const SAVE_KEY = 'aether-iron-save-v1';
/** Autosave slot: start of every human turn, quitting, closing the tab. Never touches the manual save. */
export const AUTOSAVE_KEY = 'aether-iron-autosave-v1';

export type SaveSlot = 'manual' | 'auto';
export const SAVE_SLOTS: readonly SaveSlot[] = ['manual', 'auto'];
const slotKey = (slot: SaveSlot): string => (slot === 'auto' ? AUTOSAVE_KEY : SAVE_KEY);
export const SETTINGS_KEY = 'aether-iron-settings-v1';
export const SAVE_FORMAT = 'aether-iron-save';
export const SAVE_VERSION = 1;

export interface SaveMeta {
  savedAt: number;           // epoch ms
  round: number;
  faction: FactionId;        // human faction
  auto: boolean;
}

/** What each slot holds (null: empty or unusable). */
export interface SavesInfo { manual: SaveMeta | null; auto: SaveMeta | null }

export interface SaveEnvelope extends SaveMeta {
  format: typeof SAVE_FORMAT;
  version: number;
  data: string;              // sim/state.serialize output
}

/** Minimal Storage subset (lets tests pass a fake). */
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function storage(): KV | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null; // SecurityError when storage is disabled
  }
}

export function wrapSave(data: string, meta: SaveMeta): string {
  const env: SaveEnvelope = { format: SAVE_FORMAT, version: SAVE_VERSION, ...meta, data };
  return JSON.stringify(env);
}

/** Parse & validate an envelope; returns an error string when unusable. */
export function parseSave(raw: string | null): SaveEnvelope | { error: string } {
  if (!raw) return { error: 'No saved game found.' };
  let env: unknown;
  try { env = JSON.parse(raw); } catch { return { error: 'The saved game is corrupted.' }; }
  if (!env || typeof env !== 'object') return { error: 'The saved game is corrupted.' };
  const e = env as Partial<SaveEnvelope>;
  if (e.format !== SAVE_FORMAT || typeof e.data !== 'string') return { error: 'The saved game is corrupted.' };
  if (e.version !== SAVE_VERSION) return { error: `The saved game is from an incompatible version (${String(e.version)}).` };
  return e as SaveEnvelope;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

export function saveGameState(state: GameState, auto: boolean, kv: KV | null = storage()): SaveResult {
  if (!kv) return { ok: false, error: 'Saving is unavailable (browser storage is disabled).' };
  try {
    const human = state.turnOrder.find((f) => state.factions[f]?.isHuman) ?? state.settings.playerFaction;
    kv.setItem(slotKey(auto ? 'auto' : 'manual'), wrapSave(serialize(state), { savedAt: Date.now(), round: state.round, faction: human, auto }));
    return { ok: true };
  } catch (err) {
    const quota = err instanceof Error && /quota/i.test(err.name + err.message);
    return { ok: false, error: quota ? 'Not enough browser storage to save the game.' : 'Could not save the game.' };
  }
}

export type LoadResult = { ok: true; state: GameState; meta: SaveMeta; slot: SaveSlot } | { ok: false; error: string };

/** Load a slot; with no slot, the most recent usable one. */
export function loadGameState(slot: SaveSlot | null = null, kv: KV | null = storage()): LoadResult {
  if (!kv) return { ok: false, error: 'Loading is unavailable (browser storage is disabled).' };
  const which = slot ?? latestSlot(kv) ?? 'manual';
  let raw: string | null;
  try { raw = kv.getItem(slotKey(which)); } catch { return { ok: false, error: 'Could not read the saved game.' }; }
  const env = parseSave(raw);
  if ('error' in env) return { ok: false, error: env.error };
  try {
    const state = deserialize(env.data);
    if (!state || state.version !== 1 || !Array.isArray(state.tiles) || !state.factions) {
      return { ok: false, error: 'The saved game is corrupted.' };
    }
    return { ok: true, state, meta: metaOf(env), slot: which };
  } catch {
    return { ok: false, error: 'The saved game is corrupted.' };
  }
}

const metaOf = (env: SaveEnvelope): SaveMeta => ({ savedAt: env.savedAt, round: env.round, faction: env.faction, auto: !!env.auto });

/** Metadata of one slot (or, with no slot, of the most recent save), or null. */
export function saveInfo(slot: SaveSlot | null = null, kv: KV | null = storage()): SaveMeta | null {
  if (!kv) return null;
  if (slot === null) {
    const latest = latestSlot(kv);
    return latest ? saveInfo(latest, kv) : null;
  }
  try {
    const env = parseSave(kv.getItem(slotKey(slot)));
    if ('error' in env) return null;
    return metaOf(env);
  } catch {
    return null;
  }
}

/** Both slots' metadata. */
export function savesInfo(kv: KV | null = storage()): SavesInfo {
  return { manual: saveInfo('manual', kv), auto: saveInfo('auto', kv) };
}

/** The slot holding the most recent usable save, or null when both are empty. */
export function latestSlot(kv: KV | null = storage()): SaveSlot | null {
  const m = saveInfo('manual', kv), a = saveInfo('auto', kv);
  if (m && a) return a.savedAt > m.savedAt ? 'auto' : 'manual';
  return m ? 'manual' : a ? 'auto' : null;
}

export function hasSavedGame(kv: KV | null = storage()): boolean {
  return latestSlot(kv) !== null;
}

/** Remove one slot, or both. */
export function deleteSave(kv: KV | null = storage(), slot: SaveSlot | null = null): void {
  for (const s of slot ? [slot] : SAVE_SLOTS) {
    try { kv?.removeItem(slotKey(s)); } catch { /* ignore */ }
  }
}

/** Short "Round 5 · 3 min ago" label for a save. */
export function describeSave(meta: SaveMeta, now = Date.now()): string {
  const ago = Math.max(0, now - meta.savedAt);
  const min = Math.floor(ago / 60000);
  const when = ago < 45000 ? 'just now' : min < 60 ? `${Math.max(1, min)} min ago`
    : min < 60 * 24 ? `${Math.floor(min / 60)} h ago` : new Date(meta.savedAt).toLocaleDateString();
  return `Round ${meta.round} · ${when}`;
}

// ───────────────────────────── settings ─────────────────────────────

export const DEFAULT_SETTINGS: UiSettings = {
  volume: 0.7,
  music: true,
  showGrid: true,
  animSpeed: 1,
  edgePan: true,
  quality: 'high',
  watchEnemyMoves: 'nearby',
};

/** Extra persisted preferences that are not part of UiSettings. */
export interface ExtraPrefs { lastVolume: number; newGame?: NewGameSetup }

/** Validate stored New Game choices (anything off → dropped). */
export function parseSetup(o: unknown): NewGameSetup | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const v = o as Record<string, unknown>;
  if (typeof v.playerFaction !== 'string' || !(PLAYABLE_FACTIONS as string[]).includes(v.playerFaction)) return undefined;
  if (v.aiCount !== 1 && v.aiCount !== 2) return undefined;
  if (v.mapSize !== 'small' && v.mapSize !== 'normal' && v.mapSize !== 'large') return undefined;
  if (v.difficulty !== 'easy' && v.difficulty !== 'normal' && v.difficulty !== 'hard') return undefined;
  return { playerFaction: v.playerFaction as NewGameSetup['playerFaction'], aiCount: v.aiCount, mapSize: v.mapSize, difficulty: v.difficulty };
}

/** Validate untrusted JSON into complete settings (unknown/invalid fields → defaults). */
export function parseSettings(raw: string | null): { settings: UiSettings; extra: ExtraPrefs } {
  const s: UiSettings = { ...DEFAULT_SETTINGS };
  const extra: ExtraPrefs = { lastVolume: DEFAULT_SETTINGS.volume };
  if (!raw) return { settings: s, extra };
  let o: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { settings: s, extra };
    o = parsed as Record<string, unknown>;
  } catch {
    return { settings: s, extra };
  }
  if (typeof o.volume === 'number' && Number.isFinite(o.volume)) s.volume = Math.min(1, Math.max(0, o.volume));
  if (typeof o.music === 'boolean') s.music = o.music;
  if (typeof o.showGrid === 'boolean') s.showGrid = o.showGrid;
  if (o.animSpeed === 1 || o.animSpeed === 2 || o.animSpeed === 4) s.animSpeed = o.animSpeed;
  if (typeof o.edgePan === 'boolean') s.edgePan = o.edgePan;
  if (o.quality === 'low' || o.quality === 'high') s.quality = o.quality;
  if (o.watchEnemyMoves === 'all' || o.watchEnemyMoves === 'nearby') s.watchEnemyMoves = o.watchEnemyMoves;
  const setup = parseSetup(o.newGame);
  if (setup) extra.newGame = setup;
  if (typeof o.lastVolume === 'number' && o.lastVolume > 0 && o.lastVolume <= 1) extra.lastVolume = o.lastVolume;
  return { settings: s, extra };
}

export function loadSettings(kv: KV | null = storage()): { settings: UiSettings; extra: ExtraPrefs } {
  let raw: string | null = null;
  try { raw = kv?.getItem(SETTINGS_KEY) ?? null; } catch { raw = null; }
  return parseSettings(raw);
}

export function saveSettings(settings: UiSettings, extra: ExtraPrefs, kv: KV | null = storage()): void {
  try { kv?.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, ...extra })); } catch { /* ignore */ }
}
