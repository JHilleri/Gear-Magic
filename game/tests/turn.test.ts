import { describe, expect, it } from 'vitest';
import type { Action, FactionId, GameEvent, GameState, Hex, Unit } from '../src/core/types';
import { hexDistance, inBounds, tileIndex } from '../src/core/hex';
import { mulberry32Next } from '../src/core/rng';
import { TERRAIN } from '../src/data/terrain';
import { checkVictory, endTurn, startTurn } from '../src/sim/turn';
import {
  applyAction, attackTargets, buildOptions, craftOptions, equipOptions, idleUnits, recruitOptions,
} from '../src/sim/actions';
import { skillTargets } from '../src/sim/skills';
import { knownSpells } from '../src/sim/spells';
import { TECH_LIST } from '../src/data/research';
import { ACTIVES } from '../src/data/skills';
import { forecastCombat } from '../src/sim/combat';
import { reachable } from '../src/sim/pathfinding';
import { availableTechs } from '../src/sim/research';
import { createGame, currentFaction } from '../src/sim/state';
import { at, makeTestBuilding, makeTestState, makeTestUnit } from './helpers';

const off = (h: Hex, dq: number, dr = 0): Hex => ({ q: h.q + dq, r: h.r + dr });

function twoLeaders(s: GameState) {
  const vl = makeTestUnit(s, 'valen', at(1, 1), { isLeader: true });
  const tl = makeTestUnit(s, 'thorn', at(10, 8), { isLeader: true });
  return { vl, tl };
}

