import type { BuildingDef, BuildingId } from '../core/types';

const LAND = ['grass', 'plains', 'forest', 'hills', 'mountain', 'swamp', 'crystal'] as const;
const OPEN = ['grass', 'plains', 'hills', 'crystal'] as const;

export const BUILDINGS: Record<BuildingId, BuildingDef> = {
  castle: {
    id: 'castle', name: 'Castle', terrains: ['grass', 'plains', 'hills'], output: { gold: 3, food: 1, research: 3 },
    cost: { stone: 30, wood: 20, gold: 30 }, buildPoints: 6, unlock: null, defense: [25, 30, 35], heal: 10,
    territoryRadius: 2, recruits: ['commoner', 'builder', 'swordsman', 'spearman', 'archer', 'knight', 'apprentice'],
    armory: true, maxLevel: 3, uncapturable: true,
    description: 'Seat of your house. Your leader can recruit any unit here. While the leader stands on it, all your buildings produce 10% more. Only one castle: building a new one moves your seat. Razed, not captured.',
    icon: 'buildings/castle.png', model: 'castle',
  },
  house: {
    id: 'house', name: 'House', terrains: ['grass', 'plains', 'forest', 'hills'], output: { gold: 2 },
    cost: { wood: 10, stone: 6, gold: 6 }, buildPoints: 2, unlock: null, heal: 6, territoryRadius: 1,
    recruits: ['commoner', 'builder'], armory: true, maxLevel: 3,
    description: 'Homes for your people. Produces gold and recruits Commoners and Builders.',
    icon: 'buildings/house.png', model: 'house',
  },
  farm: {
    id: 'farm', name: 'Farm', terrains: ['grass', 'plains'], output: { food: 3 }, fertileBonus: { food: 1 },
    cost: { wood: 8, gold: 6 }, buildPoints: 2, unlock: null, territoryRadius: 1, maxLevel: 3,
    description: 'Fields and a barn. Produces food (+1 on fertile soil).', icon: 'buildings/farm.png', model: 'farm',
  },
  lumber: {
    id: 'lumber', name: 'Lumber Camp', terrains: ['forest'], output: { wood: 3 },
    cost: { gold: 8, stone: 4 }, buildPoints: 2, unlock: null, territoryRadius: 1, maxLevel: 3,
    description: 'Woodcutters fell trees for timber. Must be built in a forest.', icon: 'buildings/lumber.png', model: 'lumber',
  },
  quarry: {
    id: 'quarry', name: 'Quarry', terrains: ['hills', 'mountain'], output: { stone: 3 },
    cost: { wood: 8, gold: 6 }, buildPoints: 2, unlock: null, territoryRadius: 1, maxLevel: 3,
    description: 'Cuts stone from hills and mountains.', icon: 'buildings/quarry.png', model: 'quarry',
  },
  forge: {
    id: 'forge', name: 'Forge', terrains: [...OPEN], output: {},
    cost: { stone: 14, wood: 8, iron: 4, gold: 8 }, buildPoints: 3, unlock: null, territoryRadius: 1, armory: true, maxLevel: 3,
    description: 'Crafts weapons, armor and trinkets into your stockpile (level + 1 items per turn). Units can equip here.',
    icon: 'buildings/forge.png', model: 'forge',
  },
  training: {
    id: 'training', name: 'Training Ground', terrains: ['grass', 'plains'], output: {},
    cost: { wood: 12, gold: 14 }, buildPoints: 3, unlock: null, territoryRadius: 1, armory: true,
    recruits: ['commoner', 'swordsman', 'spearman', 'archer'], xpPerTurn: { cat: 'melee', rangedCat: 'ranged', amount: 5 }, maxLevel: 3,
    description: 'Units stationed here gain 5 melee XP per turn (ranged XP for a unit with a bow; 8 at level 2, 10 at level 3). Recruits commoners, fighters and archers.',
    icon: 'buildings/training.png', model: 'training',
  },
  mine: {
    id: 'mine', name: 'Iron Mine', terrains: ['hills', 'mountain'], deposit: 'iron', output: { iron: 2 },
    cost: { wood: 10, stone: 8, gold: 8 }, buildPoints: 3, unlock: 'mining', territoryRadius: 1, maxLevel: 3,
    description: 'Extracts iron ore. Requires an iron deposit.', icon: 'buildings/mine.png', model: 'mine',
  },
  crystalmine: {
    id: 'crystalmine', name: 'Crystal Mine', terrains: ['crystal', 'mountain', 'hills'], deposit: 'crystal', output: { crystal: 2 },
    cost: { wood: 12, stone: 10, iron: 2, gold: 8 }, buildPoints: 3, unlock: 'crystallore', territoryRadius: 1, maxLevel: 3,
    description: 'Harvests aether crystals for magic. Requires a crystal deposit.', icon: 'buildings/crystalmine.png', model: 'crystalmine',
  },
  library: {
    id: 'library', name: 'Library', terrains: [...OPEN], output: { research: 3 },
    cost: { wood: 12, stone: 10, gold: 20 }, buildPoints: 3, unlock: 'writing', territoryRadius: 1, maxLevel: 3,
    description: 'Scholars produce research points.', icon: 'buildings/library.png', model: 'library',
  },
  magetower: {
    id: 'magetower', name: 'Mage Tower', terrains: ['grass', 'plains', 'forest', 'hills', 'mountain', 'crystal'], output: { mana: 2 },
    cost: { stone: 18, crystal: 10, gold: 16 }, buildPoints: 4, unlock: 'arcana', territoryRadius: 1, armory: true,
    recruits: ['apprentice', 'battlemage'], xpPerTurn: { cat: 'magic', amount: 3 }, maxLevel: 3,
    description: 'Produces mana and channels global spells within its range (a mage inside extends the range). Units inside gain 3 magic XP per turn (5 at level 2, 6 at level 3). Recruits mages.',
    icon: 'buildings/magetower.png', model: 'magetower',
  },
  wall: {
    id: 'wall', name: 'Fortified Wall', terrains: [...LAND], output: {},
    cost: { stone: 16 }, buildPoints: 2, unlock: 'masonry', defense: [20, 30, 40], territoryRadius: 1, maxLevel: 3, uncapturable: true,
    description: 'Stone ramparts. Units here gain +20/+30/+40% defense. Cannot be captured.',
    icon: 'buildings/wall.png', model: 'wall',
  },
  watchtower: {
    id: 'watchtower', name: 'Watchtower', terrains: [...LAND], output: { research: 1 },
    cost: { wood: 10, stone: 8, gold: 4 }, buildPoints: 2, unlock: null, unlockSkill: 'masonry', defense: [10, 15, 20], visionBonus: 3,
    territoryRadius: 1, maxLevel: 3,
    description: 'Extends vision by 3 hexes around it and gives +10% defense. Requires a unit with the Masonry skill.',
    icon: 'buildings/watchtower.png', model: 'watchtower',
  },
  shrine: {
    id: 'shrine', name: 'Shrine', terrains: [...LAND], output: { mana: 1 },
    cost: { stone: 10, crystal: 6 }, buildPoints: 2, unlock: null, unlockSkill: 'devotion', heal: 10, territoryRadius: 1, maxLevel: 3,
    description: 'A holy place. Heals units 10 HP per turn and cures poison. Requires a unit with the Devotion skill.',
    icon: 'buildings/shrine.png', model: 'shrine',
  },
};

export const BUILDING_LIST: BuildingDef[] = Object.values(BUILDINGS);
