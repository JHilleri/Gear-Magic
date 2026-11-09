// AI metrics harness (not part of the normal suite): AI-only games where every house, the
// player's included (isHuman kept, so the player-bias rules run), is driven by the AI.
// Run with: AI_METRICS=1 npx vitest run tests/ai-metrics.test.ts
// Optional: AI_METRICS_SEEDS=1,2,3  AI_METRICS_ROUNDS=60  AI_METRICS_DIFF=normal,hard
// AI_METRICS_PLAYER=thorn (the player's house)  AI_METRICS_IDLE=1 (the player only ends turns)
import { describe, expect, it } from 'vitest';
import type { Difficulty, FactionId, GameEvent, GameState, SpellId } from '../src/core/types';
import { createGame, currentFaction } from '../src/sim/state';
import { applyAction } from '../src/sim/actions';
import { startTurn } from '../src/sim/turn';
import { manaCap } from '../src/sim/spells';
import { SPELLS } from '../src/data/spells';
import { hasTech } from '../src/sim/research';
import { aiNextAction, createAiMemory } from '../src/sim/ai/index';

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const ON = !!env?.env.AI_METRICS;
const out = (s: string) => env?.stderr.write(s + '\n');

interface House {
  arcanaAt: number | null; towerAt: number | null; chanAt: number | null; firstSpellAt: number | null;
  towers: Record<number, number>; mana: Record<number, number>; manaFullRounds: number;
  buildings: Record<number, number>; military: Record<number, number>; techs: number;
  spells: Partial<Record<SpellId, number>>; alive: boolean; kills: number; lost: number;
  /** Round each tech was learned (signature techs at 0). */
  /** Per-turn income at rounds 20/30/45: goods (gold+food+wood+stone+iron+crystal), research, mana. */
  income: Record<number, { goods: number; research: number; mana: number }>; built: number; manaSpent: number;
  /** Income summed over every round up to 45 (smoother than one snapshot): goods, research, mana. */
  cum45: { goods: number; research: number; mana: number };
  techAt: Record<string, number>; fellAt?: number; mageChanAt: number | null; cmineAt: number | null; towerStartAt: number | null;
}

function towersDone(s: GameState, f: FactionId): number {
  return Object.values(s.buildings).filter((b) => b.owner === f && b.type === 'magetower' && b.buildLeft === 0).length;
}

/** A finished own tower with one of our units on it (`mage`: one carrying a staff or wand). */
function channelled(s: GameState, f: FactionId, mage: boolean): boolean {
  return Object.values(s.buildings).some((b) => b.owner === f && b.type === 'magetower' && b.buildLeft === 0
    && Object.values(s.units).some((u) => u.faction === f && !u.monster && u.pos.q === b.pos.q && u.pos.r === b.pos.r
      && (!mage || u.equipment.main === 'staff' || u.equipment.main === 'wand')));
}