describe('startTurn', () => {
  it('emits turnStarted first, produces, researches, resets counters', () => {
    const s = makeTestState();
    twoLeaders(s);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(5, 5), { recruitedThisTurn: true });
    const forge = makeTestBuilding(s, 'forge', 'valen', at(6, 6), { craftedThisTurn: 2 });
    s.factions.valen.researching = 'mining';
    const gold = s.factions.valen.resources.gold;
    const evs = startTurn(s, 'valen');
    expect(evs[0]).toEqual({ type: 'turnStarted', faction: 'valen', round: 1 });
    expect(s.factions.valen.resources.gold).toBe(gold + 3);
    expect(s.factions.valen.researchProgress).toBe(3);
    expect(s.factions.valen.resources.research).toBe(0);
    expect(castle.recruitedThisTurn).toBe(false);
    expect(forge.craftedThisTurn).toBe(0);
  });

  it('healing: rest, buildings, regeneration, amulet; poison', () => {
    const s = makeTestState();
    twoLeaders(s);
    const c = makeTestBuilding(s, 'castle', 'valen', at(5, 5));
    const h = makeTestBuilding(s, 'house', 'valen', at(7, 5));
    const sh = makeTestBuilding(s, 'shrine', 'valen', at(3, 5));
    const onCastle = makeTestUnit(s, 'valen', c.pos, { hp: 5, poisoned: true });
    const onHouse = makeTestUnit(s, 'valen', h.pos, { hp: 5, poisoned: true });
    const onShrine = makeTestUnit(s, 'valen', sh.pos, { hp: 5, poisoned: true });
    const rested = makeTestUnit(s, 'valen', at(2, 8), { hp: 5, restedLastTurn: true });
    const regen = makeTestUnit(s, 'valen', at(4, 8), { hp: 5, passives: ['regeneration'], items: ['amulet'] });
    const sick = makeTestUnit(s, 'valen', at(6, 8), { hp: 3, poisoned: true });
    const sicker = makeTestUnit(s, 'valen', at(8, 8), { hp: 1, poisoned: true });
    const evs = startTurn(s, 'valen');
    expect(onCastle.hp).toBe(15); // cured, +10 castle
    expect(onCastle.poisoned).toBe(false);
    expect(onHouse.hp).toBe(7); // poison bites first: 5 − 5 stops at 1 (never fatal), then +6 house
    expect(onHouse.poisoned).toBe(true);
    expect(onShrine.hp).toBe(15); // cured, +10 shrine
    expect(onShrine.poisoned).toBe(false);
    expect(rested.hp).toBe(8); // +3 rest
    expect(regen.hp).toBe(10); // +2 regeneration +3 amulet
    expect(sick.hp).toBe(1);
    expect(sicker.hp).toBe(1);
    expect(evs.some((e) => e.type === 'unitDamaged' && e.source === 'poison')).toBe(true);
  });

  it('timers: buffs, cooldowns, spell cooldowns, farsight, summons; mp reset', () => {
    const s = makeTestState();
    twoLeaders(s);
    const u = makeTestUnit(s, 'valen', at(3, 3), {
      items: ['plate'], mp: 0, acted: true, moved: true,
      buffs: [{ id: 'bless', turns: 2, damageMult: 1.2, armor: 10 }, { id: 'fortify', turns: 1, armor: 20 }],
      cooldowns: { heal: 1, volley: 3 },
    });
    const elemental = makeTestUnit(s, 'valen', at(6, 3), { monster: 'elemental', summonTurns: 1 });
    const fresh = makeTestUnit(s, 'valen', at(8, 3), { monster: 'elemental', summonTurns: 5 });
    s.factions.valen.spellCooldowns = { fireball: 1, storm: 3 };
    s.factions.valen.farsight = [{ hex: at(9, 9), turns: 1 }, { hex: at(5, 9), turns: 3 }];
    const evs = startTurn(s, 'valen');
    expect(u.buffs).toEqual([{ id: 'bless', turns: 1, damageMult: 1.2, armor: 10 }]);
    expect(u.cooldowns).toEqual({ volley: 2 });
    expect(u.mp).toBe(4); // plate −1
    expect(u.acted).toBe(false);
    expect(u.moved).toBe(false);
    expect(s.units[String(elemental.id)]).toBeUndefined();
    expect(evs).toContainEqual({ type: 'unitDied', unit: elemental.id, killer: null, pos: at(6, 3), faction: 'valen' });
    expect(fresh.summonTurns).toBe(4);
    expect(s.factions.valen.spellCooldowns).toEqual({ storm: 2 });
    expect(s.factions.valen.farsight).toEqual([{ hex: at(5, 9), turns: 2 }]);
  });

  it('inspiring gives adjacent allies XP', () => {
    const s = makeTestState();
    twoLeaders(s);
    const c = at(5, 5);
    makeTestUnit(s, 'valen', c, { passives: ['inspiring'] });
    const n = makeTestUnit(s, 'valen', off(c, 1));
    const f = makeTestUnit(s, 'valen', off(c, 3));
    // Each ally learns in its own trade: a soldier with combat XP, a fresh archer by its kit.
    const sw = makeTestUnit(s, 'valen', off(c, -1), { items: ['sword'], levelXpByCat: { melee: 9, ranged: 0, building: 0, civic: 2, explore: 0, leader: 0, magic: 0 } });
    const ar = makeTestUnit(s, 'valen', off(c, 0, 1), { items: ['bow'] });
    startTurn(s, 'valen');
    // Inspiring (rank 1) teaches 3 XP a turn.
    expect(n.xpByCat.building).toBe(3); // a bare-handed commoner is a builder by kit
    expect(f.xpByCat.building).toBe(0);
    expect(sw.xpByCat.melee).toBe(3);
    expect(sw.xpByCat.civic).toBe(0);
    expect(ar.xpByCat.ranged).toBe(3);
  });

  it('level-up queue: human gets options, AI picks automatically', () => {
    const s = makeTestState();
    twoLeaders(s);
    const hu = makeTestUnit(s, 'valen', at(3, 3), { level: 2, pendingLevelUps: 2, levelUpOptions: [] });
    startTurn(s, 'valen');
    expect(hu.levelUpOptions.length).toBe(2);
    expect(hu.levelUpOptions.every((o) => o.length > 0)).toBe(true);
    const ai = makeTestUnit(s, 'thorn', at(8, 8), { level: 3, pendingLevelUps: 2, levelUpOptions: [] });
    startTurn(s, 'thorn');
    expect(ai.pendingLevelUps).toBe(0);
  });
});

