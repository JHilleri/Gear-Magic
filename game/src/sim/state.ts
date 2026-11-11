// Game state construction & basic queries. Pure; no three.js / DOM.
import type {
  Building, BuildingId, BuildingInstanceId, FactionId, FactionState, GameSettings, GameState, Hex, LogEntry, MonsterKind, Resources, Tile, Unit,
  UnitId, XpCategory,
} from '../core/types';
import { hexDistance, inBounds, spiral, tileIndex } from '../core/hex';
import { mulberry32Next } from '../core/rng';
import { FACTIONS, MONSTERS, PLAYABLE_FACTIONS } from '../data/factions';
import { COMMONER_STATS, LEADER_STATS } from '../data/presets';
import { BUILDINGS } from '../data/buildings';
import { TERRAIN } from '../data/terrain';
import { zeroXp } from '../data/skills';
import { generateMap } from './mapgen';
import { createUnit, effectiveStats, mainAttackKind } from './units';
import { queueLevelOffer, settleLevelUps } from './progression';
import { spawnInitialMonsters } from './neutral';
import { computeAllVisibility } from './visibility';

export const LOG_CAP = 300;

/** Starting stock of every faction (DESIGN §2). */
export const STARTING_RESOURCES: Readonly<Resources> = {
  gold: 60, food: 30, wood: 40, stone: 25, iron: 12, crystal: 0, mana: 0, research: 0,
};

const zeroResources = (): Resources => ({ gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0 });

function newFactionState(id: FactionId, n: number, isHuman: boolean): FactionState {
  const isNeutral = id === 'neutral';
  return {
    id,
    isHuman,
    alive: true,
    resources: isNeutral ? zeroResources() : { ...STARTING_RESOURCES },
    income: zeroResources(),
    stockpile: {},
    // Each house knows its signature tech from turn 1 (DESIGN §2); not counted as researched.
    techs: isNeutral ? [] : [...(FACTIONS[id].startingTechs ?? [])],
    researching: null,
    researchProgress: 0,
    spellCooldowns: {},
    // The Wilds are not fog-limited: they "see" everything (never recomputed).
    explored: new Array(n).fill(isNeutral ? 1 : 0),
    visible: new Array(n).fill(isNeutral ? 1 : 0),
    farsight: [],
    leaderId: null,
    castleId: null,
    stats: { kills: 0, lost: 0, built: 0, researched: 0, spellsCast: 0 },
  };
}

/** Mix the user seed into a well-distributed non-zero RNG state for combat etc. */
function initialRngState(seed: number): number {
  let s = (seed ^ 0x5bd1e995) | 0;
  for (let i = 0; i < 4; i++) s = mulberry32Next(s).state ^ Math.imul(s, 0x27d4eb2d);
  return s | 0 || 0x1234567;
}

function placeBuilding(state: GameState, type: BuildingId, owner: FactionId, pos: Hex): Building {
  const id = newId(state);
  const b: Building = {
    id, type, owner, pos: { q: pos.q, r: pos.r }, level: 1, buildLeft: 0, upgrading: false,
    recruitedThisTurn: false, craftedThisTurn: 0, foundedRound: 0,
  };
  state.buildings[String(id)] = b;
  state.tiles[tileIndex(pos, state.width)].building = id;
  if (type === 'castle') state.factions[owner].castleId = id;
  return b;
}

