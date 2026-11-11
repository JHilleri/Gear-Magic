import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState, Hex, Unit } from '../src/core/types';
import { hexAdd, tileIndex } from '../src/core/hex';
import {
  applyDamage, attackProfile, availableAttackKinds, canAttack, COMBAT_XP, FLANK_MULT, flankingAlly, forecastCombat, killUnit, oppositeHex,
  reachingRetaliation, reactionsLeft, resolveCombat, retaliationProfile, tileDefense,
} from '../src/sim/combat';
import { COMMONER_STATS } from '../src/data/presets';
import { startTurn } from '../src/sim/turn';
import { runNeutralTurn } from '../src/sim/neutral';
import { at, makeTestBuilding, makeTestState, makeTestUnit, setTerrain } from './helpers';

const E: Hex = { q: 1, r: 0 };
const right = (h: Hex, n = 1): Hex => ({ q: h.q + n, r: h.r });

function duel(opts: { a?: Partial<Unit> & { items?: any[] }; d?: Partial<Unit> & { items?: any[] }; dist?: number } = {}) {
  const s = makeTestState(12, 10);
  const pa = at(4, 4);
  const a = makeTestUnit(s, 'valen', pa, opts.a ?? {});
  const d = makeTestUnit(s, 'thorn', right(pa, opts.dist ?? 1), opts.d ?? {});
  return { s, a, d };
}

const combatEv = (evs: GameEvent[]) => evs.find((e) => e.type === 'combat') as Extract<GameEvent, { type: 'combat' }>;

describe('tileDefense', () => {
  it('uses terrain defense and clamps', () => {
    const { s, a } = duel();
    expect(tileDefense(s, a, a.pos)).toBe(40);
    setTerrain(s, a.pos, 'swamp');
    expect(tileDefense(s, a, a.pos)).toBe(20);
    setTerrain(s, a.pos, 'mountain');
    expect(tileDefense(s, a, a.pos)).toBe(60);
  });

  it('adds own fortifications by level, not enemy ones', () => {
    const { s, a, d } = duel();
    makeTestBuilding(s, 'castle', 'valen', a.pos);
    expect(tileDefense(s, a, a.pos)).toBe(65);
    // An enemy standing on our castle gets no bonus.
    expect(tileDefense(s, d, a.pos)).toBe(40);
    const w = makeTestBuilding(s, 'wall', 'thorn', d.pos, { level: 3 });
    setTerrain(s, d.pos, 'mountain');
    expect(tileDefense(s, d, d.pos)).toBe(90); // 60 + 40 clamped
    w.buildLeft = 2; // construction site: no bonus
    expect(tileDefense(s, d, d.pos)).toBe(60);
  });

  it('shield +5, mounts −10 in rough terrain, floor 10', () => {
    const { s, a } = duel({ a: { items: ['sword', 'shield', 'horse'] } });
    expect(tileDefense(s, a, a.pos)).toBe(45);
    setTerrain(s, a.pos, 'forest');
    expect(tileDefense(s, a, a.pos)).toBe(45); // 50 + 5 − 10
    setTerrain(s, a.pos, 'swamp');
    expect(tileDefense(s, a, a.pos)).toBe(15);
    a.equipment.off = null;
    expect(tileDefense(s, a, a.pos)).toBe(10);
  });
});

