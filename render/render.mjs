// Required Notice: Copyright Andriy Yurchenko (https://ayurchenko.xyz)
// Licensed under PolyForm Shield 1.0.0 (LICENSE.md). Keep this notice in any copy or change.
// Renders examples/report/index.html (and audit.pdf with --pdf) from structured data:
//   data/capture.json  steps, screenshots and DOM geometry from the browser run
//   data/checks.json   supplementary measurements
//   data/audit.json    findings, summary, recommendations, limits
// A multi-flow audit has data/overview.json (flows, shared summary, patterns, priorities, limits) and one
// folder per flow, flows/<id>/ with its own data/ and assets/. Its ids are prefixed with the flow id
// ("signup-F1", "signup-s3") and the flows are rendered into one page.
// Geometry is CSS px of the captured viewport; it is converted to percent of the screenshot, so markers stay
// on the element at any display size. Screenshots are never painted on.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { validate } from './validate.mjs';

const dir = new URL(process.argv.find(a => a.startsWith('--dir='))?.slice(6) ?? '../examples/report/', import.meta.url).pathname;
const read = async (f, base = dir) => JSON.parse(await readFile(`${base}data/${f}`, 'utf8'));
const font = async f => (await readFile(new URL(`./fonts/${f}`, import.meta.url))).toString('base64');
const multi = existsSync(`${dir}data/overview.json`);

// One flow's data, loaded as written by the agent.
const loadFlow = async (base, fallbackChecks) => {
  const [capture, checks, audit] = await Promise.all([read('capture.json', base), existsSync(`${base}data/checks.json`) ? read('checks.json', base) : fallbackChecks, read('audit.json', base)]);
  return { capture, checks, audit };
};
// Several flows become one audit: every step, finding and check path gets its flow id as a prefix.
async function loadMulti() {
  const ov = await read('overview.json');
  const flows = await Promise.all(ov.flows.map(async (f, i) => ({ ...f, n: i + 1, ...(await loadFlow(`${dir}flows/${f.id}/`, {})) })));
  const px = (f, id) => `${f.id}-${id}`;
  const target = (f, t) => t.source === 'checks' ? { ...t, path: `${f.id}.${t.path}` } : { ...t, step: px(f, t.step) };
  const capture = {
    viewport: flows[0].capture.viewport,
    capturedAt: flows[0].capture.capturedAt,
    interactions: flows.reduce((n, f) => n + f.capture.interactions, 0),
    steps: flows.flatMap(f => f.capture.steps.map(s => ({ ...s, id: px(f, s.id), flow: f.id, screenshot: { ...s.screenshot, file: `flows/${f.id}/${s.screenshot.file}` } }))),
  };
  const checks = Object.fromEntries(flows.map(f => [f.id, f.checks]));
  const statuses = flows.map(f => f.audit.meta.status);
  const audit = {
    ...ov,
    meta: { ...ov.meta, task: ov.meta.goal, status: statuses.every(x => x === 'completed') ? 'completed' : 'partial' },
    journey: flows.flatMap(f => f.audit.journey.map(j => ({ ...j, step: px(f, j.step), flow: f.id, findings: (j.findings ?? []).map(x => px(f, x)) }))),
    findings: flows.flatMap(f => f.audit.findings.map(x => ({
      ...x, id: px(f, x.id), flow: f.id, step: x.step && px(f, x.step), target: target(f, x.target),
      related: x.related?.map(r => ({ ...r, step: px(f, r.step) })),
    }))),
    patterns: ov.patterns ?? [],
  };
  return { capture, checks, audit, flows };
}

const [{ capture, checks, audit, flows = null }, cssBody, sans] = await Promise.all([
  multi ? loadMulti() : loadFlow(dir),
  readFile(new URL('./report.css', import.meta.url), 'utf8'),
  font('Inter-Variable-latin.woff2'),
]);
// The font is embedded so the report renders the same offline and in print. Inter, SIL OFL 1.1.
const css = `@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${sans}) format("woff2");font-weight:100 900;font-display:block}
${cssBody}`;

const AGENT = JSON.parse(await readFile(new URL('./agent.json', import.meta.url), 'utf8'));

