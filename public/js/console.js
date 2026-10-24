import { el, clear, api, connectSse, ensureAdminAccess, fmtTime, setNumber, isFresh, flash } from './common.js';
import { createLiveMap } from './map.js';

// Items already on screen do not animate again. New ones slide in once.
const seen = { approvals: new Set(), alerts: new Set(), calls: new Set(), dispatches: new Set(), log: new Set() };
const stockSeen = new Map();
let firstRender = true;
const animate = () => !firstRender;
const setCount = (id, n) => {
  const node = $(id);
  node.textContent = String(n);
  node.classList.toggle('hot', n > 0);
};

const $ = (id) => document.getElementById(id);
let token = '';
let snap = null;
let showDebug = false;

const post = (path, body) => api(path, { method: 'POST', body, token });

async function act(button, fn) {
  button.disabled = true;
  try { await fn(); } catch (err) { alert(`That did not work: ${err.message}`); }
  finally { button.disabled = false; }
}

// ------------------------------------------------------------------ renderers

function renderKpis(m) {
  const items = [
    ['Calls', m.callsStarted], ['Dispatched', m.dispatches],
    ['Avg time to dispatch', m.avgTimeToDispatchSec == null ? '–' : `${m.avgTimeToDispatchSec}s`],
    ['Miles saved by batching', m.milesSavedByBatching], ['Batched jobs', m.batchedJobs],
    ['Last re-plan', m.lastReplanMs == null ? '–' : `${(m.lastReplanMs / 1000).toFixed(1)}s`],
    ['Red flags', m.redFlags],
  ];
  const root = $('kpis');
  if (!kpiNodes.length) {
    clear(root);
    for (const [label] of items) {
      const value = el('b');
      kpiNodes.push(value);
      root.append(el('div', { class: 'kpi' }, value, el('span', { text: label })));
    }
  }
  items.forEach(([, value], i) => {
    const node = kpiNodes[i];
    const before = node.textContent;
    setNumber(node, String(value));
    if (animate() && before !== String(value)) flash(node.parentElement, 'kpi-tick');
  });
}
const kpiNodes = [];

function renderApprovals(list) {
  const root = clear($('approvals'));
  const pending = list.filter((a) => a.status === 'pending');
  setCount('approvals-count', pending.length);
  if (!pending.length) root.append(el('div', { class: 'empty', text: 'Nothing waiting.' }));
  for (const a of pending) {
    const approve = el('button', { class: 'btn good small', type: 'button', text: 'Approve' });
    const reject = el('button', { class: 'btn danger small', type: 'button', text: 'Reject' });
    approve.addEventListener('click', () => act(approve, () => post(`/api/admin/approvals/${a.id}/approve`)));
    reject.addEventListener('click', () => act(reject, () => post(`/api/admin/approvals/${a.id}/reject`)));
    root.append(el('div', { class: `item attn${isFresh(seen.approvals, a.id, animate()) ? ' fresh' : ''}` },
      el('div', { class: 'row' }, el('b', { text: a.id }), el('span', { class: 'small muted', text: fmtTime(a.createdAt) })),
      el('div', { text: a.summary }),
      el('div', { class: 'actions' }, approve, reject)));
  }
  const decided = list.filter((a) => a.status !== 'pending').slice(-3).reverse();
  for (const a of decided) root.append(el('div', { class: 'small muted', text: `${a.id} ${a.status}: ${a.summary.slice(0, 70)}` }));
}

function renderAlerts(alerts) {
  const root = clear($('alerts'));
  const open = alerts.filter((a) => !a.acknowledged).reverse();
  setCount('alerts-count', open.length);
  if (!open.length) root.append(el('div', { class: 'empty', text: 'No open alerts.' }));
  for (const a of open) {
    const ack = el('button', { class: 'btn small', type: 'button', text: 'Acknowledge' });
    ack.addEventListener('click', () => act(ack, () => post(`/api/admin/alerts/${a.id}/ack`)));
    const key = a.id ?? `${a.ts}|${a.title}`;
    const fresh = isFresh(seen.alerts, key, animate()) ? ' fresh' : '';
    root.append(el('div', { class: `item ${a.severity === 'critical' ? 'crit' : 'attn'}${fresh}` },
      el('div', { class: 'row' }, el('b', { text: a.title }), el('span', { class: 'small muted', text: fmtTime(a.ts) })),
      el('div', { text: a.detail }), el('div', { class: 'actions' }, ack)));
  }
  const critical = open.filter((a) => a.severity === 'critical').length;
  document.title = `${critical ? `(${critical}) ` : ''}Lifeline — Coordinator console`;
}

