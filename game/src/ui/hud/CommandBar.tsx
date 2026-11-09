// Bottom command bar: the selected unit's commands as square icon buttons with hotkey badges —
// attack and activated skills, standing orders (rest, sentry, skip), the work its hex offers
// (build, upgrade, recruit, equip, forge, level-up) and the details sheet. The controller maps
// the same keys (game/interaction.ts keyToCommand), so a badge is the key that works. A unit that
// is not the player's gets the Details button only.
import type { ComponentChildren } from 'preact';
import type { ActiveId, Unit, UnitOrder } from '../../core/types';
import { BUILDINGS } from '../../data/buildings';
import { ACTIVES } from '../../data/skills';
import { attackTargets } from '../../sim/actions';
import { canUpgrade } from '../../sim/economy';
import { canGiveOrder, HEAL_ORDER_ALERT, ORDER_NAMES, orderWakeWarning } from '../../sim/orders';
import { canUseSkill, NO_SKILL_TARGET, skillBlocker, skillTargets } from '../../sim/skills';
import { canBuildWith, mainAttackKind } from '../../sim/units';
import { barSkills, SKILL_HOTKEYS } from '../../game/interaction';
import type { GameStore } from '../../game/store';
import { Kbd, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, Sym } from '../icons';
import { tip } from '../tooltip';
import { buildingAtHex, cls, isComplete, isMyTurn, safe, selectedUnitId, unitById, viewerOf, warOver } from '../util';
import { UpgradeDetails } from './UpgradeInfo';
import '../commandbar.css';

interface CmdProps {
  label: string;
  /** Glyph name (Sym), unless `img` (an icon image key, e.g. a skill's) is given. */
  sym?: string;
  img?: string;
  hotkey?: string;
  /** Tooltip title (the label is often shorter). */
  title: string;
  sub?: string;
  desc?: ComponentChildren;
  /** Why the command cannot be given now: greys the button out, shown in red. */
  reason?: string | null;
  /** A caveat that does not block the button (shown in amber). */
  warn?: string | null;
  /** Pressed / lit: an active order or an armed targeting mode; the click cancels it. */
  on?: boolean;
  onNote?: string;
  glow?: boolean;
  count?: number;
  cooldown?: { left: number; total: number };
  onClick: () => void;
}

/** Labels this long (with a space) take two lines under a smaller icon ("Power / Strike"). */
const ONE_LINE_CHARS = 9;
/** More buttons than this and the bar goes dense (narrower buttons), so it stays one row at 1600 px. */
const DENSE_AFTER = 12;

function Cmd(p: CmdProps) {
  const disabled = !!p.reason;
  const twoLine = p.label.length > ONE_LINE_CHARS && p.label.includes(' ');
  const body = () => (
    <TipCard title={<>{p.title}{p.hotkey && <Kbd k={p.hotkey} />}</>} sub={p.sub}
      icon={p.img ? <Icon k={p.img} size={36} /> : undefined}>
      {p.desc}
      {p.on && p.onNote && <div class="tip-note t-gold">{p.onNote}</div>}
      {p.warn && !p.reason && <div class="tip-note t-warn">{p.warn}</div>}
      {p.reason && <div class="tip-note t-bad">{p.reason}</div>}
    </TipCard>
  );
  return (
    // No native `disabled`: it would swallow the hover that explains why (as Btn does).
    <button type="button" class={cls('cb-btn', disabled && 'is-disabled', p.on && 'on', p.glow && !disabled && 'cb-glow', twoLine && 'two-line', p.warn && !disabled && 'has-warn')}
      aria-disabled={disabled} aria-pressed={p.on ? true : undefined} aria-label={p.title}
      onClick={disabled ? undefined : p.onClick} {...tip(body, 'top')}>
      <span class="cb-icon">
        {p.img ? <Icon k={p.img} size={30} dim={disabled} /> : <Sym name={p.sym ?? 'help'} />}
        {p.cooldown && p.cooldown.left > 0 && (
          <span class="cd-overlay" style={{ '--cd': `${(p.cooldown.left / Math.max(1, p.cooldown.total)) * 360}deg` } as Record<string, string>}>
            <b>{p.cooldown.left}</b>
          </span>
        )}
      </span>
      <span class="cb-label">{p.label}</span>
      {p.hotkey && <kbd class="cb-key">{p.hotkey}</kbd>}
      {p.count != null && p.count > 1 && <b class="cb-count">{p.count}</b>}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="cb-group" role="group" aria-label={label}>
      <span class="cb-group-label">{label}</span>
      <div class="cb-row">{children}</div>
    </div>
  );
}

/** Enemies the unit can attack this turn: the controller's plan (moving first included), else from where it stands. */
function attackableCount(store: GameStore, u: Unit): number {
  const s = store.state!;
  if (store.attackableTargets) return safe(() => store.attackableTargets!(u.id).length, 0);
  return safe(() => attackTargets(s, u).length, 0);
}

