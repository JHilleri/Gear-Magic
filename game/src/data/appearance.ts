// What a unit looks like beyond its armour: gender, hair cut and colour, eye colour, beard
// (DESIGN §4.9). Rolled once when the unit is created and kept for life; the renderer puts a hair
// and a beard piece on the head of the gendered body and tints them (render/units.ts).
import type { Appearance, BeardStyle, EyeColor, Gender, HairColor, HairStyle, RaceId, SkinTone } from '../core/types';

export interface HairStyleDef { id: HairStyle; name: string; genders: Gender[]; weight: number }
export interface BeardDef { id: BeardStyle; name: string; weight: number }
export interface ColorDef<T extends string> { id: T; name: string; color: string; weight: number }

/** Hair cuts. 'bald' has no model: the bare head of the body shows. */
export const HAIR_STYLES: HairStyleDef[] = [
  { id: 'short', name: 'Short', genders: ['male'], weight: 5 },
  { id: 'crop', name: 'Cropped', genders: ['male'], weight: 3 },
  { id: 'swept', name: 'Shoulder-length', genders: ['male'], weight: 3 },
  { id: 'tail', name: 'Tied back', genders: ['male'], weight: 2 },
  { id: 'curly', name: 'Curly', genders: ['male', 'female'], weight: 2 },
  { id: 'bald', name: 'Bald', genders: ['male'], weight: 1 },
  { id: 'long', name: 'Long', genders: ['female'], weight: 4 },
  { id: 'braid', name: 'Braided', genders: ['female'], weight: 4 },
  { id: 'bun', name: 'Bun', genders: ['female'], weight: 3 },
  { id: 'bob', name: 'Bob', genders: ['female'], weight: 3 },
  { id: 'ponytail', name: 'Ponytail', genders: ['female'], weight: 3 },
  { id: 'pixie', name: 'Pixie cut', genders: ['female'], weight: 2 },
];

/** Beards (men only). 'none' has no model. */
export const BEARDS: BeardDef[] = [
  { id: 'none', name: 'Clean-shaven', weight: 8 },
  { id: 'short', name: 'Short beard', weight: 4 },
  { id: 'full', name: 'Full beard', weight: 3 },
  { id: 'moustache', name: 'Moustache', weight: 2 },
  { id: 'goatee', name: 'Goatee', weight: 2 },
  { id: 'long', name: 'Long beard', weight: 1 },
];

/** Faces: each gender has its own set of head models ('head_<m|f><n>'); `Appearance.face` indexes it. */
export const FACES: Record<Gender, string[]> = {
  male: ['Square-jawed', 'Weathered', 'Lean'],
  female: ['Soft', 'Stern', 'Freckled'],
};
/** Longest name a unit can be given (the customisation screen). */
export const NAME_MAX = 18;

export const HAIR_COLORS: ColorDef<HairColor>[] = [
  { id: 'black', name: 'Black', color: '#262220', weight: 3 },
  { id: 'darkbrown', name: 'Dark brown', color: '#4a3324', weight: 5 },
  { id: 'brown', name: 'Brown', color: '#7a5233', weight: 5 },
  { id: 'auburn', name: 'Auburn', color: '#8a3b1e', weight: 3 },
  { id: 'ginger', name: 'Ginger', color: '#c9622a', weight: 2 },
  { id: 'blonde', name: 'Blonde', color: '#d9b36a', weight: 4 },
  { id: 'platinum', name: 'Platinum', color: '#efe2c0', weight: 1 },
  { id: 'grey', name: 'Grey', color: '#a8a8a8', weight: 1 },
];

export const EYE_COLORS: ColorDef<EyeColor>[] = [
  { id: 'brown', name: 'Brown', color: '#6b4423', weight: 5 },
  { id: 'hazel', name: 'Hazel', color: '#8e7032', weight: 3 },
  { id: 'amber', name: 'Amber', color: '#c98a1e', weight: 1 },
  { id: 'green', name: 'Green', color: '#3f9a4e', weight: 3 },
  { id: 'blue', name: 'Blue', color: '#3b82d6', weight: 4 },
  { id: 'grey', name: 'Grey', color: '#8fa3b3', weight: 2 },
];

/** Albedo colours, in sRGB; the renderer retains each face's painted detail and shading. */
export const SKIN_TONES: ColorDef<SkinTone>[] = [
  { id: 'porcelain', name: 'Porcelain', color: '#c59c88', weight: 2 },
  { id: 'fair', name: 'Fair', color: '#bb8a6c', weight: 3 },
  { id: 'warm', name: 'Warm', color: '#ae7353', weight: 3 },
  { id: 'olive', name: 'Olive', color: '#a77855', weight: 3 },
  { id: 'brown', name: 'Brown', color: '#805039', weight: 3 },
  { id: 'deep', name: 'Deep', color: '#523326', weight: 2 },
];

