# Lifeline Live

A browser-based AI agent for outages and disasters. A person speaks (or types) what they need. The agent triages it, finds medicine, food, water, shelter or power, holds it, sends a volunteer driver, and shows a confirmation. A coordinator supervises on a console and can approve risky actions, and the agent re-plans when a site runs out of stock.

Built for SpartHill Hacks 2026 (AWS AI/ML track) with **only Amazon Bedrock (us-east-1) and Kiro**. See `.kiro/` for the steering files, requirements, design and tasks.

> **Simulated data.** Sites, stock levels, volunteers and residents are fictional (`data/seed.json`) and labelled DEMO DATA in the UI. Only the openFDA shortage listing and RxNorm names are live.

## Run it

Requires Node 22+ and AWS credentials in the standard chain (`aws configure`, SSO, or env vars) with Bedrock access in us-east-1.

```bash
npm install
cp .env.example .env      # optional
npm start
```

| Page | URL | For |
|---|---|---|
| Caller | http://127.0.0.1:3000/ | the person asking for help |
| Coordinator console | http://127.0.0.1:3000/console.html | Rosa |
| Driver | http://127.0.0.1:3000/driver.html | volunteer drivers |

Voice needs Chrome or Safari on `localhost` or HTTPS. Without it, the text box works the same way.

**Sharing on a network:** set `HOST=0.0.0.0` and `ADMIN_TOKEN=<long random value>` in `.env`. The server refuses to start otherwise, because the console can approve medicine holds and reset data. Phones on plain HTTP cannot use the microphone (browser rule), so use an HTTPS tunnel or the text box.

## Model

Default is **Amazon Nova Pro** (`us.amazon.nova-pro-v1:0`), which works on the event account out of the box. A model call takes about 1.2 to 2.4 s. A full caller turn (one to two model calls plus tools) measured 4.0 to 7.7 s, median 5.0 s over 11 turns. That is slower than a human phone call, so the caller page speaks a short "one moment" line after 1.8 s and the status text shows progress. The first turn after a server start can be slower.

Claude models returned `ResourceNotFoundException: Model use case details have not been submitted` on this account. To use Claude, submit the Anthropic use-case form in the Bedrock console, wait about 15 minutes, then set `BEDROCK_MODEL_ID` in `.env` (for example `us.anthropic.claude-haiku-4-5-20251001-v1:0`) and run `npm run scenarios`. `npm run bench` compares models on the real prompt and tools.

## Demo script (about 3 minutes)

1. Open the caller page, the console, and the driver page (as Dev Patel or whoever gets dispatched) side by side.
2. **Call 1, medicine.** Say: "My insulin is getting warm, the power is out and I have no car." The agent checks the live FDA listing, finds a pharmacy with power and cold storage, and offers it. Say yes. The console shows **Approval needed**: press Approve. A driver is dispatched and the caller sees the confirmation card and text message.
3. **Re-plan.** On the console, press **Out of stock** on the hold. Within about 20 s the caller hears the new plan, the same driver is re-routed on the driver page, and the decision log shows the superseded and new site.
4. **Call 2, food.** Open a second caller tab: "Family of four, no food, no car." The job is batched onto a driver's run when the detour is small (see miles saved on the console).
5. **Call 3, information.** "Is the cooling center on 10th Street open?" (also works in Spanish: set Language first).
6. **Safety.** Say "I have chest pain." 911 guidance is spoken immediately and the console raises a critical alert.
7. **We call you.** On the caller page, expand Demo and choose Mr. Nguyen, then press **Call resident** on the console. Answer and the agent opens the call using the verified shutoff bulletin.
8. Show the decision log and the surge chart.

## What runs in AWS

The app itself runs on your machine. These pieces live in your AWS account (region us-east-1). Create them with one script:

```bash
./infra/aws-setup.sh               # idempotent; prints the console links when it finishes
LOG_BODIES=0 ./infra/aws-setup.sh  # metadata only: no prompt or reply text in the logs
./infra/aws-teardown.sh            # removes everything the setup created
```

