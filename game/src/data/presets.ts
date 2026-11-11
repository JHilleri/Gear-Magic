import type { PresetDef, PresetId, ResourceCost, UnitStats } from '../core/types';

export const COMMONER_COST: ResourceCost = { gold: 15, food: 5 };

export const COMMONER_STATS: UnitStats = { maxHp: 30, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 };
export const LEADER_STATS: UnitStats = { maxHp: 46, str: 6, dex: 5, int: 5, armor: 10, block: 1, mov: 5, vis: 5 };

export const PRESETS: Record<PresetId, PresetDef> = {
  commoner:   { id: 'commoner', name: 'Commoner', items: [], sites: ['house', 'castle', 'training'], description: 'An unequipped villager. Give them tools, weapons or armor to specialise.' },
  builder:    { id: 'builder', name: 'Builder', items: ['tools'], sites: ['house', 'castle'], description: "A commoner with Builder's Tools: constructs and upgrades buildings, and works them at ×2.5 output (×2 bare-handed)." },
  swordsman:  { id: 'swordsman', name: 'Swordsman', items: ['sword', 'tunic'], sites: ['training', 'castle'], description: 'Sword and padded tunic. Solid line infantry.' },
  spearman:   { id: 'spearman', name: 'Spearman', items: ['spear', 'leather'], sites: ['training', 'castle'], description: 'Spear and leather armor. First strike; deadly to cavalry.' },
  archer:     { id: 'archer', name: 'Archer', items: ['bow', 'leather'], sites: ['training', 'castle'], description: 'Longbow and leather armor. Attacks from 2 hexes.' },
  knight:     { id: 'knight', name: 'Knight', items: ['sword', 'shield', 'plate', 'horse'], sites: ['castle'], description: 'Mounted, plated and shielded. Expensive and devastating on open ground.' },
  apprentice: { id: 'apprentice', name: 'Apprentice', items: ['wand', 'robe'], sites: ['magetower', 'castle'], description: 'Wand and robe. Ranged magic and a trickle of mana.' },
  battlemage: { id: 'battlemage', name: 'Battle Mage', items: ['staff', 'robe', 'ring'], sites: ['magetower'], description: 'Staff, robe and Ring of Focus. Heavy magical firepower.' },
};

export const PRESET_LIST = Object.values(PRESETS);
