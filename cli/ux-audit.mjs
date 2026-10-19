#!/usr/bin/env node
// Required Notice: Copyright Andriy Yurchenko (https://ayurchenko.xyz)
// Licensed under PolyForm Shield 1.0.0 (LICENSE.md). Keep this notice in any copy or change.
// Command-line steps the /audit skill calls one at a time. Code does the browser work and the geometry;
// the model decides what to do next and writes the findings.
//
//   start  <url> [--out dir] [--browser name] [--browser-profile name | --separate [--profile dir] | --fresh [--headless]] [--continue]
//          default: your own browser (the Chromium browser open now, the system default first; or --browser),
//          in a new tab of the window you already have open, in the profile you used last (or --browser-profile), with your sign-ins.
//          --separate: a separate visible profile (~/.ux-audit/profile) where you sign in once.
//          --fresh: a throwaway profile, only when the user asks for one; visible unless --headless.
//          --continue: reconnect mid-audit and keep the interaction count and clock.
//   act    goto <url> | click <sel> | dblclick <sel> | hover <sel> | clickxy <x,y> | dblclickxy <x,y> | type <text> | press <key> | drag <x1,y1> <x2,y2>
//   look [selector]                                       url, title and the accessibility tree of the page (or one part), to pick the next action
//   flow <id>                                             next flow of a multi-flow audit: captures go to <out>/flows/<id>/
//   capture <id> --title .. --action .. --response .. [--target id|label|selector ...]
//   measure contrast <selector> --as <name>               computed colour contrast into checks.json
//   measure text <selector> --as <name>                   text content and box into checks.json
//   render [--single]                                     validate and build the report
//   share --consent [--email you@x]                      upload the single-file report for a 30-day link (asks first)
//   unshare                                               delete the shared link
//   stop                                                  close the audit tab and disconnect
//
// Selectors use Playwright syntax: CSS, text=..., role=button[name="..."], [data-testid=...].
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync, lstatSync, openSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// First run from an installed plugin: install Playwright next to the CLI. It drives a browser you already
// have, so no browser is downloaded.
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
if (!existsSync(path.join(ROOT, 'node_modules', 'playwright'))) {
  console.error('First run: installing Playwright (uses your browser, no browser download)...');
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
}
const { chromium } = await import('playwright');

const STATE = path.resolve('.ux-audit/session.json');
const LOG = path.resolve('.ux-audit/browser.log');
const IDLE_MS = 60 * 60 * 1000;
const SHARE = process.env.UX_AUDIT_SHARE_URL ?? 'https://r.ayurchenko.xyz';

