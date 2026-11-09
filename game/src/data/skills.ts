import type { ActiveId, ActiveSkillDef, PassiveId, SkillOptionDef, XpCategory } from '../core/types';

/** Every kind of experience, in display order (DESIGN §4.7). */
export const XP_CATEGORIES: readonly XpCategory[] = ['melee', 'ranged', 'building', 'civic', 'explore', 'leader', 'magic'];

export const XP_CATEGORY_NAMES: Record<XpCategory, string> = {
  melee: 'Melee', ranged: 'Ranged', building: 'Building', civic: 'Civic', explore: 'Exploration', leader: 'Leadership', magic: 'Research & Magic',
};

/** A fresh all-zero XP tally (every category present, so sums and UI bars never meet undefined). */
export function zeroXp(): Record<XpCategory, number> {
  return { melee: 0, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 };
}

export const PASSIVES: Record<PassiveId, { name: string; description: string; icon: string }> = {
  regeneration: { name: 'Regeneration', description: 'Heals 4 HP at the start of each turn.', icon: 'skills/regeneration.png' },
  poison:       { name: 'Venom Blades', description: 'Melee hits poison the target: 4 damage per turn until cured at a castle or shrine.', icon: 'skills/poison.png' },
  skirmisher:   { name: 'Skirmisher', description: 'Ignores enemy zones of control.', icon: 'skills/skirmisher.png' },
  pathfinder:   { name: 'Pathfinder', description: 'Forest and hills cost only 1 movement.', icon: 'skills/pathfinder.png' },
  ironskin:     { name: 'Iron Skin', description: '+8 armor.', icon: 'skills/ironskin.png' },
  leadership:   { name: 'Leadership', description: 'Adjacent allies deal 15% more damage.', icon: 'skills/leadership.png' },
  harvester:    { name: 'Harvester', description: '+1 food every turn.', icon: 'skills/harvester.png' },
  prospector:   { name: 'Prospector', description: '+1 iron every turn.', icon: 'skills/prospector.png' },
  manaspring:   { name: 'Mana Spring', description: '+1 mana every turn.', icon: 'skills/manaspring.png' },
  scholar:      { name: 'Scholar', description: '+1 research every turn.', icon: 'skills/scholar.png' },
  marksman:     { name: 'Marksman', description: 'Ranged attacks have at least 60% chance to hit.', icon: 'skills/marksman.png' },
  berserker:    { name: 'Berserker', description: '+25% melee damage while below half health.', icon: 'skills/berserker.png' },
  vampiric:     { name: 'Life Drinker', description: 'Heals 30% of melee damage dealt.', icon: 'skills/vampiric.png' },
  inspiring:    { name: 'Inspiring', description: 'Adjacent allies gain 1 XP each turn, in the kind of XP they earn most.', icon: 'skills/inspiring.png' },
};

export const ACTIVES: Record<ActiveId, ActiveSkillDef> = {
  powerstrike: { id: 'powerstrike', name: 'Power Strike', description: 'Your next melee attack this turn deals 50% more damage. Free: does not use the action.', cooldown: 3, range: 0, target: 'none', icon: 'skills/powerstrike.png' },
  volley:      { id: 'volley', name: 'Volley', description: 'Rain arrows on every enemy within 1 hex of a target hex in bow range, at 60% damage, no retaliation.', cooldown: 4, range: 2, target: 'hex', icon: 'skills/volley.png' },
  heal:        { id: 'heal', name: 'Mend', description: 'Heal an adjacent ally (or yourself) for 12 HP and cure poison.', cooldown: 2, range: 1, target: 'ally', icon: 'skills/heal.png' },
  firebolt:    { id: 'firebolt', name: 'Firebolt', description: 'Hurl a bolt of fire: 14 damage to an enemy within 3 hexes, ignoring armor, no retaliation.', cooldown: 3, range: 3, target: 'enemy', icon: 'skills/firebolt.png' },
  rally:       { id: 'rally', name: 'Rally', description: 'Allies within 2 hexes gain +2 movement this turn (not units that have already attacked). Free: does not use the action.', cooldown: 4, range: 0, target: 'none', icon: 'skills/rally.png' },
  fortify:     { id: 'fortify', name: 'Fortify', description: '+20 armor until your next turn. Uses the action: no attack after it (movement stays).', cooldown: 3, range: 0, target: 'none', icon: 'skills/fortify.png' },
  blink:       { id: 'blink', name: 'Blink', description: 'Teleport to an empty hex within 3.', cooldown: 4, range: 3, target: 'hex', icon: 'skills/blink.png' },
  masonry:     { id: 'masonry', name: 'Masonry', description: 'Permanently learned: this unit can build Watchtowers.', cooldown: 0, range: 0, target: 'none', unlocksBuilding: 'watchtower', icon: 'skills/masonry.png' },
  devotion:    { id: 'devotion', name: 'Devotion', description: 'Permanently learned: this unit can build Shrines.', cooldown: 0, range: 0, target: 'none', unlocksBuilding: 'shrine', icon: 'skills/devotion.png' },
};

