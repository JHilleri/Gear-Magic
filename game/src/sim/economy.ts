// Buildings, territory, production, crafting, recruitment. See DESIGN §4.3, §4.9, §5.
import type {
  Building, BuildingId, BuildingInstanceId, EfficiencyId, FactionId, GameEvent, GameState, Hex, ItemId, PresetId,
  ResourceCost, ResourceId, Resources, TechId, Unit, XpCategory,
} from '../core/types';
import { DIRS, hexEq, inBounds, neighbors, spiral, tileIndex } from '../core/hex';
import { aOrAn } from '../core/text';
import { BUILDINGS } from '../data/buildings';
import { augmentRank, yieldPerTurn } from '../data/ranks';
import { ITEMS } from '../data/items';
import { PRESETS } from '../data/presets';
import { FACTIONS } from '../data/factions';
import { TERRAIN } from '../data/terrain';
import { TECHS, TECH_LIST } from '../data/research';
import { newId } from './state';
import { canBuildWith, createUnit, eff, mainAttackKind, statsOf } from './units';
import { ALL_RESOURCES, baseOutput, buildingName, factionCost, houseForbids, itemCost, producesFor, recruitCost, unitUpkeep, workedOnly } from './houses';
import { buildingUnlocked, hasTech, itemUnlocked, presetUnlocked, resourceMult } from './research';
import { computeVisibility } from './visibility';
import { manaCap } from './spells';
import { applyDamage } from './combat';
import {
  buildingOn, giveXp, isBuilt, isFunctional, isHumanFaction, logEvent, logFor, passableForSpawn, round2, unitOn,
} from './ruleutil';

const RESOURCE_ORDER: readonly ResourceId[] = ALL_RESOURCES;
export { unitUpkeep };

// ───────────────────────────── resources ─────────────────────────────

export function emptyResources(): Resources {
  return { gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0, honor: 0, dark: 0 };
}

export function canAfford(res: Resources, cost: ResourceCost): boolean {
  for (const k of RESOURCE_ORDER) {
    const c = cost[k] ?? 0;
    if (c > 0 && (res[k] ?? 0) + 1e-9 < c) return false;
  }
  return true;
}

export function pay(res: Resources, cost: ResourceCost): void {
  for (const k of RESOURCE_ORDER) {
    const c = cost[k] ?? 0;
    if (c) res[k] = round2((res[k] ?? 0) - c);
  }
}

export function scaleCost(cost: ResourceCost, mult: number): ResourceCost {
  const out: ResourceCost = {};
  for (const k of RESOURCE_ORDER) {
    const c = cost[k];
    if (c) out[k] = Math.round(c * mult);
  }
  return out;
}

export function addCost(a: ResourceCost, b: ResourceCost): ResourceCost {
  const out: ResourceCost = { ...a };
  for (const k of RESOURCE_ORDER) if (b[k]) out[k] = (out[k] ?? 0) + b[k]!;
  return out;
}

/** Human-readable "8 wood, 4 stone". */
export function formatCost(cost: ResourceCost): string {
  const parts: string[] = [];
  for (const k of RESOURCE_ORDER) {
    const c = cost[k];
    if (c) parts.push(`${Math.round(c * 10) / 10} ${k === 'dark' ? 'dark energy' : k}`);
  }
  return parts.length ? parts.join(', ') : 'free';
}

/** The resources missing to pay `cost` (for error messages). */
function missing(res: Resources, cost: ResourceCost): string {
  const parts: string[] = [];
  for (const k of RESOURCE_ORDER) {
    const c = cost[k] ?? 0;
    const have = res[k] ?? 0;
    if (c > 0 && have + 1e-9 < c) parts.push(`${Math.ceil(c - have)} ${k === 'dark' ? 'dark energy' : k}`);
  }
  return `Not enough resources (need ${parts.join(', ')} more)`;
}

// ───────────────────────────── territory ─────────────────────────────

const territoryCache = new WeakMap<GameState, { sig: string; owners: (FactionId | null)[] }>();

function territorySignature(state: GameState): string {
  let s = `${state.width}x${state.height}|`;
  for (const k in state.buildings) {
    const b = state.buildings[k];
    s += `${b.id}:${b.owner ?? '-'}:${isBuilt(b) ? 1 : 0}:${b.type}:${b.foundedRound}:${b.pos.q},${b.pos.r};`;
  }
  return s;
}

