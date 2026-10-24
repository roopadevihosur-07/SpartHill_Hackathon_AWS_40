import { ToolError, str, oneOf } from './validate.js';
import { createDispatch, freeDriverIfIdle } from '../dispatch.js';
import { logDecision, addAlert, touch, emitCards } from '../store.js';

export function dispatchVolunteer(store, session, input) {
  const holdId = str(input, 'hold_id', { required: true, max: 20 });
  const urgency = oneOf(input, 'urgency', ['critical', 'urgent', 'routine'], { required: true });
  const hold = store.holds.get(holdId);
  if (!hold || hold.sessionId !== session.id) throw new ToolError('unknown_hold', `No hold "${holdId}" for this caller. Use the hold_id returned by reserve.`);
  if (hold.status !== 'active') throw new ToolError('hold_not_active', `Hold ${holdId} is ${hold.status}. Reserve at a site first.`);

  // A dispatch already exists for this call and is being re-planned: re-route the same driver.
  const prior = session.activeDispatchId ? store.dispatches.get(session.activeDispatchId) : null;
  const rerouting = prior && prior.status === 'rerouting';
  if (!rerouting && prior && ['assigned', 'accepted'].includes(prior.status) && prior.holdId === holdId) {
    return summarize(store, prior, { already_dispatched: true });
  }

  const previousDriverId = prior?.driverId;
  const dispatch = createDispatch(store, {
    session,
    hold,
    urgency,
    preferDriverId: rerouting ? previousDriverId : undefined,
    reuseDispatchId: rerouting ? prior.id : undefined,
  });

  if (!dispatch) {
    addAlert(store, { sessionId: session.id, severity: 'critical', title: 'No volunteer driver available', detail: `Hold ${holdId} has no driver.` });
    logDecision(store, { sessionId: session.id, kind: 'dispatch', level: 'warning', summary: `No driver available for hold ${holdId}`, reason: str(input, 'reason', { max: 200 }) });
    return { ok: false, error: 'no_driver_available', message: 'No volunteer driver is free. Coordinator Rosa has been alerted. Tell the caller the hold is safe and a person will follow up.' };
  }
  if (rerouting && previousDriverId && previousDriverId !== dispatch.driverId) freeDriverIfIdle(store, previousDriverId, dispatch.id);

  session.activeDispatchId = dispatch.id;
  const driver = store.drivers.get(dispatch.driverId);
  logDecision(store, {
    sessionId: session.id,
    kind: rerouting ? 'reroute' : 'dispatch',
    summary: `${rerouting ? 'Re-routed' : 'Dispatched'} ${driver.name} (${dispatch.id}): ${dispatch.pickup.label} → caller, ~${Math.max(1, Math.ceil((dispatch.etaAt - Date.now()) / 60000))} min${dispatch.batched ? `, batched (saves ~${dispatch.savedKm.toFixed(1)} km)` : ''}`,
    reason: str(input, 'reason', { max: 200 }),
    data: { dispatchId: dispatch.id, holdId, driverId: driver.id, urgency, batched: dispatch.batched },
  });
  touch(store);
  emitCards(store, session);
  return summarize(store, dispatch, rerouting ? { rerouted: true } : {});
}

function summarize(store, dispatch, extra = {}) {
  const driver = store.drivers.get(dispatch.driverId);
  return {
    ok: true,
    dispatch_id: dispatch.id,
    driver_first_name: driver.name.split(' ')[0],
    vehicle: driver.vehicle,
    pickup: dispatch.pickup.label,
    eta_minutes: Math.max(1, Math.ceil((dispatch.etaAt - Date.now()) / 60000)),
    batched_with_other_stops: dispatch.batched,
    note: 'A confirmation card with these details is now on the caller\'s screen.',
    ...extra,
  };
}