export function CommandBar() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const u = unitById(s, selectedUnitId(s, ui));
  if (!u || warOver(s, ui)) return null;
  const viewer = viewerOf(s);
  const own = u.faction === viewer && !s.gameOver;
  const details = (
    <Group label="Info">
      <Cmd label="Details" sym="sheet" hotkey="C" title="Details"
        desc={<>Status, stats and where they come from, equipment, every augment and the experience of {u.name}. <Kbd k="I" /> works too.</>}
        onClick={() => store.openModal('unitsheet', { unit: u.id })} />
    </Group>
  );
  if (!own) {
    return (
      <div class="command-bar-wrap">
        <div class="command-bar panel cb-readonly" role="toolbar" aria-label={`${u.name}`}>{details}</div>
      </div>
    );
  }

  const my = isMyTurn(s, ui);
  // (busy without an enemy playing: the player's own action is still animating)
  const notNow = my ? null : ui.busy && !ui.aiThinking ? 'Wait for the action to finish' : 'Not your turn';
  const mode = ui.mode;
  const name = u.name;

  // ── combat ──
  const kind = safe(() => mainAttackKind(u), 'melee');
  const attackOn = mode.kind === 'attack' && mode.unit === u.id;
  const targets = my && !u.acted ? attackableCount(store, u) : 0;
  const attackReason = notNow ?? (u.acted ? `${name} has already acted this turn` : targets === 0 ? 'No enemy in reach this turn' : null);
  const skills = barSkills(u.actives, (a) => ACTIVES[a]?.cooldown);
  const skillReason = (a: ActiveId): string | null => {
    const def = ACTIVES[a];
    const cd = u.cooldowns?.[a] ?? 0;
    if (notNow) return notNow;
    if (cd > 0) return `Ready in ${cd} turn${cd === 1 ? '' : 's'}`;
    if (u.acted) return `${name} has already acted this turn`;
    if (def.target === 'none') return safe(() => canUseSkill(s, u, a), null);
    // (the same words the hotkey's toast uses: controller.beginSkill)
    const blocker = safe(() => skillBlocker(s, u, a), null);
    if (blocker) return blocker;
    if (safe(() => skillTargets(s, u, a), [{ q: 0, r: 0 }]).length === 0) return NO_SKILL_TARGET;
    return null;
  };

  // ── orders ──
  const orderReason = (o: UnitOrder): string | null => (u.order === o ? notNow : notNow ?? safe(() => canGiveOrder(s, u, o), null));
  // A hostile already inside the wake-up range ends a new order at the very next turn start.
  const orderWarn = (o: UnitOrder): string | null => (u.order === o ? null : safe(() => orderWakeWarning(s, u, o), null));
  const toggleOrder = (o: UnitOrder) => store.giveOrder(u.id, u.order === o ? null : o);
  const skipped = ui.skippedUnits.includes(u.id);
  const skipReason = notNow ?? (skipped ? `${name} already waits this turn` : u.acted && u.mp <= 0 ? `${name} is done for this turn` : null);

  // ── work: what the hex it stands on offers ──
  const hasTools = safe(() => canBuildWith(u), false);
  const canBuild = hasTools || u.isLeader;   // the leader may always build (move) the castle
  const here = buildingAtHex(s, u.pos);
  const hereOwn = here && here.owner === viewer && isComplete(here) ? here : null;
  const hereDef = hereOwn ? BUILDINGS[hereOwn.type] : null;
  const upgradeReason = hasTools && hereOwn ? notNow ?? safe(() => canUpgrade(s, u), 'Cannot upgrade') : null;
  const work: ComponentChildren[] = [];
  if (canBuild) {
    work.push(<Cmd key="build" label="Build" sym="hammer" hotkey="B" title="Build" reason={notNow}
      warn={u.acted ? `${name} has already acted this turn` : null}
      desc="Construct a building on this hex (the menu says what each building needs)."
      onClick={() => store.openModal('build', { unit: u.id })} />);
  }
  if (hasTools && hereOwn && hereDef) {
    const more = !hereOwn.upgrading && hereOwn.level < hereDef.maxLevel;
    work.push(<Cmd key="upgrade" label="Upgrade" sym="upgrade" hotkey="U" title={more ? `Upgrade ${hereDef.name} to level ${hereOwn.level + 1}` : `Upgrade ${hereDef.name}`}
      reason={upgradeReason} desc={more ? <UpgradeDetails s={s} b={hereOwn} have={s.factions[viewer]?.resources} builder={u} stationed={u} /> : null}
      onClick={() => void act(store, { type: 'upgrade', unit: u.id })} />);
  }
  if (hereOwn && hereDef?.recruits) {
    work.push(<Cmd key="recruit" label="Recruit" sym="recruit" title={`Recruit at this ${hereDef.name}`} reason={notNow}
      warn={hereOwn.recruitedThisTurn ? 'Already recruited here this turn' : null}
      desc="Train new troops here; they appear on this hex or next to it."
      onClick={() => store.openModal('recruit', { site: hereOwn.id })} />);
  }
  if (hereDef?.armory && !u.monster) {
    work.push(<Cmd key="equip" label="Equip" sym="equip" title="Equip" reason={notNow}
      desc={`Give ${name} items from the stockpile.`}
      onClick={() => store.openModal('equip', { unit: u.id })} />);
  }
  if (hereOwn?.type === 'forge') {
    work.push(<Cmd key="forge" label="Forge" sym="forge" hotkey="F" title="Forge" reason={notNow}
      desc="Craft equipment for the stockpile."
      onClick={() => store.openModal('forge', { site: hereOwn.id })} />);
  }
  if (u.pendingLevelUps > 0) {
    work.push(<Cmd key="levelup" label="Level up" sym="star" hotkey="L" title="Level up" glow count={u.pendingLevelUps}
      desc={`Choose ${u.pendingLevelUps > 1 ? `${u.pendingLevelUps} level-up rewards` : 'a level-up reward'} for ${name}.`}
      onClick={() => store.openModal('levelup', { unit: u.id })} />);
  }

  const orders = (
    <Group label="Orders">
      <Cmd label="Rest" sym="heart" hotkey="Y" title={ORDER_NAMES.heal} on={u.order === 'heal'} reason={orderReason('heal')} warn={orderWarn('heal')}
        onNote="Resting — click to give new orders"
        desc={<>Stay here until fully healed (a unit that neither moves nor fights rests for +2 HP a turn; castles and shrines heal more).
          Tab passes it by until then; an enemy within {HEAL_ORDER_ALERT} hexes or an attack wakes it.</>}
        onClick={() => toggleOrder('heal')} />
      <Cmd label="Sentry" sym="eye" hotkey="V" title={ORDER_NAMES.sentry} on={u.order === 'sentry'} reason={orderReason('sentry')} warn={orderWarn('sentry')}
        onNote="On sentry — click to give new orders"
        desc="Keep watch here: Tab passes the unit by until an enemy comes into its sight at the start of your turn, or it is attacked. A unit standing on a building still works it."
        onClick={() => toggleOrder('sentry')} />
      <Cmd label="Skip" sym="hourglass" hotkey="X" title="Skip this turn" on={skipped} reason={skipReason}
        desc="Leave this unit be for the rest of this turn: Tab and the idle count pass it by."
        onClick={() => store.skipUnit()} />
    </Group>
  );
  // Many buttons: narrower ones keep the bar to one row at 1600 px. The last group (Info) always
  // travels with the one before it, so a wrap never leaves the lone Details button on a row.
  const dense = 1 + skills.length + 3 + work.length + 1 > DENSE_AFTER;
  const tail = work.length > 0
    ? <>{orders}<div class="cb-pair"><Group label="Work">{work}</Group>{details}</div></>
    : <div class="cb-pair">{orders}{details}</div>;

  return (
    <div class="command-bar-wrap">
      <div class={cls('command-bar panel', dense && 'dense')} role="toolbar" aria-label={`${name}: commands`}>
        <Group label="Combat">
          <Cmd label="Attack" sym={kind} hotkey="T" title="Attack" reason={attackOn ? null : attackReason} on={attackOn}
            onNote="Choosing a target — click to cancel"
            desc={<>Pick an enemy to strike: the ones {name} can hit this turn, from here or after moving, are marked.
              Shift+click a target for the other attack kind.{targets > 0 && !attackOn ? <div class="tip-note t-dim">{targets} target{targets === 1 ? '' : 's'} in reach</div> : null}</>}
            onClick={() => (attackOn ? store.cancelMode() : store.beginAttack(u.id))} />
          {skills.map((a, i) => {
            const def = ACTIVES[a];
            const armed = mode.kind === 'skill' && mode.unit === u.id && mode.skill === a;
            return (
              <Cmd key={a} label={def.name} img={def.icon} hotkey={i < SKILL_HOTKEYS ? String(i + 1) : undefined}
                title={def.name} sub={`Active skill · cooldown ${def.cooldown}${def.range ? ` · range ${def.range}` : ''}`}
                desc={def.description} reason={armed ? null : skillReason(a)} on={armed} onNote="Choosing a target — click to cancel"
                cooldown={{ left: u.cooldowns?.[a] ?? 0, total: def.cooldown }}
                onClick={() => (armed ? store.cancelMode() : store.beginSkill(u.id, a))} />
            );
          })}
        </Group>
        {tail}
      </div>
    </div>
  );
}
