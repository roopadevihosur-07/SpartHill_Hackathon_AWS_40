// Does the app degrade safely when AWS misbehaves, and are the unsafe defaults off?   npm run test:resilience
// Each case runs in its own process with its own environment (config is read at start-up).
// Needs working AWS credentials for the first case; the others deliberately break them.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const CASE = process.env.LL_CASE;

// ====================================================================== child: run one case
if (CASE) {
  const R = fileURLToPath(new URL('../server', import.meta.url));
  const { createStore, createSession } = await import(`${R}/store.js`);
  const { seed } = await import(`${R}/seed.js`);
  const result = { case: CASE };
  const store = createStore(seed);
  const session = createSession(store, {});
  const t0 = Date.now();

  if (CASE === 'config') {
    const { config } = await import(`${R}/config.js`);
    result.demoMode = config.demoMode;
    result.host = config.host;
  } else {
    const { handleUserMessage } = await import(`${R}/agent.js`);
    const turn = async (text, id) => handleUserMessage(store, session, text, id);
    if (CASE === 'bad_guardrail') {
      const a = await turn('Is the cooling center on 10th Street open right now?', 't1');
      const b = await turn('And is there water there?', 't2');
      result.firstReply = a.messages.map((m) => m.text).join(' | ');
      result.firstWasError = a.messages.some((m) => m.error);
      result.secondWasError = b.messages.some((m) => m.error);
      result.alerts = store.alerts.filter((x) => /guardrail/i.test(x.title)).map((x) => ({ severity: x.severity, title: x.title }));
      result.guardrailLog = store.log.filter((l) => l.kind === 'guardrail' && l.level === 'critical').length;
    } else if (CASE === 'dead_aws') {
      const normal = await turn('We have no food, family of four.', 't1');
      const urgent = await turn('I have chest pain', 't2');
      result.normalWasApology = normal.messages.some((m) => m.error);
      result.normalReply = normal.messages.map((m) => m.text).join(' | ');
      result.urgentFirst = urgent.messages[0]?.text ?? '';
      result.urgentFlag = urgent.messages[0]?.redFlag ?? null;
      result.agentErrorAlerts = store.alerts.filter((x) => x.title === 'Agent error').length;
      result.redFlagAlert = store.alerts.some((x) => x.severity === 'critical' && /RED FLAG/i.test(x.title));
      result.stillHasSession = store.sessions.has(session.id);
    }
  }
  result.ms = Date.now() - t0;
  console.log('RESULT ' + JSON.stringify(result));
  process.exit(0);
}

// ====================================================================== parent: orchestrate
const out = [];
const check = (label, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);

function run(name, env, timeoutMs = 120000) {
  const r = spawnSync(process.execPath, [SELF], { env: { ...process.env, LL_CASE: name, ...env }, encoding: 'utf8', timeout: timeoutMs });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) return { error: `no result (exit ${r.status}) ${String(r.stderr).slice(-300)}` };
  return JSON.parse(line.slice(7));
}

// ---- 1. the Guardrail is deleted or wrong: callers must still be served, loudly
{
  const r = run('bad_guardrail', { BEDROCK_GUARDRAIL_ID: 'doesnotexist00', BEDROCK_GUARDRAIL_VERSION: '1' });
  check('broken Guardrail: the caller still gets a normal answer', !r.error && r.firstWasError === false && r.firstReply?.length > 0, r.error ?? r.firstReply);
  check('broken Guardrail: the next message also works', !r.error && r.secondWasError === false, r.error ?? '');
  check('broken Guardrail: a CRITICAL alert is raised for the coordinator', !r.error && r.alerts?.some((a) => a.severity === 'critical'), JSON.stringify(r.alerts));
  check('broken Guardrail: the alert is raised once, not on every message', !r.error && r.alerts?.length === 1, JSON.stringify(r.alerts));
  check('broken Guardrail: it is in the decision log', !r.error && r.guardrailLog >= 1, String(r.guardrailLog));
}

// ---- 2. AWS credentials are dead (expired workshop keys): fail clearly, and 911 still works
{
  // Deliberately not key-shaped (no AKIA prefix), so secret scanners do not flag this file.
  const env = { AWS_ACCESS_KEY_ID: 'LIFELINE-TEST-NOT-A-REAL-KEY-ID', AWS_SECRET_ACCESS_KEY: 'lifeline-test-not-a-real-secret', AWS_SESSION_TOKEN: '', BEDROCK_GUARDRAIL: '0', AWS_TELEMETRY: '0' };
  delete process.env.AWS_PROFILE;
  const r = run('dead_aws', { ...env, AWS_PROFILE: '' });
  check('dead AWS: no crash, the caller gets a clear apology', !r.error && r.normalWasApology === true && /coordinator/i.test(r.normalReply ?? ''), r.error ?? r.normalReply);
  check('dead AWS: the coordinator gets a critical "Agent error" alert', !r.error && r.agentErrorAlerts >= 1, String(r.agentErrorAlerts));
  check('dead AWS: 911 guidance STILL reaches the caller first', !r.error && /911/.test(r.urgentFirst ?? '') && r.urgentFlag === 'chest_pain', r.error ?? r.urgentFirst);
  check('dead AWS: a critical red-flag alert is still raised', !r.error && r.redFlagAlert === true);
  check('dead AWS: the session survives', !r.error && r.stillHasSession === true);
  check(`dead AWS: fails fast (${r.ms ?? '?'} ms, under 20 s)`, !r.error && r.ms < 20000, String(r.ms));
}

// ---- 3. safe defaults: nothing demo-only is exposed on a shared network
{
  const lan = run('config', { HOST: '0.0.0.0', ADMIN_TOKEN: 'x', DEMO_MODE: '' });
  check('on a network host the demo endpoints (resident list, outbound answer) are OFF by default', !lan.error && lan.demoMode === false, lan.error ?? JSON.stringify(lan));
  const local = run('config', { HOST: '127.0.0.1', DEMO_MODE: '' });
  check('on localhost the demo endpoints are ON by default', !local.error && local.demoMode === true, local.error ?? JSON.stringify(local));
  const optIn = run('config', { HOST: '0.0.0.0', ADMIN_TOKEN: 'x', DEMO_MODE: '1' });
  check('DEMO_MODE=1 turns them on explicitly even on a network host', !optIn.error && optIn.demoMode === true);
}

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
