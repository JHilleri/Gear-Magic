// Which GLB model a unit body / building uses (pure key selection, no WebGL).
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
