import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, CreateLogStreamCommand, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { config, aws } from './config.js';

// Sends two things to CloudWatch so the app's behaviour is visible in the AWS account:
//  - the Decision_Log (already redacted by store.js) -> log group /lifeline-live/decision-log
//  - counters and timings                            -> custom metric namespace LifelineLive
// Everything here is best-effort: a CloudWatch problem must never affect a caller's request.

const NAMESPACE = 'LifelineLive';
const LOG_FLUSH_MS = 5000;
const METRIC_FLUSH_MS = 30000;
const MAX_QUEUE = 5000;

const state = {
  enabled: false,
  started: false,
  stream: null,
  logQueue: [],
  metrics: new Map(),
  shippedEvents: 0,
  shippedMetricPoints: 0,
  lastOkAt: null,
  lastError: null,
  errors: 0,
};

let logs = null;
let cw = null;
let timers = [];
const seenErrors = new Set();

function failed(where, err) {
  state.errors++;
  state.lastError = `${where}: ${err?.name ?? 'Error'}`;
  const key = `${where}:${err?.name}`;
  if (!seenErrors.has(key)) {
    seenErrors.add(key);
    console.warn(`CloudWatch ${where} failed (${err?.name}: ${err?.message}). Further repeats are silent. The app keeps working.`);
  }
}

/** Record a metric sample. Counts are summed; other units are averaged by CloudWatch. */
export function metric(name, value = 1, unit = 'Count') {
  if (!state.enabled) return;
  const m = state.metrics.get(name) ?? { unit, sum: 0, n: 0, min: Infinity, max: -Infinity };
  m.sum += value;
  m.n += 1;
  m.min = Math.min(m.min, value);
  m.max = Math.max(m.max, value);
  state.metrics.set(name, m);
}

function shipLog(entry) {
  if (!state.enabled) return;
  state.logQueue.push({
    timestamp: entry.ts,
    message: JSON.stringify({ kind: entry.kind, level: entry.level, summary: entry.summary, reason: entry.reason, session: entry.sessionId?.slice(0, 8), data: entry.data }),
  });
  if (state.logQueue.length > MAX_QUEUE) state.logQueue.splice(0, state.logQueue.length - MAX_QUEUE);
}

/** Called for every Decision_Log entry: ships it and updates counters. */
export function fromDecision(e) {
  shipLog(e);
  const s = e.summary ?? '';
  if (e.kind === 'call') metric('Calls');
  else if (e.kind === 'outbound' && /answered/i.test(s)) metric('Calls');
  else if (e.kind === 'hold') metric('Holds');
  else if (e.kind === 'dispatch' && /^Dispatched/.test(s)) metric('Dispatches');
  else if (e.kind === 'replan') {
    if (e.level === 'critical') metric('ReplanFailures');
    else { metric('Replans'); if (typeof e.data?.ms === 'number') metric('ReplanSeconds', e.data.ms / 1000, 'Seconds'); }
  } else if (e.kind === 'escalation' && /ESCALATED to 911/.test(s)) metric('RedFlags');
  else if (e.kind === 'approval_requested') metric('ApprovalsRequested');
  else if (e.kind === 'grounding') metric('GroundingBlocks');
  else if (e.kind === 'guardrail') metric('GuardrailInterventions');
  else if (e.kind?.startsWith('tool:') && (e.level === 'warning' || e.level === 'critical')) metric('ToolErrors');
}

async function flushLogs() {
  if (!state.logQueue.length || !state.stream) return;
  const batch = state.logQueue.splice(0, 500).sort((a, b) => a.timestamp - b.timestamp);
  try {
    await logs.send(new PutLogEventsCommand({ logGroupName: aws.decisionLogGroup, logStreamName: state.stream, logEvents: batch }));
    state.shippedEvents += batch.length;
    state.lastOkAt = Date.now();
  } catch (err) {
    failed('PutLogEvents', err);
    state.logQueue.unshift(...batch.slice(0, 200)); // one more chance, bounded
  }
}

async function flushMetrics() {
  if (!state.metrics.size) return;
  const data = [...state.metrics.entries()].map(([name, m]) => ({
    MetricName: name,
    Unit: m.unit,
    Timestamp: new Date(),
    StatisticValues: { SampleCount: m.n, Sum: m.sum, Minimum: m.min, Maximum: m.max },
  }));
  state.metrics.clear();
  try {
    await cw.send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data }));
    state.shippedMetricPoints += data.length;
    state.lastOkAt = Date.now();
  } catch (err) {
    failed('PutMetricData', err);
  }
}

export async function start() {
  if (!config.telemetry || !aws?.decisionLogGroup) return false;
  logs = new CloudWatchLogsClient({ region: aws.region });
  cw = new CloudWatchClient({ region: aws.region });
  state.stream = `app-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  try {
    await logs.send(new CreateLogStreamCommand({ logGroupName: aws.decisionLogGroup, logStreamName: state.stream }));
  } catch (err) {
    if (err?.name !== 'ResourceAlreadyExistsException') {
      failed('CreateLogStream', err);
      state.stream = null;
      return false;
    }
  }
  state.enabled = true;
  state.started = true;
  timers = [setInterval(flushLogs, LOG_FLUSH_MS), setInterval(flushMetrics, METRIC_FLUSH_MS)];
  timers.forEach((t) => t.unref());
  return true;
}

export async function stop() {
  timers.forEach(clearInterval);
  if (!state.started) return;
  await Promise.allSettled([flushLogs(), flushMetrics()]);
}

export function status() {
  return {
    enabled: state.enabled,
    stream: state.stream,
    queued: state.logQueue.length,
    shippedEvents: state.shippedEvents,
    shippedMetricPoints: state.shippedMetricPoints,
    lastOkAt: state.lastOkAt,
    lastError: state.lastError,
    errors: state.errors,
  };
}
