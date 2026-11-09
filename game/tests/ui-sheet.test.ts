// Pure helpers behind the unit sheet (src/ui/sheet.ts): the attribute rows add up, the attack
// formula reproduces the shown damage, every augment and level-up is listed, and the seven kinds
// of experience (and the options they favour) are laid out as the rules say.
import { describe, expect, it } from 'vitest';
import type { GameState, Unit } from '../src/core/types';
import { LEVEL_OPTIONS, XP_CATEGORIES, xpToNext, zeroXp } from '../src/data/skills';
import { getAttackDefs, effectiveStats, statBreakdown } from '../src/sim/units';
import { techDamageMult } from '../src/sim/research';
import { FACTIONS } from '../src/data/factions';
import {
  armoryNames, attackLines, augmentCount, augmentsOf, contributionTone, efficiencyRows, formatContribution, kindSummary, levelHistory,
  optionsFavouredBy, STAT_ORDER, statRows, stockpileRows, XP_SOURCES, xpRows,
} from '../src/ui/sheet';
import { displayDamage, xpSegments } from '../src/ui/util';
import { at, makeTestState, makeTestUnit } from './helpers';

function rowsOf(s: GameState, u: Unit) {
  return statRows(statBreakdown(s, u));
}

describe('attribute rows', () => {
  it('list every stat in order, and base + parts = total = effective stats', () => {
    const s = makeTestState();
    const knight = makeTestUnit(s, 'valen', at(2, 2), {
      items: ['sword', 'shield', 'plate', 'amulet', 'horse'], passives: ['ironskin'],
      buffs: [{ id: 'fortify', turns: 1, armor: 20 }, { id: 'bless', turns: 2, damageMult: 1.2, armor: 10 }],
    });
    const eff = effectiveStats(s, knight);
    const rows = rowsOf(s, knight);
    expect(rows.map((r) => r.key)).toEqual([...STAT_ORDER]);
    for (const r of rows) {
      expect(r.base + r.parts.reduce((t, p) => t + p.value, 0)).toBe(eff[r.key]);
      expect(r.total).toBe(eff[r.key]);
      expect(r.bonus).toBe(r.total - r.base);
    }
    const armor = rows.find((r) => r.key === 'armor')!;
    expect(armor.unit).toBe('%');
    // Shield, plate, Iron Skin, both buffs, then the 70 cap.
    expect(armor.parts.map((p) => p.tone)).toEqual(['item', 'item', 'passive', 'buff', 'buff', 'limit']);
    expect(armor.total).toBe(70);
    const mov = rows.find((r) => r.key === 'mov')!;
    expect(mov.parts.map((p) => [p.tone, p.value])).toEqual([['item', -1], ['mount', 3]]);
    expect(rows.find((r) => r.key === 'maxHp')!.parts.some((p) => p.label === 'Amulet of Vigor' && p.value === 8)).toBe(true);
  });

  it('names level-up gains apart from the caps', () => {
    expect(contributionTone({ source: 'Level 3: +3 Strength', kind: 'other', value: 3, option: 'stat_str' })).toBe('level');
    expect(contributionTone({ source: 'Level-ups (2 × +4)', kind: 'other', value: 8 })).toBe('level');
    expect(contributionTone({ source: 'Armor cap (70)', kind: 'other', value: -5 })).toBe('limit');
    expect(contributionTone({ source: 'House Valen', kind: 'faction', value: 1 })).toBe('faction');
    expect(formatContribution('armor', { source: 'Shield', value: 12 })).toBe('+12% Shield');
    expect(formatContribution('mov', { source: 'Plate Armor', value: -1 })).toBe('−1 Plate Armor');
  });
});

describe('attack lines', () => {
  it('reproduce the damage the panels show from base, ½ stat and the listed multipliers', () => {
    const s = makeTestState();
    const archer = makeTestUnit(s, 'valen', at(3, 3), {
      items: ['bow', 'leather'], efficiency: { ranged: 1.25 }, passives: ['marksman'],
      buffs: [{ id: 'bless', turns: 2, damageMult: 1.2, armor: 10 }, { id: 'powerstrike', turns: 1, damageMult: 1.5 }],
    });
    const mage = makeTestUnit(s, 'thorn', at(5, 5), { items: ['staff', 'robe', 'ring'], efficiency: { magic: 1.25 } });
    for (const u of [archer, mage]) {
      const stats = effectiveStats(s, u);
      const lines = attackLines(s, u, getAttackDefs(u), stats);
      expect(lines.map((l) => l.attack.kind)).toEqual(getAttackDefs(u).map((a) => a.kind));
      for (const l of lines) {
        const prod = l.mults.reduce((m, x) => m * x.value, 1);
        expect(Math.max(1, Math.round((l.base + l.statBonus) * prod))).toBe(l.perStrike);
        const fd = FACTIONS[u.faction];
        const house = (l.attack.kind === 'melee' ? fd.meleeMult : l.attack.kind === 'ranged' ? fd.rangedMult : fd.magicMult) ?? 1;
        expect(l.perStrike).toBe(displayDamage(u, l.attack, stats, house * techDamageMult(s, u.faction)));
      }
    }
    const [bash, bow] = attackLines(s, archer, getAttackDefs(archer), effectiveStats(s, archer));
    // Power Strike charges the melee blow only; Bless boosts both.
    expect(bash.mults.map((m) => m.label)).toContain('Power Strike');
    expect(bow.mults.map((m) => m.label)).not.toContain('Power Strike');
    expect(bow.mults.map((m) => m.label)).toEqual(expect.arrayContaining(['Keen Eye', 'House Valen', 'Blessing']));
    expect(bow.hit).toMatch(/Marksman/);
    const staff = attackLines(s, mage, getAttackDefs(mage), effectiveStats(s, mage)).find((l) => l.attack.kind === 'magic')!;
    expect(staff.mults.map((m) => m.label)).toEqual(expect.arrayContaining(['Arcane Focus', 'Ring of Focus']));
    expect(staff.hit).toMatch(/70%/);
  });

  it('flags situational bonuses without counting them', () => {
    const s = makeTestState();
    const raider = makeTestUnit(s, 'thorn', at(2, 2), { items: ['spear', 'horse'], passives: ['berserker', 'poison', 'vampiric'], hp: 5 });
    const [spear] = attackLines(s, raider, getAttackDefs(raider), effectiveStats(s, raider));
    expect(spear.notes.join(' ')).toMatch(/First strike/);
    expect(spear.notes.join(' ')).toMatch(/mounted/);
    expect(spear.notes.join(' ')).toMatch(/Charge/);
    expect(spear.notes.join(' ')).toMatch(/Berserker.*\(now\)/);
    expect(spear.notes.join(' ')).toMatch(/Venom Blades/);
    expect(spear.notes.join(' ')).toMatch(/Life Drinker/);
  });
});

