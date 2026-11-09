// Controller logic: pure interaction helpers (click resolution, attack-kind choice, move+attack
// planning, key mapping) and session (save envelope, settings parsing).
import { describe, expect, it } from 'vitest';
import type { AttackKind, CombatForecast, Hex, ReachInfo } from '../src/core/types';
import {
  altAttackOf, barSkills, buildMenuBlock, CAMERA_CODES, cameraKeyNames, chooseAttackKind, cycleNext, edgePanKeys, effectAreaTone, END_TURN_GRACE_MS, END_TURN_REPEAT_MS,
  endTurnAllowed, friendlyFire, hotkeyModalAction, isClickGesture, isTypingTarget, keyToCommand,
  pickApproach, resolveClick, returnTarget, SKILL_HOTKEYS, skillSlotOf, tradeScore, type ApproachCandidate, type ClickContext, type KindOption,
} from '../src/game/interaction';
import type { EffectPreview } from '../src/core/types';
import { aOrAn } from '../src/core/text';
import { siteError } from '../src/sim/economy';
import { FogMemory } from '../src/game/fogmemory';
import { canBuildAt, startBuilding } from '../src/sim/economy';
import { canBuildWith } from '../src/sim/units';
import { tileIndex } from '../src/core/hex';
import {
  AUTOSAVE_KEY, DEFAULT_SETTINGS, deleteSave, describeSave, hasSavedGame, latestSlot, loadGameState, parseSave, parseSettings, SAVE_KEY,
  saveGameState, saveInfo, savesInfo, wrapSave, type KV,
} from '../src/game/session';
import { makeTestState, makeTestUnit, at } from './helpers';

function fc(dealt: number, taken: number, opts: Partial<CombatForecast> = {}, canRetaliate = true): CombatForecast {
  const prof = (kind: AttackKind) => ({ kind, name: kind, damage: 5, strikes: 2, hitChance: 0.6, range: 1, firststrike: false });
  return {
    attacker: prof('melee'),
    defender: canRetaliate ? prof('melee') : null,
    attackerHpDist: [], defenderHpDist: [],
    attackerKillChance: 0, defenderKillChance: 0,
    expectedDamageToDefender: dealt, expectedDamageToAttacker: taken,
    ...opts,
  };
}
const opt = (kind: AttackKind, f: CombatForecast): KindOption => ({ kind, forecast: f });

describe('chooseAttackKind', () => {
  it('returns null / the only option', () => {
    expect(chooseAttackKind([])).toBeNull();
    const m = opt('melee', fc(5, 3));
    expect(chooseAttackKind([m])).toBe(m);
    expect(chooseAttackKind([m], true)).toBe(m); // nothing to swap to
  });

  it('prefers ranged when the defender cannot retaliate at range', () => {
    const m = opt('melee', fc(12, 2));
    const r = opt('ranged', fc(4, 0, {}, false));
    expect(chooseAttackKind([m, r])?.kind).toBe('ranged');
    expect(chooseAttackKind([m, r], true)?.kind).toBe('melee');
  });

  it('compares trades when both can be retaliated', () => {
    const m = opt('melee', fc(10, 2));
    const r = opt('magic', fc(6, 5));
    expect(chooseAttackKind([m, r])?.kind).toBe('melee');
    expect(chooseAttackKind([m, r], true)?.kind).toBe('magic');
    const r2 = opt('ranged', fc(9, 1));
    expect(chooseAttackKind([opt('melee', fc(9, 1)), r2])?.kind).toBe('ranged'); // tie → ranged
  });

  it('weights kill chances', () => {
    const m = opt('melee', fc(8, 6, { defenderKillChance: 0.9 }));
    const r = opt('ranged', fc(9, 2));
    expect(tradeScore(m.forecast)).toBeGreaterThan(tradeScore(r.forecast));
    expect(chooseAttackKind([m, r])?.kind).toBe('melee');
  });
});

