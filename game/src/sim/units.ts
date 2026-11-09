// Unit creation, stats, equipment. See DESIGN §4.
import type {
  AttackDef, AttackKind, BodyVariant, Buff, Building, EquipSlot, FactionId, GameEvent, GameState, Hex, ItemId, MonsterKind, PresetId, RaceId,
  ResourceCost, StatBreakdown, StatContribution, Unit, UnitStats,
} from '../core/types';
import { FACTIONS, MONSTERS } from '../data/factions';
import { ITEMS, FISTS_ATTACK } from '../data/items';
import { BUILDINGS } from '../data/buildings';
import { PRESETS, COMMONER_STATS, LEADER_STATS } from '../data/presets';
import { TECHS } from '../data/research';
import { ACTIVES, LEVEL_OPTION_BY_ID, PASSIVES, zeroXp } from '../data/skills';
import { SPELLS } from '../data/spells';
import { tileIndex } from '../core/hex';
import { rand } from '../core/rng';
import { buildingAt, isOperational, newId } from './state';
import { itemUnlocked } from './research';

export interface CreateUnitOpts {
  faction: FactionId;
  pos: Hex;
  race?: RaceId;          // default: faction race
  isLeader?: boolean;
  preset?: PresetId;      // equips the preset's items (no cost paid here)
  monster?: MonsterKind;
  name?: string;
  level?: number;
}

export const ARMOR_MAX = 70;
/** Extra max HP per level above a unit's starting level (DESIGN §4.7). */
export const HP_PER_LEVEL = 4;
const STAT_KEYS: (keyof UnitStats)[] = ['maxHp', 'str', 'dex', 'int', 'armor', 'mov', 'vis'];
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * Is a unit created with this race and first body female? Human recruits in the light body
 * (leather: archers, spearmen) are drawn and portrayed as women (the `human_light` model), so they
 * get a woman's name; everyone else is male. Decided once, at creation (DESIGN §4.9).
 */
export function isFemaleAtCreation(race: RaceId, body: BodyVariant): boolean {
  return race === 'human' && body === 'light';
}

/**
 * A name from the faction pool (the female one for a female unit, when the house has one) not
 * worn by any living unit of that faction ("Edric II" once the pool runs dry).
 */
function pickUnitName(state: GameState, faction: FactionId, female = false): string {
  const def = FACTIONS[faction];
  const pool = (female && def?.femaleUnitNames?.length ? def.femaleUnitNames : def?.unitNames) ?? [];
  if (pool.length === 0) return 'Wanderer';
  const used = new Set<string>();
  for (const k in state.units) {
    const u = state.units[k];
    if (u.faction === faction) used.add(u.name);
  }
  const free = pool.filter((n) => !used.has(n));
  if (free.length > 0) return free[Math.floor(rand(state) * free.length)];
  for (const suffix of ROMAN) {
    const candidates = pool.map((n) => `${n} ${suffix}`).filter((n) => !used.has(n));
    if (candidates.length > 0) return candidates[Math.floor(rand(state) * candidates.length)];
  }
  return `${pool[Math.floor(rand(state) * pool.length)]} ${state.nextId}`;
}

