// Pure UI helpers (formatting, XP segments, equipment deltas, roles).
import { describe, expect, it } from 'vitest';
import {
  addCost, costEntries, equipDelta, fmt, initials, optionError, pct, presetTechs, safe, selectedUnitId, signed, statDelta, unitAtHex, unitRole, viewerOf,
  xpSegments,
} from '../src/ui/util';
import type { UiState } from '../src/game/store';
import { FACTIONS, factionPerks } from '../src/data/factions';
import { at, makeTestState, makeTestUnit } from './helpers';

const baseUi = (p: Partial<UiState> = {}): UiState => ({
  screen: 'game', loadingProgress: 1, loadingLabel: '', modal: null, mode: { kind: 'idle' }, selectedHex: null, hoverHex: null,
  reach: [], forecast: null, forecastTarget: null, forecastFrom: null, forecastAlt: null, effectPreview: null, effectError: null,
  hoverToward: null, busy: false, aiThinking: null, toasts: [],
  settings: { volume: 1, music: true, showGrid: true, animSpeed: 1, edgePan: true, quality: 'high', watchEnemyMoves: 'nearby' },
  recruitSite: null, forgeSite: null, levelUpUnit: null, hasSave: false,
  saves: { manual: null, auto: null }, skippedUnits: [], turnView: null, modalReturn: null, lastSetup: null, ...p,
});

describe('formatting', () => {
  it('the New Game card shows a house\'s armor bonus as a percentage (block is the flat one)', () => {
    expect(factionPerks(FACTIONS.ashen)[0]).toBe('+2 Intellect, +5% armor');
    expect(factionPerks(FACTIONS.thorn)[0]).toBe('+5 HP, +1 Strength, -1 Intellect');
  });

  it('formats numbers, signs and percentages', () => {
    expect(fmt(3)).toBe('3');
    expect(fmt(2.25)).toBe('2.3');
    expect(fmt(-4)).toBe('−4');
    expect(fmt(Infinity)).toBe('∞');
    expect(signed(2)).toBe('+2');
    expect(signed(-1.5)).toBe('−1.5');
    expect(signed(0.01)).toBe('±0');
    expect(pct(0.5)).toBe('50%');
    expect(pct(0.004)).toBe('<1%');
    expect(pct(0.996)).toBe('>99%');
    expect(initials('Queen Aldra Valen')).toBe('QV');
    expect(initials('Zug')).toBe('ZU');
  });
  it('orders and adds costs', () => {
    expect(costEntries({ stone: 2, gold: 5 })).toEqual([['gold', 5], ['stone', 2]]);
    expect(addCost({ gold: 1 }, { gold: 2, iron: 1 }, 2)).toEqual({ gold: 5, iron: 2 });
  });
  it('safe() returns the fallback on throw', () => {
    expect(safe(() => { throw new Error('x'); }, 7)).toBe(7);
    expect(safe(() => 3, 7)).toBe(3);
  });
});

describe('units', () => {
  it('splits XP of the level by category share', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(2, 2), { xp: 20, levelXpByCat: { melee: 15, ranged: 0, building: 0, civic: 5, explore: 0, leader: 0, magic: 0 } });
    const segs = xpSegments(u, 40);
    expect(segs.map((x) => x.cat)).toEqual(['melee', 'civic']);
    expect(segs[0].frac).toBeCloseTo(0.375);
    expect(segs[1].frac).toBeCloseTo(0.125);
    expect(xpSegments({ ...u, xp: 0 }, 40)).toEqual([]);
  });
  it('computes equip deltas including a shield displaced by a bow', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(2, 2), { items: ['sword', 'shield', 'tunic'] });
    // Plate (3 block, 25% armor, −1 mov) in place of the tunic (1 block, 5% armor).
    expect(equipDelta(u, 'plate')).toEqual({ block: 2, armor: 20, mov: -1 });
    // The two-handed bow takes the shield (2 block, 5% armor) off too.
    expect(equipDelta(u, 'bow')).toEqual({ block: -2, armor: -5 });
    expect(statDelta({ str: 1 }, { str: 1 })).toEqual({});
  });
  it('names roles from equipment', () => {
    const s = makeTestState();
    expect(unitRole(makeTestUnit(s, 'valen', at(1, 1), { items: ['sword', 'horse'] }))).toBe('Knight');
    expect(unitRole(makeTestUnit(s, 'valen', at(1, 2), { items: ['bow'] }))).toBe('Archer');
    expect(unitRole(makeTestUnit(s, 'valen', at(1, 3), {}))).toBe('Commoner');
    expect(unitRole(makeTestUnit(s, 'valen', at(1, 4), { isLeader: true }))).toBe('Leader');
  });
  it('lists the research each recruit preset needs', () => {
    expect(presetTechs('commoner')).toEqual([]);
    expect(presetTechs('swordsman')).toEqual([]);
    expect(presetTechs('archer')).toEqual(['tanning']);   // the Longbow is free, leather is not
    expect(presetTechs('apprentice').sort()).toEqual(['arcana', 'wandcraft']);
    expect(presetTechs('battlemage').sort()).toEqual(['arcana', 'jewelcraft']);
  });
  it('resolves the selected unit from mode or selected hex (fog-aware)', () => {
    const s = makeTestState();
    const mine = makeTestUnit(s, 'valen', at(3, 3));
    const foe = makeTestUnit(s, 'thorn', at(5, 5));
    expect(viewerOf(s)).toBe('valen');
    expect(unitAtHex(s, foe.pos)?.id).toBe(foe.id);
    expect(selectedUnitId(s, baseUi({ mode: { kind: 'unit', unit: mine.id } }))).toBe(mine.id);
    expect(selectedUnitId(s, baseUi({ selectedHex: foe.pos }))).toBe(foe.id);
    s.factions.valen.visible.fill(0);
    expect(selectedUnitId(s, baseUi({ selectedHex: foe.pos }))).toBe(null);
  });
});

describe('option errors (build / recruit menus)', () => {
  it('keeps allowed options allowed', () => {
    const opts = [{ building: 'farm', error: null }, { building: 'quarry', error: 'Cannot be built on Grassland' }];
    expect(optionError(opts, (o) => o.building === 'farm', true)).toBeNull();
    expect(optionError(opts, (o) => o.building === 'quarry', true)).toBe('Cannot be built on Grassland');
    expect(optionError(opts, (o) => o.building === 'mine', true)).toBe('Unavailable');
    expect(optionError(opts, (o) => o.building === 'farm', false)).toBe('Not your turn');
  });
});