describe('pickApproach', () => {
  const cand = (q: number, defense: number, cost: number, options: KindOption[]): ApproachCandidate => ({ hex: { q, r: 0 }, defense, cost, options });

  it('returns null without candidates or options', () => {
    expect(pickApproach([])).toBeNull();
    expect(pickApproach([cand(1, 60, 1, [])])).toBeNull();
  });

  it('prefers the better trade, then the higher defense, then the cheaper walk', () => {
    const a = cand(1, 40, 1, [opt('melee', fc(8, 6))]);
    const b = cand(2, 60, 3, [opt('melee', fc(8, 4))]);
    expect(pickApproach([a, b])?.hex.q).toBe(2);
    // identical trades: defense decides
    const c = cand(3, 50, 1, [opt('melee', fc(8, 4))]);
    const d = cand(4, 60, 2, [opt('melee', fc(8, 4))]);
    expect(pickApproach([c, d])?.hex.q).toBe(4);
  });

  it('archer picks a hex at range where the target cannot retaliate', () => {
    const adjacent = cand(1, 60, 1, [opt('melee', fc(2, 6)), opt('ranged', fc(9, 5))]);
    const atRange = cand(2, 40, 2, [opt('ranged', fc(9, 0, {}, false))]);
    const p = pickApproach([adjacent, atRange]);
    expect(p?.hex.q).toBe(2);
    expect(p?.option.kind).toBe('ranged');
  });

  it('swap prefers the non-default kind, else falls back', () => {
    const adjacent = cand(1, 60, 1, [opt('melee', fc(4, 3)), opt('ranged', fc(9, 5))]);
    const atRange = cand(2, 40, 2, [opt('ranged', fc(9, 0, {}, false))]);
    const p = pickApproach([adjacent, atRange], true);
    expect(p?.option.kind).toBe('melee');
    expect(p?.hex.q).toBe(1);
    const only = pickApproach([atRange], true);
    expect(only?.option.kind).toBe('ranged');
  });
});