function renderCalls(sessions) {
  const root = clear($('calls'));
  if (!sessions.length) root.append(el('div', { class: 'empty', text: 'No calls yet.' }));
  for (const s of [...sessions].reverse().slice(0, 6)) {
    const fresh = isFresh(seen.calls, s.id, animate()) ? ' fresh' : '';
    root.append(el('div', { class: `item ${s.redFlagged ? 'crit' : ''}${fresh}` },
      el('div', { class: 'row' },
        el('b', { text: `${s.direction === 'outbound' ? '↗ ' : '↙ '}${s.resident ?? `Caller ${s.shortId}`}` }),
        el('span', { class: 'small muted', text: `${s.neighborhood} · ${s.language}${s.need ? ` · ${s.need.resource_type}/${s.need.urgency}` : ''}` })),
      ...s.transcript.slice(-4).map((t) => el('div', { class: 'talk' }, el('b', { text: t.role === 'user' ? 'Caller: ' : 'Lifeline: ' }), t.text))));
  }
}

function renderHolds(holds) {
  const root = clear($('holds'));
  const active = holds.filter((h) => h.status === 'active');
  if (!active.length) root.append(el('div', { class: 'empty', text: 'No active holds.' }));
  for (const h of active) {
    const out = el('button', { class: 'btn danger small', type: 'button', text: 'Out of stock' });
    out.addEventListener('click', () => act(out, () => post('/api/admin/stock-out', { siteId: h.siteId, item: h.item })));
    root.append(el('div', { class: 'item' },
      el('div', { class: 'row' }, el('b', { text: `${h.id} · ${h.itemLabel}` }), out),
      el('div', { class: 'small muted', text: h.siteName })));
  }
  const voided = holds.filter((h) => h.status === 'void').slice(-3);
  for (const h of voided) root.append(el('div', { class: 'small muted', text: `${h.id} void (site out of stock): ${h.itemLabel} at ${h.siteName}` }));
}

function renderDispatches(dispatches, drivers) {
  const root = clear($('dispatches'));
  root.append(el('div', { class: 'small' }, drivers.map((d) => `${d.name}: ${d.load ? `${d.load} job${d.load > 1 ? 's' : ''}` : 'free'}`).join(' · ')));
  const live = dispatches.filter((d) => !['delivered'].includes(d.status)).slice(-6).reverse();
  if (!live.length) root.append(el('div', { class: 'empty', text: 'No active dispatches.' }));
  for (const d of live) {
    const fresh = isFresh(seen.dispatches, d.id, animate()) ? ' fresh' : '';
    const stage = { assigned: 0, rerouting: 1, accepted: 1, delivered: 2 }[d.status] ?? -1;
    const steps = ['Assigned', 'Accepted', 'Delivered'].map((label, i) =>
      el('li', { class: i < stage ? 'done' : i === stage ? 'now' : '' }, el('span', { class: 'dot' }), label));
    root.append(el('div', { class: `item ${d.status === 'failed' ? 'crit' : ''}${fresh}` },
      el('div', { class: 'row' }, el('b', { text: `${d.id} · ${d.driver?.name ?? 'unassigned'}` }),
        el('span', { class: 'small', text: `${d.status}${d.etaMin ? ` · ~${d.etaMin} min` : ''}${d.batched ? ' · batched' : ''}` })),
      el('ol', { class: 'stepper', 'aria-label': `Status: ${d.status}` }, steps),
      el('div', { class: 'small', text: `${d.pickup.label} → ${d.dropoff.label}` }),
      d.error ? el('div', { class: 'small', text: d.error }) : null));
  }
}

function renderSites(sites) {
  const root = clear($('sites'));
  const table = el('table', { class: 'inv' }, el('thead', {}, el('tr', {}, el('th', { text: 'Site' }), el('th', { text: 'Stock' }))));
  const body = el('tbody');
  for (const s of sites) {
    const items = Object.entries(s.inventory).map(([k, v]) => {
      const out = el('button', { class: 'btn small', type: 'button', title: `Mark ${k} out of stock at ${s.name}`, text: '✕' });
      out.addEventListener('click', () => act(out, () => post('/api/admin/stock-out', { siteId: s.id, item: k })));
      const start = s.initialInventory?.[k] || v || 1;
      const bar = el('i', { class: 'stock-bar' });
      bar.style.setProperty('--w', `${Math.max(0, Math.min(100, (v / start) * 100))}%`);
      const key = `${s.id}:${k}`;
      if (animate() && stockSeen.has(key) && stockSeen.get(key) !== v) flashLater.push(key);
      stockSeen.set(key, v);
      return el('span', { class: `stock ${v === 0 ? 'zero' : ''}`, dataset: { key } }, `${k.replace(/_/g, ' ')}: ${v} `, v > 0 ? out : null, bar);
    });
    body.append(el('tr', {}, el('td', {}, el('b', { text: s.name }), el('div', { class: 'small muted', text: s.open ? s.hours : s.hours }), s.hasPower ? null : el('span', { class: 'badge off', text: 'no power' })), el('td', {}, items)));
  }
  table.append(body);
  root.append(table);
  for (const key of flashLater.splice(0)) {
    const node = table.querySelector(`[data-key="${key}"]`);
    if (node) flash(node, 'tick');
  }
}
const flashLater = [];