describe('attackProfile', () => {
  it('base + floor(stat/2), armor, hit chance from defender tile', () => {
    const { s, a, d } = duel({ a: { items: ['sword'] }, d: { items: ['plate'] } });
    const p = attackProfile(s, a, d, 'melee')!;
    expect(p.damage).toBe(5); // (7 + 2 − plate's 3 block) × (1 − 25%) = 4.5 → 5
    expect(p.strikes).toBe(3);
    expect(p.hitChance).toBeCloseTo(0.6);
    setTerrain(s, d.pos, 'forest');
    expect(attackProfile(s, a, d, 'melee')!.hitChance).toBeCloseTo(0.5);
  });

  it('applies faction melee bonus and rounding (min 1)', () => {
    const { s, a, d } = duel();
    // Thorn fists: (3 + 2) × 1.1 = 5.5 → 6
    expect(attackProfile(s, d, a, 'melee')!.damage).toBe(6);
    a.base.armor = 70;
    a.equipment.body = 'plate'; // 95% armor clamps at 70 in effectiveStats; plate adds 3 block
    expect(attackProfile(s, d, a, 'melee')!.damage).toBe(1); // (5.5 − 3) × 0.3 = 0.75 → 1
    a.base.block = 10; // block swallows the whole strike, but a hit always deals at least 1
    expect(attackProfile(s, d, a, 'melee')!.damage).toBe(1);
  });

  it('magic always 70% and ring boosts magic', () => {
    const { s, a, d } = duel({ a: { items: ['staff', 'ring'] }, dist: 2 });
    setTerrain(s, d.pos, 'mountain');
    const p = attackProfile(s, a, d, 'magic')!;
    expect(p.hitChance).toBeCloseTo(0.7);
    // int 3 + staff 2 + ring 2 = 7 → 8 + 3 = 11 × 1.15 = 12.65 → 13
    expect(p.damage).toBe(13);
  });

  it('House Valen archers deal +10% ranged damage (rangedMult), others do not', () => {
    const s = makeTestState(14, 10);
    const target = makeTestUnit(s, 'neutral', at(6, 5), { base: { maxHp: 200, str: 0, dex: 0, int: 0, armor: 0, block: 0, mov: 5, vis: 4 }, hp: 200 });
    const v = makeTestUnit(s, 'valen', at(4, 5), { items: ['bow'], base: { maxHp: 22, str: 4, dex: 10, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } });
    const t = makeTestUnit(s, 'thorn', at(8, 5), { items: ['bow'], base: { maxHp: 22, str: 4, dex: 10, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } });
    const base = 6 + 5; // bow 6 + ⌊dex/2⌋
    expect(attackProfile(s, t, target, 'ranged')!.damage).toBe(base);
    expect(attackProfile(s, v, target, 'ranged')!.damage).toBe(Math.round(base * 1.1));
    // Melee is untouched for Valen.
    expect(attackProfile(s, v, target, 'melee')!.damage).toBe(attackProfile(s, t, target, 'melee')!.damage);
  });

  it('marksman floors ranged hit chance at 60%', () => {
    const { s, a, d } = duel({ a: { items: ['bow'] }, dist: 2 });
    setTerrain(s, d.pos, 'mountain');
    expect(attackProfile(s, a, d, 'ranged')!.hitChance).toBeCloseTo(0.4);
    a.passives.push('marksman');
    expect(attackProfile(s, a, d, 'ranged')!.hitChance).toBeCloseTo(0.6);
  });

  it('bless, powerstrike, leadership, berserker, efficiency, tactics', () => {
    const { s, a, d } = duel({ a: { items: ['sword'] } });
    const base = 9;
    a.buffs.push({ id: 'bless', turns: 2, damageMult: 1.2, armor: 10 });
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(base * 1.2));
    a.buffs.push({ id: 'powerstrike', turns: 1, damageMult: 1.5 });
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(base * 1.2 * 1.5));
    a.buffs = [];
    makeTestUnit(s, 'valen', hexAdd(a.pos, { q: 0, r: -1 }), { passives: ['leadership'] });
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(base * 1.15));
    a.passives.push('berserker');
    a.hp = 10; // below half of 30
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(base * 1.15 * 1.25));
    a.hp = 22;
    a.efficiency.attack = 1.25;
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(base * 1.15 * 1.25));
    s.factions.valen.techs.push('tactics');
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(base * 1.15 * 1.25 * 1.1));
  });

  it('charge from flat terrain, spear bonus against riders', () => {
    const { s, a, d } = duel({ a: { items: ['sword', 'horse'] }, d: { items: ['spear'] } });
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(Math.round(9 * 1.25));
    setTerrain(s, a.pos, 'hills');
    expect(attackProfile(s, a, d, 'melee')!.damage).toBe(9);
    // Spear 6 + 2 = 8 × thorn 1.1 × vs mounted 1.5 = 13.2 → 13
    expect(attackProfile(s, d, a, 'melee')!.damage).toBe(13);
  });
});