/** Owner of each tile index (null = unclaimed). Castle radius 2, others 1, older building wins overlaps. Only completed buildings claim (construction sites claim their own hex). */
export function computeTerritory(state: GameState): (FactionId | null)[] {
  const sig = territorySignature(state);
  const cached = territoryCache.get(state);
  if (cached && cached.sig === sig) return cached.owners;
  const n = state.width * state.height;
  const owners: (FactionId | null)[] = new Array(n).fill(null);
  const list = Object.values(state.buildings)
    .filter((b) => b.owner !== null)
    .sort((a, b) => a.foundedRound - b.foundedRound || a.id - b.id);
  // Oldest first: completed buildings claim their radius, construction sites only their own hex.
  for (const b of list) {
    const radius = isBuilt(b) ? BUILDINGS[b.type].territoryRadius : 0;
    for (const h of spiral(b.pos, radius)) {
      if (!inBounds(h, state.width, state.height)) continue;
      const i = tileIndex(h, state.width);
      if (owners[i] === null) owners[i] = b.owner;
    }
  }
  territoryCache.set(state, { sig, owners });
  return owners;
}

export function territoryOwner(state: GameState, h: Hex): FactionId | null {
  if (!inBounds(h, state.width, state.height)) return null;
  return computeTerritory(state)[tileIndex(h, state.width)];
}

// ───────────────────────────── building ─────────────────────────────

function castleOf(state: GameState, f: FactionId): Building | undefined {
  const id = state.factions[f]?.castleId;
  if (id == null) return undefined;
  const b = state.buildings[String(id)];
  return b && b.owner === f && b.type === 'castle' ? b : undefined;
}

/** Each producing building of a type the house already has (finished or not) makes the next one this much dearer. */
export const BUILDING_COST_STEP = 0.25;

/**
 * What `faction` pays to start a `type` building now: its base cost, +25% for every building of
 * that type the house already owns (sites included) when the type produces something (farms,
 * houses, mines, libraries…), rounded up. The castle, forge, training ground and wall keep their
 * base cost. DESIGN §5. `planned`: more of that type assumed already started (AI plans).
 */
export function buildingCost(state: GameState, faction: FactionId, type: BuildingId, planned = 0): ResourceCost {
  // In the house's own resources (honor for orcs, no food for the undead; DESIGN §2).
  const base = factionCost(faction, BUILDINGS[type].cost);
  if (type === 'castle' || !producesFor(type, faction)) return { ...base };
  let n = Math.max(0, planned);
  for (const k in state.buildings) {
    const b = state.buildings[k];
    if (b.owner === faction && b.type === type) n++;
  }
  if (n === 0) return { ...base };
  const out: ResourceCost = {};
  for (const k of RESOURCE_ORDER) {
    const c = base[k];
    if (c) out[k] = Math.ceil(c * (1 + BUILDING_COST_STEP * n) - 1e-9);
  }
  return out;
}

/** Null if `unit` can start `building` on its hex now: tools, unlocked (tech or unit skill), terrain/deposit fit, empty hex (no building), inside or adjacent to own territory (castle: anywhere own-adjacent... castle also allowed anywhere the leader stands if the faction has no castle), cost affordable, unit not acted. */
export function canBuildAt(state: GameState, unit: Unit, building: BuildingId): string | null {
  const def = BUILDINGS[building];
  if (!def) return 'Unknown building';
  const f = unit.faction;
  const fs = state.factions[f];
  if (!fs || !fs.alive || f === 'neutral' || unit.monster) return 'This unit cannot build';
  if (!state.units[String(unit.id)]) return 'Unit is gone';
  // The leader can always build (and so move) the castle, tools or not (concept: "Can build and
  // move the castle"). A house without a seat may found it wherever its leader stands.
  const leaderCastle = building === 'castle' && unit.isLeader;
  const founding = leaderCastle && !castleOf(state, f);
  if (!leaderCastle && !canBuildWith(unit)) return "Requires Builder's Tools";
  if (unit.acted) return 'This unit has already acted this turn';
  if (!buildingUnlocked(state, f, building, unit)) {
    if (def.unlockSkill) return `Requires a unit with the ${def.unlockSkill === 'masonry' ? 'Masonry' : 'Devotion'} skill`;
    const tech = TECH_LIST.find((t) => t.unlocksBuildings?.includes(building)) ?? (def.unlock ? TECHS[def.unlock] : undefined);
    return `Requires research: ${tech?.name ?? def.unlock}`;
  }
  const forbidden = houseForbids(building, f);
  if (forbidden) return forbidden;
  const site = siteError(state, f, unit.pos, building, founding);
  if (site) return site;
  const cost = buildingCost(state, f, building);
  if (!canAfford(fs.resources, cost)) return missing(fs.resources, cost);
  return null;
}

/**
 * The hex-only part of canBuildAt: why `building` cannot stand on `hex` for faction `f` (existing
 * building, terrain, deposit, foreign land, outside reach of own territory), or null. `founding`:
 * a seatless house founding its castle may build anywhere that is not foreign land.
 */
