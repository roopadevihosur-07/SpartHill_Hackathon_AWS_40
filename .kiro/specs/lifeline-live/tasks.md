# Implementation Plan: Lifeline Live

Status reflects what exists in this repo and how it was verified. "Verified" means exercised against the running server and the real Bedrock model, or by the named script.

## Tasks

- [x] 1. Project scaffold and configuration
  - Node ESM, Express, Bedrock SDK, `.env.example`, loopback-by-default binding, `ADMIN_TOKEN` required off-loopback
  - _Requirements: 14.1_

- [x] 2. Simulated data and state store
  - [x] 2.1 `data/seed.json`: 5 pharmacies, 3 food banks, 2 cooling centers, 4 volunteers, 3 opted-in residents, 5 bulletins
  - [x] 2.2 `server/store.js`: holds, dispatches, approvals, alerts, decision log, TTL `sweep()`
  - _Requirements: 5.2, 10.1, 13.5_

- [x] 3. Tool layer (verified: tools smoke test, `npm run test:paths`)
  - [x] 3.1 `classify_need` with 2-question clarification cap (Req 2)
  - [x] 3.2 `find_resource` and info bulletins (Req 3, 12)
  - [x] 3.3 `check_shortage` against live openFDA, `normalize_drug` against RxNorm (Req 4, 15.4)
  - [x] 3.4 `reserve` with conditional write, version conflict, unique hold id, approval gate (Req 5, 11)
  - [x] 3.5 `dispatch_volunteer` with batching, ETA, ordered route (Req 6, 7)
  - [x] 3.6 `escalate`, `request_address_consent`, `save_address` (Req 9, 13)

- [x] 4. Agent (verified: `npm run scenarios`)
  - [x] 4.1 Bedrock Converse tool-use loop with parallel tool calls and history rollback on failure
  - [x] 4.2 Red-flag fast path: 911 guidance in about 6 ms before the model runs (Req 9)
  - [x] 4.3 Grounding guard, confirm-first guard, shortage-first guard, auto-dispatch (Req 5.1, 12)
  - [x] 4.4 Consent state machine with 30 s window (Req 13)

- [x] 5. Orchestration (verified: scenarios `insulin`, `outbound`; `test:paths`)
  - [x] 5.1 Approvals: approve executes the hold, reject cancels it (Req 11)
  - [x] 5.2 Stock-out re-plan with server-side completion check; 10.5 s to 22.2 s measured over five runs (Req 8)
  - [x] 5.3 Outbound "we call you" call (Req 15.1)
  - [x] 5.4 Driver accept, decline with reassignment, delivered

- [x] 6. Front ends (verified: loaded in headless Chrome under the CSP; live data renders)
  - [x] 6.1 Caller page: voice, text fallback, confirmation card with SMS stand-in, incoming-call screen (Req 1, 7, 14)
  - [x] 6.2 Coordinator console: approvals, alerts, holds with Out of stock, stock table, decision log, KPIs, outbound control
  - [x] 6.3 Driver page with Dispatch Card

- [x] 7. Surge test (verified: `npm run surge -- --agent 8`)
  - Tool layer 25 to 200 concurrent: 0 faults, p95 84 to 127 ms. Live agent 8 concurrent: 8/8 ok, p95 6.0 s (Req 15.2)

- [x] 8. Kiro project files: steering (`product`, `safety`, `tech`), design, hook `tool-schema-sync`

- [x] 9. AWS integration (verified in the account: logs, metrics and dashboard received real data)
  - [x] 9.1 `infra/aws-setup.sh` and `aws-teardown.sh`: invocation logging, log groups (1-day retention), IAM role, Guardrail, 10-widget CloudWatch dashboard
  - [x] 9.2 Bedrock Guardrail on every model call, scoped to the caller's words (`guardContent`)
  - [x] 9.3 `server/telemetry.js`: redacted decision log and 12 custom metrics to CloudWatch
  - [x] 9.4 "AWS footprint" panel on the console with live status and links
  - [x] 9.5 Fixes found while testing: 911 guidance no longer waits behind a slow turn; assistant lines no longer rewritten to "this is [NAME]"; Guardrail address filter removed because it replaced neighbourhood names

## Not done / needs a human

- [ ] 10. Manual browser test of voice on the real demo laptop and phone. Speech recognition needs Chrome or Safari and a secure origin (`localhost` or HTTPS). Phones on the LAN over plain HTTP cannot use the microphone; use the text box or an HTTPS tunnel.
- [ ] 11. Submit the Anthropic use-case form in the Bedrock console if you want Claude instead of Nova Pro, then set `BEDROCK_MODEL_ID` and re-run `npm run scenarios`.
- [ ] 12. Rehearse the demo three times and record the backup video (see README "Demo script").
- [ ] 13. Replace the account-root credentials with a scoped IAM user (`infra/app-policy.json`) before sharing the repo or the machine.
- [ ] 14. Decide whether to keep Bedrock invocation logging on with full text (it stores raw conversations for 1 day), or run `LOG_BODIES=0 ./infra/aws-setup.sh`.
