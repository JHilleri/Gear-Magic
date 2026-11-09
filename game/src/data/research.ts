import type { TechDef, TechId } from '../core/types';

const T = (d: TechDef) => d;

export const TECHS: Record<TechId, TechDef> = {
  // ── Civic ──
  mining:            T({ id: 'mining', name: 'Mining', branch: 'civic', cost: 30, requires: [], unlocksBuildings: ['mine'], description: 'Dig shafts into iron deposits. Unlocks the Iron Mine.', icon: 'techs/mining.png', tier: 0, row: 0 }),
  writing:           T({ id: 'writing', name: 'Writing', branch: 'civic', cost: 30, requires: [], unlocksBuildings: ['library'], description: 'Unlocks the Library: +3 research a turn each, doubling the castle\'s pace. Research it first to speed up everything else.', icon: 'techs/writing.png', tier: 0, row: 1 }),
  croprotation:      T({ id: 'croprotation', name: 'Crop Rotation', branch: 'civic', cost: 60, requires: [], bonus: { resource: 'food', mult: 1.25 }, description: '+25% food from all buildings.', icon: 'techs/croprotation.png', tier: 0, row: 2 }),
  masonry:           T({ id: 'masonry', name: 'Masonry', branch: 'civic', cost: 60, requires: ['mining'], unlocksBuildings: ['wall'], description: 'Cut and set stone. Unlocks Fortified Walls.', icon: 'techs/masonry.png', tier: 1, row: 0 }),
  architecture:      T({ id: 'architecture', name: 'Architecture', branch: 'civic', cost: 90, requires: ['masonry'], bonus: { maxBuildingLevel: 2 }, description: 'Buildings can be upgraded to level 2 (+50% output).', icon: 'techs/architecture.png', tier: 2, row: 0 }),
  guilds:            T({ id: 'guilds', name: 'Guilds', branch: 'civic', cost: 90, requires: ['writing'], bonus: { resource: 'gold', mult: 1.2 }, description: '+20% gold from all buildings.', icon: 'techs/guilds.png', tier: 1, row: 1 }),
  scholarship:       T({ id: 'scholarship', name: 'Scholarship', branch: 'civic', cost: 110, requires: ['guilds'], bonus: { resource: 'research', mult: 1.25 }, description: '+25% research.', icon: 'techs/scholarship.png', tier: 2, row: 1 }),
  grandarchitecture: T({ id: 'grandarchitecture', name: 'Grand Architecture', branch: 'civic', cost: 160, requires: ['architecture', 'scholarship'], bonus: { maxBuildingLevel: 3 }, description: 'Buildings can be upgraded to level 3 (+100% output).', icon: 'techs/grandarchitecture.png', tier: 3, row: 0 }),
  // ── Military ──
  tanning:           T({ id: 'tanning', name: 'Tanning', branch: 'military', cost: 30, requires: [], unlocksItems: ['leather'], description: 'Cure hides into armor. Unlocks Leather Armor.', icon: 'techs/tanning.png', tier: 0, row: 0 }),
  polearms:          T({ id: 'polearms', name: 'Polearms', branch: 'military', cost: 50, requires: [], unlocksItems: ['spear', 'axe'], description: 'Unlocks Spears and War Axes.', icon: 'techs/polearms.png', tier: 0, row: 1 }),
  shieldcraft:       T({ id: 'shieldcraft', name: 'Shieldcraft', branch: 'military', cost: 60, requires: ['tanning'], unlocksItems: ['shield'], description: 'Unlocks Shields.', icon: 'techs/shieldcraft.png', tier: 1, row: 0 }),
  platesmithing:     T({ id: 'platesmithing', name: 'Plate Smithing', branch: 'military', cost: 110, requires: ['shieldcraft', 'mining'], unlocksItems: ['plate'], description: 'Unlocks Plate Armor.', icon: 'techs/platesmithing.png', tier: 2, row: 0 }),
  horsemanship:      T({ id: 'horsemanship', name: 'Horsemanship', branch: 'military', cost: 100, requires: ['polearms'], unlocksItems: ['horse'], description: 'Unlocks Warmounts.', icon: 'techs/horsemanship.png', tier: 1, row: 1 }),
  tactics:           T({ id: 'tactics', name: 'Tactics', branch: 'military', cost: 140, requires: ['platesmithing', 'horsemanship'], bonus: { damageMult: 1.1 }, description: 'All your units deal 10% more damage.', icon: 'techs/tactics.png', tier: 3, row: 0 }),
  // ── Arcane ──
  crystallore:       T({ id: 'crystallore', name: 'Crystal Lore', branch: 'arcane', cost: 50, requires: [], unlocksBuildings: ['crystalmine'], description: 'Unlocks the Crystal Mine.', icon: 'techs/crystallore.png', tier: 0, row: 0 }),
  arcana:            T({ id: 'arcana', name: 'Arcana', branch: 'arcane', cost: 80, requires: ['crystallore'], unlocksBuildings: ['magetower'], unlocksItems: ['staff', 'robe'], description: 'Unlocks the Mage Tower, Magic Staves and Mage Robes.', icon: 'techs/arcana.png', tier: 1, row: 0 }),
  wandcraft:         T({ id: 'wandcraft', name: 'Wandcraft', branch: 'arcane', cost: 60, requires: ['crystallore'], unlocksItems: ['wand'], description: 'Unlocks Wands.', icon: 'techs/wandcraft.png', tier: 1, row: 1 }),
  jewelcraft:        T({ id: 'jewelcraft', name: 'Jewelcraft', branch: 'arcane', cost: 80, requires: ['wandcraft'], unlocksItems: ['amulet', 'ring'], description: 'Unlocks Amulets and Rings.', icon: 'techs/jewelcraft.png', tier: 2, row: 1 }),
  spell_farsight:    T({ id: 'spell_farsight', name: 'Farsight', branch: 'arcane', cost: 60, requires: ['arcana'], unlocksSpell: 'farsight', description: 'Spell: reveal a distant area for 3 turns.', icon: 'spells/farsight.png', tier: 2, row: 2 }),
  spell_heal:        T({ id: 'spell_heal', name: 'Healing Light', branch: 'arcane', cost: 70, requires: ['arcana'], unlocksSpell: 'heal', description: 'Spell: heal allies in an area.', icon: 'spells/heal.png', tier: 2, row: 3 }),
  spell_haste:       T({ id: 'spell_haste', name: 'Haste', branch: 'arcane', cost: 90, requires: ['spell_farsight'], unlocksSpell: 'haste', description: 'Spell: grant an ally +3 movement.', icon: 'spells/haste.png', tier: 3, row: 2 }),
  spell_bless:       T({ id: 'spell_bless', name: 'Blessing', branch: 'arcane', cost: 90, requires: ['spell_heal'], unlocksSpell: 'bless', description: 'Spell: allies in an area deal +20% damage and gain +10 armor.', icon: 'spells/bless.png', tier: 3, row: 3 }),
  spell_fireball:    T({ id: 'spell_fireball', name: 'Fireball', branch: 'arcane', cost: 110, requires: ['arcana'], unlocksSpell: 'fireball', description: 'Spell: explosive fire damage in an area.', icon: 'spells/fireball.png', tier: 2, row: 0 }),
  spell_summon:      T({ id: 'spell_summon', name: 'Summon Elemental', branch: 'arcane', cost: 150, requires: ['spell_fireball', 'jewelcraft'], unlocksSpell: 'summon', description: 'Spell: summon a Stone Elemental for 8 turns.', icon: 'spells/summon.png', tier: 3, row: 1 }),
  spell_storm:       T({ id: 'spell_storm', name: 'Storm of Ruin', branch: 'arcane', cost: 180, requires: ['spell_fireball'], unlocksSpell: 'storm', description: 'Spell: lightning strikes enemies across a wide area.', icon: 'spells/storm.png', tier: 3, row: 0 }),
};

export const TECH_LIST = Object.values(TECHS);
