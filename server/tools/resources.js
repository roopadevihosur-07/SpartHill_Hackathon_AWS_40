import { config } from '../config.js';
import { haversineKm, round1, roadKm, driveMinutes } from '../geo.js';
import { newId, itemLabel, logDecision, touch } from '../store.js';
import { requiresApproval, findPendingApproval, createPendingApproval } from '../approvals.js';
import { ToolError, str, oneOf, int, bool } from './validate.js';
import { RESOURCE_TYPES } from './schemas.js';

const TYPES_WITH_UNCLEAR = [...RESOURCE_TYPES, 'unclear'];
const MAX_CLARIFYING_QUESTIONS = 2;

// ------------------------------------------------------------------ classify_need

export function classifyNeed(store, session, input) {
  let type = oneOf(input, 'resource_type', TYPES_WITH_UNCLEAR, { required: true });
  const urgency = oneOf(input, 'urgency', ['critical', 'urgent', 'routine'], { required: true });
  const summary = str(input, 'summary', { max: 160 });
  const itemRaw = str(input, 'item', { max: 60 });
  const item = itemRaw ? resolveItem(store, itemRaw, type === 'unclear' ? undefined : type, { soft: true }) : undefined;

  if (type === 'unclear') {
    if (session.clarifyCount >= MAX_CLARIFYING_QUESTIONS) {
      type = 'info';
      return finish('info', 'Still unclear after 2 clarifying questions, so this is handled as an information request');
    }
    session.clarifyCount++;
    session.need = null;
    return {
      ok: true,
      action: 'ask_one_clarifying_question',
      clarifying_questions_asked: session.clarifyCount,
      message: 'Ask the caller ONE short clarifying question about what they need. Do not guess.',
    };
  }
  return finish(type);

  function finish(finalType, note) {
    session.need = {
      resource_type: finalType,
      item: item ?? null,
      urgency,
      // true / false when the caller said so, null when unknown. Never overwritten by "unknown".
      needs_delivery: input.needs_delivery === undefined || input.needs_delivery === null
        ? (session.need?.needs_delivery ?? null)
        : bool(input, 'needs_delivery'),
      summary: summary ?? null,
      clarifyingQuestions: session.clarifyCount,
    };
    touch(store);
    return {
      ok: true,
      classified_as: finalType,
      urgency,
      clarifying_questions_asked: session.clarifyCount,
      ...(note ? { note } : {}),
    };
  }
}

// ------------------------------------------------------------------ item resolution

export function resolveItem(store, raw, resourceType, { soft = false } = {}) {
  const key = String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (store.catalog[key]) return key;
  const text = String(raw).toLowerCase();
  for (const [k, v] of Object.entries(store.catalog)) {
    if (resourceType && v.type !== resourceType) continue;
    if (v.aliases.some((a) => text.includes(a))) return k;
  }
  if (soft) return undefined;
  const valid = Object.entries(store.catalog)
    .filter(([, v]) => !resourceType || v.type === resourceType)
    .map(([k]) => k);
  throw new ToolError('unknown_item', `"${raw}" is not an item this network tracks.`, { valid_items: valid });
}

function chosenItem(store, input, resourceType) {
  const raw = str(input, 'item', { max: 60 });
  if (raw) {
    const item = resolveItem(store, raw, resourceType);
    if (store.catalog[item].type !== resourceType) {
      throw new ToolError('item_type_mismatch', `"${item}" is a ${store.catalog[item].type} item, not ${resourceType}.`);
    }
    return item;
  }
  const fallback = store.defaultItems?.[resourceType];
  if (!fallback) throw new ToolError('item_required', `Ask the caller which ${resourceType} item they need.`);
  return fallback;
}

// ------------------------------------------------------------------ find_resource