export function siteError(state: GameState, f: FactionId, hex: Hex, building: BuildingId, founding = false): string | null {
  const def = BUILDINGS[building];
  if (!def) return 'Unknown building';
  if (!inBounds(hex, state.width, state.height)) return 'Invalid hex';
  const tile = state.tiles[tileIndex(hex, state.width)];
  if (!tile) return 'Invalid hex';
  if (tile.building != null && state.buildings[String(tile.building)]) return 'There is already a building here';
  if (!TERRAIN[tile.terrain].buildable || !def.terrains.includes(tile.terrain)) {
    return `Cannot be built on ${TERRAIN[tile.terrain].name}`;
  }
  if (def.deposit && tile.deposit !== def.deposit) return `Requires ${aOrAn(def.deposit)} deposit`;
  const owner = territoryOwner(state, hex);
  if (owner !== null && owner !== f) return 'This land belongs to another faction';
  if (!founding && owner !== f && !neighbors(hex).some((n) => territoryOwner(state, n) === f)) {
    return 'Must be inside or adjacent to your territory';
  }
  return null;
}

/** Pay & place a construction site (buildLeft = buildPoints). Building a castle when one exists destroys the old one. */
export function startBuilding(state: GameState, unit: Unit, building: BuildingId): GameEvent[] {
  const def = BUILDINGS[building];
  const f = unit.faction;
  const fs = state.factions[f];
  const events: GameEvent[] = [];
  pay(fs.resources, buildingCost(state, f, building));
  if (building === 'castle') {
    // One seat per house: the old castle (or castle site) is torn down.
    const oldId = fs.castleId;
    const old = oldId != null ? state.buildings[String(oldId)] : undefined;
    if (old && old.type === 'castle') {
      const wasSite = old.buildLeft > 0 && !old.upgrading;
      events.push(...destroyBuilding(state, old));
      // Say what was lost (a 'warning' also becomes a toast for the player).
      events.push(...logFor(state, [f], wasSite
        ? `The unfinished castle site is abandoned; the new seat needs ${def.buildPoints} build points.`
        : `The old castle (level ${old.level}) is demolished: the seat of ${FACTIONS[f].name} moves. Castle recruiting and the +10% seat bonus are lost until the new castle is built (${def.buildPoints} build points).`,
      'warning', f));
    }
    fs.castleId = null;
  }
  const b: Building = {
    id: newId(state), type: building, owner: f, pos: { ...unit.pos }, level: 1,
    buildLeft: def.buildPoints, upgrading: false, recruitedThisTurn: false, craftedThisTurn: 0, foundedRound: state.round,
  };
  state.buildings[String(b.id)] = b;
  state.tiles[tileIndex(b.pos, state.width)].building = b.id;
  if (building === 'castle') fs.castleId = b.id;
  // The builder settles in to work the site this turn (contributes at end of turn).
  unit.mp = 0;
  events.push({ type: 'buildingStarted', building: b.id });
  events.push(...logFor(state, [f], `${unit.name} begins building ${aOrAn(def.name)}.`, 'build', f));
  return events;
}

/** Remove a building from the map (razing, castle relocation). */
export function destroyBuilding(state: GameState, b: Building): GameEvent[] {
  delete state.buildings[String(b.id)];
  const t = state.tiles[tileIndex(b.pos, state.width)];
  if (t && t.building === b.id) t.building = null;
  for (const fid of Object.keys(state.factions)) {
    const fs = state.factions[fid];
    if (fs.castleId === b.id) fs.castleId = null;
  }
  return [{ type: 'buildingDestroyed', building: b.id, pos: { ...b.pos } }];
}

/** Max level allowed by techs (1, architecture → 2, grandarchitecture → 3). */
export function maxBuildingLevel(state: GameState, faction: FactionId): number {
  let lvl = 1;
  for (const t of TECH_LIST) {
    const m = t.bonus?.maxBuildingLevel;
    if (m && m > lvl && hasTech(state, faction, t.id)) lvl = m;
  }
  return lvl;
}

/** Resources to upgrade from the building's current level: cost × level. */
export function upgradeCost(b: Building): ResourceCost {
  return factionCost(b.owner, scaleCost(BUILDINGS[b.type].cost, b.level));
}

/** Build points of an upgrade from the current level: buildPoints × level. */
export function upgradeBuildPoints(b: Building): number {
  return BUILDINGS[b.type].buildPoints * b.level;
}

export function canUpgrade(state: GameState, unit: Unit): string | null {
  const f = unit.faction;
  const fs = state.factions[f];
  if (!fs || !fs.alive || unit.monster) return 'This unit cannot build';
  if (!canBuildWith(unit)) return "Requires Builder's Tools";
  if (unit.acted) return 'This unit has already acted this turn';
  const b = buildingOn(state, unit.pos);
  if (!b) return 'No building here';
  if (b.owner !== f) return 'Not your building';
  if (b.upgrading) return 'Already being upgraded';
  if (b.buildLeft > 0) return 'Still under construction';
  const def = BUILDINGS[b.type];
  if (b.level >= def.maxLevel) return 'Already at maximum level';
  const max = maxBuildingLevel(state, f);
  if (b.level >= max) return b.level === 1 ? 'Requires research: Architecture' : 'Requires research: Grand Architecture';
  const cost = upgradeCost(b);
  if (!canAfford(fs.resources, cost)) return missing(fs.resources, cost);
  return null;
}