// Chromium browsers the audit can attach to (their profile folder) or launch (their binary), and how the
// system names each as the default browser (macOS bundle id, Windows ProgId, Linux desktop file).
const home = homedir(), local = process.env.LOCALAPPDATA ?? '', roaming = process.env.APPDATA ?? '';
const mac = (name, dir, app, id) => [name, `${home}/Library/Application Support/${dir}`, `/Applications/${app}.app/Contents/MacOS/${app}`, id];
const BROWSERS = {
  darwin: [
    mac('Chrome', 'Google/Chrome', 'Google Chrome', 'com.google.chrome'),
    mac('Edge', 'Microsoft Edge', 'Microsoft Edge', 'com.microsoft.edgemac'),
    mac('Brave', 'BraveSoftware/Brave-Browser', 'Brave Browser', 'com.brave.browser'),
    mac('Comet', 'Comet', 'Comet', 'ai.perplexity.comet'),
    mac('Arc', 'Arc/User Data', 'Arc', 'company.thebrowser.browser'),
    mac('Dia', 'Dia/User Data', 'Dia', 'company.thebrowser.dia'),
    mac('Vivaldi', 'Vivaldi', 'Vivaldi', 'com.vivaldi.vivaldi'),
    mac('Opera', 'com.operasoftware.Opera', 'Opera', 'com.operasoftware.opera'),
    mac('Chromium', 'Chromium', 'Chromium', 'org.chromium.chromium'),
  ],
  win32: [
    ['Chrome', `${local}\\Google\\Chrome\\User Data`, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'ChromeHTML'],
    ['Edge', `${local}\\Microsoft\\Edge\\User Data`, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'MSEdgeHTM'],
    ['Brave', `${local}\\BraveSoftware\\Brave-Browser\\User Data`, 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'BraveHTML'],
    ['Vivaldi', `${local}\\Vivaldi\\User Data`, `${local}\\Vivaldi\\Application\\vivaldi.exe`, 'VivaldiHTM'],
    ['Opera', `${roaming}\\Opera Software\\Opera Stable`, `${local}\\Programs\\Opera\\opera.exe`, 'OperaStable'],
    ['Chromium', `${local}\\Chromium\\User Data`, `${local}\\Chromium\\Application\\chrome.exe`, 'ChromiumHTM'],
  ],
}[process.platform] ?? [
  ['Chrome', `${home}/.config/google-chrome`, '/usr/bin/google-chrome', 'google-chrome'],
  ['Edge', `${home}/.config/microsoft-edge`, '/usr/bin/microsoft-edge', 'microsoft-edge'],
  ['Brave', `${home}/.config/BraveSoftware/Brave-Browser`, '/usr/bin/brave-browser', 'brave-browser'],
  ['Vivaldi', `${home}/.config/vivaldi`, '/usr/bin/vivaldi', 'vivaldi'],
  ['Opera', `${home}/.config/opera`, '/usr/bin/opera', 'opera'],
  ['Chromium', `${home}/.config/chromium`, '/usr/bin/chromium', 'chromium'],
];
const SCHEME = { Edge: 'edge', Brave: 'brave', Opera: 'opera', Vivaldi: 'vivaldi' };
const inspectUrl = name => `${SCHEME[name] ?? 'chrome'}://inspect/#remote-debugging`;
const SEPARATE = 'Or run start with --separate: a separate Chrome, Edge or Brave window where the user signs in to the product once; it never touches their own browser.';

// The system's default browser as the id BROWSERS uses, or null when the system does not say.
function defaultBrowser() {
  try {
    if (process.platform === 'darwin') {
      const plist = `${home}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`;
      const { LSHandlers = [] } = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
      return LSHandlers.find(h => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ?? 'com.apple.safari';
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8' });
      return out.match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1] ?? null;
    }
    return execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim();
  } catch { return null; }
}
// The Chromium version of a browser whose version number is Chromium's, read on macOS only; null otherwise.
function chromiumMajor(name, binary) {
  if (process.platform !== 'darwin' || !['Chrome', 'Edge', 'Brave', 'Comet', 'Chromium'].includes(name)) return null;
  const plist = `${binary.split('/Contents/MacOS/')[0]}/Contents/Info.plist`;
  return Number(execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8' }).split('.')[0]) || null;
}
// Opens a page in a new tab through AppleScript, which Chrome, Edge, Brave, Vivaldi and Chromium answer;
// false on other systems, other browsers, or when the user does not allow it.
function openInBrowser(binary, url) {
  if (process.platform !== 'darwin') return false;
  const app = path.basename(binary.split('/Contents/MacOS/')[0], '.app');
  const script = `tell application "${app}"
    activate
    if (count of windows) = 0 then make new window
    tell front window to make new tab with properties {URL:"${url}"}
  end tell`;
  try { execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 60000 }); return true; } catch { return false; }
}
// Puts text on the clipboard; false where no clipboard tool exists (Linux without wl-copy or xclip).
function copy(text) {
  const tools = { darwin: [['pbcopy']], win32: [['clip']] }[process.platform] ?? [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  for (const [cmd, ...args] of tools) {
    try { execFileSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return true; } catch {}
  }
  return false;
}
// A running browser keeps a lock in its profile folder (a symlink to nowhere on macOS and Linux).
const running = dir => !!lstatSync(path.join(dir, process.platform === 'win32' ? 'lockfile' : 'SingletonLock'), { throwIfNoEntry: false });

const parse = argv => {
  const [cmd, ...rest] = argv;
  const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i === -1 ? fallback : rest[i + 1]; };
  return { argv, cmd, rest, flag, flags: name => rest.flatMap((v, i) => (v === `--${name}` ? [rest[i + 1]] : [])), has: name => rest.includes(`--${name}`) };
};
const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const loadState = async () => existsSync(STATE) ? JSON.parse(await readFile(STATE, 'utf8')) : fail('No session. Run: ux-audit start <url>');
const liveState = async () => { const s = await loadState(); if (s.stopped || !s.daemon) fail('The browser session ended. Run: ux-audit start <url>'); return s; };
// Written whole and renamed: start reads this file while the background process writes it.
const saveState = async s => { await writeFile(`${STATE}.tmp`, JSON.stringify(s, null, 2)); await rename(`${STATE}.tmp`, STATE); };
const readJson = async (f, fallback) => existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : fallback;

