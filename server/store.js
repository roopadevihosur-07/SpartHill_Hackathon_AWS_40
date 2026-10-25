import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { redact, redactDeep } from './pii.js';
import { round1 } from './geo.js';

// In-memory state that stands in for DynamoDB (not available on the event account).
// Every record carries `expiresAt` and is removed by sweep() (TTL auto-expiry).

export function newId(prefix, store, bag) {
  for (let i = 0; i < 20; i++) {
    const id = `${prefix}-${randomBytes(2).toString('hex').toUpperCase()}`;
    if (!bag || !bag.has(id)) return id;
  }
  return `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function createStore(seed) {
  const s = structuredClone(seed);
  const store = {
    emitter: new EventEmitter(),
    catalog: s.catalog,
    defaultItems: s.defaultItems,
    neighborhoods: s.neighborhoods,
    bulletins: s.bulletins,
    sites: new Map(s.sites.map((x) => [x.id, { ...x, version: 1, initialInventory: { ...x.inventory } }])),
    drivers: new Map(s.volunteers.map((v) => [v.id, { ...v, status: 'available', homeLat: v.lat, homeLng: v.lng }])),
    residents: new Map(s.residents.map((r) => [r.id, r])),
    sessions: new Map(),
    holds: new Map(),
    dispatches: new Map(),
    approvals: new Map(),
    outboundCalls: new Map(),
    alerts: [],
    log: [],
    settings: { requireMedicineApproval: true },
    metrics: freshMetrics(),
    seq: { log: 0, alert: 0, approval: 0, dispatch: 0 },
    seedRef: seed,
  };
  store.emitter.setMaxListeners(500);
  return store;
}

function freshMetrics() {
  return {
    callsStarted: 0,
    dispatches: 0,
    batchedJobs: 0,
    kmSavedByBatching: 0,
    replans: 0,
    replanFailures: 0,
    lastReplanMs: null,
    redFlags: 0,
    timeToDispatchMs: [],
    logWriteFailures: 0,
    awsCredentialsFailedAt: null,
    model: undefined,
  };
}

/** Restore the seed state (admin "reset demo"). Keeps listeners attached. */
export function resetStore(store) {
  const fresh = createStore(store.seedRef);
  for (const key of ['sites', 'drivers', 'residents', 'sessions', 'holds', 'dispatches', 'approvals', 'outboundCalls', 'alerts', 'log', 'metrics', 'seq']) {
    store[key] = fresh[key];
  }
  store.settings = { ...store.settings };
  store.emitter.emit('reset');
  store.emitter.emit('changed');
}

export const touch = (store) => store.emitter.emit('changed');
export const pushToSession = (store, sessionId, event, data) =>
  store.emitter.emit(`session:${sessionId}`, { event, data });

// ---------------------------------------------------------------- decision log

function safeText(text) {
  if (text == null) return undefined;
  try {
    return redact(String(text));
  } catch {
    return '[unavailable: redaction failed]';
  }
}

/**
 * Append to the Decision_Log. Retries up to 3 times; if every attempt fails the
 * failure is counted and surfaced as a coordinator alert (Requirement 2.6).
 */
export function logDecision(store, e) {
  const entry = {
    id: 0,
    ts: Date.now(),
    expiresAt: Date.now() + config.recordTtlMs,
    sessionId: e.sessionId ?? null,
    kind: e.kind,
    level: e.level ?? 'info',
    summary: safeText(e.summary) ?? '',
    reason: safeText(e.reason),
    data: e.data === undefined ? undefined : safeData(e.data),
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      entry.id = ++store.seq.log;
      store.log.push(entry);
      touch(store);
      store.emitter.emit('decision', entry);
      return entry;
    } catch (err) {
      if (attempt === 3) {
        store.metrics.logWriteFailures++;
        console.error('decision log write failed', err);
        return null;
      }
    }
  }
  return null;
}

function safeData(data) {
  try {
    return redactDeep(data);
  } catch {
    return { note: 'data omitted: redaction failed' };
  }
}

export function addAlert(store, a) {
  const alert = {
    id: ++store.seq.alert,
    ts: Date.now(),
    expiresAt: Date.now() + config.recordTtlMs,
    sessionId: a.sessionId ?? null,
    severity: a.severity ?? 'warning',
    title: safeText(a.title) ?? '',
    detail: safeText(a.detail) ?? '',
    acknowledged: false,
  };
  store.alerts.push(alert);
  touch(store);
  return alert;
}

// -------------------------------------------------------------------- sessions

export function createSession(store, { neighborhood = 'east_san_jose', language = 'en', residentId = null, direction = 'inbound' } = {}) {
  const hood = store.neighborhoods[neighborhood] ? neighborhood : 'east_san_jose';
  const resident = residentId ? store.residents.get(residentId) : null;
  const effectiveHood = resident?.neighborhood && store.neighborhoods[resident.neighborhood] ? resident.neighborhood : hood;
  const centroid = store.neighborhoods[effectiveHood];
  const id = randomUUID();
  // Deterministic small offset so different callers in one neighborhood are not at one point.
  const h = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const jitter = (n) => (((h >> n) % 100) / 100 - 0.5) * 0.008;
  const session = {
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.recordTtlMs,
    direction,
    language: ['en', 'es', 'vi'].includes(language) ? language : 'en',
    neighborhood: effectiveHood,
    location: { lat: centroid.lat + jitter(3), lng: centroid.lng + jitter(11) },
    residentId: resident?.id ?? null,
    knownNames: resident ? [resident.name, resident.displayName.replace(/^(Mr|Ms|Mrs)\.?\s*/i, '')] : [],
    address: resident?.address ?? null,
    addressSource: resident ? 'enrollment' : null,
    consent: { state: resident ? 'granted' : 'none', askedAt: null },
    need: null,
    clarifyCount: 0,
    redFlagged: false,
    activeHoldId: null,
    activeDispatchId: null,
    approvedItems: new Set(),
    seenVersions: new Map(),
    offeredAt: new Map(),
    shortage: null,
    eventMode: false,
    deliveryHint: null,
    pendingReplan: null,
    transcript: [],
    firstUserAt: null,
    turn: 0,
  };
  store.sessions.set(id, session);
  store.metrics.callsStarted++;
  touch(store);
  return session;
}

/** Persist a transcript line. Redaction failure => the line is NOT stored (Requirement 13.4). */
export function appendTranscript(store, session, role, text) {
  let redacted;
  try {
    redacted = redact(text, { knownNames: session.knownNames, nameIntro: role === 'user' });
  } catch {
    logDecision(store, {
      sessionId: session.id,
      kind: 'privacy',
      level: 'warning',
      summary: 'Transcript line not stored: redaction failed',
      reason: 'PII redaction must succeed before anything is persisted',
    });
    return null;
  }
  const line = { id: randomUUID(), role, text: redacted, ts: Date.now() };
  session.transcript.push(line);
  if (session.transcript.length > 200) session.transcript.shift();
  touch(store);
  return line;
}

// ------------------------------------------------------------------ cards

const firstName = (full) => String(full).split(' ')[0];

/** Caller's own words win over the model's flag; null means "not known yet". */
export function needsDelivery(session) {
  return session.deliveryHint ?? session.need?.needs_delivery ?? null;
}

export function itemLabel(store, item) {
  return store.catalog[item]?.label ?? item;
}

/** Caller-facing Confirmation_Card (stands in for the confirmation SMS) and the driver Dispatch_Card. */
export function buildCards(store, session) {
  const hold = session.activeHoldId ? store.holds.get(session.activeHoldId) : null;
  const dispatch = session.activeDispatchId ? store.dispatches.get(session.activeDispatchId) : null;
  const pending = [...store.approvals.values()].find((a) => a.sessionId === session.id && a.status === 'pending');

  let confirmation = { state: 'none' };
  if (session.pendingReplan?.failed) {
    confirmation = { state: 'failed', message: 'No alternative site is available right now. Our coordinator has been alerted.' };
  } else if (session.pendingReplan) {
    confirmation = { state: 'replanning', message: 'The site ran out of stock. Finding you the next closest option.' };
  } else if (pending) {
    confirmation = {
      state: 'pending_approval',
      message: 'Waiting for our coordinator, Rosa, to approve your medicine hold.',
      item: itemLabel(store, pending.input.item),
    };
  } else if (hold && hold.status === 'active') {
    const site = store.sites.get(hold.siteId);
    const driver = dispatch ? store.drivers.get(dispatch.driverId) : null;
    const etaMin = dispatch ? Math.max(1, Math.ceil((dispatch.etaAt - Date.now()) / 60000)) : null;
    const itemName = itemLabel(store, hold.item);
    const sms = dispatch && driver
      ? `Lifeline: your ${itemName} is on hold at ${site.name}. Hold ${hold.id}. ${firstName(driver.name)} is on the way, ETA about ${etaMin} min.`
      : `Lifeline: your ${itemName} is on hold at ${site.name} (${site.address}). Hold ${hold.id}. Please pick up within 2 hours.`;
    confirmation = {
      state: dispatch ? 'dispatched' : 'holding',
      holdId: hold.id,
      site: { name: site.name, address: site.address, hours: site.hours },
      item: itemName,
      driver: driver ? { name: driver.name, vehicle: driver.vehicle } : null,
      etaMin,
      sms,
    };
  }

  let dispatchCard = null;
  if (dispatch) dispatchCard = dispatchCardFor(store, dispatch);

  return { confirmation, dispatch: dispatchCard };
}

/**
 * Coordinates for the coordinator map. The caller is shown at their neighborhood
 * centre, never at the exact point the agent stored (that point stays server-side).
 */
export function mapPointsFor(store, dispatch) {
  const session = store.sessions.get(dispatch.sessionId);
  const hood = store.neighborhoods[session?.neighborhood];
  const driver = store.drivers.get(dispatch.driverId);
  return {
    driver: driver ? { lat: driver.homeLat, lng: driver.homeLng } : null,
    pickup: { lat: dispatch.pickup.lat, lng: dispatch.pickup.lng },
    dropoff: hood ? { lat: hood.lat, lng: hood.lng, label: hood.label } : null,
  };
}

export function dispatchCardFor(store, dispatch) {
  const driver = store.drivers.get(dispatch.driverId);
  const etaMin = Math.max(1, Math.ceil((dispatch.etaAt - Date.now()) / 60000));
  return {
    id: dispatch.id,
    holdId: dispatch.holdId,
    status: dispatch.status,
    urgency: dispatch.urgency,
    driver: driver ? { id: driver.id, name: driver.name, vehicle: driver.vehicle, phone: driver.phone } : null,
    pickup: dispatch.pickup,
    dropoff: dispatch.dropoff,
    route: dispatch.route,
    etaMin: ['delivered', 'failed'].includes(dispatch.status) ? null : etaMin,
    distanceKm: round1(dispatch.distanceKm),
    batched: dispatch.batched,
    savedKm: round1(dispatch.savedKm ?? 0),
    error: dispatch.error ?? null,
  };
}

export function emitCards(store, session) {
  pushToSession(store, session.id, 'cards', buildCards(store, session));
  touch(store);
}

// ---------------------------------------------------------------- snapshots

export function adminSnapshot(store) {
  const now = Date.now();
  const kms = store.metrics.timeToDispatchMs;
  return {
    now,
    settings: store.settings,
    metrics: {
      ...store.metrics,
      kmSavedByBatching: round1(store.metrics.kmSavedByBatching),
      milesSavedByBatching: round1(store.metrics.kmSavedByBatching * 0.621371),
      avgTimeToDispatchSec: kms.length ? Math.round(kms.reduce((a, b) => a + b, 0) / kms.length / 1000) : null,
      timeToDispatchMs: undefined,
    },
    sites: [...store.sites.values()].map((s) => ({
      id: s.id, kind: s.kind, name: s.name, address: s.address, open: s.open, hasPower: s.hasPower,
      hours: s.hours, inventory: s.inventory, initialInventory: s.initialInventory, version: s.version,
      lat: s.lat, lng: s.lng,
    })),
    drivers: [...store.drivers.values()].map((d) => ({
      id: d.id, name: d.name, vehicle: d.vehicle, status: d.status,
      load: [...store.dispatches.values()].filter((x) => x.driverId === d.id && ['assigned', 'accepted'].includes(x.status)).length,
      lat: d.homeLat, lng: d.homeLng,
    })),
    holds: [...store.holds.values()].slice(-60).map((h) => ({
      id: h.id, sessionId: h.sessionId, siteId: h.siteId, siteName: store.sites.get(h.siteId)?.name,
      item: h.item, itemLabel: itemLabel(store, h.item), status: h.status, createdAt: h.createdAt,
    })),
    dispatches: [...store.dispatches.values()].slice(-60).map((d) => ({ ...dispatchCardFor(store, d), sessionId: d.sessionId, map: mapPointsFor(store, d) })),
    approvals: [...store.approvals.values()].map((a) => ({
      id: a.id, sessionId: a.sessionId, status: a.status, summary: a.summary, createdAt: a.createdAt, decidedAt: a.decidedAt ?? null,
    })),
    alerts: store.alerts.slice(-50),
    sessions: [...store.sessions.values()].slice(-30).map((s) => ({
      id: s.id, shortId: s.id.slice(0, 8), direction: s.direction, createdAt: s.createdAt, language: s.language,
      neighborhood: store.neighborhoods[s.neighborhood]?.label, resident: s.residentId ? store.residents.get(s.residentId)?.displayName : null,
      need: s.need, redFlagged: s.redFlagged, activeHoldId: s.activeHoldId,
      transcript: s.transcript.slice(-8).map((t) => ({ role: t.role, text: t.text })),
    })),
    residents: [...store.residents.values()].map((r) => ({
      id: r.id, displayName: r.displayName, language: r.language, enrolledNeeds: r.enrolledNeeds,
      ringing: store.emitter.listenerCount(`resident:${r.id}`) > 0,
    })),
    log: store.log.slice(-400),
  };
}

// ---------------------------------------------------------------------- TTL

export function sweep(store, now = Date.now()) {
  let removed = 0;
  for (const [id, h] of store.holds) {
    if (h.expiresAt <= now) {
      if (h.status === 'active') {
        const site = store.sites.get(h.siteId);
        if (site && site.inventory[h.item] !== undefined) {
          site.inventory[h.item] += h.qty;
          site.version++;
        }
      }
      store.holds.delete(id);
      removed++;
    }
  }
  for (const [id, s] of store.sessions) {
    if (s.expiresAt <= now) {
      store.sessions.delete(id);
      store.emitter.emit('session_expired', id);
      removed++;
    }
  }
  for (const [id, d] of store.dispatches) {
    if (!store.sessions.has(d.sessionId) && d.createdAt + config.recordTtlMs <= now) {
      store.dispatches.delete(id);
      removed++;
    }
  }
  for (const [id, a] of store.approvals) {
    if (a.expiresAt <= now) {
      store.approvals.delete(id);
      removed++;
    }
  }
  const before = store.log.length + store.alerts.length;
  store.log = store.log.filter((e) => e.expiresAt > now);
  store.alerts = store.alerts.filter((a) => a.expiresAt > now);
  removed += before - (store.log.length + store.alerts.length);
  if (removed) touch(store);
  return removed;
}