describe('augments and level history', () => {
  it('sorts skills into actives, building skills, passives and efficiencies', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(2, 2), {
      actives: ['volley', 'masonry'], passives: ['pathfinder'], efficiency: { gathering: 1.25, ranged: 1.5625, mining: 1 },
      learned: [{ level: 3, option: 'eff_ranged' }, { level: 2, option: 'stat_dex' }, { level: 4, option: 'retired_option' }],
    });
    const a = augmentsOf(u);
    expect(a.actives.map((d) => d.id)).toEqual(['volley']);
    expect(a.crafts.map((d) => d.id)).toEqual(['masonry']);
    expect(a.passives.map((p) => p.id)).toEqual(['pathfinder']);
    expect(efficiencyRows(u).map((e) => [e.id, e.pctText])).toEqual([['ranged', '+56%'], ['gathering', '+25%']]);
    expect(augmentCount(a)).toBe(5);
    expect(augmentCount(augmentsOf(makeTestUnit(s, 'valen', at(4, 4))))).toBe(0);
    // Oldest first; an option id that no longer exists still shows.
    expect(levelHistory(u).map((h) => [h.level, h.name])).toEqual([[2, '+3 Dexterity'], [3, 'Keen Eye'], [4, 'retired_option']]);
  });
});

describe('experience', () => {
  it('splits the stacked bar over the seven kinds, in order', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(2, 2), {
      xp: 30, levelXpByCat: { ...zeroXp(), magic: 6, melee: 6, explore: 12, civic: 6 },
    });
    const segs = xpSegments(u, 40);
    expect(segs.map((g) => g.cat)).toEqual(['melee', 'civic', 'explore', 'magic']);
    expect(segs.reduce((t, g) => t + g.frac, 0)).toBeCloseTo(30 / 40);
    expect(segs.find((g) => g.cat === 'explore')!.frac).toBeCloseTo(12 / 40); // 12 of the 30 tallied
    // XP with no tally (should not happen) shows in the unit's own trade, not as melee.
    const archer = makeTestUnit(s, 'valen', at(3, 3), { items: ['bow'], xp: 10 });
    expect(xpSegments(archer, 40)).toEqual([{ cat: 'ranged', frac: 0.25, amount: 10 }]);
  });

  it('gives each kind its level and lifetime share, and marks leadership for leaders only', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(2, 2), {
      level: 2, levelXpByCat: { ...zeroXp(), ranged: 30, explore: 10 }, xpByCat: { ...zeroXp(), ranged: 60, explore: 30, civic: 10 },
    });
    const rows = xpRows(u);
    expect(rows.map((r) => r.cat)).toEqual([...XP_CATEGORIES]);
    const ranged = rows.find((r) => r.cat === 'ranged')!;
    expect(ranged.levelFrac).toBeCloseTo(30 / xpToNext(2));
    expect(ranged.levelShare).toBeCloseTo(0.75);
    expect(ranged.lifeShare).toBeCloseTo(0.6);
    expect(rows.find((r) => r.cat === 'leader')!.leaderOnly).toBe(true);
    expect(xpRows(makeTestUnit(s, 'valen', at(4, 4), { isLeader: true })).find((r) => r.cat === 'leader')!.leaderOnly).toBe(false);
    for (const c of XP_CATEGORIES) expect(XP_SOURCES[c].length).toBeGreaterThan(10);
  });

  it('lists the options each kind favours: every option somewhere, no melee picks for ranged XP', () => {
    for (const o of LEVEL_OPTIONS) expect(XP_CATEGORIES.some((c) => optionsFavouredBy(c).includes(o))).toBe(true);
    const ranged = optionsFavouredBy('ranged').map((o) => o.id);
    expect(ranged).toEqual(expect.arrayContaining(['stat_dex', 'eff_ranged', 'passive_marksman', 'active_volley']));
    for (const melee of ['stat_str', 'eff_attack', 'passive_poison', 'passive_berserker', 'active_powerstrike']) expect(ranged).not.toContain(melee);
    expect(kindSummary(optionsFavouredBy('building'))).toBe('1 attribute · 1 efficiency · 3 active skills');
    expect(kindSummary([])).toBe('');
  });
});

describe('inventory', () => {
  it('lists the stockpile in item order and names the armories', () => {
    const s = makeTestState();
    s.factions.valen.stockpile = { shield: 2, sword: 1, bow: 0 };
    expect(stockpileRows(s, 'valen').map((r) => [r.def.id, r.count])).toEqual([['sword', 1], ['shield', 2]]);
    expect(stockpileRows(s, 'thorn')).toEqual([]);
    expect(armoryNames()).toMatch(/^castle, .* and mage tower$/);
  });
});
