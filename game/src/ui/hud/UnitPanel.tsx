// Left panel: the selected unit — portrait, bars, stats, equipment, attacks, passive skills and
// status. Its commands (attack, skills, orders, build…) are on the bottom command bar
// (CommandBar.tsx); the portrait opens the full sheet.
import type { AttackDef, EquipSlot, GameState, Unit, UnitStats } from '../../core/types';
import { BUILDINGS } from '../../data/buildings';
import { FACTIONS, MONSTERS } from '../../data/factions';
import { FISTS_ATTACK, ITEMS } from '../../data/items';
import { ACTIVES, MAX_LEVEL, PASSIVES, xpToNext } from '../../data/skills';
import { techDamageMult } from '../../sim/research';
import { HEAL_ORDER_ALERT } from '../../sim/orders';
import { bodyVariant, effectiveStats, getAttackDefs, isMounted } from '../../sim/units';
import { Bar, Kbd, TipCard } from '../common';
import { dutyOf, ORDER_DUTY } from '../../game/duty';
import { useUi } from '../ctx';
import { Emblem, Icon, KindIcon, Portrait, Sym } from '../icons';
import { tip } from '../tooltip';
import {
  buildingAtHex, cls, displayDamage, fmt, isComplete, isMyTurn, pct, portraitKey, safe, selectedUnitId, STAT_LABELS, STAT_NAMES,
  unitById, unitRole, viewerOf, XP_CATS, XP_NAMES, xpSegments,
} from '../util';
import '../commandbar.css';

const SLOTS: { slot: EquipSlot; label: string; empty: string }[] = [
  { slot: 'main', label: 'Main hand', empty: 'sword' },
  { slot: 'off', label: 'Off hand', empty: 'shield' },
  { slot: 'body', label: 'Body', empty: 'tunic' },
  { slot: 'trinket', label: 'Trinket', empty: 'amulet' },
  { slot: 'mount', label: 'Mount', empty: 'horse' },
];

const EFF_NAMES: Record<string, string> = {
  attack: 'Melee', ranged: 'Ranged', magic: 'Magic', farming: 'Farming', building: 'Building', mining: 'Mining',
  gathering: 'Gathering', mana: 'Mana', research: 'Research', trade: 'Trade',
};

const BUFF_INFO: Record<string, { name: string; icon: string; text: (b: Unit['buffs'][number]) => string }> = {
  bless: { name: 'Blessed', icon: 'star', text: (b) => `+${Math.round(((b.damageMult ?? 1.2) - 1) * 100)}% damage, +${b.armor ?? 10} armor` },
  fortify: { name: 'Fortified', icon: 'shield', text: (b) => `+${b.armor ?? 20} armor` },
  haste: { name: 'Hasted', icon: 'boot', text: () => 'Extra movement this turn' },
  powerstrike: { name: 'Power Strike', icon: 'sword', text: () => 'Next melee attack deals 50% more damage' },
  farsight: { name: 'Farsight', icon: 'eye', text: () => 'Revealing a distant area' },
};

/** Attacks when the sim helper is unavailable: weapon (+ melee fallback), monster attack or fists. */
function fallbackAttacks(u: Unit): AttackDef[] {
  if (u.monster) {
    const m = MONSTERS[u.monster];
    return m ? [{ ...m.attack }] : [{ ...FISTS_ATTACK }];
  }
  const main = u.equipment.main ? ITEMS[u.equipment.main] : null;
  if (!main?.attack) return [{ ...FISTS_ATTACK }];
  if (main.attack.kind === 'melee') return [main.attack];
  return [main.meleeFallback ?? { ...FISTS_ATTACK }, main.attack];
}

function attackMult(s: GameState, u: Unit, a: AttackDef): number {
  const fd = FACTIONS[u.faction];
  let m = safe(() => techDamageMult(s, u.faction), 1);
  if (a.kind === 'melee') m *= fd?.meleeMult ?? 1;
  if (a.kind === 'ranged') m *= fd?.rangedMult ?? 1;
  if (a.kind === 'magic') m *= fd?.magicMult ?? 1;
  return m;
}

