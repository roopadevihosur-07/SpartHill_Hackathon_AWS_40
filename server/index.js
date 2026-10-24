import express from 'express';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config, isLoopback, aws } from './config.js';
import * as telemetry from './telemetry.js';
import { seed } from './seed.js';
import {
  createStore, resetStore, createSession, adminSnapshot, buildCards, dispatchCardFor, logDecision, sweep, touch,
} from './store.js';
import { handleUserMessage, GREETINGS, dropContext } from './agent.js';
import {
  decideApproval, handleStockOut, placeOutboundCall, answerOutboundCall, driverAction,
} from './orchestrator.js';
import { runTool } from './tools/index.js';
import { warmShortageCache } from './tools/external.js';

if (!isLoopback(config.host) && !config.adminToken) {
  console.error(`Refusing to listen on ${config.host} without ADMIN_TOKEN. The coordinator console can approve medicine holds and reset data.\nSet ADMIN_TOKEN in .env, or use HOST=127.0.0.1.`);
  process.exit(1);
}

const store = createStore(seed);
// Only the live store ships to CloudWatch. The isolated surge-test store never does.
store.emitter.on('decision', (entry) => { try { telemetry.fromDecision(entry); } catch { /* telemetry must never affect a request */ } });
store.emitter.on('session_expired', dropContext);
store.emitter.on('reset', () => {
  for (const id of [...store.sessions.keys()]) dropContext(id);
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' https://cdnjs.cloudflare.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});

// ------------------------------------------------------------------ helpers

const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || rec.reset <= now) hits.set(key, { count: 1, reset: now + 60_000 });
  else if (++rec.count > config.rateLimitPerMin) {
    res.set('Retry-After', String(Math.ceil((rec.reset - now) / 1000)));
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 60_000).unref();

function tokenOk(provided) {
  if (!config.adminToken) return true; // loopback-only, enforced at startup
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
const requireAdmin = (req, res, next) =>
  tokenOk(req.get('x-admin-token')) ? next() : res.status(401).json({ error: 'unauthorized' });

function openSse(req, res, onClose) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
  req.on('close', () => { clearInterval(hb); onClose?.(); });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const getSession = (id) => (typeof id === 'string' ? store.sessions.get(id) : undefined);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'server_error' });
});

// ------------------------------------------------------------------ caller API

app.get('/api/health', (req, res) => res.json({ ok: true, model: store.metrics.model ?? config.modelId, configuredModel: config.modelId, region: config.region, guardrail: Boolean(config.guardrailId), cloudwatch: telemetry.status().enabled }));

app.get('/api/config', (req, res) => {
  res.json({
    neighborhoods: Object.entries(store.neighborhoods).map(([id, n]) => ({ id, label: n.label })),
    residents: config.demoMode ? [...store.residents.values()].map((r) => ({ id: r.id, displayName: r.displayName, language: r.language })) : [],
    languages: [{ id: 'en', label: 'English' }, { id: 'es', label: 'Español' }, { id: 'vi', label: 'Tiếng Việt' }],
    maxMessageChars: config.maxMessageChars,
  });
});

app.post('/api/session', rateLimit, (req, res) => {
  const { neighborhood, language } = req.body ?? {};
  const session = createSession(store, { neighborhood, language });
  res.json({ sessionId: session.id, language: session.language, greeting: GREETINGS[session.language] });
  logDecision(store, { sessionId: session.id, kind: 'call', summary: 'Inbound session started', reason: 'Caller opened the page and started a call' });
});

app.post('/api/session/:id/settings', rateLimit, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'unknown_session' });
  const { language } = req.body ?? {};
  if (['en', 'es', 'vi'].includes(language)) session.language = language;
  res.json({ ok: true, language: session.language, greeting: GREETINGS[session.language] });
});

app.post('/api/chat', rateLimit, wrap(async (req, res) => {
  const { sessionId, message, clientMsgId } = req.body ?? {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown_session' });
  if (typeof message !== 'string') return res.status(400).json({ error: 'message must be a string' });
  if (message.length > config.maxMessageChars) return res.status(400).json({ error: `message is longer than ${config.maxMessageChars} characters` });
  const id = typeof clientMsgId === 'string' ? clientMsgId.slice(0, 60) : undefined;
  res.json(await handleUserMessage(store, session, message, id));
}));

app.get('/api/events/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'unknown_session' });
  const channel = `session:${session.id}`;
  const send = openSse(req, res, () => store.emitter.off(channel, handler));
  const handler = ({ event, data }) => send(event, data);
  store.emitter.on(channel, handler);
  send('cards', buildCards(store, session));
});

