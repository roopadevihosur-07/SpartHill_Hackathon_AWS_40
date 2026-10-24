// Regression checks for the safety and failure paths. Runs in-process (no server needed) but
// the rejected-approval and no-alternative re-plan cases make real Bedrock calls.
//   npm run test:paths
import { fileURLToPath } from 'node:url';
const R = fileURLToPath(new URL('../server', import.meta.url));
const { createStore, createSession, appendTranscript, adminSnapshot } = await import(`${R}/store.js`);
const { seed } = await import(`${R}/seed.js`);
const { runTool } = await import(`${R}/tools/index.js`);
const { driverAction, decideApproval, handleStockOut } = await import(`${R}/orchestrator.js`);
const { redact } = await import(`${R}/pii.js`);
const { ungroundedClaim, clean } = await import(`${R}/agent.js`);

const out = [];
const check = (label, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);

// ---- PII redaction
const samples = [
  ['Call me at (408) 555-0199 or mary@example.com', ['408', 'mary@example.com']],
  ['I live at 1450 Demo Ave apt 4', ['1450 Demo Ave']],
  ['My name is Tuan Nguyen and I need insulin', ['Tuan', 'Nguyen']],
  ['my name is tuan nguyen', []], // lowercase: documented limitation, must not crash
];
for (const [text, banned] of samples) {
  const r = redact(text);
  check(`redact: "${text.slice(0, 40)}" -> "${r}"`, banned.every((b) => !r.includes(b)));
}
check('redact keeps ordinary text', redact('I need food for my family') === 'I need food for my family');
check('assistant lines keep "this is Lifeline"', redact('Hello, this is Lifeline.', { nameIntro: false }) === 'Hello, this is Lifeline.');
check('caller lines still redact "this is <Name>"', redact('Hi, this is Maria Gomez.') === 'Hi, this is [NAME].');
{
  const store = createStore(seed);
  const s = createSession(store, { residentId: 'r1' });
  appendTranscript(store, s, 'assistant', 'Hello Mr. Nguyen, this is Lifeline calling.');
  const stored = s.transcript.at(-1).text;
  check('stored assistant line hides the resident name but keeps "Lifeline"', !stored.includes('Nguyen') && stored.includes('Lifeline'), stored);
}
check('redact known names', !redact('Thanks Nguyen', { knownNames: ['Tuan Nguyen'] }).includes('Nguyen'));

// ---- redaction failure => transcript not stored
{
  const store = createStore(seed);
  const s = createSession(store, {});
  const line = appendTranscript(store, s, 'user', { not: 'a string' });
  check('redaction failure: line NOT persisted', line === null && s.transcript.length === 0);
  check('redaction failure is logged', store.log.some((l) => l.kind === 'privacy' && /not stored/i.test(l.summary)));
}

// ---- sanitizer + grounding check
check('clean strips <thinking>', clean('<thinking>plan</thinking> Hello there') === 'Hello there');
check('clean strips unclosed <thinking>', clean('Hello <thinking>oops') === 'Hello');
{
  const store = createStore(seed);
  const s = createSession(store, {});
  check('grounding: blocks "driver is on the way" with no dispatch', ungroundedClaim(store, s, 'Your driver is on the way.') === 'dispatch');
  check('grounding: blocks "your insulin is on hold" with no hold', ungroundedClaim(store, s, 'Your insulin is on hold at the pharmacy.') === 'hold');
  check('grounding: allows conditional wording', ungroundedClaim(store, s, 'Once approved, a driver will be on the way.') === null);
  check('grounding: allows a plain offer', ungroundedClaim(store, s, 'Do you want me to hold it and send a driver?') === null);
}

// ---- driver accept / decline / deliver
{
  const store = createStore(seed);
  const s = createSession(store, { neighborhood: 'mayfair' });
  s.turn = 1;
  const f = await runTool(store, s, 'find_resource', { resource_type: 'food', reason: 't' });
  s.turn = 2;
  const h = await runTool(store, s, 'reserve', { site_id: f.results[0].site_id, item: 'food_box', reason: 't' });
  const d = await runTool(store, s, 'dispatch_volunteer', { hold_id: h.hold_id, urgency: 'routine', reason: 't' });
  const dispatch = store.dispatches.get(d.dispatch_id);
  const first = dispatch.driverId;
  check('wrong driver cannot act on a dispatch', driverAction(store, dispatch.id, first === 'v1' ? 'v2' : 'v1', 'accept').ok === false);
  const dec = driverAction(store, dispatch.id, first, 'decline');
  check('decline succeeds', dec.ok);
  check('decline reassigns to a different driver', dispatch.driverId !== first && dispatch.status === 'assigned', `${first} -> ${dispatch.driverId} ${dispatch.status}`);
  check('declining driver is freed', store.drivers.get(first).status === 'available');
  check('accept works', driverAction(store, dispatch.id, dispatch.driverId, 'accept').ok && dispatch.status === 'accepted');
  check('double accept is rejected', driverAction(store, dispatch.id, dispatch.driverId, 'accept').ok === false);
  check('delivered works', driverAction(store, dispatch.id, dispatch.driverId, 'delivered').ok && dispatch.status === 'delivered');
  check('delivered fulfils the hold and frees the driver', store.holds.get(h.hold_id).status === 'fulfilled' && store.drivers.get(dispatch.driverId).status === 'available');
}

