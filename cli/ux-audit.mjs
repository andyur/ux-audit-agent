#!/usr/bin/env node
// Command-line steps the /audit skill calls one at a time. Code does the browser work and the geometry;
// the model decides what to do next and writes the findings.
//
//   start  <url> [--out dir] [--headed] [--profile dir | --fresh]   open Chrome; --fresh = empty profile
//   act    goto <url> | click <sel> | dblclick <sel> | clickxy <x,y> | dblclickxy <x,y> | type <text> | press <key> | drag <x1,y1> <x2,y2>
//   capture <id> --title .. --action .. --response .. [--target id|label|selector ...]
//   measure contrast <selector> --as <name>               computed colour contrast into checks.json
//   measure text <selector> --as <name>                   text content and box into checks.json
//   render [--single]                                     validate and build the report
//   share --consent [--email you@x]                      upload the single-file report for a 30-day link (asks first)
//   unshare                                               delete the shared link
//   stop                                                  close the browser
//
// Selectors use Playwright syntax: CSS, text=..., role=button[name="..."], [data-testid=...].
import { spawn, execSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// First run from an installed plugin: install Playwright next to the CLI. It drives the user's own Chrome,
// so no browser is downloaded.
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
if (!existsSync(path.join(ROOT, 'node_modules', 'playwright'))) {
  console.error('First run: installing Playwright (uses your Chrome, no browser download)...');
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
}
const { chromium } = await import('playwright');

const STATE = path.resolve('.ux-audit/session.json');
const PORT = 9333;
const SHARE = process.env.UX_AUDIT_SHARE_URL ?? 'https://r.ayurchenko.xyz';
const CHROME = process.env.UX_AUDIT_CHROME ?? {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] ?? 'google-chrome';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};
const flags = name => rest.flatMap((v, i) => (v === `--${name}` ? [rest[i + 1]] : []));
const has = name => rest.includes(`--${name}`);
const fail = msg => { console.error(msg); process.exit(1); };

const loadState = async () => existsSync(STATE) ? JSON.parse(await readFile(STATE, 'utf8')) : fail('No session. Run: ux-audit start <url>');
const liveState = async () => { const s = await loadState(); if (s.stopped) fail('The browser was stopped. Run: ux-audit start <url>'); return s; };
const saveState = s => writeFile(STATE, JSON.stringify(s, null, 2));
const readJson = async (f, fallback) => existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : fallback;

// Viewport emulation lasts only while a client is attached, so headless runs set it on every connect.
async function page() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const pg = ctx.pages().find(p => !p.url().startsWith('chrome://')) ?? ctx.pages()[0];
  const state = existsSync(STATE) ? JSON.parse(await readFile(STATE, 'utf8')) : null;
  if (state?.headless ?? !has('headed')) {
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  }
  return { browser, pg };
}

async function waitForPort(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  fail('Chrome did not open its debugging port.');
}