describe('endTurn', () => {
  it('records rest, works sites, advances factions, runs the wilds and the round', () => {
    const s = makeTestState();
    const { vl } = twoLeaders(s);
    const site = makeTestBuilding(s, 'farm', 'valen', at(4, 4), { buildLeft: 2 });
    const b = makeTestUnit(s, 'valen', site.pos, { items: ['tools'] });
    const mover = makeTestUnit(s, 'valen', at(6, 6), { moved: true });
    let evs = endTurn(s, 'valen');
    expect(site.buildLeft).toBeCloseTo(0.9);
    expect(vl.restedLastTurn).toBe(true);
    expect(b.restedLastTurn).toBe(true);
    expect(mover.restedLastTurn).toBe(false);
    expect(s.currentTurn).toBe(1);
    expect(evs.at(-1)?.type === 'turnStarted' || evs.some((e) => e.type === 'turnStarted' && e.faction === 'thorn')).toBe(true);
    expect(s.round).toBe(1);
    evs = endTurn(s, 'thorn');
    expect(s.currentTurn).toBe(0);
    expect(s.round).toBe(2);
    expect(evs.find((e) => e.type === 'turnStarted')).toEqual({ type: 'turnStarted', faction: 'valen', round: 2 });
  });

  it('skips eliminated factions', () => {
    const s = makeTestState();
    s.factions.ashen = { ...structuredClone(s.factions.thorn), id: 'ashen' };
    s.turnOrder = ['valen', 'thorn', 'ashen'];
    twoLeaders(s);
    makeTestUnit(s, 'ashen', at(10, 1), { isLeader: true });
    s.factions.thorn.alive = false;
    endTurn(s, 'valen');
    expect(currentFaction(s)).toBe('ashen');
    s.factions.ashen.alive = false;
    s.factions.thorn.alive = true;
    const evs = endTurn(s, 'ashen');
    expect(currentFaction(s)).toBe('valen');
    expect(s.round).toBe(2);
    void evs;
  });

  it('captures happen at the end of the capturer\'s turn', () => {
    const s = makeTestState();
    twoLeaders(s);
    const house = makeTestBuilding(s, 'house', 'thorn', at(6, 6));
    makeTestUnit(s, 'valen', house.pos);
    const evs = endTurn(s, 'valen');
    expect(house.owner).toBe('valen');
    expect(evs.some((e) => e.type === 'buildingCaptured')).toBe(true);
  });
});

describe('checkVictory', () => {
  it('last faction standing wins; human loss is a defeat', () => {
    const s = makeTestState();
    twoLeaders(s);
    expect(checkVictory(s)).toEqual([]);
    s.factions.thorn.alive = false;
    const evs = checkVictory(s);
    expect(evs.at(-1)).toEqual({ type: 'gameOver', winner: 'valen' });
    expect(s.gameOver).toBe(true);
    expect(checkVictory(s)).toEqual([]); // idempotent
    const s2 = makeTestState();
    s2.factions.valen.alive = false;
    checkVictory(s2);
    expect(s2.winner).toBe('thorn');
  });

  it('a human defeat with two AIs alive crowns nobody and names the slayer', () => {
    const s = makeTestState();
    s.factions.ashen = { ...structuredClone(s.factions.thorn), id: 'ashen' };
    s.turnOrder = ['valen', 'thorn', 'ashen'];
    s.factions.valen.alive = false;
    s.factions.valen.eliminatedBy = 'thorn';
    const evs = checkVictory(s);
    expect(s.gameOver).toBe(true);
    expect(s.winner).toBeNull();
    expect(evs.at(-1)).toEqual({ type: 'gameOver', winner: null });
    expect(s.log.at(-1)!.text).toBe('Defeat. Your leader was slain by Thornwild Clans.');
    // Monsters, or nobody: worded accordingly.
    const m = makeTestState();
    m.factions.valen.alive = false;
    m.factions.valen.eliminatedBy = 'neutral';
    checkVictory(m);
    expect(m.winner).toBe('thorn'); // sole survivor is still the winner
    expect(m.log.at(-1)!.text).toBe('Defeat. Your leader fell to the wilds. Thornwild Clans stands alone.');
  });
});