/** Create a unit (base stats = commoner/leader/monster + race mods), add it to state.units. */
export function createUnit(state: GameState, opts: CreateUnitOpts): Unit {
  const isLeader = !!opts.isLeader && !opts.monster;
  const mdef = opts.monster ? MONSTERS[opts.monster] : undefined;
  const race: RaceId = opts.race ?? (mdef ? 'monster' : FACTIONS[opts.faction].race);

  const base: UnitStats = mdef ? { ...mdef.stats } : { ...(isLeader ? LEADER_STATS : COMMONER_STATS) };
  if (!mdef) {
    const mods = FACTIONS[opts.faction]?.statMods ?? {};
    for (const k of STAT_KEYS) base[k] += mods[k] ?? 0;
  }
  const startLevel = mdef ? mdef.level : 1;
  const level = Math.max(0, Math.floor(opts.level ?? (mdef ? mdef.level : isLeader ? 2 : 1)));
  base.maxHp += HP_PER_LEVEL * Math.max(0, level - Math.max(1, startLevel));

  const id = newId(state);
  const unit: Unit = {
    id,
    faction: opts.faction,
    name: opts.name ?? (mdef ? mdef.name : isLeader ? FACTIONS[opts.faction].leaderName : ''),
    race,
    isLeader,
    pos: { q: opts.pos.q, r: opts.pos.r },
    hp: base.maxHp,
    base,
    level,
    xp: 0,
    xpByCat: zeroXp(),
    levelXpByCat: zeroXp(),
    pendingLevelUps: 0,
    levelUpOptions: [],
    equipment: { main: null, off: null, body: null, trinket: null, mount: null },
    efficiency: {},
    passives: mdef?.passives ? [...mdef.passives] : [],
    actives: [],
    cooldowns: {},
    buffs: [],
    poisoned: false,
    mp: 0,
    acted: false,
    moved: false,
    restedLastTurn: false,
    kills: 0,
    learned: [],
  };
  if (opts.monster) {
    unit.monster = opts.monster;
    if (opts.monster === 'elemental') unit.summonTurns = 8;
    if (opts.faction === 'neutral') unit.home = { q: opts.pos.q, r: opts.pos.r };
  }
  if (opts.preset && !mdef) {
    for (const it of PRESETS[opts.preset].items) unit.equipment[ITEMS[it].slot] = it;
  }
  // A recruit's name follows the body it is first drawn in (bodyVariant, as the portrait and
  // the 3D model do): a woman's name for a human in the light body.
  if (opts.name === undefined && !mdef && !isLeader) unit.name = pickUnitName(state, opts.faction, isFemaleAtCreation(race, bodyVariant(unit)));
  const st = effectiveStats(state, unit);
  unit.hp = st.maxHp;
  unit.mp = st.mov;
  state.units[String(id)] = unit;
  if (isLeader && state.factions[opts.faction]) state.factions[opts.faction].leaderId = id;
  return unit;
}

const IRONSKIN_ARMOR = 8;
const STAT_NAMES: Record<keyof UnitStats, string> = {
  maxHp: 'Max HP', str: 'Strength', dex: 'Dexterity', int: 'Intellect', armor: 'Armor', mov: 'Movement', vis: 'Vision',
};
const BUFF_NAMES: Record<Buff['id'], string> = {
  bless: SPELLS.bless.name, fortify: ACTIVES.fortify.name, haste: SPELLS.haste.name,
  powerstrike: ACTIVES.powerstrike.name, farsight: SPELLS.farsight.name,
};

/** Receives each modifier summed on top of unit.base (statBreakdown); effectiveStats passes none. */
type StatSink = (stat: keyof UnitStats, c: StatContribution) => void;

/** Clamp one stat into [lo, hi], reporting the cut as an 'other' contribution. */
function clampStat(s: UnitStats, k: keyof UnitStats, lo: number, hi: number, sink: StatSink | undefined): void {
  const v = Math.max(lo, Math.min(hi, s[k]));
  if (v === s[k]) return;
  sink?.(k, { source: v > s[k] ? `Minimum ${STAT_NAMES[k]} (${lo})` : `${STAT_NAMES[k]} cap (${hi})`, kind: 'other', value: v - s[k] });
  s[k] = v;
}

/**
 * The one place the modifiers on top of unit.base are summed, so effectiveStats and statBreakdown
 * can never disagree: equipment (not for monsters), Iron Skin, armor buffs, then the clamps.
 */
