// Floating HUD pieces: end turn, event log, toasts, turn banner, AI indicator, mode hint,
// combat forecast and the hover hex chip.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AttackMod, CombatForecast, EffectEntry, GameState, Hex, LogEntry, Unit } from '../../core/types';
import type { GameStore, Toast } from '../../game/store';
import { hexKey, spiral, tileIndex } from '../../core/hex';
import { BUILDINGS } from '../../data/buildings';
import { FACTIONS, MONSTERS } from '../../data/factions';
import { ACTIVES } from '../../data/skills';
import { SPELLS } from '../../data/spells';
import { TERRAIN } from '../../data/terrain';
import { tileDefense } from '../../sim/combat';
import { mainAttackKind } from '../../sim/units';
import { skillRange } from '../../sim/skills';
import { unitsAtWork, unitsAwaitingOrders } from '../../game/duty';
import { Kbd } from '../common';
import { useUi } from '../ctx';
import { Emblem, Icon, KindIcon, Sym } from '../icons';
import { tip } from '../tooltip';
import {
  buildingAtHex, cls, displayTurn, fmt, hexExplored, hexVisible, isComplete, isMyTurn, pct, safe, selectedUnitId, tileAt, unitAtHex, unitById,
  unitsOwned, viewerOf, warOver,
} from '../util';
import { DEPOSIT_INFO } from './TilePanel';

// ───────────────────────────── pointer tracking ─────────────────────────────
const pointer = { x: -1000, y: -1000 };
let pointerListeners = 0;
const onPointer = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; };
/** Live pointer position (re-renders the caller on move while mounted). */
function usePointer(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const fn = (e: PointerEvent) => {
      onPointer(e);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setTick((t) => t + 1); });
    };
    window.addEventListener('pointermove', fn, { passive: true });
    return () => { window.removeEventListener('pointermove', fn); cancelAnimationFrame(raf); };
  }, [active]);
  return pointer;
}
export function installPointerTracking(): () => void {
  if (pointerListeners++ === 0) window.addEventListener('pointermove', onPointer, { passive: true, capture: true });
  return () => { if (--pointerListeners === 0) window.removeEventListener('pointermove', onPointer, { capture: true }); };
}

