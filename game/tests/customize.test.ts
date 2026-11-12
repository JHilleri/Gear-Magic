// Customising a unit (DESIGN §4.9): the 'customize' action changes who a human is — name, gender,
// looks — and nothing else.
import { describe, expect, it } from 'vitest';
import { at, makeTestState } from './helpers';
import { applyAction, validateAction } from '../src/sim/actions';
import { canCustomize, createUnit, effectiveStats } from '../src/sim/units';
import { FACES, NAME_MAX, appearanceError, fitAppearance, hairStylesFor } from '../src/data/appearance';
import { headModelKey } from '../src/render/appearance';
import type { Appearance } from '../src/core/types';

const LOOK: Appearance = { hair: 'short', hairColor: 'ginger', eyes: 'green', beard: 'full', face: 2 };

describe('customize', () => {
  it('changes the name, gender and looks of an own human, and nothing else', () => {
    const s = makeTestState(12, 10);
    const u = createUnit(s, { faction: 'valen', pos: at(2, 2), preset: 'swordsman', gender: 'male' });
    const rng = s.rngState;
    const before = JSON.stringify({ stats: effectiveStats(s, u), eq: u.equipment, hp: u.hp, mp: u.mp, acted: u.acted });
    const r = applyAction(s, { type: 'customize', unit: u.id, name: '  Bertram ', look: LOOK });
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([]);
    expect(u.name).toBe('Bertram');
    expect(u.look).toEqual(LOOK);
    expect(u.look).not.toBe(LOOK); // a copy: the action's payload is not kept
    expect(u.gender).toBe('male');
    expect(JSON.stringify({ stats: effectiveStats(s, u), eq: u.equipment, hp: u.hp, mp: u.mp, acted: u.acted })).toBe(before);
    expect(s.rngState).toBe(rng);
    // a change of gender with looks that suit it
    const woman = fitAppearance('female', LOOK);
    expect(woman.beard).toBe('none');
    expect(hairStylesFor('female').some((h) => h.id === woman.hair)).toBe(true);
    expect(applyAction(s, { type: 'customize', unit: u.id, gender: 'female', look: woman, name: 'Maud' }).ok).toBe(true);
    expect([u.gender, u.name, u.look]).toEqual(['female', 'Maud', woman]);
    expect(headModelKey('female', woman)).toBe('head_f3');
    expect(headModelKey('male', { ...LOOK, face: 0 })).toBe('head_m1');
  });

  it('refuses looks that do not suit the gender, unknown ids, bad names, and units without looks', () => {
    const s = makeTestState(12, 10);
    const u = createUnit(s, { faction: 'valen', pos: at(2, 2), gender: 'female', name: 'Aelis' });
    const other = createUnit(s, { faction: 'valen', pos: at(3, 2), gender: 'male', name: 'Edric' });
    const bad = (a: Parameters<typeof validateAction>[1]) => validateAction(s, a);
    expect(bad({ type: 'customize', unit: u.id, look: LOOK })).toMatch(/hair cut|beard/);            // a man's cut and beard on a woman
    expect(bad({ type: 'customize', unit: u.id, gender: 'male', look: LOOK })).toBeNull();
    expect(bad({ type: 'customize', unit: u.id, look: { ...u.look!, face: FACES.female.length } })).toBe('Unknown face');
    expect(bad({ type: 'customize', unit: u.id, look: { ...u.look!, hairColor: 'pink' as never } })).toBe('Unknown hair colour');
    expect(bad({ type: 'customize', unit: u.id, look: { ...u.look!, eyes: 'red' as never } })).toBe('Unknown eye colour');
    expect(bad({ type: 'customize', unit: u.id, gender: 'other' as never })).toBe('Unknown gender');
    expect(bad({ type: 'customize', unit: u.id, name: '   ' })).toBe('A unit needs a name');
    expect(bad({ type: 'customize', unit: u.id, name: 'x'.repeat(NAME_MAX + 1) })).toMatch(/at most/);
    expect(bad({ type: 'customize', unit: u.id, name: 'edric' })).toBe('Edric already bears that name');
    expect(bad({ type: 'customize', unit: u.id, name: 'Aelis' })).toBeNull();                         // its own name
    expect(appearanceError('male', LOOK)).toBeNull();
    // not the leader, not an orc, not another house's unit
    const queen = createUnit(s, { faction: 'valen', pos: at(5, 5), isLeader: true });
    expect(canCustomize(s, queen, { name: 'Bob' })).toMatch(/keeps/);
    const orc = createUnit(s, { faction: 'thorn', pos: at(8, 8) });
    expect(canCustomize(s, orc, { name: 'Bob' })).toMatch(/humans/);
    expect(bad({ type: 'customize', unit: orc.id, name: 'Bob' })).toBe('Not your unit');
    expect(other.name).toBe('Edric');
  });
});
