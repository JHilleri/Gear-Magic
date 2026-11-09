import type { FactionDef, FactionId, MonsterKind, TechId, UnitStats } from '../core/types';

export const FACTIONS: Record<FactionId, FactionDef> = {
  valen: {
    id: 'valen', name: 'House Valen', race: 'human', color: '#2f6fd6', accent: '#e8c35a',
    statMods: { dex: 1 }, rangedMult: 1.1, foodUpkeep: 1, leaderName: 'Queen Aldra Valen',
    unitNames: ['Edric', 'Aldric', 'Tobin', 'Godwin', 'Garrick', 'Hal', 'Osric', 'Bryn', 'Cael', 'Leofric', 'Rowan', 'Brand', 'Wendel', 'Cedric', 'Aldous', 'Oswin', 'Piers', 'Jory', 'Wulfric', 'Corwin'],
    femaleUnitNames: ['Aelis', 'Edith', 'Maud', 'Isolde', 'Rowena', 'Elswyth', 'Matilda', 'Avelina', 'Aldith', 'Elinor', 'Wynne', 'Hilde', 'Sibyl', 'Cecily', 'Alys', 'Agnes', 'Beatrix', 'Margery', 'Tamsin', 'Elspeth'],
    emblem: 'emblems/valen.png',
    startingTechs: ['tanning'],
    researchPriority: ['tanning', 'mining', 'writing', 'polearms', 'crystallore', 'arcana', 'spell_heal', 'shieldcraft', 'croprotation', 'spell_farsight', 'masonry', 'horsemanship', 'spell_bless', 'spell_haste', 'architecture', 'platesmithing', 'guilds', 'spell_fireball', 'wandcraft', 'tactics', 'jewelcraft', 'scholarship', 'grandarchitecture', 'spell_summon', 'spell_storm'],
    flavor: 'Disciplined knights and archers of the river kingdom, sworn to the Silver Crown.',
  },
  thorn: {
    id: 'thorn', name: 'Thornwild Clans', race: 'orc', color: '#c8342b', accent: '#d9c9a3',
    statMods: { maxHp: 4, str: 1, int: -1 }, meleeMult: 1.1, foodUpkeep: 1, leaderName: 'Warchief Grukka Thornfist',
    unitNames: ['Gash', 'Grakk', 'Urzog', 'Brakka', 'Throk', 'Durz', 'Dagrum', 'Skarn', 'Hrok', 'Krull', 'Narzh', 'Vorn', 'Zug', 'Brug', 'Borgo', 'Kazgar', 'Mogg', 'Taruk'],
    emblem: 'emblems/thorn.png',
    startingTechs: ['polearms'],
    researchPriority: ['polearms', 'mining', 'tanning', 'croprotation', 'horsemanship', 'shieldcraft', 'masonry', 'crystallore', 'arcana', 'spell_fireball', 'platesmithing', 'writing', 'spell_heal', 'tactics', 'architecture', 'guilds', 'wandcraft', 'spell_storm', 'jewelcraft', 'spell_farsight', 'scholarship', 'spell_bless', 'spell_haste', 'grandarchitecture', 'spell_summon'],
    flavor: 'Wolf-riding warbands of the thorn forests. They value strength above all.',
  },
  ashen: {
    id: 'ashen', name: 'Ashen Covenant', race: 'undead', color: '#8a4fd6', accent: '#9aa0a6',
    statMods: { int: 2, armor: 5 }, magicMult: 1.1, foodUpkeep: 0.5, leaderName: 'Lich-Lord Morvain',
    unitNames: ['Vesper', 'Grimwald', 'Sorrow', 'Malek', 'Ilse', 'Mortis', 'Caskel', 'Nyx', 'Revna', 'Thane', 'Ossian', 'Lethe', 'Hollow', 'Vael', 'Duskan', 'Sepulka'],
    emblem: 'emblems/ashen.png',
    startingTechs: ['crystallore'],
    researchPriority: ['crystallore', 'writing', 'mining', 'arcana', 'spell_fireball', 'wandcraft', 'spell_heal', 'jewelcraft', 'spell_summon', 'tanning', 'polearms', 'masonry', 'spell_farsight', 'shieldcraft', 'spell_storm', 'scholarship', 'guilds', 'spell_bless', 'spell_haste', 'architecture', 'platesmithing', 'croprotation', 'horsemanship', 'tactics', 'grandarchitecture'],
    flavor: 'Revenants bound by the Covenant of Ash, hungering for the living crystal.',
  },
  neutral: {
    id: 'neutral', name: 'The Wilds', race: 'monster', color: '#8a8a8a', accent: '#5a5a5a',
    statMods: {}, foodUpkeep: 0, leaderName: '', unitNames: [], emblem: 'emblems/neutral.png', researchPriority: [], startingTechs: [],
    flavor: 'Beasts and guardians of the old ruins.',
  },
};

