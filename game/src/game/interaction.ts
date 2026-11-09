// Pure interaction helpers used by the controller & input layer (no DOM, no three.js, no sim
// imports) so that click resolution and attack choice can be unit-tested in isolation.
import type { ActiveId, AttackKind, BuildingInstanceId, CombatForecast, EffectPreview, FactionId, Hex, ReachInfo, SpellId, UnitId } from '../core/types';
import { hexEq } from '../core/hex';
import type { InteractionMode, ModalId } from './store';

// ───────────────────────────── attack choice ─────────────────────────────

export interface KindOption { kind: AttackKind; forecast: CombatForecast }

/**
 * Net value of an exchange for the attacker: damage dealt minus damage taken, with kills
 * weighted heavily (a likely kill is worth more than a few extra points of damage).
 */
export function tradeScore(f: CombatForecast): number {
  return f.expectedDamageToDefender - f.expectedDamageToAttacker
    + 12 * f.defenderKillChance - 16 * f.attackerKillChance;
}

/**
 * Pick the attack kind to use (DESIGN §10 / controller spec): with both a melee and a
 * ranged/magic option, use ranged when the defender cannot retaliate at range or when the
 * ranged trade is at least as good; otherwise melee. `swap` (Shift held) returns the
 * other option when two are available.
 */
export function chooseAttackKind(options: readonly KindOption[], swap = false): KindOption | null {
  if (options.length === 0) return null;
  if (options.length === 1) return options[0];
  const melee = options.find((o) => o.kind === 'melee');
  const ranged = options.find((o) => o.kind !== 'melee');
  if (!melee || !ranged) return options[0];
  let best: KindOption;
  if (!ranged.forecast.defender) best = ranged;
  else if (tradeScore(ranged.forecast) >= tradeScore(melee.forecast)) best = ranged;
  else best = melee;
  if (!swap) return best;
  return best === melee ? ranged : melee;
}

// ───────────────────────────── move + attack ─────────────────────────────

export interface ApproachCandidate {
  hex: Hex;
  cost: number;        // movement cost to get there
  defense: number;     // tile defense % for the attacker standing there
  options: KindOption[]; // attack options available from that hex against the target
}

export interface ApproachChoice { hex: Hex; option: KindOption }

/**
 * The attack Shift would switch to, given the default plan and the Shift plan against one target:
 * null when both use the same kind (there is no real alternative, so the hint must not offer one).
 */
export function altAttackOf<T extends { option: KindOption }>(base: T | null, swapped: T | null): T | null {
  if (!base || !swapped) return null;
  return base.option.kind !== swapped.option.kind ? swapped : null;
}

function approachScore(c: ApproachCandidate, o: KindOption): number {
  // trade quality first (already includes how hard we are to hit there), then defense, then a
  // tiny preference for shorter walks.
  return tradeScore(o.forecast) + c.defense * 0.05 - c.cost * 0.01;
}

/**
 * Best hex to move to before attacking a target that is out of reach from the current hex.
 * Without swap: each candidate uses its default attack kind, highest score wins (ties →
 * higher defense, then cheaper). With swap: prefer the kind that is *not* the default
 * choice; falls back to the default when no candidate offers the alternative.
 */
export function pickApproach(cands: readonly ApproachCandidate[], swap = false): ApproachChoice | null {
  const better = (a: { s: number; c: ApproachCandidate }, b: { s: number; c: ApproachCandidate } | null): boolean => {
    if (!b) return true;
    if (Math.abs(a.s - b.s) > 1e-9) return a.s > b.s;
    if (a.c.defense !== b.c.defense) return a.c.defense > b.c.defense;
    return a.c.cost < b.c.cost;
  };
  let best: { s: number; c: ApproachCandidate; o: KindOption } | null = null;
  for (const c of cands) {
    const o = chooseAttackKind(c.options);
    if (!o) continue;
    const cur = { s: approachScore(c, o), c, o };
    if (better(cur, best)) best = cur;
  }
  if (!best) return null;
  if (!swap) return { hex: best.c.hex, option: best.o };
  const defaultKind = best.o.kind;
  let alt: { s: number; c: ApproachCandidate; o: KindOption } | null = null;
  for (const c of cands) {
    const o = c.options.find((x) => x.kind !== defaultKind);
    if (!o) continue;
    const cur = { s: approachScore(c, o), c, o };
    if (better(cur, alt)) alt = cur;
  }
  const pick = alt ?? best;
  return { hex: pick.c.hex, option: pick.o };
}