const listening = port => new Promise(r => {
  const s = connect(port, '127.0.0.1');
  s.on('connect', () => { s.end(); r(true); });
  s.on('error', () => r(false));
});
// A Chromium browser with remote debugging on writes its port and endpoint to DevToolsActivePort in its profile folder.
async function devtoolsUrl(dir) {
  const file = path.join(dir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const [port, wsPath] = (await readFile(file, 'utf8')).trim().split('\n');
  return (await listening(Number(port))) ? `ws://127.0.0.1:${port}${wsPath}` : null;
}
async function waitFor(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const v = await check();
    if (v) return v;
  }
}

// The first visible match: pages often keep hidden copies of headings and dialogs ahead of the visible one.
async function pick(pg, selector) {
  const all = pg.locator(selector), visible = all.filter({ visible: true });
  return (await visible.count()) ? visible.first() : all.first();
}

// Commands that need the page run inside the background process that holds the browser connection.
const browserCommands = {
  async act(a, pg) {
    const state = await liveState();
    const [kind, x, y] = a.rest;
    const run = {
      goto: async () => { await pg.goto(x, { waitUntil: 'load' }); await pg.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); },
      click: async () => (await pick(pg, x)).click(),
      dblclick: async () => (await pick(pg, x)).dblclick(),
      hover: async () => (await pick(pg, x)).hover(),
      clickxy: () => { const [cx, cy] = x.split(',').map(Number); return pg.mouse.click(cx, cy); },
      dblclickxy: () => { const [cx, cy] = x.split(',').map(Number); return pg.mouse.dblclick(cx, cy); },
      type: () => pg.keyboard.type(x, { delay: 20 }),
      press: () => pg.keyboard.press(x),
      drag: async () => {
        const [x1, y1] = x.split(',').map(Number), [x2, y2] = y.split(',').map(Number);
        await pg.mouse.move(x1, y1); await pg.mouse.down(); await pg.mouse.move(x2, y2, { steps: 10 }); await pg.mouse.up();
      },
    }[kind] ?? fail(`unknown act: ${kind}`);
    await run();
    await pg.waitForTimeout(300);
    state.interactions += 1;
    await saveState(state);
    return { ok: true, interactions: state.interactions, url: pg.url() };
  },

  // What the page offers right now, as roles and names; selectors like role=button[name="..."] follow from it.
  async look(a, pg) {
    return { ok: true, url: pg.url(), title: await pg.title(), tree: await (await pick(pg, a.rest[0] ?? 'body')).ariaSnapshot({ timeout: 10000 }) };
  },

  async capture(a, pg, cdp) {
    const state = await liveState();
    const id = a.rest[0] ?? fail('capture needs an id');
    await pg.waitForTimeout(300);
    const file = `assets/${id}.jpg`;
    // Straight from the browser: Playwright's own screenshot ignores the emulated 2× scale on an attached browser.
    // JPEG keeps a ten-screen report under the 15 MB a shared link accepts; marks are drawn over it, not into it.
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    await writeFile(path.join(state.out, file), Buffer.from(data, 'base64'));
    const view = await pg.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, x: scrollX, y: scrollY, ua: navigator.userAgent }));
    const targets = [];
    for (const spec of a.flags('target')) {
      const [tid, label, selector] = spec.split('|');
      const el = await pick(pg, selector).catch(e => fail(`--target ${tid}: ${e.message.split('\n')[0]}`));
      const count = await el.count();
      const box = count ? await el.evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) : null;
      targets.push({ id: tid, label, selector, box, source: box ? 'dom' : 'missing' });
    }
    const capFile = path.join(state.out, 'data/capture.json');
    const cap = await readJson(capFile, { product: a.flag('product', new URL(state.url).hostname), url: state.url, capturedAt: new Date().toISOString(), browser: view.ua, viewport: { width: view.w, height: view.h }, dpr: view.dpr, steps: [] });
    cap.steps = cap.steps.filter(s => s.id !== id);
    cap.steps.push({
      id, title: a.flag('title', id), action: a.flag('action', ''), response: a.flag('response', ''),
      screenshot: { file, cssWidth: view.w, cssHeight: view.h, dpr: view.dpr, scroll: { x: view.x, y: view.y } },
      targets, elapsedMs: Date.now() - state.startedAt, interactionsSoFar: state.interactions,
    });
    cap.interactions = state.interactions;
    cap.totalMs = Date.now() - state.startedAt;
    await writeFile(capFile, JSON.stringify(cap, null, 2));
    return { ok: true, step: id, targets: targets.map(t => `${t.id}:${t.source}`) };
  },

  async measure(a, pg) {
    const state = await liveState();
    const [kind, selector] = a.rest;
    const as = a.flag('as') ?? fail('measure needs --as <name>');
    await pg.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const el = await pick(pg, selector);
    if (!(await el.count())) fail(`not found: ${selector}`);
    const result = await el.evaluate((n, kind) => {
      const r = n.getBoundingClientRect();
      const box = { x: r.x, y: r.y, width: r.width, height: r.height };
      if (kind === 'text') return { text: n.textContent.trim(), box };
      // Any CSS colour (rgb, lch, oklch, color()) to sRGB [r, g, b, a] through a 1 x 1 canvas.
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
      const rgb = s => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = s; ctx.fillRect(0, 0, 1, 1); const [r, g, b, al] = ctx.getImageData(0, 0, 1, 1).data; return [r, g, b, al / 255]; };
      const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const cs = getComputedStyle(n);
      let bg = null;
      for (let e = n; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) { bg = c.slice(0, 3); break; }
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
    return { ok: true, [as]: result };
  },

  async stop() { return { ok: true }; },
};

