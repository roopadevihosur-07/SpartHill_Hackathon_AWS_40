// Surge test. Needs a running server started with ENABLE_TEST_API=1 and a high rate limit:
//   ENABLE_TEST_API=1 RATE_LIMIT_PER_MIN=5000 npm start
//   npm run surge                  tools layer: 25, 50, 100, 200 concurrent simulated callers
//   npm run surge -- --agent 10    plus 10 concurrent calls through the live Bedrock agent
//
// Each tool-layer "caller" runs classify -> find -> reserve -> dispatch against an isolated
// copy of the data (your demo state is untouched). Latency is measured by the client, so it
// includes HTTP. It does NOT include Bedrock; the agent run measures that separately.

import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.ADMIN_TOKEN ?? '';
const args = process.argv.slice(2);
const agentN = args.includes('--agent') ? Number(args[args.indexOf('--agent') + 1] || 10) : 0;
const levels = (process.env.LEVELS ?? '25,50,100,200').split(',').map(Number);

const headers = { 'content-type': 'application/json', ...(TOKEN ? { 'x-admin-token': TOKEN } : {}) };
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function toolLevel(n) {
  await post('/api/_test/surge/reset');
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: n }, async () => {
    const s = performance.now();
    try {
      const { status, json } = await post('/api/_test/surge/chain');
      return { ms: performance.now() - s, ok: status === 200 && json.ok === true, outcome: json.outcome, error: status !== 200 ? `http_${status}` : json.error };
    } catch (err) {
      return { ms: performance.now() - s, ok: false, error: err.cause?.code ?? err.message };
    }
  }));
  const wall = (performance.now() - t0) / 1000;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  const byType = Object.fromEntries([...new Set(errors.map((e) => e.error))].map((t) => [t, errors.filter((e) => e.error === t).length]));
  const dispatched = results.filter((r) => r.outcome === 'dispatched').length;
  const queued = results.filter((r) => r.outcome === 'queued_no_driver').length;
  return {
    concurrency: n,
    requests: n,
    ok: n - errors.length,
    dispatched,
    queued,
    errors: errors.length,
    errorRate: errors.length / n,
    errorTypes: byType,
    p50: Math.round(pct(ms, 50)),
    p95: Math.round(pct(ms, 95)),
    p99: Math.round(pct(ms, 99)),
    max: Math.round(ms.at(-1)),
    rps: Math.round(n / wall),
  };
}

async function agentRun(n) {
  const phrases = [
    'We have no food. Family of four, and we have no car.',
    'I need drinking water, my tap water is brown.',
    'Is the cooling center on 10th Street open?',
    'It is 104 degrees and my air conditioning is off. Where can I go?',
  ];
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const s = performance.now();
    try {
      const sess = await post('/api/session', { language: 'en', neighborhood: 'east_san_jose' });
      if (sess.status !== 200) return { ms: performance.now() - s, ok: false, error: `session_http_${sess.status}` };
      const chat = await post('/api/chat', { sessionId: sess.json.sessionId, message: phrases[i % phrases.length], clientMsgId: `surge-${i}-${Date.now()}` });
      const reply = (chat.json.messages ?? []).map((m) => m.text).join(' ');
      const failed = chat.status !== 200 || (chat.json.messages ?? []).some((m) => m.error) || !reply;
      return { ms: performance.now() - s, ok: !failed, error: failed ? (chat.status !== 200 ? `http_${chat.status}` : 'agent_error') : undefined };
    } catch (err) {
      return { ms: performance.now() - s, ok: false, error: err.message };
    }
  }));
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  return {
    sessions: n,
    ok: n - errors.length,
    errors: errors.length,
    p50: Math.round(pct(ms, 50)),
    p95: Math.round(pct(ms, 95)),
    max: Math.round(ms.at(-1)),
    wallSec: Math.round((performance.now() - t0) / 1000),
    note: 'One chat turn per call; includes Bedrock. These create real holds in the demo data, so reset it afterwards.',
  };
}

try {
  const health = await fetch(BASE + '/api/health').then((r) => r.json());
  console.log(`Target ${BASE}  model ${health.model}`);
  const probe = await post('/api/_test/surge/reset');
  if (probe.status === 404) throw new Error('Test API is off. Start the server with ENABLE_TEST_API=1');
  if (probe.status === 401) throw new Error('Unauthorized. Set ADMIN_TOKEN for this script.');

  const tool = [];
  console.log('\nTool layer (classify -> find -> reserve -> dispatch per simulated caller)');
  console.log('(dispatched = driver assigned; queued = hold kept, no driver free, coordinator alerted; err = real faults)');
  console.log('concurrent  dispatched  queued  err    p50     p95     p99     max   req/s');
  for (const n of levels) {
    const r = await toolLevel(n);
    tool.push(r);
    console.log(`${String(r.concurrency).padStart(9)} ${String(r.dispatched).padStart(11)} ${String(r.queued).padStart(7)} ${String(r.errors).padStart(4)} ${String(r.p50).padStart(5)}ms ${String(r.p95).padStart(6)}ms ${String(r.p99).padStart(6)}ms ${String(r.max).padStart(6)}ms ${String(r.rps).padStart(6)}${r.errors ? '   errors: ' + JSON.stringify(r.errorTypes) : ''}`);
  }

  let agent = null;
  if (agentN > 0) {
    console.log(`\nLive agent: ${agentN} concurrent calls through Bedrock…`);
    agent = await agentRun(agentN);
    console.log(`  ok ${agent.ok}/${agent.sessions}  p50 ${agent.p50}ms  p95 ${agent.p95}ms  max ${agent.max}ms  errors ${agent.errors}`);
  }

  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../data/surge-results.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE, model: health.model, tool, agent }, null, 2));
  console.log('\nSaved data/surge-results.json (the coordinator console charts it).');
  process.exit(tool.some((r) => r.errors > 0) ? 1 : 0);
} catch (err) {
  console.error(`Surge test failed: ${err.message}`);
  process.exit(2);
}