// ───────────────────────────── click resolution ─────────────────────────────

export type ClickIntent =
  | { kind: 'none' }
  | { kind: 'cancel' }
  | { kind: 'select'; unit: UnitId }
  | { kind: 'tile'; hex: Hex }
  | { kind: 'move'; unit: UnitId; to: Hex }
  /** Beyond this turn's reach: walk as far as possible toward the hex (the unit stays selected). */
  | { kind: 'moveToward'; unit: UnitId; to: Hex }
  | { kind: 'attack'; unit: UnitId; target: UnitId; attack: AttackKind }
  | { kind: 'moveAttack'; unit: UnitId; to: Hex; target: UnitId; attack: AttackKind }
  | { kind: 'cast'; spell: SpellId; tower: BuildingInstanceId; target: Hex }
  | { kind: 'skill'; unit: UnitId; skill: ActiveId; target: Hex }
  | { kind: 'invalid'; reason: string };

export interface ClickUnitInfo { id: UnitId; faction: FactionId }

export interface ClickContext {
  hex: Hex;
  button: 'left' | 'right';
  swap: boolean;                    // Shift held
  mode: InteractionMode;
  human: FactionId;
  myTurn: boolean;                  // human's turn, not busy, game running
  /** Unit visible to the human at the clicked hex, if any. */
  unitAt: ClickUnitInfo | null;
  /** The selected unit (mode.kind 'unit' or 'attack'), if it still exists. */
  selected: ClickUnitInfo | null;
  reach: readonly ReachInfo[];
  /** Attack the target from the selected unit's current hex. */
  attackFromHere(target: UnitId, swap: boolean): KindOption | null;
  /** Move-then-attack plan against the target. */
  approach(target: UnitId, swap: boolean): ApproachChoice | null;
  /** Cast mode: best tower for the target hex, or an error message. */
  castCheck?(target: Hex): { tower: BuildingInstanceId } | { error: string };
  /** Skill mode: null when the skill can target the hex, else an error message. */
  skillCheck?(target: Hex): string | null;
  /**
   * Selected own unit, empty hex out of reach this turn: null when the unit can head there over
   * several turns, else why not (impassable, unexplored, no path). Absent: plain tile click.
   */
  towardCheck?(target: Hex): string | null;
}

/**
 * What a click on an enemy does for the own unit `unit`: attack from here, else move to the best
 * hex and attack from there; null when it cannot reach the target this turn.
 */
function attackOn(ctx: ClickContext, unit: UnitId, target: UnitId): ClickIntent | null {
  const here = ctx.attackFromHere(target, ctx.swap);
  if (here) return { kind: 'attack', unit, target, attack: here.kind };
  const ap = ctx.approach(target, ctx.swap);
  if (!ap) return null;
  if (hexEq(ap.hex, ctx.hex)) return { kind: 'none' };
  return { kind: 'moveAttack', unit, to: ap.hex, target, attack: ap.option.kind };
}

