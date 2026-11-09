// Icons & portraits. <Icon k="items/sword.png"/> renders '/assets/icons/items/sword.png' and
// falls back to a generated glyph (tinted rounded tile + vector symbol) when the file is
// missing, so the UI looks finished before (or without) the painted icon set.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { AttackKind, FactionId } from '../core/types';
import { FACTIONS } from '../data/factions';
import { useUi } from './ctx';
import { cls, initials } from './util';

/** URLs that failed to load once: never request them again this session. */
const failed = new Set<string>();

function resolveIcon(k: string, lib: ReturnType<ReturnType<typeof useUi>['assets']>): string | null {
  if (lib) {
    try { return lib.iconUrl(k); } catch { return null; }
  }
  return '/assets/icons/' + k;
}

function resolvePortrait(k: string, lib: ReturnType<ReturnType<typeof useUi>['assets']>): string | null {
  if (lib) {
    try { return lib.portraitUrl(k); } catch { return null; }
  }
  return `/assets/portraits/${k}.png`;
}

/** Size is in UI pixels at the 16px reference scale (it grows with the UI scale). */
const rem = (px: number) => `${px / 16}rem`;

export interface IconProps {
  k: string;
  size?: number;
  class?: string;
  /** Desaturate (locked / unavailable). */
  dim?: boolean;
  alt?: string;
}

export function Icon({ k, size = 32, class: klass, dim, alt }: IconProps) {
  const { assets } = useUi();
  const url = resolveIcon(k, assets());
  const [bad, setBad] = useState(false);
  const style = { width: rem(size), height: rem(size), fontSize: rem(size) };
  if (!url || bad || failed.has(url)) {
    return <span class={cls('icon icon-glyph', dim && 'dim', klass)} style={style} aria-label={alt ?? labelOf(k)}><Glyph k={k} /></span>;
  }
  return (
    <span class={cls('icon icon-img', dim && 'dim', klass)} style={style}>
      <img src={url} alt={alt ?? labelOf(k)} draggable={false} loading="lazy" decoding="async"
        onError={() => { failed.add(url); setBad(true); }} />
    </span>
  );
}

function labelOf(k: string): string {
  const name = k.split('/').pop() ?? k;
  return name.replace(/\.[a-z]+$/i, '').replace(/^(stat|eff|passive|active)_/, '').replace(/_/g, ' ');
}

// ───────────────────────────── generated glyphs ─────────────────────────────
// 24×24 vector symbols; fill/stroke use currentColor so the tile tint drives them.
type Sym = JSX.Element;
const P = (d: string, extra: JSX.SVGAttributes<SVGPathElement> = {}) => <path d={d} {...extra} />;

