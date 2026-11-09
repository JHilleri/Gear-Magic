// Full-screen views: loading, title, new-game setup.
import { useEffect, useState } from 'preact/hooks';
import type { Difficulty, FactionId, GameSettings } from '../../core/types';
import { FACTIONS, PLAYABLE_FACTIONS, factionPerks } from '../../data/factions';
import { TECHS } from '../../data/research';
import { Btn, Segmented, stopKeys } from '../common';
import { useUi } from '../ctx';
import { Emblem, Sym } from '../icons';
import { tip } from '../tooltip';
import { assetUrl, cls } from '../util';
import { Modal } from '../modals/Modal';
import { describeSave, type SaveMeta } from '../../game/session';

/** "Round 5 · House Valen · autosave · 2 min ago" (+ the other slot, if any). */
function continueTip(saves: { manual: SaveMeta | null; auto: SaveMeta | null }): string {
  const { manual, auto } = saves;
  const newest = manual && auto ? (auto.savedAt > manual.savedAt ? auto : manual) : manual ?? auto;
  if (!newest) return 'No saved game yet';
  const [round, when] = describeSave(newest).split(' · ');
  const line = `Resume: ${round} · ${FACTIONS[newest.faction]?.name ?? newest.faction} · ${newest.auto ? 'autosave' : 'manual save'} · ${when}`;
  const other = newest === auto ? manual : auto;
  return other ? `${line}. A ${other.auto ? 'autosave' : 'manual save'} from round ${other.round} is in Menu › Load game.` : line;
}

// ───────────────────────────── image preloading ─────────────────────────────
const imgState = new Map<string, 'loading' | 'ok' | 'bad'>();
const imgWaiters = new Map<string, Set<() => void>>();

/** Preload a decorative image once; returns the URL when it loaded, null while loading or if missing. */
export function useImage(url: string): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const st = imgState.get(url);
    if (st === 'ok' || st === 'bad') return;
    const fn = () => setTick((t) => t + 1);
    let set = imgWaiters.get(url);
    if (!set) { set = new Set(); imgWaiters.set(url, set); }
    set.add(fn);
    if (!st) {
      imgState.set(url, 'loading');
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { imgState.set(url, 'ok'); imgWaiters.get(url)?.forEach((f) => f()); };
      img.onerror = () => { imgState.set(url, 'bad'); imgWaiters.get(url)?.forEach((f) => f()); };
      img.src = url;
    }
    return () => { set!.delete(fn); };
  }, [url]);
  return imgState.get(url) === 'ok' ? url : null;
}

function KeyArt({ dim }: { dim?: boolean }) {
  const bg = useImage(assetUrl('ui/menu_bg.jpg'));
  return (
    <div class={cls('keyart', dim && 'dim', bg && 'loaded')}>
      <div class="keyart-fallback" />
      {bg && <div class="keyart-img" style={{ backgroundImage: `url(${bg})` }} />}
      <div class="keyart-shade" />
      <div class="keyart-motes" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ '--i': i } as Record<string, number>} />)}</div>
    </div>
  );
}

function Logo({ small }: { small?: boolean }) {
  return (
    <div class={cls('logo', small && 'small')}>
      <div class="logo-ornament"><span /><Sym name="crystal" /><span /></div>
      <h1 class="logo-text" data-text="Gear & Magic">Gear <em>&amp;</em> Magic</h1>
      <div class="logo-tag">A tale of steel, sorcery and stone</div>
    </div>
  );
}

export function LoadingScreen() {
  const { store } = useUi();
  const p = Math.max(0, Math.min(1, store.ui.loadingProgress));
  return (
    <div class="screen loading-screen">
      <KeyArt dim />
      <div class="loading-center">
        <Logo />
        <div class="loading-bar"><div class="loading-fill" style={{ width: `${p * 100}%` }} /><div class="loading-shine" /></div>
        <div class="loading-label"><span>{store.ui.loadingLabel || 'Preparing the realm…'}</span><span>{Math.round(p * 100)}%</span></div>
      </div>
    </div>
  );
}

export function TitleScreen() {
  const { store } = useUi();
  const ui = store.ui;
  return (
    <div class="screen title-screen">
      <KeyArt />
      <div class="title-center">
        <Logo />
        <nav class="title-menu">
          <button type="button" class="title-btn primary" onClick={() => store.openModal('newgame')}><span>New Game</span></button>
          <button type="button" class={cls('title-btn', !ui.hasSave && 'is-disabled')} aria-disabled={!ui.hasSave} onClick={ui.hasSave ? () => { if (!store.loadGame()) store.toast('The saved game could not be loaded', 'bad'); } : undefined}
            {...tip(continueTip(ui.saves), 'right')}><span>Continue</span></button>
          <button type="button" class="title-btn" onClick={() => store.openModal('help')}><span>Field Manual</span></button>
          <button type="button" class="title-btn" onClick={() => store.openModal('settings')}><span>Settings</span></button>
        </nav>
      </div>
      <div class="title-foot">Inspired by Battle for Wesnoth &amp; Millennia · v0.1</div>
    </div>
  );
}