/** Translate a click on a hex into what the controller should do. Pure. */
export function resolveClick(ctx: ClickContext): ClickIntent {
  const { mode, hex } = ctx;

  if (mode.kind === 'cast') {
    if (ctx.button === 'right') return { kind: 'cancel' };
    if (!ctx.myTurn) return { kind: 'none' };
    const r = ctx.castCheck ? ctx.castCheck(hex) : { error: 'Cannot cast here' };
    if ('error' in r) return { kind: 'invalid', reason: r.error };
    return { kind: 'cast', spell: mode.spell, tower: r.tower, target: hex };
  }

  if (mode.kind === 'skill') {
    if (ctx.button === 'right') return { kind: 'cancel' };
    if (!ctx.myTurn) return { kind: 'none' };
    const err = ctx.skillCheck ? ctx.skillCheck(hex) : 'Invalid target';
    if (err) return { kind: 'invalid', reason: err };
    return { kind: 'skill', unit: mode.unit, skill: mode.skill, target: hex };
  }

  // Attack command: a click on an enemy in reach does what it does with the unit selected; anything
  // else (a friend, an empty hex, an enemy out of reach, the right button) backs out to the unit.
  if (mode.kind === 'attack') {
    if (ctx.button === 'right') return { kind: 'cancel' };
    if (!ctx.myTurn) return { kind: 'none' };
    const att = ctx.selected && ctx.selected.faction === ctx.human ? ctx.selected : null;
    const target = ctx.unitAt && ctx.unitAt.faction !== ctx.human ? ctx.unitAt : null;
    const a = att && target ? attackOn(ctx, att.id, target.id) : null;
    return a && a.kind !== 'none' ? a : { kind: 'cancel' };
  }

  const sel = mode.kind === 'unit' ? ctx.selected : null;
  const ownSel = sel && sel.faction === ctx.human && ctx.myTurn ? sel : null;
  const other = ctx.unitAt;

  // Right-click always cancels (DESIGN §10, Help, forecast footer); the alternative attack kind
  // is Shift+click, whose forecast the hover already previews.
  if (ctx.button === 'right') return { kind: 'cancel' };

  if (ownSel) {
    if (other && other.faction !== ctx.human) {
      return attackOn(ctx, ownSel.id, other.id) ?? { kind: 'select', unit: other.id };   // else inspect the enemy
    }
    if (other) return { kind: 'select', unit: other.id };
    if (ctx.reach.some((r) => hexEq(r.hex, hex))) return { kind: 'move', unit: ownSel.id, to: hex };
    if (ctx.towardCheck) {
      // Never silently drop the selection on a click past this turn's reach.
      const err = ctx.towardCheck(hex);
      return err ? { kind: 'invalid', reason: err } : { kind: 'moveToward', unit: ownSel.id, to: hex };
    }
    return { kind: 'tile', hex };
  }

  if (other) return { kind: 'select', unit: other.id };
  return { kind: 'tile', hex };
}

// ───────────────────────────── misc pure helpers ─────────────────────────────

/**
 * Why `u` may not open the Build menu, or null. Builder's Tools unlock every building; the
 * leader may always open it, since it can build (and so move) the castle without tools. The
 * menu then reports per building why it is unavailable.
 */
export function buildMenuBlock(u: { name: string; isLeader: boolean }, hasTools: boolean): string | null {
  if (hasTools || u.isLeader) return null;
  return `${u.name} needs Builder's Tools to build.`;
}

/** Pointer gesture is a click (not a camera drag) when it moved less than `threshold` px. */
export function isClickGesture(dx: number, dy: number, threshold = 6): boolean {
  return dx * dx + dy * dy <= threshold * threshold;
}

/** Next id after `current` in `ids` (wrapping); first id when current is absent. */
export function cycleNext<T>(ids: readonly T[], current: T | null): T | null {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  return ids[(i + 1) % ids.length];
}

// ───────────────────────────── end turn grace ─────────────────────────────

/** End-turn presses (Space, Enter, the button) are ignored this long after the player's turn begins. */
export const END_TURN_GRACE_MS = 700;
/** Longer after a fast-forwarded enemy turn: that is when the key is being mashed. */
export const END_TURN_GRACE_AFTER_FF_MS = 1000;

/** A press this soon after the previous end-turn press is part of a burst (mashing, a double tap): ignored. */
export const END_TURN_REPEAT_MS = 450;

/**
 * May a player end-turn request made at `now` end the turn that began at `turnStartedAt`? Not in
 * the turn's first `graceMs`, and not when the previous press (`lastPressAt`, counted or not) was
 * under END_TURN_REPEAT_MS ago: a burst of presses ends at most one turn.
 */
export function endTurnAllowed(now: number, turnStartedAt: number, graceMs = END_TURN_GRACE_MS, lastPressAt = -Infinity): boolean {
  return now - turnStartedAt >= graceMs && now - lastPressAt >= END_TURN_REPEAT_MS;
}