const problems = validate({ capture, checks, audit, flows });
if (problems.length) {
  console.error(`Report not built: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

// Links back to the author carry a source tag, so visits from shared reports show up in analytics.
const tagged = (url, content) => {
  const u = new URL(url);
  u.searchParams.set('utm_source', AGENT.name);
  u.searchParams.set('utm_medium', 'report');
  u.searchParams.set('utm_campaign', content);
  return u.toString();
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (v, total) => `${((v / total) * 100).toFixed(3)}%`;
// Steps are numbered within their flow.
const steps = Object.fromEntries(capture.steps.map((s, i) => [s.id, { ...s, n: s.flow ? capture.steps.filter((x, k) => k <= i && x.flow === s.flow).length : i + 1 }]));
const flowOf = Object.fromEntries((flows ?? []).map(f => [f.id, f]));
// "step 3" in a one-flow audit, "flow 2 step 3" when there are several.
const stepName = s => s.flow ? `flow ${flowOf[s.flow].n} step ${s.n}` : `step ${s.n}`;
const isFinding = r => /(^|-)F\d+$/.test(r);

const dig = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function targetBox(t) {
  if (t.source === 'checks') return dig(checks, t.path) ?? null;
  return steps[t.step]?.targets.find(x => x.id === t.id)?.box ?? null;
}

const SEVERITY = {
  blocker: { label: 'Blocks the task', level: 4 },
  significant: { label: 'Slows or risks the task', level: 3 },
  minor: { label: 'Minor friction', level: 2 },
  observation: { label: 'Observation', level: 1 },
};
const sevBar = key => {
  const s = SEVERITY[key];
  return `<span class="tag tag--${key}"><i aria-hidden="true"></i>${s.label}</span>`;
};

// Pins sit outside the element, at its left edge, so they never cover the text they point at.
// Elements in the left tenth of the frame get the pin on their right instead.
const pinStyle = (box, W, H) => box.x / W < 0.1
  ? `left:${pct(box.x + box.width, W)};top:${pct(box.y + box.height / 2, H)};transform:translate(6px,-50%)`
  : `left:${pct(box.x, W)};top:${pct(box.y + box.height / 2, H)};transform:translate(calc(-100% - 6px),-50%)`;

// Marks on a full screenshot. ref marks are dashed: context, not the finding itself.
function marks(step, items) {
  const { cssWidth: W, cssHeight: H } = step.screenshot;
  return items.filter(m => m.box).map(m => `
    <span class="box${m.ref ? ' box--ref' : ''}" style="left:${pct(m.box.x, W)};top:${pct(m.box.y, H)};width:${pct(m.box.width, W)};height:${pct(m.box.height, H)}"></span>
    <span class="pin${m.ref ? ' pin--ref' : ''}" style="${pinStyle(m.box, W, H)}">${esc(m.label)}</span>`).join('');
}

function shot(step, items, alt) {
  return `<figure class="shot"><img src="${esc(step.screenshot.file)}" alt="${esc(alt)}">${marks(step, items)}</figure>`;
}

// Detail crop around a box, done with CSS: the image is scaled and offset inside a clipped frame.
// The region is at least 760 x 420 CSS px, centred on the element, so the zoom stays readable.
function crop(step, box, label, pad = 80, minW = 760, minH = 420) {
  const { cssWidth: W, cssHeight: H } = step.screenshot;
  const w = Math.min(W, Math.max(minW, box.width + pad * 2)), h = Math.min(H, Math.max(minH, box.height + pad * 2));
  const x = Math.min(Math.max(0, box.x + box.width / 2 - w / 2), W - w);
  const y = Math.min(Math.max(0, box.y + box.height / 2 - h / 2), H - h);
  const inner = { x: box.x - x, y: box.y - y, width: box.width, height: box.height };
  return `<figure class="crop" style="aspect-ratio:${w.toFixed(1)}/${h.toFixed(1)}">
    <img src="${esc(step.screenshot.file)}" alt="" style="width:${pct(W, w)};left:${pct(-x, w)};top:${pct(-y, h)}">
    <span class="box" style="left:${pct(inner.x, w)};top:${pct(inner.y, h)};width:${pct(inner.width, w)};height:${pct(inner.height, h)}"></span>
    <span class="pin" style="${pinStyle(inner, w, h)}">${esc(label)}</span>
  </figure>`;
}

// Inline SVG icons from HugeIcons (stroke-rounded), generated into icons.json; aria-hidden, colour from CSS.
const ICON = JSON.parse(await readFile(new URL('./icons.json', import.meta.url), 'utf8'));
const icon = k => `<span class="ic" aria-hidden="true">${ICON[k] ?? ''}</span>`;

const fIndex = Object.fromEntries(audit.findings.map((f, i) => [f.id, i + 1]));
// Finding refs use the same numbered disc as the marks on screenshots; step refs are quiet grey tags.
const fTitle = Object.fromEntries(audit.findings.map(f => [f.id, f.title]));
const refLink = r => isFinding(r)
  ? `<a class="ref ref--f" href="#${r}" title="${esc(fTitle[r] ?? r)}"><i>${fIndex[r] ?? '?'}</i>Finding</a>`
  : `<a class="ref" href="#journey-${r}">${steps[r] ? stepName(steps[r]).replace(/^./, c => c.toUpperCase()) : r}</a>`;
const refs = list => list?.length ? `<span class="refs">${list.map(refLink).join('')}</span>` : '';

const m = audit.meta;
const valueStep = audit.journey.find(j => j.firstValue)?.step;
const interactionsToValue = capture.steps.find(s => s.id === valueStep)?.interactionsSoFar;
// A partial or blocked audit has no first-value step; the stat then names where the task stopped.
const stopStep = audit.journey.find(j => j.status === 'blocked')?.step ?? audit.journey.at(-1).step;
const valueStat = valueStep
  ? `<span class="stat">${interactionsToValue}</span><span class="stat__label">${icon('flag')}Interactions to first value</span><span class="stat__sub">Reached at ${stepName(steps[valueStep])}</span>`
  : `<span class="stat">None</span><span class="stat__label">${icon('flag')}First value</span><span class="stat__sub">Not reached; stopped at ${stepName(steps[stopStep])}</span>`;
const statusClass = { completed: '', partial: ' status--partial', blocked: ' status--blocked' }[m.status] ?? '';
const sevCount = audit.findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
const findingMix = Object.entries(sevCount).map(([k, n]) => `${n} ${SEVERITY[k].label.toLowerCase()}`).join(', ').replace(/^./, c => c.toUpperCase());
// The call to action: two email steps in a hairline frame. Free sends the report for a short note; Paid asks
// for a Product Diagnosis. Both open a prefilled email, so every request arrives with the agent report.
const fillMail = t => t.replaceAll('{product}', m.product).replaceAll('{url}', m.url);
const mailto = x => `mailto:${AGENT.cta.email}?subject=${encodeURIComponent(fillMail(x.mailSubject))}&body=${encodeURIComponent(fillMail(x.mailBody))}`;
const ctaArrow = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ctaCard = (cls, href, title, tag, tagCls, text, tags) => `<a class="cta__card ${cls}" href="${esc(href)}">
      <span class="cta__head"><span class="cta__title">${esc(title)} ${ctaArrow}</span><span class="cta__tag ${tagCls}">${esc(tag)}</span></span>
      <p class="cta__text">${esc(text)}</p>
      <span class="cta__tags">${tags.map(t => `<b>${esc(t)}</b>`).join('')}</span>
    </a>`;
const cta = () => {
  const c = AGENT.cta, d = c.diagnosis;
  const n = audit.diagnosis?.include && audit.diagnosis.text.match(/finding (\d+)/i)?.[1];
  return `
<section class="section cta" id="contact">
  <div class="cta__frame">
    <h2>${esc(c.title)}</h2>
    <p class="cta__lede">${esc(c.body)}</p>
    <div class="cta__cards">
    ${ctaCard('cta__card--free', mailto(c), c.button, c.card.tag, '', c.card.text, c.card.tags)}
    ${ctaCard('cta__card--paid', mailto(d), d.title, d.card.tag, 'cta__tag--magic', d.card.text.replace('{case}', n ? `, like finding ${n}` : ''), d.card.tags)}
    </div>
    <p class="cta__note">${esc(c.note)} <a href="${esc(tagged(d.link, slug))}">${esc(d.aboutLabel)} ${ctaArrow}</a></p>
  </div>
</section>`;
};
const slug = m.product.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const date = new Date(capture.capturedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const header = `
<header id="overview">
  <div class="title">
    <p class="kicker"><span>${esc(m.product)} <a href="${esc(m.url)}">${esc(m.url.replace(/^https?:\/\//, ''))}</a></span><span>Task audit, ${esc(date)}</span></p>
    <h1>${esc(m.task)}</h1>
    <p class="title__task">${esc(m.taskDetail)}</p>
  </div>
  <div class="outcome">
    <div class="outcome__top"><span class="status${statusClass}">${esc(m.status[0].toUpperCase() + m.status.slice(1))}</span><p class="outcome__note">${esc(m.statusNote)}</p></div>
    <div class="stats">
      <div>${valueStat}</div>
      <div><span class="stat">${capture.interactions}</span><span class="stat__label">${icon('check')}Interactions in total</span><span class="stat__sub">Across ${capture.steps.length} screens</span></div>
      <div><span class="stat">${audit.findings.length}</span><span class="stat__label">${icon('search')}Findings</span><span class="stat__sub">${findingMix}</span></div>
    </div>
  </div>
  <dl class="scope">
    <div><dt>${icon('target')}Success means</dt><dd>${esc(m.success)}</dd></div>
    <div><dt>${icon('stars')}First value</dt><dd>${esc(m.firstValue)}</dd></div>
    <div><dt>${icon('browser')}Starting state</dt><dd>${esc(m.startingState)}</dd></div>
    <div><dt>${icon('monitor')}Environment</dt><dd>${esc(m.environment)}</dd></div>
    <div><dt>${icon('crop')}Scope</dt><dd>${esc(m.auditType)}</dd></div>
    <div><dt>${icon('stars')}Made by</dt><dd>${esc(AGENT.madeBy)}</dd></div>
  </dl>
</header>`;

// Several flows: the header lists them with why each was chosen; each flow's own outcome sits above its journey.
const DEPTH = { quick: 'Quick', standard: 'Standard', deep: 'Deep' };
const flowsReached = flows?.filter(f => f.audit.journey.some(j => j.firstValue)).length;
const multiHeader = () => `
<header id="overview">
  <div class="title">
    <p class="kicker"><span>${esc(m.product)} <a href="${esc(m.url)}">${esc(m.url.replace(/^https?:\/\//, ''))}</a></span><span>${flows.length} flows, ${esc(DEPTH[m.depth] ?? m.depth)} depth, ${esc(date)}</span></p>
    <h1>${esc(m.goal)}</h1>
    ${m.goalDetail ? `<p class="title__task">${esc(m.goalDetail)}</p>` : ''}
  </div>
  <div class="outcome">
    <div class="outcome__top"><span class="status${statusClass}">${esc(m.status[0].toUpperCase() + m.status.slice(1))}</span><p class="outcome__note">${esc(m.statusNote ?? '')}</p></div>
    <div class="stats">
      <div><span class="stat">${flowsReached} of ${flows.length}</span><span class="stat__label">${icon('flag')}Flows that reached first value</span><span class="stat__sub">Each flow's own result is above its journey</span></div>
      <div><span class="stat">${capture.interactions}</span><span class="stat__label">${icon('check')}Interactions in total</span><span class="stat__sub">Across ${capture.steps.length} screens</span></div>
      <div><span class="stat">${audit.findings.length}</span><span class="stat__label">${icon('search')}Findings</span><span class="stat__sub">${findingMix}</span></div>
    </div>
  </div>
  <ol class="flows">${flows.map(f => `<li><a href="#journey-${f.id}"><span class="flows__n">Flow ${f.n}</span><b>${esc(f.audit.meta.task)}</b></a><p>${esc(f.why)}</p><span class="status${{ completed: '', partial: ' status--partial', blocked: ' status--blocked' }[f.audit.meta.status] ?? ''}">${esc(f.audit.meta.status[0].toUpperCase() + f.audit.meta.status.slice(1))}</span></li>`).join('')}</ol>
  <dl class="scope">
    <div><dt>${icon('crop')}Depth</dt><dd>${esc(m.depthNote ?? `${DEPTH[m.depth] ?? m.depth}: ${flows.length} flows chosen with the user.`)}</dd></div>
    <div><dt>${icon('browser')}Starting state</dt><dd>${esc(m.startingState)}</dd></div>
    <div><dt>${icon('monitor')}Environment</dt><dd>${esc(m.environment)}</dd></div>
    <div><dt>${icon('stars')}Made by</dt><dd>${esc(AGENT.madeBy)}</dd></div>
  </dl>
</header>`;
const row = (name, ic, items, emptyNote) => `<div class="kccn__row">
    <h3>${icon(ic)}${name}${items.length ? `<span class="kccn__n">${items.length}</span>` : ''}</h3>
    ${items.length
      ? `<ul>${items.map(i => `<li><p>${esc(i.text)}</p>${refs(i.refs)}</li>`).join('')}</ul>`
      : `<p class="empty">${esc(emptyNote)}</p>`}
  </div>`;
const summary = `
<section class="section section--break" id="summary">
  <div class="section__head"><div><h2>What to keep, cut, change, and do next</h2><p class="section__lede">Each line points to the step or finding it comes from.</p></div></div>
  <div class="kccn">
    ${row('Keep', 'check', audit.summary.keep)}
    ${row('Cut', 'scissor', audit.summary.cut, audit.summary.cutNote)}
    ${row('Change', 'edit', audit.summary.change)}
    ${row('Next', 'arrow', audit.summary.next)}
  </div>
</section>`;

const journeyItem = j => {
      const s = steps[j.step];
      return `<li id="journey-${s.id}">
        <span class="n">${String(s.n).padStart(2, '0')}</span>
        <div class="thumb"><img src="${esc(s.screenshot.file)}" alt="${esc(s.title)}"></div>
        <div class="body">
          <h3>${esc(s.title)}</h3>
          <dl class="flow">
            <div><dt>${icon('cursor')}<span>Action</span></dt><dd>${esc(s.action)}</dd></div>
            <div><dt>${icon('monitor')}<span>Product response</span></dt><dd>${esc(j.response ?? s.response)}</dd></div>
          </dl>
          <div class="meta">${j.firstValue ? '<span class="chip chip--first">First value</span>' : ''}<span class="chip">${s.interactionsSoFar ? `${s.interactionsSoFar} interactions` : 'Start'}</span>${j.status === 'done-verified-separately' ? '<span class="chip">Verified in a second run</span>' : ''}${j.status === 'blocked' ? '<span class="chip chip--blocked">Blocked here</span>' : ''}${(j.findings ?? []).map(id => `<a class="ref ref--f" href="#${id}"><i>${fIndex[id]}</i>${esc(audit.findings.find(f => f.id === id).target.label)}</a>`).join('')}</div>
        </div>
      </li>`;
};
// Several flows: Journey and Findings each get a row of flow tabs; picking one shows that flow in both.
// Without the script every flow shows, one after another.
const flowTabs = kind => `<div class="flowtabs" role="tablist" aria-label="Flows">${flows.map(f => `<button type="button" role="tab" data-flow="${f.id}"><span class="flows__n">Flow ${f.n}</span>${esc(f.audit.meta.task)}<span class="toc__n">${kind === 'findings' ? audit.findings.filter(x => x.flow === f.id).length : f.capture.steps.length}</span></button>`).join('')}</div>`;
const flowPanel = (f, inner) => `<div class="flowpanel" data-flow="${f.id}" role="tabpanel">${inner}</div>`;
const flowScope = f => `<dl class="scope flowscope">
      <div><dt>${icon('flag')}Result</dt><dd><span class="status${{ completed: '', partial: ' status--partial', blocked: ' status--blocked' }[f.audit.meta.status] ?? ''}">${esc(f.audit.meta.status[0].toUpperCase() + f.audit.meta.status.slice(1))}</span> ${esc(f.audit.meta.statusNote ?? '')}</dd></div>
      <div><dt>${icon('target')}Success means</dt><dd>${esc(f.audit.meta.success)}</dd></div>
      <div><dt>${icon('stars')}First value</dt><dd>${esc(f.audit.meta.firstValue)}</dd></div>
      <div><dt>${icon('crop')}Why this flow</dt><dd>${esc(f.why)}</dd></div>
    </dl>`;

const journey = `
<section class="section section--break" id="journey">
  <div class="section__head"><div><h2>The task, step by step</h2><p class="section__lede">Every state below was captured in the browser run. Interaction counts are cumulative: clicks, drags, key presses and typed strings.</p></div></div>
  ${flows ? `${flowTabs('journey')}${flows.map(f => flowPanel(f, `<div id="journey-${f.id}">${flowScope(f)}<ol class="journey">${audit.journey.filter(j => j.flow === f.id).map(journeyItem).join('')}</ol></div>`)).join('')}` : `<ol class="journey">
    ${audit.journey.map(journeyItem).join('')}
  </ol>`}
</section>`;


const findingCard = f => {
    const n = fIndex[f.id];
    const box = targetBox(f.target);
    const step = steps[f.target.source === 'checks' ? f.step : f.target.step];
    const related = (f.related ?? []).map((r, i) => ({ step: steps[r.step], box: steps[r.step]?.targets.find(t => t.id === r.id)?.box, label: r.label, i }));
    const relSameStep = related.filter(r => r.step.id === step.id);
    const relOther = related.filter(r => r.step.id !== step.id);
    const zoom = box ? crop(step, box, n) : '<p class="caption">Element could not be located in the DOM; no precise mark.</p>';
    const context = shot(step, [{ box, label: n }, ...relSameStep.map(r => ({ box: r.box, label: '·', ref: true }))], `${step.title}, full screen`);
    const others = relOther.map(r => `<div>${shot(r.step, [{ box: r.box, label: '·', ref: true }], r.label)}<p class="caption"><span>${esc(r.label)}</span><span>${stepName(r.step)}</span></p></div>`).join('');
    const sev = SEVERITY[f.severity];
    return `<article class="finding" id="${f.id}">
      <div class="finding__head">
        <div class="finding__id"><span class="pin">${n}</span><span>Finding ${n}</span></div>
        <div><h3 class="finding__title">${esc(f.title)}</h3>
          <p class="sev">${sevBar(f.severity)}${f.consequence === 'high' ? '<span class="tag tag--plain">High consequence if it happens</span>' : ''}<span class="sev__note">Confidence ${esc(f.confidence)}</span></p></div>
      </div>
      <div class="finding__figs"><div>${zoom}<p class="caption"><span>${esc(f.target.label)}</span><span>${stepName(step)}, zoomed</span></p></div><div class="finding__side"><div>${context}<p class="caption"><span>${esc(step.title)}</span><span>full screen</span></p></div>${others}</div></div>
      <dl class="finding__body">
        <div><dt>Observed</dt><dd>${esc(f.observed)}</dd></div>
        <div><dt>Why it matters</dt><dd>${esc(f.matters)}</dd></div>
        <div class="hyp"><dt>Hypothesis</dt><dd>${esc(f.hypothesis)}</dd></div>
        <div class="rec"><dt>Recommendation</dt><dd>${esc(f.recommendation)}</dd></div>
        <div><dt>Evidence</dt><dd>${esc(f.evidence)}${f.disagreement ? ` ${esc(f.disagreement)}` : ''}</dd></div>
      </dl>
    </article>`;
};
const findingsLede = 'Solid marks point at the element a finding is about. Dashed marks show related context. Positions come from the page\'s DOM, not from reading the image.';
const findings = `
<section class="section section--break" id="findings">
  <div class="section__head"><div><h2>Annotated walkthrough</h2><p class="section__lede">${findingsLede}</p></div></div>
  ${flows ? `${flowTabs('findings')}${flows.map(f => {
    const own = audit.findings.filter(x => x.flow === f.id);
    return flowPanel(f, own.length ? own.map(findingCard).join('') : '<p class="empty">Nothing in this flow passed the evidence gates.</p>');
  }).join('')}` : audit.findings.map(findingCard).join('')}
</section>`;

// Priorities as lanes of ready-to-file tasks. Each card carries its own issue text for "Copy as issue".
const LANES = [
  { key: 'now', name: 'Now', note: 'Cheap, low risk, do it this week', checks: 'Done when' },
  { key: 'next', name: 'Next', note: 'Worth doing, one question to settle first', checks: 'Decide first' },
  { key: 'test', name: 'Test first', note: 'Not proven yet, check with users before building', checks: 'Test first' },
];
const issueText = (r, lane) => {
  const f = audit.findings.find(x => x.id === r.refs[0]);
  return [
    r.change, '',
    `Observed: ${f.observed}`, '',
    `Recommendation: ${f.recommendation}`, '',
    `${lane.checks}:`, ...r.checks.map(c => `- [ ] ${c}`), '',
    `Evidence: ${f.evidence}`, '',
    `Source: ${m.product} task audit, ${date}, finding ${fIndex[f.id]}: ${f.title}`,
  ].join('\n');
};
const card = (r, lane, i) => {
  const f = audit.findings.find(x => x.id === r.refs[0]);
  const box = targetBox(f.target);
  const step = steps[f.target.source === 'checks' ? f.step : f.target.step];
  const evidence = box ? crop(step, box, fIndex[f.id], 40, 520, 240) : '';
  const checks = `<fieldset class="checks"><legend>${esc(lane.checks)}</legend>
      ${r.checks.map((c, k) => `<label><input type="checkbox" name="${esc(lane.key)}-${i}-${k}"><span>${esc(c)}</span></label>`).join('')}
    </fieldset>`;
  const copy = `<button type="button" class="copy" data-issue="${esc(issueText(r, lane))}">${icon('copy')}<span>Copy as issue</span></button>`;
  return `<article class="task">${evidence}<h3>${esc(r.change)}</h3>${checks}<div class="task__foot">${refs(r.refs)}${copy}</div></article>`;
};
const recs = `
<section class="section section--break" id="recommendations">
  <div class="section__head"><div><h2>What to change first</h2><p class="section__lede">Each card is a task you can copy into Linear, Jira or GitHub. No business impact is estimated; the audit has no usage data to estimate it from.</p></div></div>
  <div class="lanes">${LANES.map(l => {
    const items = audit.recommendations.filter(r => r.lane === l.key);
    return `<div class="lane"><header><h3>${l.name}${items.length ? `<span class="kccn__n">${items.length}</span>` : ''}</h3><p>${l.note}</p></header>${items.map((r, i) => card(r, l, i)).join('') || '<p class="empty">Nothing here.</p>'}</div>`;
  }).join('')}</div>
</section>`;

const severityKey = `
<section class="section" id="severity">
  <div class="section__head"><div><h2>How findings are ranked</h2></div></div>
  <dl class="finding__body sevkey">
    <div><dt>${sevBar('blocker')}</dt><dd>The task cannot be finished on the tested path, or only by a route most users would not find.</dd></div>
    <div><dt>${sevBar('significant')}</dt><dd>The task can be finished, but the issue costs real effort, causes errors, or puts the user's work at risk within the flow.</dd></div>
    <div><dt>${sevBar('minor')}</dt><dd>The task is finished with some extra effort or searching. Recovery is easy.</dd></div>
    <div><dt>${sevBar('observation')}</dt><dd>Worth knowing, not friction in this flow. Consequence is noted separately when it could be high.</dd></div>
  </dl>
</section>`;

const limits = `
<section class="section section--break" id="limits">
  <div class="section__head"><div><h2>What this audit cannot see</h2></div></div>
  <ul class="limits">${audit.cannotSee.map(l => typeof l === 'string'
    ? `<li><p>${esc(l)}</p></li>`
    : `<li>${icon(l.icon)}<h3>${esc(l.title)}</h3><p>${esc(l.text)}</p></li>`).join('')}</ul>

</section>`;

// Problems seen in more than one flow; only a multi-flow audit has them.
const patterns = audit.patterns?.length ? `
<section class="section section--break" id="patterns">
  <div class="section__head"><div><h2>Patterns across flows</h2><p class="section__lede">The same problem in more than one flow. One fix helps everywhere it appears.</p></div></div>
  <div class="kccn">${audit.patterns.map(p => row(esc(p.title), 'search', [{ text: p.text, refs: p.refs }])).join('')}</div>
</section>` : '';

// In a multi-flow report the active Journey or Findings link opens small flow tabs next to it in the bar.
const navFlows = section => flows ? `<span class="toc__sub">${flows.map(f => `<button type="button" data-flow="${f.id}" data-section="${section}" title="${esc(f.audit.meta.task)}">Flow ${f.n}</button>`).join('')}</span>` : '';
const nav = `
<nav class="toc" aria-label="Report sections"><div class="toc__bar">
  <a href="#overview">Overview</a>
  <a href="#summary">Summary</a>${audit.patterns?.length ? '<a href="#patterns">Patterns</a>' : ''}
  <a href="#journey">Journey</a>${navFlows('journey')}
  <a href="#findings">Findings<span class="toc__n">${audit.findings.length}</span></a>${navFlows('findings')}
  <a href="#recommendations">Priorities</a>
  <a href="#limits">Limits</a>
</div></nav>`;

// Highlights the section in view, and copies task text. The report reads fine without either.
const spy = `<script>
// Any screenshot opens full screen in a dialog, marks included. Click, Esc or the close button closes it.
const lb = Object.assign(document.createElement('dialog'), { className: 'lightbox' });
lb.setAttribute('aria-label', 'Screenshot, full screen');
document.body.append(lb);
lb.addEventListener('click', () => lb.close());
document.addEventListener('click', e => {
  const f = e.target.closest('.shot, .crop, .journey .thumb');
  if (!f || lb.contains(f)) return;
  const img = f.querySelector('img');
  const view = f.matches('.thumb') ? Object.assign(document.createElement('figure'), { className: 'shot' }) : f.cloneNode(true);
  if (f.matches('.thumb')) view.append(Object.assign(document.createElement('img'), { src: img.src, alt: img.alt }));
  const ratio = f.matches('.thumb') ? img.naturalWidth / img.naturalHeight : f.offsetWidth / f.offsetHeight;
  view.style.width = Math.min(innerWidth * 0.94, innerHeight * 0.9 * ratio) + 'px';
  const x = Object.assign(document.createElement('button'), { type: 'button', className: 'lightbox__x', textContent: 'Close' });
  lb.replaceChildren(view, x);
  lb.showModal();
});
document.addEventListener('click', async e => {
  const b = e.target.closest('.copy'); if (!b) return;
  e.preventDefault();
  const text = b.dataset.issue;
  try { await navigator.clipboard.writeText(text); }
  catch { const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  const label = b.querySelector('span'); label.textContent = 'Copied'; b.classList.add('is-done');
  setTimeout(() => { label.textContent = 'Copy as issue'; b.classList.remove('is-done'); }, 1600);
});
const links = [...document.querySelectorAll('.toc a')];
const io = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  links.forEach(a => a.toggleAttribute('aria-current', a.hash === '#' + e.target.id));
}), { rootMargin: '-40% 0px -55% 0px' });
links.forEach(a => { const s = document.querySelector(a.hash); if (s) io.observe(s); });
// Flow tabs: one choice drives Journey and Findings together; a link into a flow selects it first.
const tabs = [...document.querySelectorAll('.flowtabs [data-flow], .toc__sub [data-flow]')];
if (tabs.length) {
  const pick = id => {
    tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.flow === id));
    document.querySelectorAll('.flowpanel').forEach(p => { p.hidden = p.dataset.flow !== id; });
  };
  tabs.forEach(t => t.addEventListener('click', () => {
    pick(t.dataset.flow);
    if (t.dataset.section) document.getElementById(t.dataset.section).scrollIntoView();
  }));
  const follow = () => {
    const t = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const panel = t?.closest('.flowpanel');
    if (panel) { pick(panel.dataset.flow); t.scrollIntoView(); }
  };
  pick(tabs[0].dataset.flow);
  addEventListener('hashchange', follow);
  follow();
}
</script>`;

const colophon = `
<footer class="colophon">
  <p class="colophon__note">${esc(AGENT.disclaimer)}</p>
  <p class="colophon__by">Generated by <a href="${esc(AGENT.repo)}">${esc(AGENT.name)}</a>, a source-available task audit for Claude Code. Made by <a href="${esc(tagged(AGENT.authorUrl, slug))}">${esc(AGENT.author)}</a>.</p>
  <p class="colophon__by">${esc(AGENT.contact.text)} <a href="mailto:${esc(AGENT.contact.email)}?subject=${encodeURIComponent(`${m.product}: product question`)}">${esc(AGENT.contact.email)}</a></p>
  <p>Built from structured capture data: <span class="num">data/capture.json</span>, <span class="num">data/checks.json</span>, <span class="num">data/audit.json</span>. Screenshots are unedited; marks are drawn over them. AI-assisted findings can be wrong; each one lists its evidence.</p>
  <p>${esc(m.author)}</p>
</footer>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="ux-audit-agent by Andriy Yurchenko (https://ayurchenko.xyz)">\n<!-- Required Notice: Copyright Andriy Yurchenko (https://ayurchenko.xyz). Report generated by ux-audit-agent. -->
<title>${esc(m.product)} task audit</title>
<style>${css}</style>
</head>
<body><main class="page">${nav}${flows ? multiHeader() : header}${summary}${patterns}${journey}${findings}${recs}${severityKey}${limits}${cta()}${colophon}</main>${spy}</body>
</html>`;

await writeFile(`${dir}index.html`, html);
console.log('wrote', `${dir}index.html`);

// --single: one shareable file with every screenshot embedded.
if (process.argv.includes('--single')) {
  const files = [...new Set([...html.matchAll(/src="((?:flows\/[a-z0-9]+\/)?assets\/[^"]+)"/g)].map(x => x[1]))];
  const mime = f => (f.endsWith('.png') ? 'image/png' : 'image/jpeg');
  const data = Object.fromEntries(await Promise.all(files.map(async f => [f, `data:${mime(f)};base64,${(await readFile(`${dir}${f}`)).toString('base64')}`])));
  // Each screenshot is embedded once; its other uses (thumbnail, zoom, full screen) copy it on load.
  const seen = new Set();
  const blank = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const single = html
    .replace(/src="((?:flows\/[a-z0-9]+\/)?assets\/[^"]+)"/g, (_, f) => (seen.has(f) ? `data-asset="${f}" src="${blank}"` : (seen.add(f), `data-asset="${f}" src="${data[f]}"`)))
    .replace('</body>', `<script>for (const i of document.querySelectorAll('img[data-asset]')) i.src = document.querySelector(\`img[data-asset="\${i.dataset.asset}"]\`).src;</script></body>`);
  const name = `${slug}-task-audit.html`;
  await writeFile(`${dir}${name}`, single);
  console.log('wrote', `${dir}${name}`, `${(single.length / 1e6).toFixed(1)} MB`);
}

if (process.argv.includes('--pdf')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.goto(`file://${dir}index.html`, { waitUntil: 'load' });
  await page.pdf({ path: `${dir}audit.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log('wrote', `${dir}audit.pdf`);
}
