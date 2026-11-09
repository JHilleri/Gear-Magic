// AI controller. Uses only sim/actions (same rules as the player). See DESIGN §9.
//
// Every call rebuilds a cheap view of the world (Ctx) and walks the phases below in order; the
// first phase with something useful to do returns one validated action. Expensive analysis
// (strategy, threat map, distance fields, build plan) lives in `mem.data.turn` for the whole
// turn. Each phase only returns actions that make progress (spend movement, an action, a
// resource or a cooldown), so the turn always terminates; a hard step cap backs that up.
import type { Action, FactionId, GameState, Unit } from '../../core/types';
import { FACTIONS } from '../../data/factions';
import { tileIndex } from '../../core/hex';
import { aiChooseLevelOption } from '../progression';
import { currentFaction } from '../state';
import { canBuildWith } from '../units';
import { isVisible } from '../visibility';
import { buildPhase, builderMovePhase, craftPhase, equipPhase, recruitPhase } from './economy-ai';
import { fortifyPhase, hastePhase, mendPhase, rallyPhase, spellPhase } from './magic';
import { researchPhase } from './research-ai';
import { getStrategy } from './strategy';
import { attackPhase, leaderPhase, militaryMovePhase, retreatPhase } from './tactics';
import type { Ctx, TurnData } from './types';
import { actionKey, attempt } from './util';

/** Per-turn scratch memory (plans, assignments). Create a fresh one at the start of each AI turn. */
export interface AiMemory {
  faction: FactionId;
  step: number;
  phase: string;
  failed: Set<string>;   // keys of actions that failed, to avoid loops
  data: Record<string, unknown>;
}

/** Hard cap on actions per AI turn (the controller caps at 500 too). */
export const AI_STEP_CAP = 400;

export function createAiMemory(state: GameState, faction: FactionId): AiMemory {
  void state;
  return { faction, step: 0, phase: 'start', failed: new Set<string>(), data: {} };
}

function turnData(mem: AiMemory): TurnData {
  let t = mem.data.turn as TurnData | undefined;
  if (!t) {
    t = {
      dist: new Map(), threats: new Map(), prof: new Map(), handled: new Set(), returned: new Map(),
      flags: new Set(), pending: null, strategy: null, claims: new Map(), tasks: null, plannedAt: 0, plans: new Map(),
      forecasts: new Map(), reachCache: new Map(), incomeCache: null, hits: new Map(), hitsSig: '',
    };
    mem.data.turn = t;
  }
  return t;
}

function buildCtx(s: GameState, mem: AiMemory): Ctx {
  const f = mem.faction;
  const fs = s.factions[f];
  const t = turnData(mem);
  const ids = Object.keys(s.units).map(Number).sort((a, b) => a - b);
  const units: Unit[] = [];
  const enemies: Unit[] = [];
  for (const id of ids) {
    const u = s.units[String(id)];
    if (!u || u.hp <= 0) continue;
    if (u.faction === f) units.push(u);
    else if (isVisible(s, f, u.pos)) enemies.push(u);
  }
  // Threat entries of units that died or vanished into the fog are dropped lazily by id.
  for (const id of t.threats.keys()) if (!s.units[String(id)]) t.threats.delete(id);
  // Exposure memos stay valid while the same enemies are in sight (they do not move on our turn).
  const hitsSig = enemies.map((e) => e.id).join(',');
  if (hitsSig !== t.hitsSig) { t.hits.clear(); t.hitsSig = hitsSig; }
  const leader = fs.leaderId != null ? s.units[String(fs.leaderId)] : undefined;
  const cb = fs.castleId != null ? s.buildings[String(fs.castleId)] : undefined;
  const castle = cb && cb.owner === f && cb.type === 'castle' ? cb : undefined;
  const own = Object.values(s.buildings).filter((b) => b.owner === f).sort((a, b) => a.id - b.id);
  const home = castle?.pos ?? leader?.pos ?? own[0]?.pos ?? units[0]?.pos ?? { q: 0, r: 0 };
  const leadHexes = new Set<string>();
  const at = new Map<number, Unit>();
  for (const k in s.units) {
    const u = s.units[k];
    if (u.passives.includes('leadership')) leadHexes.add(`${u.faction}@${u.pos.q},${u.pos.r}`);
    if (u.hp > 0) at.set(tileIndex(u.pos, s.width), u);
  }
  return {
    s, mem, t, f, fs, def: FACTIONS[f],
    units, leader, castle, home, own, enemies,
    foes: enemies.filter((e) => e.faction !== 'neutral'),
    monsters: enemies.filter((e) => e.faction === 'neutral'),
    military: units.filter((u) => !u.isLeader && !canBuildWith(u)),
    builders: units.filter((u) => !u.isLeader && canBuildWith(u)),
    reach: new Map(),
    hits: t.hits,
    income: null,
    leadHexes,
    memo: new Map(),
    at,
  };
}

