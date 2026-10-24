import { randomUUID } from 'node:crypto';
import { runEvent } from './agent.js';
import { runTool } from './tools/index.js';
import { reassignAfterDecline, freeDriverIfIdle } from './dispatch.js';
import {
  createSession, logDecision, addAlert, touch, emitCards, itemLabel, pushToSession, needsDelivery,
} from './store.js';

// Everything that happens outside a caller's own turn: coordinator decisions, stock-outs,
// outbound calls, and driver responses. Each can trigger an agent turn whose reply is
// pushed to the caller.

const REPLAN_BUDGET_MS = 30_000;

const quiet = (p) => p.catch((err) => console.error('background task failed:', err?.message));

// ------------------------------------------------------------------ approvals

export function decideApproval(store, approvalId, decision, by = 'Rosa') {
  const approval = store.approvals.get(approvalId);
  if (!approval) return { ok: false, status: 404, error: 'unknown_approval' };
  if (approval.status !== 'pending') return { ok: false, status: 409, error: `already_${approval.status}` };
  if (!['approve', 'reject'].includes(decision)) return { ok: false, status: 400, error: 'invalid_decision' };

  const session = store.sessions.get(approval.sessionId);
  approval.status = decision === 'approve' ? 'approved' : 'rejected';
  approval.decidedAt = Date.now();

  if (!session) {
    approval.status = 'expired';
    logDecision(store, { kind: 'approval', level: 'warning', summary: `Approval ${approval.id} could not be applied: the call record expired` });
    return { ok: true, approval, done: Promise.resolve() };
  }

  const done = quiet((async () => {
    if (decision === 'reject') {
      logDecision(store, { sessionId: session.id, kind: 'approval', level: 'attention', summary: `${by} REJECTED approval ${approval.id}: ${approval.summary}`, reason: 'Coordinator decision; the action was cancelled' });
      emitCards(store, session);
      await runEvent(store, session,
        `Coordinator ${by} did NOT approve the medicine hold, so nothing was reserved. Tell the caller kindly and briefly. Do not retry that hold. Offer to look for a different option, or say the coordinator will follow up.`);
      return;
    }
    const result = await runTool(store, session, 'reserve', approval.input, { approved: true });
    logDecision(store, { sessionId: session.id, kind: 'approval', level: 'attention', summary: `${by} APPROVED ${approval.id}: ${approval.summary}`, reason: 'Coordinator decision; the action was executed', data: { executed: result.ok, holdId: result.hold_id } });

    // If we know the caller cannot travel, the server dispatches. The model only has to
    // tell the caller, so the confirmation cannot be a made-up claim.
    let dispatched = null;
    if (result.status === 'held' && needsDelivery(session) === true) {
      dispatched = await runTool(store, session, 'dispatch_volunteer', {
        hold_id: result.hold_id,
        urgency: session.need?.urgency ?? 'urgent',
        reason: 'Dispatched automatically after coordinator approval because the caller cannot travel',
      });
    }
    emitCards(store, session);

    let instruction;
    if (result.ok === false || result.status !== 'held') {
      instruction = 'The hold could not be placed. Tell the caller briefly and find another site with find_resource.';
    } else if (dispatched) {
      instruction = dispatched.ok
        ? 'Both steps are done. Do not call any tools. Confirm to the caller in one or two sentences: what is held where, the driver first name, and the ETA.'
        : 'The hold is placed but no driver could be assigned; the coordinator was alerted. Do not call tools. Tell the caller the hold is safe and a person will follow up.';
    } else if (needsDelivery(session) === false) {
      instruction = 'The caller will travel themselves. Do not call tools. Tell them the hold is confirmed, the site name and hours.';
    } else {
      instruction = 'The hold is placed. We do not yet know if the caller can travel. Ask them if they need a volunteer to deliver it. Do not claim any driver is coming.';
    }
    await runEvent(store, session,
      `Coordinator ${by} APPROVED the medicine hold. Reserve result: ${JSON.stringify(result)}.` +
      (dispatched ? ` Dispatch result: ${JSON.stringify(dispatched)}.` : '') + ` ${instruction}`);
  })());
  touch(store);
  return { ok: true, approval, done };
}

// ------------------------------------------------------------------ stock-out re-plan

