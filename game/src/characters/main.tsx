import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Appearance, Equipment, Gender, ItemId } from '../core/types';
import { BEARDS, EYE_COLORS, FACES, HAIR_COLORS, NAME_MAX, SKIN_TONES, fitAppearance, hairStylesFor, rollAppearance } from '../data/appearance';
import { ITEMS } from '../data/items';
import { assetBase } from '../render/assets';
import { CHARACTER_STORAGE_KEY, INITIAL_CHARACTER, LOADOUTS, parseCharacterDraft, withEquipment, type CharacterDraft } from './state';
import { createCharacterViewer, type CharacterViewer, type ViewerStats } from './viewer';
import './style.css';

interface StudioDebug {
  readonly state: CharacterDraft;
  readonly stats: ViewerStats | null;
  readonly ready: boolean;
  setState(value: unknown): void;
  focus(view: 'full' | 'face' | 'back'): void;
  play(clip: string): void;
}
declare global { interface Window { __characterStudio?: StudioDebug } }

const CLIPS: Record<string, string> = { idle: 'Idle', walk: 'Walk', attack_melee: 'Melee', attack_ranged: 'Archery', cast: 'Cast', work: 'Work', hit: 'Hit', death: 'Death' };
const ARMORS: { id: ItemId | null; name: string; note: string; glyph: string }[] = [
  { id: null, name: 'Base body', note: 'No armor attachments', glyph: '◇' },
  { id: 'tunic', name: 'Padded tunic', note: 'Quilted cloth', glyph: '◈' },
  { id: 'leather', name: 'Leather armor', note: 'Hardened hide', glyph: '⬡' },
  { id: 'plate', name: 'Plate armor', note: 'Forged steel', glyph: '♜' },
  { id: 'robe', name: 'Mage robe', note: 'Runed silk', glyph: '✧' },
];

function Section({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ComponentChildren }) {
  return <section class="forge-section"><div class="section-heading"><h3>{title}</h3>{eyebrow && <span>{eyebrow}</span>}</div>{children}</section>;
}

function Swatches<T extends string>({ label, colors, value, onChange }: {
  label: string; colors: { id: T; name: string; color: string }[]; value?: T; onChange: (id: T) => void;
}) {
  return <div class="color-control"><div class="field-label"><span>{label}</span><span>{colors.find((c) => c.id === value)?.name ?? 'Original'}</span></div>
    <div class="swatches" role="group" aria-label={label}>{colors.map((c) => <button type="button" key={c.id} title={`${label}: ${c.name}`} aria-label={`${label}: ${c.name}`} aria-pressed={value === c.id}
      class={`swatch ${value === c.id ? 'selected' : ''}`} style={{ '--swatch': c.color }} onClick={() => onChange(c.id)} />)}</div></div>;
}

function download(url: string, name: string) {
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
}