app.get('/api/resident-events/:id', (req, res) => {
  if (!config.demoMode || !store.residents.has(req.params.id)) return res.status(404).json({ error: 'unknown_resident' });
  const channel = `resident:${req.params.id}`;
  const send = openSse(req, res, () => { store.emitter.off(channel, handler); touch(store); });
  const handler = ({ event, data }) => send(event, data);
  store.emitter.on(channel, handler);
  send('ready', {});
  touch(store);
});

app.post('/api/resident/:id/answer', rateLimit, wrap(async (req, res) => {
  if (!config.demoMode) return res.status(404).json({ error: 'not_found' });
  const out = await answerOutboundCall(store, req.params.id, req.body?.callId);
  if (!out.ok) return res.status(out.status ?? 400).json({ error: out.error });
  res.json(out);
}));

// ------------------------------------------------------------------ coordinator API

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/ping', (req, res) => res.json({ ok: true }));
admin.get('/state', (req, res) => res.json(adminSnapshot(store)));

admin.get('/stream', (req, res) => {
  let timer = null;
  const push = () => { timer = null; send('snapshot', adminSnapshot(store)); };
  const onChange = () => { if (!timer) timer = setTimeout(push, 120); };
  const send = openSse(req, res, () => { store.emitter.off('changed', onChange); clearTimeout(timer); });
  store.emitter.on('changed', onChange);
  push();
});

admin.post('/stock-out', wrap(async (req, res) => {
  const { siteId, item } = req.body ?? {};
  const out = handleStockOut(store, { siteId, item });
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true, affectedHolds: out.affectedHolds });
}));

admin.post('/approvals/:id/:decision', wrap(async (req, res) => {
  const out = decideApproval(store, req.params.id, req.params.decision === 'approve' ? 'approve' : req.params.decision === 'reject' ? 'reject' : 'invalid');
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true, status: out.approval.status });
}));

admin.post('/alerts/:id/ack', (req, res) => {
  const alert = store.alerts.find((a) => a.id === Number(req.params.id));
  if (!alert) return res.status(404).json({ error: 'unknown_alert' });
  alert.acknowledged = true;
  touch(store);
  res.json({ ok: true });
});

admin.post('/settings', (req, res) => {
  if (typeof req.body?.requireMedicineApproval === 'boolean') {
    store.settings.requireMedicineApproval = req.body.requireMedicineApproval;
    logDecision(store, { kind: 'settings', level: 'attention', summary: `Medicine approval requirement turned ${store.settings.requireMedicineApproval ? 'ON' : 'OFF'}`, reason: 'Coordinator setting' });
  }
  res.json({ ok: true, settings: store.settings });
});

admin.post('/outbound-call', (req, res) => {
  const out = placeOutboundCall(store, req.body?.residentId);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.json(out);
});

admin.post('/reset', (req, res) => {
  resetStore(store);
  logDecision(store, { kind: 'settings', summary: 'Demo data reset to the seed', reason: 'Coordinator pressed reset' });
  res.json({ ok: true });
});

// What exists in the AWS account and where to look at it. Links need a console sign-in.
admin.get('/aws', (req, res) => {
  res.json({
    configured: Boolean(aws),
    region: aws?.region ?? config.region,
    account: aws?.account ?? null,
    model: store.metrics.model ?? config.modelId,
    guardrail: config.guardrailId ? { id: config.guardrailId, version: config.guardrailVersion } : null,
    invocationLogging: aws ? { logGroup: aws.invocationLogGroup, fullText: aws.logBodies, retentionDays: aws.retentionDays } : null,
    telemetry: telemetry.status(),
    links: aws?.links ?? null,
    setupHint: aws ? null : 'Run ./infra/aws-setup.sh to create the logging, guardrail and dashboard, then restart.',
  });
});

admin.get('/surge-results', wrap(async (req, res) => {
  try {
    res.json(JSON.parse(await readFile(new URL('../data/surge-results.json', import.meta.url), 'utf8')));
  } catch {
    res.json(null);
  }
}));

app.use('/api/admin', admin);

// ------------------------------------------------------------------ driver API (same token)

const driver = express.Router();
driver.use(requireAdmin);

driver.get('/list', (req, res) => res.json([...store.drivers.values()].map((d) => ({ id: d.id, name: d.name, vehicle: d.vehicle }))));