function renderLog(log) {
  const root = $('log');
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 60;
  clear(root);
  const shown = log.filter((l) => showDebug || l.level !== 'debug');
  for (const l of shown) {
    const fresh = isFresh(seen.log, `${l.ts}|${l.summary}`, animate()) ? ' fresh' : '';
    root.append(el('div', { class: `entry ${l.level}${fresh}` },
      el('span', { class: 'when', text: fmtTime(l.ts) }), el('span', { class: 'kind', text: l.kind }), l.summary,
      l.reason ? el('span', { class: 'why', text: `why: ${l.reason}` }) : null));
  }
  $('log-count').textContent = `${shown.length} entries, oldest first`;
  if (nearBottom) root.scrollTop = root.scrollHeight;
}

function renderResidents(residents) {
  const sel = $('resident');
  const current = sel.value;
  clear(sel);
  for (const r of residents) sel.append(el('option', { value: r.id, text: `${r.displayName}${r.ringing ? ' · page open' : ''}` }));
  if (current) sel.value = current;
}

let liveMap = null;

function render() {
  if (!snap) return;
  // Created on first render, after the console is visible, so Leaflet measures a real size.
  liveMap ??= createLiveMap($('map'));
  liveMap.update(snap);
  renderKpis(snap.metrics);
  renderApprovals(snap.approvals);
  renderAlerts(snap.alerts);
  renderCalls(snap.sessions);
  renderHolds(snap.holds);
  renderDispatches(snap.dispatches, snap.drivers);
  renderSites(snap.sites);
  renderLog(snap.log);
  renderResidents(snap.residents);
  firstRender = false;
  $('approval-toggle').checked = snap.settings.requireMedicineApproval;
}

// ------------------------------------------------------------------ AWS footprint

const CONSOLE_HOST = /^https:\/\/([a-z0-9-]+\.)?console\.aws\.amazon\.com\//;

function awsLink(href, text, cls = 'btn small') {
  // Only ever render links that point at the AWS console.
  if (typeof href !== 'string' || !CONSOLE_HOST.test(href)) return null;
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls, text });
}

function awsRow(label, value, link) {
  return el('div', { class: 'aws-row' }, el('span', { class: 'aws-label', text: label }), el('span', { class: 'aws-value' }, value, ' ', link));
}

async function loadAws() {
  const root = clear($('aws'));
  let a;
  try { a = await api('/api/admin/aws', { token }); } catch { root.append(el('div', { class: 'empty', text: 'Could not read AWS status.' })); return; }

  const badge = $('aws-badge');
  if (!a.configured) {
    badge.textContent = 'not set up';
    badge.className = 'badge off';
    root.append(el('p', { class: 'small', text: a.setupHint }), el('code', { class: 'small', text: './infra/aws-setup.sh' }));
    return;
  }
  const healthy = a.telemetry.enabled && a.telemetry.errors === 0 && a.guardrail;
  badge.textContent = healthy ? 'connected' : 'attention';
  badge.className = `badge ${healthy ? 'live' : 'off'}`;

  const L = a.links ?? {};
  root.append(
    el('div', { class: 'aws-cta' }, awsLink(L.dashboard, 'Open AWS dashboard', 'btn primary small')),
    awsRow('Account · region', `${a.account} · ${a.region}`),
    awsRow('Model', a.model),
    awsRow('Guardrail', a.guardrail ? `${a.guardrail.id} (v${a.guardrail.version}) on every call` : 'off', awsLink(L.guardrails, 'View')),
    awsRow('Request logs', a.invocationLogging ? `${a.invocationLogging.logGroup}, ${a.invocationLogging.fullText ? 'full text' : 'metadata only'}, kept ${a.invocationLogging.retentionDays} day` : 'off', awsLink(L.invocationLogs, 'View')),
    awsRow('Decision log', a.telemetry.enabled ? `${a.telemetry.shippedEvents} events sent${a.telemetry.errors ? `, ${a.telemetry.errors} errors (${a.telemetry.lastError})` : ''}` : 'not shipping', awsLink(L.decisionLogs, 'View')),
    awsRow('Metrics', a.telemetry.enabled ? `LifelineLive namespace, ${a.telemetry.shippedMetricPoints} points sent` : 'not shipping', awsLink(L.metrics, 'View')),
    el('p', { class: 'small muted', text: 'Links open the AWS Console and need you to be signed in to this account.' }),
  );
}

// ------------------------------------------------------------------ surge chart

