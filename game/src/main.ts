// Bootstrap: renderer → controller → UI → assets → title screen.
import { createWorldRenderer } from './render/index';
import type { AssetLibrary } from './render/types';
import { createController, type GameController } from './game/controller';
import { mountUi } from './ui/App';

// ───────────────────────────── error overlay ─────────────────────────────
// Dev-friendly but unobtrusive: a small card in the corner that collects uncaught errors and
// expands to show stacks. Never blocks input to the game.

interface Captured { message: string; detail: string; count: number }

const IGNORED = [/ResizeObserver loop/i, /AbortError/i, /The play\(\) request was interrupted/i];

function installErrorOverlay(): void {
  const errors: Captured[] = [];
  let card: HTMLDivElement | null = null;
  let expanded = false;

  const render = () => {
    if (!card) {
      card = document.createElement('div');
      card.setAttribute('role', 'status');
      Object.assign(card.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: '9999', maxWidth: 'min(560px, 90vw)',
        maxHeight: '50vh', overflow: 'auto', padding: '8px 12px', borderRadius: '8px',
        background: 'rgba(40,10,12,0.92)', color: '#ffd9d4', border: '1px solid rgba(255,120,100,0.55)',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)', pointerEvents: 'auto',
      } as Partial<CSSStyleDeclaration>);
      document.body.appendChild(card);
    }
    const total = errors.reduce((n, e) => n + e.count, 0);
    card.replaceChildren();
    const head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', gap: '10px', alignItems: 'center', cursor: 'pointer' });
    const title = document.createElement('strong');
    title.textContent = `${total} error${total > 1 ? 's' : ''}: ${errors[errors.length - 1].message.slice(0, 120)}`;
    title.style.flex = '1';
    const toggle = document.createElement('span');
    toggle.textContent = expanded ? 'hide' : 'details';
    toggle.style.textDecoration = 'underline';
    const close = document.createElement('span');
    close.textContent = '×';
    Object.assign(close.style, { fontSize: '16px', padding: '0 4px' });
    close.title = 'Dismiss';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      errors.length = 0;
      card?.remove();
      card = null;
      expanded = false;
    });
    head.append(title, toggle, close);
    head.addEventListener('click', () => { expanded = !expanded; render(); });
    card.append(head);
    if (expanded) {
      for (const e of errors) {
        const pre = document.createElement('pre');
        Object.assign(pre.style, { whiteSpace: 'pre-wrap', margin: '8px 0 0', color: '#ffb8ae' });
        pre.textContent = `${e.count > 1 ? `(×${e.count}) ` : ''}${e.message}\n${e.detail}`;
        card.append(pre);
      }
    }
  };

  const capture = (message: string, detail: string) => {
    if (IGNORED.some((re) => re.test(message))) return;
    const prev = errors.find((e) => e.message === message);
    if (prev) prev.count++;
    else errors.push({ message, detail, count: 1 });
    if (errors.length > 20) errors.shift();
    if (document.body) render();
  };

  window.addEventListener('error', (ev) => {
    if (!ev.error && !ev.message) return; // resource load errors (handled by the asset loader)
    const err = ev.error as Error | undefined;
    capture(err?.message ?? String(ev.message), err?.stack ?? `${ev.filename}:${ev.lineno}:${ev.colno}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as unknown;
    const msg = r instanceof Error ? r.message : String(r);
    capture(`Unhandled rejection: ${msg}`, r instanceof Error ? (r.stack ?? '') : '');
  });
}

function showFatal(message: string, err: unknown): void {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '10000',
    background: 'radial-gradient(circle at 50% 40%, #1d1a16, #07080a)', color: '#e8dcc0', textAlign: 'center',
    font: '16px/1.5 "Alegreya Sans", system-ui, sans-serif', padding: '24px',
  } as Partial<CSSStyleDeclaration>);
  const box = document.createElement('div');
  box.style.maxWidth = '560px';
  const h = document.createElement('h1');
  h.textContent = 'Gear & Magic could not start';
  Object.assign(h.style, { font: '700 28px Cinzel, serif', color: '#e8c35a', margin: '0 0 12px' });
  const p = document.createElement('p');
  p.textContent = message;
  const pre = document.createElement('pre');
  pre.textContent = err instanceof Error ? `${err.message}` : String(err);
  Object.assign(pre.style, { opacity: '0.6', fontSize: '12px', whiteSpace: 'pre-wrap' });
  box.append(h, p, pre);
  el.append(box);
  document.body.appendChild(el);
}

function removeBootSplash(): void {
  const el = document.getElementById('boot-splash');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 400);
}

// ───────────────────────────── boot ─────────────────────────────

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');
  if (!canvas || !uiRoot) throw new Error('index.html is missing #scene or #ui-root');

  let renderer;
  try {
    renderer = createWorldRenderer(canvas);
  } catch (e) {
    showFatal('Your browser or graphics driver could not create a WebGL2 context. Try updating your browser or enabling hardware acceleration.', e);
    throw e;
  }
  const controller: GameController = createController(renderer, canvas);

  // The renderer owns the asset library; it is exposed for the UI (icons, portraits) once loaded.
  const r = renderer as unknown as { assets?: AssetLibrary | null; getAssets?: () => AssetLibrary | null };
  const assets = (): AssetLibrary | null => {
    try { return r.getAssets?.() ?? r.assets ?? null; } catch { return null; }
  };

  mountUi(uiRoot, controller, assets);
  removeBootSplash();

  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__aether = { controller, renderer };

  try {
    await renderer.init((fraction, label) => controller.setLoading(fraction, label));
  } catch (e) {
    // Missing assets fall back to procedural art inside the renderer; an exception here is
    // unexpected but the game may still be playable, so report it and carry on.
    console.error('[boot] renderer.init failed', e);
  }
  controller.ready();
}

installErrorOverlay();
boot().catch((e) => console.error('[boot] failed', e));
