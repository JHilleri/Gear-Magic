import { describe, expect, it } from 'vitest';
import type { GameEvent, Hex, TechId } from '../src/core/types';
import { hexDistance, hexEq, tileIndex } from '../src/core/hex';
import { binomial, canCast, castSpell, hitsOutcome, knownSpells, manaCap, previewSpell, towerRange, towersInRange } from '../src/sim/spells';
import { previewSkill, volleyStrikeDamage } from '../src/sim/skills';
import { attackProfile } from '../src/sim/combat';
import { getAttackDefs } from '../src/sim/units';
import { captureBuildings, recruit } from '../src/sim/economy';
import { unitTurnUpkeep } from '../src/sim/turn';
import { applyAction, validateAction } from '../src/sim/actions';
import { at, makeTestBuilding, makeTestState, makeTestUnit, setTerrain } from './helpers';

const T = at(3, 4);
const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });
const ALL: TechId[] = ['spell_heal', 'spell_bless', 'spell_fireball', 'spell_haste', 'spell_farsight', 'spell_summon', 'spell_storm'];

function setup() {
  const s = makeTestState(16, 12);
  const tower = makeTestBuilding(s, 'magetower', 'valen', T);
  s.factions.valen.techs.push('crystallore', 'arcana', ...ALL);
  s.factions.valen.resources.mana = 100;
  return { s, tower };
}

const has = (evs: GameEvent[], type: GameEvent['type']) => evs.filter((e) => e.type === type);

describe('spell knowledge and range', () => {
  it('knownSpells follows research', () => {
    const s = makeTestState();
    expect(knownSpells(s, 'valen')).toEqual([]);
    s.factions.valen.techs.push('spell_fireball', 'spell_heal');
    expect(knownSpells(s, 'valen')).toEqual(['heal', 'fireball']);
  });

  it('tower range grows with the channeler intellect', () => {
    const { s, tower } = setup();
    expect(towerRange(s, tower.id, 'heal')).toBe(6);
    const mage = makeTestUnit(s, 'valen', T, { items: ['staff', 'robe'] }); // int 3 + 2 + 2 = 7
    expect(towerRange(s, tower.id, 'heal')).toBe(8);
    mage.faction = 'thorn'; // an enemy squatting in the tower does not help
    expect(towerRange(s, tower.id, 'heal')).toBe(6);
  });

  it('towersInRange lists only own complete towers that reach', () => {
    const { s, tower } = setup();
    const t2 = makeTestBuilding(s, 'magetower', 'valen', at(13, 4));
    makeTestBuilding(s, 'magetower', 'valen', at(13, 8), { buildLeft: 2 });
    makeTestBuilding(s, 'magetower', 'thorn', at(8, 10));
    const target = at(10, 4);
    const list = towersInRange(s, 'valen', 'fireball', target);
    expect(list).toEqual([t2.id, tower.id].filter((id) => hexDistance(s.buildings[String(id)].pos, target) <= 7));
    expect(manaCap(s, 'valen')).toBe(200);
  });
});

