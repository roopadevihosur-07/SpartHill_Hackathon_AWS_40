import { haversineKm, driveMinutes, roadKm, round1 } from './geo.js';
import { newId, logDecision, addAlert, touch } from './store.js';

const ACTIVE = ['assigned', 'accepted'];
const MAX_BATCH = 3;
const LOAD_MINUTES = 4;
// Routine jobs may join a busy driver's run if the detour is within this multiple of a fresh trip.
const BATCH_TOLERANCE = 1.25;
// ...and must still arrive within this many minutes.
const ROUTINE_MAX_ETA_MIN = 60;

function driverState(store, driver, excludeDispatchId) {
  const active = [...store.dispatches.values()]
    .filter((d) => d.driverId === driver.id && ACTIVE.includes(d.status) && d.id !== excludeDispatchId)
    .sort((a, b) => a.etaAt - b.etaAt);
  if (!active.length) {
    return { pos: { lat: driver.homeLat, lng: driver.homeLng }, freeAt: Date.now(), load: 0 };
  }
  const last = active.at(-1);
  return { pos: { lat: last.dropoff.lat, lng: last.dropoff.lng }, freeAt: Math.max(last.etaAt, Date.now()), load: active.length };
}

function quote(store, driver, pickup, dropoff, excludeDispatchId) {
  const st = driverState(store, driver, excludeDispatchId);
  const home = { lat: driver.homeLat, lng: driver.homeLng };
  const leg1 = haversineKm(st.pos, pickup);
  const leg2 = haversineKm(pickup, dropoff);
  const leg3 = haversineKm(dropoff, home);
  const minutes = driveMinutes(leg1) + driveMinutes(leg2) + LOAD_MINUTES;
  // Vehicle-km accounting (both include the drive back to the driver's base):
  //  - idle driver: the whole round trip is caused by this job.
  //  - busy driver: only the detour is caused by this job. The return trip from the
  //    previous drop-off was going to happen anyway, so it is subtracted.
  const returnAnyway = st.load > 0 ? haversineKm(st.pos, home) : 0;
  return {
    driver,
    load: st.load,
    start: st.pos,
    km: roadKm(leg1 + leg2),
    vehicleKm: roadKm(leg1 + leg2 + leg3 - returnAnyway),
    minutes,
    etaAt: st.freeAt + minutes * 60000,
    startsFromPriorStop: st.load > 0,
  };
}

/**
 * Pick a driver. critical/urgent -> earliest arrival. routine -> batch onto a busy driver's
 * run when the detour is small (fewer vehicles on the road), otherwise nearest idle driver.
 * Returns { quote, savedKm, batched } or null when nobody is available.
 */
export function chooseDriver(store, { pickup, dropoff, urgency, preferDriverId, excludeDriverIds = [], excludeDispatchId }) {
  const candidates = [...store.drivers.values()]
    .filter((d) => d.status !== 'offline' && !excludeDriverIds.includes(d.id))
    .map((d) => quote(store, d, pickup, dropoff, excludeDispatchId))
    .filter((q) => q.load < MAX_BATCH);
  if (!candidates.length) return null;

  const idle = candidates.filter((q) => q.load === 0);
  const busy = candidates.filter((q) => q.load > 0);
  const byEta = (a, b) => a.etaAt - b.etaAt;
  const byVehicleKm = (a, b) => a.vehicleKm - b.vehicleKm;

  let pick;
  if (preferDriverId) pick = candidates.find((q) => q.driver.id === preferDriverId);

  if (!pick && (urgency === 'critical' || urgency === 'urgent')) {
    pick = [...candidates].sort(byEta)[0];
  } else if (!pick) {
    const bestIdle = [...idle].sort(byVehicleKm)[0];
    const bestBusy = [...busy]
      .filter((q) => (q.etaAt - Date.now()) / 60000 <= ROUTINE_MAX_ETA_MIN)
      .sort(byVehicleKm)[0];
    // Batch whenever the extra driving is no worse than a fresh trip (with a small tolerance
    // for the longer wait), because it also keeps another vehicle off the road.
    if (bestBusy && (!bestIdle || bestBusy.vehicleKm <= bestIdle.vehicleKm * BATCH_TOLERANCE)) pick = bestBusy;
    else pick = bestIdle ?? [...candidates].sort(byEta)[0];
  }

  // Saving = what a separate idle driver's round trip would have cost, minus the detour.
  const freshBaseline = [...idle].sort(byVehicleKm)[0];
  const batched = pick.load > 0;
  const savedKm = batched && freshBaseline ? Math.max(0, freshBaseline.vehicleKm - pick.vehicleKm) : 0;
  return { quote: pick, savedKm, batched };
}