// ───────────────────────────── level-ups ─────────────────────────────

/**
 * Units whose level-up window may open by itself (turn start, after an action, after a pick):
 * pending choices the player has not put off. `deferred` maps a unit to how many choices were
 * waiting when the player chose "Decide later"; only a newer level-up (more choices waiting) offers
 * it by itself again. Put-off choices wait behind the HUD reminder and the unit panel button.
 */
export function levelUpsToOffer(units: readonly { id: UnitId; pendingLevelUps: number }[], deferred: ReadonlyMap<UnitId, number>): UnitId[] {
  return units.filter((u) => u.pendingLevelUps > (deferred.get(u.id) ?? 0)).map((u) => u.id);
}

// ───────────────────────────── trips ─────────────────────────────

/**
 * Why a unit cannot set out toward a hex this turn although it could with full MP: `step` is the
 * first hex's terrain and cost when that alone is too dear (else friendly units fill the hexes it
 * could afford, and it may not stop on them). `turns` counts this turn too (2 = arrives next turn).
 * `short` is for the hover chip, `long` for the warning a click gives.
 */
export function tooCostlyThisTurn(unit: string, step: { terrain: string; cost: number } | null, mpLeft: number, turns: number): { short: string; long: string } {
  const mp = Number.isInteger(mpLeft) ? String(mpLeft) : mpLeft.toFixed(1);
  const n = Math.max(1, turns - 1);
  const when = n === 1 ? 'It can get there next turn.' : `About ${n} turns to get there, setting out next turn.`;
  if (step) {
    return {
      short: `${step.terrain} cost ${step.cost} MP, ${mp} left`,
      long: `Too costly this turn: entering ${step.terrain} takes ${step.cost} MP and ${unit} has ${mp} left. ${when}`,
    };
  }
  return {
    short: `${mp} MP left, cannot stop on your units`,
    long: `Too costly this turn: ${unit} has ${mp} MP left, not enough to get past your units on the way. ${when}`,
  };
}

// ───────────────────────────── windows ─────────────────────────────

/** Windows a window hotkey (R, M, F, B, H, C/I) may replace; decision windows (results, level-up, new game, settings) stay. */
const HOTKEY_SWITCHABLE: ReadonlySet<ModalId> = new Set<ModalId>(['help', 'research', 'spellbook', 'menu', 'forge', 'recruit', 'equip', 'build', 'unitsheet']);

/** What a window hotkey does with `target` while `current` is open. */
export function hotkeyModalAction(current: ModalId, target: Exclude<ModalId, null>): 'open' | 'close' | 'none' {
  if (current === target) return 'close';
  if (current === null || HOTKEY_SWITCHABLE.has(current)) return 'open';
  return 'none';
}

/**
 * Window to return to when `next` (opened over `prev`) closes: Settings and Help go back to the
 * pause menu; the equip and level-up windows opened from a unit sheet go back to that sheet.
 */
export function returnTarget(prev: ModalId, next: ModalId): ModalId {
  if (prev === 'menu' && (next === 'settings' || next === 'help')) return 'menu';
  if (prev === 'unitsheet' && (next === 'equip' || next === 'levelup')) return 'unitsheet';
  return null;
}

// ───────────────────────────── targeting tone ─────────────────────────────

/**
 * Area colour of a spell / skill preview: 'harm' for damage, 'warn' when the blast also hits own
 * units, 'help' otherwise.
 */
export function effectAreaTone(p: EffectPreview | null): 'help' | 'harm' | 'warn' {
  if (!p || p.tone !== 'harm') return 'help';
  return p.entries.some((e) => e.own && e.hpDelta < 0) ? 'warn' : 'harm';
}

/** Own units a harmful preview would hurt (friendly fire), leaders first. */
export function friendlyFire(p: EffectPreview | null): EffectPreview['entries'] {
  if (!p || p.tone !== 'harm') return [];
  return p.entries.filter((e) => e.own && e.hpDelta < 0);
}

/** Number keys 1–6: the selected unit's activated skills, in command bar order. */
export type SkillSlotCommand = 'skill1' | 'skill2' | 'skill3' | 'skill4' | 'skill5' | 'skill6';