export function startUpgrade(state: GameState, unit: Unit): GameEvent[] {
  const b = buildingOn(state, unit.pos)!;
  const fs = state.factions[unit.faction];
  pay(fs.resources, upgradeCost(b));
  b.upgrading = true;
  b.buildLeft = upgradeBuildPoints(b);
  unit.mp = 0;
  return [
    { type: 'buildingStarted', building: b.id },
    ...logFor(state, [unit.faction], `${unit.name} begins upgrading the ${BUILDINGS[b.type].name} to level ${b.level + 1}.`, 'build', unit.faction),
  ];
}

// ───────────────────────────── production ─────────────────────────────

/** Which worker efficiency boosts a resource. */
const RESOURCE_EFF: Record<ResourceId, EfficiencyId> = {
  gold: 'trade', food: 'farming', wood: 'gathering', stone: 'mining', iron: 'mining', crystal: 'mining', mana: 'mana', research: 'research',
  honor: 'trade', dark: 'trade',
};

/** Output share a worker adds per point of the stat that drives a resource (DESIGN §4.1). */
export const STAT_YIELD = 0.03;
/** The worker attribute that drives a resource: Strength for raw materials and honor, Intellect for research and gold. */
export const YIELD_STAT: Partial<Record<ResourceId, 'str' | 'int'>> = {
  wood: 'str', stone: 'str', iron: 'str', crystal: 'str', honor: 'str', research: 'int', gold: 'int',
};

/** What `worker`'s attributes multiply resource `k` of its building by: +3% per point of the driving stat. */
export function statYieldMult(worker: Unit, k: ResourceId): number {
  const stat = YIELD_STAT[k];
  if (!stat) return 1;
  return 1 + STAT_YIELD * Math.max(0, statsOf(worker)[stat]);
}

/** Output multiplier of a building worked by a unit with Builder's Tools (before its efficiencies). */
export const WORKER_MULT = 2.5;
/** Output multiplier of a building worked bare-handed: any unit can work, tools just work better. */
export const BARE_WORKER_MULT = 2;
/** XP a worker earns for each turn it works its building without acting. */
export const WORK_XP = 5;
/** XP a unit earns for each turn it puts build points into a construction or upgrade. */
export const BUILD_XP = 5;
/** HP every unit that eats loses when the house runs out of food (never below 1). */
export const STARVATION_DAMAGE = 4;

const DIFFICULTY_MULT = { easy: 0.8, normal: 1.0, hard: 1.3 } as const;

/** AI income multiplier for the game's difficulty (1 for the human). */
export function difficultyMult(state: GameState, faction: FactionId): number {
  const fs = state.factions[faction];
  if (!fs || fs.isHuman || faction === 'neutral') return 1;
  return DIFFICULTY_MULT[state.settings.difficulty] ?? 1;
}

/** Leader standing on its own functional castle: +10% to every building of the house. */
function leaderOnCastle(state: GameState, faction: FactionId): boolean {
  const lid = state.factions[faction]?.leaderId;
  const leader = lid != null ? state.units[String(lid)] : undefined;
  if (!leader) return false;
  const b = buildingOn(state, leader.pos);
  return isFunctional(b) && b.type === 'castle' && b.owner === faction;
}

/**
 * True when the building type produces something a worker can boost (castle, farm, library…; not a
 * forge or wall). With `f`, for that house (an orc house yields nothing, an orc Arena yields honor).
 */
export function hasWorkableOutput(type: BuildingId, f?: FactionId | null): boolean {
  if (f !== undefined) return producesFor(type, f);
  return Object.values(BUILDINGS[type]?.output ?? {}).some((v) => (v ?? 0) > 0);
}

/**
 * The unit working `b`, or null: an own unit standing on it (not a monster or summon) while it is
 * functional and produces something. Builder's Tools are not needed: they only make the work
 * better (WORKER_MULT vs BARE_WORKER_MULT). DESIGN §5.
 */
export function workerOf(state: GameState, b: Building): Unit | null {
  if (!isFunctional(b) || !producesFor(b.type, b.owner)) return null;
  const u = unitOn(state, b.pos);
  if (!u || u.faction !== b.owner || u.monster || u.summonTurns !== undefined) return null;
  return u;
}

/** Output multiplier `worker` brings to the building it works (before its efficiencies). */
export function workerMult(worker: Unit): number {
  return canBuildWith(worker) ? WORKER_MULT : BARE_WORKER_MULT;
}