const commands = {
  async start() {
    const url = rest[0] ?? fail('start needs a URL');
    const out = path.resolve(flag('out', 'audit'));
    // A separate profile: the user signs in there once, the agent never types credentials.
    // --fresh: a throwaway profile, for first-visit audits where saved site data would change what the user sees.
    const profile = has('fresh')
      ? path.join(tmpdir(), `ux-audit-fresh-${Date.now()}`)
      : path.resolve(flag('profile', path.join(homedir(), '.ux-audit/profile')));
    await mkdir(profile, { recursive: true });
    await mkdir(path.join(out, 'assets'), { recursive: true });
    await mkdir(path.join(out, 'data'), { recursive: true });
    await mkdir(path.dirname(STATE), { recursive: true });
    const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,980'];
    if (!has('headed')) args.push('--headless=new', '--force-device-scale-factor=2');
    const chrome = spawn(CHROME, [...args, url], { detached: true, stdio: 'ignore' });
    chrome.unref();
    await waitForPort();
    const { browser, pg } = await page();
    await pg.waitForLoadState('networkidle').catch(() => {});
    await saveState({ pid: chrome.pid, out, url, startedAt: Date.now(), interactions: 0, headless: !has('headed') });
    console.log(JSON.stringify({ ok: true, out, title: await pg.title(), headed: has('headed') }));
    await browser.close().catch(() => {});
  },

  async act() {
    const state = await liveState();
    const [kind, a, b] = rest;
    const { browser, pg } = await page();
    const run = {
      goto: () => pg.goto(a, { waitUntil: 'networkidle' }),
      click: () => pg.locator(a).first().click(),
      dblclick: () => pg.locator(a).first().dblclick(),
      clickxy: () => { const [x, y] = a.split(',').map(Number); return pg.mouse.click(x, y); },
      dblclickxy: () => { const [x, y] = a.split(',').map(Number); return pg.mouse.dblclick(x, y); },
      type: () => pg.keyboard.type(a, { delay: 20 }),
      press: () => pg.keyboard.press(a),
      drag: async () => {
        const [x1, y1] = a.split(',').map(Number), [x2, y2] = b.split(',').map(Number);
        await pg.mouse.move(x1, y1); await pg.mouse.down(); await pg.mouse.move(x2, y2, { steps: 10 }); await pg.mouse.up();
      },
    }[kind] ?? fail(`unknown act: ${kind}`);
    await run();
    await pg.waitForTimeout(300);
    state.interactions += 1;
    await saveState(state);
    console.log(JSON.stringify({ ok: true, interactions: state.interactions, url: pg.url() }));
    await browser.close().catch(() => {});
  },

  async capture() {
    const state = await liveState();
    const id = rest[0] ?? fail('capture needs an id');
    const { browser, pg } = await page();
    await pg.waitForTimeout(300);
    const file = `assets/${id}.png`;
    await pg.screenshot({ path: path.join(state.out, file) });
    const view = await pg.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, x: scrollX, y: scrollY, ua: navigator.userAgent }));
    const targets = [];
    for (const spec of flags('target')) {
      const [tid, label, selector] = spec.split('|');
      const el = pg.locator(selector).first();
      const box = (await el.count()) ? await el.evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) : null;
      targets.push({ id: tid, label, selector, box, source: box ? 'dom' : 'missing' });
    }
    const capFile = path.join(state.out, 'data/capture.json');
    const cap = await readJson(capFile, { product: flag('product', new URL(state.url).hostname), url: state.url, capturedAt: new Date().toISOString(), browser: view.ua, viewport: { width: view.w, height: view.h }, dpr: view.dpr, steps: [] });
    cap.steps = cap.steps.filter(s => s.id !== id);
    cap.steps.push({
      id, title: flag('title', id), action: flag('action', ''), response: flag('response', ''),
      screenshot: { file, cssWidth: view.w, cssHeight: view.h, dpr: view.dpr, scroll: { x: view.x, y: view.y } },
      targets, elapsedMs: Date.now() - state.startedAt, interactionsSoFar: state.interactions,
    });
    cap.interactions = state.interactions;
    cap.totalMs = Date.now() - state.startedAt;
    await writeFile(capFile, JSON.stringify(cap, null, 2));
    console.log(JSON.stringify({ ok: true, step: id, targets: targets.map(t => `${t.id}:${t.source}`) }));
    await browser.close().catch(() => {});
  },

  async measure() {
    const state = await liveState();
    const [kind, selector] = rest;
    const as = flag('as') ?? fail('measure needs --as <name>');
    const { browser, pg } = await page();
    const el = pg.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (!(await el.count())) fail(`not found: ${selector}`);
    const result = await el.evaluate((n, kind) => {
      const r = n.getBoundingClientRect();
      const box = { x: r.x, y: r.y, width: r.width, height: r.height };
      if (kind === 'text') return { text: n.textContent.trim(), box };
      const rgb = s => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const cs = getComputedStyle(n);
      let bg = null;
      for (let e = n; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3] > 0)) { bg = c.slice(0, 3); break; }
      }
      bg ??= [255, 255, 255];
      const fg = rgb(cs.color).slice(0, 3);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return { text: n.textContent.trim(), box, fontSize: cs.fontSize, color: cs.color, background: `rgb(${bg.join(', ')})`, contrast: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
    }, kind);
    const checksFile = path.join(state.out, 'data/checks.json');
    const checks = await readJson(checksFile, {});
    checks[as] = { ...result, measuredAt: new Date().toISOString() };
    await writeFile(checksFile, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify({ ok: true, [as]: result }));
    await browser.close().catch(() => {});
  },

  async render() {
    const state = await loadState();
    for (const f of ['capture.json', 'audit.json']) {
      if (!existsSync(path.join(state.out, 'data', f))) fail(`Missing ${f} in ${state.out}/data. Write audit.json from the findings first.`);
    }
    if (!existsSync(path.join(state.out, 'data/checks.json'))) await writeFile(path.join(state.out, 'data/checks.json'), '{}');
    const args = [new URL('../render/render.mjs', import.meta.url).pathname, `--dir=${path.relative(new URL('../render/', import.meta.url).pathname, state.out)}/`];
    if (has('single')) args.push('--single');
    const p = spawn(process.execPath, args, { stdio: 'inherit' });
    p.on('exit', code => process.exit(code));
  },

  // Opt-in hosted copy of the single-file report on r.ayurchenko.xyz (30 days). The skill asks the user first;
  // --consent records that they agreed. The owner token stays in <out>/.share.json for unshare.
  async share() {
    if (!has('consent')) fail('Ask the user first: the report is stored on ayurchenko.xyz for 30 days and Andriy Yurchenko, who built this agent, can see shared reports. Run again with --consent once they agree.');
    const state = await loadState();
    const files = (await readdir(state.out)).filter(f => f.endsWith('-task-audit.html'));
    if (!files.length) fail('No single-file report yet. Run: ux-audit render --single');
    const meta = (await readJson(path.join(state.out, 'data/audit.json'), {})).meta ?? {};
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'X-Product': encodeURIComponent(meta.product ?? ''), 'X-Product-Url': encodeURIComponent(meta.url ?? '') };
    if (flag('email')) headers['X-Email'] = encodeURIComponent(flag('email'));
    const res = await fetch(`${SHARE}/api/reports`, { method: 'POST', headers, body: await readFile(path.join(state.out, files[0])) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) fail(body.error ?? `Upload failed (${res.status}).`);
    await writeFile(path.join(state.out, '.share.json'), JSON.stringify(body, null, 2));
    console.log(JSON.stringify({ ok: true, url: body.url, manageUrl: body.manageUrl, expires: body.expires }));
  },

  async unshare() {
    const state = await loadState();
    const file = path.join(state.out, '.share.json');
    const shared = await readJson(file, null) ?? fail('Nothing was shared from this audit.');
    const res = await fetch(`${SHARE}/api/reports/${shared.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: shared.token }) });
    if (!res.ok && res.status !== 404) fail(`Could not delete (${res.status}).`);
    await unlink(file);
    console.log(JSON.stringify({ ok: true, removed: shared.url }));
  },

  async stop() {
    const state = await loadState();
    try { process.kill(state.pid); } catch {}
    await saveState({ ...state, stopped: true });
    console.log(JSON.stringify({ ok: true, stopped: state.pid }));
  },
};

await (commands[cmd] ?? (() => fail(`Commands: ${Object.keys(commands).join(', ')}`)))();
