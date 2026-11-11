// Gear & Magic — shared type contracts. See /DESIGN.md.
// Everything in GameState is plain JSON (no classes, no Maps) so it can be saved/cloned.

// ───────────────────────────── identifiers ─────────────────────────────
export type FactionId = 'valen' | 'thorn' | 'ashen' | 'neutral';
export type RaceId = 'human' | 'orc' | 'undead' | 'monster';
export type TerrainId =
  | 'grass' | 'plains' | 'forest' | 'hills' | 'mountain'
  | 'swamp' | 'shallows' | 'water' | 'crystal' | 'ruins';
export type DepositId = 'iron' | 'crystal' | 'stone' | 'fertile';
export type ResourceId = 'gold' | 'food' | 'wood' | 'stone' | 'iron' | 'crystal' | 'mana' | 'research';
export type BuildingId =
  | 'castle' | 'house' | 'farm' | 'lumber' | 'quarry' | 'forge' | 'training'
  | 'mine' | 'crystalmine' | 'library' | 'magetower' | 'wall' | 'watchtower' | 'shrine';
export type ItemId =
  | 'tools' | 'sword' | 'spear' | 'axe' | 'bow' | 'staff' | 'wand' | 'shield'
  | 'tunic' | 'leather' | 'plate' | 'robe' | 'amulet' | 'ring' | 'horse';
export type EquipSlot = 'main' | 'off' | 'body' | 'trinket' | 'mount';
/** Kinds of experience (DESIGN §4.7): they weight which level-up options a unit is offered. */
export type XpCategory = 'melee' | 'ranged' | 'building' | 'civic' | 'explore' | 'leader' | 'magic';
export type EfficiencyId =
  | 'attack' | 'ranged' | 'magic' | 'farming' | 'building' | 'mining'
  | 'gathering' | 'mana' | 'research' | 'trade';
export type PassiveId =
  | 'regeneration' | 'poison' | 'skirmisher' | 'pathfinder' | 'ironskin' | 'leadership'
  | 'harvester' | 'prospector' | 'manaspring' | 'scholar' | 'marksman' | 'berserker'
  | 'vampiric' | 'inspiring' | 'reflexes';
export type ActiveId =
  | 'powerstrike' | 'volley' | 'heal' | 'firebolt' | 'rally' | 'fortify' | 'blink'
  | 'masonry' | 'devotion';
export type TechId =
  | 'mining' | 'writing' | 'croprotation' | 'masonry' | 'architecture' | 'guilds'
  | 'scholarship' | 'grandarchitecture'
  | 'tanning' | 'polearms' | 'shieldcraft' | 'platesmithing' | 'horsemanship' | 'tactics'
  | 'crystallore' | 'arcana' | 'wandcraft' | 'jewelcraft'
  | 'spell_heal' | 'spell_bless' | 'spell_fireball' | 'spell_haste' | 'spell_farsight'
  | 'spell_summon' | 'spell_storm';
export type SpellId = 'heal' | 'bless' | 'fireball' | 'haste' | 'farsight' | 'summon' | 'storm';
export type PresetId =
  | 'commoner' | 'builder' | 'swordsman' | 'spearman' | 'archer' | 'knight'
  | 'apprentice' | 'battlemage';
/** Visual body variant of a unit model (chosen from the body item). */
export type BodyVariant = 'commoner' | 'light' | 'heavy' | 'robe' | 'leader';
/** Neutral monster kinds and summons (non-humanoid or special models). */
export type MonsterKind = 'wolf' | 'golem' | 'spider' | 'elemental';
export type AttackKind = 'melee' | 'ranged' | 'magic';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type UnitId = number;
/** Standing order (DESIGN §4.10): stay put until healed, or keep watch until an enemy shows up. */
export type UnitOrder = 'heal' | 'sentry';
/** Why a standing order ended: the unit is whole again, a hostile came close, or it was attacked. */
export type OrderEndReason = 'healed' | 'enemy' | 'attacked';
export type BuildingInstanceId = number;

// ───────────────────────────── hex coords ─────────────────────────────
/** Axial hex coordinate (pointy-top). */
export interface Hex { q: number; r: number }

// ───────────────────────────── static data (data/*.ts) ─────────────────────────────
export type Resources = Record<ResourceId, number>;
export type ResourceCost = Partial<Record<ResourceId, number>>;

export interface TerrainDef {
  id: TerrainId;
  name: string;
  moveCost: number;          // Infinity for impassable
  defense: number;           // % chance to be missed when standing here (0-100)
  height: number;            // render height offset (world units)
  buildable: boolean;
  color: string;             // minimap color
  description: string;
}

