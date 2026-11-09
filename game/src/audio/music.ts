// Generative medieval-fantasy soundtrack (WebAudio, no files).
// Layers: low drone, slow detuned string pad with voice-led chords, a plucked lute
// (Karplus–Strong) arpeggiating the chord, an occasional recorder melody, and a frame drum +
// shaker that fade in with `intensity` (raised by combat via `pulse`).
// A lookahead scheduler places notes bar by bar on the AudioContext clock.
import { audio, midiToHz } from './sfx';

export type MusicMood = 'title' | 'game' | 'tension';

const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], sus2: [0, 2, 7], sus4: [0, 5, 7], m7: [0, 3, 7, 10], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
};

interface Chord { name: string; root: number; ints: number[] }

function parseChord(name: string): Chord {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(name);
  if (!m) throw new Error(`bad chord ${name}`);
  return { name, root: PC[m[1]], ints: QUALITIES[m[2]] ?? QUALITIES[''] };
}

// Progressions in D (dorian / aeolian colours; A major for a harmonic-minor cadence).
const PROGRESSIONS: Record<MusicMood, string[][]> = {
  title: [
    ['Dm', 'Bb', 'F', 'C'], ['Dm', 'Bb', 'C', 'A'], ['F', 'C', 'Dm', 'Bb'], ['Gm', 'Bb', 'C', 'Dm'], ['Dmadd9', 'C', 'Bb', 'A'],
  ],
  game: [
    ['Dm', 'C', 'Bb', 'C'], ['Dm', 'Am', 'Bb', 'F'], ['F', 'C', 'Dm', 'Dm'], ['Dm', 'G', 'Dm', 'C'],
    ['Bb', 'F', 'C', 'Dm'], ['Gm', 'Dm', 'Csus2', 'Dm'], ['Dmadd9', 'C', 'G', 'Dm'], ['Am', 'Dm', 'F', 'Gsus2'],
  ],
  tension: [
    ['Dm', 'Bb', 'Gm', 'A'], ['Dm', 'C', 'Bb', 'A'], ['Gm', 'Dm', 'Eb', 'A'], ['Dm', 'Eb', 'Dm', 'A'],
  ],
};

// Lute arpeggio patterns: indices into the chord's upward tone ladder, -1 = rest (8 eighths per bar).
const ARP_PATTERNS: number[][] = [
  [0, 2, 1, 2, 3, 2, 1, 2],
  [0, -1, 2, 1, 3, -1, 2, 1],
  [0, 1, 2, 3, 4, 3, 2, 1],
  [0, -1, 1, -1, 2, 3, 2, -1],
  [0, 2, 4, 2, 3, 1, 2, -1],
  [0, -1, -1, 2, 1, -1, 3, -1],
];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const choice = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

class MusicEngine {
  private enabled = true;
  private mood: MusicMood = 'title';
  private intensity = 0;             // 0..1, decays over time
  private timer: ReturnType<typeof setInterval> | null = null;
  private session: GainNode | null = null;
  private nextBar = 0;               // ctx time of the next bar to schedule
  private barInSlot = 0;             // 0..1 (each chord lasts two bars)
  private chordIdx = 0;
  private progression: Chord[] = [];
  private voicing: number[] = [62, 65, 69];
  private melodyActive = false;
  private lastTick = 0;
  private duckUntil = 0;
  private bpm = 66;
  private switchPending = false;

  /** Begin (or keep) playing once audio is unlocked. */
  start(): void {
    audio.onUnlock(() => this.resume());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.start();
    else this.fadeOut();
  }

  isEnabled(): boolean { return this.enabled; }

  setMood(m: MusicMood): void {
    if (m === this.mood) return;
    this.mood = m;
    this.switchPending = true; // new progression at the next chord boundary
  }

  /** Combat or other excitement: raise intensity (drums fade in). */
  pulse(amount = 0.25): void {
    this.intensity = Math.min(1, this.intensity + amount);
  }

  /** Lower the music for a few seconds (under stingers). */
  duck(seconds: number): void {
    const ctx = audio.ctx;
    if (!ctx || !this.session) return;
    const now = ctx.currentTime;
    this.duckUntil = Math.max(this.duckUntil, now + seconds);
    this.session.gain.cancelScheduledValues(now);
    this.session.gain.setTargetAtTime(0.15, now, 0.15);
    this.session.gain.setTargetAtTime(1, this.duckUntil, 1.2);
  }