function sumStats(unit: Unit, sink?: StatSink): UnitStats {
  const s: UnitStats = { ...unit.base };
  if (!unit.monster) {
    for (const slot of Object.keys(unit.equipment) as EquipSlot[]) {
      const it = unit.equipment[slot];
      const def = it ? ITEMS[it] : undefined;
      const stats = def?.stats;
      if (!stats) continue;
      for (const k of STAT_KEYS) {
        const v = stats[k] ?? 0;
        s[k] += v;
        if (v && sink) sink(k, { source: def.name, kind: def.mount ? 'mount' : 'item', value: v, item: it! });
      }
    }
  }
  if (unit.passives.includes('ironskin')) {
    s.armor += IRONSKIN_ARMOR;
    sink?.('armor', { source: PASSIVES.ironskin.name, kind: 'passive', value: IRONSKIN_ARMOR, passive: 'ironskin' });
  }
  for (const b of unit.buffs) {
    if (!b.armor || b.turns <= 0) continue;
    s.armor += b.armor;
    sink?.('armor', { source: BUFF_NAMES[b.id] ?? b.id, kind: 'buff', value: b.armor, buff: b.id });
  }
  clampStat(s, 'armor', 0, ARMOR_MAX, sink);
  clampStat(s, 'mov', 1, Infinity, sink);
  clampStat(s, 'maxHp', 1, Infinity, sink);
  clampStat(s, 'vis', 1, Infinity, sink);
  clampStat(s, 'str', 0, Infinity, sink);
  clampStat(s, 'dex', 0, Infinity, sink);
  clampStat(s, 'int', 0, Infinity, sink);
  return s;
}

/** Base + equipment + passives (ironskin) + buffs. armor clamped to [0, ARMOR_MAX = 70] (DESIGN §4.1), mov ≥ 1. */
export function effectiveStats(state: GameState, unit: Unit): UnitStats {
  return sumStats(unit);
}

/**
 * Every stat of `unit` explained for the unit sheet (DESIGN §4.1): `base` plus the signed
 * `contributions` is exactly the effectiveStats total. unit.base already holds the house's race
 * mods, the level-up hit points and stat picks, so those are split back out of it ('faction', and
 * 'other' for levels: the picks need the level history, so older units keep them in base); the rest
 * comes from the same sum effectiveStats uses (items, mount, Iron Skin, buffs, caps).
 */
export function statBreakdown(state: GameState, unit: Unit): StatBreakdown {
  const out = {} as StatBreakdown;
  for (const k of STAT_KEYS) out[k] = { base: unit.base[k], contributions: [], total: 0 };
  const fromBase = (k: keyof UnitStats, c: StatContribution): void => {
    if (!c.value) return;
    out[k].base -= c.value;
    out[k].contributions.push(c);
  };
  if (!unit.monster) {
    const fdef = FACTIONS[unit.faction];
    for (const k of STAT_KEYS) fromBase(k, { source: fdef?.name ?? unit.faction, kind: 'faction', value: fdef?.statMods[k] ?? 0 });
  }
  // createUnit adds HP_PER_LEVEL per level above the starting one, and each level-up as many again.
  const startLevel = Math.max(1, unit.monster ? MONSTERS[unit.monster]?.level ?? 1 : 1);
  const levels = Math.max(0, unit.level - startLevel);
  fromBase('maxHp', { source: `Level-ups (${levels} × +${HP_PER_LEVEL})`, kind: 'other', value: HP_PER_LEVEL * levels });
  for (const l of unit.learned ?? []) {
    const opt = LEVEL_OPTION_BY_ID[l.option];
    if (opt?.kind !== 'stat') continue;
    for (const k of STAT_KEYS) fromBase(k, { source: `Level ${l.level}: ${opt.name}`, kind: 'other', value: opt.stat?.[k] ?? 0, option: opt.id });
  }
  const total = sumStats(unit, (k, c) => out[k].contributions.push(c));
  for (const k of STAT_KEYS) out[k].total = total[k];
  return out;
}

