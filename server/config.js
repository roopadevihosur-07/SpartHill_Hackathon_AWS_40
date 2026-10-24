import { readFileSync } from 'node:fs';

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

// Written by infra/aws-setup.sh. Absent when the AWS resources have not been created.
function loadAwsResources() {
  try {
    return JSON.parse(readFileSync(new URL('../data/aws-resources.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}
export const aws = loadAwsResources();

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  region: process.env.BEDROCK_REGION || 'us-east-1',
  // Amazon Nova Pro works on the event account out of the box. Claude (for example
  // us.anthropic.claude-haiku-4-5-20251001-v1:0) needs the one-time Anthropic use-case form in
  // the Bedrock console first; then set BEDROCK_MODEL_ID in .env.
  modelId: process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-pro-v1:0',
  // Off by default. A silent model switch changes behavior, so it is opt-in and always logged.
  fallbackModelId: process.env.BEDROCK_FALLBACK_MODEL_ID || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  recordTtlMs: int(process.env.RECORD_TTL_MS, 24 * 60 * 60 * 1000),
  holdTtlMs: int(process.env.HOLD_TTL_MS, 2 * 60 * 60 * 1000),
  enableTestApi: process.env.ENABLE_TEST_API === '1',
  rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 40),
  maxMessageChars: 1000,
  demoMode: process.env.DEMO_MODE !== '0',
  bedrockTimeoutMs: int(process.env.BEDROCK_TIMEOUT_MS, 30000),
  // Bedrock Guardrail applied to every model call. On automatically when infra/aws-setup.sh has
  // run; BEDROCK_GUARDRAIL=0 turns it off, BEDROCK_GUARDRAIL_ID / _VERSION override it.
  guardrailId: process.env.BEDROCK_GUARDRAIL === '0' ? '' : (process.env.BEDROCK_GUARDRAIL_ID || aws?.guardrail?.id || ''),
  guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION || aws?.guardrail?.version || 'DRAFT',
  // Ship the (already redacted) decision log and counters to CloudWatch. AWS_TELEMETRY=0 turns it off.
  telemetry: process.env.AWS_TELEMETRY === '0' ? false : Boolean(aws?.decisionLogGroup),
};

export const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);
