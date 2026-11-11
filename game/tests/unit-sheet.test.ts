// Data behind the unit sheet: the level history (Unit.learned) and statBreakdown, which must add up
// to effectiveStats exactly for every kind of unit.
import { describe, expect, it } from 'vitest';
import type { GameState, MonsterKind, Unit, UnitStats } from '../src/core/types';
import { COMMONER_STATS, LEADER_STATS, PRESET_LIST } from '../src/data/presets';
import { FACTIONS, MONSTERS, PLAYABLE_FACTIONS } from '../src/data/factions';
import { ITEMS } from '../src/data/items';
import { PASSIVES, xpToNext } from '../src/data/skills';
import { applyLevelOption, grantXp } from '../src/sim/progression';
import { applyAction } from '../src/sim/actions';
import { createGame } from '../src/sim/state';
import { startTurn } from '../src/sim/turn';
import { ARMOR_MAX, HP_PER_LEVEL, createUnit, effectiveStats, statBreakdown } from '../src/sim/units';
import { at, makeTestState, makeTestUnit } from './helpers';

const KEYS: (keyof UnitStats)[] = ['maxHp', 'str', 'dex', 'int', 'armor', 'block', 'mov', 'vis'];

/** base + Σ contributions === total === effectiveStats, for every stat. */
function expectExact(s: GameState, u: Unit): void {
  const eff = effectiveStats(s, u);
  const bd = statBreakdown(s, u);
  for (const k of KEYS) {
    const line = bd[k];
    const sum = line.base + line.contributions.reduce((t, c) => t + c.value, 0);
    expect({ unit: u.name, stat: k, sum, total: line.total }).toEqual({ unit: u.name, stat: k, sum: eff[k], total: eff[k] });
    for (const c of line.contributions) expect(c.value).not.toBe(0);
  }
}

function freshGame(): GameState {
  return createGame({ mapSize: 'small', seed: 31, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });
}

describe('level history', () => {
  it('records the level each queued choice belongs to', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(3, 3), {
      level: 3, pendingLevelUps: 2, levelUpOptions: [['stat_str', 'stat_dex', 'stat_int'], ['stat_hp', 'stat_vis', 'stat_mov']],
    });
    applyLevelOption(s, u, 'stat_dex');
    expect(u.learned).toEqual([{ level: 2, option: 'stat_dex' }]);
    applyLevelOption(s, u, 'stat_hp');
    expect(u.learned).toEqual([{ level: 2, option: 'stat_dex' }, { level: 3, option: 'stat_hp' }]);
    expect(u.pendingLevelUps).toBe(0);
    // A rejected pick records nothing.
    applyLevelOption(s, u, 'stat_str');
    expect(u.learned).toHaveLength(2);
  });

  it('two levels gained at once, then picked through actions, and the AI picking for itself', () => {
    const s = freshGame();
    const u = Object.values(s.units).find((x) => x.faction === 'valen' && !x.isLeader)!;
    expect(u.learned).toEqual([]);
    grantXp(s, u, 'melee', xpToNext(1) + xpToNext(2));
    expect(u.level).toBe(3);
    expect(u.pendingLevelUps).toBe(2);
    expect(applyAction(s, { type: 'levelup', unit: u.id, option: u.levelUpOptions[0][0] }).ok).toBe(true);
    expect(applyAction(s, { type: 'levelup', unit: u.id, option: u.levelUpOptions[0][1] }).ok).toBe(true);
    expect(u.learned!.map((l) => l.level)).toEqual([2, 3]);

    const ai = Object.values(s.units).find((x) => x.faction === 'thorn' && !x.isLeader)!;
    grantXp(s, ai, 'building', xpToNext(1));
    startTurn(s, 'thorn'); // the AI resolves its level-ups at its turn start
    expect(ai.learned).toHaveLength(1);
    expect(ai.learned![0].level).toBe(2);
  });
});