/** Best free hex for a starting building inside the castle territory (radius 2). */
function pickStartSite(state: GameState, start: Hex, type: BuildingId, taken: Hex[]): Hex | null {
  const def = BUILDINGS[type];
  let best: Hex | null = null;
  let bestScore = -Infinity;
  for (const h of spiral(start, 2)) {
    if (hexDistance(h, start) === 0 || !inBounds(h, state.width, state.height)) continue;
    if (taken.some((t) => t.q === h.q && t.r === h.r)) continue;
    const tile = state.tiles[tileIndex(h, state.width)];
    if (tile.building !== null || !def.terrains.includes(tile.terrain)) continue;
    if (def.deposit && tile.deposit !== def.deposit) continue;
    let score = 0;
    const d = hexDistance(h, start);
    if (type === 'farm') {
      if (tile.deposit === 'fertile') score += 10;
      if (tile.terrain === 'grass') score += 1;
      score += d === 1 ? 1.5 : 0;
    } else {
      // House: keep fertile soil, forests and ore for later buildings.
      if (tile.terrain === 'grass' || tile.terrain === 'plains') score += 4;
      if (tile.deposit === null) score += 3;
      score += d === 1 ? 2 : 0;
    }
    // Deterministic per-map tie-break so equal sites don't always resolve in the same direction.
    score -= (tile.variant % 7) * 0.01;
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

/** Free hexes closest to `center` for spawning starting units: firm ground first, any passable hex as a fallback. */
function freeSpawnHexes(state: GameState, center: Hex, count: number): Hex[] {
  const out: Hex[] = [];
  const firm = (t: Tile['terrain']) => t !== 'mountain' && t !== 'shallows' && t !== 'swamp';
  for (const strict of [true, false]) {
    for (const h of spiral(center, 3)) {
      if (out.length >= count) return out;
      if (hexDistance(h, center) === 0 || !inBounds(h, state.width, state.height)) continue;
      const tile = state.tiles[tileIndex(h, state.width)];
      if (!Number.isFinite(TERRAIN[tile.terrain].moveCost)) continue;
      if (strict ? !firm(tile.terrain) : tile.terrain === 'mountain') continue;
      if (unitAt(state, h) || out.some((o) => o.q === h.q && o.r === h.r)) continue;
      out.push(h);
    }
  }
  return out;
}

/**
 * Build a fresh game: map (sim/mapgen), factions (human = settings.playerFaction, then
 * `aiCount` AI factions from PLAYABLE_FACTIONS, plus 'neutral'), each with castle + farm +
 * house + leader (level 2, sword + tunic) + 2 commoners (one with tools) and starting
 * resources (DESIGN §2); neutral monsters around ruins; visibility computed for all.
 * Deterministic for a given settings.seed.
 */
export function createGame(settings: GameSettings): GameState {
  const player: FactionId = PLAYABLE_FACTIONS.includes(settings.playerFaction) ? settings.playerFaction : 'valen';
  const others = PLAYABLE_FACTIONS.filter((f) => f !== player);
  const aiCount = Math.max(1, Math.min(others.length, Math.floor(settings.aiCount || 1)));
  const turnOrder: FactionId[] = [player, ...others.slice(0, aiCount)];
  const cleanSettings: GameSettings = { ...settings, playerFaction: player, aiCount };

  const map = generateMap(cleanSettings, turnOrder.length);
  const n = map.width * map.height;

  const factions: Record<string, FactionState> = {};
  for (const f of turnOrder) factions[f] = newFactionState(f, n, f === player);
  factions.neutral = newFactionState('neutral', n, false);

  const state: GameState = {
    version: 1,
    settings: cleanSettings,
    width: map.width,
    height: map.height,
    tiles: map.tiles,
    units: {},
    buildings: {},
    factions,
    turnOrder,
    currentTurn: 0,
    round: 1,
    nextId: 1,
    rngState: initialRngState(settings.seed),
    log: [],
    winner: null,
    gameOver: false,
  };

  turnOrder.forEach((f, i) => {
    const start = map.starts[i];
    placeBuilding(state, 'castle', f, start);
    const taken: Hex[] = [];
    const farmHex = pickStartSite(state, start, 'farm', taken);
    if (farmHex) { placeBuilding(state, 'farm', f, farmHex); taken.push(farmHex); }
    const houseHex = pickStartSite(state, start, 'house', taken);
    if (houseHex) placeBuilding(state, 'house', f, houseHex);

    const leader = createUnit(state, { faction: f, pos: start, isLeader: true, level: 2, name: FACTIONS[f].leaderName });
    // Starting kit is issued, not crafted: equip directly (no stockpile round-trip).
    leader.equipment.main = 'sword';
    leader.equipment.body = 'tunic';
    leader.hp = effectiveStats(state, leader).maxHp;

    const spots = freeSpawnHexes(state, start, 2);
    if (spots[0]) createUnit(state, { faction: f, pos: spots[0], preset: 'builder' });
    if (spots[1]) createUnit(state, { faction: f, pos: spots[1], preset: 'commoner' });
  });

  spawnInitialMonsters(state, map.ruins);

  // Everyone starts fresh and ready to act; the controller runs turn.startTurn for the first faction.
  for (const u of Object.values(state.units)) {
    const st = effectiveStats(state, u);
    u.hp = Math.min(u.hp, st.maxHp);
    u.mp = st.mov;
    u.acted = false;
    u.moved = false;
    delete u.moveEnded;
  }

  computeAllVisibility(state);
  addLog(state, `The struggle for the region begins. ${FACTIONS[player].name} faces ${turnOrder.slice(1).map((f) => FACTIONS[f].name).join(' and ')}.`, 'info', null);
  return state;
}

export function getTile(state: GameState, h: Hex): Tile | undefined {
  if (!inBounds(h, state.width, state.height)) return undefined;
  return state.tiles[tileIndex(h, state.width)];
}

export function unitAt(state: GameState, h: Hex): Unit | undefined {
  for (const k in state.units) {
    const u = state.units[k];
    if (u.pos.q === h.q && u.pos.r === h.r && u.hp > 0) return u;
  }
  return undefined;
}

export function buildingAt(state: GameState, h: Hex): Building | undefined {
  const tile = getTile(state, h);
  if (!tile || tile.building === null) return undefined;
  return state.buildings[String(tile.building)];
}

export function getUnit(state: GameState, id: UnitId): Unit | undefined {
  return state.units[String(id)];
}

export function getBuilding(state: GameState, id: BuildingInstanceId): Building | undefined {
  return state.buildings[String(id)];
}

export function unitsOf(state: GameState, faction: FactionId): Unit[] {
  const out: Unit[] = [];
  for (const k in state.units) {
    const u = state.units[k];
    if (u.faction === faction && u.hp > 0) out.push(u);
  }
  return out;
}

export function buildingsOf(state: GameState, faction: FactionId): Building[] {
  const out: Building[] = [];
  for (const k in state.buildings) {
    const b = state.buildings[k];
    if (b.owner === faction) out.push(b);
  }
  return out;
}

/** True for a finished building (an upgrading building keeps working at its current level). */
export function isOperational(b: Building): boolean {
  return b.buildLeft <= 0 || b.upgrading;
}

export function faction(state: GameState, id: FactionId): FactionState {
  const fs = state.factions[id];
  if (!fs) throw new Error(`Unknown faction '${id}'`);
  return fs;
}

/** Faction whose turn it is. */
export function currentFaction(state: GameState): FactionId {
  return state.turnOrder[state.currentTurn] ?? state.turnOrder[0];
}

export function humanFaction(state: GameState): FactionId {
  for (const f of state.turnOrder) if (state.factions[f]?.isHuman) return f;
  return state.settings.playerFaction;
}

export function newId(state: GameState): number {
  return state.nextId++;
}

/** Append to state.log (capped at 300 entries) and return the entry. */
export function addLog(state: GameState, text: string, kind: LogEntry['kind'], faction?: FactionId | null): LogEntry {
  const entry: LogEntry = { round: state.round, faction: faction ?? null, text, kind };
  state.log.push(entry);
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  return entry;
}

/** True when the two factions are hostile (everyone is hostile to everyone, incl. neutral). */
export function isEnemy(a: FactionId, b: FactionId): boolean {
  return a !== b;
}

export function cloneState(state: GameState): GameState {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state)) as GameState;
}

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

