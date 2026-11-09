// Tiny typed event bus used between controller, renderer and UI (not by the sim).
type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Set<Handler<Events[K]>> } = {};

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers[type];
    if (!set) { set = new Set(); this.handlers[type] = set; }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers[type];
    if (set) for (const fn of [...set]) fn(payload);
  }
}
