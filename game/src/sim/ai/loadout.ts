// Unit "tracks" and the equipment the AI wants each unit to carry. A unit's track follows its
// main-hand item and never changes once armed, so desired loadouts only ever move forward as
// techs unlock (no equip/unequip ping-pong).
import type { EquipSlot, FactionId, ItemId, Unit } from '../../core/types';
import { ITEMS, ITEM_LIST } from '../../data/items';
import { itemUnlocked } from '../research';
import type { Ctx, Track } from './types';

export type Loadout = Partial<Record<EquipSlot, ItemId>>;

export const SLOT_ORDER: EquipSlot[] = ['main', 'off', 'body', 'trinket', 'mount'];

export function trackOf(u: Unit): Track {
  if (u.isLeader) return 'leader';
  if (u.monster) return 'summon';
  const m = u.equipment.main;
  if (!m) return 'none';
  if (m === 'tools') return 'builder';
  if (m === 'bow') return 'archer';
  if (m === 'staff' || m === 'wand') return 'mage';
  return 'melee';
}

/** Track a main-hand item puts a unit on. */
export function trackOfItem(item: ItemId | null | undefined): Track {
  if (!item) return 'none';
  if (item === 'tools') return 'builder';
  if (item === 'bow') return 'archer';
  if (item === 'staff' || item === 'wand') return 'mage';
  return 'melee';
}

/** Army make-up each house aims for (shares of the military). */
export const COMPOSITION: Record<FactionId, Partial<Record<Track, number>>> = {
  valen: { melee: 0.45, archer: 0.4, mage: 0.15 },
  thorn: { melee: 0.7, archer: 0.25, mage: 0.05 },
  ashen: { melee: 0.35, archer: 0.15, mage: 0.5 },
  neutral: {},
};

/** Deterministic per-unit coin: does this melee unit ride (knights, wolf riders, nightmares)? */
export function isCavalry(f: FactionId, id: number): boolean {
  if (f === 'valen') return id % 2 === 0;   // knights
  if (f === 'thorn') return id % 2 === 1;   // wolf riders
  return id % 4 === 0;                      // the occasional nightmare rider
}

const has = (ctx: Ctx, item: ItemId) => itemUnlocked(ctx.s, ctx.f, item);

/**
 * Main-hand items of a track in this house's order of taste for unit `id` (flavour first;
 * every main-hand item of the track is listed, so any stocked one can be picked). Without an
 * id: the house's usual taste (what its next recruit is armed with).
 */
function weaponPrefs(ctx: Ctx, track: Track, id?: number): ItemId[] {
  let prefs: ItemId[];
  const odd = id !== undefined && id % 3 === 0;
  if (track === 'melee') {
    const enemyRiders = !!ctx.t.strategy?.enemyMounted;
    if (ctx.f === 'thorn') prefs = odd ? ['spear', 'axe', 'sword'] : ['axe', 'spear', 'sword'];
    else if (ctx.f === 'ashen') prefs = ['spear', 'sword', 'axe'];
    else prefs = enemyRiders && odd ? ['spear', 'sword'] : ['sword', 'spear'];
  } else if (track === 'mage') prefs = odd ? ['staff', 'wand'] : ['wand', 'staff'];
  else if (track === 'archer') prefs = ['bow'];
  else if (track === 'builder') prefs = ['tools'];
  else return [];
  for (const it of ITEM_LIST) {
    if (it.slot === 'main' && trackOfItem(it.id) === track && !prefs.includes(it.id)) prefs.push(it.id);
  }
  return prefs;
}

/** The melee weapon a fresh recruit of this house should get (flavour first, then whatever is unlocked). */
export function meleeWeaponFor(ctx: Ctx, id?: number): ItemId {
  return weaponPrefs(ctx, 'melee', id).find((i) => has(ctx, i)) ?? 'sword';
}

export function mageWeaponFor(ctx: Ctx, id?: number): ItemId | null {
  return weaponPrefs(ctx, 'mage', id).find((i) => has(ctx, i)) ?? null;
}

/** A stocked, usable (unlocked) main-hand item of `track` for unit `id`, taste breaking ties. */
export function stockedWeapon(ctx: Ctx, track: Track, id: number | undefined, stock: Partial<Record<ItemId, number>>): ItemId | null {
  return weaponPrefs(ctx, track, id).find((i) => (stock[i] ?? 0) > 0 && has(ctx, i)) ?? null;
}

/**
 * The main-hand item an unarmed unit of `track` should take up: a usable weapon of the track
 * already in `stock` first, else the house's taste among unlocked ones (null: none for the track).
 */
export function weaponFor(ctx: Ctx, track: Track, id: number | undefined, stock: Partial<Record<ItemId, number>>): ItemId | null {
  const stocked = stockedWeapon(ctx, track, id, stock);
  if (stocked) return stocked;
  if (track === 'melee') return meleeWeaponFor(ctx, id);
  if (track === 'mage') return mageWeaponFor(ctx, id);
  if (track === 'archer') return 'bow';
  if (track === 'builder') return 'tools';
  return null;
}