  private resume(): void {
    const ctx = audio.ctx;
    if (!ctx || !this.enabled || this.timer) return;
    this.session = ctx.createGain();
    this.session.gain.setValueAtTime(0, ctx.currentTime);
    this.session.gain.linearRampToValueAtTime(1, ctx.currentTime + 3);
    this.session.connect(audio.musicBus);
    this.nextBar = ctx.currentTime + 0.3;
    this.barInSlot = 0;
    this.chordIdx = 0;
    this.progression = [];
    this.lastTick = ctx.currentTime;
    this.timer = setInterval(() => this.tick(), 120);
  }

  private fadeOut(): void {
    const ctx = audio.ctx;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!ctx || !this.session) return;
    const s = this.session;
    this.session = null;
    const now = ctx.currentTime;
    s.gain.cancelScheduledValues(now);
    s.gain.setValueAtTime(s.gain.value, now);
    s.gain.linearRampToValueAtTime(0, now + 1.5);
    // notes already scheduled for this session keep running silently, then are dropped
    setTimeout(() => { try { s.disconnect(); } catch { /* */ } }, 12000);
  }

  private tick(): void {
    const ctx = audio.ctx;
    if (!ctx || !this.session || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    this.intensity = Math.max(0, this.intensity - dt * 0.018);
    // If we fell behind (tab throttled), skip ahead rather than burst-scheduling.
    if (this.nextBar < now) this.nextBar = now + 0.1;
    while (this.nextBar < now + 0.8) {
      try { this.scheduleBar(this.nextBar); } catch (e) { console.warn('[music] schedule failed', e); }
      this.nextBar += this.barLen();
    }
  }

  private beat(): number { return 60 / this.bpm; }
  private barLen(): number { return this.beat() * 4; }

  private effectiveMood(): MusicMood {
    if (this.mood === 'game' && this.intensity > 0.55) return 'tension';
    return this.mood;
  }

  private scheduleBar(t: number): void {
    const out = this.session!;
    if (this.barInSlot === 0) {
      if (this.switchPending || this.chordIdx >= this.progression.length) {
        this.switchPending = false;
        this.progression = choice(PROGRESSIONS[this.effectiveMood()]).map(parseChord);
        this.chordIdx = 0;
        this.melodyActive = Math.random() < (this.mood === 'title' ? 0.7 : 0.45);
        this.bpm = this.mood === 'title' ? 62 : 66 + Math.round(this.intensity * 8);
      }
      const chord = this.progression[this.chordIdx];
      this.voicing = this.voiceLead(chord, this.voicing);
      this.schedulePad(out, chord, t, this.barLen() * 2);
      this.scheduleDrone(out, chord, t, this.barLen() * 2);
    }
    const chord = this.progression[this.chordIdx];
    this.scheduleLute(out, chord, t);
    if (this.melodyActive && (this.barInSlot === 0 || Math.random() < 0.5)) this.scheduleMelody(out, chord, t);
    if (this.intensity > 0.25 || (this.mood === 'title' && this.barInSlot === 1 && Math.random() < 0.3)) {
      this.schedulePercussion(out, t, this.intensity);
    }
    this.barInSlot++;
    if (this.barInSlot >= 2) { this.barInSlot = 0; this.chordIdx++; }
  }

  /** Choose the inversion (within F3..A4) closest to the previous voicing. */
  private voiceLead(chord: Chord, prev: number[]): number[] {
    const pcs = chord.ints.slice(0, 3).map((i) => (chord.root + i) % 12);
    if (chord.ints.length > 3) pcs.push((chord.root + chord.ints[3]) % 12);
    let best: number[] = [];
    let bestCost = Infinity;
    const prevAvg = prev.reduce((a, b) => a + b, 0) / prev.length;
    for (let low = 53; low <= 64; low++) {
      if (!pcs.includes(low % 12)) continue;
      const v: number[] = [low];
      let cur = low;
      // stack the remaining pitch classes upward in order of the chord ladder
      const start = pcs.indexOf(low % 12);
      for (let k = 1; k < pcs.length; k++) {
        const pc = pcs[(start + k) % pcs.length];
        let n = cur + 1;
        while (n % 12 !== pc) n++;
        v.push(n);
        cur = n;
      }
      if (cur > 76) continue;
      const avg = v.reduce((a, b) => a + b, 0) / v.length;
      const cost = Math.abs(avg - prevAvg) + Math.abs(avg - 62) * 0.3 + Math.random() * 0.8;
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
    return best.length ? best : [50 + chord.root, 54 + chord.root, 57 + chord.root];
  }

  private schedulePad(out: AudioNode, chord: Chord, t: number, dur: number): void {
    const ctx = audio.ctx!;
    const bus = ctx.createGain();
    bus.gain.value = 0.9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.6;
    const cutoff = 650 + this.intensity * 700 + (this.mood === 'title' ? 250 : 0);
    lp.frequency.setValueAtTime(cutoff * 0.7, t);
    lp.frequency.linearRampToValueAtTime(cutoff * 1.25, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(cutoff * 0.8, t + dur + 2);
    lp.connect(bus);
    bus.connect(out);
    const rev = ctx.createGain();
    rev.gain.value = 0.7;
    bus.connect(rev).connect(audio.reverbSend);
    const attack = 2.2, release = 3.2;
    const hold = Math.max(0.2, dur - attack + 0.4);
    for (const m of this.voicing) {
      const f = midiToHz(m);
      for (const det of [-8, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det + rnd(-2, 2);
        const g = ctx.createGain();
        const peak = 0.022;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + attack);
        g.gain.setValueAtTime(peak, t + attack + hold);
        g.gain.linearRampToValueAtTime(0, t + attack + hold + release);
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(t + attack + hold + release + 0.1);
      }
      // soft sine an octave up for air
      const s = ctx.createOscillator();
      s.type = 'sine';
      s.frequency.value = f * 2;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0, t);
      sg.gain.linearRampToValueAtTime(0.008, t + attack * 1.4);
      sg.gain.linearRampToValueAtTime(0, t + attack + hold + release);
      s.connect(sg).connect(bus);
      s.start(t);
      s.stop(t + attack + hold + release + 0.1);
    }
    setTimeout(() => { try { bus.disconnect(); rev.disconnect(); } catch { /* */ } }, (t - ctx.currentTime + dur + 8) * 1000);
  }

  private scheduleDrone(out: AudioNode, chord: Chord, t: number, dur: number): void {
    const ctx = audio.ctx!;
    const root = 38 + ((chord.root - 2 + 12) % 12); // around D2
    const bassNote = root > 45 ? root - 12 : root;
    for (const [m, gain, type] of [[bassNote, 0.07, 'triangle'], [bassNote + 7, 0.025, 'sine'], [bassNote - 12, 0.04, 'sine']] as [number, number, OscillatorType][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = midiToHz(m);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 1.6);
      g.gain.setValueAtTime(gain, t + dur - 0.4);
      g.gain.linearRampToValueAtTime(0, t + dur + 2);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 2.1);
    }
  }

  private scheduleLute(out: AudioNode, chord: Chord, t: number): void {
    const ctx = audio.ctx!;
    // Body resonances + gentle lowpass give the plucked string a lute-like timbre.
    const body1 = ctx.createBiquadFilter();
    body1.type = 'peaking'; body1.frequency.value = 260; body1.Q.value = 1.2; body1.gain.value = 5;
    const body2 = ctx.createBiquadFilter();
    body2.type = 'peaking'; body2.frequency.value = 2400; body2.Q.value = 1.5; body2.gain.value = 3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4200;
    const g = ctx.createGain();
    g.gain.value = 0.55;
    body1.connect(body2).connect(lp).connect(g).connect(out);
    const rev = ctx.createGain();
    rev.gain.value = 0.45;
    g.connect(rev).connect(audio.reverbSend);

    // Ladder of chord tones from around D4 upward.
    const base = 50 + chord.root + (chord.root < 5 ? 12 : 0);
    const ladder: number[] = [];
    for (let oct = 0; oct < 3; oct++) for (const i of chord.ints.slice(0, 3)) ladder.push(base + i + oct * 12);
    ladder.sort((a, b) => a - b);
    const pattern = choice(ARP_PATTERNS);
    const density = this.mood === 'title' ? 0.85 : 0.6 + this.intensity * 0.35;
    const eighth = this.beat() / 2;
    for (let i = 0; i < 8; i++) {
      const idx = pattern[i];
      if (idx < 0) continue;
      if (i > 0 && Math.random() > density) continue;
      const m = ladder[Math.min(ladder.length - 1, idx + (Math.random() < 0.12 ? 2 : 0))];
      const swing = i % 2 === 1 ? eighth * 0.08 : 0;
      const tt = t + i * eighth + swing + rnd(-0.008, 0.012);
      const vel = (i === 0 ? 0.5 : i === 4 ? 0.4 : 0.28) * rnd(0.8, 1.1);
      audio.pluck(body1, midiToHz(m), tt, { gain: vel, dur: 1.5, damping: 0.995, bright: 0.45 });
    }
    // bass pluck on beat 1
    audio.pluck(body1, midiToHz(base - 12), t + rnd(0, 0.01), { gain: 0.45, dur: 1.8, damping: 0.996, bright: 0.3 });
    setTimeout(() => { try { g.disconnect(); rev.disconnect(); } catch { /* */ } }, (t - ctx.currentTime + this.barLen() + 6) * 1000);
  }

  /** Recorder-like melody: sine + soft triangle + breath noise, vibrato. */
  private scheduleMelody(out: AudioNode, chord: Chord, t: number): void {
    const ctx = audio.ctx!;
    const chordPcs = chord.ints.map((i) => (chord.root + i) % 12);
    // D dorian, raised C# when the chord is A major (harmonic-minor colour)
    const scale = chordPcs.includes(1) ? [2, 4, 5, 7, 9, 10, 1] : [2, 4, 5, 7, 9, 11, 0];
    const notes: number[] = [];
    for (let m = 67; m <= 86; m++) if (scale.includes(m % 12)) notes.push(m);
    const rhythms = [[2, 1, 1], [1, 1, 2], [3, 1], [1.5, 0.5, 2], [2, 2], [4]];
    const rhythm = choice(rhythms);
    let beatPos = 0;
    let cur = notes.findIndex((m) => chordPcs.includes(m % 12) && m >= 72);
    if (cur < 0) cur = Math.floor(notes.length / 2);
    const bus = ctx.createGain();
    bus.gain.value = this.mood === 'title' ? 0.06 : 0.045;
    bus.connect(out);
    const rev = ctx.createGain();
    rev.gain.value = 0.9;
    bus.connect(rev).connect(audio.reverbSend);
    for (const beats of rhythm) {
      if (Math.random() < 0.15 && beatPos > 0) { beatPos += beats; continue; } // breath
      // step-wise motion, landing on chord tones on strong beats
      cur = Math.max(0, Math.min(notes.length - 1, cur + choice([-2, -1, -1, 1, 1, 2, 0])));
      if (beatPos % 2 === 0) {
        for (let k = 0; k < 3 && !chordPcs.includes(notes[cur] % 12); k++) cur = Math.min(notes.length - 1, cur + 1);
      }
      const f = midiToHz(notes[cur]);
      const tt = t + beatPos * this.beat() + rnd(0, 0.02);
      const dur = beats * this.beat() * 0.95;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = f * 2;
      const g2 = ctx.createGain();
      g2.gain.value = 0.12;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, tt);
      lg.gain.linearRampToValueAtTime(f * 0.006, tt + dur);
      lfo.connect(lg).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(1, tt + 0.06);
      g.gain.setValueAtTime(0.85, tt + dur * 0.7);
      g.gain.linearRampToValueAtTime(0, tt + dur + 0.12);
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(bus);
      audio.noiseBurst(bus, tt, 0.09, { gain: 0.25, type: 'bandpass', f0: f * 2, q: 6, attack: 0.02 });
      for (const n of [o, o2, lfo]) { n.start(tt); n.stop(tt + dur + 0.2); }
      beatPos += beats;
    }
    setTimeout(() => { try { bus.disconnect(); rev.disconnect(); } catch { /* */ } }, (t - ctx.currentTime + this.barLen() + 6) * 1000);
  }

  /** Frame drum on 1 & 3 (+ ghost notes), shaker on off-beats at higher intensity. */
  private schedulePercussion(out: AudioNode, t: number, intensity: number): void {
    const ctx = audio.ctx!;
    const bus = ctx.createGain();
    bus.gain.value = Math.min(1, 0.35 + intensity * 0.8);
    bus.connect(out);
    const rev = ctx.createGain();
    rev.gain.value = 0.3;
    bus.connect(rev).connect(audio.reverbSend);
    const beat = this.beat();
    const drum = (tt: number, vel: number) => {
      audio.osc(bus, 'sine', 120, tt, 0.45, { gain: 0.5 * vel, f1: 52, glide: 0.25 });
      audio.noiseBurst(bus, tt, 0.12, { gain: 0.18 * vel, type: 'lowpass', f0: 700, f1: 200 });
    };
    drum(t, 1);
    drum(t + beat * 2, 0.8);
    if (intensity > 0.45) {
      drum(t + beat * 2.5, 0.35);
      drum(t + beat * 3.5, 0.45);
    }
    if (intensity > 0.6) {
      for (let i = 0; i < 8; i++) {
        audio.noiseBurst(bus, t + i * beat / 2 + beat / 4, 0.05, { gain: (i % 2 ? 0.05 : 0.08), type: 'highpass', f0: 6500, attack: 0.01 });
      }
    }
    setTimeout(() => { try { bus.disconnect(); rev.disconnect(); } catch { /* */ } }, (t - ctx.currentTime + this.barLen() + 4) * 1000);
  }
}

export const music = new MusicEngine();