export function dropoffFor(store, session) {
  const hood = store.neighborhoods[session.neighborhood];
  return {
    label: session.address ? 'Caller address' : `Caller location (${hood.label})`,
    address: session.address ?? 'Address withheld: driver will confirm by phone on arrival',
    lat: session.location.lat,
    lng: session.location.lng,
  };
}

export function pickupFor(site) {
  return { label: site.name, address: site.address, lat: site.lat, lng: site.lng };
}

function buildRoute(q, pickup, dropoff, store) {
  return [
    { type: 'start', label: q.startsFromPriorStop ? 'After current delivery' : `${q.driver.name}'s starting point` },
    { type: 'pickup', label: pickup.label, address: pickup.address },
    { type: 'dropoff', label: dropoff.label, address: dropoff.address },
  ];
}

/** Create a dispatch for a hold. Used by the dispatch_volunteer tool. */
export function createDispatch(store, { session, hold, urgency, preferDriverId, reuseDispatchId }) {
  const site = store.sites.get(hold.siteId);
  const pickup = pickupFor(site);
  const dropoff = dropoffFor(store, session);
  const choice = chooseDriver(store, { pickup, dropoff, urgency, preferDriverId, excludeDispatchId: reuseDispatchId });
  if (!choice) return null;
  const { quote: q, savedKm, batched } = choice;

  let dispatch;
  if (reuseDispatchId && store.dispatches.get(reuseDispatchId)) {
    dispatch = store.dispatches.get(reuseDispatchId);
    dispatch.history = [...(dispatch.history ?? []), { pickup: dispatch.pickup, driverId: dispatch.driverId, at: Date.now() }];
  } else {
    dispatch = { id: newId('D', store, store.dispatches), createdAt: Date.now(), sessionId: session.id, history: [] };
    store.dispatches.set(dispatch.id, dispatch);
    store.seq.dispatch++;
  }
  Object.assign(dispatch, {
    holdId: hold.id,
    driverId: q.driver.id,
    status: 'assigned',
    urgency,
    pickup,
    dropoff,
    route: buildRoute(q, pickup, dropoff, store),
    distanceKm: q.km,
    etaAt: q.etaAt,
    batched,
    savedKm,
    error: null,
    updatedAt: Date.now(),
  });
  q.driver.status = 'busy';

  if (!reuseDispatchId) {
    store.metrics.dispatches++;
    if (batched) {
      store.metrics.batchedJobs++;
      store.metrics.kmSavedByBatching += savedKm;
    }
    if (session.firstUserAt) store.metrics.timeToDispatchMs.push(Date.now() - session.firstUserAt);
  }
  touch(store);
  return dispatch;
}

/** A driver declined: reassign to someone else, or alert Rosa if nobody is left. */
export function reassignAfterDecline(store, dispatch, session) {
  const declinedBy = dispatch.driverId;
  const hold = store.holds.get(dispatch.holdId);
  freeDriverIfIdle(store, declinedBy, dispatch.id);
  const site = hold ? store.sites.get(hold.siteId) : null;
  if (!hold || !site || !session) return null;
  const choice = chooseDriver(store, {
    pickup: dispatch.pickup,
    dropoff: dispatch.dropoff,
    urgency: dispatch.urgency,
    excludeDriverIds: [declinedBy],
    excludeDispatchId: dispatch.id,
  });
  if (!choice) {
    dispatch.status = 'failed';
    dispatch.error = 'No volunteer driver is available right now.';
    addAlert(store, { sessionId: session.id, severity: 'critical', title: 'No driver available', detail: `Dispatch ${dispatch.id} was declined and nobody else is free.` });
    logDecision(store, { sessionId: session.id, kind: 'dispatch', level: 'warning', summary: `Dispatch ${dispatch.id} declined by ${store.drivers.get(declinedBy)?.name}; no other driver available`, reason: 'Alerting coordinator' });
    return null;
  }
  const { quote: q, savedKm, batched } = choice;
  Object.assign(dispatch, {
    driverId: q.driver.id,
    status: 'assigned',
    route: buildRoute(q, dispatch.pickup, dispatch.dropoff, store),
    distanceKm: q.km,
    etaAt: q.etaAt,
    batched,
    savedKm,
    updatedAt: Date.now(),
  });
  q.driver.status = 'busy';
  logDecision(store, { sessionId: session.id, kind: 'dispatch', summary: `Dispatch ${dispatch.id} reassigned from ${store.drivers.get(declinedBy)?.name} to ${q.driver.name}`, reason: 'Original driver declined' });
  touch(store);
  return dispatch;
}

export function freeDriverIfIdle(store, driverId, exceptDispatchId) {
  const driver = store.drivers.get(driverId);
  if (!driver) return;
  const stillBusy = [...store.dispatches.values()].some(
    (d) => d.driverId === driverId && ACTIVE.includes(d.status) && d.id !== exceptDispatchId,
  );
  if (!stillBusy) driver.status = 'available';
}

export { round1 };