export function findResource(store, session, input) {
  const type = oneOf(input, 'resource_type', RESOURCE_TYPES, { required: true });

  if (type === 'info') return findInfo(store, str(input, 'topic', { max: 100 }) ?? str(input, 'item', { max: 100 }) ?? '');

  const item = chosenItem(store, input, type);
  const def = store.catalog[item];
  const here = session.location;

  const results = [...store.sites.values()]
    .filter((s) => s.open && (s.inventory[item] ?? 0) >= 1)
    .filter((s) => !def.coldChain || (s.hasPower && s.refrigerated))
    .map((s) => ({ site: s, km: haversineKm(here, s) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 5);

  for (const { site } of results) {
    session.seenVersions.set(site.id, site.version);
    if (!session.offeredAt.has(`${site.id}:${item}`)) session.offeredAt.set(`${site.id}:${item}`, session.turn);
  }

  return {
    ok: true,
    resource_type: type,
    item,
    item_label: def.label,
    distance_note: 'Straight-line distance from the caller; driving time is longer.',
    count: results.length,
    results: results.map(({ site, km }) => ({
      site_id: site.id,
      name: site.name,
      address: site.address,
      hours: site.hours,
      distance_km: round1(km),
      est_drive_min: Math.max(1, Math.round(driveMinutes(km))),
      has_power: site.hasPower,
      in_stock: site.inventory[item],
    })),
    ...(results.length ? {} : { message: `No open site currently has ${def.label} in stock.` }),
  };
}

function findInfo(store, topic) {
  const tokens = topic.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const bulletins = store.bulletins.filter((b) => {
    if (!tokens.length) return true;
    const hay = `${b.topic} ${b.keywords.join(' ')} ${b.text}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
  });
  const sites = tokens.length
    ? [...store.sites.values()].filter((s) => tokens.some((t) => `${s.name} ${s.address} ${s.kind.replace('_', ' ')}`.toLowerCase().includes(t)))
    : [];
  return {
    ok: true,
    resource_type: 'info',
    count: bulletins.length + sites.length,
    bulletins: bulletins.slice(0, 3).map((b) => ({ topic: b.topic, text: b.text, source: b.source, updated: b.updated })),
    sites: sites.slice(0, 3).map((s) => ({ name: s.name, address: s.address, hours: s.hours, open: s.open })),
    ...(bulletins.length + sites.length ? {} : { message: 'No verified bulletin or site matches that topic. Say you do not have verified information and offer to alert the coordinator.' }),
  };
}

// ------------------------------------------------------------------ reserve

/**
 * Conditional write: the stock decrement only happens if stock >= quantity AND the site
 * version still matches what the caller was shown. The version check is what a DynamoDB
 * condition expression would do against a concurrent update.
 */
export function reserve(store, session, input, opts = {}) {
  const siteId = str(input, 'site_id', { required: true, max: 20 });
  const item = oneOf(input, 'item', Object.keys(store.catalog), { required: true });
  const qty = int(input, 'quantity', { min: 1, max: 5, fallback: 1 });
  const site = store.sites.get(siteId);
  if (!site) throw new ToolError('unknown_site', `No site with id "${siteId}". Use a site_id returned by find_resource.`);

  // Exactly once: the same call must not create two holds.
  const existing = session.activeHoldId && store.holds.get(session.activeHoldId);
  if (existing && existing.status === 'active' && existing.siteId === siteId && existing.item === item) {
    return holdResult(store, existing, { already_held: true });
  }

  // Requirement 5.1: a hold follows the caller's confirmation. The site must be offered in one
  // caller turn and reserved in a LATER one. Coordinator-approved actions and re-plans
  // (server events) were already authorized, so they skip this.
  if (!opts.approved && !session.eventMode && session.offeredAt.get(`${siteId}:${item}`) === session.turn) {
    return { ok: false, error: 'caller_has_not_confirmed', message: 'Do not reserve yet. Offer the site to the caller in a short sentence and ask if they want it. Call reserve only after they agree in a later message.' };
  }

  // Requirement 4.1: a medicine hold is never placed without a shortage check on record.
  if (store.catalog[item]?.type === 'medicine' && !session.shortage && !opts.approved) {
    return { ok: false, error: 'shortage_check_required', message: 'Call check_shortage for this medicine first (it is fine if the service is unavailable), then reserve again.' };
  }

  const gate = requiresApproval(store, session, item);
  if (gate.required && !opts.approved) {
    const pending = findPendingApproval(store, session.id, { site_id: siteId, item }) ?? createPendingApproval(store, session, { site_id: siteId, item, quantity: qty, reason: str(input, 'reason', { max: 200 }) });
    return {
      ok: true,
      status: 'pending_approval',
      approval_id: pending.id,
      message: 'Coordinator Rosa must approve medicine holds. Nothing is reserved yet. Tell the caller you are waiting for her approval and that you will update them. Do not call reserve again.',
    };
  }

  const def = store.catalog[item];
  if (!site.open) throw new ToolError('site_closed', `${site.name} is closed.`);
  if (def.coldChain && !(site.hasPower && site.refrigerated)) throw new ToolError('no_cold_storage', `${site.name} cannot store ${def.label} safely right now.`);

  if ((site.inventory[item] ?? 0) < qty) {
    return { ok: false, error: 'out_of_stock', message: `${site.name} has no ${def.label} available. Find another site.` };
  }
  const seen = session.seenVersions.get(siteId);
  if (seen !== undefined && seen !== site.version) {
    session.seenVersions.delete(siteId);
    return { ok: false, error: 'conflict', message: `${site.name}'s stock changed after you looked. Call find_resource again.` };
  }

  site.inventory[item] -= qty;
  site.version++;
  session.seenVersions.set(siteId, site.version);

  const hold = {
    id: newId('H', store, store.holds),
    sessionId: session.id,
    siteId,
    item,
    qty,
    status: 'active',
    createdAt: Date.now(),
    expiresAt: Date.now() + config.holdTtlMs,
  };
  store.holds.set(hold.id, hold);
  session.activeHoldId = hold.id;
  if (def.type === 'medicine') session.approvedItems.add(item);
  if (session.pendingReplan && !session.pendingReplan.newHoldId) session.pendingReplan.newHoldId = hold.id;

  logDecision(store, {
    sessionId: session.id,
    kind: 'hold',
    summary: `Hold ${hold.id}: ${qty} × ${def.label} at ${site.name}`,
    reason: str(input, 'reason', { max: 200 }),
    data: { holdId: hold.id, siteId, item, remainingStock: site.inventory[item] },
  });
  touch(store);
  return holdResult(store, hold);
}

function holdResult(store, hold, extra = {}) {
  const site = store.sites.get(hold.siteId);
  return {
    ok: true,
    status: 'held',
    hold_id: hold.id,
    site: { site_id: site.id, name: site.name, address: site.address, hours: site.hours },
    item: hold.item,
    item_label: itemLabel(store, hold.item),
    quantity: hold.qty,
    holds_expire_in_min: Math.round((hold.expiresAt - Date.now()) / 60000),
    ...extra,
  };
}

export { roadKm };
