// Unit sheet: everything about one unit on one page — vitals and condition, every attribute with
// where each point comes from, attacks, the five equipment slots, every augment and the level
// history, the seven kinds of experience, and the house stockpile. Units of other houses (and
// beasts) open read-only, without the stockpile.
import type { ComponentChildren } from 'preact';
import type { EquipSlot, GameState, Unit, UnitStats } from '../../core/types';
import { BUILDINGS } from '../../data/buildings';
import { FACTIONS, MONSTERS } from '../../data/factions';
import { FISTS_ATTACK, ITEMS } from '../../data/items';
import { LEADER_XP_MULT, MAX_LEVEL, xpToNext } from '../../data/skills';
import { TERRAIN } from '../../data/terrain';
import { dutyOf } from '../../game/duty';
import { tileDefense } from '../../sim/combat';
import { BARE_WORKER_MULT, unitIncome, unitUpkeep, workerMult, workerOf, WORKER_MULT } from '../../sim/economy';
import { HEAL_ORDER_ALERT, ORDER_NAMES } from '../../sim/orders';
import { bodyVariant, canBuildWith, effectiveStats, getAttackDefs, isMounted, statBreakdown } from '../../sim/units';
import { Bar, Btn, Output, TipCard } from '../common';
import { useUi } from '../ctx';
import { Emblem, Icon, KindIcon, Portrait, Sym } from '../icons';
import {
  armoryNames, attackLines, augmentCount, augmentsOf, BUFF_INFO, fmtMult, kindSummary, levelHistory, optionsFavouredBy, STAT_HELP, statRows,
  stockpileRows, TONE_LABEL, workerBonusText, XP_SOURCES, xpRows, type AttackLine, type StatRow, type XpRow,
} from '../sheet';
import { tip } from '../tooltip';
import {
  buildingAtHex, cls, fmt, hexVisible, isComplete, isMyTurn, pct, portraitKey, safe, selectedUnitId, SLOT_EMPTY_SYM, tileAt, unitById, unitRole,
  unitsOwned, viewerOf, XP_NAMES, xpSegments,
} from '../util';
import { itemSummary } from './Forge';
import { optionIcon } from './LevelUp';
import { Modal } from './Modal';
import '../sheet.css';

const SLOTS: { slot: EquipSlot; label: string }[] = [
  { slot: 'main', label: 'Main hand' }, { slot: 'off', label: 'Off hand' }, { slot: 'body', label: 'Body' },
  { slot: 'trinket', label: 'Trinket' }, { slot: 'mount', label: 'Mount' },
];

const STAT_SYM: Record<keyof UnitStats, string> = { maxHp: 'heart', str: 'fist', dex: 'ranged', int: 'magic', armor: 'shield', mov: 'boot', vis: 'eye' };

const ORDER_HELP: Record<NonNullable<Unit['order']>, string> = {
  heal: `Stays put and rests (+2 HP a turn) until it is fully healed. A hostile within ${HEAL_ORDER_ALERT} hexes, or an attack, wakes it.`,
  sentry: 'Keeps watch where it stands. A hostile coming into its sight, or an attack, wakes it.',
};

/** The sheet's unit: the one the window was opened for, else the selection (fog-aware). */
function sheetUnit(s: GameState, ui: ReturnType<typeof useUi>['store']['ui']): Unit | undefined {
  return unitById(s, ui.sheetUnit) ?? unitById(s, selectedUnitId(s, ui));
}

function SheetCard({ title, icon, right, children, class: klass }: { title: string; icon: string; right?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={cls('us-card', klass)}>
      <header class="us-card-head">
        <span class="us-card-icon"><Sym name={icon} /></span>
        <h3>{title}</h3>
        {right && <span class="us-card-right">{right}</span>}
      </header>
      <div class="us-card-body">{children}</div>
    </section>
  );
}

// ───────────────────────────── hero band ─────────────────────────────