// ───────────────────────────── soak test ─────────────────────────────

// Set SIMRULES_DEBUG=1 to print soak outcomes (no @types/node in this project).
const nodeProc = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const DEBUG = !!nodeProc?.env.SIMRULES_DEBUG;
const debugOut = (text: string) => nodeProc?.stderr.write(text);

/** Deterministic tiny RNG for the bot (independent of the game RNG). */
function botRng(seed: number) {
  let st = seed | 0;
  return () => { const r = mulberry32Next(st); st = r.state; return r.value; };
}

function checkInvariants(s: GameState): void {
  // Plain checks (expect() per field is far too slow for thousands of actions).
  const fail = (msg: string) => { throw new Error(`invariant broken (round ${s.round}): ${msg}`); };
  const seen = new Set<string>();
  for (const k in s.units) {
    const u = s.units[k];
    if (String(u.id) !== k) fail(`unit key ${k} != id ${u.id}`);
    if (!(u.hp > 0)) fail(`${u.name} has ${u.hp} hp`);
    if (!inBounds(u.pos, s.width, s.height)) fail(`${u.name} off map`);
    if (!Number.isFinite(TERRAIN[s.tiles[tileIndex(u.pos, s.width)].terrain].moveCost)) fail(`${u.name} on impassable terrain`);
    const key = `${u.pos.q},${u.pos.r}`;
    if (seen.has(key)) fail(`two units on ${key}`);
    seen.add(key);
    if (u.mp < 0) fail(`${u.name} negative mp`);
    if (u.faction !== 'neutral' && !s.factions[u.faction].alive) fail(`${u.name} of dead faction`);
  }
  for (const k in s.buildings) {
    const b = s.buildings[k];
    if (s.tiles[tileIndex(b.pos, s.width)].building !== b.id) fail(`tile/building mismatch ${b.id}`);
    if (b.buildLeft < 0) fail(`negative buildLeft ${b.id}`);
  }
  for (let i = 0; i < s.tiles.length; i++) {
    const id = s.tiles[i].building;
    if (id != null && !s.buildings[String(id)]) fail(`dangling building ref ${id}`);
  }
  for (const f of s.turnOrder) {
    const fs = s.factions[f];
    for (const [r, v] of Object.entries(fs.resources)) if (!(v >= 0)) fail(`${f} ${r} = ${v}`);
    if (fs.castleId != null && s.buildings[String(fs.castleId)]?.type !== 'castle') fail(`${f} castleId dangling`);
    if (fs.alive && !s.units[String(fs.leaderId)]?.isLeader) fail(`${f} alive without leader`);
  }
}

