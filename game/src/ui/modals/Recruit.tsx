// Recruit modal: preset cards for the chosen recruit site.
import type { PresetId, ResourceCost, UnitStats } from '../../core/types';
import { aOrAn } from '../../core/text';
import { BUILDINGS } from '../../data/buildings';
import { FACTIONS } from '../../data/factions';
import { ITEMS } from '../../data/items';
import { COMMONER_COST, COMMONER_STATS, PRESETS } from '../../data/presets';
import { recruitOptions } from '../../sim/actions';
import { presetCost } from '../../sim/economy';
import { techDamageMult } from '../../sim/research';
import { Cost, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, Portrait } from '../icons';
import { tip } from '../tooltip';
import { addCost, buildingById, cls, isMyTurn, presetPortraitKeys, safe, viewerOf } from '../util';
import { itemSummary } from './Forge';
import { Modal } from './Modal';

function fallbackCost(p: PresetId): ResourceCost {
  return PRESETS[p].items.reduce((acc, it) => addCost(acc, ITEMS[it].cost), { ...COMMONER_COST });
}

export function RecruitModal() {
  const { store } = useUi();
  const s = store.state!;
  const f = viewerOf(s);
  const fs = s.factions[f];
  const fd = FACTIONS[f];
  const site = buildingById(s, store.ui.recruitSite);
  const def = site ? BUILDINGS[site.type] : null;
  const my = isMyTurn(s, store.ui);

  if (!site || !def?.recruits) {
    return (
      <Modal size="sm" title="Recruit" onClose={() => store.closeModal()}>
        <div class="empty-note">Select one of your castles, houses, training grounds or mage towers to recruit units.</div>
      </Modal>
    );
  }
  const opts = safe(() => recruitOptions(s, site.id), def.recruits.map((p) => ({ preset: p, error: null as string | null })));
  const recruit = async (p: PresetId) => {
    const r = await act(store, { type: 'recruit', site: site.id, preset: p });
    if (r.ok && store.ui.modal === 'recruit') store.closeModal();
  };
  const upkeep = fd.foodUpkeep;

  return (
    <Modal size="lg" title={`Recruit at ${def.name}`} icon={<Icon k={def.icon} size={40} />} onClose={() => store.closeModal()}
      sub={<span>{site.recruitedThisTurn ? <span class="t-bad">Already recruited here this turn</span> : 'One recruit per site per turn'} · Recruits cannot move on the turn they arrive · Upkeep {upkeep} food/turn each</span>}>
      <div class="preset-grid">
        {opts.map(({ preset, error }) => {
          const p = PRESETS[preset];
          const cost = safe(() => presetCost(preset), fallbackCost(preset));
          const err = !my ? 'Not your turn' : error;
          const main = p.items.map((i) => ITEMS[i]).find((d) => d.attack);
          // The recruit's real numbers: commoner + house traits + items, damage as the unit panel shows it.
          const stat = (k: keyof UnitStats) => COMMONER_STATS[k] + (fd.statMods?.[k] ?? 0) + p.items.reduce((a, i) => a + (ITEMS[i].stats?.[k] ?? 0), 0);
          const armor = stat('armor');
          const block = stat('block');
          const mov = stat('mov');
          const atk = main?.attack;
          const dmg = atk ? (() => {
            const st = atk.kind === 'melee' ? stat('str') : atk.kind === 'ranged' ? stat('dex') : stat('int');
            let mult = safe(() => techDamageMult(s, f), 1);
            mult *= atk.kind === 'melee' ? fd.meleeMult ?? 1 : atk.kind === 'ranged' ? fd.rangedMult ?? 1 : fd.magicMult ?? 1;
            if (atk.kind === 'magic') for (const i of p.items) mult *= ITEMS[i].magicDamageMult ?? 1;
            return Math.max(1, Math.round((atk.base + Math.floor(Math.max(0, st) / 2)) * mult));
          })() : 0;
          return (
            <button type="button" key={preset} class={cls('preset-card', err && 'is-disabled')} aria-disabled={!!err}
              onClick={err ? undefined : () => void recruit(preset)} {...tip(err ? <span class="t-bad">{err}</span> : `Recruit ${aOrAn(p.name)}`)}>
              <div class="pc-portrait">
                <Portrait k={presetPortraitKeys(fd.race, preset)} name={p.name} color={fd.color} sym={p.items[0] ?? 'recruit'} />
              </div>
              <div class="pc-main">
                <div class="pc-name">{p.name}</div>
                <div class="pc-items">
                  {p.items.length === 0 && <span class="t-dim">No equipment</span>}
                  {p.items.map((i) => (
                    <span key={i} class="pc-item" {...tip(<TipCard icon={<Icon k={ITEMS[i].icon} size={36} />} title={ITEMS[i].name} sub={itemSummary(ITEMS[i])}>{ITEMS[i].description}</TipCard>)}>
                      <Icon k={ITEMS[i].icon} size={30} />
                    </span>
                  ))}
                </div>
                <div class="pc-desc">{p.description}</div>
                <div class="pc-stats">
                  <span {...tip('Damage per strike before the target\'s block and armor × strikes')}>{atk ? `${atk.name} ${dmg}×${atk.strikes}` : 'Fists 3×2'}</span>
                  <span {...tip('Block: damage taken off every strike that hits · Armor: share of the rest taken off')}>Block {block} · Armor {armor}%</span>
                  <span>Move {mov}</span>
                </div>
                <div class="pc-foot">
                  <Cost cost={cost} have={fs.resources} />
                  {err && <span class="pc-err">{err}</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
