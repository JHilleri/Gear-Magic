// Customise a unit (humans, DESIGN §4.9): its name, gender, face, hair cut and colour, eye colour
// and beard, with a live bust of the result that can be turned. Nothing here changes a rule: it
// is one free 'customize' action, applied when the player confirms.
import { useState } from 'preact/hooks';
import type { Appearance, BodyVariant, Gender, Unit } from '../../core/types';
import {
  BEARDS, EYE_COLORS, FACES, HAIR_COLORS, NAME_MAX, describeAppearance, fitAppearance, hairStylesFor, rollAppearance,
} from '../../data/appearance';
import { FACTIONS } from '../../data/factions';
import { bodyVariant, canCustomize } from '../../sim/units';
import { Btn, stopKeys } from '../common';
import { act, useUi } from '../ctx';
import { Emblem, Portrait } from '../icons';
import { tip } from '../tooltip';
import { cls, isMyTurn, portraitKey, safe, selectedUnitId, unitById, unitRole } from '../util';
import { Modal } from './Modal';

interface Draft { name: string; gender: Gender; look: Appearance }

/** A name of the house's pool for `gender` that no living unit of the house bears (the unit's own excepted). */
function freeName(units: Unit[], u: Unit, gender: Gender): string | null {
  const def = FACTIONS[u.faction];
  const pool = (gender === 'female' && def?.femaleUnitNames?.length ? def.femaleUnitNames : def?.unitNames) ?? [];
  const used = new Set(units.filter((o) => o.faction === u.faction && o.id !== u.id).map((o) => o.name));
  const free = pool.filter((n) => !used.has(n));
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}

function Row({ label, children, note }: { label: string; children: preact.ComponentChildren; note?: string }) {
  return (
    <div class="cz-row">
      <div class="cz-label">{label}{note && <small>{note}</small>}</div>
      <div class="cz-opts">{children}</div>
    </div>
  );
}

