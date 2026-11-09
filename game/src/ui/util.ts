// Pure helpers shared by the UI components: state queries that do not need the sim,
// defensive wrappers around sim helpers, and number/label formatting.
import type {
  AttackDef, Building, BuildingInstanceId, FactionId, GameState, Hex, ItemId, PresetId, ResourceCost, ResourceId, TechId, Tile, Unit, UnitId, UnitStats,
  XpCategory,
} from '../core/types';
import type { UiState } from '../game/store';
import { inBounds, tileIndex } from '../core/hex';
import { ITEMS } from '../data/items';
import { MONSTERS } from '../data/factions';
import { PRESETS } from '../data/presets';
import { XP_CATEGORIES, XP_CATEGORY_NAMES } from '../data/skills';
import { mainXpCategory } from '../sim/progression';

/** URL of a file under public/assets ('ui/menu_bg.jpg'), honouring Vite's `base` (e.g. GitHub Pages' /<repo>/). */
export function assetUrl(path: string): string {
  let base = import.meta.env?.BASE_URL ?? '/';
  if (!base.endsWith('/')) base += '/';
  return `${base}assets/${path.replace(/^\/+/, '')}`;
}

// ───────────────────────────── defensive sim calls ─────────────────────────────
const warned = new Set<string>();
/**
 * Run a sim query; on exception return `fallback`. The UI must never crash because one
 * helper misbehaves on an edge case (or is still being implemented in dev builds).
 */
/**
 * Why an option is not available, or null when it is. `error: null` means allowed, so this must
 * not be written `?.error ?? 'Unavailable'` (that turns every allowed option into an error).
 */
export function optionError<T extends { error: string | null }>(opts: readonly T[], match: (o: T) => boolean, myTurn: boolean): string | null {
  if (!myTurn) return 'Not your turn';
  const o = opts.find(match);
  return o ? o.error : 'Unavailable';
}

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (import.meta.env?.DEV) {
      const key = fn.toString().slice(0, 120);
      if (!warned.has(key)) { warned.add(key); console.warn('[ui] sim helper failed:', key, err); }
    }
    return fallback;
  }
}

// ───────────────────────────── state queries ─────────────────────────────
export const RESOURCE_ORDER: ResourceId[] = ['gold', 'food', 'wood', 'stone', 'iron', 'crystal', 'mana', 'research'];
export const RESOURCE_NAMES: Record<ResourceId, string> = {
  gold: 'Gold', food: 'Food', wood: 'Wood', stone: 'Stone', iron: 'Iron', crystal: 'Crystal', mana: 'Mana', research: 'Research',
};
export const XP_CATS: readonly XpCategory[] = XP_CATEGORIES;
export const XP_NAMES: Record<XpCategory, string> = XP_CATEGORY_NAMES;

/** The human player's faction (the viewer). */
export function viewerOf(s: GameState): FactionId {
  return s.turnOrder.find((f) => s.factions[f]?.isHuman) ?? s.settings.playerFaction;
}
export function currentOf(s: GameState): FactionId {
  return s.turnOrder[s.currentTurn] ?? s.turnOrder[0];
}
/** The war is over as the screen shows it (the playback has reached the end of the war). */
export function warOver(s: GameState, ui: UiState): boolean {
  return s.gameOver && !ui.gameOverHeld;
}
/** True when the human may act (their turn, nothing animating, game running). */
export function isMyTurn(s: GameState, ui: UiState): boolean {
  return !s.gameOver && currentOf(s) === viewerOf(s) && !ui.busy;
}

/**
 * Whose turn the screen should show: the playback's position (ui.turnView) while animations of
 * earlier phases still run, else the live state. Faction may be 'neutral' (the wilds' phase).
 */
export function displayTurn(s: GameState, ui: UiState): { round: number; faction: FactionId } {
  return ui.turnView ?? { round: s.round, faction: currentOf(s) };
}

export function tileAt(s: GameState, h: Hex): Tile | undefined {
  if (!inBounds(h, s.width, s.height)) return undefined;
  return s.tiles[tileIndex(h, s.width)];
}
export function hexVisible(s: GameState, f: FactionId, h: Hex): boolean {
  if (!inBounds(h, s.width, s.height)) return false;
  return !!s.factions[f]?.visible?.[tileIndex(h, s.width)];
}
export function hexExplored(s: GameState, f: FactionId, h: Hex): boolean {
  if (!inBounds(h, s.width, s.height)) return false;
  return !!s.factions[f]?.explored?.[tileIndex(h, s.width)];
}
export function unitById(s: GameState, id: UnitId | null | undefined): Unit | undefined {
  return id == null ? undefined : s.units[String(id)];
}
export function buildingById(s: GameState, id: BuildingInstanceId | null | undefined): Building | undefined {
  return id == null ? undefined : s.buildings[String(id)];
}
export function unitAtHex(s: GameState, h: Hex): Unit | undefined {
  for (const k in s.units) {
    const u = s.units[k];
    if (u.pos.q === h.q && u.pos.r === h.r && u.hp > 0) return u;
  }
  return undefined;
}
export function buildingAtHex(s: GameState, h: Hex): Building | undefined {
  const t = tileAt(s, h);
  if (t && t.building != null) return s.buildings[String(t.building)];
  for (const k in s.buildings) {
    const b = s.buildings[k];
    if (b.pos.q === h.q && b.pos.r === h.r) return b;
  }
  return undefined;
}
export function buildingsOwned(s: GameState, f: FactionId): Building[] {
  return Object.values(s.buildings).filter((b) => b.owner === f);
}
export function unitsOwned(s: GameState, f: FactionId): Unit[] {
  return Object.values(s.units).filter((u) => u.faction === f && u.hp > 0);
}
/** Completed (not under first construction). Upgrading buildings still work at their old level. */
export function isComplete(b: Building): boolean {
  return b.buildLeft <= 0 || b.upgrading;
}

