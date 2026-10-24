# Lifeline Live: product context

Lifeline Live is a browser-based AI agent that helps people during a power shutoff, outage or disaster. It was built for SpartHill Hacks 2026 (AWS AI/ML track, "essential services during disruptions"). The event account only provides Amazon Bedrock and Kiro, so the original phone-line design (Connect, Lex, SMS) was replaced by a browser voice app.

## People

- **Rosa** (primary user): volunteer dispatch coordinator at a food-and-medicine hub in East San José. She has a laptop, a ringing phone and four volunteer drivers. She approves risky actions and handles red flags.
- **Mr. Nguyen** (caller): 78, insulin-dependent, no car, prefers Vietnamese. Needs one place to ask for help that results in a concrete plan.
- **Volunteer driver**: wants clear pickup and drop-off steps and the ability to accept or decline.

## The loop (every need follows it)

need → triage → match a resource → reserve → dispatch → confirm

Insulin is the demo story, not the scope. A new need type is new rows in `data/seed.json` (catalog items and site inventory), not new code.

## What it handles

Cold-chain and regular medicine, food (including baby formula and diabetic-safe), water, shelter and cooling, powered-device charging, and verified information (power restoration, road closures, advisories).

## Differentiators

1. Lifeline calls opted-in at-risk residents first (simulated outbound call in the browser).
2. It acts live: holds stock, dispatches a driver, and re-plans when a site runs out.
3. Surge-tested: `npm run surge` reports p95 latency and error rate under 25 to 200 concurrent callers.

## Data honesty

No public API exposes real-time pharmacy stock. Sites, stock, volunteers and residents are **simulated** (`data/seed.json`) and labelled DEMO DATA in the UI. Live data: openFDA drug shortages and RxNorm.