/** Races whose units have a gender and a rolled appearance (humans, for now). */
export function hasAppearance(race: RaceId): boolean {
  return race === 'human';
}

function weighted<T extends { weight: number }>(list: readonly T[], r: number): T {
  let total = 0;
  for (const e of list) total += e.weight;
  let x = r * total;
  for (const e of list) { x -= e.weight; if (x < 0) return e; }
  return list[list.length - 1];
}

/** A gender from one uniform draw: half and half. */
export function rollGender(r: number): Gender {
  return r < 0.5 ? 'female' : 'male';
}

/** An appearance for `gender` from six draws. Skin comes last so existing identity rolls remain stable. */
export function rollAppearance(gender: Gender, next: () => number): Appearance {
  const hair = weighted(HAIR_STYLES.filter((h) => h.genders.includes(gender)), next()).id;
  const hairColor = weighted(HAIR_COLORS, next()).id;
  const eyes = weighted(EYE_COLORS, next()).id;
  const b = next();
  const beard: BeardStyle = gender === 'male' ? weighted(BEARDS, b).id : 'none';
  const face = Math.min(FACES[gender].length - 1, Math.floor(next() * FACES[gender].length));
  const skin = weighted(SKIN_TONES, next()).id;
  return { hair, hairColor, eyes, beard, face, skin };
}

const byId = <T extends { id: string }>(list: readonly T[], id: string | undefined): T | undefined => list.find((e) => e.id === id);

export const hairStyleDef = (id: string | undefined) => byId(HAIR_STYLES, id);
export const beardDef = (id: string | undefined) => byId(BEARDS, id);
export const hairColorDef = (id: string | undefined) => byId(HAIR_COLORS, id);
export const eyeColorDef = (id: string | undefined) => byId(EYE_COLORS, id);
export const skinToneDef = (id: string | undefined) => byId(SKIN_TONES, id);

/** Hair cuts a gender can wear. */
export function hairStylesFor(gender: Gender): HairStyleDef[] {
  return HAIR_STYLES.filter((h) => h.genders.includes(gender));
}

/**
 * Why `look` is not a valid appearance for `gender` (null: it is): every id must be in its table,
 * the hair cut one of the gender's, the face one of its faces, and only men wear a beard.
 */
export function appearanceError(gender: Gender, look: Appearance): string | null {
  if (!look || typeof look !== 'object') return 'Invalid appearance';
  const style = hairStyleDef(look.hair);
  if (!style) return 'Unknown hair cut';
  if (!style.genders.includes(gender)) return `${style.name} is not a ${gender === 'female' ? "woman's" : "man's"} hair cut`;
  if (!hairColorDef(look.hairColor)) return 'Unknown hair colour';
  if (!eyeColorDef(look.eyes)) return 'Unknown eye colour';
  if (look.skin !== undefined && !skinToneDef(look.skin)) return 'Unknown skin tone';
  if (!beardDef(look.beard)) return 'Unknown beard';
  if (gender === 'female' && look.beard !== 'none') return 'Only men wear a beard';
  if (!Number.isInteger(look.face) || look.face < 0 || look.face >= FACES[gender].length) return 'Unknown face';
  return null;
}

/** `look` made valid for `gender`, keeping what carries over (colours, a shared hair cut): a change of gender in the customisation screen. */
export function fitAppearance(gender: Gender, look: Appearance): Appearance {
  const styles = hairStylesFor(gender);
  return {
    hair: styles.some((h) => h.id === look.hair) ? look.hair : styles[0].id,
    hairColor: look.hairColor,
    eyes: look.eyes,
    beard: gender === 'male' ? look.beard : 'none',
    face: Math.max(0, Math.min(FACES[gender].length - 1, Math.floor(look.face) || 0)),
    ...(look.skin === undefined ? {} : { skin: look.skin }),
  };
}

/** "Auburn braided hair, green eyes, short beard" — one line for the unit sheet. */
export function describeAppearance(look: Appearance): string {
  const parts: string[] = [];
  const style = hairStyleDef(look.hair);
  const color = hairColorDef(look.hairColor);
  if (look.hair === 'bald') parts.push('Bald');
  else if (style && color) parts.push(`${color.name} hair, ${style.name.toLowerCase()}`);
  const eyes = eyeColorDef(look.eyes);
  if (eyes) parts.push(`${eyes.name.toLowerCase()} eyes`);
  const beard = beardDef(look.beard);
  if (beard && look.beard !== 'none') parts.push(`${look.hair === 'bald' && color ? `${color.name.toLowerCase()} ` : ''}${beard.name.toLowerCase()}`);
  const skin = skinToneDef(look.skin);
  if (skin) parts.push(`${skin.name.toLowerCase()} skin`);
  return parts.join(', ');
}