async function loadSurge() {
  const root = clear($('surge'));
  let data = null;
  try { data = await api('/api/admin/surge-results', { token }); } catch { /* none yet */ }
  if (!data?.tool?.length) {
    root.append(el('div', { class: 'empty', text: 'No results yet. Run: ENABLE_TEST_API=1 npm start, then npm run surge.' }));
    return;
  }
  const runs = data.tool;
  const W = 420, H = 190, pad = { l: 44, r: 10, t: 12, b: 38 };
  const max = Math.max(...runs.map((r) => r.p95), 10);
  const bw = (W - pad.l - pad.r) / runs.length;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `p95 latency by concurrency: ${runs.map((r) => `${r.concurrency} concurrent ${r.p95} ms`).join(', ')}`);
  const mk = (name, attrs, text) => { const n = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; svg.append(n); return n; };
  mk('line', { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, stroke: '#aab7b8' });
  mk('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: H - pad.b, stroke: '#aab7b8' });
  mk('text', { x: 4, y: pad.t + 8 }, `${max} ms`);
  mk('text', { x: 4, y: H - pad.b }, '0');
  runs.forEach((r, i) => {
    const h = ((H - pad.t - pad.b) * r.p95) / max;
    const x = pad.l + i * bw + bw * 0.2;
    mk('rect', { x, y: H - pad.b - h, width: bw * 0.6, height: Math.max(1, h), fill: r.errorRate > 0 ? '#d13212' : '#ff9900', rx: 3 });
    mk('text', { x: x + bw * 0.3, y: H - pad.b - h - 4, 'text-anchor': 'middle' }, `${r.p95}`);
    mk('text', { x: x + bw * 0.3, y: H - pad.b + 14, 'text-anchor': 'middle' }, `${r.concurrency}`);
  });
  mk('text', { x: pad.l + (W - pad.l - pad.r) / 2, y: H - 6, 'text-anchor': 'middle' }, 'concurrent requests → p95 latency (ms)');
  root.append(svg);
  const table = el('table', { class: 'inv' }, el('thead', {}, el('tr', {}, ['Concurrent', 'Dispatched', 'Queued*', 'Errors', 'p50', 'p95', 'p99', 'req/s'].map((h) => el('th', { text: h })))));
  const body = el('tbody');
  for (const r of runs) body.append(el('tr', {}, [r.concurrency, r.dispatched ?? r.ok, r.queued ?? 0, `${r.errors} (${(r.errorRate * 100).toFixed(1)}%)`, `${r.p50} ms`, `${r.p95} ms`, `${r.p99} ms`, r.rps].map((v) => el('td', { text: String(v) }))));
  table.append(body);
  root.append(table);
  if (data.agent) root.append(el('p', { class: 'small', text: `Through the live agent (${data.agent.sessions} concurrent calls): p95 ${data.agent.p95} ms, ${data.agent.errors} errors. ${data.agent.note ?? ''}` }));
  root.append(el('p', { class: 'small muted', text: '*Queued: the hold stands but all 4 volunteers are at capacity (3 stops each), so the coordinator is alerted. Capacity is limited by drivers, not by the software.' }));
  root.append(el('p', { class: 'small muted', text: `Tool layer + HTTP on this machine, isolated store. ${data.generatedAt}` }));
}

// ------------------------------------------------------------------ boot

async function boot() {
  token = await ensureAdminAccess($('gate-mount'), { title: 'Coordinator console' });
  $('app').classList.remove('hidden');

  $('approval-toggle').addEventListener('change', (e) => post('/api/admin/settings', { requireMedicineApproval: e.target.checked }).catch((err) => alert(err.message)));
  $('debug-toggle').addEventListener('change', (e) => { showDebug = e.target.checked; render(); });
  $('reset').addEventListener('click', () => { if (confirm('Reset all demo data? Active calls will lose their holds.')) act($('reset'), () => post('/api/admin/reset')); });
  $('call-btn').addEventListener('click', () => act($('call-btn'), async () => {
    const r = await post('/api/admin/outbound-call', { residentId: $('resident').value });
    $('call-note').textContent = r.ringing ? 'Ringing. Waiting for the resident to answer…' : 'No caller page is open for that resident, so nothing is ringing. Open the caller page and choose the resident under "Demo".';
  }));

  connectSse('/api/admin/stream', {
    token,
    onEvent: (event, data) => { if (event === 'snapshot') { snap = data; render(); } },
    onStatus: (s) => {
      const b = $('conn');
      b.textContent = s;
      b.className = `badge ${s === 'live' ? 'live' : 'off'}`;
    },
  });
  loadSurge();
  setInterval(loadSurge, 20000);
  loadAws();
  setInterval(loadAws, 15000);
}

boot().catch((e) => { document.body.prepend(el('p', { text: `Console failed to load: ${e.message}` })); });
