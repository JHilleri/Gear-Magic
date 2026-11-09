import { describe, expect, it } from 'vitest';
import { makeTestState, makeTestUnit, at } from './helpers';
import { grantXp, rollLevelOptions, applyLevelOption, aiChooseLevelOption, canApplyLevelOption, optionEligible, unitRole } from '../src/sim/progression';
import { createUnit, effectiveStats } from '../src/sim/units';
import { LEVEL_OPTIONS, LEVEL_OPTION_BY_ID, MAX_LEVEL, xpToNext } from '../src/data/skills';
import { COMMONER_STATS } from '../src/data/presets';
import { buildingUnlocked } from '../src/sim/research';
import type { GameState, Unit } from '../src/core/types';

function levelUp(s: GameState, u: Unit, cat: Parameters<typeof grantXp>[2] = 'melee'): void {
  grantXp(s, u, cat, xpToNext(u.level) - u.xp);
}

describe('grantXp', () => {
  it('tracks totals per category without leveling below the threshold', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1));
    expect(grantXp(s, u, 'civic', 10)).toEqual([]);
    expect(u.xp).toBe(10);
    expect(u.xpByCat.civic).toBe(10);
    expect(u.levelXpByCat.civic).toBe(10);
    expect(grantXp(s, u, 'melee', 0)).toEqual([]);
    expect(grantXp(s, u, 'melee', -5)).toEqual([]);
    expect(u.xp).toBe(10);
  });

  it('multiplies leader XP by 1.3, carrying fractions so small grants keep the bonus', () => {
    const s = makeTestState();
    const l = makeTestUnit(s, 'valen', at(1, 1), { isLeader: true, level: 2 });
    grantXp(s, l, 'leader', 10);
    expect(l.xp).toBe(13);
    expect(l.xpByCat.leader).toBe(13);
    grantXp(s, l, 'leader', 1);
    expect(l.xp).toBe(14);
    expect(l.xpFrac).toBeCloseTo(0.3);
    // Ten 1-XP grants (exploration, allied kills…) are worth 13, not 10.
    const m = makeTestUnit(s, 'valen', at(2, 1), { isLeader: true, level: 2 });
    for (let i = 0; i < 10; i++) grantXp(s, m, 'explore', 1);
    expect(m.xp).toBe(13);
    expect(m.xpFrac ?? 0).toBeCloseTo(0);
    // Old saves without the field behave as a zero carry.
    const n = makeTestUnit(s, 'valen', at(3, 1), { isLeader: true, level: 2 });
    delete n.xpFrac;
    grantXp(s, n, 'melee', 2);
    expect(n.xp).toBe(2);
    expect(n.xpFrac).toBeCloseTo(0.6);
  });

  it('starts the next level\'s XP tally at level-up, so XP earned while the pick waits counts', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1));
    grantXp(s, u, 'civic', xpToNext(1) + 4);
    expect(u.pendingLevelUps).toBe(1);
    // The overflow opens the new tally; the offer keeps the mix it was rolled from.
    expect(u.levelXpByCat).toEqual({ melee: 0, ranged: 0, building: 0, civic: 4, explore: 0, leader: 0, magic: 0 });
    expect(u.levelUpXp).toEqual([{ melee: 0, ranged: 0, building: 0, civic: xpToNext(1) + 4, explore: 0, leader: 0, magic: 0 }]);
    grantXp(s, u, 'melee', 20); // e.g. defending during the enemy turn before the choice
    applyLevelOption(s, u, u.levelUpOptions[0][0]);
    expect(u.levelXpByCat.melee).toBe(20);
    expect(u.levelXpByCat.civic).toBe(4);
    expect(u.levelUpXp).toBeUndefined();
  });

  it('levels up: +4 max hp, heal 4, queue options, emit unitLeveled (+ log for humans)', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { hp: 10 });
    const ev = grantXp(s, u, 'melee', xpToNext(1) + 3);
    expect(ev[0]).toEqual({ type: 'unitLeveled', unit: u.id, level: 2 });
    expect(ev.some((e) => e.type === 'log')).toBe(true);
    expect(u.level).toBe(2);
    expect(u.xp).toBe(3);
    expect(u.base.maxHp).toBe(COMMONER_STATS.maxHp + 4);
    expect(u.hp).toBe(14);
    expect(u.pendingLevelUps).toBe(1);
    expect(u.levelUpOptions).toHaveLength(1);
    expect(new Set(u.levelUpOptions[0]).size).toBe(3);
    // AI units don't spam the shared log.
    const t = makeTestUnit(s, 'thorn', at(2, 1));
    const ev2 = grantXp(s, t, 'melee', 40);
    expect(ev2.filter((e) => e.type === 'log')).toEqual([]);
    expect(ev2.filter((e) => e.type === 'unitLeveled')).toHaveLength(1);
  });

  it('handles several level-ups from one big grant', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1));
    const total = xpToNext(1) + xpToNext(2) + xpToNext(3) + 1;
    const ev = grantXp(s, u, 'magic', total);
    expect(ev.filter((e) => e.type === 'unitLeveled').map((e) => (e as { level: number }).level)).toEqual([2, 3, 4]);
    expect(u.pendingLevelUps).toBe(3);
    expect(u.levelUpOptions).toHaveLength(3);
    expect(u.xp).toBe(1);
  });

  it('stops at the level cap', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { level: MAX_LEVEL - 1 });
    grantXp(s, u, 'melee', 10_000);
    expect(u.level).toBe(MAX_LEVEL);
    expect(u.xp).toBe(0);
    expect(grantXp(s, u, 'melee', 100)).toEqual([]);
    expect(u.level).toBe(MAX_LEVEL);
    expect(u.xpByCat.melee).toBe(10_100);
  });

  it('ignores dead units', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { hp: 0 });
    expect(grantXp(s, u, 'melee', 100)).toEqual([]);
    expect(u.level).toBe(1);
  });
});