/** A crude but legal bot: attack the best forecast, build, recruit, craft, research, wander toward enemies. */
function playTurn(s: GameState, rnd: () => number): GameEvent[] {
  const f = currentFaction(s);
  const events: GameEvent[] = [];
  const act = (a: Action) => {
    const r = applyAction(s, a);
    if (r.ok) events.push(...r.events);
    checkInvariants(s);
    return r.ok;
  };
  const fs = s.factions[f];
  if (!fs.researching) {
    const opts = availableTechs(s, f);
    if (opts.length) act({ type: 'research', faction: f, tech: opts[Math.floor(rnd() * opts.length)] });
  }
  for (const k of Object.keys(s.buildings)) {
    const b = s.buildings[k];
    if (!b || b.owner !== f) continue;
    if (b.type === 'forge') {
      const c = craftOptions(s, b.id).filter((o) => !o.error);
      if (c.length && rnd() < 0.5) act({ type: 'craft', forge: b.id, item: c[Math.floor(rnd() * c.length)].item });
    }
    const rec = recruitOptions(s, b.id).filter((o) => !o.error);
    if (rec.length && rnd() < 0.6) act({ type: 'recruit', site: b.id, preset: rec[Math.floor(rnd() * rec.length)].preset });
  }
  // Spells: aim at a random unit near any own tower.
  const towers = Object.values(s.buildings).filter((b) => b.owner === f && b.type === 'magetower');
  for (const sp of knownSpells(s, f)) {
    if (!towers.length || rnd() < 0.4) continue;
    const t = towers[Math.floor(rnd() * towers.length)];
    const all = Object.values(s.units);
    const target = all[Math.floor(rnd() * all.length)]?.pos;
    if (target) act({ type: 'cast', faction: f, spell: sp, tower: t.id, target: sp === 'summon' ? { q: target.q + 1, r: target.r } : target });
  }
  let guard = 0;
  const done = new Set<number>();
  for (;;) {
    if (s.gameOver || guard++ > 200) break;
    const ids = idleUnits(s).filter((id) => !done.has(id));
    if (!ids.length) break;
    const u = s.units[String(ids[0])];
    done.add(u.id);
    while (u.pendingLevelUps > 0 && u.levelUpOptions[0]?.length) {
      if (!act({ type: 'levelup', unit: u.id, option: u.levelUpOptions[0][0] })) break;
    }
    const under = s.buildings[String(s.tiles[tileIndex(u.pos, s.width)].building)];
    // Arm up from the stockpile when standing in an armory.
    const eq = equipOptions(s, u).filter((o) => !o.error);
    if (eq.length && rnd() < 0.8) act({ type: 'equip', unit: u.id, item: eq[Math.floor(rnd() * eq.length)].item });
    if (under && under.owner === f && rnd() < 0.5) act({ type: 'upgrade', unit: u.id });
    // Builders keep working their site.
    if (under && under.owner === f && under.buildLeft > 0 && u.equipment.main === 'tools') continue;
    for (const sk of u.actives) {
      if (ACTIVES[sk].cooldown === 0 || rnd() < 0.5) continue;
      const tg = skillTargets(s, u, sk);
      act({ type: 'skill', unit: u.id, skill: sk, target: tg.length ? tg[Math.floor(rnd() * tg.length)] : undefined });
    }
    // Leaders sit on the castle to recruit.
    if (u.isLeader && fs.castleId != null) {
      const c = s.buildings[String(fs.castleId)];
      if (c && hexDistance(u.pos, c.pos) > 0) act({ type: 'move', unit: u.id, to: c.pos });
      if (c && hexDistance(u.pos, c.pos) === 0) continue;
    }
    const opts = buildOptions(s, u).filter((o) => !o.error);
    if (opts.length && rnd() < 0.7) { act({ type: 'build', unit: u.id, building: opts[Math.floor(rnd() * opts.length)].building }); continue; }
    const tryAttack = () => {
      let best: { t: number; k: any; score: number } | null = null;
      for (const at of attackTargets(s, u)) {
        for (const k of at.kinds) {
          const fc = forecastCombat(s, u, s.units[String(at.unit)], k)!;
          const score = fc.expectedDamageToDefender - fc.expectedDamageToAttacker + fc.defenderKillChance * 20;
          if (!best || score > best.score) best = { t: at.unit, k, score };
        }
      }
      if (best && (best.score > -2 || u.isLeader === false)) return act({ type: 'attack', unit: u.id, target: best.t, kind: best.k });
      return false;
    };
    if (tryAttack()) continue;
    if (u.mp > 0 && !(u.isLeader && fs.castleId != null)) {
      const reach = reachable(s, u);
      if (reach.length) {
        const enemies = Object.values(s.units).filter((o) => o.faction !== f);
        const dist = (h: Hex) => enemies.reduce((m, o) => Math.min(m, hexDistance(h, o.pos)), 99);
        reach.sort((a, b) => dist(a.hex) - dist(b.hex) || a.cost - b.cost);
        const pick = rnd() < 0.7 ? reach[0] : reach[Math.floor(rnd() * reach.length)];
        act({ type: 'move', unit: u.id, to: pick.hex });
        if (s.units[String(u.id)]) tryAttack();
      }
    }
  }
  if (!s.gameOver) act({ type: 'endTurn', faction: f });
  return events;
}

