import { ToolError, str } from './validate.js';

// Live public APIs (outside AWS): openFDA drug shortages and RxNorm.

const ATTEMPT_TIMEOUT_MS = 5000; // per request
const MAX_RETRIES = 2; //          retries after the first attempt
const DEADLINE_MS = 11000; //      overall budget so a voice turn never hangs
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map();

async function fetchJson(url, { deadline }) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (Date.now() >= deadline) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (res.status === 404) return { notFound: true };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new ToolError('upstream_error', `HTTP ${res.status}`);
      return { json: await res.json() };
    } catch (err) {
      lastError = err;
      if (err instanceof ToolError) break; // non-retryable
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ToolError('unavailable', `Upstream API unavailable (${lastError?.message ?? 'timeout'})`);
}

/** Drug names are untrusted input going into a query string: allow letters, digits, space, hyphen only. */
function cleanDrugName(raw) {
  const cleaned = raw.replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (cleaned.length < 2) throw new ToolError('invalid_input', 'drug name is too short or has no usable characters');
  return cleaned;
}

function recordOnSession(session, value) {
  if (!session || typeof session !== 'object') return;
  session.shortage = {
    checkedAt: Date.now(),
    drug: value.drug ?? null,
    label: !value.ok
      ? 'FDA shortage status unavailable'
      : value.in_shortage ? 'FDA lists a current national shortage'
        : value.discontinuing ? 'FDA lists some products as being discontinued'
          : value.listed ? 'FDA lists it, not as a current shortage' : 'not on the FDA shortage list',
  };
}

export async function checkShortage(store, session, input, { fetchImpl } = {}) {
  const value = await checkShortageInner(store, session, input, { fetchImpl });
  recordOnSession(session, value); // an attempt counts even when the service was unreachable
  return value;
}

async function checkShortageInner(store, session, input, { fetchImpl } = {}) {
  const drug = cleanDrugName(str(input, 'drug_name', { required: true, max: 80 }));
  const key = drug.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const q = encodeURIComponent(`"${drug}"`);
  const url =
    'https://api.fda.gov/drug/shortages.json?limit=10&search=' +
    `generic_name:${q}+openfda.generic_name:${q}+openfda.brand_name:${q}+openfda.substance_name:${q}`;

  const deadline = Date.now() + DEADLINE_MS;
  let data;
  try {
    data = await (fetchImpl ? fetchImpl(url) : fetchJson(url, { deadline }));
  } catch (err) {
    // Never invent a status: the agent is told shortage status is unavailable.
    return {
      ok: false,
      error: 'shortage_status_unavailable',
      message: 'The FDA shortage service could not be reached. Tell the caller shortage status is unavailable right now. Do not guess.',
    };
  }

  const records = data.notFound ? [] : (data.json?.results ?? []);
  const matches = records.slice(0, 10).map((r) => ({
    name: r.generic_name ?? r.openfda?.generic_name?.[0] ?? drug,
    status: r.status ?? 'unknown',
    form: r.dosage_form ?? null,
    posted: r.initial_posting_date ?? null,
  }));
  const value = {
    ok: true,
    drug,
    source: 'openFDA Drug Shortages (national listing)',
    retrieved_at: new Date().toISOString(),
    listed: matches.length > 0,
    in_shortage: matches.some((m) => /current/i.test(m.status)),
    discontinuing: matches.some((m) => /discontinu/i.test(m.status)),
    matches: matches.slice(0, 5),
    caveat: 'National listing only. It says nothing about stock at a specific pharmacy. Not listed does not mean in stock. This is not medical advice.',
  };
  cache.set(key, { ts: Date.now(), value });
  return value;
}

export async function normalizeDrug(store, session, input) {
  const name = cleanDrugName(str(input, 'spoken_name', { required: true, max: 80 }));
  const deadline = Date.now() + 8000;
  try {
    const approx = await fetchJson(
      `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?maxEntries=1&term=${encodeURIComponent(name)}`,
      { deadline },
    );
    const rxcui = approx.json?.approximateGroup?.candidate?.[0]?.rxcui;
    if (!rxcui) return { ok: false, error: 'no_match', message: 'RxNorm found no match. Continue with the name as the caller said it.' };

    const [props, ingredients] = await Promise.all([
      fetchJson(`https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/properties.json`, { deadline }),
      fetchJson(`https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN`, { deadline }),
    ]);
    const generic = ingredients.json?.relatedGroup?.conceptGroup
      ?.flatMap((g) => g.conceptProperties ?? [])
      .map((c) => c.name)
      .filter(Boolean);
    return {
      ok: true,
      input: name,
      rxcui,
      matched_name: props.json?.properties?.name ?? null,
      generic_names: [...new Set(generic ?? [])].slice(0, 4),
      source: 'RxNorm (NLM)',
    };
  } catch {
    return { ok: false, error: 'unavailable', message: 'RxNorm is unavailable. Continue with the name as the caller said it.' };
  }
}

/** Warm the shortage cache so the first live call is fast (openFDA can be slow on a cold query). */
export function warmShortageCache() {
  checkShortage({}, {}, { drug_name: 'insulin' }).catch(() => {});
}

export function _clearShortageCache() {
  cache.clear();
}