describe('rollLevelOptions', () => {
  it('returns 3 distinct, valid, eligible ids and is deterministic for the RNG state', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1));
    for (let i = 0; i < 200; i++) {
      const o = rollLevelOptions(s, u);
      expect(o).toHaveLength(3);
      expect(new Set(o).size).toBe(3);
      for (const id of o) expect(LEVEL_OPTION_BY_ID[id]).toBeDefined();
    }
    const a = makeTestState();
    const b = makeTestState();
    const ua = makeTestUnit(a, 'valen', at(1, 1));
    const ub = makeTestUnit(b, 'valen', at(1, 1));
    expect(rollLevelOptions(a, ua)).toEqual(rollLevelOptions(b, ub));
    expect(a.rngState).toBe(b.rngState);
  });

  it('excludes owned passives and actives', () => {
    const s = makeTestState();
    const owned = LEVEL_OPTIONS.filter((o) => o.kind === 'passive').map((o) => o.passive!);
    const acts = LEVEL_OPTIONS.filter((o) => o.kind === 'active').map((o) => o.active!);
    const u = makeTestUnit(s, 'valen', at(1, 1), { passives: owned, actives: acts });
    for (let i = 0; i < 100; i++) {
      for (const id of rollLevelOptions(s, u)) {
        const k = LEVEL_OPTION_BY_ID[id].kind;
        expect(k === 'stat' || k === 'efficiency').toBe(true);
      }
    }
  });

  it('biases toward the categories the unit earned XP in', () => {
    const s = makeTestState();
    const civ = makeTestUnit(s, 'valen', at(1, 1));
    civ.levelXpByCat = { melee: 0, ranged: 0, building: 0, civic: 60, explore: 0, leader: 0, magic: 0 };
    const mag = makeTestUnit(s, 'valen', at(2, 1));
    mag.levelXpByCat = { melee: 0, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 60 };
    let civHits = 0, magHits = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      civHits += rollLevelOptions(s, civ).filter((id) => LEVEL_OPTION_BY_ID[id].categories.includes('civic')).length;
      magHits += rollLevelOptions(s, mag).filter((id) => LEVEL_OPTION_BY_ID[id].categories.includes('magic')).length;
    }
    // Uniform draws would land ~0.8 civic / ~0.9 magic options per roll.
    expect(civHits / N).toBeGreaterThan(1.9);
    expect(magHits / N).toBeGreaterThan(1.6);
  });

  it('spreads an offer across kinds and offers at most one wildcard outside the level\'s trades', () => {
    const s = makeTestState();
    const knight = makeTestUnit(s, 'valen', at(1, 1), { items: ['sword', 'shield'] });
    knight.levelXpByCat = { melee: 60, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 };
    const off = (id: string) => !LEVEL_OPTION_BY_ID[id].categories.includes('melee');
    const N = 2000;
    let sameKind = 0, twoWild = 0, oneWild = 0, twoActives = 0, bowOpts = 0;
    for (let i = 0; i < N; i++) {
      const o = rollLevelOptions(s, knight);
      expect(o).toHaveLength(3);
      const kinds = o.map((id) => LEVEL_OPTION_BY_ID[id].kind);
      if (new Set(kinds).size === 1) sameKind++;
      if (kinds.filter((k) => k === 'active').length >= 2) twoActives++;
      const w = o.filter(off).length;
      if (w >= 2) twoWild++;
      if (w === 1) oneWild++;
      bowOpts += o.filter((id) => ['active_volley', 'eff_ranged', 'passive_marksman'].includes(id)).length;
    }
    expect(sameKind / N).toBeLessThan(0.01);
    expect(twoWild).toBe(0);
    expect(oneWild).toBeGreaterThan(0); // the cross-trade wildcard survives (e.g. Firebolt)
    expect(twoActives / N).toBeLessThan(0.03);
    // Bow skills are rarer without a bow (but still possible: the unit may take one up).
    const archer = makeTestUnit(s, 'valen', at(2, 1), { items: ['bow'] });
    archer.levelXpByCat = { melee: 60, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 };
    let archerBow = 0;
    for (let i = 0; i < N; i++) archerBow += rollLevelOptions(s, archer).filter((id) => ['active_volley', 'eff_ranged', 'passive_marksman'].includes(id)).length;
    expect(bowOpts).toBeGreaterThan(0);
    expect(bowOpts).toBeLessThan(archerBow * 0.7);
  });

  it('an archer earning ranged XP is rarely offered melee-only options; a swordsman earning melee XP often is', () => {
    const s = makeTestState();
    const meleeOnly = ['stat_str', 'eff_attack', 'passive_poison', 'passive_berserker', 'active_powerstrike'];
    const archer = makeTestUnit(s, 'valen', at(1, 1), { items: ['bow', 'leather'] });
    archer.levelXpByCat = { melee: 0, ranged: 60, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 };
    const sword = makeTestUnit(s, 'valen', at(2, 1), { items: ['sword', 'shield'] });
    sword.levelXpByCat = { melee: 60, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 };
    const N = 3000;
    let archerMelee = 0, swordMelee = 0, archerRanged = 0;
    for (let seed = 1; seed <= N; seed++) {
      s.rngState = seed * 7919;
      const a = rollLevelOptions(s, archer);
      archerMelee += a.filter((id) => meleeOnly.includes(id)).length;
      archerRanged += a.filter((id) => LEVEL_OPTION_BY_ID[id].categories.includes('ranged')).length;
      swordMelee += rollLevelOptions(s, sword).filter((id) => meleeOnly.includes(id)).length;
    }
    expect(archerMelee / N).toBeLessThan(0.3);
    expect(archerMelee / N).toBeLessThan(0.1);
    expect(swordMelee / N).toBeGreaterThan(0.8);
    expect(archerRanged / N).toBeGreaterThanOrEqual(2); // at most one wildcard per offer
    // The weapon alone also steers: with the same melee XP, an archer meets fewer melee-only options.
    const bowMelee = makeTestUnit(s, 'valen', at(3, 1), { items: ['bow'] });
    bowMelee.levelXpByCat = { ...sword.levelXpByCat };
    let bm = 0, sm = 0;
    for (let i = 0; i < N; i++) {
      bm += rollLevelOptions(s, bowMelee).filter((id) => meleeOnly.includes(id)).length;
      sm += rollLevelOptions(s, sword).filter((id) => meleeOnly.includes(id)).length;
    }
    expect(bm).toBeLessThan(sm * 0.75);
  });

  it('only offers monsters options they can use', () => {
    const s = makeTestState();
    const w = createUnit(s, { faction: 'neutral', pos: at(1, 1), monster: 'wolf' });
    for (let i = 0; i < 200; i++) {
      for (const id of rollLevelOptions(s, w)) {
        const o = LEVEL_OPTION_BY_ID[id];
        expect(optionEligible(w, o)).toBe(true);
        expect(['eff_farming', 'eff_building', 'eff_mining', 'eff_research', 'eff_trade', 'eff_mana', 'eff_gathering', 'eff_ranged', 'eff_magic',
          'passive_harvester', 'passive_scholar', 'passive_marksman', 'active_masonry', 'active_heal', 'active_volley']).not.toContain(id);
      }
    }
  });

  it('returns fewer only when there are fewer eligible options', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1));
    expect(LEVEL_OPTIONS.filter((o) => optionEligible(u, o)).length).toBeGreaterThan(3);
    expect(rollLevelOptions(s, u)).toHaveLength(3);
  });
});