/**
 * Everything `worker` multiplies resource `k` of its building by: ×2.5 with Builder's Tools (×2
 * bare-handed) times its building and resource efficiencies (each pick is a clean +25% of the
 * whole output). buildingOutput and the tile panel's "worked by" line both read it.
 */
export function workerResourceMult(worker: Unit, k: ResourceId): number {
  return workerMult(worker) * eff(worker, 'building') * eff(worker, RESOURCE_EFF[k]) * statYieldMult(worker, k);
}

/**
 * What working `b` teaches `u`: the castle is the seat of rule, not a study, so it teaches the
 * leader leadership and anyone else civic (its research must not hand every fresh recruit magic
 * XP); research & magic where another building yields research or mana (library, shrine, mage
 * tower…); else civic.
 */
export function workXpCategory(u: Unit, b: Building): XpCategory {
  if (b.type === 'castle') return u.isLeader ? 'leader' : 'civic';
  const out = baseOutput(b.type, b.owner);
  if ((out.research ?? 0) > 0 || (out.mana ?? 0) > 0) return 'magic';
  return 'civic';
}

/** Per-turn output of a completed building incl. level, fertile bonus, worker bonus (an own unit on it: ×2.5 with Builder's Tools, ×2 bare-handed, × its building & resource efficiencies), leader-on-castle +10%, tech multipliers, AI difficulty multiplier. */
export function buildingOutput(state: GameState, b: Building): ResourceCost {
  if (!isFunctional(b)) return {};
  const owner = b.owner!;
  const def = BUILDINGS[b.type];
  const tile = state.tiles[tileIndex(b.pos, state.width)];
  // In the owner's own resources (DESIGN §2): honor for orcs, no food for the undead.
  const base: ResourceCost = baseOutput(b.type, owner);
  if (def.fertileBonus && tile?.deposit === 'fertile') {
    const bonus = factionCost(owner, def.fertileBonus);
    for (const k of RESOURCE_ORDER) if (bonus[k]) base[k] = (base[k] ?? 0) + bonus[k]!;
  }
  const levelMult = 1 + 0.5 * (b.level - 1);
  const worker = workerOf(state, b);
  if (!worker && workedOnly(b.type, owner)) return {}; // an empty Arena yields nothing
  const castleMult = leaderOnCastle(state, owner) ? 1.1 : 1;
  const diff = difficultyMult(state, owner);
  const out: ResourceCost = {};
  for (const k of RESOURCE_ORDER) {
    const v = base[k];
    if (!v) continue;
    const wm = worker ? workerResourceMult(worker, k) : 1;
    const value = v * levelMult * wm * castleMult * resourceMult(state, owner, k) * (v > 0 ? diff : 1);
    out[k] = round2(value);
  }
  return out;
}

/** Mana/food/iron/research a unit brings in each turn from items and passives. */
export function unitIncome(state: GameState, u: Unit): ResourceCost {
  const out: ResourceCost = {};
  let mana = 0;
  for (const slot of ['main', 'off', 'body', 'trinket', 'mount'] as const) {
    const it = u.equipment[slot];
    if (it && ITEMS[it].manaPerTurn) mana += ITEMS[it].manaPerTurn!;
  }
  if (mana) out.mana = mana * eff(u, 'mana');
  // Yield passives: +1 per rank (DESIGN §4.8).
  const rank = (p: 'manaspring' | 'harvester' | 'prospector' | 'scholar'): number => {
    const r = augmentRank(u, p);
    return r > 0 ? yieldPerTurn(r) : 0;
  };
  if (rank('manaspring')) out.mana = (out.mana ?? 0) + rank('manaspring');
  if (rank('harvester')) out.food = rank('harvester');
  if (rank('prospector')) out.iron = rank('prospector');
  if (rank('scholar')) out.research = rank('scholar');
  return factionCost(u.faction, out); // the undead's Harvester brings no food
}

/** Net per-turn income: buildings + items/passives (mana, harvester…) − unit upkeep (food, honor, mana; DESIGN §2). */
export function factionIncome(state: GameState, faction: FactionId): Resources {
  const inc = emptyResources();
  if (faction === 'neutral') return inc;
  for (const k in state.buildings) {
    const b = state.buildings[k];
    if (b.owner !== faction) continue;
    const o = buildingOutput(state, b);
    for (const r of RESOURCE_ORDER) if (o[r]) inc[r] += o[r]!;
  }
  const diff = difficultyMult(state, faction);
  for (const k in state.units) {
    const u = state.units[k];
    if (u.faction !== faction) continue;
    const o = unitIncome(state, u);
    for (const r of RESOURCE_ORDER) if (o[r]) inc[r] += o[r]! * diff;
    const up = unitUpkeep(u);
    for (const r of RESOURCE_ORDER) if (up[r]) inc[r] -= up[r]!;
  }
  for (const r of RESOURCE_ORDER) inc[r] = round2(inc[r]);
  return inc;
}