/**
 * Bring a unit's XP tallies to the current categories (DESIGN §4.7). Saves made before the split
 * of 'fight' and 'civil' still load: 'civil' becomes 'civic', 'fight' becomes 'ranged' for a unit
 * whose main weapon is ranged and 'melee' otherwise; missing categories are 0, unknown ones dropped.
 */
export function migrateUnitXp(u: Unit): void {
  const fightTo: XpCategory = u.equipment && mainAttackKind(u) === 'ranged' ? 'ranged' : 'melee';
  const fix = (tally: unknown): Record<XpCategory, number> => {
    const out = zeroXp();
    if (!tally || typeof tally !== 'object') return out;
    for (const [k, v] of Object.entries(tally as Record<string, unknown>)) {
      const cat = k === 'civil' ? 'civic' : k === 'fight' ? fightTo : k;
      if (cat in out && typeof v === 'number' && Number.isFinite(v)) out[cat as XpCategory] += v;
    }
    return out;
  };
  u.xpByCat = fix(u.xpByCat);
  u.levelXpByCat = fix(u.levelXpByCat);
  if (Array.isArray(u.levelUpXp)) u.levelUpXp = u.levelUpXp.map(fix);
}

/** Hit points and armor before the block stat came in (to bring old saves up to the current numbers). */
const OLD_BASE = {
  commoner: { maxHp: 22, armor: 0 }, leader: { maxHp: 34, armor: 10 },
  wolf: { maxHp: 20, armor: 0 }, spider: { maxHp: 28, armor: 10 }, golem: { maxHp: 48, armor: 30 }, elemental: { maxHp: 40, armor: 20 },
} as const satisfies Record<'commoner' | 'leader' | MonsterKind, { maxHp: number; armor: number }>;

/**
 * A unit from a save made before the block stat (DESIGN §4.1): give it the current base hit points,
 * armor and block of its kind (keeping its wounds: hp moves with max hp), the Thornwild's +5 HP
 * (was +4), and the reworked level picks (+Max HP is now +8, was +6; +Armor is now +1 block and
 * +5% armor, was +6%). Units already on the current numbers are left alone.
 */