export function handleStockOut(store, { siteId, item, by = 'Rosa' }) {
  const site = store.sites.get(siteId);
  if (!site) return { ok: false, status: 404, error: 'unknown_site' };
  if (!store.catalog[item] || site.inventory[item] === undefined) return { ok: false, status: 400, error: 'unknown_item_for_site' };

  site.inventory[item] = 0;
  site.version++;
  logDecision(store, { kind: 'stock_out', level: 'attention', summary: `${by} marked ${itemLabel(store, item)} OUT OF STOCK at ${site.name}`, reason: 'Coordinator pressed the out-of-stock button' });

  const affected = [...store.holds.values()].filter((h) => h.siteId === siteId && h.item === item && h.status === 'active');
  const jobs = [];
  for (const hold of affected) {
    const session = store.sessions.get(hold.sessionId);
    hold.status = 'void';
    hold.voidReason = 'site_out_of_stock';
    if (!session) continue;

    const dispatch = session.activeDispatchId ? store.dispatches.get(session.activeDispatchId) : null;
    if (dispatch && ['assigned', 'accepted'].includes(dispatch.status) && dispatch.holdId === hold.id) dispatch.status = 'rerouting';
    session.pendingReplan = { startedAt: Date.now(), oldHoldId: hold.id, oldSiteId: siteId, oldSiteName: site.name, item, newHoldId: null, failed: false };
    emitCards(store, session);

    jobs.push(quiet((async () => {
      await runEvent(store, session,
        `STOCK-OUT: ${site.name} just reported zero ${itemLabel(store, item)}. Hold ${hold.id} is void. Re-plan now as described in the RE-PLANS rule.`);
      await finalizeReplan(store, session);
    })()));
  }
  touch(store);
  return { ok: true, affectedHolds: affected.length, done: Promise.all(jobs) };
}

/** Server-side guarantee that a re-plan ends in a complete state, whatever the model did. */
async function finalizeReplan(store, session) {
  const pr = session.pendingReplan;
  if (!pr) return;
  const hold = pr.newHoldId ? store.holds.get(pr.newHoldId) : null;
  const dispatch = session.activeDispatchId ? store.dispatches.get(session.activeDispatchId) : null;

  if (hold?.status === 'active' && dispatch && dispatch.holdId !== hold.id && dispatch.status === 'rerouting') {
    // The model reserved but never re-routed the driver: finish the job deterministically.
    await runTool(store, session, 'dispatch_volunteer', { hold_id: hold.id, urgency: dispatch.urgency, reason: 'Server completed the re-route after the stock-out' });
  }

  const after = session.activeDispatchId ? store.dispatches.get(session.activeDispatchId) : null;
  const dispatchOk = !dispatch || (after && after.holdId === hold?.id && after.status === 'assigned');
  const elapsed = Date.now() - pr.startedAt;

  if (hold?.status === 'active' && dispatchOk) {
    const newSite = store.sites.get(hold.siteId);
    store.metrics.replans++;
    store.metrics.lastReplanMs = elapsed;
    logDecision(store, {
      sessionId: session.id,
      kind: 'replan',
      level: elapsed > REPLAN_BUDGET_MS ? 'warning' : 'info',
      summary: `Re-plan complete in ${(elapsed / 1000).toFixed(1)} s: ${pr.oldSiteName} → ${newSite.name}${after ? `, driver ${store.drivers.get(after.driverId)?.name} re-routed` : ''}${elapsed > REPLAN_BUDGET_MS ? ' (over the 30 s target)' : ''}`,
      reason: `${pr.oldSiteName} ran out of ${itemLabel(store, pr.item)}`,
      data: { supersededSite: pr.oldSiteName, newSite: newSite.name, oldHoldId: pr.oldHoldId, newHoldId: hold.id, ms: elapsed },
    });
    session.pendingReplan = null;
  } else {
    pr.failed = true;
    store.metrics.replanFailures++;
    if (dispatch && ['rerouting', 'assigned'].includes(dispatch.status)) {
      dispatch.status = 'failed';
      dispatch.error = 'No alternative site is available';
      freeDriverIfIdle(store, dispatch.driverId, dispatch.id);
    }
    logDecision(store, { sessionId: session.id, kind: 'replan', level: 'critical', summary: `Re-plan FAILED after ${(elapsed / 1000).toFixed(1)} s: no alternative site for ${itemLabel(store, pr.item)}`, reason: `${pr.oldSiteName} ran out and nothing else qualified. Hold ${pr.oldHoldId} cancelled.` });
    addAlert(store, { sessionId: session.id, severity: 'critical', title: 'Re-plan failed', detail: `No alternative site for ${itemLabel(store, pr.item)} after ${pr.oldSiteName} ran out. A caller is waiting.` });
  }
  emitCards(store, session);
}