describe('canCast', () => {
  it('rejects missing research, mana, cooldown, wrong tower, range, targets', () => {
    const { s, tower } = setup();
    const ally = makeTestUnit(s, 'valen', off(T, 2), { hp: 10 });
    expect(canCast(s, 'valen', 'heal', tower.id, ally.pos)).toBeNull();
    s.factions.valen.techs = s.factions.valen.techs.filter((t) => t !== 'spell_heal');
    expect(canCast(s, 'valen', 'heal', tower.id, ally.pos)).toMatch(/researched/);
    s.factions.valen.techs.push('spell_heal');
    s.factions.valen.resources.mana = 5;
    expect(canCast(s, 'valen', 'heal', tower.id, ally.pos)).toMatch(/mana/);
    s.factions.valen.resources.mana = 100;
    s.factions.valen.spellCooldowns.heal = 1;
    expect(canCast(s, 'valen', 'heal', tower.id, ally.pos)).toMatch(/recharging/);
    delete s.factions.valen.spellCooldowns.heal;
    const enemyTower = makeTestBuilding(s, 'magetower', 'thorn', at(10, 10));
    expect(canCast(s, 'valen', 'heal', enemyTower.id, ally.pos)).toMatch(/Not your/);
    tower.buildLeft = 1;
    expect(canCast(s, 'valen', 'heal', tower.id, ally.pos)).toMatch(/construction/);
    tower.buildLeft = 0;
    expect(canCast(s, 'valen', 'heal', tower.id, at(15, 11))).toMatch(/out of range/);
    ally.hp = 22;
    expect(canCast(s, 'valen', 'heal', tower.id, ally.pos)).toMatch(/wounded/);
    expect(canCast(s, 'valen', 'haste', tower.id, off(T, 3))).toMatch(/your units/);
    expect(canCast(s, 'valen', 'storm', tower.id, off(T, 3))).toMatch(/No enemies/);
    expect(canCast(s, 'valen', 'summon', tower.id, ally.pos)).toMatch(/occupied/);
    setTerrain(s, off(T, 3), 'water');
    expect(canCast(s, 'valen', 'summon', tower.id, off(T, 3))).toMatch(/cannot stand/);
    s.factions.valen.explored[tileIndex(off(T, 4), s.width)] = 0;
    expect(canCast(s, 'valen', 'fireball', tower.id, off(T, 4))).toMatch(/unexplored/);
    expect(canCast(s, 'valen', 'farsight', tower.id, off(T, 4))).toBeNull();
  });
});