describe('applyLevelOption', () => {
  function pending(s: GameState, ids: string[]): Unit {
    const u = makeTestUnit(s, 'valen', at(1, 1));
    u.level = 2;
    u.pendingLevelUps = 1;
    u.levelUpOptions = [ids];
    u.levelXpByCat = { melee: 20, ranged: 0, building: 0, civic: 5, explore: 3, leader: 0, magic: 0 };
    return u;
  }

  it('applies stats (max hp also heals)', () => {
    const s = makeTestState();
    const u = pending(s, ['stat_hp', 'stat_str', 'stat_dex']);
    u.hp = 10;
    expect(canApplyLevelOption(s, u, 'stat_int')).toMatch(/offered/);
    expect(applyLevelOption(s, u, 'stat_int')).toEqual([]);
    applyLevelOption(s, u, 'stat_hp');
    expect(u.base.maxHp).toBe(COMMONER_STATS.maxHp + 6);
    expect(u.hp).toBe(16);
    expect(u.pendingLevelUps).toBe(0);
    expect(u.levelUpOptions).toEqual([]);
    // The pick leaves the tally alone: it already counts toward the next level.
    expect(u.levelXpByCat).toEqual({ melee: 20, ranged: 0, building: 0, civic: 5, explore: 3, leader: 0, magic: 0 });
    expect(canApplyLevelOption(s, u, 'stat_hp')).toMatch(/pending/);
  });

  it('multiplies efficiencies by 1.25 each time', () => {
    const s = makeTestState();
    const u = pending(s, ['eff_farming', 'stat_str', 'stat_dex']);
    applyLevelOption(s, u, 'eff_farming');
    expect(u.efficiency.farming).toBe(1.25);
    u.pendingLevelUps = 1;
    u.levelUpOptions = [['eff_farming', 'stat_str', 'stat_dex']];
    applyLevelOption(s, u, 'eff_farming');
    expect(u.efficiency.farming).toBeCloseTo(1.5625, 6);
  });

  it('grants passives and actives; masonry/devotion unlock buildings permanently', () => {
    const s = makeTestState();
    const u = pending(s, ['passive_ironskin', 'active_masonry', 'stat_dex']);
    applyLevelOption(s, u, 'passive_ironskin');
    expect(u.passives).toContain('ironskin');
    expect(effectiveStats(s, u).armor).toBe(8);
    expect(buildingUnlocked(s, 'valen', 'watchtower', u)).toBe(false);
    u.pendingLevelUps = 1;
    u.levelUpOptions = [['active_masonry', 'active_devotion', 'stat_dex']];
    applyLevelOption(s, u, 'active_masonry');
    expect(u.actives).toContain('masonry');
    expect(buildingUnlocked(s, 'valen', 'watchtower', u)).toBe(true);
    expect(buildingUnlocked(s, 'valen', 'shrine', u)).toBe(false);
  });

  it('consumes queued level-ups in order and refreshes stale later offers', () => {
    const s = makeTestState();
    const u = pending(s, ['passive_poison', 'stat_str', 'stat_dex']);
    u.pendingLevelUps = 2;
    u.levelUpOptions = [['passive_poison', 'stat_str', 'stat_dex'], ['passive_poison', 'stat_hp', 'stat_mov']];
    applyLevelOption(s, u, 'passive_poison');
    expect(u.pendingLevelUps).toBe(1);
    expect(u.levelUpOptions).toHaveLength(1);
    const next = u.levelUpOptions[0];
    expect(next).toHaveLength(3);
    expect(next).not.toContain('passive_poison');
    expect(next).toContain('stat_hp');
    expect(new Set(next).size).toBe(3);
    // levelXpByCat is kept until the queue empties.
    expect(u.levelXpByCat.melee).toBe(20);
  });

  it('a vision pick refreshes the fog immediately', () => {
    const s = makeTestState(30, 30);
    for (const f of Object.values(s.factions)) { f.visible.fill(0); f.explored.fill(0); }
    const u = pending(s, ['stat_vis', 'stat_str', 'stat_dex']);
    u.pos = at(15, 15);
    applyLevelOption(s, u, 'stat_vis');
    const seen = s.factions.valen.visible.filter((v) => v === 1).length;
    expect(seen).toBe(1 + 3 * (COMMONER_STATS.vis + 1) * (COMMONER_STATS.vis + 2));
  });
});