function StatCell({ k, eff, base, extra }: { k: keyof UnitStats; eff: number; base: number; extra?: string }) {
  const d = eff - base;
  return (
    <div class={cls('stat', d > 0 && 'buffed', d < 0 && 'nerfed')}
      {...tip(<TipCard title={STAT_NAMES[k]} sub={`Base ${fmt(base)}${d ? ` · equipment & effects ${d > 0 ? '+' : ''}${fmt(d)}` : ''}`}>{STAT_HELP[k]}</TipCard>)}>
      <span class="stat-k">{STAT_LABELS[k]}</span>
      <span class="stat-v">{extra ?? fmt(eff)}{k === 'armor' ? '%' : ''}</span>
    </div>
  );
}

const STAT_HELP: Record<keyof UnitStats, string> = {
  maxHp: 'Hit points. The unit dies at 0.',
  str: 'Melee damage: +1 per strike for every 2 points.',
  dex: 'Ranged damage: +1 per strike for every 2 points.',
  int: 'Damage of magic attacks (staff, wand: +1 per 2 points) and spell range from a Mage Tower (+1 per 3 points). Spell and Firebolt damage is fixed.',
  armor: 'Reduces damage from attacks and Volley by this percentage. Spells, Firebolt, poison and starvation ignore it.',
  mov: 'Movement points per turn.',
  vis: 'Vision radius in hexes.',
};

