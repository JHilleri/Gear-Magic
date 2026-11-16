// Which GLB model a unit body / building uses (pure key selection, no WebGL).
import { hairPieceKeys } from '../src/render/appearance';
import { BEARDS, EYE_COLORS, HAIR_COLORS, HAIR_STYLES, describeAppearance, rollAppearance, rollGender } from '../src/data/appearance';
import { appearanceRng } from '../src/sim/units';
import { describe, expect, it } from 'vitest';
import { firstAvailable, unitBodyKeys } from '../src/render/units';
import { buildingModelKeys } from '../src/render/buildings';
import { ITEMS } from '../src/data/items';

const lib = (...keys: string[]) => { const s = new Set(keys); return (k: string) => s.has(k); };

describe('unit body models', () => {
  it('dresses a commoner in the padded tunic in the padded body, once the model exists', () => {
    expect(ITEMS.tunic.slot).toBe('body');
    expect(unitBodyKeys('orc', 'commoner', 'tunic')).toEqual(['orc_padded', 'orc_commoner']);
    // the model has shipped
    expect(firstAvailable(unitBodyKeys('human', 'commoner', 'tunic'), lib('human_padded', 'human_commoner'))).toBe('human_padded');
    // not yet: the commoner body
    expect(firstAvailable(unitBodyKeys('undead', 'commoner', 'tunic'), lib('undead_commoner'))).toBe('undead_commoner');
    // nothing at all: the procedural body
    expect(firstAvailable(unitBodyKeys('undead', 'commoner', 'tunic'), lib())).toBeNull();
  });
  it('leaves every other body alone', () => {
    expect(unitBodyKeys('human', 'commoner', null)).toEqual(['human_commoner']);
    expect(unitBodyKeys('human', 'heavy', 'plate')).toEqual(['human_heavy']);
    expect(unitBodyKeys('orc', 'light', 'leather')).toEqual(['orc_light']);
    expect(unitBodyKeys('human', 'robe', 'robe')).toEqual(['human_robe']);
    // a leader keeps the leader body whatever it wears
    expect(unitBodyKeys('orc', 'leader', 'tunic')).toEqual(['orc_leader']);
  });

  it('a unit with a gender wears that armour\'s own cut first, then the shared model', () => {
    expect(unitBodyKeys('human', 'light', 'leather', 'female')).toEqual(['human_f_light', 'human_light']);
    expect(unitBodyKeys('human', 'heavy', 'plate', 'male')).toEqual(['human_m_heavy', 'human_heavy']);
    expect(unitBodyKeys('human', 'commoner', 'tunic', 'female')).toEqual(['human_f_padded', 'human_f_commoner', 'human_padded', 'human_commoner']);
    // every armour exists for both: the same unit keeps its gender through any change of armour
    for (const body of ['commoner', 'light', 'heavy', 'robe'] as const) {
      expect(unitBodyKeys('human', body, null, 'male')[0]).toBe(`human_m_${body}`);
      expect(unitBodyKeys('human', body, null, 'female')[0]).toBe(`human_f_${body}`);
    }
    // a gendered human leader keeps her face and wears the plate she equipped
    expect(unitBodyKeys('human', 'leader', 'plate', 'female')).toEqual(['human_f_heavy', 'human_heavy', 'human_leader']);
    expect(unitBodyKeys('human', 'leader', 'robe', 'male')).toEqual(['human_m_robe', 'human_robe', 'human_leader']);
    expect(unitBodyKeys('human', 'leader', 'tunic', 'female')[0]).toBe('human_f_padded');
    expect(unitBodyKeys('human', 'leader', null, 'female')[0]).toBe('human_f_commoner');
    expect(unitBodyKeys('human', 'leader', 'plate')).toEqual(['human_leader']);
    // a missing cut falls back to the shared body
    expect(firstAvailable(unitBodyKeys('human', 'robe', 'robe', 'male'), lib('human_robe'))).toBe('human_robe');
  });

  it('hair and beard pieces of a look', () => {
    expect(hairPieceKeys(undefined)).toEqual([]);
    expect(hairPieceKeys({ hair: 'braid', hairColor: 'auburn', eyes: 'green', beard: 'none', face: 0 })).toEqual(['hair_braid']);
    expect(hairPieceKeys({ hair: 'bald', hairColor: 'black', eyes: 'brown', beard: 'full', face: 0 })).toEqual(['beard_full']);
    expect(hairPieceKeys({ hair: 'short', hairColor: 'blonde', eyes: 'blue', beard: 'goatee', face: 0 })).toEqual(['hair_short', 'beard_goatee']);
    expect(describeAppearance({ hair: 'braid', hairColor: 'auburn', eyes: 'green', beard: 'none', face: 0 })).toBe('Auburn hair, braided, green eyes');
    expect(describeAppearance({ hair: 'bald', hairColor: 'black', eyes: 'brown', beard: 'full', face: 0 })).toBe('Bald, brown eyes, black full beard');
  });

  it('every style a look can roll has a distinct piece, and both genders have a choice of cuts', () => {
    for (const g of ['male', 'female'] as const) expect(HAIR_STYLES.filter((h) => h.genders.includes(g)).length).toBeGreaterThanOrEqual(5);
    expect(new Set(HAIR_STYLES.map((h) => h.id)).size).toBe(HAIR_STYLES.length);
    expect(new Set(BEARDS.map((b) => b.id)).size).toBe(BEARDS.length);
    for (const c of [...HAIR_COLORS, ...EYE_COLORS]) expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    // rolls stay inside the tables and cover them
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const next = appearanceRng(11, i);
      const g = rollGender(next());
      const l = rollAppearance(g, next);
      expect(HAIR_STYLES.find((h) => h.id === l.hair)!.genders).toContain(g);
      seen.add(`h:${l.hair}`); seen.add(`b:${l.beard}`); seen.add(`c:${l.hairColor}`); seen.add(`e:${l.eyes}`);
    }
    expect(seen.size).toBe(HAIR_STYLES.length + BEARDS.length + HAIR_COLORS.length + EYE_COLORS.length);
  });
});

