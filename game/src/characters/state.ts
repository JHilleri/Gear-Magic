import type { Appearance, Equipment, Gender, ItemId } from '../core/types';
import { appearanceError, cleanShape, NAME_MAX } from '../data/appearance';
import { ITEMS } from '../data/items';

export interface CharacterDraft {
  version: 1;
  name: string;
  gender: Gender;
  look: Appearance;
  equipment: Equipment;
}

export const CHARACTER_STORAGE_KEY = 'gear-and-magic:character-forge:v1';
export const INITIAL_CHARACTER: CharacterDraft = {
  version: 1,
  name: 'Aveline',
  gender: 'female',
  look: { hair: 'braid', hairColor: 'auburn', eyes: 'green', beard: 'none', face: 0, skin: 'warm' },
  equipment: { main: 'sword', off: 'shield', body: 'plate', trinket: 'amulet', mount: null },
};

export const LOADOUTS: { id: string; name: string; note: string; equipment: Equipment }[] = [
  { id: 'vanguard', name: 'Vanguard', note: 'Plate · sword & shield', equipment: { main: 'sword', off: 'shield', body: 'plate', trinket: 'amulet', mount: null } },
  { id: 'ranger', name: 'Ranger', note: 'Leather · longbow', equipment: { main: 'bow', off: null, body: 'leather', trinket: null, mount: null } },
  { id: 'arcanist', name: 'Arcanist', note: 'Runed silk · staff', equipment: { main: 'staff', off: null, body: 'robe', trinket: 'ring', mount: null } },
  { id: 'adventurer', name: 'Adventurer', note: 'Padded cloth · axe', equipment: { main: 'axe', off: null, body: 'tunic', trinket: null, mount: null } },
];

/** Parse both imported and locally stored drafts through the same catalog validation. */
export function parseCharacterDraft(value: unknown): CharacterDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a Character Forge JSON file.');
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new Error('This character file uses an unsupported version.');
  if (v.gender !== 'male' && v.gender !== 'female') throw new Error('Choose a male or female character.');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > NAME_MAX) throw new Error(`Use a name between 1 and ${NAME_MAX} characters.`);
  const error = appearanceError(v.gender, v.look as Appearance);
  if (error) throw new Error(error);
  const look = v.look as Appearance;
  if (!v.equipment || typeof v.equipment !== 'object' || Array.isArray(v.equipment)) throw new Error('This character has no valid equipment.');
  const e = v.equipment as Record<string, unknown>;
  const equipment: Equipment = { main: null, off: null, body: null, trinket: null, mount: null };
  for (const slot of ['main', 'off', 'body', 'trinket', 'mount'] as const) {
    const item = e[slot];
    if (item === null) continue;
    if (typeof item !== 'string' || !Object.hasOwn(ITEMS, item) || ITEMS[item as ItemId].slot !== slot) throw new Error(`Unknown item in the ${slot} slot.`);
    if (slot === 'mount') throw new Error('The Character Forge displays characters on foot. Remove the mount before importing.');
    equipment[slot] = item as ItemId;
  }
  if (equipment.main && ITEMS[equipment.main].twoHanded && equipment.off) throw new Error('A two-handed weapon cannot be combined with a shield.');
  return {
    version: 1, name: v.name.trim(), gender: v.gender,
    look: { hair: look.hair, hairColor: look.hairColor, eyes: look.eyes, beard: look.beard, face: look.face, ...(look.skin ? { skin: look.skin } : {}), ...(cleanShape(look.shape) ? { shape: cleanShape(look.shape) } : {}) },
    equipment,
  };
}

/** Slot changes obey the game's two-handed rule, preserving the rest of the loadout. */
export function withEquipment(draft: CharacterDraft, slot: keyof Equipment, item: ItemId | null): CharacterDraft {
  const equipment = { ...draft.equipment, [slot]: item };
  if (slot === 'main' && item && ITEMS[item].twoHanded) equipment.off = null;
  return { ...draft, equipment };
}
