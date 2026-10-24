// Driver selection and batching rules.   npm run test:dispatch   (instant, no AWS)
import { fileURLToPath } from 'node:url';
const R = fileURLToPath(new URL('../server', import.meta.url));
const { createStore, createSession } = await import(`${R}/store.js`);
const { seed } = await import(`${R}/seed.js`);
const { runTool } = await import(`${R}/tools/index.js`);

const out = [];
const check = (label, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`);

/** One caller: find -> (next turn) reserve -> dispatch. Returns the dispatch result. */
async function job(store, { hood, resource = 'food', item, urgency }) {
  const s = createSession(store, { neighborhood: hood });
  s.turn = 1;
  const f = await runTool(store, s, 'find_resource', { resource_type: resource, ...(item ? { item } : {}), reason: 't' });
  s.turn = 2;
  s.shortage = { checkedAt: Date.now(), drug: item ?? null, label: 'test' }; // medicine needs a shortage check on record
  const r = await runTool(store, s, 'reserve', { site_id: f.results[0].site_id, item: f.item, reason: 't' }, { approved: true });
  const d = await runTool(store, s, 'dispatch_volunteer', { hold_id: r.hold_id, urgency, reason: 't' });
  return { ...d, store, session: s };
}
const fresh = () => createStore(seed);

// ---- the demo moment from the plan: a second food call joins the first driver's run
{
  const st = fresh();
  const first = await job(st, { hood: 'mayfair', urgency: 'urgent' });
  const second = await job(st, { hood: 'mayfair', urgency: 'urgent' });
  check('plan demo: second URGENT food call is batched onto the first driver', second.batched_with_other_stops === true && second.driver_first_name === first.driver_first_name, JSON.stringify({ a: first.driver_first_name, b: second.driver_first_name, batched: second.batched_with_other_stops }));
  check('...and the saving is counted (>= 0 km, batched job recorded)', st.metrics.batchedJobs === 1 && st.metrics.kmSavedByBatching >= 0);
}

// ---- but never where delay could hurt
{
  const st = fresh();
  await job(st, { hood: 'mayfair', urgency: 'urgent' });
  const critical = await job(st, { hood: 'mayfair', urgency: 'critical' });
  check('CRITICAL jobs are never batched', critical.batched_with_other_stops === false);
}
{
  const st = fresh();
  await job(st, { hood: 'mayfair', urgency: 'urgent' });
  const med = await job(st, { hood: 'mayfair', resource: 'medicine', item: 'blood_pressure_meds', urgency: 'urgent' });
  check('URGENT medicine is never batched behind a food run', med.batched_with_other_stops === false);
}
{
  const st = fresh();
  const first = await job(st, { hood: 'mayfair', urgency: 'urgent' });
  const d = st.dispatches.get(first.dispatch_id);
  d.etaAt = Date.now() + 35 * 60000; // that driver is now busy for 35 more minutes
  const second = await job(st, { hood: 'mayfair', urgency: 'urgent' });
  check('an urgent job is NOT batched if it would wait more than 20 min', second.batched_with_other_stops === false, `eta=${second.eta_minutes}`);
}

// ---- routine behaviour is unchanged
{
  const st = fresh();
  await job(st, { hood: 'mayfair', urgency: 'routine' });
  const second = await job(st, { hood: 'mayfair', urgency: 'routine' });
  check('routine jobs still batch', second.batched_with_other_stops === true);
}
{
  const st = fresh();
  const seen = new Map();
  for (let i = 0; i < 12; i++) { const j = await job(st, { hood: 'mayfair', urgency: 'routine' }); if (j.ok) seen.set(j.driver_first_name, (seen.get(j.driver_first_name) ?? 0) + 1); }
  check('no driver is given more than 3 stops', [...seen.values()].every((n) => n <= 3), JSON.stringify([...seen]));
}

// ---- the saving is a real, non-negative number
{
  const st = fresh();
  for (let i = 0; i < 4; i++) await job(st, { hood: i % 2 ? 'mayfair' : 'east_san_jose', urgency: 'urgent' });
  check('kilometres saved is never negative', st.metrics.kmSavedByBatching >= 0);
}

console.log(out.join('\n'));
const failed = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