export interface AttackDef {
  kind: AttackKind;
  name: string;
  base: number;              // base damage per strike (before stat scaling)
  strikes: number;
  range: number;             // 1 = adjacent
  firststrike?: boolean;
  vsMounted?: number;        // damage multiplier vs mounted targets
}

export interface ItemDef {
  id: ItemId;
  name: string;
  slot: EquipSlot;
  twoHanded?: boolean;
  cost: ResourceCost;
  unlock: TechId | null;     // null = available from start
  attack?: AttackDef;        // weapon attack granted (main slot)
  meleeFallback?: AttackDef; // e.g. bow's weak melee
  stats?: Partial<UnitStats>;
  terrainDefense?: number;   // flat bonus to tile defense (shield)
  manaPerTurn?: number;
  regen?: number;
  magicDamageMult?: number;  // e.g. ring 1.15
  canBuild?: boolean;        // tools
  mount?: boolean;           // horse
  body?: BodyVariant;        // visual body variant this armor selects
  description: string;
  icon: string;              // path under /assets/icons
}

export interface UnitStats {
  maxHp: number;
  str: number;
  dex: number;
  int: number;
  armor: number;             // % damage reduction (after block)
  /** Flat damage taken off every strike that hits, before the armor % (magic and flanking strikes ignore it). */
  block: number;
  mov: number;
  vis: number;
}

export interface BuildingDef {
  id: BuildingId;
  name: string;
  terrains: TerrainId[];     // allowed terrains
  deposit?: DepositId;       // required deposit
  output: ResourceCost;      // per turn at level 1
  fertileBonus?: ResourceCost;
  cost: ResourceCost;
  buildPoints: number;
  unlock: TechId | null;
  unlockSkill?: ActiveId;    // building unlocked by a unit skill instead of tech
  defense?: number[];        // per level (index 0 = level 1) tile defense bonus
  heal?: number;             // hp healed per turn for own units on it
  territoryRadius: number;
  recruits?: PresetId[];
  armory?: boolean;          // units may equip here
  /** Drill XP for a unit stationed here; `rangedCat` replaces `cat` for a unit whose main weapon is ranged. */
  xpPerTurn?: { cat: XpCategory; amount: number; rangedCat?: XpCategory };
  visionBonus?: number;
  maxLevel: number;
  uncapturable?: boolean;
  description: string;
  icon: string;
  model: string;             // GLB path under /assets/models/buildings
}

export interface SkillOptionDef {
  /** Unique option id, e.g. 'stat_str', 'eff_farming', 'passive_poison', 'active_heal'. */
  id: string;
  kind: 'stat' | 'efficiency' | 'passive' | 'active';
  name: string;
  description: string;
  categories: XpCategory[];  // xp categories that make this option likely
  stat?: Partial<UnitStats>;
  efficiency?: EfficiencyId;
  passive?: PassiveId;
  active?: ActiveId;
  weight: number;            // base weight
  icon: string;
}

export interface ActiveSkillDef {
  id: ActiveId;
  name: string;
  description: string;
  cooldown: number;          // 0 = permanent unlock (not an action)
  range: number;             // 0 = self / no target
  target: 'none' | 'enemy' | 'ally' | 'hex';
  unlocksBuilding?: BuildingId;
  icon: string;
}

export interface TechDef {
  id: TechId;
  name: string;
  branch: 'civic' | 'military' | 'arcane';
  cost: number;
  requires: TechId[];
  description: string;
  unlocksBuildings?: BuildingId[];
  unlocksItems?: ItemId[];
  unlocksSpell?: SpellId;
  bonus?: { resource?: ResourceId; mult?: number; damageMult?: number; maxBuildingLevel?: number };
  icon: string;
  /** Layout position in the research screen grid (column = tier, row within branch). */
  tier: number;
  row: number;
}

export interface SpellDef {
  id: SpellId;
  name: string;
  mana: number;
  range: number;
  cooldown: number;
  radius: number;
  target: 'ally' | 'enemy' | 'any' | 'empty';
  description: string;
  icon: string;
}

export interface PresetDef {
  id: PresetId;
  name: string;
  items: ItemId[];
  sites: BuildingId[];       // buildings that can recruit it
  description: string;
}