/** Place a floating box near the cursor, flipped to stay on screen. */
function useCursorBox(active: boolean, offset = 18) {
  const p = usePointer(active);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = p.x + offset, y = p.y + offset;
    if (x + w > window.innerWidth - 8) x = p.x - offset - w;
    if (y + h > window.innerHeight - 8) y = p.y - offset - h;
    el.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(Math.max(8, y))}px)`;
    el.style.opacity = '1';
  });
  return ref;
}

/** HUD chrome a map panel must not cover (the tile panel text, End Turn, the chronicle…). */
const HUD_SELECTORS = ['.topbar', '.hud-left > *', '.hud-right > *', '.hud-br', '.event-log', '.mode-hint', '.ai-indicator', '.command-bar'];

interface Box { x0: number; y0: number; x1: number; y1: number; w: number }
const overlap = (a: Box, b: Omit<Box, 'w'>): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * Place a floating panel beside a hex (the attack target, the spell's centre) rather than at the
 * cursor: never over that hex, and as little as possible over the hexes the player must still
 * see (attacker, approach path, blast area) and the HUD panels. Candidates around the hex are
 * scored every frame (the camera may move); the current side is kept unless another is clearly
 * better. Without a projection (dev store, hex off screen) it falls back to the cursor.
 */
function useAnchoredBox(active: boolean, anchor: Hex | null, avoid: Hex[]) {
  const { store } = useUi();
  const ref = useRef<HTMLDivElement>(null);
  const side = useRef(-1);
  const avoidRef = useRef(avoid);
  avoidRef.current = avoid;
  const anchorKey = anchor ? hexKey(anchor) : '';
  useEffect(() => {
    if (!active) { side.current = -1; return; }
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight, m = 8;
      const proj = anchor ? store.hexToScreen?.(anchor) ?? null : null;
      let ax = pointer.x, ay = pointer.y, rad = 22;
      const marks: Box[] = [];
      if (proj && proj.visible) {
        ax = proj.x; ay = proj.y;
        const n = store.hexToScreen?.({ q: anchor!.q + 1, r: anchor!.r });
        if (n) rad = Math.max(12, Math.min(90, Math.hypot(n.x - ax, n.y - ay) * 0.55));
        marks.push({ x0: ax - rad, y0: ay - rad, x1: ax + rad, y1: ay + rad, w: 60 });
        for (const a of avoidRef.current) {
          const p = store.hexToScreen?.(a);
          if (p && p.visible) marks.push({ x0: p.x - rad, y0: p.y - rad, x1: p.x + rad, y1: p.y + rad, w: 12 });
        }
      } else {
        marks.push({ x0: ax - 14, y0: ay - 14, x1: ax + 14, y1: ay + 14, w: 60 });
      }
      for (const sel of HUD_SELECTORS) {
        document.querySelectorAll(sel).forEach((e) => {
          if (e === el || el.contains(e)) return;
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) marks.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, w: 4 });
        });
      }
      const off = rad + 14;
      // right, left, below, above, then the diagonals
      const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
      let best = -1, bestScore = Infinity;
      const scores = dirs.map(([dx, dy], i) => {
        let x = dx > 0 ? ax + off : dx < 0 ? ax - off - w : ax - w / 2;
        let y = dy > 0 ? ay + off : dy < 0 ? ay - off - h : ay - h / 2;
        x = Math.max(m, Math.min(vw - w - m, x));
        y = Math.max(m, Math.min(vh - h - m, y));
        const box = { x0: x, y0: y, x1: x + w, y1: y + h };
        let sc = i * 0.5; // mild preference order
        for (const k of marks) sc += overlap({ ...box, w: 0 }, k) * k.w;
        if (sc < bestScore) { bestScore = sc; best = i; }
        return { x, y, sc };
      });
      const keep = side.current >= 0 && scores[side.current].sc <= bestScore * 1.2 + 40;
      const pick = keep ? side.current : best;
      side.current = pick;
      el.style.transform = `translate(${Math.round(scores[pick].x)}px, ${Math.round(scores[pick].y)}px)`;
      el.style.opacity = '1';
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [active, anchorKey]);
  return ref;
}

// ───────────────────────────── end turn ─────────────────────────────
export function EndTurnBox() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const viewer = viewerOf(s);
  if (warOver(s, ui)) {
    // Nothing will ever happen again: the button reopens the results (as Space does).
    const won = s.winner === viewer;
    return (
      <div class="endturn-box">
        <button type="button" class={cls('endturn', 'ready', 'game-over', won ? 'victory' : 'defeat')} onClick={() => store.openModal('end')}
          {...tip(<span>The war is over. Open the results <Kbd k="Space" /></span>, 'top')}>
          <span class="endturn-label">{won ? 'Victory' : 'Defeat'}</span>
          <span class="endturn-sub">View results</span>
        </button>
      </div>
    );
  }
  const my = isMyTurn(s, ui);
  const skipped = new Set(ui.skippedUnits);
  // Working builders, units drilling, the seated leader and skipped units do not need orders. A unit
  // under a standing order does once its Attack button has a target (same test as the bar's).
  const strikes = store.attackableTargets ? (u: Unit) => store.attackableTargets!(u.id).length > 0 : undefined;
  const idle = my ? safe(() => unitsAwaitingOrders(s, skipped, strikes).length, 0) : 0;
  const working = my ? safe(() => unitsAtWork(s, skipped, strikes), 0) : 0;
  const tv = displayTurn(s, ui);
  const enemyPlaying = !my && !!ui.aiThinking;
  const label = my ? 'End Turn' : tv.faction === 'neutral' ? 'The Wilds' : tv.faction !== viewer || ui.aiThinking ? 'Enemy Turn' : 'Please wait';
  const myTip = `${idle > 0 ? `${idle} unit${idle === 1 ? '' : 's'} await${idle === 1 ? 's' : ''} orders.` : 'All units have their orders.'}${working > 0 ? ` ${working} working or waiting.` : ''}`;
  // Level-up choices put off ("Decide later") wait here; they never hold the turn.
  const leveling = my ? unitsOwned(s, viewer).filter((u) => u.pendingLevelUps > 0) : [];
  const choices = leveling.reduce((a, u) => a + u.pendingLevelUps, 0);
  const sel = unitById(s, selectedUnitId(s, ui));
  const nextLevel = sel && sel.faction === viewer && sel.pendingLevelUps > 0 ? sel : leveling[0];
  return (
    <div class="endturn-box">
      <div class="et-pills">
        {choices > 0 && nextLevel && (
          <button type="button" class="next-unit levelup-pill" onClick={() => store.openModal('levelup', { unit: nextLevel.id })}
            {...tip(<span>Level-up choice{choices === 1 ? '' : 's'} waiting: {leveling.map((u) => u.name).join(', ')}. Click to choose a reward — it can wait, the turn can still end.</span>, 'top')}>
            <Sym name="star" /><span>Level up</span>{choices > 1 && <span class="count">{choices}</span>}
          </button>
        )}
        <button type="button" class={cls('next-unit', (!my || idle === 0) && 'is-disabled')} aria-disabled={!my || idle === 0} onClick={my && idle > 0 ? () => store.nextIdleUnit() : undefined}
          {...tip(<span>Select the next unit awaiting orders <Kbd k="Tab" /> · skip a unit this turn <Kbd k="X" /></span>, 'top')}>
          <Sym name="recruit" /><span>Next unit</span>{idle > 0 && <span class="count">{idle}</span>}
        </button>
      </div>
      <button type="button" class={cls('endturn', !my && !enemyPlaying && 'is-disabled', !my && enemyPlaying && 'enemy', my && idle === 0 && 'ready')}
        aria-disabled={!my && !enemyPlaying}
        onClick={my || enemyPlaying ? () => store.requestEndTurn() : undefined}
        {...tip(my ? <span>{myTip} <Kbd k="Space" /></span>
          : enemyPlaying ? <span>Fast-forward the enemy turn <Kbd k="Space" /></span> : 'Waiting for other factions.', 'top')}>
        <span class="endturn-label">{label}</span>
        <span class="endturn-sub">{my ? (idle > 0 ? `${idle} idle` : 'Ready') : enemyPlaying ? '▸▸ Skip' : <span class="dots"><i /><i /><i /></span>}</span>
      </button>
    </div>
  );
}

// ───────────────────────────── event log ─────────────────────────────
const LOG_ICON: Record<LogEntry['kind'], string> = {
  info: 'help', combat: 'melee', build: 'hammer', research: 'research', magic: 'magic', warning: 'poison', levelup: 'star',
};

export function EventLog() {
  const { store } = useUi();
  const s = store.state!;
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // Lines whose event is still being animated are held back (the combat result shows when the blows land).
  const shown = store.logShown;
  const log = shown ? s.log.filter((e) => shown.call(store, e)) : s.log;
  const entries = log.slice(open ? -80 : -8);
  const count = log.length;
  const last = log[count - 1];
  // The log is capped, so its length stops changing: key the auto-scroll on the last entry too.
  const tail = `${count}:${last?.round}:${last?.text}`;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail, open]);
  if (count === 0) return null;
  return (
    <div class={cls('event-log panel', open && 'open')}>
      <div class="log-head">
        <span>Chronicle</span>
        <button type="button" class="log-toggle" onClick={() => setOpen(!open)} aria-expanded={open} {...tip(open ? 'Collapse' : 'Show more history')}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      <div class="log-list" ref={listRef}>
        {entries.map((e, i) => {
          const fc = e.faction ? FACTIONS[e.faction] : null;
          const age = entries.length - 1 - i;
          return (
            <div key={`${count - entries.length + i}`} class={cls('log-entry', `log-${e.kind}`)} style={{ '--fc': fc?.color ?? 'transparent', opacity: open ? 1 : Math.max(0.45, 1 - age * 0.08) } as Record<string, string | number>}>
              <span class="log-round">{e.round}</span>
              <Sym name={LOG_ICON[e.kind] ?? 'help'} class="log-icon" />
              <span class="log-text">{e.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────── toasts ─────────────────────────────
function toastAlive(t: Toast, nowDate: number, nowPerf: number): boolean {
  // `until` may be wall-clock (Date.now) or monotonic (performance.now).
  return t.until > 1e12 ? t.until > nowDate : t.until > nowPerf;
}

export function Toasts() {
  const { store } = useUi();
  const [, setTick] = useState(0);
  const toasts = store.ui.toasts;
  const nd = Date.now(), np = performance.now();
  const alive = toasts.filter((t) => toastAlive(t, nd, np));
  useEffect(() => {
    if (alive.length === 0) return;
    const next = Math.min(...alive.map((t) => (t.until > 1e12 ? t.until - nd : t.until - np)));
    const id = window.setTimeout(() => setTick((x) => x + 1), Math.max(50, next + 20));
    return () => window.clearTimeout(id);
  });
  return (
    <div class="toasts" aria-live="polite">
      {alive.slice(-5).map((t) => (
        <div key={t.id} class={cls('toast', `toast-${t.kind}`)}>
          <Sym name={t.kind === 'bad' ? 'poison' : t.kind === 'good' ? 'check' : t.kind === 'warning' ? 'help' : 'star'} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────── turn banner ─────────────────────────────
export function TurnBanner() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const viewer = viewerOf(s);
  const tv = displayTurn(s, ui);
  const my = isMyTurn(s, ui);
  // Once per turn, when control actually returns (not while earlier phases still play).
  const key = `${s.settings.seed}:${tv.round}:${tv.faction}`;
  const shownFor = useRef<string | null>(null);
  const [show, setShow] = useState<{ round: number; id: number } | null>(null);
  useEffect(() => {
    if (!my || tv.faction !== viewer || s.gameOver || shownFor.current === key) return;
    shownFor.current = key;
    const id = Date.now();
    setShow({ round: tv.round, id });
    const t = window.setTimeout(() => setShow((v) => (v && v.id === id ? null : v)), 2600);
    return () => window.clearTimeout(t);
  }, [key, my]);
  if (!show) return null;
  const fd = FACTIONS[viewer];
  return (
    <div class="turn-banner" key={show.id} style={{ '--fc': fd.color, '--fa': fd.accent } as Record<string, string>}>
      <div class="tb-ornament" />
      <div class="tb-round">Round {show.round}</div>
      <div class="tb-title">Your Turn</div>
      <div class="tb-sub"><Emblem faction={viewer} size={20} />{fd.name}</div>
      <div class="tb-ornament" />
    </div>
  );
}

// ───────────────────────────── notice banner ─────────────────────────────
/** A moment that changes the war (a house destroyed), named over the map for a few seconds. */
export function NoticeBanner() {
  const { store } = useUi();
  const n = store.ui.notice;
  if (!n || store.ui.modal === 'end') return null;
  const fd = FACTIONS[n.faction];
  return (
    <div class="notice-banner" key={n.id} role="status" style={{ '--fc': fd?.color ?? '#888', '--fa': fd?.accent ?? '#aaa' } as Record<string, string>}>
      <Emblem faction={n.faction} size={38} />
      <div class="nb-text">
        <div class="nb-title">{n.title}</div>
        <div class="nb-sub">{n.sub}</div>
      </div>
    </div>
  );
}

// ───────────────────────────── AI indicator ─────────────────────────────
export function AiIndicator() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  if (!ui.aiThinking || warOver(s, ui)) return null;
  // Name and emblem both follow the playback (not the sim, which is already further on).
  const f = displayTurn(s, ui).faction;
  const fd = FACTIONS[f];
  return (
    <div class="ai-indicator" style={{ '--fc': fd.color } as Record<string, string>}>
      <span class="ai-spinner" />
      <Emblem faction={f} size={22} />
      {f === 'neutral' ? <span><b>The wilds</b> stir — monsters on the move</span> : <span><b>{f === viewerOf(s) ? ui.aiThinking : fd.name}</b> is making their move</span>}
      <span class="dots"><i /><i /><i /></span>
      <span class="ai-ff t-dim"><Kbd k="Space" /> fast-forward</span>
    </div>
  );
}

// ───────────────────────────── targeting mode hint ─────────────────────────────
export function ModeHint() {
  const { store } = useUi();
  const s = store.state!;
  const m = store.ui.mode;
  if (m.kind === 'attack') {
    // The attack command (T): only the marked enemies are targets.
    const u = unitById(s, m.unit);
    const kind = u ? safe(() => mainAttackKind(u), 'melee') : 'melee';
    return (
      <div class="mode-hint mode-hint-attack panel">
        <span class="mh-sym"><Sym name={kind} /></span>
        <div><b>Attack</b><span>Choose a target for {u?.name ?? 'the unit'} · Shift+click: other attack · right-click to cancel</span></div>
        <button type="button" class="btn btn-small" onClick={() => store.cancelMode()}>Cancel <Kbd k="Esc" /></button>
      </div>
    );
  }
  if (m.kind !== 'cast' && m.kind !== 'skill') return null;
  let icon: string, name: string, text: string;
  if (m.kind === 'cast') {
    const sp = SPELLS[m.spell];
    icon = sp.icon; name = sp.name;
    text = sp.target === 'ally' ? 'Choose an allied unit' : sp.target === 'empty' ? 'Choose an empty hex' : 'Choose a target hex';
    text += ' within range of a Mage Tower · right-click to cancel';
  } else {
    const sk = ACTIVES[m.skill];
    const u = unitById(s, m.unit);
    icon = sk.icon; name = sk.name;
    text = (sk.target === 'enemy' ? 'Choose an enemy' : sk.target === 'ally' ? 'Choose an ally' : 'Choose a hex') + ` within ${u ? safe(() => skillRange(u, m.skill), sk.range) : sk.range} of ${u?.name ?? 'the unit'} · right-click to cancel`;
  }
  return (
    <div class="mode-hint panel">
      <Icon k={icon} size={30} />
      <div><b>{name}</b><span>{text}</span></div>
      <button type="button" class="btn btn-small" onClick={() => store.cancelMode()}>Cancel <Kbd k="Esc" /></button>
    </div>
  );
}

// ───────────────────────────── combat forecast ─────────────────────────────
function hpColor(hp: number, max: number): string {
  if (hp <= 0) return '#5a1712';
  const f = Math.max(0, Math.min(1, hp / Math.max(1, max)));
  return `hsl(${Math.round(f * 110)} 62% ${38 + f * 8}%)`;
}

/** Stacked bar of the final HP distribution (index = hp). Tiny buckets are merged. */
function HpDist({ dist, max, current }: { dist: number[]; max: number; current: number }) {
  const segs: { hp: number; p: number }[] = [];
  for (let hp = 0; hp < dist.length; hp++) if (dist[hp] > 0.0005) segs.push({ hp, p: dist[hp] });
  const total = segs.reduce((a, x) => a + x.p, 0) || 1;
  const exp = segs.reduce((a, x) => a + x.hp * x.p, 0) / total;
  return (
    <div class="hpdist">
      <div class="hpdist-bar">
        {segs.map((x) => (
          <span key={x.hp} style={{ width: `${(x.p / total) * 100}%`, background: hpColor(x.hp, max) }}
            title={`${x.hp} HP: ${pct(x.p / total)}`} />
        ))}
      </div>
      <div class="hpdist-label"><span>{fmt(current)} → <b>{fmt(exp)}</b></span><span class="t-dim">expected HP</span></div>
    </div>
  );
}

const MOD_ICON: Record<AttackMod['id'], string> = {
  charge: 'horse', powerstrike: 'sword', leadership: 'star', berserker: 'skull', vsMounted: 'horse', poison: 'poison', vampiric: 'heart', flank: 'melee',
};

function ModChips({ mods, tone }: { mods: AttackMod[] | undefined; tone: 'good' | 'bad' }) {
  if (!mods?.length) return null;
  return (
    <div class="fc-mods">
      {mods.map((m) => (
        <span key={m.id} class={cls('fc-mod', `t-${tone}`)} {...tip(m.mult ? `${m.label}: ×${m.mult}` : m.label)}>
          <Sym name={MOD_ICON[m.id] ?? 'star'} />{m.label}{m.mult ? <small> ×{m.mult}</small> : null}
        </span>
      ))}
    </div>
  );
}

function ForecastSide({ u, prof, dist, dealt, killChance, maxHp, label, spent }: {
  u: Unit; prof: CombatForecast['attacker'] | null; dist: number[]; dealt: number; killChance: number; maxHp: number; label: string;
  /** It could answer, but has already retaliated as often as it may this turn. */
  spent?: boolean;
}) {
  const fd = FACTIONS[u.faction];
  const name = u.monster ? (u.name || MONSTERS[u.monster]?.name) : u.name;
  return (
    <div class="fc-side" style={{ '--fc': fd.color } as Record<string, string>}>
      <div class="fc-who"><span class="fc-role">{label}</span><b>{name}</b><span class="t-dim">Lv {u.level}</span></div>
      {prof ? (
        <>
          <div class="fc-attack"><KindIcon kind={prof.kind} /><span>{prof.name}</span><b>{fmt(prof.damage)}<small>×</small>{prof.strikes}</b></div>
          <div class="fc-row"><span>To hit</span><b class={prof.hitChance >= 0.6 ? 't-good' : prof.hitChance <= 0.4 ? 't-bad' : ''}>{pct(prof.hitChance)}</b></div>
          <div class="fc-row"><span>Expected dmg</span><b>{fmt(dealt)}</b></div>
          {prof.firststrike && <div class="fc-row"><span>First strike</span><b class="t-gold">yes</b></div>}
          <ModChips mods={prof.mods} tone={label === 'Attacker' ? 'good' : 'bad'} />
        </>
      ) : (
        <div class="fc-attack fc-none" {...(spent ? tip('A unit retaliates once per turn (twice with Combat Reflexes). This one already has: it takes the blows without answering.') : {})}>
          <span>{spent ? 'Already retaliated this turn' : 'No retaliation'}</span>
        </div>
      )}
      <HpDist dist={dist} max={maxHp} current={u.hp} />
      <div class={cls('fc-kill', killChance > 0.0005 && 'has')}><Sym name="skull" />{killChance > 0.0005 ? <>Falls: <b>{pct(killChance)}</b></> : 'Survives'}</div>
    </div>
  );
}

const sameHex = (a: Hex, b: Hex) => a.q === b.q && a.r === b.r;

export function ForecastTooltip() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  // Never over a window that opened while the cursor rested on the map.
  const fc = ui.modal ? null : ui.forecast;
  const attId = ui.mode.kind === 'unit' || ui.mode.kind === 'skill' || ui.mode.kind === 'attack' ? ui.mode.unit : null;
  const att = unitById(s, attId);
  const def = unitById(s, ui.forecastTarget);
  const from = ui.forecastFrom;
  const path = from ? ui.reach.find((r) => sameHex(r.hex, from.hex))?.path ?? [] : [];
  // Beside the target, clear of the attacker and the way it walks there.
  const ref = useAnchoredBox(!!fc && !!att && !!def, def?.pos ?? null, att ? [att.pos, ...path] : []);
  if (!fc || !att || !def) return null;
  const maxOf = (dist: number[], u: Unit) => Math.max(u.hp, dist.length - 1);
  const alt = ui.forecastAlt;
  const shownName = fc.attacker?.name ?? 'attack';
  const fromTile = from ? tileAt(s, from.hex) : undefined;
  const fromDef = from ? safe(() => tileDefense(s, att, from.hex), fromTile ? TERRAIN[fromTile.terrain].defense : 0) : 0;
  return (
    <div class="forecast" ref={ref} style={{ opacity: 0 }}>
      <div class="fc-title">Combat forecast</div>
      <div class="fc-from t-dim">
        {from && fromTile
          ? <>Moves to {TERRAIN[fromTile.terrain].name} first · defense <b>{Math.round(fromDef)}%</b> · {fmt(from.mpLeft)} MP left</>
          : 'Attacks from where it stands'}
      </div>
      <div class="fc-cols">
        <ForecastSide u={att} label="Attacker" prof={fc.attacker} dist={fc.attackerHpDist} dealt={fc.expectedDamageToDefender}
          killChance={fc.attackerKillChance} maxHp={maxOf(fc.attackerHpDist, att)} />
        <div class="fc-vs">vs</div>
        <ForecastSide u={def} label="Defender" prof={fc.defender} dist={fc.defenderHpDist} dealt={fc.expectedDamageToAttacker}
          killChance={fc.defenderKillChance} maxHp={maxOf(fc.defenderHpDist, def)} spent={fc.defenderSpent} />
      </div>
      <div class="fc-foot t-dim">
        {!alt ? 'Click to attack · right-click to cancel'
          : alt.active ? <>Click: {shownName} · release <Kbd k="Shift" /> for {alt.name} · right-click to cancel</>
            : <>Click to attack · <Kbd k="Shift" />+click: {alt.name} · right-click to cancel</>}
      </div>
    </div>
  );
}

// ───────────────────────────── spell / skill preview ─────────────────────────────
function EffectRow({ s, e, harm }: { s: GameState; e: EffectEntry; harm: boolean }) {
  const u = unitById(s, e.unit);
  if (!u) return null;
  const fd = FACTIONS[u.faction];
  const name = u.monster ? (u.name || MONSTERS[u.monster]?.name) : u.name;
  const after = e.hpBefore + e.hpDelta;
  return (
    <div class={cls('ep-row', e.own && harm && 'friendly')} style={{ '--fc': fd.color } as Record<string, string>}>
      <div class="ep-who"><b>{name}</b>{u.isLeader && <span class="pill pill-bad">Leader</span>}{e.own && harm && <span class="t-bad">yours</span>}</div>
      {e.hpDist ? <HpDist dist={e.hpDist} max={Math.max(e.maxHp, e.hpDist.length - 1)} current={e.hpBefore} />
        : e.hpDelta !== 0 ? <div class="ep-hp">HP {fmt(e.hpBefore)} → <b>{fmt(after)}</b> <span class={e.hpDelta < 0 ? 't-bad' : 't-good'}>({e.hpDelta > 0 ? '+' : ''}{fmt(e.hpDelta)})</span></div>
          : e.mpDelta ? null
            : <div class="ep-hp t-dim">{harm ? 'Unharmed' : 'Affected'}</div>}
      {e.mpDelta ? <div class="ep-hp">MP {fmt(u.mp)} → <b>{fmt(u.mp + e.mpDelta)}</b></div> : null}
      {harm && <div class={cls('fc-kill', e.killChance > 0.0005 && 'has')}><Sym name="skull" />{e.killChance > 0.0005 ? <>Falls: <b>{pct(e.killChance)}</b>{e.approx ? ' (est.)' : ''}</> : 'Survives'}</div>}
    </div>
  );
}

export function EffectPreviewTooltip() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const m = ui.mode;
  const h = ui.hoverHex;
  const p = ui.effectPreview;
  const active = !ui.modal && !ui.busy && (m.kind === 'cast' || m.kind === 'skill') && !!h && (!!p || !!ui.effectError);
  const radius = m.kind === 'cast' ? SPELLS[m.spell].radius : m.kind === 'skill' && m.skill === 'volley' ? 1 : 0;
  const area = h && radius > 0 ? spiral(h, radius) : [];
  const caster = m.kind === 'skill' ? unitById(s, m.unit) : undefined;
  const ref = useAnchoredBox(active, h, caster ? [...area, caster.pos] : area);
  if (!active || (m.kind !== 'cast' && m.kind !== 'skill')) return null;
  const icon = m.kind === 'cast' ? SPELLS[m.spell].icon : ACTIVES[m.skill].icon;
  const name = m.kind === 'cast' ? SPELLS[m.spell].name : ACTIVES[m.skill].name;
  const cost = m.kind === 'cast' ? `${SPELLS[m.spell].mana} mana · recharge ${SPELLS[m.spell].cooldown}` : `cooldown ${ACTIVES[m.skill].cooldown}`;
  const harm = p?.tone === 'harm';
  const own = p ? p.entries.filter((e) => e.own && e.hpDelta < 0) : [];
  const ownLeader = own.some((e) => unitById(s, e.unit)?.isLeader);
  return (
    <div class={cls('forecast effect-preview', harm && 'harm')} ref={ref} style={{ opacity: 0 }}>
      <div class="ep-head"><Icon k={icon} size={28} /><div><b>{name}</b><small class="t-dim">{cost}</small></div></div>
      {ui.effectError ? <div class="ep-error t-bad">{ui.effectError}</div> : p && (
        <>
          {own.length > 0 && (
            <div class="ep-warn"><Sym name="skull" />Hits {own.length === 1 ? 'one' : own.length} of your units{ownLeader ? ' — your Leader!' : ''}</div>
          )}
          {p.entries.length > 0 ? <div class="ep-rows">{p.entries.map((e) => <EffectRow key={e.unit} s={s} e={e} harm={harm} />)}</div>
            : !p.notes.length && <div class="t-dim ep-none">No unit is affected.</div>}
          {p.notes.map((n) => <div key={n} class="ep-note t-dim">{n}</div>)}
        </>
      )}
      <div class="fc-foot t-dim">
        {ui.effectError ? 'Right-click to cancel' : own.length ? 'Click twice to go ahead · right-click to cancel' : `Click to ${m.kind === 'cast' ? 'cast' : 'use'} · right-click to cancel`}
      </div>
    </div>
  );
}

// ───────────────────────────── hover hex chip ─────────────────────────────
type ChipLine = { k: string; v: string; tone?: string };

/** Terrain, defense, move cost, deposit and (last-seen) building of a hex: what the tile panel shows, at a glance. */
function terrainLines(store: GameStore, s: GameState, h: Hex): { title: string; lines: ChipLine[] } | null {
  const viewer = viewerOf(s);
  const t = tileAt(s, h);
  if (!t || !hexExplored(s, viewer, h)) return null;
  const tdef = TERRAIN[t.terrain];
  const visible = hexVisible(s, viewer, h);
  const mem = visible ? null : store.lastSeen?.() ?? null;
  const b = mem ? mem.buildings[tileIndex(h, s.width)] ?? undefined : buildingAtHex(s, h);
  const bdef = b ? BUILDINGS[b.type] : null;
  const bDefense = b && bdef?.defense && isComplete(b) ? bdef.defense[Math.min(bdef.defense.length - 1, b.level - 1)] : 0;
  const impassable = !Number.isFinite(tdef.moveCost);
  const d = tdef.defense + bDefense;
  const lines: ChipLine[] = [
    { k: 'Defense', v: impassable ? '—' : `${d}%`, tone: d >= 50 ? 't-good' : d <= 30 ? 't-bad' : '' },
    { k: 'Move cost', v: impassable ? 'Impassable' : String(tdef.moveCost), tone: impassable ? 't-dim' : '' },
  ];
  if (t.deposit) lines.push({ k: 'Deposit', v: DEPOSIT_INFO[t.deposit]?.name ?? t.deposit, tone: 't-gold' });
  if (t.terrain === 'ruins') lines.push({ k: 'Ruins', v: t.ruinsLooted ? 'looted' : 'unexplored', tone: t.ruinsLooted ? 't-dim' : 't-gold' });
  if (b && bdef) lines.push({ k: bdef.name, v: b.owner ? FACTIONS[b.owner].name.replace(/^(House|The)\s+/, '') : 'abandoned' });
  if (!visible) lines.push({ k: 'Fogged', v: 'last seen', tone: 't-dim' });
  return { title: tdef.name, lines };
}

function hoverInfo(store: GameStore, s: GameState, ui: GameStore['ui']): { title: string; lines: ChipLine[] } | null {
  const h = ui.hoverHex;
  // No chip over a window, and none while a forecast or a spell preview says more.
  if (!h || ui.forecast || ui.modal || ui.effectPreview || ui.effectError) return null;
  const viewer = viewerOf(s);
  const t = tileAt(s, h);
  if (!t || !hexExplored(s, viewer, h)) return null;
  const tdef = TERRAIN[t.terrain];
  const m = ui.mode;
  if (m.kind === 'unit') {
    const u = unitById(s, m.unit);
    if (!u || u.faction !== viewer) return terrainLines(store, s, h);
    if (u.pos.q === h.q && u.pos.r === h.r) return null;
    // A seen enemy gets the combat forecast instead; a hidden one must not hide the chip.
    const occupant = unitAtHex(s, h);
    if (occupant && occupant.faction !== viewer && hexVisible(s, viewer, h)) return null;
    const reach = ui.reach.find((x) => x.hex.q === h.q && x.hex.r === h.r);
    const def = safe(() => tileDefense(s, u, h), tdef.defense);
    const lines: ChipLine[] = [
      { k: 'Defense', v: Number.isFinite(tdef.moveCost) ? `${Math.round(def)}%` : '—', tone: def >= 50 ? 't-good' : def <= 30 ? 't-bad' : '' },
    ];
    if (reach) {
      lines.push({ k: 'Moves left', v: `${fmt(reach.mpLeft)}` });
      if (reach.zocStop) lines.push({ k: 'Zone of control', v: 'stops here', tone: 't-warn' });
    } else if (ui.hoverToward && 'turns' in ui.hoverToward && ui.hoverToward.wait) {
      // Not blocked: the first step costs more than the MP left this turn.
      const n = ui.hoverToward.turns - 1;
      lines.push({ k: 'Too costly', v: `this turn (${ui.hoverToward.wait})`, tone: 't-warn' });
      lines.push({ k: 'Reachable', v: n <= 1 ? 'next turn' : `in ${n} turns`, tone: 't-dim' });
    } else if (ui.hoverToward && 'turns' in ui.hoverToward) {
      lines.push({ k: 'Out of reach', v: `${ui.hoverToward.turns} turns away`, tone: 't-dim' });
      lines.push({ k: 'Click', v: 'head there', tone: 't-gold' });
    } else if (ui.hoverToward && 'error' in ui.hoverToward) {
      lines.push({ k: 'Out of reach', v: ui.hoverToward.error, tone: 't-dim' });
    } else lines.push({ k: 'Out of reach', v: Number.isFinite(tdef.moveCost) ? 'this turn' : 'impassable', tone: 't-dim' });
    return { title: tdef.name, lines };
  }
  if (m.kind === 'idle') {
    // The selected hex already has the tile panel.
    if (ui.selectedHex && ui.selectedHex.q === h.q && ui.selectedHex.r === h.r) return null;
    return terrainLines(store, s, h);
  }
  return null;
}

/** Idle scouting chip: shown after the pointer rests a moment, so sweeping the map does not flicker it. */
const IDLE_CHIP_DELAY = 300;

export function HoverChip() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const info = hoverInfo(store, s, ui);
  const idle = ui.mode.kind === 'idle';
  const hk = ui.hoverHex ? hexKey(ui.hoverHex) : '';
  const [restedOn, setRestedOn] = useState('');
  useEffect(() => {
    if (!idle || !hk) return;
    const t = window.setTimeout(() => setRestedOn(hk), IDLE_CHIP_DELAY);
    return () => window.clearTimeout(t);
  }, [hk, idle]);
  const show = !!info && (!idle || restedOn === hk);
  const ref = useCursorBox(show, 20);
  if (!show || !info) return null;
  return (
    <div class="hover-chip" ref={ref} style={{ opacity: 0 }}>
      <b>{info.title}</b>
      {info.lines.map((l) => <span key={l.k} class="hc-line"><span>{l.k}</span><em class={l.tone}>{l.v}</em></span>)}
    </div>
  );
}