describe('castSpell effects', () => {
  it('Healing Light heals allies in radius 1 and cures poison; pays, cooldown, XP, stats', () => {
    const { s, tower } = setup();
    const mage = makeTestUnit(s, 'valen', T);
    const a = makeTestUnit(s, 'valen', off(T, 3), { hp: 5, poisoned: true });
    const b = makeTestUnit(s, 'valen', off(T, 4), { hp: 20 });
    const foe = makeTestUnit(s, 'thorn', off(T, 3, 1), { hp: 5 });
    const evs = castSpell(s, 'valen', 'heal', tower.id, a.pos);
    expect(a.hp).toBe(20);
    expect(a.poisoned).toBe(false);
    expect(b.hp).toBe(22);
    expect(foe.hp).toBe(5);
    expect(s.factions.valen.resources.mana).toBe(80);
    expect(s.factions.valen.spellCooldowns.heal).toBe(2);
    expect(s.factions.valen.stats.spellsCast).toBe(1);
    expect(mage.xpByCat.magic).toBe(6);
    const cast = evs[0] as Extract<GameEvent, { type: 'spellCast' }>;
    expect(cast.type).toBe('spellCast');
    expect(cast.from).toEqual(T);
    expect(cast.affected.sort()).toEqual([a.id, b.id].sort());
    expect(has(evs, 'unitHealed').length).toBe(2);
  });

  it('Blessing buffs allies for 2 turns', () => {
    const { s, tower } = setup();
    const a = makeTestUnit(s, 'valen', off(T, 2));
    castSpell(s, 'valen', 'bless', tower.id, a.pos);
    expect(a.buffs).toEqual([{ id: 'bless', turns: 2, damageMult: 1.2, armor: 10 }]);
    s.factions.valen.spellCooldowns = {};
    castSpell(s, 'valen', 'bless', tower.id, a.pos);
    expect(a.buffs.length).toBe(1); // refreshed, not stacked
  });

  it('Fireball: 18 at the centre, 8 around, friend or foe, kills credit the channeler', () => {
    const { s, tower } = setup();
    const mage = makeTestUnit(s, 'valen', T);
    const c = makeTestUnit(s, 'thorn', off(T, 4), { hp: 30, base: { maxHp: 30, str: 4, dex: 4, int: 3, armor: 50, mov: 5, vis: 4 } });
    const ring1 = makeTestUnit(s, 'thorn', off(T, 5), { hp: 6 });
    const friend = makeTestUnit(s, 'valen', off(T, 3));
    const evs = castSpell(s, 'valen', 'fireball', tower.id, c.pos);
    expect(c.hp).toBe(12); // magic fire ignores armor
    expect(s.units[String(ring1.id)]).toBeUndefined();
    expect(friend.hp).toBe(14);
    expect(has(evs, 'unitDied').length).toBe(1);
    expect(mage.kills).toBe(1);
    expect(s.factions.valen.stats.kills).toBe(1);
  });

  it('Haste grants +3 mp now', () => {
    const { s, tower } = setup();
    const a = makeTestUnit(s, 'valen', off(T, 5), { mp: 1 });
    castSpell(s, 'valen', 'haste', tower.id, a.pos);
    expect(a.mp).toBe(4);
  });

  it('Farsight reveals radius 4 for 3 turns', () => {
    const { s, tower } = setup();
    const target = at(12, 4);
    castSpell(s, 'valen', 'farsight', tower.id, target);
    expect(s.factions.valen.farsight).toEqual([{ hex: target, turns: 3 }]);
    expect(s.factions.valen.visible[tileIndex(target, s.width)]).toBe(1);
    expect(s.factions.valen.visible[tileIndex(off(target, -4), s.width)]).toBe(1);
    expect(s.factions.valen.visible[tileIndex(off(target, -5), s.width)]).toBe(0);
  });

  it('Summon Elemental creates an own stone elemental living 8 turns', () => {
    const { s, tower } = setup();
    const target = off(T, 3);
    const evs = castSpell(s, 'valen', 'summon', tower.id, target);
    const sp = has(evs, 'unitSpawned')[0] as Extract<GameEvent, { type: 'unitSpawned' }>;
    expect(sp.reason).toBe('summon');
    const u = s.units[String(sp.unit)];
    expect(u.faction).toBe('valen');
    expect(u.monster).toBe('elemental');
    expect(u.summonTurns).toBe(8);
    expect(u.hp).toBe(40);
    expect(u.mp).toBe(0);
    expect(s.factions.valen.resources.mana).toBe(50);
  });

  it('Storm of Ruin: 4 bolts of 14 on enemies only', () => {
    const { s, tower } = setup();
    const big = { maxHp: 200, str: 4, dex: 4, int: 3, armor: 0, mov: 5, vis: 4 };
    const e1 = makeTestUnit(s, 'thorn', off(T, 5), { base: { ...big }, hp: 200 });
    const e2 = makeTestUnit(s, 'thorn', off(T, 6), { base: { ...big }, hp: 200 });
    const f = makeTestUnit(s, 'valen', off(T, 4));
    const evs = castSpell(s, 'valen', 'storm', tower.id, off(T, 5));
    expect(400 - e1.hp - e2.hp).toBe(56);
    expect(f.hp).toBe(22);
    expect(has(evs, 'unitDamaged').length).toBe(4);
  });

  it('Storm bolts stop when every enemy is dead', () => {
    const { s, tower } = setup();
    const e1 = makeTestUnit(s, 'thorn', off(T, 5), { hp: 10 });
    const evs = castSpell(s, 'valen', 'storm', tower.id, e1.pos);
    expect(s.units[String(e1.id)]).toBeUndefined();
    expect(has(evs, 'unitDamaged').length).toBe(1);
  });
});