const SYMBOLS: Record<string, Sym> = {
  // resources
  gold: <g><ellipse cx="12" cy="16.5" rx="7" ry="2.6" /><ellipse cx="12" cy="13" rx="7" ry="2.6" opacity=".85" /><ellipse cx="12" cy="9.5" rx="7" ry="2.6" opacity=".7" /><ellipse cx="12" cy="9.5" rx="4" ry="1.2" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1" /></g>,
  food: <g>{P('M5 14c0-4 3-6.5 7-6.5s7 2.5 7 6.5v1.5c0 .8-.7 1.5-1.5 1.5h-11C5.7 17 5 16.3 5 15.5z')}{P('M8.5 10.5l1 3M12 9.5v3.5M15.5 10.5l-1 3', { fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 1.2, 'stroke-linecap': 'round' })}</g>,
  wood: <g><rect x="3" y="12.5" width="16" height="5" rx="2.5" /><rect x="5" y="6.5" width="16" height="5" rx="2.5" opacity=".8" /><circle cx="19" cy="9" r="1.6" fill="rgba(0,0,0,.3)" /><circle cx="17" cy="15" r="1.6" fill="rgba(0,0,0,.3)" /></g>,
  stone: <g>{P('M3 18l2-6h7l1 6z')}{P('M13 18l1-7h6l1 7z', { opacity: 0.8 })}{P('M7 11l1.5-5h6l1.5 5z', { opacity: 0.9 })}</g>,
  iron: <g>{P('M4 17l2.5-5h11l2.5 5z')}{P('M7.5 11l2-4h7l2 4z', { opacity: 0.75 })}</g>,
  crystal: <g>{P('M12 2.5l5 6-5 13-5-13z')}{P('M12 2.5l5 6h-10z', { opacity: 0.7 })}{P('M18 11l3 3-3 5-2-5z', { opacity: 0.6 })}</g>,
  mana: <g>{P('M12 3c3.5 4.5 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.5 6-11z')}{P('M10 14.5a2.5 2.5 0 0 0 2.5 2.5', { fill: 'none', stroke: 'rgba(255,255,255,.6)', 'stroke-width': 1.4, 'stroke-linecap': 'round' })}</g>,
  research: <g>{P('M3 6.5c3-1.3 6-1.3 8.5.5v12c-2.5-1.8-5.5-1.8-8.5-.5z')}{P('M21 6.5c-3-1.3-6-1.3-8.5.5v12c2.5-1.8 5.5-1.8 8.5-.5z', { opacity: 0.8 })}</g>,
  // items
  tools: <g>{P('M13.5 4.5l5 5-2 2-1.5-1.5-6.5 6.5 1 1-2.5 2.5-3-3 2.5-2.5 1 1 6.5-6.5-1.5-1.5z')}</g>,
  sword: <g>{P('M17.5 3.5h3v3l-9 9-3-3z')}{P('M6 12.5l5.5 5.5-1.5 1.5-1.8-1.8-2.7 2.8-1.5-1.5 2.8-2.7-1.8-1.8z')}</g>,
  spear: <g>{P('M20.5 3.5l-1.5 6-2-2z')}{P('M17.7 6.3l.9.9L5 20.8l-.9-.9z')}{P('M15.5 9.5l-1-1', { stroke: 'currentColor', 'stroke-width': 2 })}</g>,
  axe: <g>{P('M6.5 20.5l-1.5-1.5 9.5-9.5 1.5 1.5z')}{P('M13 4c4 0 7 3 7 7l-2 1c0-3-2-5.5-5-6z')}{P('M12 5.5c1.5 2 3.5 4 5.5 5.5L15 13.5 9.5 8z')}</g>,
  bow: <g>{P('M6 3c8 2 12 7 14 15l-1.8.4C16.5 11 13 7 5.6 4.8z')}{P('M5.8 4L18.6 18.2', { fill: 'none', stroke: 'currentColor', 'stroke-width': 0.9, opacity: 0.7 })}{P('M8 15l9-9-.5 3 2.5-.5-9 9z', { opacity: 0.85 })}</g>,
  staff: <g>{P('M8 21l-1.2-.8L15 6.8l1.2.8z')}<circle cx="17" cy="5.5" r="3.2" /><circle cx="17" cy="5.5" r="1.4" fill="rgba(255,255,255,.6)" /></g>,
  wand: <g>{P('M5 20l-1-1 9-9 1 1z')}{P('M17 2.5l1 3 3 1-3 1-1 3-1-3-3-1 3-1z')}</g>,
  shield: <g>{P('M12 2.5l8 3v6c0 5-3.6 8.6-8 10-4.4-1.4-8-5-8-10v-6z')}{P('M12 5v14.5', { fill: 'none', stroke: 'rgba(0,0,0,.3)', 'stroke-width': 1.5 })}</g>,
  tunic: <g>{P('M8 3.5l4 2 4-2 4.5 3-2 4-2-1v11h-9v-11l-2 1-2-4z')}</g>,
  leather: <g>{P('M8 3.5l4 2 4-2 4.5 3-2 4-2-1v11h-9v-11l-2 1-2-4z')}{P('M8.5 12h7M8.5 15h7', { fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 1.2 })}</g>,
  plate: <g>{P('M7 4h10l3.5 3-1.5 4H17v9.5H7V11H5L3.5 7z')}{P('M12 4.5v15M7.5 11h9', { fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 1.3 })}</g>,
  robe: <g>{P('M9 3h6l1.5 4 3.5 13.5H4L7.5 7z')}{P('M12 7v13', { fill: 'none', stroke: 'rgba(0,0,0,.3)', 'stroke-width': 1.4 })}</g>,
  amulet: <g>{P('M6 3c0 5 2.5 8 6 9 3.5-1 6-4 6-9', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 })}{P('M12 11.5l4 4.5-4 5.5-4-5.5z')}</g>,
  ring: <g><circle cx="12" cy="14.5" r="6" fill="none" stroke="currentColor" stroke-width="2.6" />{P('M12 3.5l3 3.5-3 2.5-3-2.5z')}</g>,
  horse: <g>{P('M6 20.5V11a6 6 0 0 1 12 0v9.5h-3.5V11a2.5 2.5 0 0 0-5 0v9.5z')}<circle cx="7.8" cy="14" r=".9" fill="rgba(0,0,0,.4)" /><circle cx="16.2" cy="14" r=".9" fill="rgba(0,0,0,.4)" /><circle cx="8.5" cy="10" r=".9" fill="rgba(0,0,0,.4)" /><circle cx="15.5" cy="10" r=".9" fill="rgba(0,0,0,.4)" /></g>,
  // buildings
  castle: <g>{P('M3 21V8h3v2h2V8h3v2h2V8h3v2h2V8h3v13h-7v-5a2 2 0 0 0-4 0v5z')}</g>,
  house: <g>{P('M12 3l9 8h-2.5v10h-13V11H3z')}<rect x="10" y="14" width="4" height="7" fill="rgba(0,0,0,.35)" /></g>,
  farm: <g>{P('M12 21V8M12 9c-2-1-3-3-3-5 2 0 3 1.5 3 3.5M12 9c2-1 3-3 3-5-2 0-3 1.5-3 3.5M12 13c-2-1-3.5-3-3.5-5 2 0 3.5 1.5 3.5 3.5M12 13c2-1 3.5-3 3.5-5-2 0-3.5 1.5-3.5 3.5', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' })}{P('M4 21h16', { stroke: 'currentColor', 'stroke-width': 2 })}</g>,
  lumber: <g>{P('M12 2l5 7h-2.5l4 6H14v6h-4v-6H5.5l4-6H7z')}</g>,
  quarry: <g>{P('M2.5 20l5-11 4 5 3-7 7 13z')}</g>,
  forge: <g>{P('M3 8h13c0 2.5 2 3.5 5 3.5v1.5c-3 0-5 1.5-5.5 3.5H8.5C8 14 6 12.5 3 12z')}<rect x="8" y="16.5" width="8" height="4" /></g>,
  training: <g>{P('M4 3l2.5 0 11 11-2.5 2.5L4 5.5z')}{P('M20 3h-2.5l-11 11 2.5 2.5L20 5.5z', { opacity: 0.8 })}{P('M5 17l2 2-2.5 2.5-2-2zM19 17l-2 2 2.5 2.5 2-2z')}</g>,
  mine: <g>{P('M3 10c5-6 13-6 18 0l-1.5 1.2C15 6.5 9 6.5 4.5 11.2z')}{P('M11 8.5h2l-.3 12.5h-1.4z')}</g>,
  crystalmine: <g>{P('M3 10c5-6 13-6 18 0l-1.5 1.2C15 6.5 9 6.5 4.5 11.2z')}{P('M11 8.5h2l-.3 12.5h-1.4z')}{P('M17.5 13l2 2.5-2 5-2-5z', { opacity: 0.85 })}</g>,
  library: <g>{P('M3 5.5c3-1.3 6-1.3 8.5.5v13c-2.5-1.8-5.5-1.8-8.5-.5z')}{P('M21 5.5c-3-1.3-6-1.3-8.5.5v13c2.5-1.8 5.5-1.8 8.5-.5z', { opacity: 0.8 })}</g>,
  magetower: <g>{P('M12 1.5l3.5 7h-7z')}{P('M9 9.5h6l1 11.5H8z')}<circle cx="12" cy="13" r="1.4" fill="rgba(255,255,255,.65)" /></g>,
  wall: <g>{P('M2.5 20.5V9h3v2h3V9h3v2h3V9h3v2h3V9h1.5v11.5z')}{P('M2.5 15h19M8 11v4M15 11v4M5 15v5.5M12 15v5.5M19 15v5.5', { fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 1 })}</g>,
  watchtower: <g>{P('M7 3h10l-1.5 4h-7z')}{P('M9 7h6l2 14h-3l-.5-4h-3l-.5 4H7z')}</g>,
  shrine: <g>{P('M12 2.5l1.8 4.5 4.7.3-3.6 3 1.2 4.6L12 12.4l-4.1 2.5 1.2-4.6-3.6-3 4.7-.3z')}<rect x="5" y="17" width="14" height="3.5" rx="1" /></g>,
  // attack kinds / misc
  melee: <g>{P('M17.5 3.5h3v3l-9 9-3-3z')}{P('M6 12.5l5.5 5.5-1.5 1.5-1.8-1.8-2.7 2.8-1.5-1.5 2.8-2.7-1.8-1.8z')}</g>,
  ranged: <g>{P('M3 21l13-13', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 })}{P('M21 3l-2 7-5-5z')}{P('M3 21l1-4 3 3zM5 19.5l-2.5-.5M4.5 19.5l.5-2.5', { stroke: 'currentColor', 'stroke-width': 1 })}</g>,
  magic: <g>{P('M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z')}{P('M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z', { opacity: 0.8 })}</g>,
  lock: <g><rect x="5" y="10.5" width="14" height="10" rx="2" />{P('M8 10.5V8a4 4 0 0 1 8 0v2.5', { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2 })}</g>,
  check: <g>{P('M4.5 12.5l5 5 10-11', { fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })}</g>,
  skull: <g>{P('M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.6 1.3 4.4 3 5.5V19h9v-3c1.7-1.1 3-2.9 3-5.5A7.5 7.5 0 0 0 12 3z')}<circle cx="9" cy="11" r="1.8" fill="rgba(0,0,0,.6)" /><circle cx="15" cy="11" r="1.8" fill="rgba(0,0,0,.6)" /></g>,
  star: <g>{P('M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6-4.9-4.6 6.6-.8z')}</g>,
  hourglass: <g>{P('M6 3h12v2c0 3-2.5 5-4.5 7 2 2 4.5 4 4.5 7v2H6v-2c0-3 2.5-5 4.5-7C8.5 10 6 8 6 5z')}</g>,
  dice: <g><rect x="3.5" y="3.5" width="17" height="17" rx="3.5" /><circle cx="8.5" cy="8.5" r="1.6" fill="rgba(0,0,0,.55)" /><circle cx="15.5" cy="15.5" r="1.6" fill="rgba(0,0,0,.55)" /><circle cx="12" cy="12" r="1.6" fill="rgba(0,0,0,.55)" /><circle cx="15.5" cy="8.5" r="1.6" fill="rgba(0,0,0,.55)" /><circle cx="8.5" cy="15.5" r="1.6" fill="rgba(0,0,0,.55)" /></g>,
  menu: <g>{P('M4 6h16M4 12h16M4 18h16', { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' })}</g>,
  help: <g><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2" />{P('M9.2 9.3a2.9 2.9 0 1 1 3.9 2.7c-.7.3-1.1.9-1.1 1.7v.8', { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })}<circle cx="12" cy="17.3" r="1.25" /></g>,
  spellbook: <g>{P('M5 3h12a2 2 0 0 1 2 2v14.5H7a2 2 0 0 1-2-2z')}{P('M12 6.5l1.1 2.9 3 .2-2.3 1.9.8 3-2.6-1.7-2.6 1.7.8-3-2.3-1.9 3-.2z', { fill: 'rgba(0,0,0,.4)' })}{P('M7 19.5h12V21H7a2 2 0 0 1 0-1.5z', { opacity: 0.6 })}</g>,
  hammer: <g>{P('M13.5 4.5l5 5-2 2-1.5-1.5-6.5 6.5 1 1-2.5 2.5-3-3 2.5-2.5 1 1 6.5-6.5-1.5-1.5z')}</g>,
  upgrade: <g>{P('M12 3l7.5 7.5h-4.5v4h-6v-4H4.5z')}<rect x="9" y="16" width="6" height="2" /><rect x="9" y="19.5" width="6" height="2" /></g>,
  recruit: <g><circle cx="10" cy="7.5" r="3.8" />{P('M3 20c0-4.2 3.1-7 7-7s7 2.8 7 7z')}{P('M18.5 7v7M15 10.5h7', { fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' })}</g>,
  equip: <g>{P('M12 2.5l8 3v6c0 5-3.6 8.6-8 10-4.4-1.4-8-5-8-10v-6z')}{P('M8.5 12l2.5 2.5 4.5-5', { fill: 'none', stroke: 'rgba(0,0,0,.45)', 'stroke-width': 2, 'stroke-linecap': 'round' })}</g>,
  eye: <g>{P('M2 12c2.5-4.5 6-7 10-7s7.5 2.5 10 7c-2.5 4.5-6 7-10 7s-7.5-2.5-10-7z')}<circle cx="12" cy="12" r="3.5" fill="rgba(0,0,0,.5)" /></g>,
  sheet: <g>{P('M6 3h10.5L19 5.5V19.5A1.5 1.5 0 0 1 17.5 21H6A1.5 1.5 0 0 1 4.5 19.5v-15A1.5 1.5 0 0 1 6 3z')}{P('M8 8.5h8M8 12h8M8 15.5h5', { fill: 'none', stroke: 'rgba(0,0,0,.42)', 'stroke-width': 1.5, 'stroke-linecap': 'round' })}</g>,
  boot: <g>{P('M7 3h6v9l7 3.5c.8.4 1 1.2 1 2V20H4l1-7z')}</g>,
  heart: <g>{P('M12 20.5S3 15 3 8.8A4.8 4.8 0 0 1 12 6.3a4.8 4.8 0 0 1 9 2.5C21 15 12 20.5 12 20.5z')}</g>,
  fist: <g>{P('M7 8.5a1.6 1.6 0 0 1 3.2 0V7a1.6 1.6 0 0 1 3.2 0v.6a1.6 1.6 0 0 1 3.2 0v1a1.6 1.6 0 0 1 3.2.4V14c0 4-3 7-7 7h-1c-3.5 0-6-2.6-6-6v-2.5c0-1.2 1-2.2 2.2-2.2z')}</g>,
  poison: <g>{P('M12 3c3.5 4.5 6 7.6 6 11a6 6 0 0 1-12 0c0-3.4 2.5-6.5 6-11z')}<circle cx="10" cy="14" r="1.3" fill="rgba(0,0,0,.45)" /><circle cx="14" cy="15.5" r="1" fill="rgba(0,0,0,.45)" /></g>,
};

/** Category → tile tint (h s l) for glyph backgrounds. */
const CAT_TINT: Record<string, [number, number, number]> = {
  resources: [40, 55, 30], items: [210, 22, 30], buildings: [30, 30, 28], skills: [265, 30, 30],
  techs: [190, 30, 26], spells: [280, 40, 30], emblems: [0, 0, 24], ui: [40, 30, 26],
};
const RES_TINT: Record<string, [number, number, number]> = {
  gold: [44, 70, 32], food: [28, 55, 30], wood: [26, 40, 26], stone: [210, 8, 34], iron: [215, 15, 30],
  crystal: [275, 45, 34], mana: [220, 60, 34], research: [190, 45, 28],
};
const SYMBOL_COLOR: Record<string, string> = {
  gold: '#f3d27a', food: '#e8b878', wood: '#c79766', stone: '#c9c6bf', iron: '#a9b4c2', crystal: '#d0a8ff', mana: '#8fc0ff',
  research: '#9fe0e8',
};

function hashHue(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Resolve a symbol for an icon key, e.g. 'items/sword.png' → sword, 'skills/stat_str.png' → fist. */
function symbolFor(cat: string, name: string): Sym | null {
  if (SYMBOLS[name]) return SYMBOLS[name];
  const stem = name.replace(/^(stat|eff|passive|active)_/, '');
  const byStem: Record<string, string> = {
    str: 'fist', dex: 'ranged', int: 'magic', hp: 'heart', armor: 'shield', mov: 'boot', vis: 'eye',
    attack: 'melee', ranged: 'ranged', magic: 'magic', farming: 'farm', building: 'hammer', mining: 'mine', gathering: 'lumber',
    trade: 'gold', regeneration: 'heart', poison: 'poison', ironskin: 'shield', fortify: 'shield', heal: 'heart',
    firebolt: 'magic', fireball: 'magic', volley: 'ranged', powerstrike: 'sword', marksman: 'ranged', berserker: 'axe',
    harvester: 'food', prospector: 'iron', manaspring: 'mana', scholar: 'research', masonry: 'wall', devotion: 'shrine',
    pathfinder: 'boot', skirmisher: 'boot', blink: 'star', rally: 'star', leadership: 'star', inspiring: 'star',
    vampiric: 'heart', farsight: 'eye', haste: 'boot', bless: 'star', summon: 'stone', storm: 'magic',
    croprotation: 'farm', architecture: 'upgrade', grandarchitecture: 'castle', guilds: 'gold', scholarship: 'library',
    writing: 'research', tanning: 'leather', polearms: 'spear', shieldcraft: 'shield', platesmithing: 'plate',
    horsemanship: 'horse', tactics: 'training', crystallore: 'crystal', arcana: 'magetower', wandcraft: 'wand', jewelcraft: 'ring',
  };
  if (cat === 'spells' && name === 'heal') return SYMBOLS.heart;
  if (byStem[stem] && SYMBOLS[byStem[stem]]) return SYMBOLS[byStem[stem]];
  return null;
}

export function Glyph({ k }: { k: string }) {
  const parts = k.replace(/\.[a-z]+$/i, '').split('/');
  const cat = parts.length > 1 ? parts[0] : 'misc';
  const name = parts[parts.length - 1];
  const fac = cat === 'emblems' ? FACTIONS[name as FactionId] : undefined;
  if (fac) {
    // Heraldic crest: faction-colored shield with the accent-colored house initial.
    return (
      <span class="glyph glyph-emblem" style={{ color: fac.accent }}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 1.8l9 3.2v6.6c0 5.6-4 9.6-9 11.2-5-1.6-9-5.6-9-11.2V5z" fill={fac.color} stroke={fac.accent} stroke-width="1.2" />
          <path d="M12 4.2l6.6 2.4v5c0 4.2-2.9 7.3-6.6 8.6-3.7-1.3-6.6-4.4-6.6-8.6v-5z" fill="rgba(0,0,0,.22)" />
          <text x="12" y="15.6" text-anchor="middle" font-size="9.5" font-family="Cinzel, serif" font-weight="700" fill={fac.accent}>{fac.name.replace(/^(House|The)\s+/, '')[0]}</text>
        </svg>
      </span>
    );
  }
  const tint = cat === 'resources' && RES_TINT[name] ? RES_TINT[name] : CAT_TINT[cat] ?? [hashHue(name), 30, 28];
  const hue = cat === 'skills' || cat === 'techs' ? (tint[0] + (hashHue(name) % 40) - 20 + 360) % 360 : tint[0];
  const sym = symbolFor(cat, name);
  const color = SYMBOL_COLOR[name] ?? `hsl(${hue} 45% 82%)`;
  const bg = `radial-gradient(circle at 50% 38%, hsl(${hue} ${tint[1]}% ${tint[2] + 14}%), hsl(${hue} ${tint[1]}% ${tint[2] - 12}%) 75%)`;
  return (
    <span class="glyph" style={{ background: bg, color }}>
      {sym ? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{sym}</svg>
        : <span class="glyph-letter">{labelOf(name).slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** Bare inline symbol (no tile), e.g. in buttons and stat rows. */
export function Sym({ name, class: klass, title }: { name: keyof typeof SYMBOLS | string; class?: string; title?: string }) {
  const sym = SYMBOLS[name];
  if (!sym) return null;
  return <svg class={cls('sym', klass)} viewBox="0 0 24 24" fill="currentColor" aria-hidden={title ? undefined : 'true'}>{title && <title>{title}</title>}{sym}</svg>;
}

export function KindIcon({ kind }: { kind: AttackKind }) {
  return <Sym name={kind} class={`kind kind-${kind}`} />;
}

export function ResIcon({ r, size = 20 }: { r: string; size?: number }) {
  return <Icon k={`resources/${r}.png`} size={size} class="res-icon" />;
}

// ───────────────────────────── portraits ─────────────────────────────
/**
 * Bust portrait. `k` may list keys best first (e.g. '<race>_padded', then '<race>_commoner'): the
 * first one the asset library has (and that loads) is shown. Without any, a faction-tinted
 * silhouette with initials (or `sym`, a glyph name).
 */
export function Portrait({ k, name, color, class: klass, sym }: { k: string | readonly string[]; name: string; color: string; class?: string; sym?: string }) {
  const { assets } = useUi();
  const lib = assets();
  const keys = typeof k === 'string' ? [k] : k;
  let url: string | null = null;
  for (const key of keys) {
    const u = resolvePortrait(key, lib);
    if (u && !failed.has(u)) { url = u; break; }
  }
  // (a failed load marks the URL and re-renders: the next key is tried)
  const [, setFails] = useState(0);
  const style = { '--fc': color } as Record<string, string>;
  if (!url) {
    const first = keys[0] ?? '';
    const monster = first.startsWith('monster_');
    return (
      <div class={cls('portrait portrait-fallback', klass)} style={style} aria-label={name}>
        {!(sym && SYMBOLS[sym]) && <svg class="portrait-silhouette" viewBox="0 0 100 125" aria-hidden="true">
          {monster
            ? <path d="M14 112c4-26 18-40 36-40s32 14 36 40zM28 58c-6-14-2-30 8-38l6 12c4-3 12-3 16 0l6-12c10 8 14 24 8 38-6 10-14 14-22 14s-16-4-22-14z" />
            : <path d="M12 125c2-28 18-44 38-44s36 16 38 44zM50 76c-13 0-22-11-22-26s9-27 22-27 22 12 22 27-9 26-22 26z" />}
        </svg>}
        {sym && SYMBOLS[sym]
          ? <span class="portrait-sym"><Sym name={sym} /></span>
          : <span class="portrait-initials">{initials(name)}</span>}
      </div>
    );
  }
  return (
    <div class={cls('portrait', klass)} style={style}>
      <img src={url} alt={name} draggable={false} onError={() => { failed.add(url!); setFails((n) => n + 1); }} />
    </div>
  );
}

/** Faction emblem with a colored crest fallback. */
export function Emblem({ faction, size = 28 }: { faction: string; size?: number }) {
  return <Icon k={`emblems/${faction}.png`} size={size} class={`emblem emblem-${faction}`} />;
}