describe('attack legality and retaliation', () => {
  it('ranges and kinds', () => {
    const { s, a, d } = duel({ a: { items: ['bow'] }, dist: 2 });
    expect(availableAttackKinds(s, a, d)).toEqual(['ranged']);
    expect(canAttack(s, a, d, 'melee')).toMatch(/range/);
    expect(canAttack(s, a, d, 'ranged')).toBeNull();
    d.pos = right(a.pos, 3);
    expect(canAttack(s, a, d, 'ranged')).toMatch(/range/);
    d.pos = right(a.pos, 1);
    expect(availableAttackKinds(s, a, d).sort()).toEqual(['melee', 'ranged']);
    a.acted = true;
    expect(canAttack(s, a, d, 'ranged')).toMatch(/acted/);
  });

  it('cannot attack own units', () => {
    const s = makeTestState();
    const a = makeTestUnit(s, 'valen', at(3, 3));
    const b = makeTestUnit(s, 'valen', right(at(3, 3)));
    expect(canAttack(s, a, b, 'melee')).toMatch(/enemy/);
  });

  it('ranged attack at range 2 gets no melee retaliation; melee vs archer gets bow bash', () => {
    const { s, a, d } = duel({ a: { items: ['bow'] }, d: { items: ['sword'] }, dist: 2 });
    expect(forecastCombat(s, a, d, 'ranged')!.defender).toBeNull();
    // The forecast is a what-if (no range check); the bow cannot answer a sword from 2 hexes.
    expect(forecastCombat(s, d, a, 'melee')!.defender).toBeNull();
    d.pos = right(a.pos);
    const f2 = forecastCombat(s, d, a, 'melee')!;
    expect(f2.defender?.name).toBe('Bow Bash');
    expect(f2.defender?.strikes).toBe(1);
  });

  it('archers duel archers, mages answer archers', () => {
    const { s, a, d } = duel({ a: { items: ['bow'] }, d: { items: ['wand'] }, dist: 2 });
    const fc = forecastCombat(s, a, d, 'ranged')!;
    expect(fc.defender?.kind).toBe('magic');
  });
});

