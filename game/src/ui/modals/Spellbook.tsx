// Spellbook: every spell, known ones castable from Mage Towers.
import type { SpellId } from '../../core/types';
import { TECH_LIST } from '../../data/research';
import { SPELL_LIST } from '../../data/spells';
import { knownSpells, manaCap, towerRange } from '../../sim/spells';
import { Bar } from '../common';
import { useUi } from '../ctx';
import { Icon, ResIcon, Sym } from '../icons';
import { tip } from '../tooltip';
import { buildingsOwned, cls, fmt, isComplete, isMyTurn, safe, unitAtHex, viewerOf } from '../util';
import { Modal } from './Modal';

const TARGET_TEXT: Record<string, string> = { ally: 'One ally', enemy: 'Enemy', any: 'Area', empty: 'Empty hex' };

export function SpellbookModal() {
  const { store } = useUi();
  const s = store.state!;
  const f = viewerOf(s);
  const fs = s.factions[f];
  const fallbackKnown = SPELL_LIST.filter((sp) => TECH_LIST.some((t) => t.unlocksSpell === sp.id && fs.techs.includes(t.id))).map((sp) => sp.id);
  const known = new Set<SpellId>(safe(() => knownSpells(s, f), fallbackKnown));
  const cap = safe(() => manaCap(s, f), 100);
  const towers = buildingsOwned(s, f).filter((b) => b.type === 'magetower' && isComplete(b));
  const building = buildingsOwned(s, f).some((b) => b.type === 'magetower' && !isComplete(b));
  const manned = towers.filter((t) => { const u = unitAtHex(s, t.pos); return u && u.faction === f; }).length;
  const my = isMyTurn(s, store.ui);

  const cast = (id: SpellId) => {
    store.beginCast(id);
    if (store.ui.modal === 'spellbook') store.closeModal();
  };

  return (
    <Modal size="lg" title="Spellbook" icon={<Icon k="resources/mana.png" size={40} />} onClose={() => store.closeModal()}
      sub={<span>{known.size} of {SPELL_LIST.length} spells known · {towers.length} Mage Tower{towers.length === 1 ? '' : 's'}{towers.length ? ` (${manned} manned)` : ''}</span>}>
      <div class="spell-mana">
        <ResIcon r="mana" size={24} />
        <Bar kind="mana" value={fs.resources.mana} max={cap} label={`${fmt(Math.floor(fs.resources.mana))} / ${fmt(cap)} mana`} />
      </div>
      {towers.length === 0 && (
        <div class="notice warn">
          <Sym name="magetower" />
          <span>{building ? 'Your Mage Tower is still under construction.' : 'Spells are channelled through a Mage Tower. Research Arcana and build one to cast.'}</span>
        </div>
      )}
      {towers.length > 0 && <div class="notice"><Sym name="help" /><span>Spell range is measured from your towers. A unit standing in a tower extends its range by 1 per 3 Intellect.</span></div>}
      <div class="spell-grid">
        {SPELL_LIST.map((sp) => {
          const isKnown = known.has(sp.id);
          const cd = fs.spellCooldowns?.[sp.id] ?? 0;
          const tech = TECH_LIST.find((t) => t.unlocksSpell === sp.id);
          // A channeller's Intellect lengthens a tower's reach: show the best one.
          const reach = towers.reduce((m, t) => Math.max(m, safe(() => towerRange(s, t.id, sp.id), sp.range)), 0);
          const reason = !isKnown ? `Research ${tech?.name ?? 'it'} to learn this spell`
            : towers.length === 0 ? 'Needs a Mage Tower'
              : cd > 0 ? `Recharging: ${cd} turn${cd === 1 ? '' : 's'}`
                : fs.resources.mana < sp.mana ? `Needs ${sp.mana} mana`
                  : !my ? 'Not your turn' : null;
          return (
            <button type="button" key={sp.id} class={cls('spell-card', !isKnown && 'unknown', reason && 'is-disabled')} aria-disabled={!!reason}
              onClick={reason ? undefined : () => cast(sp.id)} {...tip(reason ? <span class="t-bad">{reason}</span> : 'Click, then choose a target on the map')}>
              <div class="sc-icon">
                <Icon k={sp.icon} size={56} dim={!isKnown} />
                {cd > 0 && isKnown && <span class="cd-overlay" style={{ '--cd': `${(cd / sp.cooldown) * 360}deg` } as Record<string, string>}><b>{cd}</b></span>}
              </div>
              <div class="sc-main">
                <div class="sc-name">{sp.name}{!isKnown && <Sym name="lock" />}</div>
                <div class="sc-meta">
                  <span class={cls('sc-mana', isKnown && fs.resources.mana < sp.mana && 't-bad')}><ResIcon r="mana" size={14} />{sp.mana}</span>
                  <span {...tip(reach > sp.range ? `Base range ${sp.range}; your best channelled tower reaches ${reach}` : 'Range from a Mage Tower (a unit standing in it adds 1 per 3 Intellect)')}>
                    Range {sp.range}{reach > sp.range ? <b class="t-good"> ({reach} with channeller)</b> : null}
                  </span>
                  {sp.radius > 0 && <span {...tip('Area radius around the target')}>Radius {sp.radius}</span>}
                  <span {...tip('Faction-wide cooldown in turns')}>CD {sp.cooldown}</span>
                  <span>{TARGET_TEXT[sp.target]}</span>
                </div>
                <div class="sc-desc">{sp.description}</div>
                {reason && <div class="sc-reason">{reason}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
