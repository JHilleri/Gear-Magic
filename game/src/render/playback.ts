// Event playback: turns sim GameEvents into layer animations, in order. The layers are synced
// against a *display model* (units/buildings as they look at this point of the sequence), not
// the final state, so a unit that moves later in the batch is not snapped ahead of its walk and
// a unit that dies later is still there to fight first.
import * as THREE from 'three';
import type { Building, GameEvent, GameState, Hex, Unit, UnitId } from '../core/types';
import { hexEq, inBounds, tileIndex } from '../core/hex';
import { SPELLS } from '../data/spells';
import { FOOT_SPEED, type BuildingLayerApi, type FxLayerApi, type RenderContext, type UnitLayerApi } from './types';

export interface PlaybackLayers {
  units: UnitLayerApi;
  buildings: BuildingLayerApi;
  fx: FxLayerApi;
}

export interface PlaybackHost {
  ctx: RenderContext;
  layers: PlaybackLayers;
  /** Refresh fog (fading) from the final state — used when the viewer's own units reveal land. */
  refreshFog(state: GameState): void;
  /** Called when the layer sync throws, so errors are reported once instead of every frame. */
  reportError(where: string, e: unknown): void;
  /**
   * True once this playback is stale: the renderer was handed another game (or disposed) while it
   * ran. Disposing the old layers resolves every pending tween, so without this check the rest of
   * the sequence would fall through at once and sync the old game into the new world.
   */
  cancelled?(): boolean;
}

export interface Snapshot { units: Record<string, Unit>; buildings: Record<string, Building> }

