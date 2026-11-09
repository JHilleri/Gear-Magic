// Internal types of the AI (sim/ai/*). Nothing here is part of the public game contract.
import type {
  AttackKind, Building, BuildingId, CombatForecast, FactionDef, FactionId, FactionState, GameState, Hex, ReachInfo, Resources, Unit,
} from '../../core/types';
import type { AiMemory } from './index';

/** What a unit is for, derived from its main-hand item (see loadout.ts). */
export type Track = 'melee' | 'archer' | 'mage' | 'builder' | 'leader' | 'none' | 'summon';

/** Strategic posture for the turn. */
export type Stance = 'build' | 'attack';

/** Kinds of attack plans the tactical search can produce. */
export type PlanKind = AttackKind | 'firebolt' | 'volley';

/** Hexes (tile indices) one visible enemy could strike next turn, assuming full movement. */
export interface Threat {
  id: number;
  melee: Set<number>;
  ranged: Set<number>;
  /** Furthest hex distance it can strike from its current position (movement + range). */
  reach: number;
}

/** A move+attack being executed across several aiNextAction calls. */
export interface PendingAttack {
  unit: number;
  target: number;
  kind: PlanKind;
  hex: Hex;
  aux?: Hex;           // volley centre
}

/** A construction or upgrade job handed to one builder. */
export interface BuildTask {
  kind: 'build' | 'upgrade' | 'resume';
  type: BuildingId;
  site: Hex;
  builder: number;
  affordable: boolean;
}

/** Decisions taken once per AI turn (first call) and reused by every later call. */
export interface Strategy {
  stance: Stance;
  /** Enemy faction the army marches on. */
  target: FactionId | null;
  /** Where the army marches (enemy castle, else nearest enemy building / leader). */
  anchor: Hex | null;
  /** Units marching in attack stance. */
  army: Set<number>;
  /** Units kept home in attack stance. */
  garrison: Set<number>;
  /** Mages posted to channel in a working mage tower: unit id → the tower's hex. */
  channelers: Map<number, Hex>;
  /** Marching units may not end closer to the anchor than this (distance-field units). */
  advanceLimit: number;
  /** Hostile faction units (or monsters) close to our buildings. */
  intruders: Unit[];
  /** Hostile faction units close enough to the castle to warrant emergency measures. */
  castleThreat: number;
  /** Wanted number of military units. */
  armyTarget: number;
  /** Planned track for unarmed units (commoners waiting for a weapon). */
  tracks: Map<number, Track>;
  /** Any visible enemy rider (spears get a priority bump). */
  enemyMounted: boolean;
  /** Army power vs. visible hostile power around it (attack stance only, else 0). */
  balance: number;
}

/** Scratch data persisted across the calls of one AI turn (lives in AiMemory.data.turn). */
export interface TurnData {
  dist: Map<string, Float64Array>;
  threats: Map<number, Threat>;
  prof: Map<string, number>;
  /** Units whose positioning is finished for this turn (they may still attack). */
  handled: Set<number>;
  /** How many times each action key has been returned (no-progress guard). */
  returned: Map<string, number>;
  flags: Set<string>;
  pending: PendingAttack | null;
  strategy: Strategy | null;
  /** Exclusive claims on map objectives: 'loot:<idx>', 'post:<idx>', 'site:<idx>', … */
  claims: Map<string, number>;
  tasks: BuildTask[] | null;
  /** Attack plans per unit, valid while the unit's local signature is unchanged. */
  plans: Map<string, { sig: string; plan: unknown }>;
  /** Combat forecasts keyed by every input they depend on (valid all turn). */
  forecasts: Map<string, CombatForecast | null>;
  /** Exposure hit lists (`${unit}|${tile}|${armor}`), valid while the visible enemies are the same. */
  hits: Map<string, { id: number; v: number }[]>;
  hitsSig: string;
  /** factionIncome, valid while the faction's unit and building counts are unchanged. */
  incomeCache: { sig: string; inc: Resources } | null;
  /**
   * Reachability per `${unit}:${mp}` (the Haste look-ahead uses mp + 3 and must not evict the
   * normal entry), valid while its position and surroundings are unchanged.
   */
  reachCache: Map<string, { sig: string; reach: ReachInfo[] }>;
  /** Builds started this turn (forces a re-plan). */
  plannedAt: number;
}

/** Per-call view of the world for one AI faction. */
export interface Ctx {
  s: GameState;
  mem: AiMemory;
  t: TurnData;
  f: FactionId;
  fs: FactionState;
  def: FactionDef;
  units: Unit[];
  leader: Unit | undefined;
  castle: Building | undefined;
  home: Hex;
  own: Building[];
  /** Hostile units the faction can currently see (monsters included). */
  enemies: Unit[];
  /** Visible hostile faction units (no monsters). */
  foes: Unit[];
  monsters: Unit[];
  /** Fighting units (no leader, no builders). */
  military: Unit[];
  builders: Unit[];
  reach: Map<number, ReachInfo[]>;
  /** Per-call memo: `${unit}|${tile}` → expected hits on that hex, strongest first. */
  hits: Map<string, { id: number; v: number }[]>;
  /** Per-call memo of factionIncome. */
  income: Resources | null;
  /** Per-call memo of per-unit scalars ('hp:<id>', 'val:<id>', 'arm:<id>'). */
  memo: Map<string, number>;
  /** Tile index → unit standing there (all factions), for fast area queries. */
  at: Map<number, Unit>;
  /** Hexes of own and enemy units with the Leadership passive (forecast cache keys). */
  leadHexes: Set<string>;
}