// The background process. The user's own browser asks for permission on every new connection, so the
// audit connects once and every command goes through this process. In the user's own browser it opens
// one new tab in the window already open and works only there; stop closes that tab and disconnects.
async function serve() {
  const state = await loadState();
  const own = state.mode === 'own';
  const log = msg => console.log(`${new Date().toISOString()} ${msg}`);
  try {
    log(`connecting to ${state.browser} (${state.mode})`);
    const browser = await chromium.connectOverCDP(state.cdp, { timeout: 120000 });
    log(`connected, ${browser.contexts().length} contexts`);
    const ctx = browser.contexts()[0];
    let first;
    if (own) {
      // The browser itself opens the tab, so it lands in the chosen profile's open window; CDP alone would use the default one.
      const opened = ctx.waitForEvent('page', { timeout: 15000 });
      spawn(state.bin, [`--profile-directory=${state.profileDir}`, 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
      first = await opened;
      log(`tab opened: ${first.url()}`);
    } else first = ctx.pages()[0] ?? await ctx.newPage();

    // The audit page and any popup it opens, newest last. Every page renders at 1440 × 900, 2×; a navigation
    // to another site can drop the override, so it is set again before every command.
    const pages = [];
    const sessions = new Map();
    const session = async pg => sessions.get(pg) ?? sessions.set(pg, await ctx.newCDPSession(pg)).get(pg);
    const emulate = async pg => (await session(pg)).send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    const track = async pg => {
      pages.push(pg);
      pg.on('close', () => { pages.splice(pages.indexOf(pg), 1); sessions.delete(pg); });
      pg.on('popup', track);
      await emulate(pg);
    };
    await track(first);
    log('emulation set');
    await first.goto(state.url, { waitUntil: 'load' });
    log('page loaded');
    await first.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const shutdown = async () => {
      if (own) await Promise.all(pages.map(p => p.close().catch(() => {})));
      else try { process.kill(state.chromePid); } catch {}
      await browser.close().catch(() => {});
      process.exit(0);
    };
    let queue = Promise.resolve(), idle = setTimeout(shutdown, IDLE_MS);
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        queue = queue.then(async () => {
          clearTimeout(idle);
          idle = setTimeout(shutdown, IDLE_MS);
          const a = parse(JSON.parse(body));
          let reply;
          try {
            const pg = pages.at(-1) ?? fail('The audit tab was closed. Run: ux-audit start <url>');
            // Only when lost: setting it again resizes the page, which closes open menus and popovers.
            if (!await pg.evaluate(() => innerWidth === 1440 && devicePixelRatio === 2).catch(() => false)) await emulate(pg);
            reply = { ok: true, result: await browserCommands[a.cmd](a, pg, await session(pg)) };
          } catch (e) { reply = { ok: false, error: e.message }; }
          res.end(JSON.stringify(reply), () => { if (a.cmd === 'stop') shutdown(); });
        });
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      log('ready');
      await saveState({ ...(await loadState()), daemon: { pid: process.pid, port: server.address().port }, title: await first.title() });
    });
  } catch (e) {
    log(e.stack);
    const error = own && /timeout|closed|403|refused/i.test(e.message)
      ? 'The browser did not allow the connection (Allow was not clicked, or was declined). Run start again, or use --separate.'
      : e.message;
    await saveState({ ...(await loadState()), daemonError: error });
    process.exit(1);
  }
}