/** Upkeep a house can run short of, and what its people are told. */
const UPKEEP_SHORTFALL: { res: ResourceId; text: (hp: number) => string }[] = [
  { res: 'food', text: (hp) => `Your people are starving! Every unit loses ${hp} HP. Build farms or reduce your army.` },
  { res: 'honor', text: (hp) => `Without honor your warriors turn on each other! Every unit loses ${hp} HP. Fight, work an Arena or reduce your warband.` },
  { res: 'mana', text: (hp) => `The binding magic fails! Every risen unit loses ${hp} HP. Raise more mana or reduce your host.` },
];

/** Add income at turn start; an unpaid upkeep (food, honor, mana) hurts the units that draw it; clamp mana to cap. Updates faction.income. Research points are not stockpiled: turn.startTurn feeds `income.research` into the current project. */
export function applyProduction(state: GameState, faction: FactionId): GameEvent[] {
  const fs = state.factions[faction];
  if (!fs || !fs.alive || faction === 'neutral') return [];
  const events: GameEvent[] = [];
  const inc = factionIncome(state, faction);
  fs.income = inc;
  for (const r of RESOURCE_ORDER) {
    if (r === 'research') continue;
    fs.resources[r] = round2((fs.resources[r] ?? 0) + inc[r]);
  }
  const cap = manaCap(state, faction);
  if (fs.resources.mana > cap) fs.resources.mana = cap;
  // An upkeep the house cannot pay (food, honor or mana) costs every unit that draws it
  // STARVATION_DAMAGE hp, never below 1 (DESIGN §2).
  const short = UPKEEP_SHORTFALL.filter((x) => fs.resources[x.res] < 0);
  for (const x of short) {
    fs.resources[x.res] = 0;
    const hit = Object.values(state.units).filter((u) => u.faction === faction && (unitUpkeep(u)[x.res] ?? 0) > 0)
      .sort((a, b) => a.id - b.id);
    if (!hit.length) continue;
    for (const u of hit) events.push(...applyDamage(state, u, STARVATION_DAMAGE, 'starvation', null, 1));
    events.push(...logFor(state, [faction], x.text(STARVATION_DAMAGE), 'warning', faction));
  }
  for (const r of RESOURCE_ORDER) if (fs.resources[r] < 0 && r !== 'research') fs.resources[r] = 0;
  return events;
}

/**
 * XP a unit stationed on `b` earns per turn (Training Ground, Mage Tower): base × (1 + 0.5 ×
 * (level − 1)), rounded — 5/8/10 and 3/5/6. With `unit`, the category is the one it learns: the
 * Training Ground drills a unit whose main weapon is ranged in ranged XP, everyone else in melee.
 */
export function buildingXpPerTurn(b: Building, unit?: Unit): { cat: XpCategory; amount: number } | null {
  const x = BUILDINGS[b.type].xpPerTurn;
  if (!x) return null;
  const cat = unit && x.rangedCat && mainAttackKind(unit) === 'ranged' ? x.rangedCat : x.cat;
  return { cat, amount: Math.round(x.amount * (1 + 0.5 * (b.level - 1))) };
}

/** Build points `u` adds to the site it stands on at the end of a turn it did not act. */
export function buildRate(u: Unit): number {
  return eff(u, 'building') * (1 + 0.1 * u.level);
}

/**
 * End-of-turn: tools units (and the leader on its castle site) that did not act contribute build
 * points (+BUILD_XP building XP); workers (workerOf) that did not act (nor just appear) get +WORK_XP XP in workXpCategory; units
 * on a Training Ground / Mage Tower get its drill XP. Completes constructions.
 */
export function progressConstruction(state: GameState, faction: FactionId): GameEvent[] {
  const events: GameEvent[] = [];
  const units = Object.values(state.units).filter((u) => u.faction === faction).sort((a, b) => a.id - b.id);
  for (const u of units) {
    if (!state.units[String(u.id)]) continue;
    const b = buildingOn(state, u.pos);
    if (!b || b.owner !== faction) continue;
    const def = BUILDINGS[b.type];
    const builder = !u.monster && canBuildWith(u);
    const raisesCastle = u.isLeader && b.type === 'castle' && !b.upgrading;
    if (b.buildLeft > 0 && (builder || raisesCastle || !b.upgrading)) {
      // A unit that attacked (or used an action) this turn does not work the site. The leader
      // raises its own castle without tools. Anyone else on an upgrading building still works
      // it at its current level (below).
      if ((!builder && !raisesCastle) || u.acted) continue;
      const pts = buildRate(u);
      b.buildLeft = round2(Math.max(0, b.buildLeft - pts));
      events.push(...giveXp(state, u, 'building', BUILD_XP));
      if (b.buildLeft <= 1e-6) {
        b.buildLeft = 0;
        if (b.upgrading) {
          b.upgrading = false;
          b.level++;
          events.push({ type: 'buildingCompleted', building: b.id });
          events.push(...logFor(state, [faction], `${def.name} upgraded to level ${b.level}.`, 'build', faction));
        } else {
          state.factions[faction].stats.built++;
          events.push({ type: 'buildingCompleted', building: b.id });
          events.push(...logFor(state, [faction], `${def.name} completed.`, 'build', faction));
        }
      } else {
        events.push({ type: 'buildingProgress', building: b.id, left: b.buildLeft });
      }
      continue;
    }
    if (!isFunctional(b)) continue;
    // A unit that appeared this turn (recruit, summon) has not worked a whole turn yet.
    // An Arena's fighters learn from its drill below, not as workers.
    if (!u.acted && !u.justSpawned && workerOf(state, b) === u && b.type !== 'training') events.push(...giveXp(state, u, workXpCategory(u, b), WORK_XP));
    const drill = buildingXpPerTurn(b, u);
    if (drill) events.push(...giveXp(state, u, drill.cat, drill.amount));
  }
  if (events.some((e) => e.type === 'buildingCompleted')) computeVisibility(state, faction);
  return events;
}