// ------------------------------------------------------------------ outbound ("we call you")

export function placeOutboundCall(store, residentId) {
  const resident = store.residents.get(residentId);
  if (!resident) return { ok: false, status: 404, error: 'unknown_resident' };
  const callId = randomUUID();
  store.outboundCalls.set(residentId, { callId, ts: Date.now() });
  const listeners = store.emitter.listenerCount(`resident:${residentId}`);
  store.emitter.emit(`resident:${residentId}`, { event: 'incoming_call', data: { callId } });
  logDecision(store, { kind: 'outbound', summary: `Outbound call placed to ${resident.displayName} (${listeners ? 'device ringing' : 'no device connected'})`, reason: 'Proactive check-in before the planned shutoff for an opted-in, at-risk resident' });
  return { ok: true, callId, ringing: listeners > 0 };
}

export async function answerOutboundCall(store, residentId, callId) {
  const call = store.outboundCalls.get(residentId);
  const resident = store.residents.get(residentId);
  if (!resident || !call || call.callId !== callId) return { ok: false, status: 404, error: 'no_such_call' };
  store.outboundCalls.delete(residentId);

  const session = createSession(store, { residentId, language: resident.language, direction: 'outbound' });
  logDecision(store, { sessionId: session.id, kind: 'outbound', summary: `${resident.displayName} answered the outbound call`, reason: 'Resident opted in to proactive calls' });
  const { message, cards } = await runEvent(store, session,
    `OUTBOUND CALL CONNECTED. You (Lifeline) are calling ${resident.displayName}, an opted-in resident. First call find_resource with resource_type "info" and topic "shutoff" to get the verified shutoff notice. Then, in two short sentences, greet them by name, ask if you are speaking with them, say why you are calling (the planned shutoff, using only what the bulletin says), and ask if they need anything. Do not mention medical details until they confirm who they are.`);
  return { ok: true, sessionId: session.id, language: session.language, messages: message ? [message] : [], cards };
}

// ------------------------------------------------------------------ driver actions

export function driverAction(store, dispatchId, driverId, action) {
  const dispatch = store.dispatches.get(dispatchId);
  if (!dispatch || dispatch.driverId !== driverId) return { ok: false, status: 404, error: 'unknown_dispatch' };
  const session = store.sessions.get(dispatch.sessionId);
  const driver = store.drivers.get(driverId);

  if (action === 'accept') {
    if (dispatch.status !== 'assigned') return { ok: false, status: 409, error: `dispatch_is_${dispatch.status}` };
    dispatch.status = 'accepted';
    logDecision(store, { sessionId: dispatch.sessionId, kind: 'driver', summary: `${driver.name} accepted dispatch ${dispatch.id}`, reason: 'Driver response' });
  } else if (action === 'decline') {
    if (!['assigned', 'accepted'].includes(dispatch.status)) return { ok: false, status: 409, error: `dispatch_is_${dispatch.status}` };
    reassignAfterDecline(store, dispatch, session);
  } else if (action === 'delivered') {
    if (!['assigned', 'accepted'].includes(dispatch.status)) return { ok: false, status: 409, error: `dispatch_is_${dispatch.status}` };
    dispatch.status = 'delivered';
    const hold = store.holds.get(dispatch.holdId);
    if (hold) hold.status = 'fulfilled';
    freeDriverIfIdle(store, driverId, dispatch.id);
    logDecision(store, { sessionId: dispatch.sessionId, kind: 'driver', summary: `${driver.name} marked dispatch ${dispatch.id} delivered`, reason: 'Driver response' });
  } else {
    return { ok: false, status: 400, error: 'invalid_action' };
  }
  if (session) emitCards(store, session);
  if (session) pushToSession(store, session.id, 'driver', { action });
  touch(store);
  return { ok: true };
}