describe('resolveClick', () => {
  const reach = (hexes: Hex[]): ReachInfo[] => hexes.map((hex) => ({ hex, cost: 1, mpLeft: 3, path: [hex], zocStop: false }));
  const base = (over: Partial<ClickContext>): ClickContext => ({
    hex: { q: 5, r: 5 }, button: 'left', swap: false, mode: { kind: 'idle' }, human: 'valen', myTurn: true,
    unitAt: null, selected: null, reach: [],
    attackFromHere: () => null, approach: () => null,
    ...over,
  });
  const melee = opt('melee', fc(5, 2));

  it('idle: selects units, otherwise the tile', () => {
    expect(resolveClick(base({ unitAt: { id: 3, faction: 'valen' } }))).toEqual({ kind: 'select', unit: 3 });
    expect(resolveClick(base({ unitAt: { id: 4, faction: 'thorn' } }))).toEqual({ kind: 'select', unit: 4 });
    expect(resolveClick(base({}))).toEqual({ kind: 'tile', hex: { q: 5, r: 5 } });
  });

  it('selected unit: moves to reachable hexes', () => {
    const ctx = base({ mode: { kind: 'unit', unit: 1 }, selected: { id: 1, faction: 'valen' }, reach: reach([{ q: 5, r: 5 }]) });
    expect(resolveClick(ctx)).toEqual({ kind: 'move', unit: 1, to: { q: 5, r: 5 } });
    expect(resolveClick({ ...ctx, hex: { q: 9, r: 9 } })).toEqual({ kind: 'tile', hex: { q: 9, r: 9 } });
  });

  it('selected unit: attacks in range, move-attacks when approachable, inspects otherwise', () => {
    const sel = { mode: { kind: 'unit', unit: 1 } as const, selected: { id: 1, faction: 'valen' as const }, unitAt: { id: 7, faction: 'thorn' as const } };
    expect(resolveClick(base({ ...sel, attackFromHere: () => melee }))).toEqual({ kind: 'attack', unit: 1, target: 7, attack: 'melee' });
    expect(resolveClick(base({ ...sel, approach: () => ({ hex: { q: 4, r: 5 }, option: melee }) })))
      .toEqual({ kind: 'moveAttack', unit: 1, to: { q: 4, r: 5 }, target: 7, attack: 'melee' });
    expect(resolveClick(base(sel))).toEqual({ kind: 'select', unit: 7 });
  });

  it('passes shift-swap through to attack planning', () => {
    let seen: boolean | null = null;
    const ctx = base({
      mode: { kind: 'unit', unit: 1 }, selected: { id: 1, faction: 'valen' }, unitAt: { id: 7, faction: 'thorn' }, swap: true,
      attackFromHere: (_t, swap) => { seen = swap; return opt(swap ? 'ranged' : 'melee', fc(1, 1)); },
    });
    expect(resolveClick(ctx)).toEqual({ kind: 'attack', unit: 1, target: 7, attack: 'ranged' });
    expect(seen).toBe(true);
  });

  it('not my turn: own selection cannot act', () => {
    const ctx = base({ myTurn: false, mode: { kind: 'unit', unit: 1 }, selected: { id: 1, faction: 'valen' }, reach: reach([{ q: 5, r: 5 }]) });
    expect(resolveClick(ctx)).toEqual({ kind: 'tile', hex: { q: 5, r: 5 } });
  });

  it('past the reach: heads there, or explains why not, keeping the selection', () => {
    const mode = { kind: 'unit', unit: 1 } as const;
    const far = base({ mode, selected: { id: 1, faction: 'valen' }, hex: { q: 9, r: 9 } });
    expect(resolveClick(far).kind).toBe('tile');   // no trip planner (no movement left): inspect the tile
    expect(resolveClick({ ...far, towardCheck: () => null })).toEqual({ kind: 'moveToward', unit: 1, to: { q: 9, r: 9 } });
    expect(resolveClick({ ...far, towardCheck: () => 'No way there' })).toEqual({ kind: 'invalid', reason: 'No way there' });
  });

  it('right click always cancels, even on an enemy offering two attack kinds', () => {
    expect(resolveClick(base({ button: 'right' }))).toEqual({ kind: 'cancel' });
    const sel = { mode: { kind: 'unit', unit: 1 } as const, selected: { id: 1, faction: 'valen' as const }, unitAt: { id: 7, faction: 'thorn' as const } };
    const alt = (_t: number, swap: boolean) => (swap ? opt('ranged', fc(3, 0)) : melee);
    const approach = () => ({ hex: { q: 4, r: 5 }, option: opt('ranged', fc(3, 0)) });
    expect(resolveClick(base({ ...sel, button: 'right', attackFromHere: alt }))).toEqual({ kind: 'cancel' });
    expect(resolveClick(base({ ...sel, button: 'right', approach }))).toEqual({ kind: 'cancel' });
    // the alternative kind is Shift+click
    expect(resolveClick(base({ ...sel, swap: true, attackFromHere: alt }))).toEqual({ kind: 'attack', unit: 1, target: 7, attack: 'ranged' });
  });

  it('cast and skill modes validate the target', () => {
    const cast = base({ mode: { kind: 'cast', spell: 'fireball', tower: null }, castCheck: () => ({ tower: 12 }) });
    expect(resolveClick(cast)).toEqual({ kind: 'cast', spell: 'fireball', tower: 12, target: { q: 5, r: 5 } });
    expect(resolveClick({ ...cast, castCheck: () => ({ error: 'Out of range' }) })).toEqual({ kind: 'invalid', reason: 'Out of range' });
    expect(resolveClick({ ...cast, button: 'right' })).toEqual({ kind: 'cancel' });
    const skill = base({ mode: { kind: 'skill', unit: 2, skill: 'blink' }, skillCheck: () => null });
    expect(resolveClick(skill)).toEqual({ kind: 'skill', unit: 2, skill: 'blink', target: { q: 5, r: 5 } });
    expect(resolveClick({ ...skill, skillCheck: () => 'Too far' })).toEqual({ kind: 'invalid', reason: 'Too far' });
    expect(resolveClick({ ...skill, myTurn: false })).toEqual({ kind: 'none' });
  });
});