/**
 * Unit whose details the left panel shows: the selected unit, else a visible unit on the selected
 * hex. `shown` (store.shownUnit) keeps a unit that just fell selected until its death has played.
 */
export function selectedUnitId(s: GameState, ui: UiState, shown?: (id: UnitId) => Unit | undefined): UnitId | null {
  const m = ui.mode;
  if ((m.kind === 'unit' || m.kind === 'skill' || m.kind === 'attack') && (s.units[String(m.unit)] || shown?.(m.unit))) return m.unit;
  if (ui.selectedHex) {
    const u = unitAtHex(s, ui.selectedHex);
    if (u && (u.faction === viewerOf(s) || hexVisible(s, viewerOf(s), u.pos))) return u.id;
  }
  return null;
}

// ───────────────────────────── unit presentation ─────────────────────────────
/** Display role from equipment ("Knight", "Archer", ...). */
export function unitRole(u: Unit): string {
  if (u.monster) return MONSTERS[u.monster]?.name ?? 'Monster';
  if (u.isLeader) return 'Leader';
  const e = u.equipment;
  switch (e.main) {
    case 'tools': return 'Builder';
    case 'sword': return e.mount ? 'Knight' : e.body === 'plate' ? 'Man-at-Arms' : 'Swordsman';
    case 'spear': return e.mount ? 'Lancer' : 'Spearman';
    case 'axe': return e.mount ? 'Raider' : 'Axeman';
    case 'bow': return e.mount ? 'Horse Archer' : 'Archer';
    case 'staff': return 'Battle Mage';
    case 'wand': return 'Apprentice';
    default: return e.body || e.off ? 'Militia' : 'Commoner';
  }
}