export interface FactionDef {
  id: FactionId;
  name: string;
  race: RaceId;
  color: string;             // primary (css hex)
  accent: string;            // secondary
  statMods: Partial<UnitStats>;
  meleeMult?: number;
  rangedMult?: number;
  magicMult?: number;
  foodUpkeep: number;        // per non-leader unit
  leaderName: string;
  unitNames: string[];       // random name pool (male units: every unit not covered below)
  /** Name pool for female units: human recruits whose first body is the light body (DESIGN §4.9). Falls back to unitNames. */
  femaleUnitNames?: string[];
  emblem: string;            // icon path
  researchPriority: TechId[];
  /** Signature techs the house knows from turn 1 (DESIGN §2). */
  startingTechs?: TechId[];
  flavor: string;
}

// ───────────────────────────── dynamic state ─────────────────────────────
export interface Tile {
  terrain: TerrainId;
  deposit: DepositId | null;
  elevation: number;         // 0..1 noise height (render variety)
  building: BuildingInstanceId | null;
  ruinsLooted?: boolean;
  /** Variation seed for decorations. */
  variant: number;
}

export interface Equipment {
  main: ItemId | null;
  off: ItemId | null;
  body: ItemId | null;
  trinket: ItemId | null;
  mount: ItemId | null;
}

export interface Buff {
  id: 'bless' | 'fortify' | 'haste' | 'powerstrike' | 'farsight';
  turns: number;             // remaining turns (decremented at owner's turn start)
  damageMult?: number;
  armor?: number;
}

export interface Unit {
  id: UnitId;
  faction: FactionId;
  name: string;
  race: RaceId;
  monster?: MonsterKind;     // set for neutral monsters & summons
  isLeader: boolean;
  pos: Hex;
  hp: number;
  base: UnitStats;           // base stats incl. level-up stat picks (not equipment)
  level: number;
  xp: number;                // xp into the current level
  xpByCat: Record<XpCategory, number>;      // lifetime totals (UI)
  levelXpByCat: Record<XpCategory, number>; // earned during the current level (level-up weighting)
  pendingLevelUps: number;
  levelUpOptions: string[][];  // one array of 3 SkillOptionDef ids per pending level-up
  /** XP mix (levelXpByCat at the moment of leveling) that weighted each pending offer; parallel to levelUpOptions. */
  levelUpXp?: Record<XpCategory, number>[];
  /** Fractional XP carried between grants (leaders' ×1.3 on small grants); absent = 0. */
  xpFrac?: number;
  equipment: Equipment;
  efficiency: Partial<Record<EfficiencyId, number>>; // multipliers, default 1
  passives: PassiveId[];
  actives: ActiveId[];
  cooldowns: Partial<Record<ActiveId, number>>;
  buffs: Buff[];
  poisoned: boolean;
  mp: number;                // movement points left this turn
  acted: boolean;            // attacked / used an action this turn
  moved: boolean;            // moved this turn (for rest healing)
  restedLastTurn: boolean;
  /** Recruited or summoned this turn: cannot march (Haste/Rally) or capture until its next turn. */
  justSpawned?: boolean;
  /** Attacked, or used an attack-like action, this turn: movement is over; Haste and Rally cannot restore it. */
  moveEnded?: boolean;
  summonTurns?: number;      // remaining life for summons
  kills: number;
  /** Guard anchor for neutral monsters. */
  home?: Hex;
  /** Standing order (DESIGN §4.10); absent = none. Any move, attack, skill, build or upgrade by the unit clears it. */
  order?: UnitOrder;
  /** Level history, oldest first: the option picked for each level reached (unit sheet). Absent on old saves until loaded. */
  learned?: LearnedOption[];
  /** Retaliations already made since the current turn began (DESIGN §4.5); absent = 0. Every turn start clears it. */
  reacted?: number;
  /**
   * Ranks of 2 and more of passives and actives learned again (DESIGN §4.8: data/ranks augmentRank).
   * An augment in `passives` / `actives` with no entry here is rank 1.
   */
  ranks?: Partial<Record<PassiveId | ActiveId, number>>;
  /** Damage per turn of the poison on this unit (Venom Blades rank of whoever poisoned it); absent = POISON_DAMAGE. */
  poisonDamage?: number;
}

/** One resolved level-up: the level the offer belonged to and the SkillOptionDef id picked. */
export interface LearnedOption { level: number; option: string }

export interface Building {
  id: BuildingInstanceId;
  type: BuildingId;
  owner: FactionId | null;   // null = abandoned
  pos: Hex;
  level: number;
  /** Remaining build points; 0 = complete. When upgrading, `upgrading` is true. */
  buildLeft: number;
  upgrading: boolean;
  recruitedThisTurn: boolean;
  craftedThisTurn: number;
  foundedRound: number;
}

