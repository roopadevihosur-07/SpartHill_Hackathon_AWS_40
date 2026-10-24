#!/usr/bin/env bash
# Creates the AWS side of Lifeline Live in YOUR account (idempotent, safe to re-run):
#   - CloudWatch log group for Bedrock model invocation logs (1-day retention)
#   - CloudWatch log group for the app's redacted decision log (1-day retention)
#   - IAM role that lets Bedrock write those logs
#   - Bedrock model invocation logging (turned on, pointing at the log group)
#   - Bedrock Guardrail (+ a numbered version)
#   - CloudWatch dashboard "LifelineLive"
# and writes data/aws-resources.json, which the app reads to enable the Guardrail,
# CloudWatch shipping, and the "AWS footprint" panel on the coordinator console.
#
# Usage:  ./infra/aws-setup.sh            (full prompts and replies are logged)
#         LOG_BODIES=0 ./infra/aws-setup.sh   (metadata only: no prompt/reply text in logs)
# Undo:   ./infra/aws-teardown.sh

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
LOG_BODIES="${LOG_BODIES:-1}"
RETENTION_DAYS=1
INV_GROUP="/lifeline-live/bedrock-invocations"
APP_GROUP="/lifeline-live/decision-log"
ROLE="LifelineBedrockLogging"
GUARD_NAME="lifeline-live-guardrail"
DASH="LifelineLive"
MODEL_ID="${BEDROCK_MODEL_ID:-us.amazon.nova-pro-v1:0}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v aws >/dev/null || { echo "AWS CLI not found"; exit 1; }
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
echo "Account $ACCOUNT, region $REGION, as $CALLER_ARN"
case "$CALLER_ARN" in *":root") echo "NOTE: running as the account root user. Prefer a scoped IAM user (infra/app-policy.json)." ;; esac

say() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- log groups
say "CloudWatch log groups (retention ${RETENTION_DAYS} day)"
for g in "$INV_GROUP" "$APP_GROUP"; do
  if [ -z "$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$g" --query "logGroups[?logGroupName=='$g'].logGroupName" --output text)" ]; then
    aws logs create-log-group --region "$REGION" --log-group-name "$g"
    echo "created $g"
  else
    echo "exists  $g"
  fi
  aws logs put-retention-policy --region "$REGION" --log-group-name "$g" --retention-in-days "$RETENTION_DAYS"
done

# ---------------------------------------------------------------- IAM role for Bedrock logging
say "IAM role $ROLE"
cat > "$TMP/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "$ACCOUNT" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock:$REGION:$ACCOUNT:*" }
    }
  }]
}
EOF
cat > "$TMP/perm.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
    "Resource": "arn:aws:logs:$REGION:$ACCOUNT:log-group:$INV_GROUP:*"
  }]
}
EOF
NEW_ROLE=0
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$TMP/trust.json" \
    --description "Lets Amazon Bedrock write Lifeline Live model invocation logs" >/dev/null
  NEW_ROLE=1
  echo "created $ROLE"
else
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$TMP/trust.json"
  echo "exists  $ROLE (trust policy refreshed)"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name WriteInvocationLogs --policy-document "file://$TMP/perm.json"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
[ "$NEW_ROLE" = 1 ] && { echo "waiting for IAM to propagate"; sleep 12; }

# ---------------------------------------------------------------- invocation logging
say "Bedrock model invocation logging (full text: $([ "$LOG_BODIES" = 1 ] && echo yes || echo NO, metadata only))"
CURRENT="$(aws bedrock get-model-invocation-logging-configuration --region "$REGION" --query 'loggingConfig.cloudWatchConfig.logGroupName' --output text 2>/dev/null || true)"
CURRENT_S3="$(aws bedrock get-model-invocation-logging-configuration --region "$REGION" --query 'loggingConfig.s3Config.bucketName' --output text 2>/dev/null || true)"
if { [ -n "$CURRENT" ] && [ "$CURRENT" != "None" ] && [ "$CURRENT" != "$INV_GROUP" ]; } || { [ -n "$CURRENT_S3" ] && [ "$CURRENT_S3" != "None" ]; }; then
  echo "Invocation logging is already configured for something else (log group '$CURRENT', bucket '$CURRENT_S3')."
  echo "Not overwriting it. Remove it yourself or point it at $INV_GROUP, then re-run."
  exit 1
