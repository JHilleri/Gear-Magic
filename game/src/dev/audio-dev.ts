// Dev page (dev/audio.html): audition every recorded SFX take against the procedural version, and
// drive the music engine through its moods.
import { audio, playSfx, type SfxName } from '../audio/sfx';
import { music } from '../audio/music';
import { audioUrl, loadAudioManifest } from '../audio/samples';

const ALL: SfxName[] = [
  'click', 'hover', 'select', 'deselect', 'error', 'modalOpen', 'modalClose', 'step', 'clash', 'hit', 'miss', 'bow',
  'arrowWhoosh', 'arrowHit', 'magicCast', 'magicWhoosh', 'magicHit', 'explosion', 'lightning', 'heal', 'bless', 'haste',
  'summon', 'farsight', 'hammer', 'buildComplete', 'levelUp', 'turnHorn', 'victory', 'defeat', 'death', 'spawn', 'coin',
  'research', 'capture', 'equip', 'craft', 'poison', 'destroy',
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const button = (text: string, cls: string, fn: () => void) => {
  const b = el('button', text, cls);
  b.onclick = fn;
  return b;
};

audio.setVolume(0.8);
audio.installUnlock();
music.setMood('title');
music.start();
(window as any).audioDev = { audio, music, playSfx };

const m = document.getElementById('music')!;
m.append(
  button('Title', '', () => music.setMood('title')),
  button('Game', '', () => music.setMood('game')),
  button('Battle (pulse +0.6)', '', () => { music.setMood('game'); music.pulse(0.6); }),
  button('Duck 6 s', '', () => music.duck(6)),
  button('Music on/off', '', () => music.setEnabled(!music.isEnabled())),
);
setInterval(() => { document.getElementById('state')!.textContent = JSON.stringify(music.state); }, 500);

let preview: HTMLAudioElement | null = null;
const listen = (file: string) => {
  preview?.pause();
  preview = new Audio(audioUrl(file));
  void preview.play();
};

void loadAudioManifest().then((man) => {
  const tracks = document.getElementById('tracks')!;
  for (const [mood, files] of Object.entries(man?.music ?? {})) {
    for (const f of files ?? []) {
      const row = el('div');
      const a = el('audio');
      a.controls = true;
      a.preload = 'none';
      a.src = audioUrl(f);
      row.append(el('span', `${mood}: ${f.split('/').pop()}`), a);
      tracks.append(row);
    }
  }
  const table = document.getElementById('sfx')!;
  for (const name of ALL) {
    const tr = el('tr');
    const td = el('td');
    td.append(
      button('game', 'game', () => { audio.samples.disabled = false; playSfx(name); }),
      button('synth', 'synth', () => { audio.samples.disabled = true; playSfx(name); audio.samples.disabled = false; }),
    );
    (man?.sfx[name] ?? []).forEach((f, i) => td.append(button(String(i + 1), '', () => listen(f))));
    tr.append(el('td', name), td);
    table.append(tr);
  }
});