describe('aiChooseLevelOption', () => {
  it('picks by role', () => {
    const s = makeTestState();
    const ids = ['eff_building', 'stat_str', 'stat_dex'];
    const builder = makeTestUnit(s, 'thorn', at(1, 1), { items: ['tools'] });
    builder.pendingLevelUps = 1; builder.levelUpOptions = [ids];
    expect(unitRole(builder)).toBe('builder');
    expect(aiChooseLevelOption(s, builder)).toBe('eff_building');

    const fighter = makeTestUnit(s, 'thorn', at(2, 1), { items: ['axe'] });
    fighter.pendingLevelUps = 1; fighter.levelUpOptions = [ids];
    expect(unitRole(fighter)).toBe('fighter');
    expect(aiChooseLevelOption(s, fighter)).toBe('stat_str');

    const archer = makeTestUnit(s, 'thorn', at(3, 1), { items: ['bow'] });
    archer.pendingLevelUps = 1; archer.levelUpOptions = [ids];
    expect(unitRole(archer)).toBe('archer');
    expect(aiChooseLevelOption(s, archer)).toBe('stat_dex');

    const mage = makeTestUnit(s, 'thorn', at(4, 1), { items: ['wand'] });
    mage.pendingLevelUps = 1; mage.levelUpOptions = [['stat_str', 'eff_magic', 'stat_hp']];
    expect(unitRole(mage)).toBe('mage');
    expect(aiChooseLevelOption(s, mage)).toBe('eff_magic');

    const leader = makeTestUnit(s, 'thorn', at(5, 1), { isLeader: true, items: ['sword'] });
    leader.pendingLevelUps = 1; leader.levelUpOptions = [['stat_dex', 'passive_leadership', 'eff_farming']];
    expect(unitRole(leader)).toBe('leader');
    expect(aiChooseLevelOption(s, leader)).toBe('passive_leadership');
  });

  it('takes its first combat active over a primary stat', () => {
    const s = makeTestState();
    const archer = makeTestUnit(s, 'thorn', at(3, 1), { items: ['bow'] });
    archer.pendingLevelUps = 1; archer.levelUpOptions = [['stat_dex', 'active_volley', 'stat_hp']];
    expect(aiChooseLevelOption(s, archer)).toBe('active_volley');
    // Once it has one, the stat wins again; building unlocks do not count as combat actives.
    archer.actives = ['volley'];
    archer.levelUpOptions = [['stat_dex', 'active_fortify', 'stat_hp']];
    expect(aiChooseLevelOption(s, archer)).toBe('stat_dex');
    const builder = makeTestUnit(s, 'thorn', at(4, 1), { items: ['axe'], actives: ['masonry'] });
    builder.pendingLevelUps = 1; builder.levelUpOptions = [['stat_str', 'active_powerstrike', 'stat_hp']];
    expect(aiChooseLevelOption(s, builder)).toBe('active_powerstrike');
  });

  it('always returns one of the offered ids (or empty when nothing is pending)', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'thorn', at(1, 1));
    expect(aiChooseLevelOption(s, u)).toBe('');
    for (let i = 0; i < 50; i++) {
      u.levelUpOptions = [rollLevelOptions(s, u)];
      u.pendingLevelUps = 1;
      expect(u.levelUpOptions[0]).toContain(aiChooseLevelOption(s, u));
    }
  });
});