describe('spell edge cases', () => {
  it('a Fireball that fells both leaders ends the game without naming a dead winner', () => {
    const { s, tower } = setup();
    const target = off(T, 4);
    const vl = makeTestUnit(s, 'valen', target, { isLeader: true, hp: 5 });
    const tl = makeTestUnit(s, 'thorn', off(T, 5), { isLeader: true, hp: 5 });
    const evs = castSpell(s, 'valen', 'fireball', tower.id, target);
    expect(s.units[String(vl.id)]).toBeUndefined();
    expect(s.units[String(tl.id)]).toBeUndefined();
    expect(s.factions.valen.alive).toBe(false);
    expect(s.factions.thorn.alive).toBe(false);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBeNull();
    const over = has(evs, 'gameOver') as Extract<GameEvent, { type: 'gameOver' }>[];
    expect(over).toHaveLength(1);
    expect(over[0].winner).toBeNull();
  });

  it('kills from an empty tower are credited to the casting house, not on friendly fire', () => {
    const { s, tower } = setup();
    const target = off(T, 4);
    const foe = makeTestUnit(s, 'thorn', target, { hp: 5 });
    const own = makeTestUnit(s, 'valen', off(T, 5), { hp: 5 });
    castSpell(s, 'valen', 'fireball', tower.id, target);
    expect(s.units[String(foe.id)]).toBeUndefined();
    expect(s.units[String(own.id)]).toBeUndefined();
    expect(s.factions.thorn.stats.lost).toBe(1);
    expect(s.factions.valen.stats.kills).toBe(1); // the foe only
    // A leader felled the same way names its destroyer.
    s.factions.valen.spellCooldowns = {};
    s.factions.valen.resources.mana = 100;
    const tl = makeTestUnit(s, 'thorn', target, { isLeader: true, hp: 5 });
    const evs = castSpell(s, 'valen', 'fireball', tower.id, target);
    expect(s.units[String(tl.id)]).toBeUndefined();
    expect(has(evs, 'factionEliminated')[0]).toEqual({ type: 'factionEliminated', faction: 'thorn', by: 'valen' });
    expect(s.winner).toBe('valen');
  });

  it('Haste cannot make a fresh recruit march; it can from its next turn', () => {
    const { s, tower } = setup();
    const house = makeTestBuilding(s, 'house', 'valen', off(T, 5));
    recruit(s, house.id, 'commoner');
    const u = Object.values(s.units).find((x) => x.faction === 'valen' && hexEq(x.pos, house.pos))!;
    expect(u.justSpawned).toBe(true);
    expect(canCast(s, 'valen', 'haste', tower.id, u.pos)).toMatch(/Fresh recruits/);
    expect(validateAction(s, { type: 'move', unit: u.id, to: off(u.pos, 1) })).not.toBeNull();
    unitTurnUpkeep(s, u);
    expect(u.justSpawned).toBeUndefined();
    expect(canCast(s, 'valen', 'haste', tower.id, u.pos)).toBeNull();
  });

  it('Haste cannot give movement back to a unit that has attacked', () => {
    const { s, tower } = setup();
    const u = makeTestUnit(s, 'valen', off(T, 2), { items: ['sword'] });
    const foe = makeTestUnit(s, 'thorn', off(T, 3), { hp: 200 });
    expect(canCast(s, 'valen', 'haste', tower.id, u.pos)).toBeNull();
    expect(validateAction(s, { type: 'attack', unit: u.id, target: foe.id, kind: 'melee' })).toBeNull();
    expect(applyAction(s, { type: 'attack', unit: u.id, target: foe.id, kind: 'melee' }).ok).toBe(true);
    expect(canCast(s, 'valen', 'haste', tower.id, u.pos)).toMatch(/already attacked/);
    expect(validateAction(s, { type: 'cast', faction: 'valen', spell: 'haste', tower: tower.id, target: u.pos })).toMatch(/already attacked/);
  });

  it('Summon may not target another faction\'s (or an abandoned) building, only empty ground or our own', () => {
    const { s, tower } = setup();
    const farm = makeTestBuilding(s, 'farm', 'thorn', off(T, 3));
    const castle = makeTestBuilding(s, 'castle', 'thorn', off(T, 4));
    const ruin = makeTestBuilding(s, 'house', null, off(T, 2));
    const mine = makeTestBuilding(s, 'farm', 'valen', off(T, 0, 2));
    expect(canCast(s, 'valen', 'summon', tower.id, farm.pos)).toMatch(/another faction/);
    expect(canCast(s, 'valen', 'summon', tower.id, castle.pos)).toMatch(/another faction/);
    expect(canCast(s, 'valen', 'summon', tower.id, ruin.pos)).toMatch(/another faction/);
    expect(validateAction(s, { type: 'cast', faction: 'valen', spell: 'summon', tower: tower.id, target: castle.pos })).toMatch(/another faction/);
    expect(canCast(s, 'valen', 'summon', tower.id, mine.pos)).toBeNull();
    expect(canCast(s, 'valen', 'summon', tower.id, off(T, 1, 1))).toBeNull();
  });

  it('an elemental placed on an enemy building (bypassing canCast) still does not take it on its first turn', () => {
    const { s, tower } = setup();
    const farm = makeTestBuilding(s, 'farm', 'thorn', off(T, 3));
    castSpell(s, 'valen', 'summon', tower.id, farm.pos);
    const el = Object.values(s.units).find((x) => x.monster === 'elemental')!;
    captureBuildings(s, 'valen');
    expect(farm.owner).toBe('thorn');
    unitTurnUpkeep(s, el);
    captureBuildings(s, 'valen');
    expect(farm.owner).toBe('valen');
  });
});