export interface FactionState {
  id: FactionId;
  isHuman: boolean;
  alive: boolean;
  resources: Resources;
  /** Last computed per-turn income (for UI). */
  income: Resources;
  stockpile: Partial<Record<ItemId, number>>;
  techs: TechId[];
  researching: TechId | null;
  researchProgress: number;
  spellCooldowns: Partial<Record<SpellId, number>>;
  explored: number[];        // packed bitset-ish: 1 per tile index (0/1)
  visible: number[];         // 0/1 per tile index (recomputed)
  farsight: { hex: Hex; turns: number }[];
  leaderId: UnitId | null;
  castleId: BuildingInstanceId | null;
  stats: { kills: number; lost: number; built: number; researched: number; spellsCast: number };
  /** House credited with slaying this faction's leader ('neutral' = monsters; null = none, e.g. poison). */
  eliminatedBy?: FactionId | null;
}

export interface LogEntry { round: number; faction: FactionId | null; text: string; kind: 'info' | 'combat' | 'build' | 'research' | 'magic' | 'warning' | 'levelup' }

export interface GameSettings {
  mapSize: 'small' | 'normal' | 'large';
  seed: number;
  playerFaction: FactionId;
  aiCount: number;           // 1..2
  difficulty: Difficulty;
}

export interface GameState {
  version: 1;
  settings: GameSettings;
  width: number;
  height: number;
  tiles: Tile[];             // index = r * width + col (odd-r offset layout)
  units: Record<string, Unit>;      // key = String(UnitId)
  buildings: Record<string, Building>;
  factions: Record<string, FactionState>; // key = FactionId (includes 'neutral')
  turnOrder: FactionId[];    // non-neutral factions, human first
  currentTurn: number;       // index into turnOrder
  round: number;
  nextId: number;
  rngState: number;
  log: LogEntry[];
  winner: FactionId | null;
  gameOver: boolean;
}

// ───────────────────────────── actions & events ─────────────────────────────
export type Action =
  | { type: 'move'; unit: UnitId; to: Hex }
  | { type: 'attack'; unit: UnitId; target: UnitId; kind: AttackKind }
  | { type: 'build'; unit: UnitId; building: BuildingId }
  | { type: 'upgrade'; unit: UnitId }
  | { type: 'recruit'; site: BuildingInstanceId; preset: PresetId }
  | { type: 'craft'; forge: BuildingInstanceId; item: ItemId }
  | { type: 'equip'; unit: UnitId; item: ItemId }
  | { type: 'unequip'; unit: UnitId; slot: EquipSlot }
  | { type: 'research'; faction: FactionId; tech: TechId }
  | { type: 'cast'; faction: FactionId; spell: SpellId; tower: BuildingInstanceId; target: Hex }
  | { type: 'skill'; unit: UnitId; skill: ActiveId; target?: Hex }
  | { type: 'levelup'; unit: UnitId; option: string }
  /** Set (or with null cancel) a standing order. Free: spends no movement or action. */
  | { type: 'order'; unit: UnitId; order: UnitOrder | null }
  | { type: 'endTurn'; faction: FactionId };

export interface StrikeEvent {
  by: 'attacker' | 'defender';
  hit: boolean;
  damage: number;
  poisoned?: boolean;
  drained?: number;
}

export type GameEvent =
  | { type: 'unitMoved'; unit: UnitId; path: Hex[] }
  | { type: 'combat'; attacker: UnitId; defender: UnitId; kind: AttackKind; strikes: StrikeEvent[]; attackerHp: number; defenderHp: number }
  | { type: 'unitDied'; unit: UnitId; killer: UnitId | null; pos: Hex; faction: FactionId }
  | { type: 'unitDamaged'; unit: UnitId; amount: number; source: 'spell' | 'poison' | 'starvation' | 'skill' }
  | { type: 'unitHealed'; unit: UnitId; amount: number }
  | { type: 'unitSpawned'; unit: UnitId; pos: Hex; reason: 'recruit' | 'summon' | 'monster' }
  | { type: 'unitEquipped'; unit: UnitId; item: ItemId | null; slot: EquipSlot }
  | { type: 'unitLeveled'; unit: UnitId; level: number }
  | { type: 'skillUsed'; unit: UnitId; skill: ActiveId; target?: Hex; targets?: UnitId[] }
  | { type: 'buildingStarted'; building: BuildingInstanceId }
  | { type: 'buildingProgress'; building: BuildingInstanceId; left: number }
  | { type: 'buildingCompleted'; building: BuildingInstanceId }
  | { type: 'buildingCaptured'; building: BuildingInstanceId; from: FactionId | null; to: FactionId }
  | { type: 'buildingDestroyed'; building: BuildingInstanceId; pos: Hex }
  | { type: 'itemCrafted'; faction: FactionId; item: ItemId }
  | { type: 'researchCompleted'; faction: FactionId; tech: TechId }
  | { type: 'spellCast'; faction: FactionId; spell: SpellId; from: Hex; target: Hex; affected: UnitId[] }
  | { type: 'ruinsExplored'; unit: UnitId; pos: Hex; reward: string }
  | { type: 'turnStarted'; faction: FactionId; round: number }
  | { type: 'factionEliminated'; faction: FactionId; by: FactionId | null }
  | { type: 'gameOver'; winner: FactionId | null }
  /** Marker: the round wraps and the wild monsters act (pushed before their events; `round` is the round ending). */
  | { type: 'neutralPhase'; round: number }
  /** A standing order ended by itself (not by the unit's own action); `enemy` = the hostile that woke it. */
  | { type: 'orderEnded'; unit: UnitId; order: UnitOrder; reason: OrderEndReason; enemy?: UnitId }
  | { type: 'log'; entry: LogEntry };