/** The unit's attacks: melee first (weapon, bow/staff fallback, monster attack or fists), then ranged/magic if any. */
export function getAttackDefs(unit: Unit): AttackDef[] {
  if (unit.monster) {
    const a = MONSTERS[unit.monster].attack;
    return [{ ...a }];
  }
  const main = unit.equipment.main ? ITEMS[unit.equipment.main] : undefined;
  if (!main?.attack) return [{ ...FISTS_ATTACK }];
  if (main.attack.kind === 'melee') return [{ ...main.attack }];
  return [{ ...(main.meleeFallback ?? FISTS_ATTACK) }, { ...main.attack }];
}

/**
 * Kind of the unit's main weapon attack: the main-hand item's attack (bow → ranged, staff and
 * wand → magic), else melee (fists, hammer, sword…; a monster's own attack). Decides which kind
 * of combat XP drills and parries teach, and which level options suit the unit (DESIGN §4.7).
 */
export function mainAttackKind(unit: Unit): AttackKind {
  if (unit.monster) return MONSTERS[unit.monster]?.attack.kind ?? 'melee';
  const m = unit.equipment.main;
  return (m && ITEMS[m]?.attack?.kind) || 'melee';
}

export function isMounted(unit: Unit): boolean {
  const m = unit.equipment.mount;
  return !unit.monster && !!m && !!ITEMS[m]?.mount;
}

export function canBuildWith(unit: Unit): boolean {
  const m = unit.equipment.main;
  return !unit.monster && !!m && !!ITEMS[m]?.canBuild;
}

/** Visual body: leader → 'leader'; else from body item (`ItemDef.body`), default 'commoner'. */
export function bodyVariant(unit: Unit): BodyVariant {
  if (unit.isLeader) return 'leader';
  const b = unit.equipment.body;
  return (b && ITEMS[b]?.body) || 'commoner';
}

/** Efficiency multiplier (default 1). */
export function eff(unit: Unit, id: keyof Unit['efficiency']): number {
  return unit.efficiency[id] ?? 1;
}

/** Own, operational building with an armory under the unit, or a reason why not. */
function armoryUnder(state: GameState, unit: Unit): Building | string {
  const b = buildingAt(state, unit.pos);
  const where = 'Must stand on your own castle, house, forge, training ground or mage tower.';
  if (!b || b.owner !== unit.faction || !BUILDINGS[b.type].armory) return where;
  if (!isOperational(b)) return `The ${BUILDINGS[b.type].name} is still under construction.`;
  return b;
}

/** Null when allowed, else a human-readable reason. Requires: own armory building under the unit, item in stockpile, unlocked; bow/staff blocks shield. */
export function canEquip(state: GameState, unit: Unit, item: ItemId): string | null {
  const def = ITEMS[item];
  if (!def) return 'Unknown item.';
  if (unit.monster) return 'Monsters cannot use equipment.';
  if (unit.hp <= 0) return 'This unit has fallen.';
  const fs = state.factions[unit.faction];
  if (!fs) return 'Unknown faction.';
  if (!itemUnlocked(state, unit.faction, item)) return `Requires ${def.unlock ? TECHS[def.unlock].name : 'research'}.`;
  if ((fs.stockpile[item] ?? 0) < 1) return `No ${def.name} in the stockpile. Craft one at a Forge.`;
  if (unit.equipment[def.slot] === item) return `${def.name} is already equipped.`;
  const main = unit.equipment.main ? ITEMS[unit.equipment.main] : undefined;
  if (def.slot === 'off' && main?.twoHanded) return `Cannot use a ${def.name} with a two-handed ${main.name}.`;
  // Riders cannot enter mountains, so they cannot mount up on one either (a mountain Mage Tower).
  if (def.mount && state.tiles[tileIndex(unit.pos, state.width)]?.terrain === 'mountain') return 'Mounts cannot stand on mountains.';
  const armory = armoryUnder(state, unit);
  if (typeof armory === 'string') return armory;
  return null;
}

