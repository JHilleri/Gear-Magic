#!/usr/bin/env node
// Minimal Chrome DevTools Protocol driver for playtesting in a headless Brave/Chromium.
//
// Start the browser once (hardware WebGL on the real GPU by default; CDP_GL=swiftshader for software):
//   CDP_PORT=9341 node tools/cdp.mjs launch   # headless Brave on that port (default 9339), 1600x900
//   (use a distinct CDP_PORT per agent/session; each port has its own profile and page)
//   node tools/cdp.mjs kill
// Then run step lists against the (single) page — the page persists between invocations:
//   node tools/cdp.mjs run '[["goto","http://127.0.0.1:5180"],["wait",3000],["shot","/abs/out.png"]]'
// Steps:
//   ["goto", url]                 navigate and wait for load
//   ["wait", ms]
//   ["waitFor", jsExpr, timeoutMs] poll until expression is truthy
//   ["eval", jsExpr]              print the JSON result
//   ["click", x, y, button?]      mouse click at CSS pixel (button: left|right|middle)
//   ["move", x, y]                mouse move
//   ["drag", x1, y1, x2, y2, button?]
//   ["wheel", x, y, deltaY]
//   ["key", key]                  e.g. "Enter", "Escape", " ", "Tab", "b"
//   ["type", text]
//   ["shot", path, scale?]        PNG screenshot (scale < 1 shrinks)
//   ["console"]                   print console messages/errors collected so far (this invocation, plus page-stored ones)
// Console errors and exceptions during the run are always printed at the end.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9339);
const BROWSER = process.env.CDP_BROWSER || '/snap/bin/brave';
const PROFILE = `${process.env.HOME}/snap/brave/common/claude-aether-profile-${PORT}`;
// CDP_GL selects the WebGL backend: gpu (default: the real graphics card, ANGLE on GL/EGL) or
// swiftshader (CPU software rendering: works anywhere, but only a few frames per second and heavy on the CPU).
const GL = process.env.CDP_GL || 'gpu';
// Hardware WebGL in headless mode: ANGLE over the host's Mesa EGL. Mesa's Wayland EGL platform has no
// offscreen configs, so the browser is started without WAYLAND_DISPLAY and with a surfaceless EGL platform.
const GL_FLAGS = {
  gpu: ['--use-gl=angle', '--use-angle=gl-egl'],
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
}[GL] ?? (() => { throw new Error(`CDP_GL must be gpu or swiftshader (got ${GL})`); })();
function launchEnv() {
  const env = { ...process.env };
  if (GL === 'gpu') { delete env.WAYLAND_DISPLAY; env.EGL_PLATFORM = 'surfaceless'; }
  return env;
}

async function launch() {
  const args = [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--ignore-gpu-blocklist',
    ...GL_FLAGS, '--window-size=1600,900',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ];
  const p = spawn(BROWSER, args, { detached: true, stdio: 'ignore', env: launchEnv() });
  p.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { console.log('browser up', (await r.json()).Browser); return; } } catch {}
  }
  throw new Error('browser did not start');
}

async function pageWs() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  return page.webSocketDebuggerUrl;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.logs = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else if (msg.method === 'Runtime.consoleAPICalled') {
        const t = msg.params.type; const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.logs.push(`[${t}] ${text}`.slice(0, 600));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails; this.logs.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`.slice(0, 1200));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry; if (e.level === 'error' || e.level === 'warning') this.logs.push(`[log.${e.level}] ${e.text} ${e.url ?? ''}`.slice(0, 600));
      } else this.events.push(msg);
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function mouse(c, type, x, y, button = 'left', clickCount = 1, extra = {}) {
  await c.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mouseReleased' ? 0 : ({ left: 1, right: 2, middle: 4 }[button] ?? 0), ...extra });
}

const KEYS = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, F1: 112 };

async function run(steps) {
  const ws = new WebSocket(await pageWs());
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const c = new Cdp(ws);
  await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const s of steps) {
    const [op, ...a] = s;
    if (op === 'goto') {
      await c.send('Page.navigate', { url: a[0] });
      for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 100)); try { if ((await c.eval('document.readyState')) === 'complete') break; } catch {} }
    } else if (op === 'wait') await new Promise((r) => setTimeout(r, a[0]));
    else if (op === 'waitFor') {
      const t0 = Date.now(); let ok = false;
      while (Date.now() - t0 < (a[1] ?? 20000)) { try { if (await c.eval(a[0])) { ok = true; break; } } catch {} await new Promise((r) => setTimeout(r, 200)); }
      console.log(`waitFor ${ok ? 'ok' : 'TIMEOUT'}: ${a[0].slice(0, 80)} (${Date.now() - t0}ms)`);
    } else if (op === 'eval') { try { console.log('eval →', JSON.stringify(await c.eval(a[0]))?.slice(0, 4000)); } catch (e) { console.log('eval ERROR', String(e).slice(0, 800)); } }
    else if (op === 'move') await mouse(c, 'mouseMoved', a[0], a[1], 'none');
    else if (op === 'click') { const b = a[2] || 'left'; await mouse(c, 'mouseMoved', a[0], a[1], 'none'); await mouse(c, 'mousePressed', a[0], a[1], b); await mouse(c, 'mouseReleased', a[0], a[1], b); }
    else if (op === 'drag') { const b = a[4] || 'left'; await mouse(c, 'mouseMoved', a[0], a[1], 'none'); await mouse(c, 'mousePressed', a[0], a[1], b);
      for (let i = 1; i <= 10; i++) await mouse(c, 'mouseMoved', a[0] + (a[2] - a[0]) * i / 10, a[1] + (a[3] - a[1]) * i / 10, b);
      await mouse(c, 'mouseReleased', a[2], a[3], b); }
    else if (op === 'wheel') await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: a[0], y: a[1], deltaX: 0, deltaY: a[2] });
    else if (op === 'key') {
      const key = a[0]; const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
      const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, text, code: key.length === 1 ? (key === ' ' ? 'Space' : `Key${key.toUpperCase()}`) : key });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, code: key.length === 1 ? (key === ' ' ? 'Space' : `Key${key.toUpperCase()}`) : key });
    } else if (op === 'type') await c.send('Input.insertText', { text: a[0] });
    else if (op === 'shot') {
      const r = await c.send('Page.captureScreenshot', { format: 'png', ...(a[1] ? { clip: { x: 0, y: 0, width: 1600, height: 900, scale: a[1] } } : {}) });
      mkdirSync(dirname(a[0]), { recursive: true }); writeFileSync(a[0], Buffer.from(r.data, 'base64')); console.log('shot', a[0]);
    } else if (op === 'console') { console.log(c.logs.join('\n') || '(no console output)'); c.logs.length = 0; }
    else console.log('unknown step', op);
  }
  const errs = c.logs.filter((l) => /error|EXCEPTION|warn/i.test(l));
  if (errs.length) console.log('--- console errors/warnings ---\n' + errs.join('\n'));
  ws.close();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'launch') await launch();
else if (cmd === 'kill') {
  // Snap-confined browsers ignore pkill from outside; ask the browser to close itself instead.
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 500));
    console.log('closed browser on port', PORT);
  } catch { console.log('no browser on port', PORT); }
}
else if (cmd === 'run') await run(JSON.parse(arg));
else console.log('usage: cdp.mjs launch | kill | run <steps-json>');
process.exit(0);
