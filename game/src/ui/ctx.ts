// Context shared by every UI component: the store and the asset library accessor.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { GameStore } from '../game/store';
import type { AssetLibrary } from '../render/types';
import type { Action, ActionResult } from '../core/types';

export interface UiCtx {
  store: GameStore;
  assets: () => AssetLibrary | null;
}

export const Ctx = createContext<UiCtx | null>(null);

export function useUi(): UiCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('UI context missing');
  return c;
}

/**
 * Dispatch through the store; surface failures as a toast unless the controller already
 * reported the same message.
 */
export async function act(store: GameStore, action: Action): Promise<ActionResult> {
  let r: ActionResult;
  try {
    r = await store.dispatch(action);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.toast(msg, 'bad');
    return { ok: false, error: msg, events: [] };
  }
  if (!r.ok && r.error && !store.ui.toasts.some((t) => t.text === r.error)) store.toast(r.error, 'bad');
  return r;
}