function addToStockpile(state: GameState, faction: FactionId, item: ItemId, n: number): void {
  const sp = state.factions[faction].stockpile;
  const v = (sp[item] ?? 0) + n;
  if (v > 0) sp[item] = v;
  else delete sp[item];
}

/**
 * Keep hp and remaining mp consistent after an equipment change. Max HP losses clamp hp;
 * gains do not heal. A movement gain only applies to a unit that has not moved yet this
 * turn, so swapping mounts back and forth can never mint extra movement.
 */
function settleAfterEquipChange(state: GameState, unit: Unit, before: UnitStats): void {
  const after = effectiveStats(state, unit);
  unit.hp = Math.max(1, Math.min(unit.hp, after.maxHp));
  const dMov = after.mov - before.mov;
  if (dMov < 0) unit.mp = Math.max(0, unit.mp + dMov);
  else if (dMov > 0 && !unit.moved && !unit.acted) unit.mp += dMov;
}

/** Moves the previous item in that slot (and a shield displaced by a 2H weapon) back to the stockpile. */
export function equip(state: GameState, unit: Unit, item: ItemId): GameEvent[] {
  if (canEquip(state, unit, item) !== null) return [];
  const def = ITEMS[item];
  const before = effectiveStats(state, unit);
  const events: GameEvent[] = [];
  addToStockpile(state, unit.faction, item, -1);
  const prev = unit.equipment[def.slot];
  if (prev) addToStockpile(state, unit.faction, prev, 1);
  if (def.twoHanded && unit.equipment.off) {
    addToStockpile(state, unit.faction, unit.equipment.off, 1);
    unit.equipment.off = null;
    events.push({ type: 'unitEquipped', unit: unit.id, item: null, slot: 'off' });
  }
  unit.equipment[def.slot] = item;
  events.push({ type: 'unitEquipped', unit: unit.id, item, slot: def.slot });
  settleAfterEquipChange(state, unit, before);
  return events;
}

export function canUnequip(state: GameState, unit: Unit, slot: EquipSlot): string | null {
  if (unit.monster) return 'Monsters have no equipment.';
  if (!(slot in unit.equipment)) return 'Unknown equipment slot.';
  if (!unit.equipment[slot]) return 'Nothing is equipped in that slot.';
  if (!state.factions[unit.faction]) return 'Unknown faction.';
  const armory = armoryUnder(state, unit);
  if (typeof armory === 'string') return armory;
  return null;
}

export function unequip(state: GameState, unit: Unit, slot: EquipSlot): GameEvent[] {
  if (canUnequip(state, unit, slot) !== null) return [];
  const before = effectiveStats(state, unit);
  const item = unit.equipment[slot]!;
  addToStockpile(state, unit.faction, item, 1);
  unit.equipment[slot] = null;
  settleAfterEquipChange(state, unit, before);
  return [{ type: 'unitEquipped', unit: unit.id, item: null, slot }];
}

const RESOURCE_VALUE: Record<string, number> = { gold: 1, food: 0.7, wood: 0.8, stone: 0.8, iron: 1.5, crystal: 2, mana: 1, research: 1 };

export function costValue(cost: ResourceCost): number {
  let v = 0;
  for (const [k, n] of Object.entries(cost)) v += (n ?? 0) * (RESOURCE_VALUE[k] ?? 1);
  return v;
}

/** Rough strategic value of a unit (AI targeting / UI): level, equipment cost, leader bonus. */
export function unitValue(unit: Unit): number {
  let v = 12 + unit.level * 8;
  if (unit.monster) v += MONSTERS[unit.monster].level * 6;
  for (const slot of Object.keys(unit.equipment) as EquipSlot[]) {
    const it = unit.equipment[slot];
    if (it) v += costValue(ITEMS[it].cost) * 0.6;
  }
  v += (unit.passives.length + unit.actives.length) * 3;
  if (unit.isLeader) v += 80;
  return Math.round(v * 10) / 10;
}
