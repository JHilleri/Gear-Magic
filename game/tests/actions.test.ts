import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState, Hex } from '../src/core/types';
import { hexDistance, hexEq, tileIndex } from '../src/core/hex';
import {
  applyAction, attackTargets, buildOptions, craftOptions, equipOptions, idleUnits, recruitOptions, validateAction,
} from '../src/sim/actions';
import { computeVisibility } from '../src/sim/visibility';
import { canUseSkill, skillBlocker, skillTargets } from '../src/sim/skills';
import { unitTurnUpkeep } from '../src/sim/turn';
import { COMMONER_STATS } from '../src/data/presets';
import { at, makeTestBuilding, makeTestState, makeTestUnit, setTerrain } from './helpers';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });
const types = (evs: GameEvent[]) => evs.map((e) => e.type);

/** A one-hex-wide grass corridor along row 5 (everything else is lake). */
function corridor(): { s: GameState; S: Hex } {
  const s = makeTestState(14, 10, 'water');
  const S = at(1, 5);
  for (let i = 0; i < 12; i++) setTerrain(s, off(S, i), 'grass');
  return { s, S };
}

describe('turn ownership', () => {
  it('only the current faction may act', () => {
    const s = makeTestState();
    const mine = makeTestUnit(s, 'valen', at(2, 2));
    const theirs = makeTestUnit(s, 'thorn', at(8, 8));
    expect(validateAction(s, { type: 'move', unit: theirs.id, to: at(8, 7) })).toMatch(/Not your unit/);
    expect(validateAction(s, { type: 'move', unit: mine.id, to: at(3, 2) })).toBeNull();
    expect(validateAction(s, { type: 'endTurn', faction: 'thorn' })).toMatch(/not your turn/);
    expect(validateAction(s, { type: 'research', faction: 'thorn', tech: 'mining' })).toMatch(/not your turn/);
    const r = applyAction(s, { type: 'move', unit: theirs.id, to: at(8, 7) });
    expect(r).toEqual({ ok: false, error: 'Not your unit', events: [] });
    s.gameOver = true;
    expect(validateAction(s, { type: 'move', unit: mine.id, to: at(3, 2) })).toMatch(/over/);
  });
});

