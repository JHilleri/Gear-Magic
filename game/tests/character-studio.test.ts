import { describe, expect, it } from 'vitest';
import { INITIAL_CHARACTER, LOADOUTS, parseCharacterDraft, withEquipment } from '../src/characters/state';

describe('Character Forge persistence', () => {
  it('round-trips appearances, skin and every supplied loadout through JSON', () => {
    for (const preset of LOADOUTS) {
      const draft = { ...INITIAL_CHARACTER, equipment: preset.equipment };
      const result = parseCharacterDraft(JSON.parse(JSON.stringify(draft)));
      expect(result).toEqual(draft);
      expect(result.look).not.toBe(draft.look);
      expect(result.equipment).not.toBe(draft.equipment);
    }
  });

  it('rejects foreign files, unknown appearance values, misplaced items and incompatible gear', () => {
    const draft = structuredClone(INITIAL_CHARACTER);
    expect(() => parseCharacterDraft(null)).toThrow(/JSON/);
    expect(() => parseCharacterDraft({ ...draft, version: 2 })).toThrow(/version/);
    expect(() => parseCharacterDraft({ ...draft, gender: 'unknown' })).toThrow(/male or female/);
    expect(() => parseCharacterDraft({ ...draft, name: '  ' })).toThrow(/name/);
    expect(() => parseCharacterDraft({ ...draft, look: { ...draft.look, skin: 'invalid' } })).toThrow(/skin/i);
    expect(() => parseCharacterDraft({ ...draft, look: { ...draft.look, hair: 'invalid' } })).toThrow(/hair/i);
    expect(() => parseCharacterDraft({ ...draft, equipment: { ...draft.equipment, body: 'sword' } })).toThrow(/body slot/);
    expect(() => parseCharacterDraft({ ...draft, equipment: { ...draft.equipment, main: 'constructor' } })).toThrow(/main slot/);
    expect(() => parseCharacterDraft({ ...draft, equipment: { ...draft.equipment, main: 'bow', off: 'shield' } })).toThrow(/two-handed/);
    expect(() => parseCharacterDraft({ ...draft, equipment: { ...draft.equipment, mount: 'horse' } })).toThrow(/on foot/);
  });

  it('retains legacy original skin and discards unrelated imported properties', () => {
    const { skin, ...look } = INITIAL_CHARACTER.look;
    const result = parseCharacterDraft({ ...INITIAL_CHARACTER, name: '  Aveline  ', look: { ...look, extra: 'ignored' }, extra: '<script>' });
    expect(result.name).toBe('Aveline');
    expect(result.look.skin).toBeUndefined();
    expect(result).not.toHaveProperty('extra');
    expect(result.look).not.toHaveProperty('extra');
  });

  it('unequips the shield when selecting a two-handed weapon without changing appearance or armor', () => {
    const draft = structuredClone(INITIAL_CHARACTER);
    const next = withEquipment(draft, 'main', 'bow');
    expect(next.equipment).toEqual({ ...draft.equipment, main: 'bow', off: null });
    expect(next.look).toEqual(draft.look);
    expect(draft.equipment.off).toBe('shield');
    expect(withEquipment(next, 'main', 'sword').equipment.off).toBeNull();
  });
});