/** Research a preset's items need before it can be recruited (empty: none). Static over PRESETS/ITEMS. */
export function presetTechs(p: PresetId): TechId[] {
  const out: TechId[] = [];
  for (const i of PRESETS[p]?.items ?? []) {
    const t = ITEMS[i]?.unlock;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Body armour with its own portrait (and model): '<race>_padded', while the sim still calls the body 'commoner'. */
const PADDED_ITEM: ItemId = 'tunic';

/**
 * Portrait keys for a humanoid body, best first: a commoner in the Padded Tunic shows
 * '<race>_padded'; a missing armoured portrait falls back to the plain commoner (a leader's to
 * the silhouette: no commoner face for a leader).
 */
export function bodyPortraitKeys(race: string, body: string, bodyItem: ItemId | null | undefined): string[] {
  if (body === 'leader') return [`${race}_leader`];
  const keys: string[] = [];
  if (body === 'commoner' && bodyItem === PADDED_ITEM) keys.push(`${race}_padded`);
  keys.push(`${race}_${body}`);
  if (body !== 'commoner') keys.push(`${race}_commoner`);
  return keys;
}

/** Portrait keys for a unit, best first: '<race>_<body>' (see bodyPortraitKeys) or 'monster_<kind>'. */
export function portraitKey(u: Unit, body: string): string[] {
  if (u.monster) return [`monster_${u.monster}`];
  return bodyPortraitKeys(u.race, u.isLeader ? 'leader' : body, u.equipment?.body);
}

/** Portrait keys for a recruit preset: the body its armour gives (none: commoner). */
export function presetPortraitKeys(race: string, preset: PresetId): string[] {
  const item = PRESETS[preset]?.items.find((i) => ITEMS[i]?.slot === 'body');
  return bodyPortraitKeys(race, (item && ITEMS[item]?.body) || 'commoner', item);
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * XP segments for the stacked bar: share of each of the seven categories in the xp of the current
 * level, in XP_CATS order. XP without a tally (it should not happen) shows in the unit's main kind.
 */
export function xpSegments(u: Unit, toNext: number): { cat: XpCategory; frac: number; amount: number }[] {
  const total = XP_CATS.reduce((a, c) => a + Math.max(0, u.levelXpByCat?.[c] ?? 0), 0);
  const xp = Math.max(0, Math.min(u.xp, toNext));
  if (toNext <= 0 || xp <= 0) return [];
  if (total <= 0) return [{ cat: safe(() => mainXpCategory(u), 'melee'), frac: xp / toNext, amount: xp }];
  return XP_CATS
    .map((c) => {
      const share = Math.max(0, u.levelXpByCat?.[c] ?? 0) / total;
      return { cat: c, frac: (share * xp) / toNext, amount: Math.round(share * xp) };
    })
    .filter((seg) => seg.frac > 0);
}

/** Display damage per strike of an attack before target armor (mirrors DESIGN §4.4 for UI). */
export function displayDamage(u: Unit, a: AttackDef, stats: UnitStats, extraMult = 1): number {
  const stat = a.kind === 'melee' ? stats.str : a.kind === 'ranged' ? stats.dex : stats.int;
  const effKey = a.kind === 'melee' ? 'attack' : a.kind;
  let mult = (u.efficiency?.[effKey] ?? 1) * extraMult;
  // Power Strike only charges the next melee blow (sim/combat buffMult); Bless boosts every kind.
  for (const b of u.buffs ?? []) if (b.damageMult && (b.id !== 'powerstrike' || a.kind === 'melee')) mult *= b.damageMult;
  if (a.kind === 'magic' && u.equipment.trinket) mult *= ITEMS[u.equipment.trinket]?.magicDamageMult ?? 1;
  return Math.max(1, Math.round((a.base + Math.floor(stat / 2)) * mult));
}

/** Stat differences between two partial stat blocks (b - a), non-zero only. */
export function statDelta(a: Partial<UnitStats> | undefined, b: Partial<UnitStats> | undefined): Partial<UnitStats> {
  const out: Partial<UnitStats> = {};
  const keys: (keyof UnitStats)[] = ['maxHp', 'str', 'dex', 'int', 'armor', 'mov', 'vis'];
  for (const k of keys) {
    const d = (b?.[k] ?? 0) - (a?.[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

/** Net stat change of equipping `item` on `u` (replacing the slot item; a 2H weapon also removes the shield). */
export function equipDelta(u: Unit, item: ItemId): Partial<UnitStats> {
  const def = ITEMS[item];
  const old = u.equipment[def.slot];
  const removed: Partial<UnitStats> = { ...(old ? ITEMS[old].stats : {}) };
  if (def.twoHanded && u.equipment.off) {
    const sh = ITEMS[u.equipment.off].stats ?? {};
    for (const k of Object.keys(sh) as (keyof UnitStats)[]) removed[k] = (removed[k] ?? 0) + (sh[k] ?? 0);
  }
  return statDelta(removed, def.stats);
}

/** Silhouette symbol of an empty equipment slot (a lock means blocked, not empty). */
export const SLOT_EMPTY_SYM: Record<'main' | 'off' | 'body' | 'trinket' | 'mount', string> = {
  main: 'sword', off: 'shield', body: 'tunic', trinket: 'amulet', mount: 'horse',
};

export const STAT_LABELS: Record<keyof UnitStats, string> = {
  maxHp: 'HP', str: 'STR', dex: 'DEX', int: 'INT', armor: 'ARM', mov: 'MOV', vis: 'VIS',
};
export const STAT_NAMES: Record<keyof UnitStats, string> = {
  maxHp: 'Max HP', str: 'Strength', dex: 'Dexterity', int: 'Intellect', armor: 'Armor', mov: 'Movement', vis: 'Vision',
};

export function formatStatDelta(d: Partial<UnitStats>): string {
  return (Object.keys(d) as (keyof UnitStats)[])
    .map((k) => `${signed(d[k]!)}${k === 'armor' ? '%' : ''} ${STAT_LABELS[k]}`)
    .join(', ');
}

// ───────────────────────────── formatting ─────────────────────────────
const MINUS = '−';
/** Integer if whole, else one decimal. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '—';
  const r = Math.round(n * 10) / 10;
  const str = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return str.replace('-', MINUS);
}
export function signed(n: number): string {
  if (Math.abs(n) < 0.05) return '±0';
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}
export function pct(p: number, digits = 0): string {
  const v = p * 100;
  if (v > 0 && v < 1 && digits === 0) return '<1%';
  if (v < 100 && v > 99 && digits === 0) return '>99%';
  return `${v.toFixed(digits)}%`;
}
export function costEntries(c: ResourceCost): [ResourceId, number][] {
  return RESOURCE_ORDER.filter((r) => (c[r] ?? 0) !== 0).map((r) => [r, c[r]!]);
}
export function addCost(a: ResourceCost, b: ResourceCost, mult = 1): ResourceCost {
  const out: ResourceCost = { ...a };
  for (const r of RESOURCE_ORDER) if (b[r]) out[r] = (out[r] ?? 0) + b[r]! * mult;
  return out;
}
export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
export function hexLabel(h: Hex): string {
  return `${h.q}, ${h.r}`;
}
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