describe('move', () => {
  it('walks the path, spends mp, updates visibility and explore XP', () => {
    const s = makeTestState(20, 12);
    const u = makeTestUnit(s, 'valen', at(2, 5));
    s.factions.valen.explored = new Array(s.width * s.height).fill(0);
    computeVisibility(s, 'valen');
    const before = s.factions.valen.explored.reduce((a, b) => a + b, 0);
    const to = off(u.pos, 4);
    const r = applyAction(s, { type: 'move', unit: u.id, to });
    expect(r.ok).toBe(true);
    const mv = r.events[0] as Extract<GameEvent, { type: 'unitMoved' }>;
    expect(mv.type).toBe('unitMoved');
    expect(mv.path.length).toBe(4);
    expect(hexEq(u.pos, to)).toBe(true);
    expect(u.mp).toBe(1);
    expect(u.moved).toBe(true);
    const after = s.factions.valen.explored.reduce((a, b) => a + b, 0);
    expect(after).toBeGreaterThan(before);
    expect(u.xpByCat.explore).toBe(Math.floor((after - before) / 3));
    expect(s.factions.valen.visible[tileIndex(off(to, 4), s.width)]).toBe(1);
  });

  it('rejects unreachable targets and passes through (not onto) friends', () => {
    const { s, S } = corridor();
    const u = makeTestUnit(s, 'valen', S);
    makeTestUnit(s, 'valen', off(S, 1));
    expect(validateAction(s, { type: 'move', unit: u.id, to: off(S, 1) })).toMatch(/Cannot reach/);
    expect(validateAction(s, { type: 'move', unit: u.id, to: off(S, 6) })).toMatch(/Cannot reach/);
    expect(validateAction(s, { type: 'move', unit: u.id, to: at(5, 2) })).toMatch(/Cannot reach/); // lake
    const r = applyAction(s, { type: 'move', unit: u.id, to: off(S, 3) });
    expect(r.ok).toBe(true);
    expect(hexEq(u.pos, off(S, 3))).toBe(true);
  });

  it('entering the zone of control of a newly seen enemy stops the move', () => {
    const { s, S } = corridor();
    const u = makeTestUnit(s, 'valen', S, { base: { maxHp: 22, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 6, vis: 1 }, mp: 6 });
    setTerrain(s, off(S, 3, -1), 'grass');
    makeTestUnit(s, 'thorn', off(S, 3, -1));
    computeVisibility(s, 'valen');
    const r = applyAction(s, { type: 'move', unit: u.id, to: off(S, 5) });
    expect(r.ok).toBe(true);
    expect(hexEq(u.pos, off(S, 2))).toBe(true);
    expect(u.mp).toBe(0);
  });

  it('a hidden enemy on the path stops a skirmisher just before it (ambush)', () => {
    const { s, S } = corridor();
    const u = makeTestUnit(s, 'valen', S, {
      base: { maxHp: 22, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 6, vis: 1 }, mp: 6, passives: ['skirmisher'],
    });
    makeTestUnit(s, 'thorn', off(S, 4));
    computeVisibility(s, 'valen');
    expect(validateAction(s, { type: 'move', unit: u.id, to: off(S, 5) })).toBeNull(); // the planner cannot know
    const r = applyAction(s, { type: 'move', unit: u.id, to: off(S, 5) });
    expect(r.ok).toBe(true);
    expect(hexEq(u.pos, off(S, 3))).toBe(true);
    expect(u.mp).toBe(0);
    expect(r.events.some((e) => e.type === 'log' && /Ambush/.test(e.entry.text))).toBe(true);
  });

  it('never stops on a friend when interrupted while passing through', () => {
    const { s, S } = corridor();
    const u = makeTestUnit(s, 'valen', S, {
      base: { maxHp: 22, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 6, vis: 1 }, mp: 6, passives: ['skirmisher'],
    });
    makeTestUnit(s, 'valen', off(S, 3));
    const foe = makeTestUnit(s, 'thorn', off(S, 4));
    computeVisibility(s, 'valen');
    // Pretend the enemy slipped in unseen (e.g. it just arrived): the planner routes through it.
    s.factions.valen.visible[tileIndex(foe.pos, s.width)] = 0;
    const r = applyAction(s, { type: 'move', unit: u.id, to: off(S, 5) });
    expect(r.ok).toBe(true);
    expect(hexEq(u.pos, off(S, 2))).toBe(true);
  });

  it('visiting unlooted ruins explores them', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(2, 2));
    const ruin = off(u.pos, 2);
    setTerrain(s, ruin, 'ruins');
    const r = applyAction(s, { type: 'move', unit: u.id, to: ruin });
    expect(types(r.events)).toContain('ruinsExplored');
    expect(s.tiles[tileIndex(ruin, s.width)].ruinsLooted).toBe(true);
    expect(u.xpByCat.explore).toBeGreaterThanOrEqual(12);
  });
});

