#!/usr/bin/env node
// Browser verification against real GLBs and WebGL. Uses an existing, isolated CDP browser.
// CDP_PORT=19479 node tools/verify-characters.mjs http://127.0.0.1:5197/characters.html ../playtest/characters
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5197/characters.html';
const out = resolve(process.argv[3] ?? '../playtest/characters');
await mkdir(out, { recursive: true });
const host = `http://127.0.0.1:${process.env.CDP_PORT ?? 19479}`;
const tabs = await (await fetch(`${host}/json`)).json();
const page = tabs.find((t) => t.type === 'page');
assert(page, 'Start a dedicated CDP browser first');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (event) => {
  const value = JSON.parse(event.data);
  if (value.id) {
    const handler = pending.get(value.id);
    if (!handler) return;
    pending.delete(value.id);
    value.error ? handler.reject(new Error(JSON.stringify(value.error))) : handler.resolve(value.result);
  } else if (value.method === 'Runtime.exceptionThrown') {
    errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
  } else if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') {
    errors.push(value.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
function send(method, params = {}) {
  const key = ++id;
  ws.send(JSON.stringify({ id: key, method, params }));
  return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); });
}
async function evaluate(expression) {
  const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expression, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expression)) return; } catch { /* navigating */ }
    await pause(150);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function shot(name, canvasOnly = true) {
  const clip = canvasOnly ? await evaluate('(() => {const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()') : undefined;
  const value = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  await writeFile(resolve(out, `${name}.png`), Buffer.from(value.data, 'base64'));
}
const checks = [];
async function set(draft, name, camera = 'full', capture = false) {
  await evaluate(`window.__characterStudio.setState(${JSON.stringify(draft)});window.__characterStudio.focus(${JSON.stringify(camera)})`);
  await pause(160);
  const stats = await evaluate('window.__characterStudio.stats');
  assert.deepEqual(stats.missing, [], `${name}: assets missing`);
  assert(stats.triangles > 10000 && stats.meshes > 1, `${name}: real character geometry missing`);
  checks.push({ name, body: stats.bodyKey, triangles: stats.triangles });
  if (capture) await shot(name);
  return stats;
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await waitFor('window.__characterStudio?.ready');
  const initial = await evaluate('window.__characterStudio.state');
  const { HAIR_STYLES, BEARDS, HAIR_COLORS, SKIN_TONES, EYE_COLORS } = await evaluate(`(async()=>{const m=await import('/src/data/appearance.ts');return {HAIR_STYLES:m.HAIR_STYLES,BEARDS:m.BEARDS,HAIR_COLORS:m.HAIR_COLORS,SKIN_TONES:m.SKIN_TONES,EYE_COLORS:m.EYE_COLORS}})()`);
  for (const gender of ['male', 'female']) {
    const base = { ...initial, gender, look: { ...initial.look, hair: gender === 'male' ? 'swept' : 'braid', beard: gender === 'male' ? 'short' : 'none', face: 0, skin: 'warm' } };
    for (const [armor, suffix] of [[null, 'commoner'], ['tunic', 'padded'], ['leather', 'light'], ['plate', 'heavy'], ['robe', 'robe']]) {
      const draft = { ...base, equipment: { ...base.equipment, body: armor } };
      const stats = await set(draft, `${gender}-${suffix}`, 'full', true);
      // Equipment must remain an attachment on the same continuous body.
      assert.equal(stats.bodyKey, `human_${gender === 'male' ? 'm' : 'f'}_base`);
      await evaluate('window.__characterStudio.play("walk")');
      await pause(450);
      await shot(`${gender}-${suffix}-walk`);
      checks.push({ name: `${gender}-${suffix}-walk-fit` });
      await evaluate('window.__characterStudio.play("idle")');
    }
    for (let face = 0; face < 3; face++) await set({ ...base, look: { ...base.look, face } }, `${gender}-face-${face + 1}`, 'face', true);
    for (const hair of HAIR_STYLES.filter((h) => h.genders.includes(gender))) await set({ ...base, look: { ...base.look, hair: hair.id } }, `${gender}-hair-${hair.id}`);
    if (gender === 'male') for (const beard of BEARDS) await set({ ...base, look: { ...base.look, beard: beard.id } }, `beard-${beard.id}`);
  }
  const portrait = { ...initial, look: { ...initial.look, face: 0, hair: 'bun' }, equipment: { main: null, off: null, body: null, trinket: null, mount: null } };
  for (const tone of SKIN_TONES) await set({ ...portrait, look: { ...portrait.look, skin: tone.id } }, `skin-${tone.id}`, 'face', true);
  for (const color of HAIR_COLORS) await set({ ...initial, look: { ...initial.look, hairColor: color.id } }, `hair-color-${color.id}`);
  for (const color of EYE_COLORS) await set({ ...initial, look: { ...initial.look, eyes: color.id } }, `eyes-${color.id}`);
  for (const main of ['tools', 'sword', 'axe', 'spear', 'bow', 'staff', 'wand']) {
    await set({ ...initial, equipment: { ...initial.equipment, main, off: ['tools','sword','wand'].includes(main) ? 'shield' : null } }, `weapon-${main}`);
  }
  await set(initial, 'final', 'full');
  for (const clip of ['idle', 'walk', 'attack_melee', 'attack_ranged', 'cast', 'work', 'hit', 'death']) {
    await evaluate(`window.__characterStudio.play(${JSON.stringify(clip)})`);
    await pause(180);
    checks.push({ name: `animation-${clip}` });
  }
  await evaluate('window.__characterStudio.play("idle")');
  // Exercise actual UI controls, including persistence restoration.
  await evaluate('document.querySelector(".gold-button").click()');
  const changed = { ...initial, name: 'Temporary' };
  await set(changed, 'before-load');
  await evaluate('document.querySelector(".quiet-button").click()');
  await pause(150);
  assert.deepEqual(await evaluate('window.__characterStudio.state'), initial, 'Load restores the saved character');
  checks.push({ name: 'UI save/load roundtrip' });
  await evaluate(`(()=>{const field=document.querySelector('[aria-label="Main hand"]');field.value='bow';field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await pause(150);
  assert.equal((await evaluate('window.__characterStudio.state')).equipment.off, null, 'Selecting a bow removes its incompatible shield');
  checks.push({ name: 'UI two-handed equipment rule' });
  await set(initial, 'final-preview');
  await evaluate('document.querySelector(".forge-toast button")?.click()');
  await pause(500);
  await shot('studio', false);
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'Desktop has no horizontal overflow');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'Mobile has no horizontal overflow');
  await shot('mobile', false);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(errors, [], 'No WebGL shader errors or browser exceptions');
  const report = { url, timestamp: new Date().toISOString(), checks: checks.length, cases: checks, errors };
  await writeFile(resolve(out, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(`PASS ${checks.length} browser checks; screenshots and report: ${out}`);
} finally { ws.close(); }
