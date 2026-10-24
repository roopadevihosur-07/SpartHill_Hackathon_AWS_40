# Lifeline Live: safety, trust and privacy rules

These apply to every spec, prompt change and code change in this repo.

1. **No medical advice.** The agent never diagnoses, doses, or says how to store or use a medicine. It points to a pharmacist, doctor or 911 and offers to find a pharmacy. A Bedrock Guardrail (`infra/guardrail.json`, denied topic `medical-advice`) blocks it on output as a second line of defence.
2. **Red flags go to 911 first.** Chest pain, difficulty breathing, confusion, unconscious, stroke signs, overdose and self-harm are detected in code (`server/redflags.js`) before the model runs, and outside the per-call queue, so the 911 guidance reaches the caller immediately even if an earlier message is still being processed. Rosa gets a critical alert and resource lookups are blocked for that turn.
3. **Tools are the only source of facts.** Sites, stock, hours, distances, drivers, ETAs, shortage status and bulletins come from tool results. The agent must not invent them, and a reply that claims a driver is coming or a hold exists without a matching record is blocked.
4. **Say only what happened.** "Held", "dispatched" and "alerted" are said only when a tool result in this call says so.
5. **Human in the loop.** Medicine holds wait for Rosa's approval (toggle on the console). Every agent decision is written to the Decision_Log with its reason.
6. **Consent before saving an address.** `request_address_consent`, then a verbal yes (checked in code, 30 s window, anything unclear counts as no), then `save_address`. Addresses are never written to the log.
7. **Redact before persisting.** Stored transcripts and log entries pass through `server/pii.js`. If redaction throws, the text is not stored. The redacted decision log is also sent to CloudWatch Logs.
8. **Records expire.** Sessions, holds, dispatches, approvals, alerts and log entries are removed after `RECORD_TTL_MS` (24 h). The CloudWatch log groups use 1-day retention (CloudWatch may take longer than that to physically delete old events).
9. **Be honest about data.** Simulated data is labelled DEMO DATA. The FDA shortage check is national and says nothing about local stock.
10. **No secrets in the repo.** AWS credentials come from the standard credential chain. `.env` and `data/aws-resources.json` (account id, links) are git-ignored. Prefer a scoped IAM user (`infra/app-policy.json`) over root.
11. **Bedrock request logging stores raw conversations.** Model invocation logs contain the full prompt and reply text, including anything a caller says, UNREDACTED (redaction happens only in this app's own storage). They go to `/lifeline-live/bedrock-invocations` with 1-day retention. Run `LOG_BODIES=0 ./infra/aws-setup.sh` for metadata-only logs, or `./infra/aws-teardown.sh` to remove everything, before using real caller data.
12. **The Guardrail screens the caller's words only.** The server's own instructions are not sent through the prompt-attack filter (they trip it). Do not widen that scope without re-running `npm run scenarios`.