describe('attack, build, recruit, craft, equip, research, levelup', () => {
  it('attacks visible enemies only', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(3, 3), { items: ['sword'] });
    const t = makeTestUnit(s, 'thorn', off(at(3, 3), 1));
    expect(attackTargets(s, u)).toEqual([{ unit: t.id, kinds: ['melee'] }]);
    s.factions.valen.visible[tileIndex(t.pos, s.width)] = 0;
    expect(validateAction(s, { type: 'attack', unit: u.id, target: t.id, kind: 'melee' })).toMatch(/not visible/);
    expect(attackTargets(s, u)).toEqual([]);
    s.factions.valen.visible[tileIndex(t.pos, s.width)] = 1;
    const r = applyAction(s, { type: 'attack', unit: u.id, target: t.id, kind: 'melee' });
    expect(r.ok).toBe(true);
    expect(types(r.events)[0]).toBe('combat');
    expect(validateAction(s, { type: 'attack', unit: u.id, target: t.id, kind: 'melee' })).toMatch(/acted/);
  });

  it('build through actions and buildOptions', () => {
    const s = makeTestState();
    makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const u = makeTestUnit(s, 'valen', off(at(5, 5), 1), { items: ['tools'] });
    const opts = buildOptions(s, u);
    expect(opts.find((o) => o.building === 'farm')!.error).toBeNull();
    expect(opts.find((o) => o.building === 'mine')!.error).toMatch(/Mining/);
    const r = applyAction(s, { type: 'build', unit: u.id, building: 'farm' });
    expect(r.ok).toBe(true);
    expect(types(r.events)).toContain('buildingStarted');
    expect(applyAction(s, { type: 'build', unit: u.id, building: 'house' }).ok).toBe(false);
  });

  it('craft at a forge, equip on an armory, unequip back to the stockpile', () => {
    const s = makeTestState();
    const forge = makeTestBuilding(s, 'forge', 'valen', at(4, 4));
    const u = makeTestUnit(s, 'valen', at(4, 4));
    expect(craftOptions(s, forge.id).find((o) => o.item === 'sword')!.error).toBeNull();
    expect(applyAction(s, { type: 'craft', forge: forge.id, item: 'sword' }).ok).toBe(true);
    expect(applyAction(s, { type: 'craft', forge: forge.id, item: 'shield' }).ok).toBe(false); // locked
    expect(s.factions.valen.stockpile.sword).toBe(1);
    expect(equipOptions(s, u)).toEqual([{ item: 'sword', count: 1, error: null }]);
    const r = applyAction(s, { type: 'equip', unit: u.id, item: 'sword' });
    expect(r.ok).toBe(true);
    expect(r.events).toContainEqual({ type: 'unitEquipped', unit: u.id, item: 'sword', slot: 'main' });
    expect(u.equipment.main).toBe('sword');
    expect(s.factions.valen.stockpile.sword ?? 0).toBe(0);
    // Equip is a free action even after moving / acting.
    u.acted = true;
    expect(applyAction(s, { type: 'unequip', unit: u.id, slot: 'main' }).ok).toBe(true);
    expect(s.factions.valen.stockpile.sword).toBe(1);
    u.pos = at(8, 8);
    expect(applyAction(s, { type: 'equip', unit: u.id, item: 'sword' }).ok).toBe(false);
  });

  it('recruit through actions and recruitOptions', () => {
    const s = makeTestState();
    const castle = makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    makeTestUnit(s, 'valen', at(5, 5), { isLeader: true });
    const opts = recruitOptions(s, castle.id);
    expect(opts.map((o) => o.preset)).toContain('knight');
    expect(opts.find((o) => o.preset === 'swordsman')!.error).toBeNull();
    expect(opts.find((o) => o.preset === 'knight')!.error).toMatch(/research/);
    const r = applyAction(s, { type: 'recruit', site: castle.id, preset: 'swordsman' });
    expect(r.ok).toBe(true);
    expect(types(r.events)).toContain('unitSpawned');
    const enemyCastle = makeTestBuilding(s, 'castle', 'thorn', at(10, 8));
    expect(validateAction(s, { type: 'recruit', site: enemyCastle.id, preset: 'commoner' })).toMatch(/Not your/);
  });

  it('research and level-up choices', () => {
    const s = makeTestState();
    expect(applyAction(s, { type: 'research', faction: 'valen', tech: 'mining' }).ok).toBe(true);
    expect(s.factions.valen.researching).toBe('mining');
    expect(applyAction(s, { type: 'research', faction: 'valen', tech: 'masonry' }).ok).toBe(false);
    const u = makeTestUnit(s, 'valen', at(2, 2), { level: 2, pendingLevelUps: 1, levelUpOptions: [['stat_str', 'stat_dex', 'passive_scholar']] });
    expect(validateAction(s, { type: 'levelup', unit: u.id, option: 'stat_int' })).toMatch(/not on offer/);
    const r = applyAction(s, { type: 'levelup', unit: u.id, option: 'stat_str' });
    expect(r.ok).toBe(true);
    expect(u.base.str).toBe(7);
    expect(u.pendingLevelUps).toBe(0);
    expect(validateAction(s, { type: 'levelup', unit: u.id, option: 'stat_str' })).toMatch(/No level-up/);
  });

  it('cast through actions', () => {
    const s = makeTestState();
    const tower = makeTestBuilding(s, 'magetower', 'valen', at(3, 3));
    s.factions.valen.techs.push('spell_haste');
    s.factions.valen.resources.mana = 40;
    const u = makeTestUnit(s, 'valen', at(5, 3), { mp: 0 });
    const r = applyAction(s, { type: 'cast', faction: 'valen', spell: 'haste', tower: tower.id, target: u.pos });
    expect(r.ok).toBe(true);
    expect(u.mp).toBe(3);
    expect(applyAction(s, { type: 'cast', faction: 'valen', spell: 'haste', tower: tower.id, target: u.pos }).error).toMatch(/recharging/);
  });

  it('endTurn passes the turn', () => {
    const s = makeTestState();
    makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    makeTestUnit(s, 'thorn', at(9, 8), { isLeader: true });
    const r = applyAction(s, { type: 'endTurn', faction: 'valen' });
    expect(r.ok).toBe(true);
    expect(s.currentTurn).toBe(1);
    expect(r.events.some((e) => e.type === 'turnStarted' && e.faction === 'thorn')).toBe(true);
  });
});