/** End-of-turn: `faction`'s units standing on capturable buildings of other factions flip them (castles are razed). */
export function captureBuildings(state: GameState, faction: FactionId): GameEvent[] {
  if (faction === 'neutral') return [];
  const events: GameEvent[] = [];
  const units = Object.values(state.units).filter((u) => u.faction === faction).sort((a, b) => a.id - b.id);
  for (const u of units) {
    // A unit that appeared this turn (recruit, summon) has not marched onto anything.
    if (u.justSpawned) continue;
    const b = buildingOn(state, u.pos);
    if (!b || b.owner === faction) continue;
    const def = BUILDINGS[b.type];
    const from = b.owner;
    if (b.type === 'castle') {
      events.push(...destroyBuilding(state, b));
      const text = from
        ? `${u.name} razes the castle of ${FACTIONS[from].name}!`
        : `${u.name} razes an abandoned castle.`;
      events.push(...logFor(state, [faction, from], text, 'warning', faction));
      continue;
    }
    if (def.uncapturable) continue;
    b.owner = faction;
    events.push({ type: 'buildingCaptured', building: b.id, from, to: faction });
    const text = `${FACTIONS[faction].name} captures ${from ? `${FACTIONS[from].name}'s` : 'an abandoned'} ${def.name}.`;
    events.push(...logFor(state, [faction, from], text, 'warning', faction));
  }
  if (events.length) {
    // Both sides' sight changes: the capturer gains the building's view, the loser loses it.
    const touched = new Set<FactionId>([faction]);
    for (const e of events) if (e.type === 'buildingCaptured' && e.from) touched.add(e.from);
    for (const f of state.turnOrder) if (state.factions[f]?.alive && (touched.has(f) || events.some((e) => e.type === 'buildingDestroyed'))) computeVisibility(state, f);
  }
  return events;
}

// ───────────────────────────── recruiting ─────────────────────────────

/** Recruit cost of `preset` for house `faction`: its commoner plus the preset's items, in its own resources (DESIGN §2). */
export function presetCost(preset: PresetId, faction: FactionId = 'valen'): ResourceCost {
  return recruitCost(faction, preset);
}

/** Spawn hex for a recruit at `site`: the site itself if free, else the first free passable neighbour that holds no building of someone else (a recruit never appears on, and so takes, a foreign building). */
export function recruitSpawnHex(state: GameState, site: Building, preset: PresetId): Hex | null {
  const mounted = PRESETS[preset].items.some((i) => ITEMS[i].mount);
  if (!unitOn(state, site.pos) && passableForSpawn(state, site.pos, mounted)) return { ...site.pos };
  // Cheapest terrain first, then direction order (deterministic).
  const cands = DIRS.map((d) => ({ q: site.pos.q + d.q, r: site.pos.r + d.r }))
    .filter((h) => passableForSpawn(state, h, mounted) && !unitOn(state, h))
    .filter((h) => { const b = buildingOn(state, h); return !b || b.owner === site.owner; });
  if (!cands.length) return null;
  cands.sort((a, b) => TERRAIN[state.tiles[tileIndex(a, state.width)].terrain].moveCost
    - TERRAIN[state.tiles[tileIndex(b, state.width)].terrain].moveCost);
  return cands[0];
}