export function CustomizeModal() {
  const { store, assets } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const u = unitById(s, ui.sheetUnit) ?? unitById(s, selectedUnitId(s, ui));
  const close = () => store.closeModal();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [yaw, setYaw] = useState(0);
  const [drag, setDrag] = useState<{ x: number; yaw: number } | null>(null);
  if (!u || u.hp <= 0 || !u.look || !u.gender) {
    return <Modal size="sm" title="Appearance" onClose={close}><div class="empty-note">This unit's looks cannot be changed.</div></Modal>;
  }
  const d: Draft = draft ?? { name: u.name, gender: u.gender, look: u.look };
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const setLook = (patch: Partial<Appearance>) => set({ look: { ...d.look, ...patch } });
  const fd = FACTIONS[u.faction];
  const units = Object.values(s.units);
  const body = safe(() => bodyVariant(u), 'commoner' as BodyVariant);
  const preview: Unit = { ...u, name: d.name, gender: d.gender, look: d.look };
  const changed = d.name.trim() !== u.name || d.gender !== u.gender || JSON.stringify(d.look) !== JSON.stringify(u.look);
  const my = isMyTurn(s, ui);
  const error = safe(() => canCustomize(s, u, { name: d.name, gender: d.gender, look: d.look }), 'Unavailable');
  const reason = !my ? 'Not your turn' : error;
  const live = !!assets()?.unitPortrait;

  const setGender = (g: Gender) => {
    if (g === d.gender) return;
    // A name from the other list goes with the other gender; a name the player typed stays.
    const pool = (d.gender === 'female' ? fd?.femaleUnitNames : fd?.unitNames) ?? [];
    const pooled = pool.includes(d.name.replace(/ [IVX]+$/, ''));
    set({ gender: g, look: fitAppearance(g, d.look), name: pooled ? freeName(units, u, g) ?? d.name : d.name });
  };
  const randomize = () => set({ look: rollAppearance(d.gender, Math.random) });
  const apply = async () => {
    if (!changed) { close(); return; }
    const r = await act(store, {
      type: 'customize', unit: u.id,
      ...(d.name.trim() !== u.name ? { name: d.name.trim() } : {}),
      ...(d.gender !== u.gender ? { gender: d.gender } : {}),
      look: d.look,
    });
    if (r.ok) close();
  };
  const turn = (deg: number) => setYaw((((yaw + deg + 180) % 360) + 360) % 360 - 180);

  const footer = (
    <div class="cz-foot">
      <Btn small onClick={() => { setDraft(null); setYaw(0); }} disabled={!changed} title="Back to how the unit looks now">Reset</Btn>
      <span class="cz-foot-note">{reason && changed ? <span class="t-bad">{reason}</span> : 'Looks change no stat: they only tell your units apart.'}</span>
      <Btn onClick={close}>Cancel</Btn>
      <Btn primary glow={changed && !reason} disabled={changed && !!reason} reason={changed ? reason : null} onClick={() => void apply()}>{changed ? 'Apply' : 'Done'}</Btn>
    </div>
  );

  return (
    <Modal size="lg" parchment={false} class="customize" onClose={close} footer={footer}
      icon={<Emblem faction={u.faction} size={44} />}
      title={`Appearance of ${u.name}`}
      sub={<span>Level {u.level} {unitRole(u)} · {d.gender === 'female' ? 'woman' : 'man'}, {describeAppearance(d.look).toLowerCase()}</span>}>
      <div class="cz" style={{ '--fc': fd.color, '--fa': fd.accent } as Record<string, string>}>
        <div class="cz-view">
          <div class={cls('cz-portrait-wrap', drag && 'dragging')}
            onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ x: e.clientX, yaw }); }}
            onPointerMove={(e) => {
              if (!drag) return;
              // The bust follows the pointer, as if held (15° steps: every step is one cached render).
              const next = Math.round((drag.yaw - (e.clientX - drag.x) * 0.9) / 15) * 15;
              const wrapped = (((next + 180) % 360) + 360) % 360 - 180;
              if (wrapped !== yaw) setYaw(wrapped);
            }}
            onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}
            {...(live ? tip('Drag to turn') : {})}>
            <Portrait k={portraitKey(preview, body)} unit={preview} body={body} name={d.name} color={fd.color} class="cz-portrait" large yaw={yaw} />
          </div>
          <div class="cz-turn">
            <Btn small onClick={() => turn(45)} title="Turn left" disabled={!live}>‹</Btn>
            <Btn small onClick={() => setYaw(0)} title="Face the front" disabled={!live || yaw === 0}>Front</Btn>
            <Btn small onClick={() => turn(180)} title="Turn around" disabled={!live}>Back</Btn>
            <Btn small onClick={() => turn(-45)} title="Turn right" disabled={!live}>›</Btn>
          </div>
          <Btn icon="star" onClick={randomize} title="Roll a new face, hair, eyes and beard">Randomise</Btn>
        </div>
        <div class="cz-form">
          <Row label="Name">
            <input class="cz-name" type="text" value={d.name} maxLength={NAME_MAX} spellcheck={false} {...stopKeys}
              onInput={(e) => set({ name: (e.currentTarget as HTMLInputElement).value })} aria-label="Name" />
            <Btn small title="A name from the house's list" onClick={() => { const n = freeName(units, u, d.gender); if (n) set({ name: n }); }}>Suggest</Btn>
          </Row>
          <Row label="Gender">
            <div class="segmented">
              {(['male', 'female'] as const).map((g) => (
                <button type="button" key={g} class={cls('seg', d.gender === g && 'on')} onClick={() => setGender(g)}>{g === 'male' ? 'Man' : 'Woman'}</button>
              ))}
            </div>
          </Row>
          <Row label="Face">
            <div class="cz-chips">
              {FACES[d.gender].map((name, i) => (
                <button type="button" key={name} class={cls('cz-chip', d.look.face === i && 'on')} onClick={() => setLook({ face: i })}>{name}</button>
              ))}
            </div>
          </Row>
          <Row label="Hair">
            <div class="cz-chips">
              {hairStylesFor(d.gender).map((h) => (
                <button type="button" key={h.id} class={cls('cz-chip', d.look.hair === h.id && 'on')} onClick={() => setLook({ hair: h.id })}>{h.name}</button>
              ))}
            </div>
          </Row>
          <Row label="Hair colour" note={d.look.hair === 'bald' && d.look.beard === 'none' ? 'nothing to colour' : undefined}>
            <div class="cz-swatches">
              {HAIR_COLORS.map((c) => (
                <button type="button" key={c.id} class={cls('cz-swatch', d.look.hairColor === c.id && 'on')} style={{ background: c.color }}
                  aria-label={c.name} onClick={() => setLook({ hairColor: c.id })} {...tip(c.name)} />
              ))}
            </div>
          </Row>
          <Row label="Eyes">
            <div class="cz-swatches">
              {EYE_COLORS.map((c) => (
                <button type="button" key={c.id} class={cls('cz-swatch cz-eye', d.look.eyes === c.id && 'on')} style={{ '--c': c.color } as Record<string, string>}
                  aria-label={c.name} onClick={() => setLook({ eyes: c.id })} {...tip(c.name)} />
              ))}
            </div>
          </Row>
          <Row label="Beard" note={d.gender === 'female' ? 'men only' : undefined}>
            <div class="cz-chips">
              {BEARDS.map((b) => (
                <button type="button" key={b.id} disabled={d.gender === 'female'} class={cls('cz-chip', d.look.beard === b.id && 'on')}
                  onClick={() => setLook({ beard: b.id })}>{b.name}</button>
              ))}
            </div>
          </Row>
        </div>
      </div>
    </Modal>
  );
}