export function migrateUnitBalance(u: Unit): void {
  if (!u.base || Number.isFinite(u.base.block)) return;
  const kind = u.monster ?? (u.isLeader ? 'leader' : 'commoner');
  const old = OLD_BASE[kind];
  const now = u.monster ? MONSTERS[u.monster]?.stats : u.isLeader ? LEADER_STATS : COMMONER_STATS;
  if (!old || !now) { u.base.block = 0; return; }
  let hp = now.maxHp - old.maxHp;
  if (!u.monster && u.faction === 'thorn') hp += 1;
  u.base.armor += now.armor - old.armor;
  u.base.block = now.block;
  for (const l of u.learned ?? []) {
    if (l.option === 'stat_hp') hp += 2;
    if (l.option === 'stat_armor') { u.base.armor -= 1; u.base.block += 1; }
  }
  u.base.maxHp += hp;
  u.hp = Math.max(1, u.hp + hp);
}

/**
 * Augment ranks live in `unit.ranks` (DESIGN §4.8); a save from the short-lived build that stored a
 * second rank of a passive as a repeated entry gets each repeat folded into its rank, and stray rank
 * entries (an augment the unit does not have, a rank below 2) are dropped.
 */
export function migrateAugmentRanks(u: Unit): void {
  const ranks: Record<string, number> = { ...(u.ranks ?? {}) };
  for (const list of [u.passives, u.actives] as string[][]) {
    if (!Array.isArray(list)) continue;
    const seen = new Map<string, number>();
    for (const id of list) seen.set(id, (seen.get(id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1) ranks[id] = Math.max(ranks[id] ?? 1, n);
    list.length = 0;
    list.push(...seen.keys());
  }
  const owned = new Set<string>([...(u.passives ?? []), ...(u.actives ?? [])]);
  for (const k of Object.keys(ranks)) if (!owned.has(k) || !(ranks[k] >= 2)) delete ranks[k];
  if (Object.keys(ranks).length) u.ranks = ranks as Unit['ranks'];
  else delete u.ranks;
}

/** Parse a saved game. Throws on malformed input; back-fills fields that older saves may lack. */
export function deserialize(json: string): GameState {
  const raw = JSON.parse(json) as Partial<GameState>;
  if (!raw || typeof raw !== 'object') throw new Error('Save data is not an object.');
  if (raw.version !== 1) throw new Error(`Unsupported save version: ${String(raw.version)}`);
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height) || !Array.isArray(raw.tiles)) throw new Error('Save data has no map.');
  if (raw.tiles.length !== raw.width! * raw.height!) throw new Error('Save data map size mismatch.');
  if (!raw.units || !raw.buildings || !raw.factions || !Array.isArray(raw.turnOrder) || !raw.settings) throw new Error('Save data is incomplete.');
  const state = raw as GameState;
  const n = state.width * state.height;
  for (const fs of Object.values(state.factions)) {
    if (!Array.isArray(fs.explored) || fs.explored.length !== n) fs.explored = new Array(n).fill(fs.id === 'neutral' ? 1 : 0);
    if (!Array.isArray(fs.visible) || fs.visible.length !== n) fs.visible = new Array(n).fill(fs.id === 'neutral' ? 1 : 0);
    fs.farsight ??= [];
    fs.spellCooldowns ??= {};
    fs.stockpile ??= {};
    fs.stats ??= { kills: 0, lost: 0, built: 0, researched: 0, spellsCast: 0 };
  }
  // Units from a save made before the balance pass (no block stat): they also levelled on the old,
  // higher XP thresholds, so the levels their XP already pays for are granted once the state is whole.
  const preBalance: Unit[] = [];
  for (const u of Object.values(state.units)) {
    if (u.base && !Number.isFinite(u.base.block) && !u.monster) preBalance.push(u);
    u.buffs ??= [];
    u.cooldowns ??= {};
    u.efficiency ??= {};
    u.levelUpOptions ??= [];
    migrateUnitXp(u);
    // Level history and standing orders came later: older saves have neither (no history, no order).
    if (!Array.isArray(u.learned)) u.learned = [];
    migrateUnitBalance(u);
    migrateAugmentRanks(u);
    if (u.order !== undefined && (u.monster || (u.order !== 'heal' && u.order !== 'sentry'))) delete u.order;
  }
  state.log ??= [];
  state.winner ??= null;
  state.gameOver ??= false;
  if (!Number.isFinite(state.rngState)) state.rngState = initialRngState(state.settings.seed ?? 1);
  for (const u of preBalance.sort((a, b) => a.id - b.id)) {
    // Offers already owed come first (startTurn would draw them the same way), then the new levels'.
    while (u.levelUpOptions.length < u.pendingLevelUps) queueLevelOffer(state, u);
    settleLevelUps(state, u, null);
  }
  return state;
}