export function takeSnapshot(state: GameState): Snapshot {
  const units: Record<string, Unit> = {};
  for (const [k, u] of Object.entries(state.units)) units[k] = structuredClone(u);
  const buildings: Record<string, Building> = {};
  for (const [k, b] of Object.entries(state.buildings)) buildings[k] = structuredClone(b);
  return { units, buildings };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One step of a scheduled playback: some of the sequence's events, played in order once the
 * steps it waits for have finished. Steps without a dependency between them play at the same
 * time (independent enemy marches), against the one shared display model.
 */
export interface PlaybackStep {
  /** Indices into the event list, ascending. Empty: a pure wait point (e.g. a camera glide in onStepStart). */
  events: number[];
  /** Earlier steps (lower indices) that must have finished before this one starts. */
  after: number[];
  /**
   * [step, seconds at speed 1]: start only that long after that earlier step has started (a march
   * following another along the same road keeps its distance). Ignored for an instant leader.
   */
  lag?: [number, number][];
  /** Apply to the display model without animating (off screen, not worth watching). Read when the step starts. */
  instant?: boolean;
  /** Animation speed of this step (default: the sequence's). Read when the step starts. */
  speed?: number;
}

export interface PlaybackPlan {
  steps: PlaybackStep[];
  /** A step's dependencies are done; awaited before its events play (camera glide, sound timeline). */
  onStepStart?(k: number): void | Promise<void>;
  /** A step's events have played (or been applied). */
  onStepEnd?(k: number): void;
}

const normSp = (v: number | undefined, d = 1) => (v !== undefined && v > 0 && Number.isFinite(v) ? v : d);

export async function playEventSequence(
  host: PlaybackHost, state: GameState, snap: Snapshot, events: GameEvent[], speed: number, plan?: PlaybackPlan,
): Promise<void> {
  const { ctx, layers } = host;
  const baseSp = normSp(speed);
  const viewer = ctx.viewer;
  const W = state.width, H = state.height;
  const visArr = state.factions[viewer]?.visible ?? [];
  const expArr = state.factions[viewer]?.explored ?? [];
  const vis = (h: Hex) => inBounds(h, W, H) && visArr[tileIndex(h, W)] === 1;
  const exp = (h: Hex) => inBounds(h, W, H) && expArr[tileIndex(h, W)] === 1;

  // Working copy of the display model.
  const units: Record<string, Unit> = {};
  for (const [k, u] of Object.entries(snap.units)) units[k] = structuredClone(u);
  const buildings: Record<string, Building> = {};
  for (const [k, b] of Object.entries(snap.buildings)) buildings[k] = structuredClone(b);
  const display = (): GameState => ({ ...state, units, buildings });
  const stale = () => host.cancelled?.() === true;

  const syncUnits = (extraVisible?: (h: Hex) => boolean) => {
    if (stale()) return;
    const v = extraVisible ? (h: Hex) => vis(h) || extraVisible(h) : vis;
    try { layers.units.sync(display(), v, exp); } catch (e) { host.reportError('units.sync', e); }
  };
  const syncBuildings = () => {
    if (stale()) return;
    try { layers.buildings.sync(display(), vis, exp); } catch (e) { host.reportError('buildings.sync', e); }
  };
  const unitOf = (id: UnitId): Unit | undefined => units[String(id)] ?? state.units[String(id)];
  const anchor = (id: UnitId): THREE.Vector3 => {
    let a: THREE.Vector3 | null = null;
    try { a = layers.units.unitAnchor(id); } catch { a = null; }
    if (a) return a.clone();
    const u = unitOf(id);
    const p = u ? ctx.hexCenter(u.pos) : new THREE.Vector3();
    p.y += 0.4;
    return p;
  };
  const unitVisible = (id: UnitId) => { const u = unitOf(id); return !!u && vis(u.pos); };
  const above = (h: Hex, y: number) => { const p = ctx.hexCenter(h); p.y += y; return p; };
  const safe = async (where: string, p: () => Promise<void> | void) => {
    if (stale()) return;
    try { await p(); } catch (e) { host.reportError(where, e); }
  };
  /** The viewer always watches its own units, even where the batch left it blind (a lone scout dying). */
  const ownUnit = (u: Unit | undefined) => !!u && u.faction === viewer;
  const later = (ms: number, fn: () => void) => setTimeout(() => { if (!stale()) fn(); }, ms);

  /** Play events[idx[p]] (and, for a run of deaths, the ones after it); returns the last position used. */
  const playAt = async (idx: readonly number[], p: number, sp: number): Promise<number> => {
    const ev = events[idx[p]];
    switch (ev.type) {
      case 'unitMoved': {
        const u = units[String(ev.unit)];
        if (!u || ev.path.length === 0) break;
        const start = u.pos;
        const own = u.faction === viewer;
        const seen = own || vis(start) || ev.path.some(vis);
        if (seen) {
          if (own) host.refreshFog(state);
          if (!vis(start)) syncUnits((h) => hexEq(h, start));
          await safe('animateMove', () => layers.units.animateMove(ev.unit, ev.path, sp));
        }
        u.pos = { ...ev.path[ev.path.length - 1] };
        u.moved = true;
        break;
      }
      case 'combat': {
        const a = units[String(ev.attacker)], d = units[String(ev.defender)];
        // Visibility is the batch's final one: after a death it may no longer cover either hex.
        if (a && d && (vis(a.pos) || vis(d.pos) || ownUnit(a) || ownUnit(d))) {
          await safe('animateCombat', () => layers.units.animateCombat(ev.attacker, ev.defender, ev.kind, ev.strikes, sp));
          if (stale()) return p;
          const big = ev.strikes.some((s) => s.hit && s.damage >= 12);
          if (big) ctx.shake(0.25);
        }
        if (a) a.hp = ev.attackerHp;
        if (d) d.hp = ev.defenderHp;
        break;
      }
      case 'unitDied': {
        // Consecutive deaths (e.g. a fallen leader's army) play together.
        const batch: (typeof ev)[] = [ev];
        while (p + 1 < idx.length && events[idx[p + 1]].type === 'unitDied') batch.push(events[idx[++p]] as typeof ev);
        await Promise.all(batch.map(async (d) => {
          if ((vis(d.pos) || d.faction === viewer) && units[String(d.unit)]) await safe('animateDeath', () => layers.units.animateDeath(d.unit, sp));
        }));
        for (const d of batch) delete units[String(d.unit)];
        break;
      }
      case 'unitSpawned': {
        const fresh = state.units[String(ev.unit)];
        if (!fresh) break;
        units[String(ev.unit)] = { ...structuredClone(fresh), pos: { ...ev.pos } };
        syncUnits();
        if (vis(ev.pos)) {
          if (ev.reason === 'summon') layers.fx.burst(above(ev.pos, 0.2), '#c9b48a', 40);
          await safe('animateSpawn', () => layers.units.animateSpawn(ev.unit, sp));
        }
        break;
      }
      case 'unitEquipped': {
        const u = units[String(ev.unit)];
        const fresh = state.units[String(ev.unit)];
        if (u) {
          if (fresh) u.equipment = structuredClone(fresh.equipment);
          else u.equipment[ev.slot] = ev.item;
          try { layers.units.refreshUnit(display(), ev.unit); } catch (e) { host.reportError('refreshUnit', e); }
          if (vis(u.pos)) layers.fx.burst(anchor(ev.unit), '#e8d9a8', 14);
        }
        break;
      }
      case 'unitLeveled': {
        const u = units[String(ev.unit)];
        if (u) u.level = ev.level;
        if (unitVisible(ev.unit)) {
          layers.fx.levelUp(anchor(ev.unit));
          await wait(250 / sp);
        }
        break;
      }
      case 'unitDamaged': {
        const u = units[String(ev.unit)];
        if (u) u.hp = Math.max(0, u.hp - ev.amount);
        if (unitVisible(ev.unit)) {
          const color = ev.source === 'poison' ? '#8fe05a' : ev.source === 'starvation' ? '#d9a35a' : '#ff6b4a';
          layers.fx.damageNumber(anchor(ev.unit), `-${ev.amount}`, color);
          if (ev.source === 'spell' || ev.source === 'skill') void safe('playClip', () => layers.units.playClip(ev.unit, 'hit', sp));
          syncUnits();
        }
        break;
      }
      case 'unitHealed': {
        const u = units[String(ev.unit)];
        const fresh = state.units[String(ev.unit)];
        if (u) u.hp = Math.min(fresh ? fresh.hp : u.hp + ev.amount, u.hp + ev.amount);
        if (unitVisible(ev.unit) && ev.amount > 0) {
          layers.fx.damageNumber(anchor(ev.unit), `+${ev.amount}`, '#7dff9a');
          layers.fx.burst(anchor(ev.unit), '#8dffb0', 12);
          syncUnits();
        }
        break;
      }
      case 'spellCast': {
        if (!vis(ev.target) && !vis(ev.from)) break;
        const def = SPELLS[ev.spell];
        const caster = Object.values(units).find((u) => hexEq(u.pos, ev.from) && u.faction === ev.faction);
        const from = above(ev.from, 1.15);
        const center = ctx.hexCenter(ev.target);
        // ally-only spells: the heavy effect plays on the units actually affected (that the viewer sees)
        const targets = ev.spell === 'heal' || ev.spell === 'bless'
          ? (ev.affected ?? []).filter(unitVisible).map((id) => { const a = anchor(id); a.y = ctx.heightAt(a.x, a.z); return a; })
          : undefined;
        const anims: Promise<void>[] = [safe('fx.spell', () => layers.fx.spell(ev.spell, from, center, def?.radius ?? 0, sp, targets))];
        if (caster) anims.push(safe('playClip', () => layers.units.playClip(caster.id, 'cast', sp)));
        if (ev.spell === 'fireball') later(450 / sp, () => ctx.shake(0.45));
        if (ev.spell === 'storm') later(300 / sp, () => ctx.shake(0.6));
        if (ev.spell === 'summon') later(500 / sp, () => ctx.shake(0.3));
        await Promise.all(anims);
        break;
      }
      case 'skillUsed': {
        const u = units[String(ev.unit)] ?? state.units[String(ev.unit)];
        if (!u || ev.skill === 'masonry' || ev.skill === 'devotion') break;
        const seen = vis(u.pos) || (ev.target ? vis(ev.target) : false);
        if (!seen) {
          if (ev.skill === 'blink' && ev.target && units[String(ev.unit)]) units[String(ev.unit)].pos = { ...ev.target };
          break;
        }
        const from = anchor(ev.unit);
        const tgt = ev.target ? above(ev.target, 0.4) : from.clone();
        const fx = layers.fx;
        switch (ev.skill) {
          case 'powerstrike':
            fx.burst(from, '#ffb347', 26);
            await safe('playClip', () => layers.units.playClip(ev.unit, 'cast', sp));
            break;
          case 'volley': {
            await Promise.all([
              safe('playClip', () => layers.units.playClip(ev.unit, 'attack_ranged', sp)),
              (async () => {
                await wait(260 / sp);
                await Promise.all((ev.targets ?? []).map(async (t, k) => {
                  await wait((k * 70) / sp);
                  if (stale()) return;
                  const to = anchor(t);
                  await safe('projectile', () => fx.projectile(from, to, 'ranged', sp));
                  if (!stale()) fx.hitSpark(to, 'ranged');
                }));
              })(),
            ]);
            break;
          }
          case 'heal':
            await Promise.all([safe('playClip', () => layers.units.playClip(ev.unit, 'cast', sp)), (async () => { await wait(250 / sp); if (!stale()) fx.burst(tgt, '#7dff9a', 34); })()]);
            break;
          case 'firebolt':
            await safe('playClip', () => layers.units.playClip(ev.unit, 'cast', sp));
            await safe('projectile', () => fx.projectile(from, tgt, 'magic', sp));
            if (stale()) return p;
            fx.hitSpark(tgt, 'magic');
            fx.burst(tgt, '#ff8a3c', 30);
            ctx.shake(0.25);
            break;
          case 'rally':
            fx.burst(from, '#ffd76a', 44);
            await safe('playClip', () => layers.units.playClip(ev.unit, 'cast', sp));
            break;
          case 'fortify':
            fx.burst(from, '#9ec9ff', 30);
            await safe('playClip', () => layers.units.playClip(ev.unit, 'cast', sp));
            break;
          case 'blink': {
            fx.burst(from, '#c08bff', 36);
            await safe('playClip', () => layers.units.playClip(ev.unit, 'cast', sp));
            if (stale()) return p;
            const du = units[String(ev.unit)];
            if (du && ev.target) {
              du.pos = { ...ev.target };
              syncUnits();
              fx.burst(anchor(ev.unit), '#c08bff', 36);
            }
            break;
          }
          default: break;
        }
        break;
      }
      case 'buildingStarted': {
        const b = state.buildings[String(ev.building)];
        if (b) buildings[String(ev.building)] = structuredClone(b);
        syncBuildings();
        if (b && vis(b.pos)) {
          layers.fx.burst(above(b.pos, 0.15), '#cdb68f', 30);
          await wait(220 / sp);
        }
        break;
      }
      case 'buildingProgress': {
        const b = buildings[String(ev.building)];
        if (b) b.buildLeft = ev.left;
        break;
      }
      case 'buildingCompleted': {
        const b = state.buildings[String(ev.building)];
        if (b) buildings[String(ev.building)] = structuredClone(b);
        syncBuildings();
        if (b && vis(b.pos)) await safe('animateConstructed', () => layers.buildings.animateConstructed(ev.building, sp));
        break;
      }
      case 'buildingCaptured': {
        const b = buildings[String(ev.building)] ?? (state.buildings[String(ev.building)] && structuredClone(state.buildings[String(ev.building)]));
        if (b) { b.owner = ev.to; buildings[String(ev.building)] = b; }
        syncBuildings();
        if (b && vis(b.pos)) {
          layers.fx.burst(above(b.pos, 0.6), cssColor(ctx.factionColor(ev.to)), 40);
          await wait(300 / sp);
        }
        break;
      }
      case 'buildingDestroyed': {
        if (vis(ev.pos) && buildings[String(ev.building)]) {
          ctx.shake(0.3);
          await safe('animateDestroyed', () => layers.buildings.animateDestroyed(ev.building, sp));
        }
        delete buildings[String(ev.building)];
        syncBuildings();
        break;
      }
      case 'ruinsExplored': {
        if (vis(ev.pos)) {
          const p = above(ev.pos, 0.5);
          layers.fx.burst(p, '#ffd76a', 46);
          layers.fx.damageNumber(above(ev.pos, 0.9), ev.reward, '#ffe08a');
          await wait(450 / sp);
        }
        break;
      }
      default:
        break; // turnStarted, research, crafting, log, elimination, gameOver: UI concerns
    }
    return p;
  };

  /** The display-model effect of an event, without animation (an instant step). */
  const applyAt = (ev: GameEvent) => {
    switch (ev.type) {
      case 'unitMoved': {
        const u = units[String(ev.unit)];
        if (u && ev.path.length) { u.pos = { ...ev.path[ev.path.length - 1] }; u.moved = true; }
        break;
      }
      case 'combat': {
        const a = units[String(ev.attacker)], d = units[String(ev.defender)];
        if (a) a.hp = ev.attackerHp;
        if (d) d.hp = ev.defenderHp;
        break;
      }
      case 'unitDied': delete units[String(ev.unit)]; break;
      case 'unitSpawned': {
        const fresh = state.units[String(ev.unit)];
        if (fresh) units[String(ev.unit)] = { ...structuredClone(fresh), pos: { ...ev.pos } };
        break;
      }
      case 'unitEquipped': {
        const u = units[String(ev.unit)], fresh = state.units[String(ev.unit)];
        if (u) { if (fresh) u.equipment = structuredClone(fresh.equipment); else u.equipment[ev.slot] = ev.item; }
        break;
      }
      case 'unitLeveled': { const u = units[String(ev.unit)]; if (u) u.level = ev.level; break; }
      case 'unitDamaged': { const u = units[String(ev.unit)]; if (u) u.hp = Math.max(0, u.hp - ev.amount); break; }
      case 'unitHealed': {
        const u = units[String(ev.unit)], fresh = state.units[String(ev.unit)];
        if (u) u.hp = Math.min(fresh ? fresh.hp : u.hp + ev.amount, u.hp + ev.amount);
        break;
      }
      case 'skillUsed': {
        const u = units[String(ev.unit)];
        if (u && ev.skill === 'blink' && ev.target) u.pos = { ...ev.target };
        break;
      }
      case 'buildingStarted': case 'buildingCompleted': {
        const b = state.buildings[String(ev.building)];
        if (b) buildings[String(ev.building)] = structuredClone(b);
        break;
      }
      case 'buildingProgress': { const b = buildings[String(ev.building)]; if (b) b.buildLeft = ev.left; break; }
      case 'buildingCaptured': {
        const b = buildings[String(ev.building)] ?? (state.buildings[String(ev.building)] && structuredClone(state.buildings[String(ev.building)]));
        if (b) { b.owner = ev.to; buildings[String(ev.building)] = b; }
        break;
      }
      case 'buildingDestroyed': delete buildings[String(ev.building)]; break;
      default: break;
    }
  };

  const playStep = async (idx: readonly number[], sp: number) => {
    for (let p = 0; p < idx.length; p++) {
      if (stale()) return;
      p = await playAt(idx, p, sp);
    }
  };
  const applyStep = (idx: readonly number[]) => {
    if (idx.length === 0 || stale()) return;
    for (const i of idx) applyAt(events[i]);
    syncBuildings();
    syncUnits();
  };

  if (!plan) {
    await playStep(events.map((_, i) => i), baseSp);
    return;
  }
  // Steps wait only for their own dependencies (always earlier steps), so independent ones overlap.
  const done: Promise<void>[] = [];
  /** Resolves with a step's speed as its events start (0: instant or never played). */
  const started: Promise<number>[] = [];
  plan.steps.forEach((step, k) => {
    let markStarted: (sp: number) => void = () => undefined;
    started[k] = new Promise<number>((r) => { markStarted = r; });
    const deps: Promise<unknown>[] = step.after.filter((j) => j >= 0 && j < k).map((j) => done[j]);
    for (const [j, delay] of step.lag ?? []) {
      if (j < 0 || j >= k) continue;
      deps.push(started[j].then((sp) => (sp > 0 && delay > 0 && !stale() ? wait((delay / sp) * 1000) : undefined)));
    }
    done[k] = Promise.all(deps).then(async () => {
      try {
        if (stale()) return;
        try { await plan.onStepStart?.(k); } catch (e) { host.reportError('onStepStart', e); }
        if (stale()) return;
        const sp = normSp(step.speed, baseSp);
        markStarted(step.instant ? 0 : sp);
        if (step.instant) applyStep(step.events);
        else await playStep(step.events, sp);
        if (stale()) return;
        try { plan.onStepEnd?.(k); } catch (e) { host.reportError('onStepEnd', e); }
      } finally {
        markStarted(0);
      }
    });
  });
  await Promise.all(done);
}

// ───────────────────────────── scheduling: beats and their dependencies ─────────────────────────────

/**
 * A beat: what one actor does in one go (a march; a strike and the deaths it causes; a cast and its
 * damage). A beat waits for the earlier beats it shares something with, so independent marches and
 * fights play at once while each unit, hex and building still sees its events in order:
 * `keys` (units, buildings, hexes where something happens) are held for the whole beat; `spans` are
 * the hexes a march leaves or passes through, with when (seconds at speed 1 from the beat's start)
 * it is on them, so a unit marching behind another along the same road need not wait for it.
 * A barrier (a turn or phase marker, an elimination, the end of the war) waits for everything
 * before it, and everything after waits for it.
 */
export interface Beat { events: number[]; keys: string[]; spans?: Record<string, [number, number]>; barrier: boolean }

const BARRIER_EVENTS: ReadonlySet<GameEvent['type']> = new Set<GameEvent['type']>(['turnStarted', 'neutralPhase', 'factionEliminated', 'gameOver']);
/** World distance between neighbouring hex centres. */
const HEX_STEP = Math.sqrt(3);

export interface BeatLookup {
  /** Where a unit stands before the sequence (undefined: unknown, e.g. spawned in it). */
  unitPos(id: UnitId): Hex | undefined;
  /** Where a building stands (undefined: unknown). */
  buildingPos(id: Building['id']): Hex | undefined;
  /** How fast a unit marches (world units per second at speed 1); default: on foot. */
  unitSpeed?(id: UnitId): number;
}

const hexKey = (h: Hex) => `h:${h.q},${h.r}`;

export function splitBeats(events: readonly GameEvent[], look: BeatLookup): Beat[] {
  const beats: Beat[] = [];
  const pos = new Map<UnitId, Hex>();
  const where = (id: UnitId): Hex | undefined => pos.get(id) ?? look.unitPos(id);
  let cur: { beat: Beat; lead: GameEvent; keys: Set<string> } | null = null;
  const open = (i: number, ev: GameEvent) => {
    const beat: Beat = { events: [i], keys: [], barrier: BARRIER_EVENTS.has(ev.type) };
    beats.push(beat);
    cur = { beat, lead: ev, keys: new Set() };
  };
  const attach = (i: number) => { cur!.beat.events.push(i); };
  const key = (k: string) => { if (cur && !cur.keys.has(k)) { cur.keys.add(k); cur.beat.keys.push(k); } };
  const unit = (id: UnitId | null | undefined) => { if (id !== null && id !== undefined) key(`u:${id}`); };
  const hex = (h: Hex | null | undefined) => { if (h) key(hexKey(h)); };
  const bld = (id: Building['id']) => { key(`b:${id}`); hex(look.buildingPos(id)); };
  const touches = (k: string) => !!cur && cur.keys.has(k);
  const leadIs = (...types: GameEvent['type'][]) => !!cur && types.includes(cur.lead.type);
  const leadMove = (id: UnitId) => { const c = cur as { lead: GameEvent } | null; return !!c && c.lead.type === 'unitMoved' && c.lead.unit === id; };

  events.forEach((ev, i) => {
    const last = i > 0 ? events[i - 1] : null;
    switch (ev.type) {
      case 'unitMoved': {
        open(i, ev);
        unit(ev.unit);
        const v = look.unitSpeed?.(ev.unit);
        const step = HEX_STEP / (v !== undefined && v > 0 ? v : FOOT_SPEED);
        const spans: Record<string, [number, number]> = {};
        const use = (h: Hex, t0: number, t1: number) => {
          const k = hexKey(h), o = spans[k];
          spans[k] = o ? [Math.min(o[0], t0), Math.max(o[1], t1)] : [t0, t1];
        };
        const from = where(ev.unit);
        if (from) use(from, -Infinity, 0.5 * step);
        const n = ev.path.length;
        ev.path.forEach((h, k) => use(h, (k + 0.5) * step, k === n - 1 ? Infinity : (k + 1.5) * step));
        cur!.beat.spans = spans;
        if (n) pos.set(ev.unit, ev.path[n - 1]);
        break;
      }
      case 'combat':
        // its own beat (not the march's): a unit may march while another strikes its target
        open(i, ev);
        unit(ev.attacker); unit(ev.defender);
        hex(where(ev.attacker)); hex(where(ev.defender));
        break;
      case 'unitDied': {
        const cause = leadIs('combat', 'spellCast', 'skillUsed') || last?.type === 'unitDied' || touches(`u:${ev.unit}`);
        if (cur && cause) attach(i); else open(i, ev);
        unit(ev.unit); hex(ev.pos);
        break;
      }
      case 'unitDamaged': case 'unitHealed': {
        if (cur && (leadIs('combat', 'spellCast', 'skillUsed') || touches(`u:${ev.unit}`))) attach(i); else open(i, ev);
        unit(ev.unit);
        break;
      }
      case 'unitLeveled': case 'unitEquipped': {
        if (cur && (touches(`u:${ev.unit}`) || leadMove(ev.unit))) attach(i); else open(i, ev);
        unit(ev.unit);
        break;
      }
      case 'unitSpawned': {
        if (cur && leadIs('spellCast', 'skillUsed')) attach(i); else open(i, ev);
        unit(ev.unit); hex(ev.pos);
        pos.set(ev.unit, ev.pos);
        break;
      }
      case 'skillUsed': {
        open(i, ev);
        unit(ev.unit); hex(where(ev.unit)); hex(ev.target);
        for (const t of ev.targets ?? []) { unit(t); hex(where(t)); }
        if (ev.skill === 'blink' && ev.target) pos.set(ev.unit, ev.target);
        break;
      }
      case 'spellCast': {
        open(i, ev);
        hex(ev.from); hex(ev.target);
        for (const t of ev.affected) { unit(t); hex(where(t)); }
        break;
      }
      case 'buildingCaptured': case 'ruinsExplored': {
        const c = cur as { lead: GameEvent } | null;
        if (c && c.lead.type === 'unitMoved') attach(i); else open(i, ev);
        if (ev.type === 'buildingCaptured') bld(ev.building); else { unit(ev.unit); hex(ev.pos); }
        break;
      }
      case 'buildingDestroyed': {
        if (cur && leadIs('combat', 'spellCast', 'skillUsed')) attach(i); else open(i, ev);
        key(`b:${ev.building}`); hex(ev.pos);
        break;
      }
      case 'buildingStarted': case 'buildingProgress': case 'buildingCompleted':
        open(i, ev); bld(ev.building);
        break;
      case 'log':
        if (cur) attach(i); else open(i, ev);
        break;
      default:
        open(i, ev); // markers (barriers), research, crafting: no keys
        break;
    }
  });
  return beats;
}

/** What a beat waits for: earlier beats to finish (`after`), or to have started a while ago (`lag`). */
export interface BeatDeps { after: number[]; lag: [number, number][] }

/**
 * For each beat, the earlier beats it must wait for (ascending, no duplicates). Two marches over the
 * same hex wait for each other unless the later one only reaches it after the earlier one has left
 * (+ `margin` seconds at speed 1): a follower already behind inherits its leader's dependencies (so
 * it never starts before it); one that would catch up starts `lag` seconds after the leader starts.
 * Only a march ending on (or starting from) the hex makes the other wait for it to finish. A march
 * merely passing a hex does not wait for, nor hold up, a fight or a death on it.
 */
export function beatDependencies(beats: readonly Beat[], margin = 0.3): BeatDeps[] {
  const passing = (sp: [number, number] | undefined) => !!sp && Number.isFinite(sp[0]) && Number.isFinite(sp[1]);
  let users = new Map<string, number[]>();
  let barrier = -1;
  let since: number[] = [];
  const out: BeatDeps[] = [];
  beats.forEach((b, k) => {
    const deps = new Set<number>();
    const lag = new Map<number, number>();
    if (barrier >= 0) deps.add(barrier);
    if (b.barrier) {
      for (const j of since) deps.add(j);
      lag.clear();
      barrier = k;
      since = [];
      users = new Map();
    } else {
      const inherited = new Set<number>();
      const check = (key: string, span?: [number, number]) => {
        for (const j of users.get(key) ?? []) {
          if (deps.has(j)) continue;
          const lead = beats[j].spans?.[key];
          if (span && lead) {
            // how long after the leader starts this march may start and still find the hex free
            const need = lead[1] + margin - span[0];
            if (need <= 0) { for (const x of out[j].after) inherited.add(x); continue; }
            if (Number.isFinite(need)) { lag.set(j, Math.max(lag.get(j) ?? 0, need)); continue; }
          } else if (passing(span) || passing(lead)) {
            continue; // a march only passing a hex where something else happens: no need to wait
          }
          deps.add(j);
        }
      };
      for (const key of b.keys) check(key);
      for (const [key, span] of Object.entries(b.spans ?? {})) check(key, span);
      for (const x of inherited) deps.add(x);
      since.push(k);
    }
    for (const key of [...b.keys, ...Object.keys(b.spans ?? {})]) {
      const list = users.get(key);
      if (list) list.push(k); else users.set(key, [k]);
    }
    out.push({
      after: [...deps].sort((x, y) => x - y),
      lag: [...lag].filter(([j]) => !deps.has(j)).sort((x, y) => x[0] - y[0]),
    });
  });
  return out;
}

function cssColor(c: THREE.Color): string { return `#${c.getHexString()}`; }
