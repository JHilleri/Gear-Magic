// Level-up choice: three option cards drawn from the XP the unit earned this level.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SkillOptionDef, Unit, XpCategory } from '../../core/types';
import { FACTIONS } from '../../data/factions';
import { ACTIVES, LEVEL_OPTION_BY_ID, PASSIVES } from '../../data/skills';
import { augmentRank, augmentText, rankedName, type AugmentId } from '../../data/ranks';
import { bodyVariant } from '../../sim/units';
import { Btn } from '../common';
import { act, useUi } from '../ctx';
import { Icon, Portrait } from '../icons';
import { tip } from '../tooltip';
import { cls, fmt, isMyTurn, portraitKey, safe, selectedUnitId, unitById, unitRole, unitsOwned, viewerOf, XP_CATS, XP_NAMES } from '../util';
import { Modal } from './Modal';

/**
 * The cards only take a pick this long after an offer appears (it may open by itself, under a
 * cursor busy clicking the map): covers the card-rise animation (0.45 s + up to 0.18 s stagger).
 */
export const LEVELUP_ARM_MS = 650;

const KIND_LABEL: Record<SkillOptionDef['kind'], string> = { stat: 'Attribute', efficiency: 'Efficiency', passive: 'Passive', active: 'Active skill' };

export function optionIcon(o: SkillOptionDef): string {
  if (o.kind === 'passive' && o.passive) return PASSIVES[o.passive]?.icon ?? o.icon;
  if (o.kind === 'active' && o.active) return ACTIVES[o.active]?.icon ?? o.icon;
  return o.icon;
}

/** The augment an option teaches, if it is a passive or an active skill. */
const augmentOf = (o: SkillOptionDef): AugmentId | undefined => (o.kind === 'passive' ? o.passive : o.kind === 'active' ? o.active : undefined);

/** The rank `u` would reach by taking `o` (1: learns it; 2+: an upgrade of an augment it has). */
function nextRank(o: SkillOptionDef, u: Unit): number {
  const id = augmentOf(o);
  return id ? augmentRank(u, id) + 1 : 1;
}

/** The option's name; an augment the unit already has names the rank it would reach ("Firebolt II"). */
function optionName(o: SkillOptionDef, u: Unit): string {
  return augmentOf(o) ? rankedName(o.name, nextRank(o, u)) : o.name;
}

/** What the option gives: for an augment, its effect at the rank it would reach. */
function optionDetail(o: SkillOptionDef, u: Unit): string {
  const id = augmentOf(o);
  if (!id) return o.description;
  const text = augmentText(id, nextRank(o, u));
  if (o.kind === 'active' && o.active) {
    const a = ACTIVES[o.active];
    if (a && a.cooldown > 0) return `${text} Cooldown ${a.cooldown} turns.`;
  }
  return text;
}

function pickUnit(s: NonNullable<ReturnType<typeof useUi>['store']['state']>, ui: ReturnType<typeof useUi>['store']['ui']): Unit | undefined {
  const f = viewerOf(s);
  const cands = [unitById(s, ui.levelUpUnit), unitById(s, selectedUnitId(s, ui))];
  for (const u of cands) if (u && u.faction === f && u.pendingLevelUps > 0) return u;
  return unitsOwned(s, f).find((u) => u.pendingLevelUps > 0);
}

