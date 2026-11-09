// Player-facing notices: outcome toasts collapsed around a house's fall, the fall announced with its
// slayer, level-up choices put off, "too costly this turn" trips, and the portraits a body shows.
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/core/types';
import { killUnit } from '../src/sim/combat';
import { pathTowards, truncatePathToMp } from '../src/sim/pathfinding';
import { eliminationNotice, eliminationSweep, skippedOutcomeToasts } from '../src/game/notices';
import { levelUpsToOffer, tooCostlyThisTurn } from '../src/game/interaction';
import { stuckTrip } from '../src/game/trip';
import { bodyPortraitKeys, portraitKey, presetPortraitKeys } from '../src/ui/util';
import manifest from '../public/assets/manifest.json';
import { at, makeTestState, makeTestUnit } from './helpers';

describe('outcome toasts around a fall', () => {
  it('the player\'s fall: one line for the leader, none per unit swept away, none after the fall', () => {
    const s = makeTestState();
    s.factions.ashen = { ...s.factions.thorn, id: 'ashen', isHuman: false };
    s.turnOrder = ['valen', 'thorn', 'ashen'];
    const leader = makeTestUnit(s, 'valen', at(4, 4), { isLeader: true });
    makeTestUnit(s, 'valen', at(1, 1));
    makeTestUnit(s, 'valen', at(2, 1));
    makeTestUnit(s, 'valen', at(3, 1));
    const foe = makeTestUnit(s, 'thorn', at(5, 4), { isLeader: true });
    const evs = killUnit(s, leader, foe);
    const skip = skippedOutcomeToasts(evs, 'valen');
    const deaths = evs.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'unitDied');
    expect(deaths.length).toBe(4);
    // the leader's own death still gets its toast; the three swept units do not
    expect(skip.has(deaths[0][1])).toBe(false);
    expect(deaths.slice(1).every(([, i]) => skip.has(i))).toBe(true);
    // "Your leader has fallen…" and "Defeat…" repeat the results screen: skipped
    const warnings = evs.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'log' && e.entry.kind === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.every(([, i]) => skip.has(i))).toBe(true);
    expect(s.gameOver).toBe(true);
  });

  it('a sweep is only the killer-less deaths right before the fall', () => {
    const evs: GameEvent[] = [
      { type: 'unitDied', unit: 1, killer: 9, pos: at(0, 0), faction: 'thorn' },
      { type: 'log', entry: { round: 1, faction: 'thorn', text: 'x', kind: 'combat' } },
      { type: 'unitDied', unit: 2, killer: null, pos: at(1, 0), faction: 'thorn' },
      { type: 'unitDied', unit: 3, killer: null, pos: at(2, 0), faction: 'thorn' },
      { type: 'factionEliminated', faction: 'thorn', by: 'valen' },
    ];
    expect([...eliminationSweep(evs)].sort()).toEqual([2, 3]);
    // an AI's fall does not mute the player's toasts after it
    expect(skippedOutcomeToasts(evs, 'valen').has(4)).toBe(false);
  });
});

describe('a house destroyed', () => {
  it('names the house and who destroyed it', () => {
    expect(eliminationNotice('thorn', 'valen', 'valen')).toEqual({
      title: 'Thornwild Clans has fallen', sub: 'Destroyed by your hand', toast: 'You have destroyed Thornwild Clans!',
    });
    const n = eliminationNotice('ashen', 'thorn', 'valen');
    expect(n.sub).toBe('Destroyed by Thornwild Clans');
    expect(n.toast).toBe('Ashen Covenant has been destroyed by Thornwild Clans!');
    expect(eliminationNotice('ashen', 'neutral', 'valen').toast).toBe('Ashen Covenant has fallen to the wilds!');
    // its own Fireball: no slayer
    expect(eliminationNotice('ashen', 'ashen', 'valen').toast).toBe('Ashen Covenant has been destroyed!');
  });

  it('the chronicle records the fall and the slayer (an AI house destroyed by another)', () => {
    const s = makeTestState();
    s.factions.ashen = { ...s.factions.thorn, id: 'ashen', isHuman: false, stats: { ...s.factions.thorn.stats } };
    s.turnOrder = ['valen', 'thorn', 'ashen'];
    makeTestUnit(s, 'valen', at(1, 1), { isLeader: true });
    const killer = makeTestUnit(s, 'ashen', at(6, 6), { isLeader: true });
    const victim = makeTestUnit(s, 'thorn', at(7, 6), { isLeader: true });
    const evs = killUnit(s, victim, killer);
    expect(evs.some((e) => e.type === 'factionEliminated' && e.faction === 'thorn' && e.by === 'ashen')).toBe(true);
    expect(s.log.some((e) => e.text === 'Thornwild Clans has been destroyed by Ashen Covenant!')).toBe(true);
    expect(s.gameOver).toBe(false);
  });
});