function play(seed: number, difficulty: Difficulty, rounds: number) {
  const s = createGame({ mapSize: 'normal', seed, playerFaction: (env?.env.AI_METRICS_PLAYER ?? 'valen') as FactionId, aiCount: 2, difficulty });
  const human = s.turnOrder.find((f) => s.factions[f].isHuman)!;
  startTurn(s, s.turnOrder[s.currentTurn]);
  const houses: Record<string, House> = {};
  for (const f of s.turnOrder) {
    houses[f] = {
      arcanaAt: null, towerAt: null, chanAt: null, firstSpellAt: null, towers: {}, mana: {}, manaFullRounds: 0,
      buildings: {}, military: {}, techs: 0, spells: {}, alive: true, kills: 0, lost: 0,
      income: {}, built: 0, manaSpent: 0, cum45: { goods: 0, research: 0, mana: 0 },
      techAt: Object.fromEntries(s.factions[f].techs.map((t) => [t, 0])), mageChanAt: null, cmineAt: null, towerStartAt: null,
    };
  }
  const attacks: Record<string, number> = {};
  // Rounds in which the player still stood, and in which two AI houses did (attack rates).
  let playerRounds = 0, aiPairRounds = 0;
  const fac = () => { const m: Record<string, FactionId> = {}; for (const k in s.units) m[k] = s.units[k].faction; return m; };
  const count = (evs: GameEvent[], who: Record<string, FactionId>) => {
    for (const e of evs) {
      if (e.type === 'combat') {
        const a = who[String(e.attacker)], d = who[String(e.defender)];
        const k = a === 'neutral' || d === 'neutral' ? (a === 'neutral' ? 'monster>house' : 'house>monster')
          : d === human ? 'ai>player' : a === human ? 'player>ai' : 'ai>ai';
        attacks[k] = (attacks[k] ?? 0) + 1;
      } else if (e.type === 'spellCast') {
        const h = houses[e.faction];
        h.spells[e.spell] = (h.spells[e.spell] ?? 0) + 1;
        h.manaSpent += SPELLS[e.spell].mana;
        h.firstSpellAt ??= s.round;
      }
    }
  };
  // The player's house is AI-driven too: when its leader falls the game would end, so the
  // measurement goes on with the AIs that are left (the fallen house is then no player at all).
  const keepGoing = () => {
    if (!s.gameOver || s.factions[human].alive) return false;
    const left = s.turnOrder.filter((f) => s.factions[f].alive);
    if (left.length < 2) return false;
    s.gameOver = false;
    s.winner = null;
    s.factions[human].isHuman = false;
    houses[human].fellAt = s.round;
    return true;
  };
  let last = s.round;
  while (!s.gameOver && s.round <= rounds) {
    const f = currentFaction(s);
    const mem = createAiMemory(s, f);
    // AI_METRICS_IDLE=1: the player's house only ends its turns (attack choices are the AIs' own).
    const idle = !!env?.env.AI_METRICS_IDLE && f === human && s.factions[human].isHuman;
    for (; !idle;) {
      const a = aiNextAction(s, mem);
      if (!a) break;
      const who = fac();
      const r = applyAction(s, a);
      expect(r.ok).toBe(true);
      count(r.events, who);
      if (s.gameOver && !keepGoing()) break;
      if (currentFaction(s) !== f) break;
    }
    if (s.gameOver) break;
    if (currentFaction(s) !== f) continue;
    const who = fac();
    count(applyAction(s, { type: 'endTurn', faction: f }).events, who);
    if (s.gameOver && !keepGoing()) break;
    if (s.round !== last) {
      last = s.round;
      if (s.factions[human].alive && s.factions[human].isHuman) playerRounds++;
      if (s.turnOrder.filter((g) => g !== human && s.factions[g].alive).length >= 2) aiPairRounds++;
      for (const g of s.turnOrder) {
        const h = houses[g];
        h.alive = s.factions[g].alive;
        if (!h.alive) continue;
        const n = towersDone(s, g);
        if (h.arcanaAt === null && hasTech(s, g, 'arcana')) h.arcanaAt = s.round;
        if (h.towerAt === null && n > 0) h.towerAt = s.round;
        if (h.chanAt === null && channelled(s, g, false)) h.chanAt = s.round;
        if (h.mageChanAt === null && channelled(s, g, true)) h.mageChanAt = s.round;
        for (const t of s.factions[g].techs) h.techAt[t] ??= s.round;
        const bl = Object.values(s.buildings).filter((b) => b.owner === g);
        if (h.cmineAt === null && bl.some((b) => b.type === 'crystalmine' && b.buildLeft === 0)) h.cmineAt = s.round;
        if (h.towerStartAt === null && bl.some((b) => b.type === 'magetower')) h.towerStartAt = s.round;
        if (s.factions[g].resources.mana >= manaCap(s, g) * 0.95) h.manaFullRounds++;
        if (s.round <= 45) {
          const inc = s.factions[g].income;
          h.cum45.goods += inc.gold + inc.food + inc.wood + inc.stone + inc.iron + inc.crystal;
          h.cum45.research += inc.research;
          h.cum45.mana += inc.mana;
        }
        if (s.round === 20 || s.round === 30 || s.round === 45) {
          const inc = s.factions[g].income;
          h.income[s.round] = {
            goods: Math.round(inc.gold + inc.food + inc.wood + inc.stone + inc.iron + inc.crystal), research: Math.round(inc.research), mana: Math.round(inc.mana * 10) / 10,
          };
        }
        if (s.round % 10 === 0) {
          h.towers[s.round] = n;
          h.mana[s.round] = Math.round(s.factions[g].resources.mana);
          h.buildings[s.round] = Object.values(s.buildings).filter((b) => b.owner === g).length;
          h.military[s.round] = Object.values(s.units).filter((u) => u.faction === g && !u.isLeader && u.equipment.main !== 'tools').length;
        }
      }
    }
  }
  for (const g of s.turnOrder) {
    houses[g].techs = s.factions[g].techs.length;
    houses[g].built = s.factions[g].stats.built;
    houses[g].kills = s.factions[g].stats.kills;
    houses[g].lost = s.factions[g].stats.lost;
    houses[g].alive = s.factions[g].alive;
  }
  return { seed, difficulty, rounds: s.round, winner: s.winner, human, houses, attacks, playerRounds, aiPairRounds };
}

