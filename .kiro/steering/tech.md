# Lifeline Live: technical context

## Stack

- Node 22+ (ESM), Express 5, vanilla JS front end with no build step.
- **Amazon Bedrock, us-east-1**, Converse API with tool use (`@aws-sdk/client-bedrock-runtime`). Default model `us.amazon.nova-pro-v1:0`. Claude needs the one-time Anthropic use-case form in the Bedrock console, then set `BEDROCK_MODEL_ID`.
- No other AWS service is available. State is in memory (`server/store.js`) and stands in for DynamoDB. Every record has `expiresAt` and is removed by `sweep()` (stand-in for DynamoDB TTL).
- Voice: browser Web Speech API (recognition + synthesis). Text input is always available.
- Live APIs: openFDA Drug Shortages, RxNorm.

## Layout

```
server/agent.js          Bedrock tool-use loop, red-flag fast path, grounding guard, consent state
server/orchestrator.js   approvals, stock-out re-plan, outbound call, driver actions
server/dispatch.js       driver choice, batching, ETA, vehicle-km accounting
server/store.js          state, decision log, cards, TTL sweep
server/telemetry.js      ships the redacted decision log and counters to CloudWatch (best effort)
infra/                   aws-setup.sh / aws-teardown.sh, guardrail.json, least-privilege app-policy.json
server/tools/            schemas.js (the tool contract) + one function per tool
server/pii.js            redaction before anything is persisted
server/redflags.js       deterministic red-flag, consent and delivery detection
public/                  caller (index), coordinator (console), driver pages
data/seed.json           simulated sites, stock, volunteers, residents, bulletins
scripts/                 scenarios (end-to-end), paths (failure paths), surge, bench-models
```

## Tools (9, all take a `reason` that is written to the Decision_Log)

`classify_need`, `find_resource`, `check_shortage`, `normalize_drug`, `reserve`, `dispatch_volunteer`, `escalate`, `request_address_consent`, `save_address`.

## Rules for changing this code

- **The server enforces anything that matters; the prompt only guides.** Do not rely on the model to remember a safety or correctness step. Existing server guarantees: red-flag escalation before the model runs, consent state machine, reserve needs a caller turn after the offer, medicine reserve needs a shortage check and (by default) coordinator approval, auto-dispatch when the caller cannot travel, unsupported "driver is coming" or "on hold" claims are blocked.
- Changing a tool's input or output: update `server/tools/schemas.js`, the implementation, and the system prompt in `agent.js` together.
- No inline scripts or styles: the CSP is `default-src 'self'`. Build DOM with `textContent` (see `public/js/common.js` `el()`), never `innerHTML`.
- Untrusted input going into URLs or queries (drug names) is sanitized in `tools/external.js`.
- Admin and driver routes use `x-admin-token`. The server refuses to listen on a non-loopback host without `ADMIN_TOKEN`.

## Verification

- `npm run scenarios` runs eight end-to-end scenarios against a running server and the real model (insulin with approval and re-plan, food batching, red flag, info, no-invention, consent declined, Spanish, outbound), then checks that no reply across all of them contains a redaction placeholder.
- `npm run test:paths` runs the failure-path checks (redaction, grounding, 911-not-queued, driver decline, approval rejection, no-alternative re-plan, TTL, readable logs).
- `npm run test:resilience` breaks AWS on purpose (bad Guardrail id, fake credentials) and checks the app degrades safely. Each case runs in its own process because config is read at start-up.
- `npm run test:dispatch` checks driver choice and batching rules. `npm run test:voice` and `npm run test:voice:browser` cover the caller page's voice handling.
- **When you change `server/dispatch.js`, run `npm run test:dispatch`.** Critical jobs and medicine must never be batched.
- **Long-lived streams:** a browser allows 6 connections per address across all tabs. Any new page that holds a stream open must pass `pauseWhenHidden: true` to `connectSse` (see `public/js/common.js`), unless it cannot replay what it missed. Run `npm run test:streams:browser` after touching it.
- **AWS credential errors** are classified in `server/errors.js` (`isCredentialError`). They raise one clear critical alert and set `store.metrics.awsCredentialsFailedAt`, which `/api/health` and the console's AWS panel show. Throttling, a bad Guardrail and a model that is not enabled are deliberately NOT credential errors.
- `ENABLE_TEST_API=1 RATE_LIMIT_PER_MIN=5000 npm start`, then `npm run surge`.
