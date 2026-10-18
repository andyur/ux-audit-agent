// Refuses to build a report whose claims are not tied to evidence.
// Returns a list of errors; an empty list means the data is publishable.
const STATUSES = ['completed', 'partial', 'blocked', 'insufficient'];
const SEVERITIES = ['blocker', 'significant', 'minor', 'observation'];
const LANES = ['now', 'next', 'test'];
const filled = v => typeof v === 'string' && v.trim().length > 0;

export function validate({ capture, checks, audit }) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const stepIds = new Set(capture.steps.map(s => s.id));
  const findingIds = new Set(audit.findings.map(f => f.id));
  const refOk = r => stepIds.has(r) || findingIds.has(r);

  if (!STATUSES.includes(audit.meta?.status)) err('meta.status', `must be one of ${STATUSES.join(', ')}`);
  for (const k of ['product', 'url', 'task', 'success', 'firstValue', 'startingState', 'environment']) {
    if (!filled(audit.meta?.[k])) err(`meta.${k}`, 'missing');
  }

  for (const s of capture.steps) {
    if (!filled(s.screenshot?.file)) err(`step ${s.id}`, 'no screenshot');
    if (!s.screenshot?.cssWidth || !s.screenshot?.cssHeight) err(`step ${s.id}`, 'screenshot has no CSS size');
  }

  for (const j of audit.journey) {
    if (!stepIds.has(j.step)) err(`journey ${j.step}`, 'step not in capture');
    for (const f of j.findings ?? []) if (!findingIds.has(f)) err(`journey ${j.step}`, `unknown finding ${f}`);
  }
  if (audit.meta?.status === 'completed' && !audit.journey.some(j => j.firstValue)) err('journey', 'completed audit with no first-value step');

  for (const [cat, items] of Object.entries(audit.summary ?? {})) {
    if (!Array.isArray(items)) continue;
    items.forEach((it, i) => {
      if (!filled(it.text)) err(`summary.${cat}[${i}]`, 'empty text');
      if (!it.refs?.length) err(`summary.${cat}[${i}]`, 'no reference to a step or finding');
      for (const r of it.refs ?? []) if (!refOk(r)) err(`summary.${cat}[${i}]`, `unknown reference ${r}`);
    });
  }
  if (Array.isArray(audit.summary?.cut) && !audit.summary.cut.length && !filled(audit.summary.cutNote)) err('summary.cut', 'empty without a note saying why');

  for (const f of audit.findings) {
    const w = `finding ${f.id}`;
    for (const k of ['title', 'observed', 'matters', 'hypothesis', 'recommendation', 'evidence']) if (!filled(f[k])) err(w, `${k} missing`);
    if (!SEVERITIES.includes(f.severity)) err(w, `severity must be one of ${SEVERITIES.join(', ')}`);
    if (!['high', 'medium', 'low'].includes(f.confidence)) err(w, 'confidence must be high, medium or low');
    const t = f.target ?? {};
    if (t.source === 'checks') {
      const box = t.path?.split('.').reduce((o, k) => o?.[k], checks);
      if (!box) err(w, `target path ${t.path} not found in checks`);
    } else {
      const step = capture.steps.find(s => s.id === t.step);
      if (!step) err(w, `target step ${t.step} not in capture`);
      else if (!step.targets.find(x => x.id === t.id)) err(w, `target ${t.id} not measured on ${t.step}`);
    }
    if (!audit.journey.some(j => j.findings?.includes(f.id)) && !audit.recommendations.some(r => r.refs?.includes(f.id))) {
      err(w, 'not referenced from the journey or the priorities');
    }
  }

  audit.recommendations.forEach((r, i) => {
    const w = `priority ${i + 1}`;
    if (!LANES.includes(r.lane)) err(w, `lane must be one of ${LANES.join(', ')}`);
    if (!filled(r.change)) err(w, 'change missing');
    if (!r.checks?.length) err(w, 'no checks');
    if (!r.refs?.length || !r.refs.every(x => findingIds.has(x))) err(w, 'must point to existing findings');
  });

  if (!audit.cannotSee?.length) err('cannotSee', 'the limits section is empty');
  return errors;
}