function soak(seed: number, rounds: number, rich = false): { state: GameState; events: number; counts: Record<string, number> } {
  const s = createGame({ mapSize: 'small', seed, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });
  if (rich) {
    // Everything unlocked and plenty of stock: exercises knights, mages, spells, walls, upgrades.
    for (const f of s.turnOrder) {
      const fs = s.factions[f];
      fs.techs = TECH_LIST.map((t) => t.id);
      for (const k of Object.keys(fs.resources) as (keyof typeof fs.resources)[]) fs.resources[k] = k === 'research' ? 0 : 400;
      fs.resources.mana = 100;
    }
    for (const u of Object.values(s.units)) if (u.faction !== 'neutral') u.actives.push('powerstrike', 'heal', 'rally', 'fortify', 'blink', 'firebolt', 'volley', 'masonry', 'devotion');
  }
  startTurn(s, currentFaction(s));
  const rnd = botRng(seed * 31 + 7);
  let events = 0;
  const counts: Record<string, number> = {};
  checkInvariants(s);
  let guard = 0;
  while (!s.gameOver && s.round <= rounds && guard++ < rounds * 4) {
    const evs = playTurn(s, rnd);
    events += evs.length;
    for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return { state: s, events, counts };
}

describe('soak: many rounds through the public action API', () => {
  it('stays consistent and deterministic over 40 rounds', () => {
    const a = soak(4242, 40);
    const b = soak(4242, 40);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.events).toBeGreaterThan(100);
    expect(a.state.round).toBeGreaterThan(5);
    const units = Object.values(a.state.units) as Unit[];
    expect(units.length).toBeGreaterThan(0);
  }, 120_000);

  it('rich games exercise spells, upgrades, equipment and skills', () => {
    const totals: Record<string, number> = {};
    for (const seed of [3, 11]) {
      const r = soak(seed, 30, true);
      checkInvariants(r.state);
      for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] ?? 0) + v;
      if (DEBUG) {
        debugOut(`\nseed ${seed} round ${r.state.round} over ${r.state.gameOver} winner ${r.state.winner}\n`);
        for (const f of r.state.turnOrder) {
          const fs = r.state.factions[f];
          debugOut(`${f} alive=${fs.alive} ${JSON.stringify(fs.stats)} units=${Object.values(r.state.units).filter((u) => u.faction === f).length} bld=${Object.values(r.state.buildings).filter((b) => b.owner === f).map((b) => b.type + b.level + (b.buildLeft > 0 ? '*' : '')).join(',')}\n`);
        }
      }
    }
    if (DEBUG) debugOut(JSON.stringify(totals) + '\n');
    for (const t of ['spellCast', 'unitEquipped', 'skillUsed', 'buildingCompleted', 'itemCrafted', 'combat', 'unitDied']) {
      expect(totals[t] ?? 0, t).toBeGreaterThan(0);
    }
  }, 180_000);

  it('a few more seeds run without errors', () => {
    for (const seed of [1, 7, 99]) {
      const r = soak(seed, 25);
      checkInvariants(r.state);
      const fs = r.state.turnOrder.map((f: FactionId) => r.state.factions[f]);
      expect(fs.some((x) => x.alive)).toBe(true);
    }
  }, 180_000);
});

describe('neutral phase marker', () => {
  it('marks where the wilds act, with the round that is ending, before the next round starts', () => {
    const s = makeTestState(10, 8);
    makeTestUnit(s, 'valen', at(1, 1), { isLeader: true });
    makeTestUnit(s, 'thorn', at(8, 6), { isLeader: true });
    s.currentTurn = 1; // thorn ends the round
    const evs = endTurn(s, 'thorn');
    const mark = evs.findIndex((e) => e.type === 'neutralPhase');
    const start = evs.findIndex((e) => e.type === 'turnStarted');
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(evs[mark]).toEqual({ type: 'neutralPhase', round: 1 });
    expect(start).toBeGreaterThan(mark);
    expect(evs[start]).toEqual({ type: 'turnStarted', faction: 'valen', round: 2 });
  });
});
