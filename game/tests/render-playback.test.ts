// Event playback rules (render/playback.ts) against fake layers, plus the pure unit-animation
// helpers: seated clips for GLB riders, planted-foot walk rate and the unit sidecar parser.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { makeTestState, makeTestUnit, at } from './helpers';
import { beatDependencies, playEventSequence, splitBeats, takeSnapshot, type BeatLookup, type PlaybackHost, type PlaybackPlan } from '../src/render/playback';
import { seatedClip } from '../src/render/units';
import { parseUnitMeta } from '../src/render/assets';
import { DEFAULT_RUN_SPEED, DEFAULT_WALK_SPEED, FOOT_SPEED, RUN_CYCLE, UNIT_HEIGHT, walkTimeScale } from '../src/render/types';
import type { GameEvent, GameState, Hex, Unit } from '../src/core/types';
import type { RenderContext } from '../src/render/types';
import heavyMeta from '../public/assets/models/units/human_heavy.meta.json';

function fakeHost(state: GameState, opts: { cancelled?: () => boolean; animateMove?: () => Promise<void> } = {}) {
  const units = {
    sync: vi.fn(), update() {}, dispose() {},
    animateMove: vi.fn(opts.animateMove ?? (async () => {})),
    animateCombat: vi.fn(async () => {}),
    animateDeath: vi.fn(async () => {}),
    animateSpawn: vi.fn(async () => {}),
    playClip: vi.fn(async () => {}),
    unitAnchor: () => null,
    refreshUnit: vi.fn(),
  };
  const buildings = { sync: vi.fn(), update() {}, dispose() {}, animateConstructed: vi.fn(async () => {}), animateDestroyed: vi.fn(async () => {}) };
  const fx = {
    projectile: vi.fn(async () => {}), damageNumber: vi.fn(), burst: vi.fn(), spell: vi.fn(async () => {}),
    levelUp: vi.fn(), hitSpark: vi.fn(), update() {}, dispose() {},
  };
  const ctx = {
    viewer: state.settings.playerFaction,
    hexCenter: () => new THREE.Vector3(),
    shake: vi.fn(),
    factionColor: () => new THREE.Color(),
  } as unknown as RenderContext;
  const host: PlaybackHost = { ctx, layers: { units, buildings, fx }, refreshFog: vi.fn(), reportError: vi.fn(), cancelled: opts.cancelled };
  return { host, units, buildings, fx };
}

const hide = (s: GameState) => { s.factions.valen.visible = new Array(s.width * s.height).fill(0); };

describe('playback: the viewer always sees its own units fight and fall', () => {
  it('plays a lone scout killed where no ally of the viewer can see any more', async () => {
    const s = makeTestState(14, 10);
    const scout = makeTestUnit(s, 'valen', at(10, 5), { hp: 1 });
    const foe = makeTestUnit(s, 'thorn', at(11, 5));
    const snap = takeSnapshot(s);
    // after the death, valen's visibility no longer covers either hex
    delete s.units[String(scout.id)];
    hide(s);
    const strikes = [{ by: 'attacker' as const, hit: true, damage: 6 }];
    const events: GameEvent[] = [
      { type: 'combat', attacker: foe.id, defender: scout.id, kind: 'melee', strikes, attackerHp: foe.hp, defenderHp: 0 },
      { type: 'unitDied', unit: scout.id, killer: foe.id, pos: scout.pos, faction: 'valen' },
    ];
    const { host, units } = fakeHost(s);
    await playEventSequence(host, s, snap, events, 1);
    expect(units.animateCombat).toHaveBeenCalledWith(foe.id, scout.id, 'melee', strikes, 1);
    expect(units.animateDeath).toHaveBeenCalledWith(scout.id, 1);
  });

  it('plays a scout dying to retaliation, but not strangers fighting in the fog', async () => {
    const s = makeTestState(14, 10);
    const scout = makeTestUnit(s, 'valen', at(10, 5), { hp: 1 });
    const foe = makeTestUnit(s, 'thorn', at(11, 5));
    const a = makeTestUnit(s, 'thorn', at(2, 2));
    const b = makeTestUnit(s, 'neutral', at(3, 2), { hp: 1 });
    const snap = takeSnapshot(s);
    delete s.units[String(scout.id)];
    delete s.units[String(b.id)];
    hide(s);
    const events: GameEvent[] = [
      { type: 'combat', attacker: scout.id, defender: foe.id, kind: 'melee', strikes: [{ by: 'defender', hit: true, damage: 6 }], attackerHp: 0, defenderHp: foe.hp },
      { type: 'unitDied', unit: scout.id, killer: foe.id, pos: scout.pos, faction: 'valen' },
      { type: 'combat', attacker: a.id, defender: b.id, kind: 'melee', strikes: [{ by: 'attacker', hit: true, damage: 6 }], attackerHp: a.hp, defenderHp: 0 },
      { type: 'unitDied', unit: b.id, killer: a.id, pos: b.pos, faction: 'neutral' },
    ];
    const { host, units } = fakeHost(s);
    await playEventSequence(host, s, snap, events, 1);
    expect(units.animateCombat).toHaveBeenCalledTimes(1);
    expect(units.animateCombat).toHaveBeenCalledWith(scout.id, foe.id, 'melee', expect.anything(), 1);
    expect(units.animateDeath).toHaveBeenCalledTimes(1);
    expect(units.animateDeath).toHaveBeenCalledWith(scout.id, 1);
  });
});

