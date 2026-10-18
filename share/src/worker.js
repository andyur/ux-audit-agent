// Shareable links for ux-audit-agent reports, on r.ayurchenko.xyz. Free plan: one Worker and one KV namespace.
//   POST /api/reports              upload a single-file report (raw HTML); returns the share and manage links
//   POST /api/reports/<id>/delete  delete with the owner token (from the CLI or the owner bar)
//   GET  /<id>                     the report in a sandboxed frame, with an owner bar for the owner's browser
//   GET  /<id>/raw                 the report itself, under a CSP sandbox
//   GET  /<id>/manage?t=<token>    marks this browser as the owner's, then opens the report; never deletes
// Uploaded HTML never runs with this origin: the frame and the CSP sandbox give it an opaque origin, and it
// cannot submit forms or open network connections, so a fake page uploaded here cannot phish or exfiltrate.

const TTL = 30 * 24 * 3600;
const MAX_BYTES = 15 * 1024 * 1024;
const PER_IP_PER_DAY = 5;
const SITE = 'https://ayurchenko.xyz';

const ID = /^[A-Za-z0-9_-]{22}$/;
const rand = n => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const day = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const base = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...base, 'Content-Type': 'application/json' } });
const page = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...extra } });

// Links in the report open in a new tab; in-page anchors (the section nav) keep working inside the frame.
const LINKS = `<script>document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(a&&!a.getAttribute('href').startsWith('#'))a.target='_blank'},true)</script>`;
const RAW_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const STYLE = `*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:rgb(10 18 23);background:#fff}a{color:inherit}`;

const gone = (why, status) => page(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Report ${why}</title>
<style>${STYLE}main{min-height:100%;display:grid;place-content:center;justify-items:center;gap:10px;padding:24px;text-align:center}h1{font-size:28px;font-weight:500;letter-spacing:-0.02em;margin:0}p{margin:0;color:rgb(10 18 23 / .62)}</style></head>
<body><main><h1>${why === 'removed' ? 'This report was removed by its owner.' : 'This report has expired.'}</h1>
<p>Shared reports stay online for 30 days. Reports like this are made with ux-audit-agent by <a href="${SITE}/?utm_source=ux-audit-agent&amp;utm_medium=share&amp;utm_campaign=${why}">Andriy Yurchenko</a>.</p></main></body></html>`, status);

const viewer = (id, meta) => page(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.product)} task audit</title>
<style>${STYLE}body{display:flex;flex-direction:column}iframe{flex:1;width:100%;border:0;display:block}
.own{display:none;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px 12px;padding:8px 16px;font-size:13px;color:rgb(10 18 23 / .62);background:#f3f3f1;border-bottom:1px solid rgb(10 18 23 / .1)}
.own.is-on{display:flex}.own b{font-weight:500;color:rgb(10 18 23)}.own button{font:inherit;font-weight:500;padding:4px 10px;border-radius:999px;border:0;cursor:pointer;background:#fff;color:rgb(10 18 23);box-shadow:0 0 0 1px rgb(10 18 23 / .1)}
.own button.danger{background:rgb(10 18 23);color:#fff;box-shadow:none}.own [hidden]{display:none}</style></head>
<body>
<div class="own" id="own" role="region" aria-label="Owner controls">
  <span><b>Shared by you</b> · Link expires ${esc(day(meta.expires))}</span>
  <span id="ask"><button type="button" id="del">Delete link</button></span>
  <span id="sure" hidden>Delete for everyone? <button type="button" class="danger" id="yes">Yes</button> <button type="button" id="no">Cancel</button></span>
</div>
<iframe src="/${id}/raw" title="${esc(meta.product)} task audit" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals" allow="clipboard-write"></iframe>
<script>
const id = ${JSON.stringify(id)}, k = 'own:' + id;
let t = null; try { t = localStorage.getItem(k); } catch {}
if (t) {
  const $ = s => document.getElementById(s);
  $('own').classList.add('is-on');
  $('del').onclick = () => { $('ask').hidden = true; $('sure').hidden = false; };
  $('no').onclick = () => { $('ask').hidden = false; $('sure').hidden = true; };
  $('yes').onclick = async () => {
    const r = await fetch('/api/reports/' + id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
    if (r.ok) { try { localStorage.removeItem(k); } catch {} location.reload(); } else alert('Could not delete. Try again or ask Claude to run ux-audit unshare.');
  };
}
</script></body></html>`);