describe('attack command (T, the command bar)', () => {
  const base = (over: Partial<ClickContext>): ClickContext => ({
    hex: { q: 5, r: 5 }, button: 'left', swap: false, mode: { kind: 'attack', unit: 1 }, human: 'valen', myTurn: true,
    unitAt: null, selected: { id: 1, faction: 'valen' }, reach: [],
    attackFromHere: () => null, approach: () => null,
    ...over,
  });
  const melee = opt('melee', fc(5, 2));
  const enemy = { id: 7, faction: 'thorn' as const };

  it('a target in reach: the same attack a click does with the unit selected', () => {
    expect(resolveClick(base({ unitAt: enemy, attackFromHere: () => melee }))).toEqual({ kind: 'attack', unit: 1, target: 7, attack: 'melee' });
    expect(resolveClick(base({ unitAt: enemy, approach: () => ({ hex: { q: 4, r: 5 }, option: melee }) })))
      .toEqual({ kind: 'moveAttack', unit: 1, to: { q: 4, r: 5 }, target: 7, attack: 'melee' });
    // wild monsters are targets too
    expect(resolveClick(base({ unitAt: { id: 9, faction: 'neutral' }, attackFromHere: () => melee }))).toEqual({ kind: 'attack', unit: 1, target: 9, attack: 'melee' });
  });

  it('matches unit mode on every target', () => {
    const alt = (_t: number, swap: boolean) => (swap ? opt('ranged', fc(3, 0)) : melee);
    for (const over of [
      { attackFromHere: () => melee },
      { approach: () => ({ hex: { q: 4, r: 5 }, option: melee }) },
      { attackFromHere: alt, swap: true },
    ] as Partial<ClickContext>[]) {
      const inAttack = resolveClick(base({ unitAt: enemy, ...over }));
      const inUnit = resolveClick(base({ unitAt: enemy, mode: { kind: 'unit', unit: 1 }, ...over }));
      expect(inAttack).toEqual(inUnit);
    }
  });

  it('passes Shift through to the attack choice', () => {
    let seen: boolean | null = null;
    const ctx = base({ unitAt: enemy, swap: true, attackFromHere: (_t, swap) => { seen = swap; return opt(swap ? 'ranged' : 'melee', fc(1, 1)); } });
    expect(resolveClick(ctx)).toEqual({ kind: 'attack', unit: 1, target: 7, attack: 'ranged' });
    expect(seen).toBe(true);
  });

  it('anything but a target cancels back to the unit (never selects, moves or inspects)', () => {
    const reach: ReachInfo[] = [{ hex: { q: 5, r: 5 }, cost: 1, mpLeft: 2, path: [{ q: 5, r: 5 }], zocStop: false }];
    expect(resolveClick(base({}))).toEqual({ kind: 'cancel' });                                       // empty hex
    expect(resolveClick(base({ reach }))).toEqual({ kind: 'cancel' });                                // even one it could walk to
    expect(resolveClick(base({ unitAt: { id: 3, faction: 'valen' } }))).toEqual({ kind: 'cancel' });  // a friend
    expect(resolveClick(base({ unitAt: enemy }))).toEqual({ kind: 'cancel' });                        // an enemy out of reach
    expect(resolveClick(base({ unitAt: enemy, attackFromHere: () => melee, button: 'right' }))).toEqual({ kind: 'cancel' });
    // an approach plan that would stand on the clicked hex is no attack
    expect(resolveClick(base({ unitAt: enemy, approach: () => ({ hex: { q: 5, r: 5 }, option: melee }) }))).toEqual({ kind: 'cancel' });
  });

  it('does nothing off turn and never attacks with another house\'s unit', () => {
    expect(resolveClick(base({ unitAt: enemy, attackFromHere: () => melee, myTurn: false }))).toEqual({ kind: 'none' });
    expect(resolveClick(base({ unitAt: enemy, attackFromHere: () => melee, selected: { id: 1, faction: 'thorn' } }))).toEqual({ kind: 'cancel' });
    expect(resolveClick(base({ unitAt: enemy, attackFromHere: () => melee, selected: null }))).toEqual({ kind: 'cancel' });
  });

  it('number keys follow the bar: activated skills only, in order', () => {
    const cd: Record<string, number> = { powerstrike: 3, masonry: 0, volley: 4, heal: 2 };
    expect(barSkills(['powerstrike', 'masonry', 'volley', 'heal'], (a) => cd[a])).toEqual(['powerstrike', 'volley', 'heal']);
    expect(barSkills(['unknown'], () => undefined)).toEqual([]);
    expect(SKILL_HOTKEYS).toBe(6);
    expect(skillSlotOf('skill1')).toBe(0);
    expect(skillSlotOf('skill6')).toBe(5);
    expect(skillSlotOf('attack')).toBeNull();
    expect(skillSlotOf('save')).toBeNull();
  });

  it('the details sheet switches with the light windows, never over a decision', () => {
    expect(hotkeyModalAction(null, 'unitsheet')).toBe('open');
    expect(hotkeyModalAction('unitsheet', 'unitsheet')).toBe('close');
    expect(hotkeyModalAction('research', 'unitsheet')).toBe('open');
    expect(hotkeyModalAction('unitsheet', 'research')).toBe('open');
    expect(hotkeyModalAction('levelup', 'unitsheet')).toBe('none');
    expect(hotkeyModalAction('end', 'unitsheet')).toBe('none');
  });
});