driver.get('/:id/stream', (req, res) => {
  if (!store.drivers.has(req.params.id)) return res.status(404).json({ error: 'unknown_driver' });
  let timer = null;
  const push = () => {
    timer = null;
    send('dispatches', [...store.dispatches.values()]
      .filter((d) => d.driverId === req.params.id && !['failed'].includes(d.status))
      .slice(-10)
      .map((d) => dispatchCardFor(store, d)));
  };
  const onChange = () => { if (!timer) timer = setTimeout(push, 100); };
  const send = openSse(req, res, () => { store.emitter.off('changed', onChange); clearTimeout(timer); });
  store.emitter.on('changed', onChange);
  push();
});

driver.post('/:id/dispatch/:dispatchId/:action', (req, res) => {
  const out = driverAction(store, req.params.dispatchId, req.params.id, req.params.action);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true });
});

app.use('/api/driver', driver);

// ------------------------------------------------------------------ test API (opt-in)

if (config.enableTestApi) {
  console.warn('ENABLE_TEST_API=1: /api/_test/* is exposed. Do not use this setting on a shared network.');
  let surge = null;
  const freshSurge = () => {
    const s = createStore({
      ...seed,
      sites: seed.sites.map((x) => ({ ...x, open: true, hasPower: true, inventory: Object.fromEntries(Object.keys(x.inventory).map((k) => [k, 1_000_000])) })),
    });
    s.settings.requireMedicineApproval = false;
    return s;
  };

  app.post('/api/_test/surge/reset', requireAdmin, (req, res) => { surge = freshSurge(); res.json({ ok: true }); });

  // One simulated caller: classify -> find -> reserve -> dispatch, against an isolated store.
  app.post('/api/_test/surge/chain', requireAdmin, wrap(async (req, res) => {
    surge ??= freshSurge();
    const t0 = performance.now();
    const hoods = Object.keys(surge.neighborhoods);
    const session = createSession(surge, { neighborhood: hoods[Math.floor(Math.random() * hoods.length)] });
    const steps = {};
    const time = async (name, fn) => { const s = performance.now(); const r = await fn(); steps[name] = Math.round(performance.now() - s); return r; };
    const type = ['food', 'water', 'shelter'][Math.floor(Math.random() * 3)];
    const c = await time('classify', () => runTool(surge, session, 'classify_need', { resource_type: type, urgency: 'routine', reason: 'surge' }));
    const f = await time('find', () => runTool(surge, session, 'find_resource', { resource_type: type, reason: 'surge' }));
    const site = f.results?.[0];
    session.turn++; // the simulated caller says "yes" in a later turn, as a real one must
    const r = site ? await time('reserve', () => runTool(surge, session, 'reserve', { site_id: site.site_id, item: f.item, reason: 'surge' })) : { ok: false };
    const d = r.status === 'held' ? await time('dispatch', () => runTool(surge, session, 'dispatch_volunteer', { hold_id: r.hold_id, urgency: 'routine', reason: 'surge' })) : { ok: false };
    // "No driver free" is graceful degradation (the hold stands and the coordinator is alerted),
    // not a fault, so it is reported as its own outcome instead of being hidden or counted as an error.
    const queued = d.ok === false && d.error === 'no_driver_available';
    const ok = [c, f, r].every((x) => x.ok !== false) && (d.ok !== false || queued);
    const outcome = !ok ? 'error' : queued ? 'queued_no_driver' : 'dispatched';
    surge.sessions.delete(session.id);
    res.json({ ok, outcome, ms: Math.round(performance.now() - t0), steps, error: ok ? undefined : [c, f, r, d].find((x) => x.ok === false)?.error });
  }));
}

// ------------------------------------------------------------------ static + start

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { extensions: ['html'], maxAge: 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

setInterval(() => sweep(store), 60_000).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`Lifeline Live  http://${config.host}:${config.port}`);
  console.log(`  caller:       http://${config.host}:${config.port}/`);
  console.log(`  coordinator:  http://${config.host}:${config.port}/console.html`);
  console.log(`  driver:       http://${config.host}:${config.port}/driver.html`);
  console.log(`  model: ${config.modelId} (${config.region})${config.adminToken ? '  admin token: required' : ''}`);
  console.log(`  guardrail: ${config.guardrailId ? `${config.guardrailId} v${config.guardrailVersion}` : 'off'}`);
  warmShortageCache();
  telemetry.start().then((on) => {
    if (on) console.log(`  CloudWatch: shipping the decision log to ${aws.decisionLogGroup} and metrics to LifelineLive`);
    else console.log('  CloudWatch: off (run ./infra/aws-setup.sh to enable)');
    if (on && aws?.links?.dashboard) console.log(`  AWS dashboard: ${aws.links.dashboard}`);
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    await Promise.race([telemetry.stop(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  });
}
server.on('error', (err) => { console.error(err.message); process.exit(1); });

export { app, store };