const S = (id: string, name: string, description: string, categories: SkillOptionDef['categories'], extra: Partial<SkillOptionDef>, weight = 1): SkillOptionDef => ({
  id, name, description, categories, weight, kind: 'stat', icon: `skills/${id}.png`, ...extra,
});

/** Every option a level-up can offer. Categories drive the weighting (DESIGN §4.7). */
export const LEVEL_OPTIONS: SkillOptionDef[] = [
  // ── stats ──
  S('stat_str', '+3 Strength', 'Hit harder in melee.', ['melee'], { kind: 'stat', stat: { str: 3 }, icon: 'skills/stat_str.png' }, 1.2),
  S('stat_dex', '+3 Dexterity', 'Sharper aim with ranged weapons.', ['ranged', 'explore'], { kind: 'stat', stat: { dex: 3 }, icon: 'skills/stat_dex.png' }, 1.1),
  S('stat_int', '+3 Intellect', 'Stronger magic and spellcasting.', ['magic'], { kind: 'stat', stat: { int: 3 }, icon: 'skills/stat_int.png' }, 1.2),
  S('stat_hp', '+6 Max HP', 'Tougher in every fight.', ['melee', 'building', 'leader'], { kind: 'stat', stat: { maxHp: 6 }, icon: 'skills/stat_hp.png' }, 1.2),
  S('stat_armor', '+6 Armor', 'Shrug off blows.', ['melee', 'leader'], { kind: 'stat', stat: { armor: 6 }, icon: 'skills/stat_armor.png' }, 1),
  S('stat_mov', '+1 Movement', 'Cover more ground each turn.', ['explore'], { kind: 'stat', stat: { mov: 1 }, icon: 'skills/stat_mov.png' }, 1),
  S('stat_vis', '+1 Vision', 'See further.', ['explore', 'ranged'], { kind: 'stat', stat: { vis: 1 }, icon: 'skills/stat_vis.png' }, 0.8),
  // ── efficiency ──
  S('eff_attack', 'Weapon Mastery', '+25% melee damage.', ['melee'], { kind: 'efficiency', efficiency: 'attack', icon: 'skills/eff_attack.png' }),
  S('eff_ranged', 'Keen Eye', '+25% ranged damage.', ['ranged'], { kind: 'efficiency', efficiency: 'ranged', icon: 'skills/eff_ranged.png' }),
  S('eff_magic', 'Arcane Focus', '+25% magic damage.', ['magic'], { kind: 'efficiency', efficiency: 'magic', icon: 'skills/eff_magic.png' }),
  S('eff_farming', 'Green Thumb', '+25% food from the building this unit works (while working it).', ['civic'], { kind: 'efficiency', efficiency: 'farming', icon: 'skills/eff_farming.png' }),
  S('eff_building', 'Master Builder', '+25% build speed and +25% output of the worked building (while working it).', ['building'], { kind: 'efficiency', efficiency: 'building', icon: 'skills/eff_building.png' }, 1.2),
  S('eff_mining', 'Deep Delver', '+25% stone, iron and crystal from the worked building (while working it).', ['civic', 'explore'], { kind: 'efficiency', efficiency: 'mining', icon: 'skills/eff_mining.png' }),
  S('eff_gathering', 'Woodsman', '+25% wood from the worked building (while working it).', ['civic', 'explore'], { kind: 'efficiency', efficiency: 'gathering', icon: 'skills/eff_gathering.png' }),
  S('eff_mana', 'Mana Channeler', '+25% mana from own equipment (wand, robe) and from the building it works.', ['magic', 'civic'], { kind: 'efficiency', efficiency: 'mana', icon: 'skills/eff_mana.png' }),
  S('eff_research', 'Erudite', '+25% research from the worked building (while working it).', ['magic', 'civic'], { kind: 'efficiency', efficiency: 'research', icon: 'skills/eff_research.png' }),
  S('eff_trade', 'Merchant', '+25% gold from the worked building (while working it).', ['civic', 'leader'], { kind: 'efficiency', efficiency: 'trade', icon: 'skills/eff_trade.png' }),
  // ── passives ──
  S('passive_regeneration', 'Regeneration', 'Heals 4 HP each turn.', ['melee', 'magic'], { kind: 'passive', passive: 'regeneration' }, 0.7),
  S('passive_poison', 'Venom Blades', 'Melee hits poison targets.', ['melee'], { kind: 'passive', passive: 'poison' }, 0.7),
  S('passive_skirmisher', 'Skirmisher', 'Ignore zones of control.', ['explore', 'ranged'], { kind: 'passive', passive: 'skirmisher' }, 0.7),
  S('passive_pathfinder', 'Pathfinder', 'Forest and hills cost 1 movement.', ['explore'], { kind: 'passive', passive: 'pathfinder' }, 0.9),
  S('passive_ironskin', 'Iron Skin', '+8 armor.', ['melee'], { kind: 'passive', passive: 'ironskin' }, 0.7),
  S('passive_leadership', 'Leadership', 'Adjacent allies +15% damage.', ['leader', 'melee'], { kind: 'passive', passive: 'leadership' }, 0.8),
  S('passive_harvester', 'Harvester', '+1 food per turn.', ['civic'], { kind: 'passive', passive: 'harvester' }, 0.8),
  S('passive_prospector', 'Prospector', '+1 iron per turn.', ['civic', 'explore'], { kind: 'passive', passive: 'prospector' }, 0.8),
  S('passive_manaspring', 'Mana Spring', '+1 mana per turn.', ['magic'], { kind: 'passive', passive: 'manaspring' }, 0.9),
  S('passive_scholar', 'Scholar', '+1 research per turn.', ['magic', 'civic', 'leader'], { kind: 'passive', passive: 'scholar' }, 0.8),
  S('passive_marksman', 'Marksman', 'Ranged hit chance at least 60%.', ['ranged'], { kind: 'passive', passive: 'marksman' }, 0.7),
  S('passive_berserker', 'Berserker', '+25% melee damage below half HP.', ['melee'], { kind: 'passive', passive: 'berserker' }, 0.6),
  S('passive_vampiric', 'Life Drinker', 'Heal 30% of melee damage dealt.', ['melee', 'magic'], { kind: 'passive', passive: 'vampiric' }, 0.5),
  S('passive_inspiring', 'Inspiring', 'Adjacent allies gain 1 XP per turn (in their own trade).', ['leader', 'civic'], { kind: 'passive', passive: 'inspiring' }, 0.7),
  // ── actives ──
  S('active_powerstrike', 'Power Strike', 'Active: next melee attack +50% damage (cd 3).', ['melee'], { kind: 'active', active: 'powerstrike' }, 0.8),
  S('active_volley', 'Volley', 'Active: area arrow barrage (cd 4).', ['ranged'], { kind: 'active', active: 'volley' }, 0.6),
  S('active_heal', 'Mend', 'Active: heal an adjacent ally 12 HP (cd 2).', ['magic', 'civic', 'leader'], { kind: 'active', active: 'heal' }, 0.8),
  S('active_firebolt', 'Firebolt', 'Active: 14 damage at range 3, ignoring armor (cd 3).', ['magic'], { kind: 'active', active: 'firebolt' }, 0.8),
  S('active_rally', 'Rally', 'Active: nearby allies that have not attacked +2 movement (cd 4).', ['leader'], { kind: 'active', active: 'rally' }, 0.8),
  S('active_fortify', 'Fortify', 'Active: +20 armor until next turn, instead of attacking (cd 3).', ['melee', 'building'], { kind: 'active', active: 'fortify' }, 0.7),
  S('active_blink', 'Blink', 'Active: teleport up to 3 hexes (cd 4).', ['magic', 'explore'], { kind: 'active', active: 'blink' }, 0.6),
  S('active_masonry', 'Masonry', 'Learn to build Watchtowers.', ['building', 'explore'], { kind: 'active', active: 'masonry' }, 0.7),
  S('active_devotion', 'Devotion', 'Learn to build Shrines.', ['magic', 'building'], { kind: 'active', active: 'devotion' }, 0.7),
];

export const LEVEL_OPTION_BY_ID: Record<string, SkillOptionDef> = Object.fromEntries(LEVEL_OPTIONS.map((o) => [o.id, o]));

export const xpToNext = (level: number): number => 25 + 15 * level;
export const MAX_LEVEL = 10;
export const LEADER_XP_MULT = 1.3;
