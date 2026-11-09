import type { SpellDef, SpellId } from '../core/types';

export const SPELLS: Record<SpellId, SpellDef> = {
  heal:     { id: 'heal', name: 'Healing Light', mana: 20, range: 6, cooldown: 2, radius: 1, target: 'any', description: 'Allies within 1 hex of the target heal 15 HP and are cured of poison.', icon: 'spells/heal.png' },
  bless:    { id: 'bless', name: 'Blessing', mana: 25, range: 6, cooldown: 3, radius: 1, target: 'any', description: 'Allies within 1 hex deal +20% damage and gain +10 armor for 2 turns.', icon: 'spells/bless.png' },
  fireball: { id: 'fireball', name: 'Fireball', mana: 30, range: 7, cooldown: 2, radius: 1, target: 'any', description: '18 damage on the target hex and 8 to every unit within 1 hex, ignoring armor. Friend or foe.', icon: 'spells/fireball.png' },
  haste:    { id: 'haste', name: 'Haste', mana: 15, range: 8, cooldown: 2, radius: 0, target: 'ally', description: 'One allied unit gains +3 movement this turn (not a unit that has already attacked).', icon: 'spells/haste.png' },
  farsight: { id: 'farsight', name: 'Farsight', mana: 10, range: 10, cooldown: 1, radius: 4, target: 'any', description: 'Reveal everything within 4 hexes of the target for 3 turns.', icon: 'spells/farsight.png' },
  summon:   { id: 'summon', name: 'Summon Elemental', mana: 50, range: 4, cooldown: 5, radius: 0, target: 'empty', description: 'Summon a Stone Elemental (40 HP, melee 12×2) on an empty hex. It crumbles after 8 turns.', icon: 'spells/summon.png' },
  storm:    { id: 'storm', name: 'Storm of Ruin', mana: 45, range: 7, cooldown: 4, radius: 2, target: 'any', description: 'Four lightning bolts strike random enemies within 2 hexes for 14 damage each, ignoring armor.', icon: 'spells/storm.png' },
};

export const SPELL_LIST = Object.values(SPELLS);
