# Plugforge AI Cost Analysis

> PRD §Submission requires: tracked dev spend, a production projections table, and
> explicit assumptions for webhook fanout, agent active rate, and storage retention.
> This document is grounded in the actual Ship platform implementation. See also
> [`pre-search.md`](./pre-search.md), [`plugforge-prd.md`](./plugforge-prd.md), and
> [`../architecture.md`](../architecture.md).

---

## Headline discipline: the platform does zero AI work

The Ship **platform layer** — OAuth, `/api/v1`, the webhook pipeline, the SDK, the
developer portal — invokes **no LLM at all**. There is no platform-layer AI feature
(no "smart scope suggestions", no AI-summarized webhook payloads). The only LLM spend
in the system is on **user-initiated agent turns**, and the invariant is **one LLM call
per agent turn**.

The architectural payoff of Epic 7 is that the agent runs through the **public API like
any other client** (OAuth app → SDK → `/api/v1` → same domain services). This changes
the agent's *access shape* — same scopes, same rate limits, same audit trail as an
external developer — **without changing its cost shape**. Therefore:

> **Cost scales with agent activity, not with platform traffic.**

A workspace that sends a million API calls and a million webhook deliveries but never
invokes the agent has **zero LLM cost**. The platform's own cost is ordinary compute,
database, and egress — not tokens.

> **Note:** Epic 7 (the agent rewire) is **not yet implemented** — the agent currently
> uses direct service calls (`api/src/routes/claude.ts`). The cost projections below
> are unaffected by this, because the rewire is designed to preserve token volume; the
> before/after measurement in the next section is a *planned* verification.

---

## Development & Testing Costs to Track

| Cost item | What to measure | Notes |
| --- | --- | --- |
| **LLM spend during the Epic 7 rewire** | Per-day Sonnet-class spend while migrating direct service calls to SDK calls | The rewire must **not** change token volume. Verify with a before/after measurement: token count per agent turn on the legacy path vs. the SDK path. Expected delta ≈ 0. *(Planned — Epic 7 not yet built.)* |
| **CI minutes for the TTFE drill** | Wall-clock of the full `install → login → subscribe → trigger → receive → verify` loop per PR | Local drill measured **794 ms** total (`drill/results/ttfe.json`), dominated by the real SDK tarball install (~749 ms). CI budget ≈ +1–2 min/PR. *(Now wired into CI — the `ttfe-drill` job in `pr-tests.yml` runs `pnpm drill ttfe` on every PR.)* |
| **OAuth Playwright launches** | Browser-launch compute for the auth-code flow | Ship is its own IdP (no external auth server to stub), so the flow drives Ship's own consent screen against a containerized Postgres — a few seconds/PR. *(Not yet in CI.)* |
| **OpenAPI generation + validation** | Time to generate the 3.1 spec from Zod and validate it | Small, in-process; runs inside the existing `pnpm run test` (`openapi/__tests__/spec.test.ts`). Sub-second. |
| **Dev-portal storage & egress** | Delivery-log + audit-log row growth at demo volume | Each delivery = 1 `webhook_deliveries` row + 1 `webhook_delivery_attempts` row/attempt; each API call = 1 `public_api_audit_logs` row. Negligible at demo scale; see retention assumption below. |

**Current CI baseline:** `.github/workflows/pr-tests.yml` runs `pnpm run test`
(api + web + probe + sdk unit suites) on Postgres 16 plus the `ttfe-drill` job — a few
minutes per PR. Adding the OAuth Playwright flow is the remaining projected CI-cost
increase.

---

## Production Cost Projections

Platform-layer cost scales with API traffic and webhook delivery (compute + DB + egress),
**not** with LLM calls. LLM cost is attributable to the agent app's user-driven sessions
only. Numbers assume the agent app is one of N installed apps at each tier.

| Tier | API calls/day | Webhook deliveries/day | Agent LLM calls/day | Est. cost/month |
| --- | --- | --- | --- | --- |
| 100 users | ~20,000 | ~5,000 | ~50 | $2–8 |
| 1,000 users | ~200,000 | ~50,000 | ~500 | $15–50 |
| 10,000 users | ~2,000,000 | ~500,000 | ~5,000 | $80–250 |
| 100,000 users | ~20,000,000 | ~5,000,000 | ~50,000 | $500–1,500 |

