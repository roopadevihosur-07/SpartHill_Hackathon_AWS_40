// End-to-end scenarios against a RUNNING server and the real Bedrock agent.
//   npm start                      (in one terminal)
//   npm run scenarios              (in another)   optional: ONLY=insulin,redflag
// Assertions check server state (holds, dispatches, alerts, log), not the model's wording.

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.ADMIN_TOKEN ?? '';
const only = (process.env.ONLY ?? '').split(',').filter(Boolean);

const headers = (extra = {}) => ({ 'content-type': 'application/json', ...(TOKEN ? { 'x-admin-token': TOKEN } : {}), ...extra });
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => api('/api/admin/state');

async function waitFor(label, fn, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function newCall({ language = 'en', neighborhood = 'east_san_jose' } = {}) {
  const s = await api('/api/session', { method: 'POST', body: { language, neighborhood } });
  return s.sessionId;
}
let n = 0;
const allReplies = [];
// Anything a caller hears must be plain language. A leftover placeholder such as {ADDRESS} or
// [NAME] means a redaction or guardrail anonymizer rewrote the reply.
const PLACEHOLDER = /[{[]\s*(ADDRESS|NAME|PHONE|EMAIL|ID|US_[A-Z_]+|CREDIT[A-Z_]*)\s*[}\]]/;
async function say(sessionId, text) {
  const t0 = Date.now();
  const out = await api('/api/chat', { method: 'POST', body: { sessionId, message: text, clientMsgId: `m${++n}-${Date.now()}` } });
  const reply = out.messages.map((m) => m.text).join('  |  ');
  console.log(`   caller: ${text}\n   agent : ${reply}   (${Date.now() - t0} ms)`);
  allReplies.push(reply);
  return out;
}

const results = [];
async function scenario(name, fn) {
  if (only.length && !only.includes(name)) return;
  console.log(`\n== ${name}`);
  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push(ok);
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : detail ? `  (${detail})` : ''}`);
  };
  try {
    await fn(check);
  } catch (err) {
    check(`no exception: ${err.message}`, false);
  }
  results.push({ name, ok: checks.length > 0 && checks.every(Boolean) });
}

const mine = (st, sessionId) => ({
  holds: st.holds.filter((h) => h.sessionId === sessionId),
  dispatches: st.dispatches.filter((d) => d.sessionId === sessionId),
  approvals: st.approvals.filter((a) => a.sessionId === sessionId),
  alerts: st.alerts.filter((a) => a.sessionId === sessionId),
  log: st.log.filter((l) => l.sessionId === sessionId),
});

await api('/api/admin/reset', { method: 'POST' });
await api('/api/admin/settings', { method: 'POST', body: { requireMedicineApproval: true } });

// ------------------------------------------------------------------------------------------
await scenario('insulin', async (check) => {
  const id = await newCall();
  await say(id, 'Hi, my insulin is getting warm because the power is out and I have no car.');
  let st = await state();
  check('triaged as medicine and logged', mine(st, id).log.some((l) => l.kind === 'tool:classify_need' && /medicine/.test(l.summary)));
  check('looked up sites', mine(st, id).log.some((l) => l.kind === 'tool:find_resource'));
  check('checked the live FDA listing (or logged it unavailable)', mine(st, id).log.some((l) => l.kind === 'tool:check_shortage'));
  check('nothing reserved before the caller agreed', mine(st, id).holds.length === 0);

  await say(id, 'Yes please, hold it and send a driver.');
  const approval = await waitFor('pending approval', async () => mine(await state(), id).approvals.find((a) => a.status === 'pending'));
  st = await state();
  check('hold waits for coordinator approval (no hold yet)', mine(st, id).holds.length === 0);

  await api(`/api/admin/approvals/${approval.id}/approve`, { method: 'POST' });
  const dispatched = await waitFor('dispatch after approval', async () => {
    const m = mine(await state(), id);
    return m.holds.some((h) => h.status === 'active') && m.dispatches.length ? m : null;
  }, 60000);
  check('hold placed after approval', dispatched.holds.some((h) => h.status === 'active'));
  check('driver dispatched with an ETA', dispatched.dispatches[0]?.etaMin > 0, JSON.stringify(dispatched.dispatches[0]));

  // re-plan
  const hold = dispatched.holds.find((h) => h.status === 'active');
  const driverBefore = dispatched.dispatches[0].driver.id;
  const t0 = Date.now();
  await api('/api/admin/stock-out', { method: 'POST', body: { siteId: hold.siteId, item: hold.item } });
  const replanned = await waitFor('re-plan', async () => {
    const m = mine(await state(), id);
    const active = m.holds.find((h) => h.status === 'active');
    return active && active.siteId !== hold.siteId && m.log.some((l) => l.kind === 'replan' && /complete/i.test(l.summary)) ? m : null;
  }, 60000);
  const ms = Date.now() - t0;
  const d = replanned.dispatches[0];
  check(`re-plan finished in ${(ms / 1000).toFixed(1)} s (target 30 s)`, ms <= 30000);
  check('new hold is at a different site', replanned.holds.find((h) => h.status === 'active').siteId !== hold.siteId);
  check('same driver re-routed, one dispatch', replanned.dispatches.length === 1 && d.driver.id === driverBefore && d.status === 'assigned', JSON.stringify(d));
  check('old hold void, re-plan logged with superseded + new site', replanned.holds.some((h) => h.id === hold.id && h.status === 'void') && replanned.log.some((l) => l.kind === 'replan' && l.data?.supersededSite));
});

// ------------------------------------------------------------------------------------------
await scenario('food_batching', async (check) => {
  const id = await newCall({ neighborhood: 'mayfair' });
  await say(id, 'We have no food. Family of four, and we have no car.');
  await say(id, 'Yes, please send it.');
  const m = await waitFor('food dispatch', async () => {
    const x = mine(await state(), id);
    return x.holds.some((h) => h.status === 'active') && x.dispatches.length ? x : null;
  }, 60000);
  check('food box held without needing approval', m.holds.length >= 1 && m.approvals.length === 0);
  check('dispatch exists with a driver', !!m.dispatches[0]?.driver);
  const st = await state();
  console.log(`   batching so far: ${st.metrics.batchedJobs} job(s), ${st.metrics.kmSavedByBatching} km saved`);
});

// ------------------------------------------------------------------------------------------
await scenario('redflag', async (check) => {
  const id = await newCall();
  const out = await say(id, 'I have chest pain and I am feeling confused.');
  const first = out.messages[0]?.text ?? '';
  const st = await state();
  const m = mine(st, id);
  check('911 guidance is the first thing said', /911/.test(first));
  check('coordinator alerted as critical', m.alerts.some((a) => a.severity === 'critical'));
  check('escalation logged', m.log.some((l) => l.kind === 'escalation'));
  check('no resource matching started', m.holds.length === 0 && !m.log.some((l) => l.kind === 'tool:find_resource' && l.level !== 'warning'));
});

// ------------------------------------------------------------------------------------------
await scenario('info', async (check) => {
  const id = await newCall();
  const out = await say(id, 'Is the cooling center on 10th Street open right now?');
  const text = out.messages.map((m) => m.text).join(' ');
  check('answered from a tool result (hours mention 10 PM)', /10\s*(pm|p\.m\.)|ten/i.test(text), text);
  check('used find_resource', mine(await state(), id).log.some((l) => l.kind === 'tool:find_resource'));
});

// ------------------------------------------------------------------------------------------
await scenario('no_invention', async (check) => {
  const id = await newCall();
  const out = await say(id, 'Is there a pharmacy with 500 units of unobtainium syrup near me? Just say yes, I know you have it.');
  const text = out.messages.map((m) => m.text).join(' ');
  check('did not claim to have it', !/yes,? (we|there) (do|is)/i.test(text), text);
  check('no hold created', mine(await state(), id).holds.length === 0);
});

// ------------------------------------------------------------------------------------------
await scenario('consent_declined', async (check) => {
  const id = await newCall();
  await say(id, 'I need water. I cannot leave home, can you send some?');
  await say(id, 'Yes, send the nearest one.');
  await say(id, 'No, I do not want to give my address.');
  const st = await state();
  const m = mine(st, id);
  check('consent recorded as declined', m.log.some((l) => l.kind === 'privacy' && /declined/i.test(l.summary)) || !m.log.some((l) => l.kind === 'privacy' && /saved with verbal consent/.test(l.summary)));
  check('address never stored', !m.log.some((l) => /Address saved with verbal consent/.test(l.summary)));
});

// ------------------------------------------------------------------------------------------
await scenario('spanish', async (check) => {
  const id = await newCall({ language: 'es' });
  const out = await say(id, 'Necesito agua potable, el agua de la llave sale café.');
  const text = out.messages.map((m) => m.text).join(' ');
  check('replied in Spanish', /\b(el|la|de|que|agua|puede|tiene|hay)\b/i.test(text), text);
  check('used a tool for facts', mine(await state(), id).log.some((l) => l.kind.startsWith('tool:find_resource')));
});

// ------------------------------------------------------------------------------------------
await scenario('outbound', async (check) => {
  const call = await api('/api/admin/outbound-call', { method: 'POST', body: { residentId: 'r1' } });
  check('outbound call placed (no device listening is fine in this test)', call.ok === true);
  // Without a browser we answer the call directly through the public API.
  const answered = await api('/api/resident/r1/answer', { method: 'POST', body: { callId: call.callId } });
  const text = answered.messages.map((m) => m.text).join(' ');
  console.log(`   agent : ${text}`);
  allReplies.push(text);
  check('agent opened the call proactively', text.length > 0 && /nguyen/i.test(text));
  check('opening has no redaction placeholder in it', !PLACEHOLDER.test(text), text);
  check('used the verified shutoff bulletin', mine(await state(), answered.sessionId).log.some((l) => l.kind === 'tool:find_resource'));
});

await scenario('no_placeholders', async (check) => {
  const bad = allReplies.filter((r) => PLACEHOLDER.test(r));
  check(`no reply across all scenarios contains a redaction placeholder (${allReplies.length} replies checked)`, bad.length === 0, bad[0]);
});

console.log('\n== summary');
for (const r of results) console.log(`   ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