export function LevelUpModal() {
  const { store } = useUi();
  const s = store.state!;
  const u = pickUnit(s, store.ui);
  const offerKey = u ? `${u.id}:${u.pendingLevelUps}:${(u.levelUpOptions?.[0] ?? []).join(',')}` : '';
  // Re-armed for every offer (the next queued one swaps in under the same cursor after a pick).
  const [armed, setArmed] = useState(false);
  const pressRef = useRef<string | null>(null);
  const pickingRef = useRef(false);
  useEffect(() => {
    setArmed(false);
    pressRef.current = null;
    pickingRef.current = false;
    const t = window.setTimeout(() => setArmed(true), LEVELUP_ARM_MS);
    return () => window.clearTimeout(t);
  }, [offerKey]);
  if (!u) {
    return <Modal size="sm" title="Level up" onClose={() => store.closeModal()}><div class="empty-note">No unit is waiting for a level-up choice.</div></Modal>;
  }
  const fd = FACTIONS[u.faction];
  const my = isMyTurn(s, store.ui);
  const ids = u.levelUpOptions?.[0] ?? [];
  const options = ids.map((id) => LEVEL_OPTION_BY_ID[id]).filter(Boolean);
  const reaching = u.level - u.pendingLevelUps + 1;
  // The XP mix of the level this offer was rolled for (levelXpByCat already tallies the next one).
  const mix = u.levelUpXp?.[0] ?? u.levelXpByCat;
  const totalXp = XP_CATS.reduce((a, c) => a + (mix?.[c] ?? 0), 0);
  const body = safe(() => bodyVariant(u), 'commoner');

  const choose = async (opt: string) => {
    if (pickingRef.current) return; // a double click must not also take the next queued offer
    pickingRef.current = true;
    const r = await act(store, { type: 'levelup', unit: u.id, option: opt });
    pickingRef.current = false;
    if (!r.ok) return;
    // The store moves on to the next pending choice itself; this only guarantees the sheet
    // closes once nothing is left (the modal otherwise picks the next pending unit).
    const st = store.state;
    if (st && store.ui.modal === 'levelup' && !unitsOwned(st, viewerOf(st)).some((x) => x.pendingLevelUps > 0)) store.closeModal();
  };

  const catWeight = (cats: XpCategory[]) => (totalXp > 0 ? cats.reduce((a, c) => a + (mix?.[c] ?? 0), 0) / totalXp : 0);

  return (
    <Modal size="lg" class="levelup-modal" title={`${u.name} reached level ${reaching}`} onClose={() => store.closeModal()}
      icon={<Portrait k={portraitKey(u, body)} name={u.name} color={fd.color} class="lu-portrait" />}
      sub={<span>{unitRole(u)} · +4 max HP · choose one reward{u.pendingLevelUps > 1 ? ` (${u.pendingLevelUps} level-ups waiting)` : ''}</span>}
      footer={<Btn onClick={() => store.closeModal()} title="The choice waits by End Turn and on the unit panel; it will not reopen by itself">Decide later</Btn>}>
      <div class="lu-xp">
        <span class="lu-xp-title">Experience this level</span>
        <div class="lu-xp-bar">
          {XP_CATS.map((c) => {
            const v = mix?.[c] ?? 0;
            return v > 0 ? <span key={c} class={`xp-${c}`} style={{ flexGrow: v }} {...tip(`${XP_NAMES[c]}: ${fmt(v)} XP`)} /> : null;
          })}
          {totalXp <= 0 && <span class="xp-none" style={{ flexGrow: 1 }} />}
        </div>
        <div class="lu-xp-legend">
          {XP_CATS.filter((c) => (mix?.[c] ?? 0) > 0).map((c) => (
            <span key={c}><i class={`xp-dot xp-${c}`} />{XP_NAMES[c]} <b>{fmt(mix[c])}</b></span>
          ))}
        </div>
      </div>
      <div class={cls('lu-options', !armed && 'is-arming')}>
        {options.length === 0 && <div class="empty-note">No options were rolled for this level.</div>}
        {options.map((o, i) => (
          <button type="button" key={o.id} class={cls('lu-card', `kind-${o.kind}`, !my && 'is-disabled')} aria-disabled={!my || !armed} style={{ animationDelay: `${i * 90}ms` }}
            onPointerDown={() => { pressRef.current = armed ? o.id : null; }}
            onClick={my ? (e: MouseEvent) => {
              // Only a press that started on this card after the offer settled (keyboard: detail 0).
              const keyboard = e.detail === 0;
              if (!armed || (!keyboard && pressRef.current !== o.id)) return;
              pressRef.current = null;
              void choose(o.id);
            } : undefined} {...tip(!my ? <span class="t-bad">Not your turn</span> : null)}>
            <span class="lu-kind">{nextRank(o, u) > 1 ? `${KIND_LABEL[o.kind]} · upgrade` : KIND_LABEL[o.kind]}</span>
            <span class="lu-icon"><Icon k={optionIcon(o)} size={76} /></span>
            <span class="lu-name">{optionName(o, u)}</span>
            <span class="lu-desc">{optionDetail(o, u)}</span>
            <span class="lu-cats">
              {o.categories.map((c) => <span key={c} class={cls('lu-cat', `xp-${c}`)}>{XP_NAMES[c]}</span>)}
              {catWeight(o.categories) > 0 && <span class="lu-why t-dim">{Math.round(catWeight(o.categories) * 100)}% of your XP</span>}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