describe('forecastCombat', () => {
  it('exact distribution for a simple exchange', () => {
    const { s, a, d } = duel({ a: { items: ['sword'] }, d: { hp: 22 } });
    const fc = forecastCombat(s, a, d, 'melee')!;
    // 9 × 3 at 60% vs a wounded defender (22 of 30 hp): dies only to 3 hits.
    expect(fc.defenderKillChance).toBeCloseTo(0.216, 10);
    expect(fc.attackerKillChance).toBe(0);
    expect(fc.defenderHpDist[13]).toBeCloseTo(3 * 0.6 * 0.4 * 0.4, 10);
    expect(fc.expectedDamageToDefender).toBeCloseTo(22 - (22 * 0.064 + 13 * 0.288 + 4 * 0.432), 10);
    // Thorn fists 6 × 2 at 60%: 0.6 × 6 × 2 = 7.2 expected.
    expect(fc.expectedDamageToAttacker).toBeCloseTo(7.2, 10);
    const sum = (x: number[]) => x.reduce((t, p) => t + p, 0);
    expect(sum(fc.attackerHpDist)).toBeCloseTo(1, 12);
    expect(sum(fc.defenderHpDist)).toBeCloseTo(1, 12);
  });

  it('does not mutate state or consume RNG', () => {
    const { s, a, d } = duel({ a: { items: ['axe'], passives: ['vampiric'] } });
    const before = JSON.stringify(s);
    forecastCombat(s, a, d, 'melee');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('firststrike defender strikes first and can kill before the attacker swings', () => {
    const { s, a, d } = duel({ a: { items: ['sword'], hp: 5 }, d: { items: ['spear'] } });
    setTerrain(s, a.pos, 'swamp'); // attacker easy to hit (80%)
    const fc = forecastCombat(s, a, d, 'melee')!;
    // Spearman kills on its first strike 80% of the time: the attacker never lands a blow then.
    expect(fc.attackerKillChance).toBeGreaterThanOrEqual(0.8 - 1e-9);
    const evs = resolveCombat(s, a, d, 'melee');
    expect(combatEv(evs).strikes[0].by).toBe('defender');
  });

  it('matches the empirical distribution of resolveCombat (statistical)', () => {
    // A rich exchange: life-drinking axe vs a first-striking spear in a forest, both can die.
    // Axe (10 + 2 − tunic's 1 block) × 95% = 10.45 → 10: two hits fell the 20-hp spearman.
    // Spear (6 + 2) × 1.1 = 8.8 − leather's 2 block = 6.8 × 90% = 6.12 → 6: three hits kill
    // the 17-hp axeman unless a drain (3) tops it up first.
    const base = makeTestState(10, 8);
    const pa = at(4, 4);
    const a = makeTestUnit(base, 'valen', pa, { items: ['axe', 'leather'], passives: ['vampiric', 'poison'], hp: 17 });
    const d = makeTestUnit(base, 'thorn', right(pa), { items: ['spear', 'tunic'], hp: 20 });
    setTerrain(base, d.pos, 'forest');
    const fc = forecastCombat(base, a, d, 'melee')!;
    const N = 20000;
    const ah = new Array(fc.attackerHpDist.length).fill(0);
    const dh = new Array(fc.defenderHpDist.length).fill(0);
    for (let i = 0; i < N; i++) {
      const s = structuredClone(base) as GameState;
      s.rngState = (i * 2654435761 + 977) | 0;
      const ev = combatEv(resolveCombat(s, s.units[String(a.id)], s.units[String(d.id)], 'melee'));
      ah[ev.attackerHp]++;
      dh[ev.defenderHp]++;
    }
    const check = (emp: number[], exp: number[]) => {
      for (let hp = 0; hp < exp.length; hp++) {
        const p = exp[hp];
        const q = emp[hp] / N;
        const tol = 5 * Math.sqrt(Math.max(p * (1 - p), 1e-6) / N) + 0.002;
        expect(Math.abs(q - p), `hp ${hp}: empirical ${q} vs forecast ${p}`).toBeLessThan(tol);
      }
    };
    check(ah, fc.attackerHpDist);
    check(dh, fc.defenderHpDist);
    // The forecast must actually be interesting (both sides can die, drain happens).
    expect(fc.attackerKillChance).toBeGreaterThan(0.01);
    expect(fc.defenderKillChance).toBeGreaterThan(0.01);
    expect(fc.attackerHpDist.slice(18).some((p) => p > 0)).toBe(true); // healed above 17
  });
});

describe('resolveCombat', () => {
  it('alternates strikes, applies damage, sets acted/mp, consumes powerstrike', () => {
    const { s, a, d } = duel({ a: { items: ['sword'], buffs: [{ id: 'powerstrike', turns: 1, damageMult: 1.5 }] } });
    const evs = resolveCombat(s, a, d, 'melee');
    const ev = combatEv(evs);
    expect(ev.strikes.map((x) => x.by).slice(0, 4)).toEqual(['attacker', 'defender', 'attacker', 'defender']);
    for (const st of ev.strikes) if (st.hit && st.by === 'attacker') expect(st.damage).toBe(Math.min(14, st.damage));
    expect(a.mp).toBe(0);
    expect(a.acted).toBe(true);
    expect(a.buffs.find((b) => b.id === 'powerstrike')).toBeUndefined();
    expect(ev.attackerHp).toBe(a.hp);
  });

  it('grants XP = 2 (COMBAT_XP) + strikes landed, in the category of the attack kind used', () => {
    const tough = { hp: 100, base: { maxHp: 100, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } };
    const { s, a, d } = duel({ a: { items: ['sword'] }, d: tough });
    const ev = combatEv(resolveCombat(s, a, d, 'melee'));
    const aHits = ev.strikes.filter((x) => x.by === 'attacker' && x.hit).length;
    const dHits = ev.strikes.filter((x) => x.by === 'defender' && x.hit).length;
    expect(COMBAT_XP).toBe(2); // the rule's number (DESIGN §4.5), pinned once
    expect(a.xpByCat.melee).toBe(COMBAT_XP + aHits);
    expect(d.xpByCat.melee).toBe(COMBAT_XP + dHits);

    const m = duel({ a: { items: ['wand'] }, dist: 2, d: tough });
    const mev = combatEv(resolveCombat(m.s, m.a, m.d, 'magic'));
    expect(m.a.xpByCat.magic).toBe(COMBAT_XP + mev.strikes.filter((x) => x.hit).length);
    expect(m.d.xpByCat.melee).toBe(COMBAT_XP); // could not retaliate: learns in its own (fists) trade

    // A bow volley teaches ranged XP to the archer and to an archer shooting back.
    const r = duel({ a: { items: ['bow'] }, dist: 2, d: { ...tough, items: ['bow'] } });
    const rev = combatEv(resolveCombat(r.s, r.a, r.d, 'ranged'));
    expect(r.a.xpByCat.ranged).toBe(COMBAT_XP + rev.strikes.filter((x) => x.by === 'attacker' && x.hit).length);
    expect(r.d.xpByCat.ranged).toBe(COMBAT_XP + rev.strikes.filter((x) => x.by === 'defender' && x.hit).length);
    expect(r.a.xpByCat.melee + r.d.xpByCat.melee).toBe(0);
    // An archer hit in melee answers with its bow bash: melee XP.
    const b = duel({ a: { items: ['axe'] }, d: { ...tough, items: ['bow'] } });
    const bev = combatEv(resolveCombat(b.s, b.a, b.d, 'melee'));
    expect(b.d.xpByCat.melee).toBe(COMBAT_XP + bev.strikes.filter((x) => x.by === 'defender' && x.hit).length);
    expect(b.d.xpByCat.ranged).toBe(0);
  });

  it('poison and vampiric', () => {
    const { s, a, d } = duel({ a: { items: ['axe'], passives: ['poison', 'vampiric'], hp: 5 }, d: { hp: 100, base: { maxHp: 100, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 } } });
    setTerrain(s, d.pos, 'swamp');
    let hitSeen = false;
    for (let i = 0; i < 20 && !hitSeen; i++) {
      s.rngState = 1000 + i;
      a.acted = false; a.hp = 5; d.hp = 100; d.poisoned = false;
      const ev = combatEv(resolveCombat(s, a, d, 'melee'));
      const hit = ev.strikes.find((x) => x.by === 'attacker' && x.hit);
      if (hit) {
        hitSeen = true;
        expect(d.poisoned).toBe(true);
        expect(ev.strikes.find((x) => x.poisoned)).toBeTruthy();
        expect(hit.drained).toBe(Math.round(hit.damage * 0.3));
      }
    }
    expect(hitSeen).toBe(true);
  });

  it('kills grant 8 × level XP and count stats', () => {
    const { s, a, d } = duel({ a: { items: ['axe'] }, d: { hp: 1, level: 2 } });
    setTerrain(s, d.pos, 'swamp');
    let killed = false;
    for (let i = 0; i < 30 && !killed; i++) {
      s.rngState = 77 + i;
      a.acted = false;
      const evs = resolveCombat(s, a, d, 'melee');
      if (evs.some((e) => e.type === 'unitDied')) {
        killed = true;
        expect(s.units[String(d.id)]).toBeUndefined();
        expect(a.kills).toBe(1);
        expect(s.factions.valen.stats.kills).toBe(1);
        expect(s.factions.thorn.stats.lost).toBe(1);
        expect(a.xpByCat.melee).toBeGreaterThanOrEqual(16 + COMBAT_XP + 1); // kill XP + the survivor's share for the killing hit
      }
    }
    expect(killed).toBe(true);
  });
});

describe('applyDamage / killUnit', () => {
  it('respects minHp and reports actual damage', () => {
    const { s, a } = duel();
    a.hp = 5;
    const evs = applyDamage(s, a, 10, 'starvation', null, 1);
    expect(a.hp).toBe(1);
    expect(evs).toEqual([{ type: 'unitDamaged', unit: a.id, amount: 4, source: 'starvation' }]);
    expect(applyDamage(s, a, 3, 'poison', null, 1)).toEqual([]);
  });

  it('lethal damage kills and credits the killer with magic XP for spells', () => {
    const { s, a, d } = duel();
    d.hp = 3;
    const evs = applyDamage(s, d, 18, 'spell', a);
    expect(evs.some((e) => e.type === 'unitDied')).toBe(true);
    expect(a.xpByCat.magic).toBe(8);
  });

  it('leader death eliminates the faction and ends a two-player game', () => {
    const s = makeTestState();
    const killer = makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    const leader = makeTestUnit(s, 'thorn', at(8, 6), { isLeader: true });
    const grunt = makeTestUnit(s, 'thorn', at(9, 6));
    const house = makeTestBuilding(s, 'house', 'thorn', at(8, 7));
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(8, 6));
    const evs = killUnit(s, leader, killer);
    expect(s.units[String(grunt.id)]).toBeUndefined();
    expect(s.factions.thorn.alive).toBe(false);
    expect(s.factions.thorn.leaderId).toBeNull();
    expect(s.factions.thorn.castleId).toBeNull();
    expect(house.owner).toBeNull();
    expect(castle.owner).toBeNull();
    expect(evs.filter((e) => e.type === 'unitDied').length).toBe(2);
    expect(evs.find((e) => e.type === 'factionEliminated')).toEqual({ type: 'factionEliminated', faction: 'thorn', by: 'valen' });
    expect(s.factions.thorn.eliminatedBy).toBe('valen');
    expect(evs.find((e) => e.type === 'gameOver')).toEqual({ type: 'gameOver', winner: 'valen' });
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('valen');
  });

  it('human leader death is a defeat', () => {
    const s = makeTestState();
    const leader = makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    makeTestUnit(s, 'thorn', at(8, 6), { isLeader: true });
    const evs = killUnit(s, leader, null);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBe('thorn');
    expect(evs.at(-1)).toEqual({ type: 'gameOver', winner: 'thorn' });
  });

  it('the defeat names the slayer; no AI is crowned while two still stand', () => {
    const s = makeTestState();
    s.factions.ashen = { ...structuredClone(s.factions.thorn), id: 'ashen' };
    s.turnOrder = ['valen', 'thorn', 'ashen'];
    const leader = makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    makeTestUnit(s, 'thorn', at(8, 6), { isLeader: true });
    makeTestUnit(s, 'ashen', at(10, 8), { isLeader: true });
    const killer = makeTestUnit(s, 'ashen', at(3, 2));
    const evs = killUnit(s, leader, killer);
    expect(s.factions.valen.eliminatedBy).toBe('ashen');
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBeNull();
    expect(evs.at(-1)).toEqual({ type: 'gameOver', winner: null });
    const defeat = evs.filter((e) => e.type === 'log').map((e) => (e as Extract<GameEvent, { type: 'log' }>).entry.text).find((t) => t.startsWith('Defeat'));
    expect(defeat).toBe('Defeat. Your leader was slain by Ashen Covenant.');
  });

  it('allied kills near the leader give leader XP', () => {
    const s = makeTestState();
    const leader = makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    const killer = makeTestUnit(s, 'valen', hexAdd(at(2, 2), E));
    const victim = makeTestUnit(s, 'thorn', hexAdd(at(2, 2), { q: 2, r: 0 }));
    killUnit(s, victim, killer);
    expect(leader.xpByCat.leader).toBe(1); // round(1 × 1.3)
    expect(killer.xpByCat.melee).toBe(8); // no attack named: the killer's own (fists) trade
  });
});

describe('forecast modifiers (descriptive)', () => {
  it('lists charge on open ground only, Power Strike only on an initiated melee, poison on retaliation', () => {
    const s = makeTestState(12, 10);
    const knight = makeTestUnit(s, 'valen', at(3, 3), { items: ['sword', 'horse'] });
    const foe = makeTestUnit(s, 'thorn', at(4, 3), { hp: 30 });
    const ids = (p: ReturnType<typeof attackProfile>) => (p?.mods ?? []).map((m) => m.id);
    expect(ids(attackProfile(s, knight, foe, 'melee'))).toContain('charge');
    s.tiles[tileIndex(knight.pos, s.width)].terrain = 'forest';
    expect(ids(attackProfile(s, knight, foe, 'melee'))).not.toContain('charge');
    knight.buffs.push({ id: 'powerstrike', turns: 1, damageMult: 1.5 });
    expect(ids(attackProfile(s, knight, foe, 'melee'))).toContain('powerstrike');
    // retaliating with it does not spend or apply it
    expect(ids(retaliationProfile(s, foe, knight, 'melee'))).not.toContain('powerstrike');
    const spider = makeTestUnit(s, 'neutral', at(3, 5), { monster: 'spider', passives: ['poison'] });
    const walker = makeTestUnit(s, 'valen', at(3, 4), { items: ['sword'] });
    expect(ids(retaliationProfile(s, walker, spider, 'melee'))).toContain('poison');
    walker.poisoned = true;
    expect(ids(retaliationProfile(s, walker, spider, 'melee'))).not.toContain('poison');
  });
});

describe('block', () => {
  it('comes off every strike before armor; a hit still deals at least 1; magic passes it by', () => {
    const { s, a, d } = duel({ a: { items: ['axe'] } });
    const dmg = () => attackProfile(s, a, d, 'melee')!.damage;
    expect(dmg()).toBe(12); // axe 10 + ⌊4/2⌋
    d.base.block = 4;
    expect(dmg()).toBe(8); // 12 − 4
    d.base.armor = 50;
    expect(dmg()).toBe(4); // (12 − 4) × 50%; armor first would have left 12 × 50% − 4 = 2
    d.base.block = 3;
    expect(dmg()).toBe(5); // (12 − 3) × 50% = 4.5 → 5 (half up)
    d.base.block = 20;
    expect(dmg()).toBe(1); // the whole strike is blocked, yet a hit always deals at least 1
    // Ranged strikes are blocked like melee ones.
    const r = duel({ a: { items: ['bow'] }, d: { base: { ...COMMONER_STATS, block: 2 } }, dist: 2 });
    expect(attackProfile(r.s, r.a, r.d, 'ranged')!.damage).toBe(7); // (6 + 2) × 1.1 Valen = 8.8 − 2 = 6.8 → 7
    // Magic passes block by; armor still takes its share.
    const m = duel({ a: { items: ['staff'] }, dist: 2 });
    const magic = () => attackProfile(m.s, m.a, m.d, 'magic')!.damage;
    expect(magic()).toBe(10); // 8 + ⌊(3 + 2 staff) / 2⌋
    m.d.base.block = 5;
    expect(magic()).toBe(10);
    m.d.base.armor = 50;
    expect(magic()).toBe(5);
  });

  it('the forecast and the resolution deal the blocked amount', () => {
    const { s, a, d } = duel({ a: { items: ['sword'] }, d: { items: ['leather'], hp: 30 } });
    setTerrain(s, d.pos, 'swamp'); // easy to hit
    const fc = forecastCombat(s, a, d, 'melee')!;
    expect(fc.attacker.damage).toBe(6); // (7 + 2 − 2 block) × 90% = 6.3 → 6
    s.rngState = 5;
    const ev = combatEv(resolveCombat(s, a, d, 'melee'));
    const hits = ev.strikes.filter((x) => x.by === 'attacker' && x.hit);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.damage).toBe(6);
  });
});