const SIZE_INFO: Record<GameSettings['mapSize'], string> = { small: '26 × 20 hexes — quick skirmish', normal: '34 × 26 hexes — the intended scale', large: '42 × 32 hexes — long campaign' };
const DIFF_INFO: Record<Difficulty, string> = { easy: 'Rivals earn 20% less and recruit fewer troops', normal: 'Rivals play by your rules', hard: 'Rivals earn 30% more and field larger armies' };

export function NewGameModal() {
  const { store } = useUi();
  // Starts from the last game's choices (a fresh seed, though: a new game means new land).
  const last = store.ui.lastSetup;
  const [faction, setFaction] = useState<FactionId>(last?.playerFaction ?? 'valen');
  const [ai, setAi] = useState<number>(last?.aiCount ?? 2);
  const [size, setSize] = useState<GameSettings['mapSize']>(last?.mapSize ?? 'normal');
  const [diff, setDiff] = useState<Difficulty>(last?.difficulty ?? 'normal');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const start = () => {
    store.newGame({ mapSize: size, seed: Math.abs(Math.floor(seed)) || 1, playerFaction: faction, aiCount: ai, difficulty: diff });
  };
  const rivals = PLAYABLE_FACTIONS.filter((f) => f !== faction).slice(0, ai);
  return (
    <Modal size="xl" class="newgame-modal" title="Forge a New Realm" onClose={() => store.closeModal()}
      footer={<>
        <Btn onClick={() => store.closeModal()}>Back</Btn>
        <Btn primary icon="castle" onClick={start}>Begin</Btn>
      </>}>
      <div class="ng-section-title">Choose your house</div>
      <div class="faction-cards">
        {PLAYABLE_FACTIONS.map((f) => {
          const d = FACTIONS[f];
          return (
            <button type="button" key={f} class={cls('faction-card', f === faction && 'on')} onClick={() => setFaction(f)}
              style={{ '--fc': d.color, '--fa': d.accent } as Record<string, string>} aria-pressed={f === faction}>
              <span class="fcard-banner"><Emblem faction={f} size={84} /></span>
              <span class="fcard-name">{d.name}</span>
              <span class="fcard-race">{d.race === 'human' ? 'Humans' : d.race === 'orc' ? 'Orcs' : 'Undead'} · led by {d.leaderName}</span>
              <span class="fcard-flavor">{d.flavor}</span>
              <span class="fcard-perks">
                {factionPerks(d, (t) => TECHS[t].name).map((p) => <span key={p}>{p}</span>)}
              </span>
            </button>
          );
        })}
      </div>
      <div class="ng-options">
        <div class="ng-opt">
          <span class="ng-label">Rivals</span>
          <Segmented value={ai} onChange={setAi} options={[{ value: 1, label: '1 rival' }, { value: 2, label: '2 rivals' }]} />
          <span class="ng-hint">{rivals.map((f) => FACTIONS[f].name).join(' & ')}</span>
        </div>
        <div class="ng-opt">
          <span class="ng-label">Map size</span>
          <Segmented value={size} onChange={setSize} options={[{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} />
          <span class="ng-hint">{SIZE_INFO[size]}</span>
        </div>
        <div class="ng-opt">
          <span class="ng-label">Difficulty</span>
          <Segmented value={diff} onChange={setDiff} options={[{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }]} />
          <span class="ng-hint">{DIFF_INFO[diff]}</span>
        </div>
        <div class="ng-opt">
          <span class="ng-label">Map seed</span>
          <span class="seed-row">
            <input class="seed-input" type="number" min={1} max={999999999} value={seed} {...stopKeys}
              onInput={(e) => { const v = parseInt((e.currentTarget as HTMLInputElement).value, 10); if (Number.isFinite(v)) setSeed(v); }} />
            <button type="button" class="btn btn-small" onClick={() => setSeed(Math.floor(Math.random() * 1e6))} {...tip('Random seed')}><Sym name="dice" /></button>
          </span>
          <span class="ng-hint">The same seed always generates the same land</span>
        </div>
      </div>
    </Modal>
  );
}