describe('build menu gate', () => {
  it('a leader without tools may open the Build menu and found a castle', () => {
    const s = makeTestState();
    const leader = makeTestUnit(s, 'valen', at(5, 5), { isLeader: true, items: ['sword'] });
    expect(canBuildWith(leader)).toBe(false);
    expect(canBuildAt(s, leader, 'castle')).toBeNull();
    expect(buildMenuBlock(leader, canBuildWith(leader))).toBeNull();
    // the other cards explain themselves inside the menu
    expect(canBuildAt(s, leader, 'farm')).toMatch(/Tools/);
  });

  it('other units need Builder\'s Tools', () => {
    const s = makeTestState();
    const soldier = makeTestUnit(s, 'valen', at(5, 5), { items: ['sword'] });
    const builder = makeTestUnit(s, 'valen', at(6, 5), { items: ['tools'] });
    expect(buildMenuBlock(soldier, canBuildWith(soldier))).toMatch(/Builder's Tools/);
    expect(buildMenuBlock(builder, canBuildWith(builder))).toBeNull();
  });
});

describe('fog memory', () => {
  it('keeps the last-seen building under the fog and ignores changes made out of sight', () => {
    const s = makeTestState();
    const fs = s.factions.valen;
    const foe = makeTestUnit(s, 'thorn', at(8, 6), { isLeader: true });
    const mem = new FogMemory();
    mem.update(s, 'valen', true);
    const i = tileIndex(foe.pos, s.width);
    expect(mem.buildings[i]).toBeNull();
    // the hex falls out of sight, then the enemy founds a castle there
    fs.visible[i] = 0;
    startBuilding(s, foe, 'castle');
    mem.update(s, 'valen');
    expect(mem.buildings[i]).toBeNull();
    expect(mem.territory[i]).toBeNull();
    // seen again: remembered as it is now, and kept once fogged again
    fs.visible[i] = 1;
    mem.update(s, 'valen');
    expect(mem.buildings[i]?.type).toBe('castle');
    expect(mem.territory[i]).toBe('thorn');
    fs.visible[i] = 0;
    s.buildings[String(mem.buildings[i]!.id)].buildLeft = 0;
    mem.update(s, 'valen');
    expect(mem.buildings[i]?.buildLeft).toBeGreaterThan(0);
  });
});

describe('end turn grace, window hotkeys, targeting tone', () => {
  it('ignores end-turn presses in the first moments of the turn', () => {
    expect(endTurnAllowed(1000, 900)).toBe(false);
    expect(endTurnAllowed(900 + END_TURN_GRACE_MS - 1, 900)).toBe(false);
    expect(endTurnAllowed(900 + END_TURN_GRACE_MS, 900)).toBe(true);
    expect(endTurnAllowed(2000, 900, 1000)).toBe(true);
    expect(endTurnAllowed(1800, 900, 1000)).toBe(false);
    // no player turn began yet in this session (a game just loaded): never blocked
    expect(endTurnAllowed(5, -Infinity)).toBe(true);
    // a press right after another one (mashing, a double tap) never counts, even late in the turn
    expect(endTurnAllowed(10_000, 0, END_TURN_GRACE_MS, 10_000 - 120)).toBe(false);
    expect(endTurnAllowed(10_000, 0, END_TURN_GRACE_MS, 10_000 - END_TURN_REPEAT_MS)).toBe(true);
  });

  it('window hotkeys never replace a decision window', () => {
    expect(hotkeyModalAction('end', 'forge')).toBe('none');
    expect(hotkeyModalAction('levelup', 'forge')).toBe('none');
    expect(hotkeyModalAction('levelup', 'help')).toBe('none');
    expect(hotkeyModalAction('settings', 'research')).toBe('none');
    expect(hotkeyModalAction('newgame', 'help')).toBe('none');
    expect(hotkeyModalAction('forge', 'help')).toBe('open');
    expect(hotkeyModalAction('recruit', 'research')).toBe('open');
    expect(hotkeyModalAction('build', 'forge')).toBe('open');
    expect(hotkeyModalAction('forge', 'forge')).toBe('close');
    expect(hotkeyModalAction(null, 'forge')).toBe('open');
  });

  it('settings and help opened from the menu return to it', () => {
    expect(returnTarget('menu', 'settings')).toBe('menu');
    expect(returnTarget('menu', 'help')).toBe('menu');
    expect(returnTarget(null, 'settings')).toBeNull();
    expect(returnTarget('research', 'help')).toBeNull();
    expect(returnTarget('menu', 'research')).toBeNull();
  });

  it('equip and level-up opened from a unit sheet return to the sheet', () => {
    expect(returnTarget('unitsheet', 'equip')).toBe('unitsheet');
    expect(returnTarget('unitsheet', 'levelup')).toBe('unitsheet');
    expect(returnTarget('unitsheet', 'research')).toBeNull();
    expect(returnTarget(null, 'equip')).toBeNull();
    expect(returnTarget('build', 'equip')).toBeNull();
  });

  it('colours harmful areas and flags friendly fire', () => {
    const e = (own: boolean, hpDelta: number) => ({ unit: 1, own, hpBefore: 20, maxHp: 20, hpDelta, killChance: 0 });
    const harm = (entries: ReturnType<typeof e>[]): EffectPreview => ({ tone: 'harm', entries, notes: [] });
    expect(effectAreaTone(null)).toBe('help');
    expect(effectAreaTone({ tone: 'help', entries: [e(true, 10)], notes: [] })).toBe('help');
    expect(effectAreaTone(harm([e(false, -8)]))).toBe('harm');
    expect(effectAreaTone(harm([e(false, -8), e(true, -8)]))).toBe('warn');
    expect(friendlyFire(harm([e(false, -8), e(true, -8)]))).toHaveLength(1);
    expect(friendlyFire({ tone: 'help', entries: [e(true, 5)], notes: [] })).toEqual([]);
  });

  it('offers the Shift attack only when it differs', () => {
    const m = { option: opt('melee', fc(5, 3)) };
    const r = { option: opt('ranged', fc(4, 0)) };
    expect(altAttackOf(m, r)).toBe(r);
    expect(altAttackOf(m, { option: opt('melee', fc(5, 3)) })).toBeNull();
    expect(altAttackOf(m, null)).toBeNull();
  });

  it('camera keys: codes only (no double rotation), +/- zoom keys forwarded', () => {
    expect(cameraKeyNames({ code: 'KeyQ' })).toEqual(['KeyQ']);
    for (const c of ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'PageUp', 'PageDown']) {
      expect(CAMERA_CODES.has(c)).toBe(true);
      expect(keyToCommand({ key: '', code: c })).toBeNull();
    }
    expect(keyToCommand({ key: 'x', code: 'KeyX' })).toBe('skipUnit');
  });

  it('article and site checks', () => {
    expect(aOrAn('Iron Mine')).toBe('an Iron Mine');
    expect(aOrAn('Archer')).toBe('an Archer');
    expect(aOrAn('Farm')).toBe('a Farm');
    expect(aOrAn('Unicorn')).toBe('a Unicorn');
    const s = makeTestState(14, 10);
    s.buildings['900'] = { id: 900, type: 'castle', owner: 'valen', pos: at(3, 3), level: 1, buildLeft: 0, upgrading: false, recruitedThisTurn: false, craftedThisTurn: 0, foundedRound: 0 };
    s.tiles[tileIndex(at(3, 3), s.width)].building = 900;
    expect(siteError(s, 'valen', at(4, 3), 'farm')).toBeNull();               // inside the territory
    expect(siteError(s, 'valen', at(11, 8), 'farm')).toMatch(/inside or adjacent/);
    expect(siteError(s, 'valen', at(3, 3), 'farm')).toMatch(/already a building/);
    expect(siteError(s, 'thorn', at(4, 3), 'farm')).toMatch(/another faction/);
  });
});

