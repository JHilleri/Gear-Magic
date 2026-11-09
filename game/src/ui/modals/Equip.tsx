// Equip modal: the unit's five slots and the stockpile items it can wear, with stat deltas.
import type { EquipSlot, ItemId, UnitStats } from '../../core/types';
import { FACTIONS } from '../../data/factions';
import { ITEM_LIST, ITEMS } from '../../data/items';
import { equipOptions } from '../../sim/actions';
import { bodyVariant, canUnequip, effectiveStats } from '../../sim/units';
import { Btn, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, Portrait, Sym } from '../icons';
import { tip } from '../tooltip';
import {
  SLOT_EMPTY_SYM,
  cls, equipDelta, fmt, isMyTurn, portraitKey, safe, selectedUnitId, signed, STAT_LABELS, unitById, unitRole, viewerOf,
} from '../util';
import { itemSummary } from './Forge';
import { Modal } from './Modal';

const SLOT_NAMES: Record<EquipSlot, string> = { main: 'Main hand', off: 'Off hand', body: 'Body', trinket: 'Trinket', mount: 'Mount' };
const SLOT_ORDER: EquipSlot[] = ['main', 'off', 'body', 'trinket', 'mount'];

function DeltaList({ d }: { d: Partial<UnitStats> }) {
  const keys = Object.keys(d) as (keyof UnitStats)[];
  if (keys.length === 0) return <span class="t-dim">no stat change</span>;
  return (
    <span class="deltas">
      {keys.map((k) => <span key={k} class={d[k]! > 0 ? 't-good' : 't-bad'}>{signed(d[k]!)}{k === 'armor' ? '%' : ''} {STAT_LABELS[k]}</span>)}
    </span>
  );
}

export function EquipModal() {
  const { store } = useUi();
  const s = store.state!;
  const f = viewerOf(s);
  const u = unitById(s, selectedUnitId(s, store.ui));
  if (!u || u.faction !== f) {
    return <Modal size="sm" title="Equipment" onClose={() => store.closeModal()}><div class="empty-note">Select one of your units standing on an armory.</div></Modal>;
  }
  const fs = s.factions[f];
  const fd = FACTIONS[f];
  const my = isMyTurn(s, store.ui);
  const stats = safe(() => effectiveStats(s, u), u.base);
  const body = safe(() => bodyVariant(u), 'commoner');
  const fallbackOpts = ITEM_LIST.filter((d) => (fs.stockpile[d.id] ?? 0) > 0).map((d) => ({ item: d.id, count: fs.stockpile[d.id] ?? 0, error: null as string | null }));
  const opts = safe(() => equipOptions(s, u), fallbackOpts).filter((o) => o.count > 0);

  const equip = (item: ItemId) => void act(store, { type: 'equip', unit: u.id, item });
  const unequip = (slot: EquipSlot) => void act(store, { type: 'unequip', unit: u.id, slot });

  return (
    <Modal size="lg" title="Equipment" icon={<Icon k="items/shield.png" size={40} />} onClose={() => store.closeModal()}
      sub="Equipping is free and does not end the unit's turn. Removed items return to the stockpile.">
      <div class="equip-layout">
        <div class="equip-unit">
          <div class="eu-head">
            <Portrait k={portraitKey(u, body)} name={u.name} color={fd.color} class="eu-portrait" />
            <div>
              <div class="eu-name">{u.name}</div>
              <div class="t-dim">{unitRole(u)} · Level {u.level}</div>
              <div class="eu-stats">
                {(['maxHp', 'str', 'dex', 'int', 'armor', 'mov'] as (keyof UnitStats)[]).map((k) => (
                  <span key={k}><small>{STAT_LABELS[k]}</small><b>{fmt(stats[k])}{k === 'armor' ? '%' : ''}</b></span>
                ))}
              </div>
            </div>
          </div>
          <div class="eu-slots">
            {SLOT_ORDER.map((slot) => {
              const it = u.equipment[slot];
              const def = it ? ITEMS[it] : null;
              const reason = it ? (my ? safe(() => canUnequip(s, u, slot), null) : 'Not your turn') : null;
              return (
                <div class={cls('eu-slot', !def && 'empty')} key={slot}>
                  <span class="eu-slot-icon">{def ? <Icon k={def.icon} size={40} />
                    : <Sym name={slot === 'off' && u.equipment.main && ITEMS[u.equipment.main].twoHanded ? 'lock' : SLOT_EMPTY_SYM[slot]} />}</span>
                  <span class="eu-slot-main">
                    <small>{SLOT_NAMES[slot]}</small>
                    <b>{def ? def.name : 'Empty'}</b>
                    {def && <span class="t-dim">{itemSummary(def)}</span>}
                  </span>
                  {def && <Btn small disabled={!!reason} reason={reason} onClick={() => unequip(slot)} title={`Return ${def.name} to the stockpile`}>Remove</Btn>}
                </div>
              );
            })}
          </div>
        </div>
        <div class="equip-stock">
          <div class="group-title">Stockpile</div>
          {opts.length === 0 && <div class="empty-note">The stockpile is empty. Craft items at a Forge (F).</div>}
          {opts.map(({ item, count, error }) => {
            const def = ITEMS[item];
            const cur = u.equipment[def.slot];
            const delta = equipDelta(u, item);
            const err = !my ? 'Not your turn' : error;
            const swaps = cur ? ITEMS[cur].name : null;
            const dropsShield = def.twoHanded && u.equipment.off ? ITEMS[u.equipment.off].name : null;
            return (
              <button type="button" key={item} class={cls('stock-item', err && 'is-disabled')} aria-disabled={!!err} onClick={err ? undefined : () => equip(item)}
                {...tip(<TipCard icon={<Icon k={def.icon} size={40} />} title={def.name} sub={`${SLOT_NAMES[def.slot]} · ${itemSummary(def)}`}>
                  {def.description}
                  {swaps && <div class="tip-note">Replaces {swaps}.</div>}
                  {dropsShield && <div class="tip-note t-warn">Two-handed: {dropsShield} returns to the stockpile.</div>}
                  {err && <div class="tip-note t-bad">{err}</div>}
                </TipCard>, 'left')}>
                <span class="ic-icon"><Icon k={def.icon} size={40} /><span class="count-badge">{count}</span></span>
                <span class="ic-main">
                  <span class="ic-name">{def.name} <small class="t-dim">{SLOT_NAMES[def.slot]}</small></span>
                  <span class="ic-sum">{def.attack ? `${def.attack.name} ${def.attack.base}×${def.attack.strikes}${cur && ITEMS[cur].attack ? ` (was ${ITEMS[cur].attack!.base}×${ITEMS[cur].attack!.strikes})` : ''} · ` : ''}<DeltaList d={delta} /></span>
                  {err && <span class="pc-err">{err}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