describe('statBreakdown', () => {
  it('adds up to effectiveStats for every preset of every house, leaders and monsters', () => {
    const s = freshGame();
    let col = 0;
    const pos = () => at(col++ % s.width, 0);
    for (const f of PLAYABLE_FACTIONS) {
      for (const p of PRESET_LIST) expectExact(s, createUnit(s, { faction: f, pos: pos(), preset: p.id }));
      expectExact(s, createUnit(s, { faction: f, pos: pos(), isLeader: true, level: 4 }));
    }
    for (const m of Object.keys(MONSTERS) as MonsterKind[]) {
      expectExact(s, createUnit(s, { faction: 'neutral', pos: pos(), monster: m }));
      expectExact(s, createUnit(s, { faction: 'neutral', pos: pos(), monster: m, level: MONSTERS[m].level + 2 }));
    }
    for (const u of Object.values(s.units)) expectExact(s, u);
  });

  it('splits the base into the house, level-ups and stat picks', () => {
    const s = freshGame();
    const orc = createUnit(s, { faction: 'thorn', pos: at(1, 1) });
    const bd = statBreakdown(s, orc);
    for (const k of KEYS) expect(bd[k].base).toBe(COMMONER_STATS[k]);
    expect(bd.maxHp.contributions).toEqual([{ source: FACTIONS.thorn.name, kind: 'faction', value: 5 }]);
    expect(bd.int.contributions).toEqual([{ source: FACTIONS.thorn.name, kind: 'faction', value: -1 }]);

    const leader = Object.values(s.units).find((u) => u.isLeader && u.faction === 'valen')!;
    const lb = statBreakdown(s, leader);
    expect(lb.maxHp.base).toBe(LEADER_STATS.maxHp);
    expect(lb.maxHp.contributions).toContainEqual({ source: `Level-ups (1 × +${HP_PER_LEVEL})`, kind: 'other', value: HP_PER_LEVEL });
    expect(lb.armor.contributions).toContainEqual({ source: ITEMS.tunic.name, kind: 'item', value: 5, item: 'tunic' });
    expect(lb.block.base).toBe(LEADER_STATS.block);
    expect(lb.block.contributions).toContainEqual({ source: ITEMS.tunic.name, kind: 'item', value: 1, item: 'tunic' });

    // Two levels, one of them a +3 Strength pick: base is the commoner's again.
    const u = createUnit(s, { faction: 'valen', pos: at(2, 1), preset: 'swordsman' });
    grantXp(s, u, 'melee', xpToNext(1) + xpToNext(2));
    u.levelUpOptions = [['stat_str', 'eff_attack', 'passive_ironskin'], ['eff_attack', 'stat_mov', 'passive_poison']];
    applyLevelOption(s, u, 'stat_str');
    applyLevelOption(s, u, 'eff_attack');
    const ub = statBreakdown(s, u);
    for (const k of KEYS) expect(ub[k].base).toBe(COMMONER_STATS[k]);
    expect(ub.str.contributions).toContainEqual({ source: 'Level 2: +3 Strength', kind: 'other', value: 3, option: 'stat_str' });
    expect(ub.maxHp.contributions).toContainEqual({ source: `Level-ups (2 × +${HP_PER_LEVEL})`, kind: 'other', value: 2 * HP_PER_LEVEL });
    expectExact(s, u);
  });

  it('items, the mount, Iron Skin, buffs and the caps', () => {
    const s = freshGame();
    const knight = createUnit(s, { faction: 'ashen', pos: at(1, 1), preset: 'knight' });
    // Two +Armor picks (+1 block, +5% armor each): the house's 5, shield 5, plate 25 and both
    // buffs (10 + 20) then come to 75%, over the cap.
    grantXp(s, knight, 'melee', xpToNext(1) + xpToNext(2));
    knight.levelUpOptions = [['stat_armor', 'stat_str', 'stat_hp'], ['stat_armor', 'stat_str', 'stat_hp']];
    applyLevelOption(s, knight, 'stat_armor');
    applyLevelOption(s, knight, 'stat_armor');
    knight.passives.push('ironskin');
    knight.buffs.push({ id: 'bless', turns: 2, damageMult: 1.2, armor: 10 }, { id: 'fortify', turns: 1, armor: 20 }, { id: 'haste', turns: 1 });
    const bd = statBreakdown(s, knight);
    expect(bd.mov.contributions).toContainEqual({ source: ITEMS.horse.name, kind: 'mount', value: 3, item: 'horse' });
    expect(bd.mov.contributions).toContainEqual({ source: ITEMS.plate.name, kind: 'item', value: -1, item: 'plate' });
    expect(bd.block.contributions).toContainEqual({ source: PASSIVES.ironskin.name, kind: 'passive', value: 1, passive: 'ironskin' });
    expect(bd.block.contributions.some((c) => c.kind === 'buff')).toBe(false); // Fortify is armor only
    expect(bd.block.contributions.filter((c) => c.option === 'stat_armor').map((c) => c.value)).toEqual([1, 1]);
    expect(bd.block.base).toBe(COMMONER_STATS.block);
    expect(bd.block.total).toBe(2 + 2 + 3 + 1); // picks, shield, plate, Iron Skin (rank 1)
    expect(bd.armor.contributions.some((c) => c.passive === 'ironskin')).toBe(false);
    expect(bd.armor.contributions).toContainEqual(expect.objectContaining({ kind: 'buff', buff: 'bless', value: 10 }));
    expect(bd.armor.contributions).toContainEqual(expect.objectContaining({ kind: 'buff', buff: 'fortify', value: 20 }));
    const cap = bd.armor.contributions.at(-1)!;
    expect(cap).toMatchObject({ kind: 'other', source: `Armor cap (${ARMOR_MAX})` });
    expect(cap.value).toBeLessThan(0);
    expect(bd.armor.total).toBe(ARMOR_MAX);
    expectExact(s, knight);

    // Floors: a stat pushed below its minimum is lifted, and the lift is shown.
    const lame = createUnit(s, { faction: 'valen', pos: at(2, 1), preset: 'knight' });
    lame.base.mov = -4;
    lame.base.int = -9;
    const lb = statBreakdown(s, lame);
    expect(lb.mov.total).toBe(1);
    expect(lb.mov.contributions.at(-1)).toMatchObject({ kind: 'other', source: 'Minimum Movement (1)' });
    expect(lb.int.total).toBe(0);
    expectExact(s, lame);

    // Monsters wear nothing: their stats are their own (plus buffs), never the house's.
    const golem = createUnit(s, { faction: 'valen', pos: at(3, 1), monster: 'elemental' });
    golem.buffs.push({ id: 'fortify', turns: 1, armor: 20 });
    const gb = statBreakdown(s, golem);
    expect(gb.armor.base).toBe(MONSTERS.elemental.stats.armor);
    expect(gb.armor.contributions).toEqual([expect.objectContaining({ kind: 'buff', value: 20 })]);
    expect(gb.block.base).toBe(MONSTERS.elemental.stats.block);
    expect(gb.block.contributions).toEqual([]);
    expect(gb.dex.contributions).toEqual([]);
    expectExact(s, golem);
  });
});