fi
if [ "$LOG_BODIES" = 1 ]; then TEXT=true; else TEXT=false; fi
cat > "$TMP/logging.json" <<EOF
{
  "cloudWatchConfig": { "logGroupName": "$INV_GROUP", "roleArn": "$ROLE_ARN" },
  "textDataDeliveryEnabled": $TEXT,
  "imageDataDeliveryEnabled": false,
  "embeddingDataDeliveryEnabled": false,
  "videoDataDeliveryEnabled": false
}
EOF
for attempt in 1 2 3 4 5; do
  if aws bedrock put-model-invocation-logging-configuration --region "$REGION" --logging-config "file://$TMP/logging.json" 2>"$TMP/err.txt"; then
    echo "invocation logging enabled -> $INV_GROUP"; break
  fi
  if [ "$attempt" = 5 ]; then cat "$TMP/err.txt"; exit 1; fi
  echo "retrying (IAM propagation)…"; sleep 8
done

# ---------------------------------------------------------------- guardrail
say "Bedrock Guardrail $GUARD_NAME"
GUARD_ID="$(aws bedrock list-guardrails --region "$REGION" --query "guardrails[?name=='$GUARD_NAME'].id | [0]" --output text)"
if [ -z "$GUARD_ID" ] || [ "$GUARD_ID" = "None" ]; then
  GUARD_ID="$(aws bedrock create-guardrail --region "$REGION" --cli-input-json "file://$HERE/guardrail.json" --query guardrailId --output text)"
  echo "created guardrail $GUARD_ID"
else
  echo "exists  guardrail $GUARD_ID (updating to match infra/guardrail.json)"
  aws bedrock update-guardrail --region "$REGION" --guardrail-identifier "$GUARD_ID" --cli-input-json "file://$HERE/guardrail.json" >/dev/null
fi
GUARD_VERSION="$(aws bedrock create-guardrail-version --region "$REGION" --guardrail-identifier "$GUARD_ID" --description "Lifeline Live $(date -u +%Y-%m-%dT%H:%MZ)" --query version --output text)"
GUARD_ARN="arn:aws:bedrock:$REGION:$ACCOUNT:guardrail/$GUARD_ID"
echo "guardrail $GUARD_ID version $GUARD_VERSION"

# ---------------------------------------------------------------- dashboard
say "CloudWatch dashboard $DASH"
cat > "$TMP/dash.json" <<EOF
{
  "widgets": [
    { "type": "text", "x": 0, "y": 0, "width": 24, "height": 2, "properties": { "markdown": "# Lifeline Live\nAmazon Bedrock ($MODEL_ID) · region $REGION · Guardrail \`$GUARD_ID\` v$GUARD_VERSION · invocation logs: \`$INV_GROUP\` · app decision log: \`$APP_GROUP\`" } },
    { "type": "metric", "x": 0, "y": 2, "width": 6, "height": 6, "properties": { "title": "Bedrock invocations", "region": "$REGION", "view": "timeSeries", "stat": "Sum", "period": 60, "metrics": [ [ "AWS/Bedrock", "Invocations", "ModelId", "$MODEL_ID" ] ] } },
    { "type": "metric", "x": 6, "y": 2, "width": 6, "height": 6, "properties": { "title": "Bedrock latency (ms)", "region": "$REGION", "view": "timeSeries", "period": 60, "metrics": [ [ "AWS/Bedrock", "InvocationLatency", "ModelId", "$MODEL_ID", { "stat": "Average" } ], [ "...", { "stat": "p95" } ] ] } },
    { "type": "metric", "x": 12, "y": 2, "width": 6, "height": 6, "properties": { "title": "Tokens", "region": "$REGION", "view": "timeSeries", "stat": "Sum", "period": 60, "metrics": [ [ "AWS/Bedrock", "InputTokenCount", "ModelId", "$MODEL_ID" ], [ ".", "OutputTokenCount", ".", "." ] ] } },
    { "type": "metric", "x": 18, "y": 2, "width": 6, "height": 6, "properties": { "title": "Bedrock errors and throttles", "region": "$REGION", "view": "timeSeries", "stat": "Sum", "period": 60, "metrics": [ [ "AWS/Bedrock", "InvocationClientErrors", "ModelId", "$MODEL_ID" ], [ ".", "InvocationServerErrors", ".", "." ], [ ".", "InvocationThrottles", ".", "." ] ] } },
    { "type": "metric", "x": 0, "y": 8, "width": 12, "height": 6, "properties": { "title": "Lifeline: what the agent did", "region": "$REGION", "view": "timeSeries", "stat": "Sum", "period": 60, "metrics": [ [ "LifelineLive", "Calls" ], [ ".", "Holds" ], [ ".", "Dispatches" ], [ ".", "Replans" ], [ ".", "RedFlags" ], [ ".", "ApprovalsRequested" ] ] } },
    { "type": "metric", "x": 12, "y": 8, "width": 12, "height": 6, "properties": { "title": "Lifeline: safety nets that fired", "region": "$REGION", "view": "timeSeries", "stat": "Sum", "period": 60, "metrics": [ [ "LifelineLive", "GuardrailInterventions" ], [ ".", "GroundingBlocks" ], [ ".", "ToolErrors" ], [ ".", "ReplanFailures" ] ] } },
    { "type": "metric", "x": 0, "y": 14, "width": 24, "height": 5, "properties": { "title": "Bedrock Guardrail: checks and interventions", "region": "$REGION", "view": "timeSeries", "stat": "Sum", "period": 60, "metrics": [ [ { "expression": "SEARCH('{AWS/Bedrock/Guardrails,GuardrailContentSource,GuardrailPolicyType,Operation} MetricName=\"Invocations\"', 'Sum', 60)", "label": "Checked", "id": "e1" } ], [ { "expression": "SEARCH('{AWS/Bedrock/Guardrails,GuardrailContentSource,GuardrailPolicyType,Operation} MetricName=\"InvocationsIntervened\"', 'Sum', 60)", "label": "Intervened", "id": "e2" } ] ] } },
    { "type": "log", "x": 0, "y": 19, "width": 24, "height": 7, "properties": { "title": "Bedrock model invocation log (newest first)", "region": "$REGION", "view": "table", "query": "SOURCE '$INV_GROUP' | fields @timestamp, operation, modelId, input.inputTokenCount as inTokens, output.outputTokenCount as outTokens | sort @timestamp desc | limit 20" } },
    { "type": "log", "x": 0, "y": 26, "width": 24, "height": 8, "properties": { "title": "Lifeline decision log, redacted (newest first)", "region": "$REGION", "view": "table", "query": "SOURCE '$APP_GROUP' | fields @timestamp, kind, level, summary, reason | filter kind != 'model_round' and kind != 'turn' | sort @timestamp desc | limit 30" } }
  ]
}
EOF
aws cloudwatch put-dashboard --region "$REGION" --dashboard-name "$DASH" --dashboard-body "file://$TMP/dash.json" >/dev/null
echo "dashboard $DASH written"

