import { ToolError, str, oneOf } from './validate.js';
import { logDecision, addAlert, touch, emitCards } from '../store.js';
import { guidanceFor } from '../redflags.js';

export function escalate(store, session, input) {
  const severity = oneOf(input, 'severity', ['emergency', 'coordinator'], { required: true });
  const redFlag = oneOf(input, 'red_flag', ['chest_pain', 'difficulty_breathing', 'confusion', 'other', 'none'], { fallback: 'none' });
  const reason = str(input, 'reason', { required: true, max: 200 });

  const emergency = severity === 'emergency';
  if (emergency) {
    session.redFlagged = true;
    store.metrics.redFlags++;
  }
  const alert = addAlert(store, {
    sessionId: session.id,
    severity: emergency ? 'critical' : 'attention',
    title: emergency ? `MEDICAL RED FLAG${redFlag !== 'none' ? `: ${redFlag.replace('_', ' ')}` : ''}` : 'Coordinator needed',
    detail: `${reason}${session.residentId ? ` (resident: ${store.residents.get(session.residentId)?.displayName})` : ''}`,
  });
  logDecision(store, {
    sessionId: session.id,
    kind: 'escalation',
    level: emergency ? 'critical' : 'attention',
    summary: emergency ? `ESCALATED to 911 guidance and coordinator (${redFlag})` : 'Escalated to coordinator',
    reason,
    data: { alertId: alert.id, severity, redFlag },
  });
  touch(store);
  return {
    ok: true,
    escalated: true,
    coordinator_alerted: true,
    alert_id: alert.id,
    ...(emergency
      ? { say_to_caller: guidanceFor(session.language), instruction: 'Tell the caller to call 911 now. Do not give medical advice. Do not continue with resource matching in this turn.' }
      : { instruction: 'Tell the caller a coordinator has been alerted and will follow up.' }),
  };
}

export function requestAddressConsent(store, session, input) {
  if (session.consent.state === 'granted') {
    return { ok: true, already_granted: true, message: session.addressSource === 'enrollment' ? 'Consent is on file from enrollment. You may confirm the address on file instead of asking again.' : 'Consent already granted for this call.' };
  }
  session.consent = { state: 'asked', askedAt: Date.now() };
  logDecision(store, { sessionId: session.id, kind: 'privacy', summary: 'Asked caller for verbal consent to save address', reason: str(input, 'reason', { max: 200 }) });
  return {
    ok: true,
    state: 'asked',
    message: 'Now ask out loud: "May I save your address so the driver can find you? Please say yes or no." Then wait. The system will tell you the answer on the next turn. Do not ask for the address yet.',
  };
}

export function saveAddress(store, session, input) {
  if (session.consent.state !== 'granted') {
    return {
      ok: false,
      error: 'consent_not_granted',
      message: 'The caller has not consented. Do not store or repeat the address. Carry on without it; the driver will confirm by phone.',
    };
  }
  const address = str(input, 'address', { required: true, max: 160 });
  if (!address) throw new ToolError('invalid_input', 'address is empty');
  session.address = address;
  session.addressSource = 'caller';
  logDecision(store, { sessionId: session.id, kind: 'privacy', summary: 'Address saved with verbal consent (value not logged)', reason: str(input, 'reason', { max: 200 }) });
  touch(store);
  emitCards(store, session);
  return { ok: true, stored: true, message: 'Address saved for the driver.' };
}