/** Can this house field a track at all with what it has researched? */
export function trackAvailable(ctx: Ctx, track: Track): boolean {
  if (track === 'mage') return has(ctx, 'wand') || has(ctx, 'staff');
  return track === 'melee' || track === 'archer';
}

function firstUnlocked(ctx: Ctx, items: ItemId[]): ItemId | undefined {
  return items.find((i) => has(ctx, i));
}

/**
 * Equipment the AI wants on `u`. Main hand: kept as is once armed (the track is fixed); an
 * unarmed commoner gets the weapon of its planned track, preferring one already in `stock`
 * (default: the faction stockpile). Other slots: the best unlocked item for the track.
 */
export function desiredLoadout(ctx: Ctx, u: Unit, planned?: Track, stock: Partial<Record<ItemId, number>> = ctx.fs.stockpile): Loadout {
  if (u.monster) return {};
  let track = trackOf(u);
  const out: Loadout = {};
  if (track === 'none') {
    track = planned ?? ctx.t.strategy?.tracks.get(u.id) ?? 'melee';
    if (track === 'mage') {
      const w = weaponFor(ctx, 'mage', u.id, stock);
      if (w) out.main = w; else { track = 'archer'; out.main = 'bow'; }
    } else if (track === 'archer' || track === 'melee' || track === 'builder') {
      out.main = weaponFor(ctx, track, u.id, stock) ?? undefined;
    }
  } else if (u.equipment.main) {
    out.main = u.equipment.main;
  }
  // Until a commoner holds its weapon its track can still change: only arm it (and a cheap
  // tunic), so armor always matches the final role (no plate-wearing archers).
  if (trackOf(u) === 'none') {
    if (!u.equipment.body && has(ctx, 'tunic')) out.body = 'tunic';
    return out;
  }
  const main = out.main ? ITEMS[out.main] : undefined;
  const twoHanded = !!main?.twoHanded;
  switch (track) {
    case 'leader':
      if (!twoHanded && has(ctx, 'shield')) out.off = 'shield';
      out.body = firstUnlocked(ctx, ['plate', 'leather', 'tunic']);
      if (has(ctx, 'amulet')) out.trinket = 'amulet';
      break;
    case 'melee':
      if (!twoHanded && has(ctx, 'shield')) out.off = 'shield';
      out.body = firstUnlocked(ctx, ['plate', 'leather', 'tunic']);
      if (has(ctx, 'amulet')) out.trinket = 'amulet';
      if (isCavalry(ctx.f, u.id) && has(ctx, 'horse')) out.mount = 'horse';
      break;
    case 'archer':
      out.body = firstUnlocked(ctx, ['leather', 'tunic']);
      if (has(ctx, 'amulet')) out.trinket = 'amulet';
      break;
    case 'mage':
      if (!twoHanded && has(ctx, 'shield')) out.off = 'shield';
      out.body = firstUnlocked(ctx, ['robe', 'leather', 'tunic']);
      out.trinket = firstUnlocked(ctx, ['ring', 'amulet']);
      break;
    case 'builder':
      out.body = firstUnlocked(ctx, ['tunic']);
      break;
  }
  // Never downgrade: a unit that already wears something better keeps it.
  if (out.body && u.equipment.body && bodyRank(track, u.equipment.body) >= bodyRank(track, out.body)) out.body = u.equipment.body;
  if (out.trinket && u.equipment.trinket && track !== 'mage') out.trinket = u.equipment.trinket;
  return out;
}

function bodyRank(track: Track, item: ItemId): number {
  if (track === 'mage') return item === 'robe' ? 4 : item === 'leather' ? 2 : item === 'plate' ? 3 : 1;
  return item === 'plate' ? 4 : item === 'leather' ? 3 : item === 'robe' ? 2 : 1;
}

/** How urgently an item is wanted for a unit (crafting order). */
export function itemPriority(u: Unit, slot: EquipSlot, item: ItemId, track: Track): number {
  const leader = u.isLeader ? 3 : 0;
  switch (slot) {
    case 'main': return track === 'builder' ? 3 : 10;
    case 'body': return (u.equipment.body ? 4 : 7) + leader - (track === 'builder' ? 6 : 0);
    case 'off': return 5 + leader;
    case 'mount': return 4;
    case 'trinket': return (item === 'ring' ? 4 : 3) + leader;
  }
  return 1;
}

/** Rough worth of carried equipment (recruit option comparison). */
export function loadoutQuality(items: (ItemId | null | undefined)[]): number {
  let q = 0;
  for (const it of items) {
    switch (it) {
      case 'sword': case 'axe': case 'spear': case 'bow': case 'wand': q += 10; break;
      case 'staff': q += 11; break;
      case 'plate': q += 7; break;
      case 'leather': case 'robe': q += 4; break;
      case 'tunic': q += 2; break;
      case 'shield': q += 4; break;
      case 'horse': q += 5; break;
      case 'amulet': case 'ring': q += 3; break;
      default: break;
    }
  }
  return q;
}