function App() {
  const [draft, setDraft] = useState<CharacterDraft>(() => structuredClone(INITIAL_CHARACTER));
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clip, setClip] = useState('idle');
  const [paused, setPaused] = useState(false);
  const [turntable, setTurntable] = useState(false);
  const [view, setView] = useState<'full' | 'face' | 'back'>('full');
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const viewer = useRef<CharacterViewer | null>(null);
  const latest = useRef(draft);
  const latestStats = useRef(stats);
  latest.current = draft; latestStats.current = stats;

  useEffect(() => {
    let alive = true;
    createCharacterViewer(canvas.current!, latest.current, (fraction) => { if (alive) setProgress(fraction); }, (value) => { if (alive) setStats(value); })
      .then((v) => { if (!alive) { v.dispose(); return; } viewer.current = v; v.setCharacter(latest.current); setReady(true); })
      .catch((e: unknown) => { if (alive) setError(`The 3D preview could not start. ${e instanceof Error ? e.message : 'Please reload the page.'}`); });
    return () => { alive = false; viewer.current?.dispose(); viewer.current = null; };
  }, []);

  useEffect(() => { viewer.current?.setCharacter(draft); }, [draft.gender, draft.look, draft.equipment]);
  useEffect(() => { viewer.current?.play(clip); }, [clip]);
  useEffect(() => { viewer.current?.setPaused(paused); }, [paused]);
  useEffect(() => { viewer.current?.setTurntable(turntable); }, [turntable]);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(id); }, [notice]);
  useEffect(() => {
    window.__characterStudio = {
      get state() { return structuredClone(latest.current); },
      get stats() { return latestStats.current ? structuredClone(latestStats.current) : null; },
      get ready() { return !!viewer.current; },
      setState(value) { setDraft(parseCharacterDraft(value)); },
      focus(mode) { setView(mode); viewer.current?.focus(mode); },
      play(name) { setClip(name); viewer.current?.play(name); },
    };
    return () => { delete window.__characterStudio; };
  }, []);

  const setLook = (patch: Partial<Appearance>) => setDraft((d) => ({ ...d, look: { ...d.look, ...patch } }));
  const setGender = (gender: Gender) => setDraft((d) => ({ ...d, gender, look: fitAppearance(gender, d.look) }));
  const equip = (slot: keyof Equipment, item: ItemId | null) => setDraft((d) => withEquipment(d, slot, item));
  const focus = (mode: 'full' | 'face' | 'back') => { setView(mode); viewer.current?.focus(mode); };
  const tryAction = (fn: () => void) => { try { fn(); } catch (e) { setNotice(e instanceof Error ? e.message : 'This action could not be completed.'); } };
  const save = () => tryAction(() => { const value = parseCharacterDraft(draft); localStorage.setItem(CHARACTER_STORAGE_KEY, JSON.stringify(value)); setNotice(`${value.name} saved in this browser.`); });
  const load = () => tryAction(() => { const text = localStorage.getItem(CHARACTER_STORAGE_KEY); if (!text) throw new Error('No saved character yet. Save your character first.'); setDraft(parseCharacterDraft(JSON.parse(text))); setNotice('Saved character restored.'); });
  const exportDraft = () => tryAction(() => {
    const value = parseCharacterDraft(draft);
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    download(url, `${value.name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-character.json`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Character exported. Import this file to restore the same appearance and gear.');
  });
  const importDraft = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) { setNotice('This file is too large. Choose a Character Forge JSON file under 64 KB.'); return; }
    try { setDraft(parseCharacterDraft(JSON.parse(await file.text()))); setNotice('Character imported.'); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'This character file could not be read.'); }
    finally { if (input.current) input.current.value = ''; }
  };
  const main = draft.equipment.main;
  const twoHanded = !!main && !!ITEMS[main].twoHanded;
  const currentLoadout = LOADOUTS.find((p) => JSON.stringify(p.equipment) === JSON.stringify(draft.equipment));
  const armor = ARMORS.find((a) => a.id === draft.equipment.body)!;

  return <div class="forge-shell">
    <header class="forge-header">
      <a class="brand" href={import.meta.env.BASE_URL} aria-label="Back to Gear and Magic"><span class="brand-mark">✦</span><span>GEAR <i>&</i> MAGIC</span></a>
      <div class="header-title"><span class="eyebrow">THE WORKSHOP</span><h1>Character Forge</h1></div>
      <div class="header-actions"><button type="button" class="quiet-button" onClick={load}>Load character</button><button type="button" class="gold-button" onClick={save}>Save character <span>↗</span></button></div>
    </header>
    <main class="forge-main">
      <aside class="forge-panel identity-panel" aria-label="Character appearance">
        <div class="panel-heading"><span class="eyebrow">01 / IDENTITY</span><h2>Make them yours.</h2></div>
        <Section title="Character">
          <label class="name-field"><span class="field-label">Name</span><input aria-label="Character name" value={draft.name} maxLength={NAME_MAX} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} spellcheck={false} /></label>
          <div class="segmented" aria-label="Body type">{(['male', 'female'] as const).map((g) => <button type="button" class={draft.gender === g ? 'selected' : ''} aria-pressed={draft.gender === g} onClick={() => setGender(g)}>{g === 'male' ? 'Male' : 'Female'}</button>)}</div>
        </Section>
        <Section title="Face" eyebrow="3 sculpted faces">
          <div class="choice-grid faces">{FACES[draft.gender].map((name, index) => <button type="button" class={`choice ${draft.look.face === index ? 'selected' : ''}`} aria-pressed={draft.look.face === index} onClick={() => setLook({ face: index })}><span class="face-number">0{index + 1}</span>{name}</button>)}</div>
          <Swatches label="Skin tone" colors={SKIN_TONES} value={draft.look.skin} onChange={(skin) => setLook({ skin })} />
          <Swatches label="Eye color" colors={EYE_COLORS} value={draft.look.eyes} onChange={(eyes) => setLook({ eyes })} />
        </Section>
        <Section title="Hair" eyebrow={`${hairStylesFor(draft.gender).length} styles`}>
          <div class="choice-grid hair">{hairStylesFor(draft.gender).map((h) => <button type="button" class={`choice ${draft.look.hair === h.id ? 'selected' : ''}`} aria-pressed={draft.look.hair === h.id} onClick={() => setLook({ hair: h.id })}>{h.name}</button>)}</div>
          <Swatches label="Hair color" colors={HAIR_COLORS} value={draft.look.hairColor} onChange={(hairColor) => setLook({ hairColor })} />
          {draft.gender === 'male' && <label class="select-label"><span>Facial hair</span><select aria-label="Facial hair" value={draft.look.beard} onChange={(e) => setLook({ beard: e.currentTarget.value as Appearance['beard'] })}>{BEARDS.map((b) => <option value={b.id}>{b.name}</option>)}</select></label>}
        </Section>
        <button type="button" class="random-button" onClick={() => setDraft({ ...draft, look: rollAppearance(draft.gender, Math.random) })}><span>⤨</span> Randomize appearance</button>
      </aside>

      <section class="forge-stage" aria-label="Live 3D character preview">
        <div class="stage-ambient" />
        <div class="stage-top"><span class="live-label"><i /> LIVE 3D PREVIEW</span><div class="view-options" aria-label="Camera view">{(['full', 'face', 'back'] as const).map((mode) => <button type="button" aria-pressed={view === mode} class={view === mode ? 'selected' : ''} disabled={!ready} onClick={() => focus(mode)}>{mode === 'full' ? 'Full body' : mode === 'face' ? 'Portrait' : 'Back'}</button>)}</div></div>
        <canvas ref={canvas} aria-label="Drag to rotate your character. Scroll to zoom." tabIndex={0} />
        {!ready && <div class="loading-overlay" role="status">{error ? <><span class="loading-rune">!</span><h2>Preview unavailable</h2><p>{error}</p></> : <><span class="loading-rune">✧</span><h2>Preparing the forge</h2><p>Loading character models · {Math.round(progress * 100)}%</p><div class="loading-track"><i style={{ width: `${progress * 100}%` }} /></div></>}</div>}
        <div class="character-caption"><span class="eyebrow">{currentLoadout?.name ?? 'Your creation'} / HUMAN</span><h2>{draft.name || 'Unnamed hero'}</h2><p>{armor.name} <span>·</span> {FACES[draft.gender][draft.look.face]}</p></div>
        <div class="stage-controls"><div class="animation-row"><label>POSE <select aria-label="Animation" value={clip} disabled={!ready} onChange={(e) => setClip(e.currentTarget.value)}>{Object.entries(CLIPS).filter(([id]) => !stats || stats.clips.includes(id)).map(([id, label]) => <option value={id}>{label}</option>)}</select></label><button type="button" title={paused ? 'Resume animation' : 'Pause animation'} aria-label={paused ? 'Resume animation' : 'Pause animation'} aria-pressed={paused} disabled={!ready} onClick={() => setPaused(!paused)}>{paused ? '▶' : 'Ⅱ'}</button><button type="button" class={turntable ? 'selected' : ''} aria-pressed={turntable} disabled={!ready} onClick={() => setTurntable(!turntable)}>↻ Turntable</button><button type="button" title="Save a PNG of the 3D preview" disabled={!ready} onClick={() => { if (viewer.current) download(viewer.current.snapshot(), 'character-preview.png'); }}>↓ PNG</button></div><p class="orbit-hint">Drag to rotate <span>·</span> Scroll to zoom</p></div>
      </section>

      <aside class="forge-panel equipment-panel" aria-label="Character equipment">
        <div class="panel-heading"><span class="eyebrow">02 / EQUIPMENT</span><h2>Dress for adventure.</h2></div>
        <Section title="Armor" eyebrow="Fitted for both bodies">
          <div class="armor-list">{ARMORS.map((a) => <button type="button" class={`armor-card ${draft.equipment.body === a.id ? 'selected' : ''}`} aria-pressed={draft.equipment.body === a.id} onClick={() => equip('body', a.id)}><span class="armor-icon">{a.id ? <img src={`${assetBase()}icons/${ITEMS[a.id].icon}`} alt="" /> : a.glyph}</span><span><strong>{a.name}</strong><small>{a.note}</small></span><span class="selection-dot">{draft.equipment.body === a.id ? '◆' : '◇'}</span></button>)}</div>
        </Section>
        <Section title="Arms & relics">
          <label class="select-label"><span>Main hand</span><select aria-label="Main hand" value={draft.equipment.main ?? ''} onChange={(e) => equip('main', (e.currentTarget.value || null) as ItemId | null)}><option value="">Unarmed</option>{Object.values(ITEMS).filter((it) => it.slot === 'main').map((it) => <option value={it.id}>{it.name}{it.twoHanded ? ' · 2H' : ''}</option>)}</select></label>
          <label class="select-label"><span>Off hand {twoHanded && <small>Occupied by weapon</small>}</span><select aria-label="Off hand" value={draft.equipment.off ?? ''} disabled={twoHanded} onChange={(e) => equip('off', (e.currentTarget.value || null) as ItemId | null)}><option value="">None</option><option value="shield">Shield</option></select></label>
          <label class="select-label"><span>Trinket</span><select aria-label="Trinket" value={draft.equipment.trinket ?? ''} onChange={(e) => equip('trinket', (e.currentTarget.value || null) as ItemId | null)}><option value="">None</option><option value="amulet">Amulet of Vigor</option><option value="ring">Ring of Focus</option></select></label>
        </Section>
        <Section title="Loadout presets"><div class="loadouts">{LOADOUTS.map((p) => <button type="button" class={currentLoadout?.id === p.id ? 'selected' : ''} aria-pressed={currentLoadout?.id === p.id} title={p.note} onClick={() => setDraft({ ...draft, equipment: { ...p.equipment } })}>{p.name}</button>)}</div></Section>
        <div class="equipment-note"><span>✧</span><p>Your gear is shown on the model.<br />Appearance stays with you as armor changes.</p></div>
      </aside>
    </main>
    <footer class="forge-footer"><span><i class={ready ? 'ready-dot' : ''} />{ready ? 'All changes preview instantly' : 'Preparing character assets'}</span><div><button type="button" onClick={() => input.current?.click()}>Import character</button><span class="footer-divider" /><button type="button" onClick={exportDraft}>Export character ↗</button></div><input ref={input} class="file-input" type="file" accept=".json,application/json" aria-label="Import character JSON" onChange={(e) => void importDraft(e.currentTarget.files?.[0])} /></footer>
    {stats?.missing.length ? <div class="asset-warning" role="status">Some assets could not load: {stats.missing.join(', ')}. Reload to retry.</div> : null}
    {notice && <div class="forge-toast" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}
  </div>;
}

render(<App />, document.getElementById('app')!);