# ---------------------------------------------------------------- resources file for the app
mkdir -p "$ROOT/data"
enc() { printf '%s' "$1" | sed 's#/#$252F#g'; }
CONSOLE="https://$REGION.console.aws.amazon.com"
cat > "$ROOT/data/aws-resources.json" <<EOF
{
  "account": "$ACCOUNT",
  "region": "$REGION",
  "modelId": "$MODEL_ID",
  "logBodies": $TEXT,
  "retentionDays": $RETENTION_DAYS,
  "invocationLogGroup": "$INV_GROUP",
  "decisionLogGroup": "$APP_GROUP",
  "loggingRoleArn": "$ROLE_ARN",
  "guardrail": { "id": "$GUARD_ID", "version": "$GUARD_VERSION", "arn": "$GUARD_ARN" },
  "dashboard": "$DASH",
  "links": {
    "dashboard": "$CONSOLE/cloudwatch/home?region=$REGION#dashboards/dashboard/$DASH",
    "invocationLogs": "$CONSOLE/cloudwatch/home?region=$REGION#logsV2:log-groups/log-group/$(enc "$INV_GROUP")",
    "decisionLogs": "$CONSOLE/cloudwatch/home?region=$REGION#logsV2:log-groups/log-group/$(enc "$APP_GROUP")",
    "bedrockLoggingSettings": "$CONSOLE/bedrock/home?region=$REGION#/settings",
    "guardrails": "$CONSOLE/bedrock/home?region=$REGION#/guardrails",
    "metrics": "$CONSOLE/cloudwatch/home?region=$REGION#metricsV2",
    "iamRole": "https://console.aws.amazon.com/iam/home#/roles/details/$ROLE"
  }
}
EOF

say "Done. Open these in the AWS Console (sign in to account $ACCOUNT):"
echo "  Dashboard:        $CONSOLE/cloudwatch/home?region=$REGION#dashboards/dashboard/$DASH"
echo "  Invocation logs:  log group $INV_GROUP"
echo "  Decision log:     log group $APP_GROUP"
echo "  Guardrail:        $GUARD_ID (version $GUARD_VERSION)"
echo
echo "Restart the app so it picks up data/aws-resources.json."
