// Augment ranks (DESIGN §4.8): every passive and active skill grows with each further learning.
import { describe, expect, it } from 'vitest';
import type { Hex } from '../src/core/types';
import { at, makeTestState, makeTestUnit } from './helpers';
import { augmentRank, augmentText, isUpgradable, rankedName } from '../src/data/ranks';
import { ACTIVES, PASSIVES } from '../src/data/skills';
import { attackProfile, forecastCombat, poisonOn, reactionsPerTurn, resolveCombat } from '../src/sim/combat';
import { effectiveStats } from '../src/sim/units';
import { unitIncome } from '../src/sim/economy';
import { startTurn, unitTurnUpkeep } from '../src/sim/turn';
import { applyAction, validateAction } from '../src/sim/actions';
import { skillRange, volleyProfile } from '../src/sim/skills';
import { migrateAugmentRanks } from '../src/sim/state';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });

describe('augment ranks', () => {
  it('rank 1 is the plain description; names carry a numeral from rank 2', () => {
    for (const [id, d] of Object.entries(PASSIVES)) expect(augmentText(id as keyof typeof PASSIVES, 1)).toBe(d.description);
    for (const [id, d] of Object.entries(ACTIVES)) expect(augmentText(id as keyof typeof ACTIVES, 1)).toBe(d.description);
    expect(augmentText('firebolt', 2)).toMatch(/24 damage/);
    expect(augmentText('reflexes', 2)).toMatch(/3 times per turn/);
    expect(rankedName('Firebolt', 1)).toBe('Firebolt');
    expect(rankedName('Firebolt', 4)).toBe('Firebolt IV');
    expect(isUpgradable('masonry')).toBe(false);
    expect(isUpgradable('leadership')).toBe(true);
  });

  it('augmentRank: 0 without the augment, 1 when learned once, the stored rank after', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { passives: ['ironskin'], actives: ['blink'], ranks: { blink: 3 } });
    expect(augmentRank(u, 'regeneration')).toBe(0);
    expect(augmentRank(u, 'ironskin')).toBe(1);
    expect(augmentRank(u, 'blink')).toBe(3);
  });

  it('stat passives: Iron Skin block, Skirmisher and Pathfinder movement', () => {
    const s = makeTestState();
    const base = effectiveStats(s, makeTestUnit(s, 'valen', at(1, 1)));
    const u = makeTestUnit(s, 'valen', at(2, 2), { passives: ['ironskin', 'skirmisher', 'pathfinder'], ranks: { ironskin: 3, skirmisher: 3, pathfinder: 2 } });
    const st = effectiveStats(s, u);
    expect(st.block).toBe(base.block + 3); // 1 a rank × 3
    expect(st.mov).toBe(base.mov + 2 + 1); // Skirmisher III +2, Pathfinder II +1
  });

  it('Regeneration heals 2 per rank; yield passives give +1 per rank', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { passives: ['regeneration', 'harvester', 'scholar'], ranks: { regeneration: 2, harvester: 3 }, hp: 5 });
    unitTurnUpkeep(s, u);
    expect(u.hp).toBe(9); // 5 + 2 × 2
    expect(unitIncome(s, u)).toMatchObject({ food: 3, research: 1 });
  });

  it('Leadership, Berserker and Marksman grow with rank', () => {
    const s = makeTestState();
    const a = makeTestUnit(s, 'valen', at(5, 5), { items: ['sword'], passives: ['berserker'], ranks: { berserker: 2 } });
    makeTestUnit(s, 'valen', off(a.pos, 0, -1), { passives: ['leadership'], ranks: { leadership: 2 } });
    makeTestUnit(s, 'valen', off(a.pos, -1, 1), { passives: ['leadership'] }); // the strongest aura applies, not both
    const d = makeTestUnit(s, 'thorn', off(a.pos, 1), { hp: 100 });
    a.hp = 10; // below half: Berserker
    const p = attackProfile(s, a, d, 'melee')!;
    expect(p.mods?.find((m) => m.id === 'leadership')?.mult).toBeCloseTo(1.3, 9);
    expect(p.mods?.find((m) => m.id === 'berserker')?.mult).toBeCloseTo(1.5, 9);
    const archer = makeTestUnit(s, 'valen', at(1, 8), { items: ['bow'], passives: ['marksman'], ranks: { marksman: 3 } });
    const far = makeTestUnit(s, 'thorn', off(archer.pos, 2));
    s.tiles[far.pos.r * s.width + (far.pos.q + (far.pos.r - (far.pos.r & 1)) / 2)].terrain = 'mountain'; // 60% defense
    expect(attackProfile(s, archer, far, 'ranged')!.hitChance).toBeCloseTo(0.7, 9); // at least 60% + 2 × 5%
  });

  it('Life Drinker drains more, Venom Blades poisons harder (and a stronger venom replaces a weaker one)', () => {
    const s = makeTestState();
    const a = makeTestUnit(s, 'valen', at(5, 5), { items: ['sword'], passives: ['vampiric', 'poison'], ranks: { vampiric: 3, poison: 2 }, hp: 10 });
    const d = makeTestUnit(s, 'thorn', off(a.pos, 1), { hp: 200, base: { maxHp: 200, str: 0, dex: 0, int: 0, armor: 0, block: 0, mov: 5, vis: 4 } });
    const p = attackProfile(s, a, d, 'melee')!;
    expect(p.mods?.find((m) => m.id === 'vampiric')?.label).toMatch(/50%/);
    expect(p.mods?.find((m) => m.id === 'poison')?.label).toMatch(/8\/turn/);
    s.rngState = 7;
    for (let i = 0; i < 5 && !d.poisoned; i++) { a.acted = false; resolveCombat(s, a, d, 'melee'); }
    expect(d.poisoned).toBe(true);
    expect(poisonOn(d)).toBe(8);
    // A weaker venom does not replace it.
    const weak = makeTestUnit(s, 'valen', off(d.pos, 1), { items: ['sword'], passives: ['poison'] });
    for (let i = 0; i < 5; i++) { weak.acted = false; resolveCombat(s, weak, d, 'melee'); }
    expect(poisonOn(d)).toBe(8);
    const before = d.hp;
    unitTurnUpkeep(s, d);
    expect(before - d.hp).toBe(8);
  });

  it('Combat Reflexes: one more riposte per rank', () => {
    const s = makeTestState();
    expect(reactionsPerTurn(makeTestUnit(s, 'valen', at(1, 1)))).toBe(1);
    expect(reactionsPerTurn(makeTestUnit(s, 'valen', at(2, 2), { passives: ['reflexes'] }))).toBe(2);
    expect(reactionsPerTurn(makeTestUnit(s, 'valen', at(3, 3), { passives: ['reflexes'], ranks: { reflexes: 4 } }))).toBe(5);
    // The forecast agrees: a rank-2 defender still answers a third attacker.
    const def = makeTestUnit(s, 'thorn', at(7, 5), { items: ['sword'], passives: ['reflexes'], ranks: { reflexes: 2 }, hp: 200 });
    def.reacted = 2;
    const att = makeTestUnit(s, 'valen', off(def.pos, -1), { items: ['sword'] });
    expect(forecastCombat(s, att, def, 'melee')!.defender).not.toBeNull();
    def.reacted = 3;
    expect(forecastCombat(s, att, def, 'melee')!.defenderSpent).toBe(true);
  });

  it('Inspiring teaches 3 XP per rank', () => {
    const s = makeTestState();
    const mentor = makeTestUnit(s, 'valen', at(4, 4), { passives: ['inspiring'], ranks: { inspiring: 3 } });
    const pupil = makeTestUnit(s, 'valen', off(mentor.pos, 1));
    startTurn(s, 'valen');
    expect(pupil.xp).toBe(9); // rank 3
  });

  it('active skills: Power Strike, Fortify, Rally, Mend, Firebolt, Volley and Blink by rank', () => {
    const s = makeTestState(16, 12);
    const c = at(6, 6);
    const u = makeTestUnit(s, 'valen', c, {
      items: ['sword'], actives: ['powerstrike', 'fortify', 'rally', 'heal', 'firebolt', 'blink'],
      ranks: { powerstrike: 2, fortify: 3, rally: 2, heal: 2, firebolt: 2, blink: 3 },
    });
    applyAction(s, { type: 'skill', unit: u.id, skill: 'powerstrike' });
    expect(u.buffs.find((b) => b.id === 'powerstrike')?.damageMult).toBeCloseTo(1.3, 9); // +15% a rank
    // Rally: +3 movement at rank 2.
    const ally = makeTestUnit(s, 'valen', off(c, 1));
    const mp = ally.mp;
    applyAction(s, { type: 'skill', unit: u.id, skill: 'rally' });
    expect(ally.mp).toBe(mp + 3);
    // Mend heals 20 at rank 2.
    ally.hp = 5;
    applyAction(s, { type: 'skill', unit: u.id, skill: 'heal', target: ally.pos });
    expect(ally.hp).toBe(25);
    // Firebolt 24 at rank 2 (on a fresh unit, the healer has acted).
    const mage = makeTestUnit(s, 'valen', at(2, 2), { actives: ['firebolt'], ranks: { firebolt: 2 } });
    const foe = makeTestUnit(s, 'thorn', off(mage.pos, 2), { hp: 40 });
    applyAction(s, { type: 'skill', unit: mage.id, skill: 'firebolt', target: foe.pos });
    expect(foe.hp).toBe(16);
    // Fortify III: +22.5% armor (7.5% a rank), no block.
    const wall = makeTestUnit(s, 'valen', at(12, 2), { actives: ['fortify'], ranks: { fortify: 3 } });
    const blockBefore = effectiveStats(s, wall).block;
    applyAction(s, { type: 'skill', unit: wall.id, skill: 'fortify' });
    expect(wall.buffs.find((b) => b.id === 'fortify')).toEqual({ id: 'fortify', turns: 1, armor: 22.5 });
    expect(effectiveStats(s, wall).block).toBe(blockBefore);
    // Blink III reaches 5 hexes.
    const jumper = makeTestUnit(s, 'valen', at(8, 9), { actives: ['blink'], ranks: { blink: 3 } });
    expect(skillRange(jumper, 'blink')).toBe(5);
    expect(validateAction(s, { type: 'skill', unit: jumper.id, skill: 'blink', target: off(jumper.pos, 5) })).toBeNull();
    expect(validateAction(s, { type: 'skill', unit: jumper.id, skill: 'blink', target: off(jumper.pos, 6) })).toMatch(/range/);
    // Volley II: 70% per arrow (before block and armor).
    const archer = makeTestUnit(s, 'thorn', at(3, 10), { items: ['bow'], actives: ['volley'], ranks: { volley: 2 } });
    const target = makeTestUnit(s, 'valen', off(archer.pos, 2));
    expect(volleyProfile(s, archer, target)!.damage).toBe(Math.max(1, Math.round(8 * 0.7))); // 6 + ½ of 4 dex = 8
  });

  it('saves that stored a repeated augment get it folded into a rank', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { passives: ['reflexes', 'reflexes', 'ironskin', 'reflexes'], actives: ['heal'] });
    u.ranks = { heal: 2, regeneration: 4, ironskin: 1 } as typeof u.ranks; // stray entries are dropped
    migrateAugmentRanks(u);
    expect(u.passives).toEqual(['reflexes', 'ironskin']);
    expect(u.ranks).toEqual({ reflexes: 3, heal: 2 });
    expect(reactionsPerTurn(u)).toBe(4);
  });
});