/** Level-ups gained during our own turn (start-of-turn ones are resolved by turn.startTurn). */
function levelUpPhase(ctx: Ctx): Action | null {
  for (const u of ctx.units) {
    if (u.pendingLevelUps <= 0 || !u.levelUpOptions.length) continue;
    const option = aiChooseLevelOption(ctx.s, u);
    if (!option) continue;
    const a = attempt(ctx, { type: 'levelup', unit: u.id, option });
    if (a) return a;
  }
  return null;
}

interface Phase { name: string; run: (ctx: Ctx) => Action | null }

/** Phase order: bookkeeping, economy spend, magic, combat, movement, then late spending. */
const PHASES: Phase[] = [
  { name: 'levelup', run: levelUpPhase },
  { name: 'research', run: researchPhase },
  { name: 'build', run: buildPhase },
  { name: 'spells', run: spellPhase },
  { name: 'rally', run: rallyPhase },
  { name: 'attack', run: attackPhase },
  { name: 'haste', run: hastePhase },
  { name: 'craft', run: craftPhase },
  { name: 'equip', run: equipPhase },
  { name: 'retreat', run: retreatPhase },
  { name: 'leader', run: leaderPhase },
  { name: 'builders', run: builderMovePhase },
  { name: 'military', run: militaryMovePhase },
  { name: 'mend', run: mendPhase },
  { name: 'recruit', run: recruitPhase },
  { name: 'fortify', run: fortifyPhase },
];

/**
 * Next action for this AI faction, or null when it is done (the caller then applies
 * { type: 'endTurn' }). Called repeatedly; the caller applies each returned action with
 * applyAction before calling again. Must terminate (hard cap ~400 actions per turn) and
 * never return an action that failed before in this memory.
 */
export function aiNextAction(state: GameState, mem: AiMemory): Action | null {
  if (state.gameOver) return null;
  if (currentFaction(state) !== mem.faction) return null;
  const fs = state.factions[mem.faction];
  if (!fs || !fs.alive || mem.faction === 'neutral') return null;
  if (mem.step >= AI_STEP_CAP) { mem.phase = 'capped'; return null; }
  mem.step++;
  // Optional profiling (tests / debug overlay): mem.data.profile = {} collects ms per phase.
  const prof = mem.data.profile as Record<string, number> | undefined;
  let t0 = prof ? performance.now() : 0;
  const ctx = buildCtx(state, mem);
  getStrategy(ctx);
  if (prof) { const t1 = performance.now(); prof.setup = (prof.setup ?? 0) + t1 - t0; t0 = t1; }
  for (const phase of PHASES) {
    mem.phase = phase.name;
    const a = phase.run(ctx);
    if (prof) { const t1 = performance.now(); prof[phase.name] = (prof[phase.name] ?? 0) + t1 - t0; t0 = t1; }
    if (a) {
      const key = actionKey(a);
      ctx.t.returned.set(key, (ctx.t.returned.get(key) ?? 0) + 1);
      return a;
    }
  }
  mem.phase = 'done';
  return null;
}