describe('small helpers', () => {
  it('click vs drag threshold', () => {
    expect(isClickGesture(0, 0)).toBe(true);
    expect(isClickGesture(4, 4)).toBe(true);
    expect(isClickGesture(5, 5)).toBe(false);
    expect(isClickGesture(10, 0, 12)).toBe(true);
  });

  it('cycleNext wraps', () => {
    expect(cycleNext([], null)).toBeNull();
    expect(cycleNext([3, 5, 9], null)).toBe(3);
    expect(cycleNext([3, 5, 9], 5)).toBe(9);
    expect(cycleNext([3, 5, 9], 9)).toBe(3);
    expect(cycleNext([3, 5, 9], 42)).toBe(3);
  });

  it('maps keys to commands', () => {
    const k = (code: string, extra: Record<string, unknown> = {}) => keyToCommand({ key: '', code, ...extra });
    expect(k('Space')).toBe('endTurn');
    expect(k('Enter')).toBe('endTurn');
    // auto-repeat never re-fires a command (no flickering windows or grid / mute toggles)
    for (const code of ['Space', 'Tab', 'KeyR', 'KeyM', 'KeyF', 'KeyB', 'KeyH', 'KeyG', 'KeyN', 'Escape']) {
      expect(k(code, { repeat: true })).toBeNull();
    }
    expect(k('Tab')).toBe('nextUnit');
    expect(k('KeyB')).toBe('build');
    expect(k('KeyR')).toBe('research');
    expect(k('KeyM')).toBe('spellbook');
    expect(k('KeyF')).toBe('forge');
    expect(k('KeyG')).toBe('grid');
    expect(k('KeyH')).toBe('help');
    expect(k('KeyN')).toBe('mute');
    expect(k('Escape')).toBe('escape');
    expect(k('F1')).toBe('debug');
    expect(k('KeyS', { ctrlKey: true })).toBe('save');
    expect(k('KeyW')).toBeNull(); // camera key
    expect(k('KeyB', { altKey: true })).toBeNull();
  });

  it('maps the command bar keys, leaving the camera and the old keys alone', () => {
    const k = (code: string, extra: Record<string, unknown> = {}) => keyToCommand({ key: '', code, ...extra });
    expect(k('KeyT')).toBe('attack');
    expect(k('KeyY')).toBe('orderHeal');
    expect(k('KeyV')).toBe('orderSentry');
    expect(k('KeyU')).toBe('upgrade');
    expect(k('KeyL')).toBe('levelUp');
    expect(k('KeyC')).toBe('details');
    expect(k('KeyI')).toBe('details');
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].forEach((code, i) => expect(k(code)).toBe(`skill${i + 1}`));
    expect(k('Digit7')).toBeNull();
    expect(k('Digit0')).toBeNull();
    // WASD / Q / E stay camera keys: no command, still in the held-key set
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) {
      expect(k(code)).toBeNull();
      expect(CAMERA_CODES.has(code)).toBe(true);
    }
    // the new keys are not camera keys (a held one would pan)
    for (const code of ['KeyT', 'KeyY', 'KeyV', 'KeyU', 'KeyL', 'KeyC', 'KeyI', 'Digit1', 'Digit6']) expect(CAMERA_CODES.has(code)).toBe(false);
    // existing keys keep their meaning
    expect(k('Space')).toBe('endTurn');
    expect(k('Tab')).toBe('nextUnit');
    expect(k('KeyX')).toBe('skipUnit');
    expect(k('KeyB')).toBe('build');
    expect(k('KeyR')).toBe('research');
    expect(k('KeyF')).toBe('forge');
    expect(k('KeyH')).toBe('help');
    // no auto-repeat, and browser / OS shortcuts are not taken (Ctrl+C copy, Alt+T…)
    for (const code of ['KeyT', 'KeyY', 'KeyV', 'KeyC', 'Digit1']) expect(k(code, { repeat: true })).toBeNull();
    expect(k('KeyC', { ctrlKey: true })).toBeNull();
    expect(k('KeyT', { altKey: true })).toBeNull();
    expect(k('Digit1', { metaKey: true })).toBeNull();
  });

  it('edge pan keys', () => {
    expect(edgePanKeys(500, 400, 1000, 800)).toEqual([]);
    expect(edgePanKeys(2, 400, 1000, 800)).toEqual(['ArrowLeft']);
    expect(edgePanKeys(999, 0, 1000, 800)).toEqual(['ArrowRight', 'ArrowUp']);
    expect(edgePanKeys(500, 799, 1000, 800)).toEqual(['ArrowDown']);
  });

  it('typing targets', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
  });
});