export const PLAYABLE_FACTIONS: FactionId[] = ['valen', 'thorn', 'ashen'];

const STAT_LABEL: Record<keyof UnitStats, string> = {
  maxHp: 'HP', str: 'Strength', dex: 'Dexterity', int: 'Intellect', armor: 'armor', mov: 'movement', vis: 'vision',
};

/**
 * The house's real perks, built from its data (statMods, damage multipliers, upkeep, starting
 * techs) so the New Game card can never advertise something the rules do not do.
 */
export function factionPerks(def: FactionDef, techName: (t: TechId) => string = (t) => t): string[] {
  const out: string[] = [];
  const mods = Object.entries(def.statMods) as [keyof UnitStats, number][];
  if (mods.length) out.push(mods.map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${STAT_LABEL[k]}`).join(', '));
  const mult: string[] = [];
  if (def.meleeMult) mult.push(`+${Math.round((def.meleeMult - 1) * 100)}% melee`);
  if (def.rangedMult) mult.push(`+${Math.round((def.rangedMult - 1) * 100)}% ranged`);
  if (def.magicMult) mult.push(`+${Math.round((def.magicMult - 1) * 100)}% magic`);
  if (mult.length) out.push(`${mult.join(', ')} damage`);
  if (def.foodUpkeep < 1) out.push(def.foodUpkeep === 0.5 ? 'half food upkeep' : `${def.foodUpkeep} food upkeep`);
  for (const t of def.startingTechs ?? []) out.push(`Starts with ${techName(t)}`);
  return out;
}

export interface MonsterDef {
  kind: MonsterKind;
  name: string;
  stats: UnitStats;
  attack: { kind: 'melee' | 'ranged' | 'magic'; name: string; base: number; strikes: number; range: number };
  level: number;
  passives?: ('poison' | 'regeneration' | 'skirmisher')[];
  description: string;
}

export const MONSTERS: Record<MonsterKind, MonsterDef> = {
  wolf:      { kind: 'wolf', name: 'Grey Wolf', level: 1, stats: { maxHp: 20, str: 4, dex: 2, int: 0, armor: 0, mov: 7, vis: 5 }, attack: { kind: 'melee', name: 'Fangs', base: 5, strikes: 2, range: 1 }, passives: ['skirmisher'], description: 'Hunts in packs near the ruins.' },
  spider:    { kind: 'spider', name: 'Giant Spider', level: 2, stats: { maxHp: 28, str: 5, dex: 4, int: 0, armor: 10, mov: 5, vis: 4 }, attack: { kind: 'melee', name: 'Venom Bite', base: 6, strikes: 2, range: 1 }, passives: ['poison'], description: 'Its bite poisons.' },
  golem:     { kind: 'golem', name: 'Ruin Golem', level: 3, stats: { maxHp: 48, str: 8, dex: 0, int: 0, armor: 30, mov: 3, vis: 3 }, attack: { kind: 'melee', name: 'Stone Fist', base: 11, strikes: 2, range: 1 }, passives: ['regeneration'], description: 'Ancient guardian of the ruins.' },
  elemental: { kind: 'elemental', name: 'Stone Elemental', level: 0, stats: { maxHp: 40, str: 6, dex: 0, int: 0, armor: 20, mov: 4, vis: 3 }, attack: { kind: 'melee', name: 'Boulder Fist', base: 9, strikes: 2, range: 1 }, description: 'Summoned earth spirit. Crumbles after 8 turns.' },
};