export interface ActionResult {
  ok: boolean;
  error?: string;
  events: GameEvent[];
}

// ───────────────────────────── stat breakdown ─────────────────────────────
/** Where a stat contribution comes from (sim/units statBreakdown). Level-up gains count as 'other'. */
export type StatSourceKind = 'item' | 'buff' | 'passive' | 'tech' | 'faction' | 'mount' | 'other';

export interface StatContribution {
  /** Display label: an item / buff / passive name, the house name, "Level 3: Toughness", "Armor cap (70)". */
  source: string;
  kind: StatSourceKind;
  /** Signed amount added to the stat. */
  value: number;
  item?: ItemId;
  buff?: Buff['id'];
  passive?: PassiveId;
  /** Level option id (stat picks from the level history). */
  option?: string;
}

/** One stat: `base + Σ contributions.value === total === effectiveStats(unit)[stat]`. */
export interface StatLine { base: number; contributions: StatContribution[]; total: number }
export type StatBreakdown = Record<keyof UnitStats, StatLine>;

// ───────────────────────────── combat forecast ─────────────────────────────
export interface AttackProfile {
  kind: AttackKind;
  name: string;
  damage: number;            // per strike after all modifiers (vs this target)
  strikes: number;
  hitChance: number;         // 0..1
  range: number;
  firststrike: boolean;
  /**
   * Why the numbers are what they are (descriptive only, already included in damage / hit):
   * charge, Power Strike, leadership, berserker, bonus vs mounted, poison / drain on hit.
   */
  mods?: AttackMod[];
}

export type AttackModId = 'charge' | 'powerstrike' | 'leadership' | 'berserker' | 'vsMounted' | 'poison' | 'vampiric' | 'flank';
export interface AttackMod { id: AttackModId; label: string; mult?: number }

/** Outcome preview of a spell or active skill on one target hex (sim/spells previewSpell, sim/skills previewSkill). */
export interface EffectPreview {
  /** help: buffs / heals; harm: deals damage; neutral: neither (blink, farsight, summon). */
  tone: 'help' | 'harm' | 'neutral';
  entries: EffectEntry[];
  notes: string[];
}

export interface EffectEntry {
  unit: UnitId;
  /** Same faction as the caster (friendly fire for a harmful effect). */
  own: boolean;
  hpBefore: number;
  maxHp: number;
  /** Expected HP change (negative for damage). */
  hpDelta: number;
  /** Chance the effect kills the unit (0..1). */
  killChance: number;
  /** Final HP distribution (index = hp) when the outcome is random. */
  hpDist?: number[];
  mpDelta?: number;
  /** Outcome is an estimate (random target choice), not exact. */
  approx?: boolean;
}

export interface CombatForecast {
  attacker: AttackProfile;
  defender: AttackProfile | null;  // null = cannot retaliate
  /** The defender has an attack that reaches but has already used its reactions this turn. */
  defenderSpent?: boolean;
  /** Probability distribution of final hp, index = hp value. */
  attackerHpDist: number[];
  defenderHpDist: number[];
  attackerKillChance: number;      // chance attacker dies
  defenderKillChance: number;      // chance defender dies
  expectedDamageToDefender: number;
  expectedDamageToAttacker: number;
}

/** Reachable hex info for movement overlays. */
export interface ReachInfo {
  hex: Hex;
  cost: number;
  mpLeft: number;
  path: Hex[];               // from unit pos (exclusive) to hex (inclusive)
  zocStop: boolean;          // movement ends here due to ZOC
}
