// Hand-built game states for unit tests (no mapgen dependency).
import type { Building, BuildingId, FactionId, FactionState, GameState, Hex, ItemId, Resources, TerrainId, Unit } from '../src/core/types';
import { offsetToAxial, tileIndex } from '../src/core/hex';
import { COMMONER_STATS, LEADER_STATS } from '../src/data/presets';
import { FACTIONS } from '../src/data/factions';
import { zeroXp } from '../src/data/skills';

export function res(partial: Partial<Resources> = {}): Resources {
  return { gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0, ...partial };
}

function factionState(id: FactionId, n: number, isHuman: boolean): FactionState {
  return {
    id, isHuman, alive: true, resources: res({ gold: 100, food: 50, wood: 50, stone: 50, iron: 30, crystal: 20 }), income: res(),
    stockpile: {}, techs: [], researching: null, researchProgress: 0, spellCooldowns: {},
    explored: new Array(n).fill(1), visible: new Array(n).fill(1), farsight: [], leaderId: null, castleId: null,
    stats: { kills: 0, lost: 0, built: 0, researched: 0, spellsCast: 0 },
  };
}

/** A W×H map filled with `terrain` (default grass), factions valen (human) + thorn (AI) + neutral. */
export function makeTestState(width = 12, height = 10, terrain: TerrainId = 'grass'): GameState {
  const n = width * height;
  const tiles = Array.from({ length: n }, (_, i) => ({ terrain, deposit: null, elevation: 0.5, building: null, variant: i % 7 }));
  return {
    version: 1,
    settings: { mapSize: 'small', seed: 1, playerFaction: 'valen', aiCount: 1, difficulty: 'normal' },
    width, height, tiles, units: {}, buildings: {},
    factions: { valen: factionState('valen', n, true), thorn: factionState('thorn', n, false), neutral: factionState('neutral', n, false) },
    turnOrder: ['valen', 'thorn'], currentTurn: 0, round: 1, nextId: 1, rngState: 12345, log: [], winner: null, gameOver: false,
  };
}

/** Axial hex from offset (col,row) — convenient for laying out tests. */
export const at = (col: number, row: number): Hex => offsetToAxial(col, row);

export function setTerrain(state: GameState, h: Hex, terrain: TerrainId): void {
  state.tiles[tileIndex(h, state.width)].terrain = terrain;
}

export function makeTestUnit(state: GameState, faction: FactionId, pos: Hex, opts: Partial<Unit> & { items?: ItemId[] } = {}): Unit {
  const id = state.nextId++;
  const base = { ...(opts.isLeader ? LEADER_STATS : COMMONER_STATS) };
  const u: Unit = {
    id, faction, name: `T${id}`, race: FACTIONS[faction].race, isLeader: false, pos,
    hp: base.maxHp, base, level: 1, xp: 0,
    xpByCat: zeroXp(),
    levelXpByCat: zeroXp(),
    pendingLevelUps: 0, levelUpOptions: [],
    equipment: { main: null, off: null, body: null, trinket: null, mount: null },
    efficiency: {}, passives: [], actives: [], cooldowns: {}, buffs: [], poisoned: false,
    mp: base.mov, acted: false, moved: false, restedLastTurn: false, kills: 0, learned: [],
    ...opts,
  };
  if (opts.base === undefined) u.hp = opts.hp ?? base.maxHp;
  for (const it of opts.items ?? []) {
    const slot = ({ tools: 'main', sword: 'main', spear: 'main', axe: 'main', bow: 'main', staff: 'main', wand: 'main', shield: 'off', tunic: 'body', leather: 'body', plate: 'body', robe: 'body', amulet: 'trinket', ring: 'trinket', horse: 'mount' } as const)[it];
    u.equipment[slot] = it;
  }
  delete (u as any).items;
  state.units[String(id)] = u;
  if (u.isLeader) state.factions[faction].leaderId = id;
  return u;
}

export function makeTestBuilding(state: GameState, type: BuildingId, owner: FactionId | null, pos: Hex, opts: Partial<Building> = {}): Building {
  const id = state.nextId++;
  const b: Building = { id, type, owner, pos, level: 1, buildLeft: 0, upgrading: false, recruitedThisTurn: false, craftedThisTurn: 0, foundedRound: 0, ...opts };
  state.buildings[String(id)] = b;
  state.tiles[tileIndex(pos, state.width)].building = id;
  if (type === 'castle' && owner) state.factions[owner].castleId = id;
  return b;
}