| AWS service | What it does here |
|---|---|
| **Amazon Bedrock** (Converse API, tool use) | The agent. Nova Pro by default. |
| **Bedrock Guardrail** `lifeline-live-guardrail` | Applied to every model call. Blocks medical advice and prompt attacks, detects PII, filters harmful output. Screens the caller's words only. |
| **Bedrock model invocation logging** | Every request and response, in the CloudWatch log group `/lifeline-live/bedrock-invocations` (1-day retention). |
| **CloudWatch Logs** | `/lifeline-live/decision-log`: the app's redacted Decision_Log, so Rosa's audit trail is also in AWS. |
| **CloudWatch metrics** | Namespace `LifelineLive`: calls, holds, dispatches, re-plans, red flags, approvals, guardrail interventions, grounding blocks, model round time. Plus the built-in `AWS/Bedrock` metrics. |
| **CloudWatch dashboard** `LifelineLive` | One page with all of the above and live log tables. |
| **IAM role** `LifelineBedrockLogging` | Lets Bedrock write the invocation logs. |

The coordinator console has an **AWS footprint** panel with live status and links straight to the dashboard, log groups and Guardrail. The setup script writes `data/aws-resources.json` (git-ignored, contains your account id), which the app reads. Console links need you to be signed in to that account.

**Privacy.** Invocation logs hold the full conversation, unredacted, because Bedrock writes them before this app's redaction runs. They expire after 1 day (CloudWatch can take longer to physically delete). Use `LOG_BODIES=0` or run the teardown before handling real caller data.

**Credentials.** The app needs only `bedrock:InvokeModel`/`Converse`, `bedrock:ApplyGuardrail`, `logs:PutLogEvents` and `cloudwatch:PutMetricData`. `infra/app-policy.json` is a least-privilege policy for an IAM user, so you do not have to run it as the account root user.

**Not used:** Amazon Bedrock Agents / AgentCore. The agent loop uses the Converse API with tool use directly, so every safety rule lives in this repo's code where it can be tested.

## Tests

```bash
npm run scenarios          # 8 end-to-end scenarios + a no-placeholder check, real model (server must be running)
npm run test:paths         # 43 checks: redaction, grounding, 911-not-queued, driver decline, approval rejection, no-alternative re-plan, TTL
ENABLE_TEST_API=1 RATE_LIMIT_PER_MIN=5000 npm start
npm run surge -- --agent 8 # tool layer at 25/50/100/200 concurrent callers + 8 live agent calls
```

Measured on a laptop with Nova Pro: tool layer p95 84 to 127 ms with 0 faults at up to 200 concurrent callers; 8 concurrent live agent calls all succeeded, p95 6.0 s; 911 guidance reaches the caller's stream in about 6 ms (and within 500 ms even while another message is being processed); re-plan took 10.5 to 22.2 s over five runs (target 30 s). The Guardrail adds about 200 ms per model call. Your numbers will differ with network and model load.

Model output varies between runs, so scenario assertions check server state (holds, dispatches, alerts, log), not wording.

## Known limits

- **Capacity:** with 4 volunteers and a limit of 3 stops each, 12 jobs get drivers. Additional callers keep their hold and the coordinator is alerted. The surge chart says so.
- **Distances and ETAs** are straight-line with a road factor, not routed (Amazon Location Service is unavailable).
- **PII redaction** is rule-based. It catches phones, emails, ids, street addresses, "my name is Xxx" with a capitalised name, and known resident names. It can miss lowercase spoken names.
- **FDA shortage data** is national and unvalidated. "Not listed" does not mean a pharmacy has stock, and the agent is told so.
- **State is in memory.** Restarting the server clears holds, calls and the decision log.
- **One server process.** There is no database or multi-instance support.

## Privacy and safety in short

No medical advice. Red flags go to 911 guidance first, in code. Only tool results are stated as fact, and made-up "help is coming" claims are blocked. Medicine holds need coordinator approval. Addresses need a verbal yes and are never logged. Stored text is redacted. Records expire after 24 hours. Full rules in `.kiro/steering/safety.md`.