describe('skills', () => {
  const big = () => ({ maxHp: 200, str: 4, dex: 4, int: 3, armor: 0, block: 0, mov: 5, vis: 4 });

  it('Power Strike is a free buff; Fortify uses the action but keeps movement', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(3, 3), { actives: ['powerstrike', 'fortify'] });
    const foe = makeTestUnit(s, 'thorn', at(4, 3));
    let r = applyAction(s, { type: 'skill', unit: u.id, skill: 'powerstrike' });
    expect(r.ok).toBe(true);
    expect(u.buffs).toContainEqual({ id: 'powerstrike', turns: 1, damageMult: 1.15 }); // +15% at rank 1
    expect(u.cooldowns.powerstrike).toBe(3);
    expect(u.acted).toBe(false);
    r = applyAction(s, { type: 'skill', unit: u.id, skill: 'powerstrike' });
    expect(r.error).toMatch(/recharging/);
    r = applyAction(s, { type: 'skill', unit: u.id, skill: 'fortify' });
    expect(r.ok).toBe(true);
    expect(u.buffs).toContainEqual({ id: 'fortify', turns: 1, armor: 7.5 }); // +7.5% armor at rank 1, no block
    expect(u.acted).toBe(true);
    expect(u.mp).toBe(u.base.mov);
    expect(validateAction(s, { type: 'attack', unit: u.id, target: foe.id, kind: 'melee' })).toMatch(/already acted/);
    expect(validateAction(s, { type: 'move', unit: u.id, to: at(2, 3) })).toBeNull();
  });

  it('a skill the unit does not know is refused; permanent skills are not actions', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(3, 3), { actives: ['masonry'] });
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'heal', target: u.pos })).toMatch(/does not know/);
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'masonry' })).toMatch(/permanent/);
  });

  it('Rally: +2 mp to allies within 2', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['rally'] });
    const near = makeTestUnit(s, 'valen', off(c, 2), { mp: 1 });
    const far = makeTestUnit(s, 'valen', off(c, -3), { mp: 1 });
    const r = applyAction(s, { type: 'skill', unit: u.id, skill: 'rally' });
    expect(r.ok).toBe(true);
    expect(near.mp).toBe(3);
    expect(far.mp).toBe(1);
    expect(u.mp).toBe(5);
    expect(u.acted).toBe(false);
  });

  it('Rally passes over fresh recruits (they cannot march on their first turn)', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['rally'] });
    const fresh = makeTestUnit(s, 'valen', off(c, 1), { mp: 0, acted: true, justSpawned: true });
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'rally' })).toMatch(/No allies/);
    const vet = makeTestUnit(s, 'valen', off(c, 2), { mp: 1 });
    expect(applyAction(s, { type: 'skill', unit: u.id, skill: 'rally' }).ok).toBe(true);
    expect(fresh.mp).toBe(0);
    expect(vet.mp).toBe(3);
    expect(validateAction(s, { type: 'move', unit: fresh.id, to: off(c, 1, 1) })).toMatch(/Fresh recruits/);
  });

  it('Rally cannot give movement back to a unit that has attacked (no hit-and-run)', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['rally'] });
    const archer = makeTestUnit(s, 'valen', off(c, 1), { items: ['bow'] });
    const foe = makeTestUnit(s, 'thorn', off(archer.pos, 2), { hp: 200 });
    expect(applyAction(s, { type: 'attack', unit: archer.id, target: foe.id, kind: 'ranged' }).ok).toBe(true);
    expect(archer.mp).toBe(0);
    expect(archer.moveEnded).toBe(true);
    // The only ally in reach has already attacked: nobody to rally.
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'rally' })).toMatch(/No allies/);
    const other = makeTestUnit(s, 'valen', off(c, -1), { mp: 1 });
    expect(applyAction(s, { type: 'skill', unit: u.id, skill: 'rally' }).ok).toBe(true);
    expect(other.mp).toBe(3);
    expect(archer.mp).toBe(0);
    expect(archer.buffs.some((b) => b.id === 'haste')).toBe(false);
    expect(validateAction(s, { type: 'move', unit: archer.id, to: off(archer.pos, 0, -1) })).toMatch(/Attacking ended/);
    expect(idleUnits(s)).not.toContain(archer.id);
  });

  it('Volley ends movement for the turn: Rally passes the archer by', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['rally'] });
    const archer = makeTestUnit(s, 'valen', off(c, 1), { items: ['bow'], actives: ['volley'] });
    const foe = makeTestUnit(s, 'thorn', off(archer.pos, 2), { hp: 200 });
    expect(applyAction(s, { type: 'skill', unit: archer.id, skill: 'volley', target: foe.pos }).ok).toBe(true);
    expect(archer.moveEnded).toBe(true);
    const other = makeTestUnit(s, 'valen', off(c, -1), { mp: 1 });
    expect(applyAction(s, { type: 'skill', unit: u.id, skill: 'rally' }).ok).toBe(true);
    expect(archer.mp).toBe(0);
    expect(other.mp).toBe(3);
    expect(validateAction(s, { type: 'move', unit: archer.id, to: off(archer.pos, 0, -1) })).toMatch(/Attacking ended/);
  });

  it('Rally still reaches a fortified ally (Fortify leaves movement), and Rally then attack stays legal', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['rally'], items: ['sword'] });
    const guard = makeTestUnit(s, 'valen', off(c, 1), { actives: ['fortify'], mp: 1 });
    expect(applyAction(s, { type: 'skill', unit: guard.id, skill: 'fortify' }).ok).toBe(true);
    expect(applyAction(s, { type: 'skill', unit: u.id, skill: 'rally' }).ok).toBe(true);
    expect(guard.mp).toBe(3);
    expect(validateAction(s, { type: 'move', unit: guard.id, to: off(guard.pos, 0, -1) })).toBeNull();
    const foe = makeTestUnit(s, 'thorn', off(c, -1), { hp: 200 });
    expect(applyAction(s, { type: 'attack', unit: u.id, target: foe.id, kind: 'melee' }).ok).toBe(true);
    expect(u.moveEnded).toBe(true);
  });

  it('the movement lock clears at the unit\'s next turn start', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(5, 5), { moveEnded: true, mp: 2 });
    expect(validateAction(s, { type: 'move', unit: u.id, to: off(u.pos, 1) })).toMatch(/Attacking ended/);
    unitTurnUpkeep(s, u);
    expect(u.moveEnded).toBeUndefined();
    expect(validateAction(s, { type: 'move', unit: u.id, to: off(u.pos, 1) })).toBeNull();
  });

  it('Mend heals an adjacent ally 15 and cures poison', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['heal'] });
    const ally = makeTestUnit(s, 'valen', off(c, 1), { hp: 5, poisoned: true });
    expect(skillTargets(s, u, 'heal')).toEqual([ally.pos]);
    const r = applyAction(s, { type: 'skill', unit: u.id, skill: 'heal', target: ally.pos });
    expect(r.ok).toBe(true);
    expect(ally.hp).toBe(20); // 5 + 15
    expect(ally.poisoned).toBe(false);
    expect(u.acted).toBe(true);
    expect(u.cooldowns.heal).toBe(2);
    expect(r.events).toContainEqual({ type: 'unitHealed', unit: ally.id, amount: 15 });
  });

  it('skillBlocker says what stops a skill before any target: no "Choose an ally" for a missing target', () => {
    const s = makeTestState();
    const c = at(5, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['heal'] });
    // Nobody wounded next to it: only a target is missing, which the HUD words itself.
    expect(skillTargets(s, u, 'heal')).toEqual([]);
    expect(skillBlocker(s, u, 'heal')).toBeNull();
    expect(canUseSkill(s, u, 'heal')).not.toBeNull(); // (the per-target wording)
    u.acted = true;
    expect(skillBlocker(s, u, 'heal')).toMatch(/already acted/);
    u.acted = false;
    u.cooldowns.heal = 2;
    expect(skillBlocker(s, u, 'heal')).toMatch(/recharging \(2 turns\)/);
    expect(skillBlocker(s, u, 'firebolt')).toMatch(/does not know/);
  });

  it('Firebolt: 18 damage at range 3, no retaliation', () => {
    const s = makeTestState();
    const c = at(3, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['firebolt'] });
    const foe = makeTestUnit(s, 'thorn', off(c, 3), { base: big(), hp: 50 });
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'firebolt', target: off(c, 2) })).toMatch(/visible enemy/);
    const r = applyAction(s, { type: 'skill', unit: u.id, skill: 'firebolt', target: foe.pos });
    expect(r.ok).toBe(true);
    expect(foe.hp).toBe(32); // 50 − 18
    expect(u.hp).toBe(COMMONER_STATS.maxHp); // untouched: no retaliation
    expect(u.acted).toBe(true);
    expect(u.mp).toBe(0);
  });

  it('a Firebolt kill is magic XP', () => {
    const s = makeTestState();
    const c = at(3, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['firebolt'] });
    const foe = makeTestUnit(s, 'thorn', off(c, 3), { hp: 5, level: 2 });
    expect(applyAction(s, { type: 'skill', unit: u.id, skill: 'firebolt', target: foe.pos }).ok).toBe(true);
    expect(s.units[String(foe.id)]).toBeUndefined();
    expect(u.xpByCat.magic).toBe(2 + 16); // cast + kill (8 × level 2)
    expect(u.xpByCat.melee + u.xpByCat.ranged).toBe(0);
    expect(u.kills).toBe(1);
  });

  it('Volley hits every enemy around the target at 60% damage', () => {
    const s = makeTestState();
    const c = at(3, 5);
    const u = makeTestUnit(s, 'valen', c, { items: ['bow'], actives: ['volley'], passives: ['marksman'] });
    const t = off(c, 2);
    const a = makeTestUnit(s, 'thorn', t, { base: big(), hp: 200 });
    const b = makeTestUnit(s, 'thorn', off(t, 1), { base: big(), hp: 200 });
    const friend = makeTestUnit(s, 'valen', off(t, 0, 1));
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'volley', target: off(c, 3) })).toMatch(/range/);
    let total = 0;
    for (let i = 0; i < 10; i++) {
      u.acted = false; u.cooldowns = {}; a.hp = 200; b.hp = 200;
      s.rngState = 31 + i * 17;
      const r = applyAction(s, { type: 'skill', unit: u.id, skill: 'volley', target: t });
      expect(r.ok).toBe(true);
      const dmgA = 200 - a.hp, dmgB = 200 - b.hp;
      // bow: (6 + 2) × 0.6 = 4.8 → 5 per arrow
      expect(dmgA % 5).toBe(0);
      expect(dmgB % 5).toBe(0);
      total += dmgA + dmgB;
    }
    expect(total).toBeGreaterThan(0);
    expect(friend.hp).toBe(COMMONER_STATS.maxHp); // friends under the arrows are spared
    expect(u.acted).toBe(true);
  });

  it('Blink teleports to an empty explored hex within 3 and explores ruins there', () => {
    const s = makeTestState();
    const c = at(3, 5);
    const u = makeTestUnit(s, 'valen', c, { actives: ['blink'] });
    makeTestUnit(s, 'thorn', off(c, 2));
    const dest = off(c, 3);
    setTerrain(s, dest, 'ruins');
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'blink', target: off(c, 2) })).toMatch(/occupied/);
    expect(validateAction(s, { type: 'skill', unit: u.id, skill: 'blink', target: off(c, 4) })).toMatch(/range/);
    const targets = skillTargets(s, u, 'blink');
    expect(targets.every((h) => hexDistance(h, c) >= 1 && hexDistance(h, c) <= 3)).toBe(true);
    expect(targets.some((h) => hexEq(h, off(c, 2)))).toBe(false);
    const r = applyAction(s, { type: 'skill', unit: u.id, skill: 'blink', target: dest });
    expect(r.ok).toBe(true);
    expect(hexEq(u.pos, dest)).toBe(true);
    expect(u.mp).toBe(0);
    expect(types(r.events)).toContain('ruinsExplored');
  });
});

describe('idleUnits', () => {
  it('lists units with movement or an attack left', () => {
    const s = makeTestState();
    const a = makeTestUnit(s, 'valen', at(2, 2));
    const b = makeTestUnit(s, 'valen', at(5, 5), { mp: 0 });
    const c = makeTestUnit(s, 'valen', at(8, 5), { mp: 0 });
    makeTestUnit(s, 'thorn', off(at(8, 5), 1));
    makeTestUnit(s, 'thorn', at(10, 9));
    expect(idleUnits(s)).toEqual([a.id, c.id]);
    c.acted = true;
    expect(idleUnits(s)).toEqual([a.id]);
    void b;
  });
});
