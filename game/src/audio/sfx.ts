// Procedural WebAudio sound design — no audio files. One shared AudioContext (also used by
// audio/music.ts) is created lazily and unlocked on the first user gesture (autoplay policy).
//
// Graph:   voice → [gain] → [panner] → sfxBus ─┐
//                              └→ reverbSend ─→ convolver ─→ reverbReturn ─┤
//          music.ts ───────────────────────────────→ musicBus ─────────────┤
//                                                               master → compressor → out

export type SfxName =
  | 'click' | 'hover' | 'select' | 'deselect' | 'error' | 'modalOpen' | 'modalClose'
  | 'step' | 'clash' | 'hit' | 'miss' | 'bow' | 'arrowWhoosh' | 'arrowHit'
  | 'magicCast' | 'magicWhoosh' | 'magicHit' | 'explosion' | 'lightning' | 'heal' | 'bless' | 'haste'
  | 'summon' | 'farsight' | 'hammer' | 'buildComplete' | 'levelUp' | 'turnHorn' | 'victory' | 'defeat'
  | 'death' | 'spawn' | 'coin' | 'research' | 'capture' | 'equip' | 'craft' | 'poison' | 'destroy';

export interface PlayOpts {
  /** Stereo position −1..1. */
  pan?: number;
  /** Linear gain multiplier. */
  gain?: number;
  /** Seconds from now. */
  delay?: number;
  /** Pitch multiplier (1 = as designed). */
  pitch?: number;
}

type Dest = AudioNode;