describe('flanking', () => {
  const W: Hex = { q: -1, r: 0 };

  it('a melee strike with an ally of the striker on the far side: ×1.25, passing block', () => {
    const s = makeTestState(12, 10);
    const T = at(5, 4);
    const foe = makeTestUnit(s, 'thorn', T, { base: { ...COMMONER_STATS, block: 3 } });
    const a = makeTestUnit(s, 'valen', hexAdd(T, W), { items: ['axe'] });
    expect(oppositeHex(T, a.pos)).toEqual(hexAdd(T, E)); // axial: 2·target − striker
    expect(flankingAlly(s, a, foe)).toBeNull();
    expect(attackProfile(s, a, foe, 'melee')!.damage).toBe(9); // axe 12 − 3 block
    const ally = makeTestUnit(s, 'valen', hexAdd(T, E));
    expect(flankingAlly(s, a, foe)).toBe(ally);
    const p = attackProfile(s, a, foe, 'melee')!;
    expect(p.damage).toBe(15); // 12 × 1.25, block passed by
    expect(p.mods).toContainEqual(expect.objectContaining({ id: 'flank', mult: FLANK_MULT }));
    expect(FLANK_MULT).toBe(1.25);
    expect(forecastCombat(s, a, foe, 'melee')!.attacker.damage).toBe(15);
    foe.base.armor = 20;
    expect(attackProfile(s, a, foe, 'melee')!.damage).toBe(12); // armor still counts: 15 × 80%
    foe.base.armor = 0;
    // Beside the target is not enough: the ally must stand exactly opposite the striker.
    ally.pos = hexAdd(T, { q: 1, r: -1 });
    expect(flankingAlly(s, a, foe)).toBeNull();
    expect(attackProfile(s, a, foe, 'melee')!.damage).toBe(9);
    // Only the striker's own house flanks: the target's friend or a monster there does not.
    ally.pos = at(10, 8);
    const other = makeTestUnit(s, 'thorn', hexAdd(T, E));
    expect(flankingAlly(s, a, foe)).toBeNull();
    other.faction = 'neutral';
    expect(flankingAlly(s, a, foe)).toBeNull();
    expect(attackProfile(s, a, foe, 'melee')!.mods?.some((m) => m.id === 'flank')).toBeFalsy();
  });

  it('a retaliating defender flanks too, when its own ally stands behind the attacker', () => {
    const s = makeTestState(12, 10);
    const T = at(5, 4);
    const foe = makeTestUnit(s, 'thorn', T);
    const a = makeTestUnit(s, 'valen', hexAdd(T, W), { items: ['sword'], base: { ...COMMONER_STATS, block: 2 } });
    expect(retaliationProfile(s, a, foe, 'melee')!.damage).toBe(4); // fists (3 + 2) × 1.1 = 5.5 − 2 block = 3.5 → 4
    const behind = makeTestUnit(s, 'thorn', hexAdd(a.pos, W));
    expect(behind.pos).toEqual(oppositeHex(a.pos, foe.pos));
    const r = retaliationProfile(s, a, foe, 'melee')!;
    expect(r.mods?.map((m) => m.id)).toContain('flank');
    expect(r.damage).toBe(7); // 5.5 × 1.25 = 6.875 → 7, block passed by
    expect(forecastCombat(s, a, foe, 'melee')!.defender!.damage).toBe(7);
    // The attacker itself is not flanked by that: nothing of its house stands beyond the target.
    expect(attackProfile(s, a, foe, 'melee')!.mods?.some((m) => m.id === 'flank')).toBeFalsy();
  });

  it('ranged and magic strikes never flank, even from the next hex', () => {
    const s = makeTestState(12, 10);
    const T = at(5, 4);
    const foe = makeTestUnit(s, 'thorn', T, { base: { ...COMMONER_STATS, block: 3 } });
    const archer = makeTestUnit(s, 'valen', hexAdd(T, W), { items: ['bow'] });
    makeTestUnit(s, 'valen', hexAdd(T, E));
    const shot = attackProfile(s, archer, foe, 'ranged')!;
    expect(shot.mods?.some((m) => m.id === 'flank')).toBeFalsy();
    expect(shot.damage).toBe(6); // (6 + 2) × 1.1 = 8.8 − 3 block = 5.8 → 6
    // The same archer's Bow Bash is a melee blow: that one flanks.
    const bash = attackProfile(s, archer, foe, 'melee')!;
    expect(bash.mods?.map((m) => m.id)).toContain('flank');
    expect(bash.damage).toBe(5); // (2 + 2) × 1.25, block passed by
    const mage = makeTestUnit(s, 'valen', hexAdd(T, { q: 0, r: -1 }), { items: ['staff'] });
    makeTestUnit(s, 'valen', hexAdd(T, { q: 0, r: 1 }));
    const bolt = attackProfile(s, mage, foe, 'magic')!;
    expect(bolt.mods?.some((m) => m.id === 'flank')).toBeFalsy();
    expect(bolt.damage).toBe(10); // 8 + ⌊5/2⌋: no ×1.25 (magic passes block anyway)
  });
});