describe('spell and skill previews (match the resolution)', () => {
  it('fireball: exact damage, own units flagged, hidden units left out', () => {
    const { s, tower } = setup();
    const c = off(T, 3);
    const foe = makeTestUnit(s, 'thorn', c, { hp: 30 });
    const mine = makeTestUnit(s, 'valen', off(c, 1), { hp: 6 });
    const hidden = makeTestUnit(s, 'thorn', off(c, -1), { hp: 30 });
    s.factions.valen.visible[tileIndex(hidden.pos, s.width)] = 0;
    const p = previewSpell(s, 'valen', 'fireball', c);
    expect(p.tone).toBe('harm');
    expect(p.entries.map((e) => e.unit).sort()).toEqual([foe.id, mine.id].sort());
    const ef = p.entries.find((e) => e.unit === foe.id)!;
    const em = p.entries.find((e) => e.unit === mine.id)!;
    expect(ef).toMatchObject({ own: false, hpDelta: -18, killChance: 0 });
    expect(em).toMatchObject({ own: true, hpDelta: -6, killChance: 1 });
    castSpell(s, 'valen', 'fireball', tower.id, c);
    expect(s.units[String(foe.id)].hp).toBe(30 + ef.hpDelta);
    expect(s.units[String(mine.id)]).toBeUndefined();
  });

  it('heal and haste: exact amounts', () => {
    const { s, tower } = setup();
    const a = makeTestUnit(s, 'valen', off(T, 2), { hp: 10 });
    const b = makeTestUnit(s, 'valen', off(T, 3), { hp: 18 }); // max 20 by default
    const ph = previewSpell(s, 'valen', 'heal', a.pos);
    expect(ph.tone).toBe('help');
    const before = { a: a.hp, b: b.hp };
    castSpell(s, 'valen', 'heal', tower.id, a.pos);
    for (const e of ph.entries) {
      const u = s.units[String(e.unit)];
      expect(u.hp).toBe((e.unit === a.id ? before.a : before.b) + e.hpDelta);
    }
    const mp = a.mp;
    const pz = previewSpell(s, 'valen', 'haste', a.pos);
    expect(pz.entries).toEqual([expect.objectContaining({ unit: a.id, mpDelta: 3 })]);
    castSpell(s, 'valen', 'haste', tower.id, a.pos);
    expect(s.units[String(a.id)].mp).toBe(mp + 3);
  });

  it('storm: expected damage over the random bolts', () => {
    const { s } = setup();
    const c = off(T, 3);
    const one = makeTestUnit(s, 'thorn', c, { hp: 30 });
    const solo = previewSpell(s, 'valen', 'storm', c);
    // a single enemy takes all four bolts: 56 > 30, a certain kill
    expect(solo.entries[0]).toMatchObject({ unit: one.id, hpDelta: -30, killChance: 1 });
    makeTestUnit(s, 'thorn', off(c, 1), { hp: 30 });
    const two = previewSpell(s, 'valen', 'storm', c);
    for (const e of two.entries) {
      // P(k hits) = Binomial(4, 1/2); dead at k >= 3 (42 dmg)
      expect(e.killChance).toBeCloseTo(5 / 16, 6);
      expect(e.approx).toBe(true);
      const exp = -(14 * 4 / 16 + 28 * 6 / 16 + 30 * 5 / 16);
      expect(e.hpDelta).toBeCloseTo(exp, 6);
    }
  });

  it('firebolt and volley previews', () => {
    const s = makeTestState(16, 12);
    const c = at(5, 5);
    const mage = makeTestUnit(s, 'valen', c, { actives: ['firebolt'] });
    const foe = makeTestUnit(s, 'thorn', off(c, 2), { hp: 30, items: ['plate'] });
    const fb = previewSkill(s, mage, 'firebolt', foe.pos);
    expect(fb.entries).toEqual([expect.objectContaining({ unit: foe.id, own: false, hpDelta: -14, killChance: 0 })]);
    expect(fb.notes.join(' ')).toMatch(/armor/);
    applyAction(s, { type: 'skill', unit: mage.id, skill: 'firebolt', target: foe.pos });
    expect(s.units[String(foe.id)].hp).toBe(30 - 14); // armor ignored

    const archer = makeTestUnit(s, 'valen', at(5, 9), { items: ['bow'], actives: ['volley'] });
    const v1 = makeTestUnit(s, 'thorn', off(archer.pos, 2), { hp: 25 });
    const pv = previewSkill(s, archer, 'volley', v1.pos);
    const e = pv.entries.find((x) => x.unit === v1.id)!;
    const prof = attackProfile(s, archer, v1, 'ranged')!;
    const dmg = volleyStrikeDamage(prof.damage);
    const strikes = getAttackDefs(archer).find((a) => a.kind === 'ranged')!.strikes;
    expect(strikes * dmg).toBeLessThan(25); // no kill possible: the expectation is the binomial mean
    expect(e.killChance).toBe(0);
    expect(e.hpDelta).toBeCloseTo(-strikes * prof.hitChance * dmg, 6);
    expect(e.hpDist!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('binomial and hit outcomes', () => {
    expect(binomial(3, 0.5)).toEqual([0.125, 0.375, 0.375, 0.125]);
    const o = hitsOutcome(10, 6, binomial(2, 0.5));
    expect(o.killChance).toBeCloseTo(0.25, 9);
    expect(o.hpDist[4]).toBeCloseTo(0.5, 9);
    expect(o.hpDelta).toBeCloseTo(-(0.5 * 6 + 0.25 * 10), 9);
  });

  it('spell damage is fixed: plate and a shield do not reduce Fireball or Storm', () => {
    const { s, tower } = setup();
    const c = off(T, 3);
    const tank = makeTestUnit(s, 'thorn', c, { hp: 40, items: ['plate', 'shield'] });
    const side = makeTestUnit(s, 'thorn', off(c, 1), { hp: 40, items: ['plate'] });
    castSpell(s, 'valen', 'fireball', tower.id, c);
    expect(s.units[String(tank.id)].hp).toBe(40 - 18);
    expect(s.units[String(side.id)].hp).toBe(40 - 8);
    const lone = makeTestUnit(s, 'thorn', off(T, -4), { hp: 60, items: ['plate'] });
    s.factions.valen.resources.mana = 100;
    castSpell(s, 'valen', 'storm', tower.id, lone.pos);
    expect(s.units[String(lone.id)].hp).toBe(60 - 4 * 14);
  });
});
