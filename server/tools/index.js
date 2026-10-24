import { ToolError, withTimeout } from './validate.js';
import { classifyNeed, findResource, reserve } from './resources.js';
import { checkShortage, normalizeDrug } from './external.js';
import { dispatchVolunteer } from './logistics.js';
import { escalate, requestAddressConsent, saveAddress } from './safety.js';
import { logDecision } from '../store.js';

export { toolSpecs } from './schemas.js';

const registry = {
  classify_need: { fn: classifyNeed, timeoutMs: 5000 },
  find_resource: { fn: findResource, timeoutMs: 5000 },
  check_shortage: { fn: checkShortage, timeoutMs: 15000 },
  normalize_drug: { fn: normalizeDrug, timeoutMs: 12000 },
  reserve: { fn: reserve, timeoutMs: 5000 },
  dispatch_volunteer: { fn: dispatchVolunteer, timeoutMs: 5000 },
  escalate: { fn: escalate, timeoutMs: 5000 },
  request_address_consent: { fn: requestAddressConsent, timeoutMs: 5000 },
  save_address: { fn: saveAddress, timeoutMs: 5000 },
};

export const TOOL_NAMES = Object.keys(registry);

// Tools that write their own, richer Decision_Log entry when they succeed.
const SELF_LOGGING_OK = {
  reserve: (r) => r.status === 'held',
  dispatch_volunteer: (r) => r.ok,
  escalate: (r) => r.ok,
  request_address_consent: (r) => r.ok && !r.already_granted,
  save_address: (r) => r.ok,
};

function summarize(name, input, r) {
  switch (name) {
    case 'classify_need':
      if (r.ok === false) return `classify_need was rejected: ${r.error}`;
      return r.action === 'ask_one_clarifying_question'
        ? `Asked clarifying question #${r.clarifying_questions_asked}`
        : `Classified need as ${r.classified_as}${input.item ? ` (${input.item})` : ''}, urgency ${input.urgency}`;
    case 'find_resource':
      if (r.ok === false) return `find_resource could not run for ${input.resource_type ?? '?'}${input.item ? `/${input.item}` : ''}: ${r.error}`;
      return r.resource_type === 'info'
        ? `find_resource info "${input.topic ?? ''}": ${r.count} verified item(s)`
        : `find_resource ${r.resource_type}/${r.item}: ${r.count} site(s)${r.results?.[0] ? `, nearest ${r.results[0].name} (${r.results[0].distance_km} km)` : ''}`;
    case 'check_shortage':
      return r.ok
        ? `openFDA ${r.drug}: ${r.in_shortage ? 'IN SHORTAGE (national)' : r.discontinuing ? 'listed as being discontinued' : r.listed ? 'listed, not a current shortage' : 'not listed'}`
        : `openFDA shortage check unavailable for ${input.drug_name}`;
    case 'normalize_drug':
      return r.ok ? `RxNorm: "${input.spoken_name}" → ${(r.generic_names?.[0] ?? r.matched_name) || 'matched'}` : `RxNorm could not normalize "${input.spoken_name}"`;
    case 'reserve':
      return r.status === 'pending_approval' ? `Hold waiting for coordinator approval (${r.approval_id})` : `Hold not placed: ${r.error ?? 'failed'}`;
    default:
      return `${name} ${r.ok ? 'ok' : `failed: ${r.error}`}`;
  }
}

/**
 * Execute one tool call. Never throws: failures come back as { ok:false, error, message }.
 * opts.onlyAllow: restrict to these tools (used during a medical red-flag handoff).
 * opts.approved:  the coordinator already approved this exact action.
 */
export async function runTool(store, session, name, input, opts = {}) {
  const entry = registry[name];
  if (!entry) return { ok: false, error: 'unknown_tool', message: `No tool named "${name}".` };

  if (opts.onlyAllow && !opts.onlyAllow.includes(name)) {
    logDecision(store, { sessionId: session.id, kind: 'blocked', level: 'warning', summary: `Blocked ${name} during medical red-flag handoff`, reason: '911 guidance must be delivered before resource matching' });
    return { ok: false, error: 'blocked_red_flag', message: 'A medical red flag is being handled. Do not look up resources now. Tell the caller to call 911 and that you are staying with them.' };
  }

  const safeInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let result;
  try {
    result = await withTimeout(Promise.resolve(entry.fn(store, session, safeInput, opts)), entry.timeoutMs);
  } catch (err) {
    if (err instanceof ToolError) {
      result = { ok: false, error: err.code, message: err.message, ...err.extra };
    } else {
      console.error(`tool ${name} crashed`, err);
      result = { ok: false, error: 'tool_failed', message: 'The tool failed. Tell the caller you could not complete that step and offer to alert the coordinator.' };
    }
  }

  const selfLogged = SELF_LOGGING_OK[name]?.(result);
  if (!selfLogged) {
    logDecision(store, {
      sessionId: session.id,
      kind: `tool:${name}`,
      level: result.ok === false ? 'warning' : 'info',
      summary: summarize(name, safeInput, result),
      reason: typeof safeInput.reason === 'string' ? safeInput.reason.slice(0, 200) : undefined,
      data: name === 'classify_need' ? { urgency: safeInput.urgency, clarifying: result.clarifying_questions_asked } : undefined,
    });
  }
  return result;
}