/** Loudness balance per sound (measured offline with debugRenderSfx). */
const LEVELS: Partial<Record<SfxName, number>> = {
  click: 1.3, hover: 1.2, step: 1.6, bow: 0.75, clash: 1.7, hit: 1.3, miss: 1.4, arrowWhoosh: 1.8, arrowHit: 1.7,
  magicWhoosh: 1.7, magicHit: 1.3, equip: 2, modalOpen: 1.4, modalClose: 1.4, deselect: 1.3, bless: 1.5, haste: 1.4,
  capture: 1.4, coin: 1.3, buildComplete: 1.3, levelUp: 1.4, explosion: 0.9, summon: 0.8, lightning: 0.9,
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

class AudioEngine {
  ctx: BaseAudioContext | null = null;
  private offline = false;
  master!: GainNode;
  sfxBus!: GainNode;
  musicBus!: GainNode;
  reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private ksCache = new Map<string, AudioBuffer>();
  private volume = 0.7;
  private unlocked = false;
  private unlockCbs: (() => void)[] = [];
  private lastPlayed = new Map<SfxName, number>();
  private activeVoices = 0;

  /** True once a user gesture has created/resumed the context. */
  get ready(): boolean { return this.unlocked && !!this.ctx && this.ctx.state === 'running'; }

  /** Register a callback for when audio becomes available (runs immediately if it already is). */
  onUnlock(cb: () => void): void {
    if (this.unlocked && this.ctx) cb();
    else this.unlockCbs.push(cb);
  }

  /** Install one-shot gesture listeners that unlock audio. Safe to call more than once. */
  installUnlock(): void {
    if (typeof window === 'undefined') return;
    const handler = () => {
      this.unlock();
      if (this.unlocked) {
        window.removeEventListener('pointerdown', handler, true);
        window.removeEventListener('keydown', handler, true);
        window.removeEventListener('touchstart', handler, true);
      }
    };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
    window.addEventListener('touchstart', handler, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || !this.unlocked) return;
      const c = this.ctx as AudioContext;
      if (document.hidden) void c.suspend().catch(() => undefined);
      else void c.resume().catch(() => undefined);
    });
  }

  unlock(): void {
    try {
      if (!this.ctx) this.create();
      if (!this.ctx) return;
      if (this.ctx.state !== 'running') void (this.ctx as AudioContext).resume().catch(() => undefined);
      if (!this.unlocked) {
        this.unlocked = true;
        const cbs = this.unlockCbs.splice(0);
        for (const cb of cbs) { try { cb(); } catch (e) { console.warn('[audio] unlock callback failed', e); } }
      }
    } catch (e) {
      console.warn('[audio] WebAudio unavailable', e);
    }
  }

  private create(given?: BaseAudioContext): void {
    let ctx: BaseAudioContext;
    if (given) ctx = given;
    else {
      const Ctor: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.curve(this.volume);
    this.master.connect(comp);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 2.2; // voices are designed quiet; the bus + compressor set loudness
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.55;
    this.musicBus.connect(this.master);

    // Algorithmic hall reverb: stereo exponentially decaying filtered noise impulse.
    const conv = ctx.createConvolver();
    conv.buffer = this.makeImpulse(2.6, 2.4);
    const ret = ctx.createGain();
    ret.gain.value = 0.55;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(hp).connect(conv).connect(ret).connect(this.master);

    // 2 s of white noise, shared by every noise-based voice.
    const n = Math.floor(ctx.sampleRate * 2);
    this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // one-pole lowpass that darkens the tail over time (air absorption)
        const k = 0.25 + 0.7 * t;
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
        const early = i < ctx.sampleRate * 0.012 ? 0 : 1; // pre-delay
        d[i] = lp * Math.pow(1 - t, decay) * early * 2.2;
      }
    }
    return buf;
  }

  /** Perceptual volume curve. */
  private curve(v: number): number { return v <= 0 ? 0 : Math.pow(clamp(v, 0, 1), 1.6); }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.ctx) this.master.gain.setTargetAtTime(this.curve(this.volume), this.ctx.currentTime, 0.05);
  }

  getVolume(): number { return this.volume; }

  noise(): AudioBuffer { return this.noiseBuf; }

  /**
   * Karplus–Strong plucked string (cached per pitch). Returns the buffer plus the playback
   * rate that corrects the integer-delay tuning error.
   */
  pluckBuffer(freq: number, dur = 2.2, damping = 0.996, bright = 0.5): { buf: AudioBuffer; rate: number } {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const period = Math.max(4, Math.round(sr / freq));
    const key = `${period}:${dur}:${damping}:${bright}`;
    let buf = this.ksCache.get(key);
    if (!buf) {
      const n = Math.floor(sr * dur);
      buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      const ring = new Float32Array(period);
      // excitation: noise softened by a lowpass whose strength depends on brightness
      let lp = 0;
      for (let i = 0; i < period; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * (0.25 + bright * 0.7);
        ring[i] = lp;
      }
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const cur = ring[idx];
        const nxt = ring[(idx + 1) % period];
        const v = damping * (cur * (0.5 + bright * 0.1) + nxt * (0.5 - bright * 0.1));
        ring[idx] = v;
        d[i] = cur;
        idx = (idx + 1) % period;
      }
      // fade out the tail to avoid clicks
      const fade = Math.min(n, Math.floor(sr * 0.05));
      for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
      if (this.ksCache.size > 64) this.ksCache.delete(this.ksCache.keys().next().value as string);
      this.ksCache.set(key, buf);
    }
    const actual = sr / (period + 0.5); // averaging filter adds half a sample of delay
    return { buf, rate: freq / actual };
  }

  // ───────────── voice primitives (all times are absolute ctx times) ─────────────

  /** Output strip for one sound: gain → pan → sfx bus, plus reverb send. */
  strip(t: number, gain: number, pan: number, reverb: number, life: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    let out: AudioNode = g;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      out = p;
    }
    out.connect(this.sfxBus);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      out.connect(s).connect(this.reverbSend);
      setTimeout(() => { try { s.disconnect(); } catch { /* */ } }, (t - ctx.currentTime + life + 3.5) * 1000);
    }
    this.activeVoices++;
    setTimeout(() => {
      this.activeVoices--;
      try { g.disconnect(); out.disconnect(); } catch { /* */ }
    }, (t - ctx.currentTime + life + 3.5) * 1000);
    return g;
  }

  osc(dest: Dest, type: OscillatorType, f0: number, t: number, dur: number,
    o: { gain?: number; attack?: number; f1?: number; glide?: number; detune?: number; vibrato?: number; vibRate?: number } = {}): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (o.f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + (o.glide ?? dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.3;
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.01, dur));
    osc.connect(g).connect(dest);
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.vibRate ?? 5.5;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(o.vibrato, t + dur * 0.5);
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Sustained tone with explicit attack/hold/release (brass, horns, pads). */
  tone(dest: Dest, type: OscillatorType, f: number, t: number, attack: number, hold: number, release: number,
    o: { gain?: number; detune?: number; vibrato?: number; filter?: number; filterEnv?: number; q?: number } = {}): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (o.detune) osc.detune.value = o.detune;
    let node: AudioNode = osc;
    if (o.filter) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = o.q ?? 0.8;
      const base = o.filter;
      lp.frequency.setValueAtTime(base * 0.5, t);
      lp.frequency.linearRampToValueAtTime(base + (o.filterEnv ?? 0), t + attack);
      lp.frequency.setTargetAtTime(base, t + attack, hold * 0.5 + 0.05);
      osc.connect(lp);
      node = lp;
    }
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    node.connect(g).connect(dest);
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.2;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(o.vibrato, t + attack + hold);
      lfo.connect(lg).connect(osc.detune);
      lfo.start(t);
      lfo.stop(t + attack + hold + release + 0.05);
    }
    osc.start(t);
    osc.stop(t + attack + hold + release + 0.05);
  }

  noiseBurst(dest: Dest, t: number, dur: number,
    o: { gain?: number; type?: BiquadFilterType; f0?: number; f1?: number; q?: number; attack?: number; rate?: number } = {}): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = o.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f0 ?? 1000, t);
    if (o.f1 !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur);
    const g = ctx.createGain();
    const peak = o.gain ?? 0.3;
    const a = o.attack ?? 0.003;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.01, dur));
    src.connect(f).connect(g).connect(dest);
    const off = Math.random() * 1.2;
    src.start(t, off, dur + 0.1);
  }

  pluck(dest: Dest, freq: number, t: number, o: { gain?: number; dur?: number; damping?: number; bright?: number } = {}): void {
    const ctx = this.ctx!;
    const { buf, rate } = this.pluckBuffer(freq, o.dur ?? 1.6, o.damping ?? 0.994, o.bright ?? 0.5);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 0.4;
    src.connect(g).connect(dest);
    src.start(t);
  }

  /** Metallic strike: inharmonic partials with fast-decaying highs. */
  metal(dest: Dest, base: number, t: number, o: { gain?: number; decay?: number } = {}): void {
    const ratios = [1, 2.76, 5.4, 8.93, 13.34];
    const gains = [1, 0.6, 0.38, 0.22, 0.12];
    const decay = o.decay ?? 0.5;
    for (let i = 0; i < ratios.length; i++) {
      this.osc(dest, 'sine', base * ratios[i] * rnd(0.995, 1.005), t, decay / (1 + i * 0.6), { gain: (o.gain ?? 0.2) * gains[i], attack: 0.001 });
    }
  }

  /** Bell: harmonic-ish partials with long decay (chimes, heal). */
  bell(dest: Dest, f: number, t: number, o: { gain?: number; decay?: number } = {}): void {
    const partials: [number, number][] = [[1, 1], [2, 0.5], [3.01, 0.22], [4.2, 0.12], [5.43, 0.06]];
    const decay = o.decay ?? 1.4;
    for (const [r, g] of partials) this.osc(dest, 'sine', f * r, t, decay / Math.sqrt(r), { gain: (o.gain ?? 0.12) * g, attack: 0.002 });
  }

  /** Brass-like note: detuned saws through an opening lowpass. */
  brass(dest: Dest, f: number, t: number, hold: number, o: { gain?: number; bright?: number; release?: number } = {}): void {
    const bright = o.bright ?? 1;
    for (const det of [-7, 0, 6]) {
      this.tone(dest, 'sawtooth', f, t, 0.06, hold, o.release ?? 0.35, {
        gain: (o.gain ?? 0.07), detune: det, filter: 700 * bright + f * 0.8, filterEnv: 1800 * bright, q: 1.2, vibrato: 9,
      });
    }
  }

  // ───────────── public ─────────────

  play(name: SfxName, opts: PlayOpts = {}): void {
    if (!this.ctx || !this.unlocked || (this.ctx.state !== 'running' && !this.offline)) return;
    if (this.volume <= 0) return;
    if (this.activeVoices > 90) return; // overload guard
    const now = this.ctx.currentTime;
    // Rate-limit spammy sounds.
    const minGap = name === 'hover' ? 0.045 : name === 'step' ? 0.07 : name === 'click' ? 0.03 : 0.012;
    const last = this.lastPlayed.get(name) ?? -1;
    const t = now + Math.max(0, opts.delay ?? 0) + 0.005;
    if (t - last < minGap) return;
    this.lastPlayed.set(name, t);
    try {
      this.render(name, t, opts.pan ?? 0, (opts.gain ?? 1) * (LEVELS[name] ?? 1), opts.pitch ?? 1);
    } catch (e) {
      console.warn('[audio] sfx failed', name, e);
    }
  }

  private render(name: SfxName, t: number, pan: number, gm: number, p: number): void {
    switch (name) {
      case 'click': {
        const o = this.strip(t, 0.32 * gm, pan, 0.05, 0.1);
        this.osc(o, 'triangle', 1250 * p * rnd(0.97, 1.03), t, 0.045, { gain: 0.5, f1: 820 * p });
        this.noiseBurst(o, t, 0.02, { gain: 0.25, type: 'highpass', f0: 3500 });
        break;
      }
      case 'hover': {
        const o = this.strip(t, 0.07 * gm, pan, 0.0, 0.05);
        this.osc(o, 'sine', 2300 * p, t, 0.03, { gain: 0.5 });
        break;
      }
      case 'select': {
        const o = this.strip(t, 0.3 * gm, pan, 0.12, 0.4);
        this.osc(o, 'triangle', 660 * p, t, 0.16, { gain: 0.35 });
        this.osc(o, 'triangle', 990 * p, t + 0.045, 0.22, { gain: 0.3 });
        this.noiseBurst(o, t, 0.05, { gain: 0.12, type: 'bandpass', f0: 2400, q: 2 });
        break;
      }
      case 'deselect': {
        const o = this.strip(t, 0.22 * gm, pan, 0.05, 0.2);
        this.osc(o, 'triangle', 720 * p, t, 0.12, { gain: 0.35, f1: 480 * p });
        break;
      }
      case 'error': {
        const o = this.strip(t, 0.22 * gm, pan, 0.05, 0.4);
        for (const dt of [0, 0.13]) {
          this.tone(o, 'square', 165 * p, t + dt, 0.005, 0.07, 0.04, { gain: 0.25, filter: 900 });
        }
        break;
      }
      case 'modalOpen': {
        const o = this.strip(t, 0.2 * gm, pan, 0.08, 0.3);
        this.noiseBurst(o, t, 0.18, { gain: 0.35, type: 'bandpass', f0: 900, f1: 3200, q: 0.9, attack: 0.05 });
        this.osc(o, 'sine', 520, t + 0.02, 0.12, { gain: 0.12, f1: 780 });
        break;
      }
      case 'modalClose': {
        const o = this.strip(t, 0.16 * gm, pan, 0.05, 0.3);
        this.noiseBurst(o, t, 0.15, { gain: 0.32, type: 'bandpass', f0: 2800, f1: 900, q: 0.9, attack: 0.02 });
        break;
      }
      case 'step': {
        const o = this.strip(t, 0.2 * gm, pan, 0.03, 0.15);
        this.noiseBurst(o, t, rnd(0.05, 0.08), { gain: 0.5, type: 'lowpass', f0: rnd(500, 950) * p, q: 0.7 });
        this.osc(o, 'sine', rnd(85, 110), t, 0.06, { gain: 0.35, f1: 55 });
        this.noiseBurst(o, t + 0.01, 0.03, { gain: 0.08, type: 'highpass', f0: 4000 });
        break;
      }
      case 'clash': {
        const o = this.strip(t, 0.34 * gm, pan, 0.22, 0.9);
        this.metal(o, rnd(1050, 1500) * p, t, { gain: 0.22, decay: rnd(0.4, 0.6) });
        this.noiseBurst(o, t, 0.07, { gain: 0.45, type: 'highpass', f0: 2600, q: 0.7 });
        this.noiseBurst(o, t + 0.005, 0.12, { gain: 0.15, type: 'bandpass', f0: 5200, f1: 2600, q: 2 });
        this.osc(o, 'sine', 180, t, 0.08, { gain: 0.3, f1: 70 });
        break;
      }
      case 'hit': {
        const o = this.strip(t, 0.5 * gm, pan, 0.1, 0.4);
        this.osc(o, 'sine', 150 * p, t, 0.16, { gain: 0.6, f1: 55 });
        this.noiseBurst(o, t, 0.1, { gain: 0.5, type: 'lowpass', f0: 1100, f1: 300, q: 0.8 });
        this.noiseBurst(o, t, 0.03, { gain: 0.2, type: 'bandpass', f0: 2000, q: 1.5 });
        break;
      }
      case 'miss': {
        const o = this.strip(t, 0.24 * gm, pan, 0.06, 0.4);
        this.noiseBurst(o, t, 0.24, { gain: 0.5, type: 'bandpass', f0: 500 * p, f1: 2600 * p, q: 1.6, attack: 0.09 });
        break;
      }
      case 'bow': {
        const o = this.strip(t, 0.5 * gm, pan, 0.12, 0.7);
        this.pluck(o, [100, 112, 125][Math.floor(Math.random() * 3)] * p, t, { gain: 0.8, dur: 0.5, damping: 0.985, bright: 0.85 });
        this.osc(o, 'triangle', 260 * p, t, 0.09, { gain: 0.2, f1: 150 });
        this.noiseBurst(o, t, 0.03, { gain: 0.25, type: 'bandpass', f0: 1800, q: 3 });
        break;
      }
      case 'arrowWhoosh': {
        const o = this.strip(t, 0.16 * gm, pan, 0.05, 0.4);
        this.noiseBurst(o, t, 0.3, { gain: 0.5, type: 'bandpass', f0: 3600, f1: 1400, q: 3, attack: 0.05 });
        break;
      }
      case 'arrowHit': {
        const o = this.strip(t, 0.35 * gm, pan, 0.08, 0.3);
        this.noiseBurst(o, t, 0.035, { gain: 0.5, type: 'bandpass', f0: 1300, q: 1.8 });
        this.osc(o, 'sine', 320, t, 0.06, { gain: 0.4, f1: 110 });
        break;
      }
      case 'magicCast': {
        const o = this.strip(t, 0.24 * gm, pan, 0.45, 1.4);
        const base = 880 * p;
        [1, 1.26, 1.5, 2].forEach((r, i) => {
          this.osc(o, 'sine', base * r, t + i * 0.035, 0.9, { gain: 0.16, attack: 0.12, vibrato: 6, vibRate: 7 });
        });
        this.noiseBurst(o, t, 0.6, { gain: 0.25, type: 'bandpass', f0: 400, f1: 5000, q: 2.5, attack: 0.3 });
        break;
      }
      case 'magicWhoosh': {
        const o = this.strip(t, 0.2 * gm, pan, 0.25, 0.6);
        this.noiseBurst(o, t, 0.4, { gain: 0.4, type: 'bandpass', f0: 700, f1: 3800, q: 3, attack: 0.1 });
        this.osc(o, 'triangle', 420 * p, t, 0.4, { gain: 0.15, f1: 1300 * p, attack: 0.05 });
        break;
      }
      case 'magicHit': {
        const o = this.strip(t, 0.32 * gm, pan, 0.35, 0.8);
        this.osc(o, 'sine', 1600 * p, t, 0.3, { gain: 0.35, f1: 260 });
        this.osc(o, 'square', 90, t, 0.18, { gain: 0.08, f1: 45 });
        this.noiseBurst(o, t, 0.25, { gain: 0.35, type: 'highpass', f0: 2500, q: 0.7 });
        this.bell(o, 1760 * p, t + 0.02, { gain: 0.06, decay: 0.6 });
        break;
      }
      case 'explosion': {
        const o = this.strip(t, 0.75 * gm, pan, 0.4, 2.2);
        this.osc(o, 'sine', 95, t, 1.0, { gain: 0.9, f1: 28, glide: 0.9 });
        this.noiseBurst(o, t, 1.3, { gain: 0.9, type: 'lowpass', f0: 2400, f1: 120, q: 0.6 });
        this.noiseBurst(o, t, 0.08, { gain: 0.6, type: 'highpass', f0: 1500 });
        for (let i = 0; i < 6; i++) this.noiseBurst(o, t + 0.1 + Math.random() * 0.6, 0.03, { gain: 0.18, type: 'highpass', f0: 3000 });
        break;
      }
      case 'lightning': {
        const o = this.strip(t, 0.7 * gm, pan, 0.4, 2.2);
        this.noiseBurst(o, t, 0.02, { gain: 1, type: 'highpass', f0: 800 });
        // crackle: a handful of very short bursts
        for (let i = 0; i < 10; i++) this.noiseBurst(o, t + 0.01 + i * rnd(0.012, 0.03), 0.02, { gain: rnd(0.3, 0.7), type: 'highpass', f0: rnd(1500, 5000) });
        this.noiseBurst(o, t + 0.04, 1.5, { gain: 0.7, type: 'lowpass', f0: 380, f1: 60, q: 0.8, attack: 0.08 });
        this.osc(o, 'sawtooth', 70, t, 0.4, { gain: 0.12, f1: 35 });
        break;
      }
      case 'heal': {
        const o = this.strip(t, 0.22 * gm, pan, 0.55, 2.0);
        [76, 80, 83, 88].forEach((m, i) => this.bell(o, midiToHz(m) * p, t + i * 0.075, { gain: 0.14, decay: 1.6 }));
        this.noiseBurst(o, t, 0.8, { gain: 0.08, type: 'highpass', f0: 6000, attack: 0.2 });
        break;
      }
      case 'bless': {
        const o = this.strip(t, 0.2 * gm, pan, 0.6, 2.2);
        [62, 66, 69, 74].forEach((m, i) => this.tone(o, 'sawtooth', midiToHz(m) * p, t + i * 0.04, 0.35, 0.5, 0.9, { gain: 0.05, filter: 1400, filterEnv: 900, vibrato: 7 }));
        this.bell(o, midiToHz(86), t + 0.3, { gain: 0.08, decay: 1.6 });
        break;
      }
      case 'haste': {
        const o = this.strip(t, 0.22 * gm, pan, 0.3, 1.0);
        for (let i = 0; i < 5; i++) this.osc(o, 'triangle', midiToHz(72 + i * 4) * p, t + i * 0.05, 0.18, { gain: 0.2 });
        this.noiseBurst(o, t, 0.35, { gain: 0.25, type: 'bandpass', f0: 1200, f1: 6000, q: 2, attack: 0.05 });
        break;
      }
      case 'farsight': {
        const o = this.strip(t, 0.2 * gm, pan, 0.6, 2.0);
        [69, 76, 81].forEach((m, i) => this.osc(o, 'sine', midiToHz(m), t + i * 0.12, 1.4, { gain: 0.15, attack: 0.25, vibrato: 4 }));
        break;
      }
      case 'summon': {
        const o = this.strip(t, 0.6 * gm, pan, 0.4, 2.4);
        this.noiseBurst(o, t, 1.4, { gain: 0.7, type: 'lowpass', f0: 90, f1: 700, q: 2, attack: 0.6 });
        this.osc(o, 'sawtooth', 45, t, 1.4, { gain: 0.2, f1: 90, attack: 0.5 });
        this.osc(o, 'sine', 120, t + 1.2, 0.5, { gain: 0.8, f1: 40 });
        this.noiseBurst(o, t + 1.2, 0.3, { gain: 0.5, type: 'lowpass', f0: 900, f1: 120 });
        break;
      }
      case 'hammer': {
        const o = this.strip(t, 0.32 * gm, pan, 0.18, 0.9);
        for (let i = 0; i < 3; i++) {
          const tt = t + i * rnd(0.19, 0.24);
          this.noiseBurst(o, tt, 0.03, { gain: 0.5, type: 'bandpass', f0: rnd(2000, 2800), q: 3 });
          this.osc(o, 'sine', rnd(620, 820), tt, 0.12, { gain: 0.35, f1: 380 });
          this.osc(o, 'sine', 140, tt, 0.07, { gain: 0.3, f1: 70 });
        }
        break;
      }
      case 'buildComplete': {
        const o = this.strip(t, 0.28 * gm, pan, 0.45, 1.8);
        this.noiseBurst(o, t, 0.03, { gain: 0.4, type: 'bandpass', f0: 2400, q: 3 });
        this.osc(o, 'sine', 700, t, 0.12, { gain: 0.3, f1: 380 });
        this.bell(o, midiToHz(84), t + 0.12, { gain: 0.14, decay: 1.4 });
        this.bell(o, midiToHz(91), t + 0.22, { gain: 0.1, decay: 1.4 });
        break;
      }
      case 'levelUp': {
        const o = this.strip(t, 0.3 * gm, pan, 0.4, 2.0);
        const notes: [number, number, number][] = [[67, 0, 0.09], [72, 0.11, 0.09], [76, 0.22, 0.09], [79, 0.33, 0.55]];
        for (const [m, dt, hold] of notes) this.brass(o, midiToHz(m) * p, t + dt, hold, { gain: 0.06 });
        this.bell(o, midiToHz(91), t + 0.34, { gain: 0.1, decay: 1.4 });
        this.noiseBurst(o, t + 0.33, 0.8, { gain: 0.08, type: 'highpass', f0: 7000, attack: 0.1 });
        break;
      }
      case 'turnHorn': {
        const o = this.strip(t, 0.34 * gm, pan, 0.6, 2.6);
        this.brass(o, midiToHz(50), t, 0.5, { gain: 0.08, bright: 0.45, release: 0.4 });
        this.brass(o, midiToHz(57), t + 0.55, 0.8, { gain: 0.08, bright: 0.5, release: 0.8 });
        this.tone(o, 'sine', midiToHz(38), t, 0.2, 1.1, 0.8, { gain: 0.12 });
        break;
      }
      case 'victory': {
        const o = this.strip(t, 0.34 * gm, pan, 0.55, 4.5);
        const seq: [number[], number, number][] = [
          [[60, 64, 67], 0, 0.14], [[60, 64, 67], 0.2, 0.14], [[62, 65, 69], 0.4, 0.14], [[64, 67, 72], 0.6, 1.6],
        ];
        for (const [chord, dt, hold] of seq) for (const m of chord) this.brass(o, midiToHz(m), t + dt, hold, { gain: 0.05, release: 0.9 });
        this.osc(o, 'sine', 90, t + 0.6, 1.2, { gain: 0.7, f1: 45 });
        this.noiseBurst(o, t + 0.6, 0.5, { gain: 0.3, type: 'lowpass', f0: 600, f1: 100 });
        [84, 88, 91, 96].forEach((m, i) => this.bell(o, midiToHz(m), t + 0.7 + i * 0.09, { gain: 0.08, decay: 2 }));
        break;
      }
      case 'defeat': {
        const o = this.strip(t, 0.34 * gm, pan, 0.65, 5);
        const seq: [number, number, number][] = [[57, 0, 0.5], [53, 0.6, 0.5], [50, 1.2, 1.8]];
        for (const [m, dt, hold] of seq) {
          this.brass(o, midiToHz(m), t + dt, hold, { gain: 0.07, bright: 0.35, release: 1.2 });
          this.brass(o, midiToHz(m - 12), t + dt, hold, { gain: 0.05, bright: 0.3, release: 1.2 });
        }
        for (const dt of [0, 0.6, 1.2]) this.osc(o, 'sine', 70, t + dt, 0.9, { gain: 0.5, f1: 38 });
        break;
      }
      case 'death': {
        const o = this.strip(t, 0.3 * gm, pan, 0.25, 1.2);
        this.tone(o, 'sawtooth', 200 * p, t, 0.03, 0.15, 0.5, { gain: 0.12, filter: 700 });
        this.osc(o, 'sawtooth', 190 * p, t + 0.05, 0.6, { gain: 0.1, f1: 70 * p });
        this.osc(o, 'sine', 110, t + 0.45, 0.25, { gain: 0.6, f1: 45 });
        this.noiseBurst(o, t + 0.45, 0.25, { gain: 0.45, type: 'lowpass', f0: 800, f1: 150 });
        break;
      }
      case 'spawn': {
        const o = this.strip(t, 0.24 * gm, pan, 0.35, 1.0);
        this.noiseBurst(o, t, 0.5, { gain: 0.35, type: 'bandpass', f0: 400, f1: 3200, q: 2, attack: 0.25 });
        this.osc(o, 'triangle', 330 * p, t, 0.5, { gain: 0.2, f1: 880 * p, attack: 0.2 });
        this.bell(o, midiToHz(84) * p, t + 0.45, { gain: 0.07, decay: 0.8 });
        break;
      }
      case 'coin': {
        const o = this.strip(t, 0.22 * gm, pan, 0.2, 0.6);
        this.osc(o, 'triangle', 1976 * p, t, 0.12, { gain: 0.35 });
        this.osc(o, 'triangle', 2637 * p, t + 0.07, 0.35, { gain: 0.35 });
        break;
      }
      case 'research': {
        const o = this.strip(t, 0.24 * gm, pan, 0.55, 2.0);
        [69, 73, 76, 81].forEach((m, i) => this.bell(o, midiToHz(m), t + i * 0.1, { gain: 0.13, decay: 1.8 }));
        break;
      }
      case 'capture': {
        const o = this.strip(t, 0.28 * gm, pan, 0.4, 1.6);
        for (let i = 0; i < 6; i++) this.noiseBurst(o, t + i * 0.055, 0.05, { gain: 0.25, type: 'bandpass', f0: rnd(500, 900), q: 1.2 });
        this.brass(o, midiToHz(62), t + 0.25, 0.35, { gain: 0.06, bright: 0.6 });
        this.brass(o, midiToHz(69), t + 0.25, 0.35, { gain: 0.05, bright: 0.6 });
        break;
      }
      case 'equip': {
        const o = this.strip(t, 0.26 * gm, pan, 0.12, 0.5);
        this.noiseBurst(o, t, 0.09, { gain: 0.4, type: 'bandpass', f0: 1400, q: 1.2 });
        this.metal(o, 2400 * p, t + 0.05, { gain: 0.08, decay: 0.25 });
        break;
      }
      case 'craft': {
        const o = this.strip(t, 0.3 * gm, pan, 0.3, 1.4);
        for (const dt of [0, 0.26]) {
          this.metal(o, rnd(780, 900), t + dt, { gain: 0.2, decay: 0.7 });
          this.noiseBurst(o, t + dt, 0.04, { gain: 0.35, type: 'highpass', f0: 3000 });
        }
        this.noiseBurst(o, t + 0.27, 0.4, { gain: 0.08, type: 'highpass', f0: 7000 });
        break;
      }
      case 'poison': {
        const o = this.strip(t, 0.2 * gm, pan, 0.15, 0.6);
        for (let i = 0; i < 4; i++) this.osc(o, 'sine', rnd(260, 520), t + i * 0.06, 0.08, { gain: 0.3, f1: rnd(500, 900) });
        break;
      }
      case 'destroy': {
        const o = this.strip(t, 0.55 * gm, pan, 0.4, 2.0);
        this.noiseBurst(o, t, 1.2, { gain: 0.8, type: 'lowpass', f0: 1800, f1: 90, q: 0.5 });
        this.osc(o, 'sine', 80, t, 0.8, { gain: 0.6, f1: 32 });
        for (let i = 0; i < 8; i++) this.noiseBurst(o, t + 0.1 + Math.random() * 0.8, 0.05, { gain: 0.2, type: 'bandpass', f0: rnd(400, 1600), q: 2 });
        break;
      }
    }
  }

  /** Dev/test: bind this engine to an OfflineAudioContext. */
  attachOffline(ctx: OfflineAudioContext): void {
    this.offline = true;
    this.create(ctx);
    this.unlocked = true;
  }
}

/** Shared engine (sfx + music). */
export const audio = new AudioEngine();

/**
 * Dev/test helper: render sounds offline and report peak / RMS / NaN so the sound design can
 * be verified without listening (used from the browser console).
 */
export async function debugRenderSfx(names: SfxName[], seconds = 3): Promise<Record<string, { peak: number; rms: number; bad: boolean }>> {
  const out: Record<string, { peak: number; rms: number; bad: boolean }> = {};
  for (const name of names) {
    const sr = 44100;
    const off = new OfflineAudioContext(2, sr * seconds, sr);
    const eng = new AudioEngine();
    eng.attachOffline(off);
    eng.play(name);
    const buf = await off.startRendering();
    let peak = 0, sum = 0, bad = false;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (!Number.isFinite(v)) { bad = true; continue; }
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sum += v * v;
      }
    }
    out[name] = { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / (buf.length * buf.numberOfChannels)).toFixed(4), bad };
  }
  return out;
}

export function playSfx(name: SfxName, opts?: PlayOpts): void {
  audio.play(name, opts);
}