**Reading the table.** The LLM share of cost is small and roughly linear in *agent
calls/day*, not in *API calls/day*. At every tier, agent LLM calls are ~0.25% of API
calls — because the platform never calls the LLM and only a fraction of users invoke the
agent (see *Agent active rate* below). The dollar range is dominated by compute/DB/egress
for API + webhook traffic; the agent's token spend is a minor, predictable addend on top.

---

## Include Assumptions (stated explicitly)

### Webhook fanout ratio

**Definition:** deliveries per write = the average number of **active matching
subscriptions** for the event type produced by that write.

**Grounding:** Ship subscriptions are **per-app, per-event-type** with no broadcast or
global subscription (`api/src/platform/webhooks/subscriptions.ts`), and fan-out is
further gated by **document visibility** (private docs deliver only to the creator's
matching subscriptions; migration 055). So fanout is bounded by
`(apps subscribed to the event) × (subscriptions per app for that event)`, narrowed by
visibility.

**Assumed values:** the projections assume an average fanout of **~0.25 deliveries per
write** across all write operations — i.e. roughly 1 in 4 writes matches an active
subscription, and matching writes typically hit 1–2 subscriptions. This yields the
table's deliveries/day ≈ ¼ of API calls/day. This is intentionally conservative:
fanout rises linearly with installed apps subscribing to popular events, but the
per-app/per-event model means it cannot explode the way a global broadcast would.

### Agent active rate

**Definition:** the fraction of users who invoke agent features on a given day, times
the average number of agent turns per active user — multiplied by **one LLM call per
turn** (the platform invariant).

**Assumed values:** ~**10% daily active-agent rate**, ~**5 agent turns per active user
per day** → agent LLM calls/day ≈ `users × 0.10 × 5 = users × 0.5`. (The table rounds
this against the installed-app mix; the agent app is one of N apps, so realized agent
calls land near the ~0.25%-of-API-calls figure shown.) **The cost projection bends on
this assumption, not on platform traffic:** doubling API traffic with the same agent
activity barely moves LLM cost; doubling agent activity moves it directly. Per the PRD
invariant, there is exactly one LLM call per turn — no hidden platform-side calls.

### Storage retention

**Definition:** delivery-log rows × retention days × bytes/row, plus audit-log rows ×
retention days × bytes/row.

**Grounding & known gap:** there is currently **no automated retention / cleanup job**
for `webhook_deliveries`, `webhook_delivery_attempts`, or `public_api_audit_logs` — the
tables grow unbounded. For the demo this is immaterial; for production it must be bounded.

**Recommended windows and why:**
- **Webhook delivery log: 30 days.** Long enough to debug a failing integration, retry
  history, and DLQ investigation across a typical incident cycle; short enough to keep
  the highest-volume table small. At the 100k-user tier (~5M deliveries/day) and an
  assumed ~1 KB/row including attempts, 30 days ≈ **~150 GB** — the dominant storage
  line, which is exactly why the window is the tightest.
- **Audit log: 90 days.** Security/compliance value (leaked-secret investigation,
  proving the agent went through the public API) justifies a longer window than the
  delivery log. At ~20M API calls/day and ~0.5 KB/row, 90 days ≈ **~900 GB** at the top
  tier — kept longer because each row is smaller and the forensic value is higher.

Both windows are recommendations; implementing the cleanup job (a scheduled
delete-older-than) is the action item that turns these assumptions into enforced ceilings.

---

## Bottom line

- The platform itself is **LLM-free**; tokens are spent only on user-initiated agent
  turns at **one call per turn**.
- Production cost is dominated by **API + webhook compute/DB/egress**, which scales with
  traffic; the **LLM addend scales with agent activity**, which is a small, separately-
  controllable fraction.
- The two assumptions that actually move the numbers are **agent active rate** (drives
  LLM cost) and **storage retention** (drives the largest infrastructure line) — both
  stated above with explicit values and rationale.
