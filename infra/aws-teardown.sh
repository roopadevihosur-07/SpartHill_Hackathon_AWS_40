#!/usr/bin/env bash
# Removes everything infra/aws-setup.sh created. Safe to re-run; skips what is already gone.
# Turning off invocation logging stops new prompt/reply text from being written to AWS.
set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
INV_GROUP="/lifeline-live/bedrock-invocations"
APP_GROUP="/lifeline-live/decision-log"
ROLE="LifelineBedrockLogging"
GUARD_NAME="lifeline-live-guardrail"
DASH="LifelineLive"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

echo "Disabling invocation logging (only if it points at our log group)"
CUR="$(aws bedrock get-model-invocation-logging-configuration --region "$REGION" --query 'loggingConfig.cloudWatchConfig.logGroupName' --output text 2>/dev/null || true)"
if [ "$CUR" = "$INV_GROUP" ]; then
  aws bedrock delete-model-invocation-logging-configuration --region "$REGION" && echo "  disabled"
else
  echo "  not ours ('$CUR'), left alone"
fi

echo "Deleting dashboard"
aws cloudwatch delete-dashboards --region "$REGION" --dashboard-names "$DASH" 2>/dev/null && echo "  done" || echo "  (none)"

echo "Deleting guardrail"
GID="$(aws bedrock list-guardrails --region "$REGION" --query "guardrails[?name=='$GUARD_NAME'].id | [0]" --output text 2>/dev/null || true)"
if [ -n "$GID" ] && [ "$GID" != "None" ]; then aws bedrock delete-guardrail --region "$REGION" --guardrail-identifier "$GID" && echo "  deleted $GID"; else echo "  (none)"; fi

echo "Deleting log groups (this deletes the logs)"
for g in "$INV_GROUP" "$APP_GROUP"; do aws logs delete-log-group --region "$REGION" --log-group-name "$g" 2>/dev/null && echo "  deleted $g" || echo "  (none) $g"; done

echo "Deleting IAM role"
aws iam delete-role-policy --role-name "$ROLE" --policy-name WriteInvocationLogs 2>/dev/null
aws iam delete-role --role-name "$ROLE" 2>/dev/null && echo "  deleted $ROLE" || echo "  (none)"

rm -f "$ROOT/data/aws-resources.json" && echo "Removed data/aws-resources.json. Restart the app."
echo "CloudWatch custom metrics in namespace LifelineLive expire on their own."