function Hero({ s, u, own, stats }: { s: GameState; u: Unit; own: boolean; stats: UnitStats }) {
  const { store } = useUi();
  const fd = FACTIONS[u.faction];
  const body = safe(() => bodyVariant(u), u.isLeader ? 'leader' : 'commoner');
  const name = u.monster ? (u.name || MONSTERS[u.monster]?.name) : u.name;
  const toNext = xpToNext(u.level);
  const maxed = u.level >= MAX_LEVEL;
  const segs = xpSegments(u, toNext);
  const myTurn = isMyTurn(s, store.ui);
  const duty = own && !u.order ? safe(() => dutyOf(s, u), null) : null;
  const upkeep = safe(() => unitUpkeep(u), 0);
  const income = safe(() => unitIncome(s, u), {});
  const turnState = !own || !myTurn ? null
    : u.acted && u.mp <= 0 ? 'Done for this turn' : u.acted ? 'Has acted' : u.moved ? 'Has moved' : 'Ready';
  // Where it stands: the building (and whether it works it), the terrain and its defense there.
  const here = buildingAtHex(s, u.pos);
  const hereDef = here ? BUILDINGS[here.type] : null;
  const terrain = TERRAIN[tileAt(s, u.pos)?.terrain ?? 'grass'];
  const works = !!here && safe(() => workerOf(s, here), null)?.id === u.id;
  const defense = safe(() => tileDefense(s, u, u.pos), terrain?.defense ?? 0);
  return (
    <div class="us-hero" style={{ '--fc': fd.color, '--fa': fd.accent } as Record<string, string>}>
      <div class="us-portrait-wrap">
        <Portrait k={portraitKey(u, body)} name={name} color={fd.color} class="us-portrait" />
        <span class="us-level" {...tip(maxed ? `Level ${u.level} — the maximum` : `Level ${u.level}`)}><small>Lvl</small>{u.level}</span>
        {u.isLeader && <span class="leader-crown" {...tip('Leader — if they fall, the house is lost')}><Sym name="castle" /></span>}
      </div>
      <div class="us-vitals">
        <div class="us-vital">
          <span class="us-vk">Health</span>
          <Bar kind="hp" value={u.hp} max={stats.maxHp} label={`${fmt(u.hp)} / ${fmt(stats.maxHp)}`} tipContent="Hit points: the unit dies at 0" />
        </div>
        <div class="us-vital">
          <span class="us-vk">Experience</span>
          <Bar kind="xp" value={u.xp} max={toNext} label={maxed ? 'Maximum level' : `${fmt(u.xp)} / ${toNext} to level ${u.level + 1}`}
            tipContent={maxed ? 'This unit has reached the highest level.' : 'XP earned this level, by kind (see Experience below)'}>
            {maxed ? <div class="bar-fill xp-max" style={{ width: '100%' }} />
              : segs.map((g) => <div key={g.cat} class={`bar-seg xp-${g.cat}`} style={{ width: `${g.frac * 100}%` }} {...tip(`${XP_NAMES[g.cat]}: ${fmt(g.amount)} XP`)} />)}
          </Bar>
        </div>
        <div class="us-facts">
          <span class="us-fact" {...tip('Movement points left this turn / per turn')}>
            <Sym name="boot" /><small>Move</small><b>{own ? `${fmt(u.mp)} / ${fmt(stats.mov)}` : fmt(stats.mov)}</b>
          </span>
          <span class="us-fact" {...tip('Enemies this unit has slain')}><Sym name="skull" /><small>Kills</small><b>{u.kills ?? 0}</b></span>
          {!u.monster && <span class="us-fact" {...tip(upkeep > 0 ? `Eats ${fmt(upkeep)} food each turn` : 'Eats nothing: leaders and summons are fed by the house')}>
            <Sym name="food" /><small>Upkeep</small><b>{fmt(upkeep)}</b></span>}
          {!u.monster && !u.summonTurns && (
            // What it would bring to a building: lit while it works one, dimmed as a potential.
            <span class={cls('us-fact', works ? 'us-fact-on' : 'us-fact-dim')} {...tip(<TipCard title={works ? `Working the ${hereDef!.name}` : 'As a worker'}
              sub={works ? 'Its multiplier on that building\'s output' : 'Not working any building now'}>
              {workerBonusText(safe(() => canBuildWith(u), false))} Its work efficiencies multiply the output too.
              {!works && ' It works a building by standing on one of yours that produces something.'}</TipCard>)}>
              <Sym name="hammer" /><small>{works ? 'Working' : 'As worker'}</small><b>{fmtMult(safe(() => canBuildWith(u), false) ? WORKER_MULT : BARE_WORKER_MULT)}</b>
            </span>
          )}
          {Object.keys(income).length > 0 && <span class="us-fact us-fact-income" {...tip('Brought in every turn by its items and passives')}><small>Yields</small><Output out={income} /></span>}
        </div>
      </div>
      <div class="us-condition">
        <div class="us-vk">Condition</div>
        <div class="us-pills">
          {!own && <span class="pill pill-enemy">{u.faction === 'neutral' ? 'Hostile beast' : 'Enemy'}</span>}
          {u.order && <span class="pill pill-order" {...tip(<TipCard title={ORDER_NAMES[u.order]} sub="Standing order">{ORDER_HELP[u.order]}</TipCard>)}>
            <Sym name={u.order === 'heal' ? 'heart' : 'eye'} />{ORDER_NAMES[u.order]}</span>}
          {duty && <span class="pill pill-work" {...tip('A standing job: left out of Tab and the idle count')}><Sym name="hammer" />{duty}</span>}
          {turnState && <span class={cls('pill', turnState === 'Ready' ? 'pill-good' : 'pill-dim')}>{turnState}</span>}
          {u.poisoned && <span class="pill pill-bad" {...tip('Loses 4 HP each turn until cured at a castle or shrine, or by Mend / Healing Light')}><Sym name="poison" />Poisoned</span>}
          {u.buffs?.map((b, i) => {
            const info = BUFF_INFO[b.id];
            return info ? (
              <span key={i} class="pill pill-good" {...tip(`${info.text(b)}`)}>
                <Sym name={info.icon} />{info.name}<em>{b.turns} turn{b.turns === 1 ? '' : 's'}</em>
              </span>
            ) : null;
          })}
          {u.summonTurns != null && <span class="pill pill-magic" {...tip('Summoned: crumbles when the timer runs out')}><Sym name="hourglass" />Crumbles in {u.summonTurns}</span>}
          {safe(() => isMounted(u), false) && <span class="pill">Mounted</span>}
          {own && u.pendingLevelUps > 0 && (
            <button type="button" class="pill pill-levelup" onClick={() => store.openModal('levelup', { unit: u.id })}
              {...tip('Choose the level-up reward')}><Sym name="star" />Level-up waiting{u.pendingLevelUps > 1 ? ` ×${u.pendingLevelUps}` : ''}</button>
          )}
        </div>
        {u.monster && MONSTERS[u.monster]?.description && <p class="us-lore">{MONSTERS[u.monster].description}</p>}
        <div class="us-where" {...tip(`Attacks against it miss ${defense}% of the time here (terrain${hereDef?.defense ? ', building' : ''} and shield; magic always hits 70%).`)}>
          <Sym name={hereDef ? hereDef.id === 'castle' ? 'castle' : 'house' : 'eye'} />
          <span>
            {hereDef ? <>On {here!.owner === u.faction ? 'its' : 'a'} <b>{hereDef.name}</b>{here!.buildLeft > 0 && !here!.upgrading ? ' (building site)' : ''} · </> : null}
            {terrain?.name ?? 'Unknown ground'} · defense <b>{defense}%</b>
            {works && <><br /><span class="t-good">Working it: {fmtMult(safe(() => workerMult(u), BARE_WORKER_MULT))} output</span></>}
          </span>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── attributes & attacks ─────────────────────────────

function StatLineRow({ r }: { r: StatRow }) {
  const card = (
    <TipCard title={r.name} sub={`Base ${fmt(r.base)}${r.unit} → ${fmt(r.total)}${r.unit}`}>
      {STAT_HELP[r.key]}
      {r.parts.length > 0 && (
        <table class="breakdown">
          <tbody>
            <tr><td>Base</td><td>{fmt(r.base)}{r.unit}</td></tr>
            {r.parts.map((p, i) => <tr key={i}><td>{p.label} <span class="t-dim">({TONE_LABEL[p.tone]})</span></td><td>{p.value > 0 ? '+' : ''}{fmt(p.value)}{r.unit}</td></tr>)}
          </tbody>
          <tfoot><tr><td>Total</td><td>{fmt(r.total)}{r.unit}</td></tr></tfoot>
        </table>
      )}
    </TipCard>
  );
  return (
    <div class={cls('us-stat', r.bonus > 0 && 'up', r.bonus < 0 && 'down')} {...tip(card)}>
      <span class="us-stat-icon"><Sym name={STAT_SYM[r.key]} /></span>
      <span class="us-stat-name">{r.name}<small>{r.short}</small></span>
      <span class="us-stat-total">{fmt(r.total)}<small>{r.unit}</small></span>
      <div class="us-parts">
        <span class="us-part tone-base">Base {fmt(r.base)}{r.unit}</span>
        {r.parts.map((p, i) => <span key={i} class={cls('us-part', `tone-${p.tone}`, p.value < 0 && 'neg')}>{p.text}</span>)}
      </div>
    </div>
  );
}

function AttackRow({ l }: { l: AttackLine }) {
  const a = l.attack;
  const kind = a.kind[0].toUpperCase() + a.kind.slice(1);
  return (
    <div class={cls('us-attack', `atk-${a.kind}`)}>
      <div class="us-atk-head">
        <KindIcon kind={a.kind} />
        <b class="us-atk-name">{a.name}</b>
        <span class="us-atk-kind">{kind} · {a.range > 1 ? `range ${a.range}` : 'adjacent'}</span>
        <span class="us-atk-dmg" {...tip('Damage per strike before the target\'s armor × strikes')}>{fmt(l.perStrike)}<small>×</small>{a.strikes}</span>
      </div>
      <div class="us-atk-formula">
        <span>{fmt(l.base)} base</span>
        <span>+ {fmt(l.statBonus)} <small>(½ {l.statName})</small></span>
        {l.mults.map((m, i) => <span key={i} class="us-mult">{fmtMult(m.value)} <small>{m.label}</small></span>)}
        <span class="us-eq">= <b>{fmt(l.perStrike)}</b> per strike</span>
      </div>
      <ul class="us-atk-notes">
        <li>{l.hit}</li>
        {l.notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </div>
  );
}

// ───────────────────────────── equipment & inventory ─────────────────────────────

function EquipmentList({ u }: { u: Unit }) {
  if (u.monster) {
    return <div class="us-empty">Creatures fight with their own natural weapons and carry no equipment.</div>;
  }
  const main = u.equipment.main ? ITEMS[u.equipment.main] : null;
  return (
    <div class="us-slots">
      {SLOTS.map(({ slot, label }) => {
        const it = u.equipment[slot];
        const def = it ? ITEMS[it] : null;
        const blocked = slot === 'off' && !def && !!main?.twoHanded;
        return (
          <div key={slot} class={cls('us-slot', !def && 'empty', blocked && 'blocked')}>
            <span class="us-slot-icon">
              {def ? <Icon k={def.icon} size={46} /> : <Sym name={blocked ? 'lock' : SLOT_EMPTY_SYM[slot]} />}
            </span>
            <span class="us-slot-main">
              <small>{label}</small>
              {def ? <>
                <b>{def.name}</b>
                <span class="us-slot-sum">{itemSummary(def) || 'No combat effect'}</span>
                <span class="us-slot-desc">{def.description}</span>
              </> : blocked ? <>
                <b>Blocked</b>
                <span class="us-slot-desc">The {main!.name} takes both hands.</span>
              </> : <>
                <b class="t-dim">Empty</b>
                <span class="us-slot-desc">{slot === 'main' ? `Fights with ${FISTS_ATTACK.name.toLowerCase()} (${FISTS_ATTACK.base}×${FISTS_ATTACK.strikes}). ` : ''}Equip an item at an armory.</span>
              </>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Inventory({ s, u }: { s: GameState; u: Unit }) {
  const { store } = useUi();
  const rows = stockpileRows(s, u.faction);
  const here = buildingAtHex(s, u.pos);
  const onArmory = !!here && here.owner === u.faction && isComplete(here) && !!BUILDINGS[here.type]?.armory;
  const my = isMyTurn(s, store.ui);
  const reason = !my ? 'Not your turn' : !onArmory ? `Stand on an armory to equip: ${armoryNames()}` : null;
  return (
    <>
      {rows.length === 0
        ? <div class="us-empty">The stockpile is empty. Craft weapons, armor and trinkets at a Forge.</div>
        : (
          <div class="us-stock">
            {rows.map(({ def, count }) => (
              <span key={def.id} class="us-stock-item" {...tip(<TipCard icon={<Icon k={def.icon} size={36} />} title={def.name} sub={itemSummary(def)}>{def.description}</TipCard>)}>
                <span class="us-stock-icon"><Icon k={def.icon} size={42} /><span class="count-badge">{count}</span></span>
                <span class="us-stock-name">{def.name}</span>
              </span>
            ))}
          </div>
        )}
      <div class="us-stock-foot">
        <span class="t-dim">Items are equipped from the house stockpile on an armory: {armoryNames()}.</span>
        <Btn small icon="equip" disabled={!!reason} reason={reason} title="Equip items from the stockpile"
          onClick={() => store.openModal('equip', { unit: u.id })}>Equip…</Btn>
      </div>
    </>
  );
}

// ───────────────────────────── augments ─────────────────────────────

function AugmentList({ u, own }: { u: Unit; own: boolean }) {
  const a = augmentsOf(u);
  const hist = levelHistory(u);
  const none = augmentCount(a) === 0;
  return (
    <>
      {none && <div class="us-empty">No augments yet. Each level-up offers three rewards shaped by the experience earned during that level.</div>}
      {a.actives.length > 0 && <div class="us-sub">Active skills</div>}
      {a.actives.map((d) => {
        const cd = u.cooldowns?.[d.id] ?? 0;
        return (
          <div key={d.id} class="us-aug kind-active">
            <span class="us-aug-icon"><Icon k={d.icon} size={40} dim={cd > 0} />{cd > 0 && <span class="us-cd">{cd}</span>}</span>
            <span class="us-aug-main">
              <b>{d.name}</b>
              <span class="us-aug-meta">
                Cooldown {d.cooldown}{d.range ? ` · range ${d.range}` : ''} · {cd > 0 ? <span class="t-warn">ready in {cd} turn{cd === 1 ? '' : 's'}</span> : <span class="t-good">ready</span>}
              </span>
              <span class="us-aug-desc">{d.description}</span>
            </span>
          </div>
        );
      })}
      {a.passives.length > 0 && <div class="us-sub">Passives</div>}
      {a.passives.map((p) => (
        <div key={p.id} class="us-aug kind-passive">
          <span class="us-aug-icon"><Icon k={p.icon} size={40} /></span>
          <span class="us-aug-main"><b>{p.name}</b><span class="us-aug-desc">{p.description}</span></span>
        </div>
      ))}
      {a.crafts.length > 0 && <div class="us-sub">Building skills</div>}
      {a.crafts.map((d) => (
        <div key={d.id} class="us-aug kind-craft">
          <span class="us-aug-icon"><Icon k={d.icon} size={40} /></span>
          <span class="us-aug-main">
            <b>{d.name}</b>
            <span class="us-aug-desc">{d.description}</span>
          </span>
        </div>
      ))}
      {a.efficiencies.length > 0 && <div class="us-sub">Efficiencies</div>}
      {a.efficiencies.map((e) => (
        <div key={e.id} class="us-aug kind-eff">
          <span class="us-aug-icon"><Icon k={e.icon} size={40} /></span>
          <span class="us-aug-main">
            <b>{e.name} <span class="us-eff">{fmtMult(e.value)}</span> <small class={e.value >= 1 ? 't-good' : 't-bad'}>{e.pctText}</small></b>
            <span class="us-aug-desc">{e.description}</span>
          </span>
        </div>
      ))}
      <div class="us-sub">Level history</div>
      {hist.length === 0
        ? <div class="us-empty small">No level-up rewards chosen yet.</div>
        : (
          <ol class="us-history">
            {hist.map((h, i) => (
              <li key={i} {...tip(h.option ? <TipCard icon={<Icon k={optionIcon(h.option)} size={32} />} title={h.option.name} sub={`Level ${h.level}`}>{h.option.description}</TipCard> : h.name)}>
                <span class="us-hist-lvl">{h.level}</span>
                {h.option && <Icon k={optionIcon(h.option)} size={24} />}
                <span>{h.name}</span>
              </li>
            ))}
          </ol>
        )}
      {own && u.pendingLevelUps > 0 && <div class="us-note t-gold"><Sym name="star" /> {u.pendingLevelUps} level-up reward{u.pendingLevelUps > 1 ? 's' : ''} still to choose.</div>}
    </>
  );
}

// ───────────────────────────── experience ─────────────────────────────

function XpTable({ u }: { u: Unit }) {
  const rows = xpRows(u);
  const top = rows.reduce<XpRow | null>((best, r) => (r.level > (best?.level ?? 0) ? r : best), null);
  return (
    <div class="us-xp">
      <div class="us-xp-head">
        <span>Kind</span><span>This level</span><span>Lifetime</span><span>Earned by</span><span>Favours on level-up</span>
      </div>
      {rows.map((r) => {
        const fav = optionsFavouredBy(r.cat);
        return (
          <div key={r.cat} class={cls('us-xp-row', r.leaderOnly && 'off', top?.cat === r.cat && 'main')}>
            <span class="us-xp-name"><i class={`xp-dot xp-${r.cat}`} />{r.name}{top?.cat === r.cat && <small class="us-xp-tag" {...tip('Most of this level\'s XP: the next offer leans this way')}>main</small>}</span>
            <span class="us-xp-bar" {...tip(`${fmt(r.level)} ${r.name} XP this level${r.levelShare > 0 ? ` — ${pct(r.levelShare)} of it, so ${pct(r.levelShare)} of the weight of the next offer` : ''}`)}>
              <span class="us-xp-track"><span class={`xp-${r.cat}`} style={{ width: `${r.levelFrac * 100}%` }} /></span>
              <b>{fmt(r.level)}</b>
            </span>
            <span class="us-xp-bar life" {...tip(`${fmt(r.lifetime)} ${r.name} XP in all (${pct(r.lifeShare)} of everything it has learned)`)}>
              <span class="us-xp-track"><span class={`xp-${r.cat}`} style={{ width: `${r.lifeShare * 100}%` }} /></span>
              <b>{fmt(r.lifetime)}</b>
            </span>
            <span class="us-xp-src">{XP_SOURCES[r.cat]}</span>
            <span class="us-xp-fav">
              {fav.map((o) => (
                <span key={o.id} class={cls('us-fav', `kind-${o.kind}`)} {...tip(<TipCard icon={<Icon k={optionIcon(o)} size={32} />} title={o.name} sub={o.categories.map((c) => XP_NAMES[c]).join(' · ')}>{o.description}</TipCard>)}>
                  <Icon k={optionIcon(o)} size={22} />
                </span>
              ))}
              <small class="us-fav-sum">{kindSummary(fav)}</small>
            </span>
          </div>
        );
      })}
      <div class="us-note t-dim">
        Each level-up offers three rewards, weighted by the share of each kind of XP earned during that level (options of other kinds turn up rarely).
        {u.isLeader ? ` Leaders earn ${Math.round((LEADER_XP_MULT - 1) * 100)}% more XP.` : ''}
      </div>
    </div>
  );
}

// ───────────────────────────── the window ─────────────────────────────

export function UnitSheetModal() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const viewer = viewerOf(s);
  const u = sheetUnit(s, ui);
  const close = () => store.closeModal();
  if (!u || u.hp <= 0) {
    return <Modal size="sm" title="Unit" onClose={close}><div class="empty-note">This unit is no longer on the field.</div></Modal>;
  }
  const own = u.faction === viewer;
  if (!own && !hexVisible(s, viewer, u.pos)) {
    return <Modal size="sm" title="Out of sight" onClose={close}><div class="empty-note">This unit is hidden in the fog of war.</div></Modal>;
  }
  const fd = FACTIONS[u.faction];
  const stats = safe(() => effectiveStats(s, u), u.base);
  const rows = safe(() => statRows(statBreakdown(s, u)), [] as StatRow[]);
  const attacks = safe(() => attackLines(s, u, getAttackDefs(u), stats), [] as AttackLine[]);
  const name = u.monster ? (u.name || MONSTERS[u.monster]?.name) : u.name;
  const role = unitRole(u);

  // Footer: page through the house's units (leader first) without leaving the sheet.
  const mine = own ? unitsOwned(s, viewer).sort((a, b) => Number(b.isLeader) - Number(a.isLeader) || a.id - b.id) : [];
  const idx = mine.findIndex((x) => x.id === u.id);
  const go = (d: number) => { const n = mine[(idx + d + mine.length) % mine.length]; if (n) store.openModal('unitsheet', { unit: n.id }); };
  const my = isMyTurn(s, ui);
  const footer = (
    <div class="us-foot">
      {mine.length > 1 && <>
        <Btn small onClick={() => go(-1)} title="Previous unit of your house">‹ Prev</Btn>
        <span class="us-foot-count">{idx + 1} / {mine.length}</span>
        <Btn small onClick={() => go(1)} title="Next unit of your house">Next ›</Btn>
      </>}
      <span class="us-foot-gap" />
      {own && u.pendingLevelUps > 0 && <Btn glow primary icon="star" disabled={!my} reason={my ? null : 'Not your turn'} onClick={() => store.openModal('levelup', { unit: u.id })}>Level up</Btn>}
      <Btn onClick={close}>Close</Btn>
    </div>
  );

  return (
    <Modal size="xl" parchment={false} class="unit-sheet" onClose={close} footer={footer}
      icon={<Emblem faction={u.faction} size={44} />}
      title={name}
      sub={<span>Level {u.level} {role}{own ? '' : ` · ${u.faction === 'neutral' ? 'wild creature' : 'enemy'}`} · <span style={{ color: `color-mix(in srgb, ${fd.color} 50%, #fff)` }}>{fd.name}</span></span>}>
      <Hero s={s} u={u} own={own} stats={stats} />
      <div class="us-cols">
        <div class="us-col">
          <SheetCard title="Attributes" icon="fist" right={<span class="t-dim">base · sources · total</span>}>
            <div class="us-stats">{rows.map((r) => <StatLineRow key={r.key} r={r} />)}</div>
          </SheetCard>
          <SheetCard title="Attacks" icon="sword" right={<span class="t-dim">per strike × strikes</span>}>
            {attacks.map((l, i) => <AttackRow key={i} l={l} />)}
          </SheetCard>
        </div>
        <div class="us-col">
          <SheetCard title="Equipment" icon="shield">
            <EquipmentList u={u} />
          </SheetCard>
          {own && !u.monster && (
            <SheetCard title="Inventory" icon="equip" right={<span class="t-dim">house stockpile</span>}>
              <Inventory s={s} u={u} />
            </SheetCard>
          )}
        </div>
        <div class="us-col">
          <SheetCard title="Augments" icon="star" right={<span class="t-dim">{u.learned?.length ?? 0} picked</span>}>
            <AugmentList u={u} own={own} />
          </SheetCard>
        </div>
      </div>
      <SheetCard title="Experience" icon="research" class="us-wide"
        right={<span class="t-dim">{u.level >= MAX_LEVEL ? 'maximum level' : `${fmt(u.xp)} / ${xpToNext(u.level)} XP to level ${u.level + 1}`}</span>}>
        <XpTable u={u} />
      </SheetCard>
    </Modal>
  );
}