export function UnitPanel() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  // While an action animates, the panel shows the unit as the animation does (HP drops as blows land).
  const shown = store.shownUnit ? (x: number) => store.shownUnit!(x) : undefined;
  const id = selectedUnitId(s, ui, shown);
  const u = (id !== null ? shown?.(id) : undefined) ?? unitById(s, id);
  if (!u) return null;

  const viewer = viewerOf(s);
  const own = u.faction === viewer;
  const myTurn = isMyTurn(s, ui);
  const canAct = own && myTurn;
  const fd = FACTIONS[u.faction];
  const stats = safe(() => effectiveStats(s, u), u.base);
  const attacks = safe(() => getAttackDefs(u), fallbackAttacks(u));
  const body = safe(() => bodyVariant(u), u.isLeader ? 'leader' : 'commoner');
  const mounted = safe(() => isMounted(u), !!u.equipment.mount);
  const toNext = xpToNext(u.level);
  const maxed = u.level >= MAX_LEVEL;
  const segs = xpSegments(u, toNext);
  const here = buildingAtHex(s, u.pos);
  const hereOwn = here && here.owner === viewer && isComplete(here) ? here : null;
  const hereDef = hereOwn ? BUILDINGS[hereOwn.type] : null;
  const onArmory = !!hereDef?.armory;
  const name = u.monster ? (u.name || MONSTERS[u.monster]?.name) : u.name;
  const duty = own ? safe(() => dutyOf(s, u), null) : null;
  const skipped = ui.skippedUnits.includes(u.id);

  const xpTip = () => (
    <TipCard title={maxed ? `Level ${u.level} — maximum` : `Experience ${fmt(u.xp)} / ${toNext}`} sub="XP earned this level (lifetime in brackets)">
      <table class="breakdown">
        <tbody>
          {XP_CATS.filter((c) => c !== 'leader' || u.isLeader).map((c) => (
            <tr key={c}>
              <td><span class={`xp-dot xp-${c}`} /> {XP_NAMES[c]}</td>
              <td>{fmt(u.levelXpByCat?.[c] ?? 0)} <span class="t-dim">({fmt(u.xpByCat?.[c] ?? 0)})</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="tip-note t-dim">Level-up choices favour the kinds of XP earned this level.{u.isLeader ? ' Leaders gain 30% more XP.' : ''}</div>
    </TipCard>
  );

  const effs = Object.entries(u.efficiency ?? {}).filter(([, v]) => v != null && Math.abs(v - 1) > 1e-6);
  const learned = u.actives.filter((a) => ACTIVES[a]?.cooldown === 0);
  // Own units use their activated skills from the command bar; another house's are shown here (read only).
  const foreignActives = own ? [] : u.actives.filter((a) => ACTIVES[a] && ACTIVES[a].cooldown > 0);
  const openSheet = () => store.openModal('unitsheet', { unit: u.id });

  return (
    <div class="unit-panel panel" style={{ '--fc': fd.color, '--fa': fd.accent } as Record<string, string>}>
      <div class="up-head">
        <div class="up-portrait-wrap">
          <div class="up-portrait-btn" role="button" tabIndex={0} aria-label={`Details of ${name}`} onClick={openSheet}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openSheet(); } }}
            {...tip(<span>Details: stats, equipment, augments and experience <Kbd k="C" /></span>)}>
            <Portrait k={portraitKey(u, body)} name={name} color={fd.color} class="up-portrait" />
          </div>
          <span class="level-badge" {...tip(`Level ${u.level}`)}>{u.level}</span>
          {own && u.pendingLevelUps > 0 && (
            <button type="button" class="lu-badge" onClick={() => store.openModal('levelup', { unit: u.id })}
              {...tip(`Level-up reward waiting${u.pendingLevelUps > 1 ? ` (${u.pendingLevelUps})` : ''} — click to choose`)}>
              <Sym name="star" />{u.pendingLevelUps > 1 && <b>{u.pendingLevelUps}</b>}
            </button>
          )}
          {u.isLeader && <span class="leader-crown" {...tip('Leader — if they fall, the faction is lost')}><Sym name="castle" /></span>}
        </div>
        <div class="up-id">
          <div class={cls('up-name', name.length > 18 && 'long')} {...tip(name)}>{name}</div>
          <div class="up-role">{unitRole(u)}{mounted ? ' · mounted' : ''}</div>
          <div class="up-faction"><Emblem faction={u.faction} size={18} /><span>{fd.name}</span></div>
          <div class="up-status">
            {!own && <span class="pill pill-enemy">{u.faction === 'neutral' ? 'Hostile beast' : 'Enemy'}</span>}
            {u.poisoned && <span class="pill pill-bad" {...tip('Poisoned: loses 4 HP each turn until cured at a castle or shrine')}><Sym name="poison" />Poisoned</span>}
            {u.buffs?.map((b, i) => {
              const info = BUFF_INFO[b.id];
              return info ? <span key={i} class="pill pill-good" {...tip(`${info.text(b)} · ${b.turns} turn${b.turns === 1 ? '' : 's'} left`)}><Sym name={info.icon} />{info.name}</span> : null;
            })}
            {u.summonTurns != null && <span class="pill pill-magic" {...tip('Summoned: crumbles when the timer runs out')}><Sym name="hourglass" />{u.summonTurns}</span>}
            {own && u.acted && u.mp <= 0 && <span class="pill pill-dim">Done</span>}
            {u.order && (
              <span class="pill pill-order" {...tip(u.order === 'heal'
                ? `Standing order: rests here until fully healed (Tab passes it by). An enemy within ${HEAL_ORDER_ALERT} hexes or an attack ends it. Cancel it from the command bar (Y).`
                : 'Standing order: keeps watch here (Tab passes it by) until an enemy comes into sight or it is attacked. Cancel it from the command bar (V).')}>
                <Sym name={u.order === 'heal' ? 'heart' : 'eye'} />{ORDER_DUTY[u.order]}
              </span>
            )}
            {duty && !u.order && <span class="pill pill-work" {...tip('A standing job: left out of Tab and the idle count until you select it')}><Sym name="hammer" />{duty}</span>}
            {own && skipped && !duty && <span class="pill pill-dim" {...tip('Skipped this turn (X): left out of Tab and the idle count')}>Waiting</span>}
          </div>
        </div>
      </div>

      <div class="up-bars">
        <Bar kind="hp" value={u.hp} max={stats.maxHp} label={`${fmt(u.hp)} / ${fmt(stats.maxHp)}`}
          tipContent={`Hit points${stats.maxHp !== u.base.maxHp ? ` (base ${u.base.maxHp})` : ''}`} />
        <Bar kind="xp" value={u.xp} max={toNext} label={maxed ? 'MAX' : `${fmt(u.xp)} / ${toNext}`} tipContent={xpTip}>
          {maxed ? <div class="bar-fill xp-max" style={{ width: '100%' }} />
            : segs.map((g) => <div key={g.cat} class={`bar-seg xp-${g.cat}`} style={{ width: `${g.frac * 100}%` }} />)}
        </Bar>
      </div>

      <div class="up-stats">
        <StatCell k="str" eff={stats.str} base={u.base.str} />
        <StatCell k="dex" eff={stats.dex} base={u.base.dex} />
        <StatCell k="int" eff={stats.int} base={u.base.int} />
        <StatCell k="armor" eff={stats.armor} base={u.base.armor} />
        <StatCell k="mov" eff={stats.mov} base={u.base.mov} extra={own ? `${fmt(u.mp)}/${fmt(stats.mov)}` : undefined} />
        <StatCell k="vis" eff={stats.vis} base={u.base.vis} />
      </div>

      {!u.monster && (
        <div class="up-equip">
          {SLOTS.map(({ slot, label, empty }) => {
            const it = u.equipment[slot];
            const def = it ? ITEMS[it] : null;
            const blocked = slot === 'off' && !it && u.equipment.main && ITEMS[u.equipment.main].twoHanded;
            const clickable = canAct && onArmory;
            return (
              <button type="button" key={slot} class={cls('slot', !def && 'empty', blocked && 'blocked', clickable && 'clickable')}
                onClick={clickable ? () => store.openModal('equip', { unit: u.id }) : undefined}
                {...tip(def
                  ? <TipCard icon={<Icon k={def.icon} size={36} />} title={def.name} sub={label}>{def.description}{clickable ? <div class="tip-note t-gold">Click to change equipment</div> : null}</TipCard>
                  : <TipCard title={`${label}: empty`}>{blocked ? 'Blocked by a two-handed weapon.' : clickable ? 'Click to equip an item from the stockpile.' : 'Equip items at your castle, forge, house, training ground or mage tower.'}</TipCard>)}>
                {def ? <Icon k={def.icon} size={34} /> : <span class="slot-empty"><Sym name={empty} /></span>}
              </button>
            );
          })}
        </div>
      )}

      <div class="up-attacks">
        {attacks.map((a, i) => {
          const dmg = displayDamage(u, a, stats, attackMult(s, u, a));
          return (
            <div class={cls('attack-row', `atk-${a.kind}`)} key={i}
              {...tip(<TipCard title={a.name} sub={`${a.kind[0].toUpperCase() + a.kind.slice(1)} attack · range ${a.range}`}>
                {fmt(dmg)} damage per strike before the target's armor, {a.strikes} strike{a.strikes === 1 ? '' : 's'}.
                {a.kind === 'magic' && ' Magic always has a 70% chance to hit.'}
                {a.firststrike && ' First strike: always strikes first, even when defending.'}
                {a.vsMounted && ` ×${a.vsMounted} damage against mounted units.`}
              </TipCard>)}>
              <KindIcon kind={a.kind} />
              <span class="atk-name">{a.name}</span>
              <span class="atk-dmg">{fmt(dmg)}<small>×</small>{a.strikes}</span>
              <span class="atk-range">{a.range > 1 ? `R${a.range}` : 'melee'}</span>
              {a.firststrike && <span class="atk-tag" {...tip('First strike')}>FS</span>}
            </div>
          );
        })}
      </div>

      {(u.passives.length > 0 || learned.length > 0 || foreignActives.length > 0 || effs.length > 0) && (
        <div class="up-skills">
          <div class="passives">
            {foreignActives.map((a) => {
              const def = ACTIVES[a];
              const cd = u.cooldowns?.[a] ?? 0;
              return (
                <span class="passive learned" key={a} {...tip(<TipCard icon={<Icon k={def.icon} size={32} />} title={def.name}
                  sub={`Active · cooldown ${def.cooldown}${cd > 0 ? ` · ready in ${cd}` : ' · ready'}`}>{def.description}</TipCard>)}>
                  <Icon k={def.icon} size={22} dim={cd > 0} />
                </span>
              );
            })}
            {u.passives.map((p) => {
              const def = PASSIVES[p];
              return def ? (
                <span class="passive" key={p} {...tip(<TipCard icon={<Icon k={def.icon} size={32} />} title={def.name} sub="Passive">{def.description}</TipCard>)}>
                  <Icon k={def.icon} size={22} />
                </span>
              ) : null;
            })}
            {learned.map((a) => {
              const def = ACTIVES[a];
              return (
                <span class="passive learned" key={a} {...tip(<TipCard icon={<Icon k={def.icon} size={32} />} title={def.name} sub="Learned">{def.description}</TipCard>)}>
                  <Icon k={def.icon} size={22} />
                </span>
              );
            })}
            {effs.map(([k, v]) => (
              <span class="eff-chip" key={k} {...tip(`${EFF_NAMES[k] ?? k} efficiency ×${v!.toFixed(2).replace(/0$/, '')} (${v! >= 1 ? '+' : ''}${Math.round((v! - 1) * 100)}%)`)}>
                {EFF_NAMES[k] ?? k} <b>×{v!.toFixed(2).replace(/0$/, '')}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