describe('playback: a stale sequence stops touching the layers', () => {
  it('returns at the next step once cancelled (another game was installed meanwhile)', async () => {
    const s = makeTestState(14, 10);
    const u1 = makeTestUnit(s, 'valen', at(3, 3));
    const u2 = makeTestUnit(s, 'valen', at(5, 3));
    const snap = takeSnapshot(s);
    s.units[String(u1.id)].pos = at(4, 3);
    s.units[String(u2.id)].pos = at(6, 3);
    const spawned = makeTestUnit(s, 'valen', at(7, 7));
    let cancelled = false;
    let release!: () => void;
    const { host, units, fx } = fakeHost(s, {
      cancelled: () => cancelled,
      animateMove: () => new Promise<void>((r) => { release = r; }),
    });
    const events: GameEvent[] = [
      { type: 'unitMoved', unit: u1.id, path: [at(4, 3)] },
      { type: 'unitMoved', unit: u2.id, path: [at(6, 3)] },
      { type: 'unitSpawned', unit: spawned.id, pos: spawned.pos, reason: 'recruit' },
    ];
    const done = playEventSequence(host, s, snap, events, 1);
    await Promise.resolve();
    expect(units.animateMove).toHaveBeenCalledTimes(1);
    const syncsBefore = units.sync.mock.calls.length;
    // The old layers' scheduler resolves every pending tween when the new game disposes them.
    cancelled = true;
    release();
    await done;
    expect(units.animateMove).toHaveBeenCalledTimes(1);
    expect(units.animateSpawn).not.toHaveBeenCalled();
    expect(units.sync.mock.calls.length).toBe(syncsBefore);
    expect(fx.burst).not.toHaveBeenCalled();
    expect(host.refreshFog).toHaveBeenCalledTimes(1);
  });
});

// ───────────── scheduled (concurrent) playback ─────────────

const move = (u: Unit, ...path: Hex[]): GameEvent => ({ type: 'unitMoved', unit: u.id, path });
const hit = (a: Unit, d: Unit, defenderHp = d.hp - 3): GameEvent => ({
  type: 'combat', attacker: a.id, defender: d.id, kind: 'melee', strikes: [{ by: 'attacker', hit: true, damage: 3 }], attackerHp: a.hp, defenderHp,
});
const lookup = (s: GameState): BeatLookup => ({
  unitPos: (id) => s.units[String(id)]?.pos,
  buildingPos: (id) => s.buildings[String(id)]?.pos,
});

