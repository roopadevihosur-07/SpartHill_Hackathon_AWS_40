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

  if (CASE === 'errors') {
    const { isCredentialError } = await import(`${R}/errors.js`);
    const named = (name, message = '') => Object.assign(new Error(message), { name });
    result.cases = {
      expiredTokenException: isCredentialError(named('ExpiredTokenException', 'The security token included in the request is expired')),
      expiredToken: isCredentialError(named('ExpiredToken')),
      unrecognizedClient: isCredentialError(named('UnrecognizedClientException', 'The security token included in the request is invalid.')),
      invalidSignature: isCredentialError(named('InvalidSignatureException')),
      noCredentials: isCredentialError(named('CredentialsProviderError', 'Could not load credentials from any providers')),
      throttling: isCredentialError(named('ThrottlingException', 'Too many requests')),
      badGuardrail: isCredentialError(named('ValidationException', 'The provided guardrail identifier is invalid.')),
      modelNotEnabled: isCredentialError(named('ResourceNotFoundException', 'Model use case details have not been submitted')),
      timeout: isCredentialError(named('TimeoutError', 'The operation was aborted')),
      nothing: isCredentialError(undefined),
    };
  } else if (CASE === 'config') {
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
      result.credAlerts = store.alerts.filter((x) => /credentials/i.test(x.title)).map((x) => ({ severity: x.severity, detail: x.detail }));
      result.credFlag = Boolean(store.metrics.awsCredentialsFailedAt);
      result.credLog = store.log.filter((l) => l.kind === 'aws_credentials' && l.level === 'critical').length;
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
// ONLY=deadaws,config,errors runs just those groups (the 'guardrail' group needs working AWS credentials).
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const want = (group) => !ONLY.length || ONLY.includes(group);

function run(name, env, timeoutMs = 120000) {
  const r = spawnSync(process.execPath, [SELF], { env: { ...process.env, LL_CASE: name, ...env }, encoding: 'utf8', timeout: timeoutMs });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) return { error: `no result (exit ${r.status}) ${String(r.stderr).slice(-300)}` };
  return JSON.parse(line.slice(7));
}

// ---- 1. the Guardrail is deleted or wrong: callers must still be served, loudly
if (want('guardrail')) {
  const r = run('bad_guardrail', { BEDROCK_GUARDRAIL_ID: 'doesnotexist00', BEDROCK_GUARDRAIL_VERSION: '1' });
  check('broken Guardrail: the caller still gets a normal answer', !r.error && r.firstWasError === false && r.firstReply?.length > 0, r.error ?? r.firstReply);
  check('broken Guardrail: the next message also works', !r.error && r.secondWasError === false, r.error ?? '');
  check('broken Guardrail: a CRITICAL alert is raised for the coordinator', !r.error && r.alerts?.some((a) => a.severity === 'critical'), JSON.stringify(r.alerts));
  check('broken Guardrail: the alert is raised once, not on every message', !r.error && r.alerts?.length === 1, JSON.stringify(r.alerts));
  check('broken Guardrail: it is in the decision log', !r.error && r.guardrailLog >= 1, String(r.guardrailLog));
}

// ---- 2. AWS credentials are dead (expired workshop keys): fail clearly, and 911 still works
if (want('deadaws')) {
  // Deliberately not key-shaped (no AKIA prefix), so secret scanners do not flag this file.
  const env = { AWS_ACCESS_KEY_ID: 'LIFELINE-TEST-NOT-A-REAL-KEY-ID', AWS_SECRET_ACCESS_KEY: 'lifeline-test-not-a-real-secret', AWS_SESSION_TOKEN: '', BEDROCK_GUARDRAIL: '0', AWS_TELEMETRY: '0' };
  delete process.env.AWS_PROFILE;
  const r = run('dead_aws', { ...env, AWS_PROFILE: '' });
  check('dead AWS: no crash, the caller gets a clear apology', !r.error && r.normalWasApology === true && /coordinator/i.test(r.normalReply ?? ''), r.error ?? r.normalReply);
  check('dead AWS: the alert says the CREDENTIALS are the problem and what to do (refresh, restart)', !r.error && r.credAlerts?.length >= 1 && r.credAlerts[0].severity === 'critical' && /refresh/i.test(r.credAlerts[0].detail) && /restart/i.test(r.credAlerts[0].detail), JSON.stringify(r.credAlerts));
  check('dead AWS: ONE credentials alert even though two messages failed (no flood)', !r.error && r.credAlerts?.length === 1, String(r.credAlerts?.length));
  check('dead AWS: not the vague "Agent error" alert any more', !r.error && r.agentErrorAlerts === 0, String(r.agentErrorAlerts));
  check('dead AWS: health flag is set and the failure is in the decision log', !r.error && r.credFlag === true && r.credLog >= 1, `flag=${r.credFlag} log=${r.credLog}`);
  check('dead AWS: 911 guidance STILL reaches the caller first', !r.error && /911/.test(r.urgentFirst ?? '') && r.urgentFlag === 'chest_pain', r.error ?? r.urgentFirst);
  check('dead AWS: a critical red-flag alert is still raised', !r.error && r.redFlagAlert === true);
  check('dead AWS: the session survives', !r.error && r.stillHasSession === true);
  check(`dead AWS: fails fast (${r.ms ?? '?'} ms, under 20 s)`, !r.error && r.ms < 20000, String(r.ms));
}

// ---- 3. safe defaults: nothing demo-only is exposed on a shared network
if (want('config')) {
  const lan = run('config', { HOST: '0.0.0.0', ADMIN_TOKEN: 'x', DEMO_MODE: '' });
  check('on a network host the demo endpoints (resident list, outbound answer) are OFF by default', !lan.error && lan.demoMode === false, lan.error ?? JSON.stringify(lan));
  const local = run('config', { HOST: '127.0.0.1', DEMO_MODE: '' });
  check('on localhost the demo endpoints are ON by default', !local.error && local.demoMode === true, local.error ?? JSON.stringify(local));
  const optIn = run('config', { HOST: '0.0.0.0', ADMIN_TOKEN: 'x', DEMO_MODE: '1' });
  check('DEMO_MODE=1 turns them on explicitly even on a network host', !optIn.error && optIn.demoMode === true);
}

// ---- which AWS errors count as "the credentials are the problem" (no AWS needed)
if (want('errors')) {
  const r = run('errors', {});
  const c = r.cases ?? {};
  check('error classifier: expired/invalid/missing credentials ARE credential problems', !r.error && ['expiredTokenException', 'expiredToken', 'unrecognizedClient', 'invalidSignature', 'noCredentials'].every((k) => c[k] === true), r.error ?? JSON.stringify(c));
  check('error classifier: throttling, bad Guardrail, model not enabled, timeouts are NOT', !r.error && ['throttling', 'badGuardrail', 'modelNotEnabled', 'timeout', 'nothing'].every((k) => c[k] === false), r.error ?? JSON.stringify(c));
}

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
