import { newId, logDecision, addAlert, touch, itemLabel } from './store.js';
import { config } from './config.js';

// Human-in-the-loop policy. Medicine holds (prescription release) wait for coordinator Rosa.
// A re-plan for the same item inside the same call is covered by her earlier approval.

export function requiresApproval(store, session, item) {
  if (!store.settings.requireMedicineApproval) return { required: false };
  if (store.catalog[item]?.type !== 'medicine') return { required: false };
  if (session.approvedItems.has(item)) return { required: false, coveredByEarlierApproval: true };
  return { required: true };
}

export function findPendingApproval(store, sessionId, input) {
  return [...store.approvals.values()].find(
    (a) => a.sessionId === sessionId && a.status === 'pending' && a.input.site_id === input.site_id && a.input.item === input.item,
  );
}

export function createPendingApproval(store, session, input) {
  const site = store.sites.get(input.site_id);
  const resident = session.residentId ? store.residents.get(session.residentId) : null;
  const approval = {
    id: newId('A', store, store.approvals),
    sessionId: session.id,
    toolName: 'reserve',
    input: { site_id: input.site_id, item: input.item, quantity: input.quantity ?? 1, reason: input.reason },
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + config.recordTtlMs,
    summary: `Hold ${input.quantity ?? 1} × ${itemLabel(store, input.item)} at ${site?.name ?? input.site_id}${resident ? ` for ${resident.displayName}` : ''}${session.need?.summary ? `. Need: ${session.need.summary}` : ''}${session.shortage ? `. ${session.shortage.label}` : ''}`,
  };
  store.approvals.set(approval.id, approval);
  logDecision(store, {
    sessionId: session.id,
    kind: 'approval_requested',
    level: 'attention',
    summary: `Approval requested (${approval.id}): ${approval.summary}`,
    reason: 'Medicine holds need coordinator approval before they are executed',
  });
  addAlert(store, { sessionId: session.id, severity: 'attention', title: 'Approval needed', detail: approval.summary });
  touch(store);
  return approval;
}
