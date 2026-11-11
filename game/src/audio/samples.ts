// Recorded audio assets (generated with Stable Audio 3 / ACE-Step, see art/tools/gen_audio.py):
// sample-based SFX variants and streamed music tracks, listed in assets/audio/audio.json.
// Everything here is optional. A missing manifest or file, or a browser that cannot play Ogg Opus,
// leaves the procedural sound design (sfx.ts) and generative music (music.ts) in place.

export type TrackMood = 'title' | 'game' | 'tension';

export interface AudioManifest {
  sfx: Record<string, string[]>;
  music: Partial<Record<TrackMood, string[]>>;
}

export function audioUrl(rel: string): string {
  let base = (import.meta as any).env?.BASE_URL ?? '/';
  if (!base.endsWith('/')) base += '/';
  return `${base}assets/audio/${rel.replace(/^\/+/, '')}`;
}

/** Ogg Opus is what the files are encoded as (Chrome, Firefox, Edge, Safari 18.4+). */
export function opusSupported(): boolean {
  try {
    return typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs="opus"') !== '';
  } catch {
    return false;
  }
}

let manifestP: Promise<AudioManifest | null> | null = null;

/** Fetch (once) the audio manifest; null when there is none or the codec is unsupported. */
export function loadAudioManifest(): Promise<AudioManifest | null> {
  if (!manifestP) {
    manifestP = (async () => {
      if (typeof fetch === 'undefined' || !opusSupported()) return null;
      try {
        const res = await fetch(audioUrl('audio.json'), { cache: 'no-cache' });
        if (!res.ok) return null;
        const m = (await res.json()) as AudioManifest;
        return m && typeof m === 'object' ? { sfx: m.sfx ?? {}, music: m.music ?? {} } : null;
      } catch {
        return null;
      }
    })();
  }
  return manifestP;
}

/** Decoded SFX variants per sound name; a sound counts as available once one variant is decoded. */
export class SampleBank {
  private bufs = new Map<string, AudioBuffer[]>();
  private last = new Map<string, AudioBuffer>();
  private started = false;
  /** Set by the dev audition page to compare against the procedural versions. */
  disabled = false;

  has(name: string): boolean {
    return !this.disabled && (this.bufs.get(name)?.length ?? 0) > 0;
  }

  /** A random variant, avoiding the one played last time when there is a choice. */
  pick(name: string): AudioBuffer | null {
    const list = this.bufs.get(name);
    if (!list?.length) return null;
    let b = list[Math.floor(Math.random() * list.length)];
    if (list.length > 1 && b === this.last.get(name)) b = list[(list.indexOf(b) + 1) % list.length];
    this.last.set(name, b);
    return b;
  }

  /** Fetch and decode every listed variant in the background (a few at a time). */
  load(ctx: BaseAudioContext): void {
    if (this.started) return;
    this.started = true;
    void (async () => {
      const m = await loadAudioManifest();
      if (!m) return;
      const jobs: [string, string][] = [];
      for (const [name, files] of Object.entries(m.sfx)) for (const f of files ?? []) jobs.push([name, f]);
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const [name, file] = jobs[next++];
          try {
            const res = await fetch(audioUrl(file));
            if (!res.ok) continue;
            const data = await res.arrayBuffer();
            const buf = await ctx.decodeAudioData(data);
            const list = this.bufs.get(name) ?? [];
            list.push(buf);
            this.bufs.set(name, list);
          } catch (e) {
            console.warn('[audio] sample failed', file, e);
          }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    })();
  }
}