const manage = id => page(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Opening report</title><style>${STYLE}</style></head>
<body><script>
const p = new URLSearchParams(location.search), id = ${JSON.stringify(id)};
try { if (p.get('t')) localStorage.setItem('own:' + id, p.get('t')); } catch {}
location.replace('/' + id);
</script><noscript>Open <a href="/${id}">the report</a>.</noscript></body></html>`);

async function notify(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

async function upload(req, env, ctx, origin) {
  const size = Number(req.headers.get('Content-Length') || 0);
  if (size > MAX_BYTES) return json({ error: 'Report is larger than 15 MB.' }, 413);
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const rlKey = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.REPORTS.get(rlKey)) || 0;
  if (used >= PER_IP_PER_DAY) return json({ error: 'Daily limit reached (5 shared reports). Try again tomorrow.' }, 429);

  const html = await req.text();
  if (html.length > MAX_BYTES) return json({ error: 'Report is larger than 15 MB.' }, 413);
  if (!/<meta name="generator" content="ux-audit-agent/.test(html.slice(0, 4000))) return json({ error: 'Only ux-audit-agent reports can be shared.' }, 415);

  const id = rand(16), token = rand(24), now = Date.now();
  const clip = (s, n) => { try { return decodeURIComponent(s ?? '').slice(0, n); } catch { return ''; } };
  const meta = { product: clip(req.headers.get('X-Product') || 'Product', 80), url: clip(req.headers.get('X-Product-Url'), 200), created: now, expires: now + TTL * 1000, owner: await sha(token) };
  await env.REPORTS.put(`r:${id}`, html, { expirationTtl: TTL, metadata: meta });
  await env.REPORTS.put(rlKey, String(used + 1), { expirationTtl: 24 * 3600 });

  const url = `${origin}/${id}`;
  const email = clip(req.headers.get('X-Email'), 120);
  ctx.waitUntil(notify(env, [`New shared report: ${meta.product}`, meta.url, url, email && `Email: ${email}`].filter(Boolean).join('\n')));
  return json({ id, url, manageUrl: `${url}/manage?t=${token}`, token, expires: new Date(meta.expires).toISOString() }, 201);
}

async function remove(req, env, id) {
  const { token } = await req.json().catch(() => ({}));
  const { metadata } = await env.REPORTS.getWithMetadata(`r:${id}`, { type: 'stream' }).then(r => (r.value?.cancel(), r));
  if (!metadata) return json({ error: 'Not found.' }, 404);
  if (!token || (await sha(token)) !== metadata.owner) return json({ error: 'Not allowed.' }, 403);
  await env.REPORTS.delete(`r:${id}`);
  await env.REPORTS.put(`gone:${id}`, '1', { expirationTtl: TTL });
  return json({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    const origin = url.hostname === 'r.ayurchenko.xyz' ? 'https://r.ayurchenko.xyz' : url.origin;
    if (req.method === 'POST' && url.pathname === '/api/reports') return upload(req, env, ctx, origin);
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'reports' && ID.test(parts[2] ?? '') && parts[3] === 'delete') return remove(req, env, parts[2]);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
    if (!parts.length) return Response.redirect(SITE, 302);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });

    const id = parts[0];
    if (!ID.test(id)) return gone('expired', 404);
    if (parts[1] === 'manage') return manage(id);

    if (parts[1] === 'raw') {
      const html = await env.REPORTS.get(`r:${id}`);
      if (html === null) return new Response('', { status: 404, headers: base });
      return new Response(html.replace('</body>', `${LINKS}</body>`), { headers: { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': RAW_CSP, 'Cache-Control': 'private, max-age=300' } });
    }

    const { metadata } = await env.REPORTS.getWithMetadata(`r:${id}`, { type: 'stream' }).then(r => (r.value?.cancel(), r));
    if (!metadata) return gone((await env.REPORTS.get(`gone:${id}`)) ? 'removed' : 'expired', 404);
    return viewer(id, metadata);
  },
};