describe('level-up choices put off', () => {
  it('only pending choices not put off open by themselves; a newer level-up does', () => {
    const units = [{ id: 1, pendingLevelUps: 1 }, { id: 2, pendingLevelUps: 2 }, { id: 3, pendingLevelUps: 0 }];
    expect(levelUpsToOffer(units, new Map())).toEqual([1, 2]);
    // "Decide later" with both waiting: nothing reopens at the next turn start
    expect(levelUpsToOffer(units, new Map([[1, 1], [2, 2]]))).toEqual([]);
    // unit 2 levels again (3 waiting): it is offered again
    expect(levelUpsToOffer([{ id: 1, pendingLevelUps: 1 }, { id: 2, pendingLevelUps: 3 }], new Map([[1, 1], [2, 2]]))).toEqual([2]);
  });
});

describe('too costly this turn vs blocked', () => {
  it('a unit with 1 MP left next to mountains: too costly, reachable next turn', () => {
    const s = makeTestState(12, 10, 'mountain');
    const u = makeTestUnit(s, 'valen', at(3, 3), { mp: 1 });
    const full = pathTowards(s, u, at(6, 3))!;
    expect(full.length).toBeGreaterThan(0);
    expect(truncatePathToMp(s, u, full)).toEqual([]);
    const r = stuckTrip(s, u, full, 5);
    expect(r.wait).toBeDefined();
    expect(r.error).toMatch(/^Too costly this turn/);
    expect(r.error).not.toMatch(/blocked/);
    expect(r.wait!.why).toMatch(/MP, 1 left/);
    expect(r.wait!.turns).toBeGreaterThanOrEqual(2);
  });

  it('a unit with full MP that still cannot move is blocked', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(3, 3));
    const r = stuckTrip(s, u, [at(4, 3)], u.mp);
    expect(r.wait).toBeUndefined();
    expect(r.error).toMatch(/blocked/);
  });

  it('words the wait', () => {
    expect(tooCostlyThisTurn('Bram', { terrain: 'Mountains', cost: 3 }, 1, 2)).toEqual({
      short: 'Mountains cost 3 MP, 1 left',
      long: 'Too costly this turn: entering Mountains takes 3 MP and Bram has 1 left. It can get there next turn.',
    });
    expect(tooCostlyThisTurn('Bram', null, 1, 4).long).toMatch(/your units on the way\. About 3 turns to get there, setting out next turn\./);
  });
});

describe('portraits', () => {
  it('a commoner in the Padded Tunic shows <race>_padded, else falls back to the commoner', () => {
    const s = makeTestState();
    const padded = makeTestUnit(s, 'valen', at(1, 1), { items: ['tunic'] });
    expect(portraitKey(padded, 'commoner')).toEqual(['human_padded', 'human_commoner']);
    const plain = makeTestUnit(s, 'thorn', at(2, 1));
    expect(portraitKey(plain, 'commoner')).toEqual(['orc_commoner']);
    const archer = makeTestUnit(s, 'valen', at(3, 1), { items: ['leather'] });
    expect(portraitKey(archer, 'light')).toEqual(['human_light', 'human_commoner']);
    const leader = makeTestUnit(s, 'valen', at(4, 1), { isLeader: true, items: ['tunic'] });
    expect(portraitKey(leader, 'leader')).toEqual(['human_leader']);
    expect(bodyPortraitKeys('undead', 'commoner', 'tunic')).toEqual(['undead_padded', 'undead_commoner']);
  });

  it('recruit cards show the body the preset armour gives', () => {
    expect(presetPortraitKeys('orc', 'swordsman')[0]).toBe('orc_padded');
    expect(presetPortraitKeys('human', 'archer')[0]).toBe('human_light');
    expect(presetPortraitKeys('undead', 'knight')[0]).toBe('undead_heavy');
    expect(presetPortraitKeys('human', 'battlemage')[0]).toBe('human_robe');
    expect(presetPortraitKeys('undead', 'builder')).toEqual(['undead_commoner']);
  });

  it('the manifest lists every padded and commoner portrait that ships', () => {
    const files = Object.keys(import.meta.glob('../public/assets/portraits/*.png'));
    const shipped = new Set(files.map((f) => f.replace(/^.*\//, '').replace(/\.png$/, '')));
    const portraits = (manifest as { portraits: Record<string, string> }).portraits;
    for (const race of ['human', 'orc', 'undead']) {
      for (const body of ['padded', 'commoner']) {
        const key = `${race}_${body}`;
        if (!shipped.has(key)) continue;
        expect(portraits[key], key).toBe(`portraits/${key}.png`);
      }
    }
    expect(shipped.has('undead_padded') && shipped.has('undead_commoner')).toBe(true);
  });
});