describe('building models', () => {
  const shipped = lib('castle_valen', 'castle_thorn', 'castle_ashen', 'house', 'house_thorn', 'house_ashen', 'farm', 'farm_thorn', 'farm_ashen', 'forge');
  const pick = (...a: Parameters<typeof buildingModelKeys>) => firstAvailable(buildingModelKeys(...a), shipped);

  it('uses the owner faction variant when one exists, else the plain model', () => {
    expect(pick('house', 'house', 'thorn', null, 'valen')).toBe('house_thorn');
    expect(pick('farm', 'farm', 'ashen', null, 'valen')).toBe('farm_ashen');
    expect(pick('house', 'house', 'valen', null, 'valen')).toBe('house');   // no house_valen: plain
    expect(pick('forge', 'forge', 'thorn', null, 'valen')).toBe('forge');   // no forge_thorn
    expect(pick('house', 'house', 'neutral', null, 'valen')).toBe('house');
    // a fallen faction's town keeps its shape (drawn grey by the abandoned look)
    expect(pick('house', 'house', null, 'thorn', 'valen')).toBe('house_thorn');
    expect(pick('house', 'house', null, null, 'valen')).toBe('house');
  });

  it("draws each faction's own seat, and never an unknown ownerless castle as Valen's", () => {
    expect(pick('castle', 'castle', 'valen', null, 'valen')).toBe('castle_valen');
    expect(pick('castle', 'castle', 'ashen', null, 'valen')).toBe('castle_ashen');
    // eliminated faction: its own silhouette
    expect(pick('castle', 'castle', null, 'ashen', 'valen')).toBe('castle_ashen');
    // never seen owned (e.g. a loaded game): neither the viewer's nor Valen's blue seat
    for (const viewer of ['valen', 'thorn', 'ashen'] as const) {
      const k = pick('castle', 'castle', null, null, viewer);
      expect(k).not.toBe('castle_valen');
      expect(k).not.toBe(`castle_${viewer}`);
    }
    // only Valen's model exists: still a castle (the abandoned look greys it)
    expect(firstAvailable(buildingModelKeys('castle', 'castle', null, null, 'thorn'), lib('castle_valen'))).toBe('castle_valen');
  });
});