async function send(argv) {
  const state = await liveState();
  const res = await fetch(`http://127.0.0.1:${state.daemon.port}`, { method: 'POST', body: JSON.stringify(argv) })
    .catch(() => fail('The browser session ended. Run: ux-audit start <url>'));
  const body = await res.json();
  return body.ok ? body.result : fail(body.error);
}

const commands = {
  async start(a) {
    const url = a.rest[0] ?? fail('start needs a URL');
    const out = path.resolve(a.flag('out', 'audit'));
    const mode = a.has('fresh') ? 'fresh' : a.has('separate') || a.has('profile') ? 'separate' : 'own';
    await mkdir(path.join(out, 'assets'), { recursive: true });
    await mkdir(path.join(out, 'data'), { recursive: true });
    await mkdir(path.dirname(STATE), { recursive: true });
    const prev = existsSync(STATE) ? await loadState() : null;
    if (prev?.daemon && !prev.stopped) await send(['stop']).catch(() => {});

    let cdp, chromePid, browserName, bin, profileDir, profileName, otherProfiles;
    if (mode === 'own') {
      const installed = BROWSERS.filter(([, dir]) => existsSync(dir));
      const def = defaultBrowser(), wanted = a.flag('browser');
      const isDefault = ([, , , id]) => !!def?.toLowerCase().startsWith(id.toLowerCase());
      // The browser named with --browser, else the ones open now, the default first, then the rest.
      const ranked = wanted
        ? [installed.find(([n]) => n.toLowerCase() === wanted.toLowerCase()) ?? fail(`No ${wanted} found. Found: ${installed.map(([n]) => n).join(', ') || 'none'}.`)]
        : installed.toSorted((x, y) => (running(y[1]) * 2 + isDefault(y)) - (running(x[1]) * 2 + isDefault(x)));
      let entry = null;
      for (const b of ranked) if ((cdp = await devtoolsUrl(b[1]))) { entry = b; break; }
      if (!entry) {
        // Safari and Firefox cannot be driven with the user's sign-ins; no Chromium browser open means none is in use.
        const otherDefault = !wanted && def && !installed.some(isDefault) && !installed.some(([, dir]) => running(dir));
        if (!installed.length || otherDefault) {
          const what = /safari/i.test(def ?? '') ? 'Safari' : /firefox/i.test(def ?? '') ? 'Firefox' : 'Your browser';
          fail(`${what} cannot be connected to: the audit drives Chrome, Edge, Brave or another Chromium browser.${installed.length ? ` Installed here: ${installed.map(([n]) => n).join(', ')}; to use one, run start with --browser "<name>".` : ''} ${SEPARATE}`);
        }
        // Remote debugging is off. Browsers refuse their own settings pages from the command line, so on macOS
        // the page opens through AppleScript (the system asks once to allow it); elsewhere the address goes to
        // the clipboard. Then the audit waits for the switch.
        entry = ranked[0];
        const [name, dir, binary] = entry, url = inspectUrl(name), major = chromiumMajor(name, binary);
        if (major && major < 144) fail(`${name} ${major} does not have the remote debugging switch yet (it came with Chromium 144). Update ${name}, or use another installed browser with --browser "<name>". ${SEPARATE}`);
        if (!running(dir)) spawn(binary, [], { detached: true, stdio: 'ignore' }).unref();
        const how = openInBrowser(binary, url) ? `opened ${url} in ${name}`
          : copy(url) ? `${url} is copied: paste it into the address bar of ${name}` : `open ${url} in ${name}`;
        console.error(`Remote debugging is off in ${name}: ${how}, and switch on "Allow remote debugging". The audit goes on by itself.`);
        cdp = await waitFor(() => devtoolsUrl(dir), 120000)
          ?? fail(`${name} did not switch on remote debugging. Open ${url} in ${name}, switch it on, then run start again. ${SEPARATE}`);
      }
      const [name, dir, binary] = entry;
      [browserName, bin] = [name, binary];
      // Profile names and the one used last live in the browser's Local State file.
      const { profile: p = {} } = await readJson(path.join(dir, 'Local State'), {});
      const names = Object.entries(p.info_cache ?? {}).map(([d, info]) => [d, info.name ?? d]);
      const wantedProfile = a.flag('browser-profile');
      profileDir = wantedProfile
        ? names.find(([d, n]) => [d, n].some(v => v.toLowerCase() === wantedProfile.toLowerCase()))?.[0] ?? fail(`No ${name} profile named "${wantedProfile}". Profiles: ${names.map(([, n]) => n).join(', ')}`)
        : p.last_used ?? 'Default';
      profileName = names.find(([d]) => d === profileDir)?.[1] ?? profileDir;
      otherProfiles = names.map(([, n]) => n).filter(n => n !== profileName);
    } else {
      // A separate profile: the user signs in there once, the agent never types credentials.
      // --fresh: a throwaway profile, only when the user asks for one; visible so they can sign up in it.
      const profile = mode === 'fresh'
        ? path.join(tmpdir(), `ux-audit-fresh-${Date.now()}`)
        : path.resolve(a.flag('profile', path.join(homedir(), '.ux-audit/profile')));
      const found = BROWSERS.find(([name, , bin]) => ['Chrome', 'Edge', 'Brave', 'Chromium'].includes(name) && existsSync(bin));
      const bin = process.env.UX_AUDIT_CHROME ?? found?.[2] ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : null)
        ?? fail('No Chrome, Edge or Brave found. Install one, set UX_AUDIT_CHROME to a Chromium browser, or download Playwright\'s Chromium (about 150 MB): npx playwright install chromium');
      browserName = found?.[0] ?? 'Chromium';
      await mkdir(profile, { recursive: true });
      await unlink(path.join(profile, 'DevToolsActivePort')).catch(() => {});
      const args = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,980'];
      if (mode === 'fresh' && a.has('headless')) args.push('--headless=new');
      const chrome = spawn(bin, [...args, 'about:blank'], { detached: true, stdio: 'ignore' });
      chrome.unref();
      chromePid = chrome.pid;
      cdp = await waitFor(() => devtoolsUrl(profile), 15000) ?? fail(`${browserName} did not open its debugging port.`);
    }

    const clock = a.has('continue') && prev ? { startedAt: prev.startedAt, interactions: prev.interactions } : { startedAt: Date.now(), interactions: 0 };
    // Reconnecting mid-way through a multi-flow audit keeps the flow being captured.
    const place = a.has('continue') && prev?.root ? { root: prev.root, out: prev.out } : {};
    await saveState({ mode, browser: browserName, bin, profileDir, cdp, chromePid, out, url, ...clock, ...place });
    const log = openSync(LOG, 'a');
    spawn(process.execPath, [new URL(import.meta.url).pathname, '__serve'], { detached: true, stdio: ['ignore', log, log] }).unref();
    if (mode === 'own') console.error(`${browserName} will ask once to allow this connection. Click Allow.`);
    const state = await waitFor(async () => { const s = await loadState(); return (s.daemon || s.daemonError) && s; }, 150000)
      ?? fail('The browser did not answer in time. Run start again.');
    if (state.daemonError) fail(state.daemonError);
    return { ok: true, out, mode, browser: browserName, ...(profileName && { profile: profileName, otherProfiles }), title: state.title };
  },

  // The next flow of a multi-flow audit, in the same tab: captures go to <out>/flows/<id>/ and the
  // interaction count starts again at zero. The audit folder stays the one start was given.
  async flow(a) {
    const id = a.rest[0] ?? fail('flow needs an id');
    if (!/^[a-z0-9]+$/.test(id)) fail('A flow id is lowercase letters and digits only, such as signup or invite.');
    const state = await liveState();
    const root = state.root ?? state.out;
    const out = path.join(root, 'flows', id);
    await mkdir(path.join(out, 'assets'), { recursive: true });
    await mkdir(path.join(out, 'data'), { recursive: true });
    await saveState({ ...state, root, out, startedAt: Date.now(), interactions: 0 });
    return { ok: true, flow: id, out };
  },

  async render(a) {
    const state = await loadState();
    const root = state.root ?? state.out;
    const multi = existsSync(path.join(root, 'data/overview.json'));
    const dirs = multi ? (await readdir(path.join(root, 'flows'))).map(f => path.join(root, 'flows', f)) : [root];
    for (const d of dirs) {
      for (const f of ['capture.json', 'audit.json']) {
        if (!existsSync(path.join(d, 'data', f))) fail(`Missing ${f} in ${d}/data. Write audit.json from the findings first.`);
      }
      if (!existsSync(path.join(d, 'data/checks.json'))) await writeFile(path.join(d, 'data/checks.json'), '{}');
    }
    const args = [new URL('../render/render.mjs', import.meta.url).pathname, `--dir=${path.relative(new URL('../render/', import.meta.url).pathname, root)}/`];
    if (a.has('single')) args.push('--single');
    const code = await new Promise(r => spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', r));
    if (code) process.exit(code);
  },

  // Opt-in hosted copy of the single-file report on r.ayurchenko.xyz (30 days). The skill asks the user first;
  // --consent records that they agreed. The owner token stays in <out>/.share.json for unshare.
  async share(a) {
    if (!a.has('consent')) fail('Ask the user first: the report is stored on ayurchenko.xyz for 30 days and Andriy Yurchenko, who built this agent, can see shared reports. Run again with --consent once they agree.');
    const state = await loadState();
    const root = state.root ?? state.out;
    const files = (await readdir(root)).filter(f => f.endsWith('-task-audit.html'));
    if (!files.length) fail('No single-file report yet. Run: ux-audit render --single');
    const meta = (await readJson(path.join(root, 'data/overview.json'), null) ?? await readJson(path.join(root, 'data/audit.json'), {})).meta ?? {};
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'X-Product': encodeURIComponent(meta.product ?? ''), 'X-Product-Url': encodeURIComponent(meta.url ?? '') };
    if (a.flag('email')) headers['X-Email'] = encodeURIComponent(a.flag('email'));
    const res = await fetch(`${SHARE}/api/reports`, { method: 'POST', headers, body: await readFile(path.join(root, files[0])) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) fail(body.error ?? `Upload failed (${res.status}).`);
    await writeFile(path.join(root, '.share.json'), JSON.stringify(body, null, 2));
    return { ok: true, url: body.url, manageUrl: body.manageUrl, expires: body.expires };
  },

  async unshare() {
    const state = await loadState();
    const file = path.join(state.root ?? state.out, '.share.json');
    const shared = await readJson(file, null) ?? fail('Nothing was shared from this audit.');
    const res = await fetch(`${SHARE}/api/reports/${shared.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: shared.token }) });
    if (!res.ok && res.status !== 404) fail(`Could not delete (${res.status}).`);
    await unlink(file);
    return { ok: true, removed: shared.url };
  },

  async stop() {
    const state = await loadState();
    if (!state.stopped) await send(['stop']).catch(() => { try { process.kill(state.chromePid); } catch {} });
    await saveState({ ...(await loadState()), stopped: true });
    return { ok: true, mode: state.mode };
  },
};

const a = parse(process.argv.slice(2));
if (a.cmd === '__serve') await serve();
else {
  try {
    const run = commands[a.cmd] ?? (browserCommands[a.cmd] && (() => send(a.argv)))
      ?? fail(`Commands: ${[...Object.keys(commands), ...Object.keys(browserCommands).filter(c => c !== 'stop')].join(', ')}`);
    const result = await run(a);
    if (result) console.log(JSON.stringify(result));
  } catch (e) { console.error(e.message); process.exit(1); }
}