describe('playback schedule: beats and dependencies', () => {
  it('splits marches from strikes and keeps a strike with the deaths it causes', () => {
    const s = makeTestState(16, 10);
    const a = makeTestUnit(s, 'thorn', at(2, 2));
    const d = makeTestUnit(s, 'valen', at(5, 2));
    const events: GameEvent[] = [
      move(a, at(3, 2), at(4, 2)),
      hit(a, d, 0),
      { type: 'log', entry: { round: 1, text: 'x', kind: 'combat', faction: 'thorn' } as never },
      { type: 'unitDied', unit: d.id, killer: a.id, pos: d.pos, faction: 'valen' },
      { type: 'factionEliminated', faction: 'valen', by: 'thorn' },
      { type: 'gameOver', winner: 'thorn' },
    ];
    const beats = splitBeats(events, lookup(s));
    expect(beats.map((b) => b.events)).toEqual([[0], [1, 2, 3], [4], [5]]);
    expect(beats.map((b) => b.barrier)).toEqual([false, false, true, true]);
    const deps = beatDependencies(beats);
    expect(deps.map((x) => x.after)).toEqual([[], [0], [0, 1], [2]]);
  });

  it('lets independent marches play at once, chains a unit\'s own events and pile-ons on one target', () => {
    const s = makeTestState(16, 10);
    const a = makeTestUnit(s, 'thorn', at(1, 1));
    const b = makeTestUnit(s, 'thorn', at(1, 6));
    const target = makeTestUnit(s, 'valen', at(5, 4));
    const events: GameEvent[] = [
      move(a, at(2, 1), at(3, 2), at(4, 3)),   // 0
      move(b, at(2, 6), at(3, 5), at(4, 5)),   // 1: elsewhere
      hit(a, target),                           // 2: after a's march
      hit(b, target),                           // 3: after b's march and a's strike on the same target
    ];
    const deps = beatDependencies(splitBeats(events, lookup(s)));
    expect(deps.map((x) => x.after)).toEqual([[], [], [0], [1, 2]]);
    expect(deps.every((x) => x.lag.length === 0)).toBe(true);
  });

  it('a march behind another on the same road does not wait; one that would catch up starts later; one ending in its path waits', () => {
    const s = makeTestState(20, 6);
    const lead = makeTestUnit(s, 'thorn', at(5, 2));
    const behind = makeTestUnit(s, 'thorn', at(2, 2));
    const level = makeTestUnit(s, 'thorn', at(4, 3));
    const road = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => at(from + k, 2));
    // the leader walks 5,2 → 10,2; a follower 3 hexes behind walks 2,2 → 6,2 (where the leader passed long ago)
    let deps = beatDependencies(splitBeats([move(lead, ...road(6, 10)), move(behind, ...road(3, 6))], lookup(s)));
    expect(deps[1]).toEqual({ after: [], lag: [] });
    // one joining the road beside the leader would reach 6,2 as the leader does: it starts a little later
    deps = beatDependencies(splitBeats([move(lead, ...road(6, 10)), move(level, at(5, 2), at(6, 2), at(7, 2))], lookup(s)));
    expect(deps[1].after).toEqual([]);
    expect(deps[1].lag).toHaveLength(1);
    expect(deps[1].lag[0][0]).toBe(0);
    expect(deps[1].lag[0][1]).toBeGreaterThan(0);
    // ending on the hex the leader ends on, or starting where the leader will stand: wait for it
    deps = beatDependencies(splitBeats([move(lead, ...road(6, 8)), move(behind, ...road(3, 8))], lookup(s)));
    expect(deps[1].after).toEqual([0]);
  });

  it('a march only passing a fight neither waits for it nor holds it up', () => {
    const s = makeTestState(16, 10);
    const a = makeTestUnit(s, 'thorn', at(4, 4));
    const d = makeTestUnit(s, 'valen', at(5, 4));
    const runner = makeTestUnit(s, 'thorn', at(2, 4));
    const deps = beatDependencies(splitBeats([hit(a, d), move(runner, at(3, 4), at(4, 4), at(4, 5), at(4, 6))], lookup(s)));
    expect(deps[1].after).toEqual([]);
    // but stopping on the attacker's hex would
    const stop = beatDependencies(splitBeats([hit(a, d), move(runner, at(3, 4), at(4, 4))], lookup(s)));
    expect(stop[1].after).toEqual([0]);
  });
});