describe('reactions', () => {
  /** A sword-wielding thorn defender and three valen swordsmen around it, none opposite another (no flanking). */
  function arena() {
    const s = makeTestState(12, 10);
    const T = at(5, 4);
    const tough = () => ({ items: ['sword'] as any[], base: { ...COMMONER_STATS, maxHp: 500 }, hp: 500 });
    const foe = makeTestUnit(s, 'thorn', T, tough());
    const raiders = [{ q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 }].map((d) => makeTestUnit(s, 'valen', hexAdd(T, d), tough()));
    return { s, foe, raiders };
  }

  it('a unit answers one attack per turn: the next attacker meets no retaliation, and the forecast says so', () => {
    const { s, foe, raiders: [a1, a2] } = arena();
    expect(reactionsLeft(foe)).toBe(1);
    const f1 = forecastCombat(s, a1, foe, 'melee')!;
    expect(f1.defender).not.toBeNull();
    expect(f1.defenderSpent).toBeUndefined();
    const ev1 = combatEv(resolveCombat(s, a1, foe, 'melee'));
    expect(ev1.strikes.some((x) => x.by === 'defender')).toBe(true);
    expect(foe.reacted).toBe(1);
    expect(a1.reacted).toBeUndefined(); // attacking spends no reaction
    expect(reactionsLeft(foe)).toBe(0);

    const f2 = forecastCombat(s, a2, foe, 'melee')!;
    expect(f2.defender).toBeNull();
    expect(f2.defenderSpent).toBe(true);
    expect(f2.expectedDamageToAttacker).toBe(0);
    expect(retaliationProfile(s, a2, foe, 'melee')).toBeNull();
    expect(reachingRetaliation(s, a2, foe, 'melee')).not.toBeNull(); // its sword still reaches
    const hp2 = a2.hp;
    const ev2 = combatEv(resolveCombat(s, a2, foe, 'melee'));
    expect(ev2.strikes.length).toBe(3);
    expect(ev2.strikes.every((x) => x.by === 'attacker')).toBe(true);
    expect(a2.hp).toBe(hp2);
    expect(foe.reacted).toBe(1);
  });

  it('a defender that could not answer anyway is not "spent"', () => {
    const { s, foe } = arena();
    foe.reacted = 1;
    const archer = makeTestUnit(s, 'valen', hexAdd(foe.pos, { q: 2, r: 0 }), { items: ['bow'] });
    const fc = forecastCombat(s, archer, foe, 'ranged')!;
    expect(fc.defender).toBeNull();
    expect(fc.defenderSpent).toBeUndefined(); // a sword never reaches 2 hexes
  });

  it('Combat Reflexes answers two attacks a turn', () => {
    const { s, foe, raiders: [a1, a2, a3] } = arena();
    foe.passives.push('reflexes');
    expect(reactionsLeft(foe)).toBe(2);
    resolveCombat(s, a1, foe, 'melee');
    expect(reactionsLeft(foe)).toBe(1);
    expect(forecastCombat(s, a2, foe, 'melee')!.defender).not.toBeNull();
    const ev2 = combatEv(resolveCombat(s, a2, foe, 'melee'));
    expect(ev2.strikes.some((x) => x.by === 'defender')).toBe(true);
    expect(foe.reacted).toBe(2);
    const f3 = forecastCombat(s, a3, foe, 'melee')!;
    expect(f3.defender).toBeNull();
    expect(f3.defenderSpent).toBe(true);
  });

  it('every turn start (any house, or the wilds) lets every unit answer again', () => {
    const { s, foe, raiders: [a1] } = arena();
    resolveCombat(s, a1, foe, 'melee');
    expect(foe.reacted).toBe(1);
    startTurn(s, 'valen'); // the attacker's house's turn clears the thorn defender too
    expect(foe.reacted).toBeUndefined();
    expect(reactionsLeft(foe)).toBe(1);
    foe.reacted = 1;
    a1.reacted = 1;
    runNeutralTurn(s);
    expect(foe.reacted).toBeUndefined();
    expect(a1.reacted).toBeUndefined();
  });
});