// ---- approval REJECTED (real agent turn)
{
  const store = createStore(seed);
  const s = createSession(store, {});
  s.turn = 1;
  await runTool(store, s, 'classify_need', { resource_type: 'medicine', item: 'insulin', urgency: 'critical', reason: 't' });
  await runTool(store, s, 'check_shortage', { drug_name: 'insulin', reason: 't' });
  const f = await runTool(store, s, 'find_resource', { resource_type: 'medicine', item: 'insulin', reason: 't' });
  s.turn = 2;
  const r = await runTool(store, s, 'reserve', { site_id: f.results[0].site_id, item: 'insulin', reason: 't' });
  check('medicine reserve is gated', r.status === 'pending_approval');
  const stockBefore = store.sites.get(f.results[0].site_id).inventory.insulin;
  const res = decideApproval(store, r.approval_id, 'reject');
  await res.done;
  check('rejected: no hold exists', [...store.holds.values()].length === 0);
  check('rejected: stock untouched', store.sites.get(f.results[0].site_id).inventory.insulin === stockBefore);
  check('rejected: logged', store.log.some((l) => l.kind === 'approval' && /REJECTED/.test(l.summary)));
  check('rejected: caller was told something', s.transcript.some((t) => t.role === 'assistant'));
  check('cannot decide twice', decideApproval(store, r.approval_id, 'approve').ok === false);
  out.push(`      agent said: ${s.transcript.filter((t) => t.role === 'assistant').map((t) => t.text).join(' | ')}`);
}

// ---- re-plan with NO alternative site (real agent turn)
{
  const store = createStore(seed);
  const s = createSession(store, {});
  store.settings.requireMedicineApproval = false;
  s.turn = 1;
  await runTool(store, s, 'classify_need', { resource_type: 'medicine', item: 'insulin', urgency: 'critical', needs_delivery: true, reason: 't' });
  await runTool(store, s, 'check_shortage', { drug_name: 'insulin', reason: 't' });
  const f = await runTool(store, s, 'find_resource', { resource_type: 'medicine', item: 'insulin', reason: 't' });
  s.turn = 2;
  const h = await runTool(store, s, 'reserve', { site_id: f.results[0].site_id, item: 'insulin', reason: 't' });
  await runTool(store, s, 'dispatch_volunteer', { hold_id: h.hold_id, urgency: 'critical', reason: 't' });
  for (const site of store.sites.values()) if (site.id !== h.site.site_id && site.inventory.insulin !== undefined) site.inventory.insulin = 0;
  const t0 = Date.now();
  const so = handleStockOut(store, { siteId: h.site.site_id, item: 'insulin' });
  await so.done;
  const dispatch = store.dispatches.get(s.activeDispatchId);
  check('no-alternative: re-plan marked failed', s.pendingReplan?.failed === true);
  check('no-alternative: dispatch marked failed with a message', dispatch.status === 'failed' && /no alternative/i.test(dispatch.error ?? ''));
  check('no-alternative: critical alert raised', store.alerts.some((a) => a.severity === 'critical' && /re-plan/i.test(a.title)));
  check('no-alternative: driver freed', store.drivers.get(dispatch.driverId).status === 'available');
  check('no-alternative: caller card shows the failure', (await import(`${R}/store.js`)).buildCards(store, s).confirmation.state === 'failed');
  out.push(`      took ${((Date.now() - t0) / 1000).toFixed(1)} s; agent said: ${s.transcript.filter((t) => t.role === 'assistant').map((t) => t.text).join(' | ')}`);
}

// ---- 911 guidance must not wait behind a slow turn (real Bedrock for the slow turn)
{
  const { handleUserMessage } = await import(`${R}/agent.js`);
  const store = createStore(seed);
  const s = createSession(store, {});
  const arrivals = [];
  store.emitter.on(`session:${s.id}`, ({ event, data }) => { if (event === 'message') arrivals.push({ at: Date.now(), redFlag: data.redFlag, text: data.text }); });
  const slow = handleUserMessage(store, s, 'We have no food and no car, family of four.', 'slow-1');
  await new Promise((r) => setTimeout(r, 150)); // the slow turn is now in flight
  const t0 = Date.now();
  const urgent = handleUserMessage(store, s, 'I have chest pain', 'urgent-1');
  await new Promise((r) => setTimeout(r, 400));
  const first911 = arrivals.find((a) => a.redFlag);
  const slowStillRunning = arrivals.filter((a) => !a.redFlag).length === 0;
  check('911 guidance arrives within 500 ms while a slow turn is still running', !!first911 && first911.at - t0 < 500 && slowStillRunning, `arrived=${first911 ? first911.at - t0 : 'never'} ms, slowStillRunning=${slowStillRunning}`);
  const [slowOut, urgentOut] = await Promise.all([slow, urgent]);
  check('red flag is escalated exactly once', store.log.filter((l) => l.kind === 'escalation' && /ESCALATED/.test(l.summary)).length === 1);
  check('response to the urgent message includes the 911 text first', /911/.test(urgentOut.messages[0]?.text ?? ''));
  check('the slow turn still completed normally', slowOut.messages.length > 0);
  check('user line stored once in the transcript', s.transcript.filter((t) => t.role === 'user' && /chest pain/.test(t.text)).length === 1);
}

// ---- TTL sweep
{
  const { sweep } = await import(`${R}/store.js`);
  const store = createStore(seed);
  const s = createSession(store, {});
  s.turn = 1;
  const f = await runTool(store, s, 'find_resource', { resource_type: 'food', reason: 't' });
  s.turn = 2;
  const h = await runTool(store, s, 'reserve', { site_id: f.results[0].site_id, item: 'food_box', reason: 't' });
  const before = store.sites.get(f.results[0].site_id).inventory.food_box;
  const removed = sweep(store, Date.now() + 25 * 3600 * 1000);
  check('TTL: sessions, holds and log are removed after 24 h', removed > 0 && store.sessions.size === 0 && store.holds.size === 0 && store.log.length === 0);
  check('TTL: expired active hold returns stock', store.sites.get(f.results[0].site_id).inventory.food_box === before + 1);
}

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