describe('playback schedule: running a plan', () => {
  it('plays independent steps at once, waits for dependencies, applies instant steps without animating', async () => {
    const s = makeTestState(16, 10);
    const a = makeTestUnit(s, 'thorn', at(1, 1));
    const b = makeTestUnit(s, 'thorn', at(1, 6));
    const c = makeTestUnit(s, 'thorn', at(9, 6));
    const snap = takeSnapshot(s);
    s.units[String(a.id)].pos = at(3, 1);
    s.units[String(b.id)].pos = at(3, 6);
    s.units[String(c.id)].pos = at(11, 6);
    const releases: (() => void)[] = [];
    const { host, units } = fakeHost(s, { animateMove: () => new Promise<void>((r) => { releases.push(r); }) });
    const events: GameEvent[] = [move(a, at(2, 1), at(3, 1)), move(b, at(2, 6), at(3, 6)), move(a, at(3, 2)), move(c, at(10, 6), at(11, 6))];
    s.units[String(a.id)].pos = at(3, 2);
    const order: string[] = [];
    const plan: PlaybackPlan = {
      steps: [
        { events: [0], after: [] },
        { events: [1], after: [], speed: 2 },
        { events: [2], after: [0] },
        { events: [3], after: [], instant: true },
      ],
      onStepStart: (k) => { order.push(`start${k}`); },
      onStepEnd: (k) => { order.push(`end${k}`); },
    };
    const done = playEventSequence(host, s, snap, events, 4, plan);
    for (let k = 0; k < 5; k++) await Promise.resolve();
    // both first marches started together (the second at its own speed); the instant one is already done
    expect(units.animateMove).toHaveBeenCalledTimes(2);
    expect(units.animateMove.mock.calls[0]).toEqual([a.id, [at(2, 1), at(3, 1)], 4]);
    expect(units.animateMove.mock.calls[1]).toEqual([b.id, [at(2, 6), at(3, 6)], 2]);
    expect(order).toContain('end3');
    expect(order).not.toContain('start2');
    releases[0]();
    for (let k = 0; k < 8; k++) await Promise.resolve();
    expect(order).toContain('start2');
    releases.splice(0).forEach((r) => r());
    for (let k = 0; k < 8; k++) await Promise.resolve();
    releases.splice(0).forEach((r) => r());
    await done;
    expect(units.animateMove).toHaveBeenCalledTimes(3); // never for the instant step
    // the instant step still reached the layers: c stands at its destination in a synced display model
    const lastSync = units.sync.mock.calls.at(-1)?.[0] as GameState | undefined;
    expect(lastSync?.units[String(c.id)].pos).toEqual(at(11, 6));
  });

  it('stops a plan once stale: later steps never start, waiting steps are released', async () => {
    const s = makeTestState(16, 10);
    const a = makeTestUnit(s, 'thorn', at(1, 1));
    const b = makeTestUnit(s, 'thorn', at(1, 3));
    const snap = takeSnapshot(s);
    let cancelled = false;
    let release!: () => void;
    const { host, units } = fakeHost(s, { cancelled: () => cancelled, animateMove: () => new Promise<void>((r) => { release = r; }) });
    const started: number[] = [];
    const done = playEventSequence(host, s, snap, [move(a, at(2, 1)), move(b, at(2, 3))], 4, {
      steps: [{ events: [0], after: [] }, { events: [1], after: [0] }, { events: [1], after: [], lag: [[0, 0.5]] }],
      onStepStart: (k) => { started.push(k); },
    });
    for (let k = 0; k < 6; k++) await Promise.resolve();
    expect(units.animateMove).toHaveBeenCalledTimes(1);
    cancelled = true;
    release();
    await done;
    expect(started).toEqual([0]);
    expect(units.animateMove).toHaveBeenCalledTimes(1);
  });

  it('a lagging step starts its delay after the leader starts, not after it ends', async () => {
    vi.useFakeTimers();
    try {
      const s = makeTestState(16, 10);
      const a = makeTestUnit(s, 'thorn', at(1, 1));
      const b = makeTestUnit(s, 'thorn', at(1, 2));
      const snap = takeSnapshot(s);
      let releaseA!: () => void;
      const { host, units } = fakeHost(s, {
        animateMove: () => new Promise<void>((r) => { if (!releaseA) releaseA = r; else r(); }),
      });
      const events: GameEvent[] = [move(a, at(2, 1)), move(b, at(2, 2))];
      // b starts 0.8 s (speed 1) after a starts; at speed 4 that is 200 ms
      const done = playEventSequence(host, s, snap, events, 4, { steps: [{ events: [0], after: [] }, { events: [1], after: [], lag: [[0, 0.8]] }] });
      await vi.advanceTimersByTimeAsync(150);
      expect(units.animateMove).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(units.animateMove).toHaveBeenCalledTimes(2); // while a still walks
      releaseA();
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('unit animation helpers', () => {
  it('keeps a GLB rider on seat-preserving clips', () => {
    expect(seatedClip('attack_melee')).toBe('ride_attack');
    expect(seatedClip('attack_ranged')).toBe('ride_attack');
    expect(seatedClip('cast')).toBe('ride_attack');
    expect(seatedClip('ride_idle')).toBe('ride_idle');
    expect(seatedClip('work')).toBe('ride_idle');
    expect(seatedClip('idle')).toBe('ride_idle');
    expect(seatedClip('hit')).toBeNull();   // flinch instead
    expect(seatedClip('death')).toBeNull(); // handled by animateDeath, from the saddle
  });

  it('time-scales the walk so planted feet move at ground speed', () => {
    const ts = walkTimeScale(FOOT_SPEED, 0.56);
    expect(ts * 0.56 * UNIT_HEIGHT).toBeCloseTo(FOOT_SPEED, 9);
    expect(walkTimeScale(2.4, 0.6)).toBeCloseTo(2.4 / (0.6 * UNIT_HEIGHT), 9);
    expect(walkTimeScale(1, 0)).toBeCloseTo(1 / (DEFAULT_WALK_SPEED * UNIT_HEIGHT), 9);
    expect(walkTimeScale(1, Number.NaN)).toBeCloseTo(1 / (DEFAULT_WALK_SPEED * UNIT_HEIGHT), 9);
    // a plausible cadence for the shipped 0.8 s walk cycle at a walking pace: 2.5–5 cycles per second
    const cyclesPerSecond = walkTimeScale(1.2, 0.56) / 0.8;
    expect(cyclesPerSecond).toBeGreaterThan(2.5);
    expect(cyclesPerSecond).toBeLessThan(5);
  });

  it('reads walk_speed from a unit sidecar', () => {
    const ws = parseUnitMeta(heavyMeta).walkSpeed;
    expect(ws).toBeGreaterThan(0.3);
    expect(ws).toBeLessThan(1);
    expect(parseUnitMeta({ walkSpeed: 0.6 }).walkSpeed).toBe(0.6);
    expect(parseUnitMeta({ walk_speed: -1 })).toEqual({});
    expect(parseUnitMeta({ walk_speed: '0.5' })).toEqual({});
    expect(parseUnitMeta(null)).toEqual({});
  });

  it('reads run_speed and keeps a running cadence at foot speed', () => {
    expect(parseUnitMeta({ walk_speed: 0.56, run_speed: 2.1 })).toEqual({ walkSpeed: 0.56, runSpeed: 2.1 });
    expect(parseUnitMeta({ walk_speed: 0.56, run_speed: 0 })).toEqual({ walkSpeed: 0.56 });
    const ts = walkTimeScale(FOOT_SPEED, DEFAULT_RUN_SPEED);
    const stepsPerSecond = (2 * ts) / RUN_CYCLE;
    expect(stepsPerSecond).toBeGreaterThan(3);
    expect(stepsPerSecond).toBeLessThan(4.2);
  });
});