describe('session', () => {
  const memKV = (): KV & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
  };

  it('validates save envelopes', () => {
    expect('error' in parseSave(null)).toBe(true);
    expect('error' in parseSave('{nope')).toBe(true);
    expect('error' in parseSave(JSON.stringify({ format: 'other', data: '' }))).toBe(true);
    const bad = JSON.parse(wrapSave('{}', { savedAt: 1, round: 2, faction: 'valen', auto: false }));
    bad.version = 99;
    const r = parseSave(JSON.stringify(bad));
    expect('error' in r && r.error).toMatch(/incompatible/);
    const ok = parseSave(wrapSave('{"a":1}', { savedAt: 1, round: 2, faction: 'valen', auto: true }));
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) { expect(ok.round).toBe(2); expect(ok.data).toBe('{"a":1}'); }
  });

  it('round-trips a game through storage', () => {
    const kv = memKV();
    const s = makeTestState(8, 6);
    s.round = 7;
    makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    makeTestUnit(s, 'thorn', at(5, 3));
    expect(saveGameState(s, true, kv)).toEqual({ ok: true });
    expect(kv.data.has(AUTOSAVE_KEY)).toBe(true);
    expect(kv.data.has(SAVE_KEY)).toBe(false); // an autosave never touches the manual slot
    expect(saveInfo('auto', kv)).toMatchObject({ round: 7, faction: 'valen', auto: true });
    expect(saveInfo(null, kv)).toMatchObject({ round: 7 });
    const r = loadGameState(null, kv);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.round).toBe(7);
      expect(Object.keys(r.state.units)).toHaveLength(2);
      expect(r.state).toEqual(s);
      expect(r.state).not.toBe(s);
    }
  });

  it('reports storage failures instead of throwing', () => {
    const full: KV = { getItem: () => null, setItem: () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }, removeItem: () => undefined };
    const s = makeTestState(4, 4);
    const r = saveGameState(s, false, full);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/storage/);
    expect(saveGameState(s, false, null).ok).toBe(false);
    expect(loadGameState(null, memKV()).ok).toBe(false);
    const corrupt = memKV();
    corrupt.setItem(SAVE_KEY, wrapSave('not json', { savedAt: 1, round: 1, faction: 'valen', auto: false }));
    expect(loadGameState(null, corrupt).ok).toBe(false);
  });

  it('keeps a manual save when the next turn autosaves (separate slots)', () => {
    const kv = memKV();
    const s = makeTestState(8, 6);
    makeTestUnit(s, 'valen', at(2, 2), { isLeader: true });
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      s.round = 1;
      expect(saveGameState(s, false, kv).ok).toBe(true);   // Ctrl+S in round 1
      now += 60_000;
      s.round = 2;
      expect(saveGameState(s, true, kv).ok).toBe(true);    // next turn's autosave
      const info = savesInfo(kv);
      expect(info.manual).toMatchObject({ round: 1, auto: false });
      expect(info.auto).toMatchObject({ round: 2, auto: true });
      const manual = loadGameState('manual', kv);
      expect(manual.ok && manual.state.round).toBe(1);
      expect(manual.ok && manual.slot).toBe('manual');
      // no slot: the newest save
      expect(latestSlot(kv)).toBe('auto');
      const newest = loadGameState(null, kv);
      expect(newest.ok && newest.state.round).toBe(2);
      // a later manual save becomes the newest
      now += 60_000;
      s.round = 3;
      saveGameState(s, false, kv);
      expect(latestSlot(kv)).toBe('manual');
      expect(saveInfo(null, kv)?.round).toBe(3);
      expect(describeSave(saveInfo('auto', kv)!, now)).toBe('Round 2 · 1 min ago');
      deleteSave(kv);
      expect(hasSavedGame(kv)).toBe(false);
      expect(kv.data.size).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('parses settings defensively', () => {
    expect(parseSettings(null).settings).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('garbage').settings).toEqual(DEFAULT_SETTINGS);
    const p = parseSettings(JSON.stringify({ volume: 3, music: false, showGrid: 'yes', animSpeed: 3, quality: 'low', edgePan: false, lastVolume: 0.4 }));
    expect(p.settings).toEqual({ ...DEFAULT_SETTINGS, volume: 1, music: false, quality: 'low', edgePan: false });
    expect(p.extra.lastVolume).toBe(0.4);
    expect(parseSettings(JSON.stringify({ animSpeed: 4 })).settings.animSpeed).toBe(4);
    expect(parseSettings(JSON.stringify({ watchEnemyMoves: 'all' })).settings.watchEnemyMoves).toBe('all');
    expect(parseSettings(JSON.stringify({ watchEnemyMoves: 'some' })).settings.watchEnemyMoves).toBe('nearby');
  });

  it('remembers the last New Game choices, dropping invalid ones', () => {
    const good = { playerFaction: 'thorn', aiCount: 1, mapSize: 'small', difficulty: 'hard' };
    expect(parseSettings(JSON.stringify({ newGame: good })).extra.newGame).toEqual(good);
    expect(parseSettings(JSON.stringify({ newGame: { ...good, playerFaction: 'neutral' } })).extra.newGame).toBeUndefined();
    expect(parseSettings(JSON.stringify({ newGame: { ...good, aiCount: 5 } })).extra.newGame).toBeUndefined();
    expect(parseSettings(JSON.stringify({ newGame: { ...good, mapSize: 'huge' } })).extra.newGame).toBeUndefined();
    expect(parseSettings(JSON.stringify({ newGame: 'x' })).extra.newGame).toBeUndefined();
  });
});