export type KeyCommand =
  | 'endTurn' | 'nextUnit' | 'skipUnit' | 'build' | 'research' | 'spellbook' | 'forge' | 'grid' | 'help'
  | 'mute' | 'escape' | 'debug' | 'save'
  // selected unit (the command bar): attack, standing orders, upgrade, level-up, details sheet
  | 'attack' | 'orderHeal' | 'orderSentry' | 'upgrade' | 'levelUp' | 'details' | SkillSlotCommand;

/** How many skills get a number key (Digit1..Digit6). */
export const SKILL_HOTKEYS = 6;

/** Command bar slot (0-based) a number-key command fires, or null for other commands. */
export function skillSlotOf(c: KeyCommand): number | null {
  const m = /^skill([1-6])$/.exec(c);
  return m ? Number(m[1]) - 1 : null;
}

/**
 * The skills the command bar offers, in order (their number keys follow it): the unit's activated
 * skills (cooldown > 0). Permanent skills (cooldown 0: masonry, devotion…) are never pressed.
 */
export function barSkills<A extends string>(actives: readonly A[], cooldownOf: (a: A) => number | undefined): A[] {
  return actives.filter((a) => (cooldownOf(a) ?? 0) > 0);
}

export interface KeyLike { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean }

/**
 * Map a keydown to a game command (DESIGN §10). Camera keys are handled separately (held keys
 * pan), so auto-repeat never re-fires a command: holding R, G or N must not flicker a window or
 * toggle the grid / sound many times a second.
 */
export function keyToCommand(e: KeyLike): KeyCommand | null {
  if (e.altKey || e.repeat) return null;
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyS') return 'save';
    return null;
  }
  switch (e.code) {
    case 'Space': case 'Enter': case 'NumpadEnter': return 'endTurn';
    case 'Tab': return 'nextUnit';
    case 'KeyX': return 'skipUnit';
    case 'KeyB': return 'build';
    case 'KeyR': return 'research';
    case 'KeyM': return 'spellbook';
    case 'KeyF': return 'forge';
    case 'KeyG': return 'grid';
    case 'KeyH': return 'help';
    case 'KeyN': return 'mute';
    case 'Escape': return 'escape';
    case 'F1': return 'debug';
    case 'KeyT': return 'attack';
    case 'KeyY': return 'orderHeal';
    case 'KeyV': return 'orderSentry';
    case 'KeyU': return 'upgrade';
    case 'KeyL': return 'levelUp';
    case 'KeyC': case 'KeyI': return 'details';
    case 'Digit1': return 'skill1';
    case 'Digit2': return 'skill2';
    case 'Digit3': return 'skill3';
    case 'Digit4': return 'skill4';
    case 'Digit5': return 'skill5';
    case 'Digit6': return 'skill6';
    default: return null;
  }
}

/** Camera keys (held): the renderer polls `keyState` every frame. */
export const CAMERA_CODES: ReadonlySet<string> = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
  'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
]);

/**
 * Names a held camera key puts into renderer.keyState: the physical code only. Adding the
 * layout's letter too (e.key) counted Q twice (double rotation speed), and on AZERTY made the
 * physical Q key both rotate and pan.
 */
export function cameraKeyNames(e: Pick<KeyLike, 'code'>): string[] {
  return [e.code];
}

/** Edge-pan keys for a pointer at (x, y) in a viewport of w×h (margin in px). */
export function edgePanKeys(x: number, y: number, w: number, h: number, margin = 8): string[] {
  const out: string[] = [];
  if (x <= margin) out.push('ArrowLeft');
  else if (x >= w - 1 - margin) out.push('ArrowRight');
  if (y <= margin) out.push('ArrowUp');
  else if (y >= h - 1 - margin) out.push('ArrowDown');
  return out;
}

/** True when keyboard focus is in a text field (game shortcuts must be ignored). */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toUpperCase();
  if (t.isContentEditable) return true;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type ?? 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

/** Stable key for an action (used for the AI's failed-action memory). */
export function actionKey(a: unknown): string {
  return JSON.stringify(a);
}