describe.runIf(ON)('AI metrics (AI-only games)', () => {
  const seeds = (env?.env.AI_METRICS_SEEDS ?? '544774,7,11,23,42').split(',').map(Number);
  const rounds = Number(env?.env.AI_METRICS_ROUNDS ?? 60);
  const diffs = (env?.env.AI_METRICS_DIFF ?? 'normal,hard').split(',') as Difficulty[];
  for (const difficulty of diffs) {
    it(`${difficulty}: seeds ${seeds.join(',')}, ${rounds} rounds`, () => {
      type Row = { f: string; ai: boolean; h: House };
      const rows: Row[] = [];
      let aiPlayer = 0, aiAi = 0, playerAi = 0, playerRounds = 0, aiPairRounds = 0, playerFell = 0;
      for (const seed of seeds) {
        const g = play(seed, difficulty, rounds);
        out(`== ${difficulty} seed ${seed} → round ${g.rounds} winner ${g.winner ?? '-'} attacks ${JSON.stringify(g.attacks)} player rounds ${g.playerRounds}`);
        for (const [f, h] of Object.entries(g.houses)) {
          out(`  ${f}${f === g.human ? '(P)' : ''}${h.alive ? '' : '†'} arcana@${h.arcanaAt ?? '-'} tower@${h.towerAt ?? '-'} mageChan@${h.mageChanAt ?? '-'} `
            + `spell1@${h.firstSpellAt ?? '-'} towers ${JSON.stringify(h.towers)} mana ${JSON.stringify(h.mana)} full ${h.manaFullRounds} `
            + `bld ${JSON.stringify(h.buildings)} mil ${JSON.stringify(h.military)} techs ${h.techs} k/l ${h.kills}/${h.lost} spells ${JSON.stringify(h.spells)}`
            + `${h.fellAt ? ` fell@${h.fellAt}` : ''}\n     cmine@${h.cmineAt ?? '-'} towerStart@${h.towerStartAt ?? '-'} anyChan@${h.chanAt ?? '-'} techs ${Object.entries(h.techAt).map(([t, r]) => `${t}@${r}`).join(' ')}`);
          rows.push({ f, ai: f !== g.human, h });
        }
        aiPlayer += g.attacks['ai>player'] ?? 0;
        aiAi += g.attacks['ai>ai'] ?? 0;
        playerAi += g.attacks['player>ai'] ?? 0;
        playerRounds += g.playerRounds;
        aiPairRounds += g.aiPairRounds;
        if (g.houses[g.human].fellAt) playerFell++;
      }
      const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const avg = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '-'; };
      const sumUp = (label: string, rs: Row[]) => {
        const n = rs.length;
        const by = (r: number, k: 'towerAt' | 'mageChanAt' | 'firstSpellAt') => rs.filter((x) => x.h[k] !== null && x.h[k]! <= r).length;
        const spells: Record<string, number> = {};
        for (const x of rs) for (const [k, v] of Object.entries(x.h.spells)) spells[k] = (spells[k] ?? 0) + (v ?? 0);
        const total = Object.values(spells).reduce((a, b) => a + b, 0);
        out(`## ${difficulty} ${label} (${n} houses): tower by r25 ${by(25, 'towerAt')}/${n} r30 ${by(30, 'towerAt')}/${n} r45 ${by(45, 'towerAt')}/${n}; `
          + `mage channeler by r30 ${by(30, 'mageChanAt')}/${n} r40 ${by(40, 'mageChanAt')}/${n}; first spell by r35 ${by(35, 'firstSpellAt')}/${n} r45 ${by(45, 'firstSpellAt')}/${n}; `
          + `median arcana@${med(rs.map((x) => x.h.arcanaAt ?? 999))} tower@${med(rs.map((x) => x.h.towerAt ?? 999))} mageChan@${med(rs.map((x) => x.h.mageChanAt ?? 999))} spell1@${med(rs.map((x) => x.h.firstSpellAt ?? 999))}; `
          + `spells ${total} ${JSON.stringify(spells)} mana spent/house ${avg(rs.map((x) => x.h.manaSpent))}; avg towers r30 ${avg(rs.map((x) => x.h.towers[30]))} r60 ${avg(rs.map((x) => x.h.towers[60]))}, mana r30 ${avg(rs.map((x) => x.h.mana[30]))} r60 ${avg(rs.map((x) => x.h.mana[60]))}, mana-full rounds ${rs.reduce((a, x) => a + x.h.manaFullRounds, 0)}; `
          + `economy (alive houses) buildings r30 ${avg(rs.map((x) => x.h.buildings[30]))} r60 ${avg(rs.map((x) => x.h.buildings[60]))}, military r30 ${avg(rs.map((x) => x.h.military[30]))} r60 ${avg(rs.map((x) => x.h.military[60]))}, techs ${avg(rs.map((x) => x.h.techs))}, built ${avg(rs.map((x) => x.h.built))}, `
          + `income goods r20 ${avg(rs.map((x) => x.h.income[20]?.goods))} r30 ${avg(rs.map((x) => x.h.income[30]?.goods))} r45 ${avg(rs.map((x) => x.h.income[45]?.goods))}, `
          + `research r20 ${avg(rs.map((x) => x.h.income[20]?.research))} r30 ${avg(rs.map((x) => x.h.income[30]?.research))} r45 ${avg(rs.map((x) => x.h.income[45]?.research))}, `
          + `mana/turn r30 ${avg(rs.map((x) => x.h.income[30]?.mana))} r45 ${avg(rs.map((x) => x.h.income[45]?.mana))}, `
          + `income summed r1-45 (houses alive at 45) goods ${avg(rs.filter((x) => x.h.income[45]).map((x) => x.h.cum45.goods))} research ${avg(rs.filter((x) => x.h.income[45]).map((x) => x.h.cum45.research))} mana ${avg(rs.filter((x) => x.h.income[45]).map((x) => x.h.cum45.mana))}, kills ${avg(rs.map((x) => x.h.kills))} lost ${avg(rs.map((x) => x.h.lost))}`);
      };
      sumUp('AI houses', rows.filter((x) => x.ai));
      sumUp('all houses', rows);
      out(`## ${difficulty} attacks: ai>player ${aiPlayer} in ${playerRounds} player rounds (${(aiPlayer / Math.max(1, playerRounds)).toFixed(2)}/round), `
        + `ai>ai ${aiAi} in ${aiPairRounds} two-AI rounds (${(aiAi / Math.max(1, aiPairRounds)).toFixed(2)}/round), player>ai ${playerAi}; player fell in ${playerFell}/${seeds.length} games`);
    }, 1_800_000);
  }
});