/** Null if `site` can recruit `preset` now: owned complete site listing the preset (castle needs the leader on it), not recruited this turn, items unlocked, affordable, a free hex on/adjacent to the site. */
export function canRecruit(state: GameState, site: BuildingInstanceId, preset: PresetId): string | null {
  const b = state.buildings[String(site)];
  if (!b) return 'No such building';
  if (!b.owner) return 'Abandoned building';
  const f = b.owner;
  const fs = state.factions[f];
  if (!fs || !fs.alive) return 'Faction is gone';
  if (!PRESETS[preset]) return 'Unknown unit type';
  const def = BUILDINGS[b.type];
  if (!def.recruits?.includes(preset)) return `A ${buildingName(b.type, f)} cannot train ${PRESETS[preset].name}s`;
  if (!isFunctional(b)) return 'Still under construction';
  if (b.type === 'castle') {
    const leader = fs.leaderId != null ? state.units[String(fs.leaderId)] : undefined;
    if (!leader || !hexEq(leader.pos, b.pos)) return 'Your leader must stand on the castle to recruit';
  }
  if (b.recruitedThisTurn) return 'Already recruited here this turn';
  if (!presetUnlocked(state, f, preset)) {
    // Every tech still missing, once each, in the order of the preset's items.
    const techs = [...new Set(PRESETS[preset].items
      .filter((i) => !itemUnlocked(state, f, i))
      .map((i) => ITEMS[i].unlock)
      .filter((t): t is TechId => !!t))];
    return `Requires research: ${techs.length ? techs.map((t) => TECHS[t].name).join(', ') : 'unknown'}`;
  }
  const cost = presetCost(preset, f);
  if (!canAfford(fs.resources, cost)) return missing(fs.resources, cost);
  if (!recruitSpawnHex(state, b, preset)) return 'No free space next to the building';
  return null;
}

export function recruit(state: GameState, site: BuildingInstanceId, preset: PresetId): GameEvent[] {
  const b = state.buildings[String(site)];
  const f = b.owner!;
  const fs = state.factions[f];
  const pos = recruitSpawnHex(state, b, preset)!;
  pay(fs.resources, presetCost(preset, f));
  const u = createUnit(state, { faction: f, pos, preset });
  u.mp = 0;
  u.acted = true;
  u.moved = false;
  u.justSpawned = true; // cannot move this turn (Haste/Rally included) nor capture where it appeared
  b.recruitedThisTurn = true;
  const events: GameEvent[] = [{ type: 'unitSpawned', unit: u.id, pos: { ...pos }, reason: 'recruit' }];
  events.push(...logFor(state, [f], `${u.name} the ${PRESETS[preset].name} joins your ranks.`, 'info', f));
  const leader = fs.leaderId != null ? state.units[String(fs.leaderId)] : undefined;
  if (leader) events.push(...giveXp(state, leader, 'leader', 2));
  computeVisibility(state, f);
  return events;
}

// ───────────────────────────── crafting ─────────────────────────────

/** Items a forge can still craft this turn: level + 1 per turn. */
export function forgeCapacity(b: Building): number {
  return Math.max(0, b.level + 1 - b.craftedThisTurn);
}

export function canCraft(state: GameState, forge: BuildingInstanceId, item: ItemId): string | null {
  const b = state.buildings[String(forge)];
  if (!b || b.type !== 'forge') return 'Not a forge';
  if (!b.owner) return 'Abandoned forge';
  const fs = state.factions[b.owner];
  if (!fs || !fs.alive) return 'Faction is gone';
  if (!isFunctional(b)) return 'Still under construction';
  const def = ITEMS[item];
  if (!def) return 'Unknown item';
  if (!itemUnlocked(state, b.owner, item)) return `Requires research: ${def.unlock ? TECHS[def.unlock].name : 'unknown'}`;
  if (forgeCapacity(b) <= 0) return `This forge has crafted its ${b.level + 1} items this turn`;
  const cost = itemCost(b.owner, item);
  if (!canAfford(fs.resources, cost)) return missing(fs.resources, cost);
  return null;
}

export function craft(state: GameState, forge: BuildingInstanceId, item: ItemId): GameEvent[] {
  const b = state.buildings[String(forge)];
  const f = b.owner!;
  const fs = state.factions[f];
  pay(fs.resources, itemCost(f, item));
  fs.stockpile[item] = (fs.stockpile[item] ?? 0) + 1;
  b.craftedThisTurn++;
  const events: GameEvent[] = [{ type: 'itemCrafted', faction: f, item }];
  // The smith on the anvil learns the trade.
  const smith = unitOn(state, b.pos);
  if (smith && smith.faction === f) events.push(...giveXp(state, smith, 'civic', 2));
  if (isHumanFaction(state, f)) events.push(logEvent(state, `Forged: ${ITEMS[item].name}.`, 'build', f));
  return events;
}

/** Debug/UI: total production of every own building (sum of buildingOutput). */
export function buildingsIncome(state: GameState, faction: FactionId): Resources {
  const inc = emptyResources();
  for (const k in state.buildings) {
    const b = state.buildings[k];
    if (b.owner !== faction) continue;
    const o = buildingOutput(state, b);
    for (const r of RESOURCE_ORDER) if (o[r]) inc[r] = round2(inc[r] + o[r]!);
  }
  return inc;
}

