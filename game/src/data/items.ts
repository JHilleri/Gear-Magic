import type { ItemDef, ItemId } from '../core/types';

const FISTS = { kind: 'melee', name: 'Fists', base: 3, strikes: 2, range: 1 } as const;
export const FISTS_ATTACK = FISTS;

export const ITEMS: Record<ItemId, ItemDef> = {
  tools: {
    id: 'tools', name: "Builder's Tools", slot: 'main', cost: { wood: 5, iron: 2 }, unlock: null,
    attack: { kind: 'melee', name: 'Hammer', base: 4, strikes: 2, range: 1 }, canBuild: true,
    description: 'Hammer, saw and chisel. Allows building and upgrading. The building the unit works yields 50% more (25% bare-handed).',
    icon: 'items/tools.png',
  },
  sword: {
    id: 'sword', name: 'Iron Sword', slot: 'main', cost: { wood: 4, iron: 6 }, unlock: null,
    attack: { kind: 'melee', name: 'Sword', base: 7, strikes: 3, range: 1 },
    description: 'A reliable blade. Melee 7×3.', icon: 'items/sword.png',
  },
  spear: {
    id: 'spear', name: 'Spear', slot: 'main', cost: { wood: 6, iron: 4 }, unlock: 'polearms',
    attack: { kind: 'melee', name: 'Spear', base: 6, strikes: 3, range: 1, firststrike: true, vsMounted: 1.5 },
    description: 'Melee 6×3. First strike: always strikes first, even when defending. +50% damage against mounted units.',
    icon: 'items/spear.png',
  },
  axe: {
    id: 'axe', name: 'War Axe', slot: 'main', cost: { wood: 4, iron: 7 }, unlock: 'polearms',
    attack: { kind: 'melee', name: 'Axe', base: 10, strikes: 2, range: 1 },
    description: 'Heavy, brutal chops. Melee 10×2.', icon: 'items/axe.png',
  },
  bow: {
    id: 'bow', name: 'Longbow', slot: 'main', twoHanded: true, cost: { wood: 8, iron: 1 }, unlock: null,
    attack: { kind: 'ranged', name: 'Longbow', base: 6, strikes: 3, range: 2 },
    meleeFallback: { kind: 'melee', name: 'Bow Bash', base: 2, strikes: 1, range: 1 },
    description: 'Ranged 6×3 at up to 2 hexes. Two-handed.', icon: 'items/bow.png',
  },
  staff: {
    id: 'staff', name: 'Magic Staff', slot: 'main', twoHanded: true, cost: { wood: 4, crystal: 4 }, unlock: 'arcana',
    attack: { kind: 'magic', name: 'Arcane Bolt', base: 8, strikes: 2, range: 2 },
    meleeFallback: { kind: 'melee', name: 'Staff', base: 3, strikes: 2, range: 1 },
    stats: { int: 2 },
    description: 'Magic 8×2 at range 2 (always 70% to hit). +2 Intellect. Two-handed.', icon: 'items/staff.png',
  },
  wand: {
    id: 'wand', name: 'Wand', slot: 'main', cost: { wood: 2, crystal: 3, iron: 1 }, unlock: 'wandcraft',
    attack: { kind: 'magic', name: 'Spark', base: 5, strikes: 3, range: 2 },
    stats: { int: 1 }, manaPerTurn: 1,
    description: 'Magic 5×3 at range 2. +1 Intellect, +1 mana per turn.', icon: 'items/wand.png',
  },
  shield: {
    id: 'shield', name: 'Shield', slot: 'off', cost: { wood: 6, iron: 3 }, unlock: 'shieldcraft',
    stats: { armor: 12 }, terrainDefense: 5,
    description: '+12 armor and +5% defense on any terrain. Cannot be used with two-handed weapons.', icon: 'items/shield.png',
  },
  tunic: {
    id: 'tunic', name: 'Padded Tunic', slot: 'body', cost: { food: 4, gold: 2 }, unlock: null,
    stats: { armor: 5 }, body: 'commoner',
    description: 'Quilted cloth. +5 armor.', icon: 'items/tunic.png',
  },
  leather: {
    id: 'leather', name: 'Leather Armor', slot: 'body', cost: { food: 6, wood: 4 }, unlock: 'tanning',
    stats: { armor: 15 }, body: 'light',
    description: 'Hardened leather. +15 armor.', icon: 'items/leather.png',
  },
  plate: {
    id: 'plate', name: 'Plate Armor', slot: 'body', cost: { iron: 10, stone: 2 }, unlock: 'platesmithing',
    stats: { armor: 30, mov: -1 }, body: 'heavy',
    description: 'Full steel plate. +30 armor, −1 movement.', icon: 'items/plate.png',
  },
  robe: {
    id: 'robe', name: 'Mage Robe', slot: 'body', cost: { crystal: 3, gold: 4 }, unlock: 'arcana',
    stats: { armor: 3, int: 2 }, manaPerTurn: 1, body: 'robe',
    description: 'Runed silk. +3 armor, +2 Intellect, +1 mana per turn.', icon: 'items/robe.png',
  },
  amulet: {
    id: 'amulet', name: 'Amulet of Vigor', slot: 'trinket', cost: { crystal: 3, gold: 6 }, unlock: 'jewelcraft',
    stats: { maxHp: 8 }, regen: 2,
    description: '+8 max HP and regenerate 2 HP per turn.', icon: 'items/amulet.png',
  },
  ring: {
    id: 'ring', name: 'Ring of Focus', slot: 'trinket', cost: { crystal: 4, gold: 4 }, unlock: 'jewelcraft',
    stats: { int: 2 }, magicDamageMult: 1.15,
    description: '+2 Intellect and +15% magic damage.', icon: 'items/ring.png',
  },
  horse: {
    id: 'horse', name: 'Warmount', slot: 'mount', cost: { food: 10, gold: 6, iron: 2 }, unlock: 'horsemanship',
    stats: { mov: 3 }, mount: true,
    description: '+3 movement. Charge: +25% melee damage when attacking from flat terrain. −10% defense in forest, hills and swamp. Cannot enter mountains. (Humans ride warhorses, orcs dire wolves, the undead nightmares.)',
    icon: 'items/horse.png',
  },
};

export const ITEM_LIST: ItemDef[] = Object.values(ITEMS);
