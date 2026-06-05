# Plugforge Pre-Search Document

> PRD §Submission requires the Pre-Search checklist (PRD Appendix) answered in
> writing across all three phases. This document answers every question, grounded in
> the actual Ship platform implementation. Where a capability is a known gap, the
> answer states the intended design and flags it as **not yet shipped** rather than
> claiming it as done.
>
> Companion artifacts: [`plugforge-prd.md`](./plugforge-prd.md),
> [`grader-quickstart.md`](./grader-quickstart.md), [`webhooks-prd.md`](./webhooks-prd.md),
> [`ai-cost-analysis.md`](./ai-cost-analysis.md), [`../architecture.md`](../architecture.md),
> [`../openapi.json`](../openapi.json). The saved AI brainstorming conversation is
> attached separately as the reference artifact required by the PRD.

---

## Phase 1: Define Your Constraints

### 1.1 — Scale & Load Expectations

**Realistic API request rate during the demo, and webhook fanout.**
The demo window is single-digit concurrent clients: the CLI, one browser SPA demo,
and the grader's curl/Postman session. Peak is well under 10 req/s. Webhook fanout is
1:N where N = matching active subscriptions for an event type. In the demo we seed one
subscription per relevant event type per app, so a single `issue.created` write
produces 1–2 deliveries. The fanout multiplier is bounded by the per-app per-event
subscription model in `api/src/platform/webhooks/subscriptions.ts`; there is no
broadcast/global subscription, so fanout cannot exceed (apps × subscriptions per event).

**OAuth apps and subscriptions seeded for the grader, and the fanout breaking point.**
We seed one read-only grader app (`client_grader_readonly`, `documents:read`) via
`pnpm --filter @ship/api db:seed:grader` (see `grader-quickstart.md`). For webhook
demos we add an app with `webhooks:manage` plus one subscription per emitted event
type. The in-process deliverer fires the first attempt inline post-commit
(`webhooks/scheduler.ts`), so single-digit fanout lands in well under the 2s P95
target — the drill (`drill/results/ttfe.json`) measured the full create→deliver→verify
loop at single-digit milliseconds locally. The deliverer would start to risk the 2s
P95 only at fanout in the hundreds per write, far beyond demo scale; the 30s cron
backstop absorbs any overflow without dropping deliveries.

**Concurrent CLI device-flow sessions and `slow_down`.**
The demo runs at most a couple of concurrent `ship login` device flows. RFC 8628
`slow_down` is implemented in `api/src/platform/oauth/device-codes.ts`: each device
code carries `interval_seconds` and `last_polled_at`; polling faster than the interval
increments the interval and returns `slow_down`. This is per-device-code, so
concurrent sessions are independent and correctly rate-limited.

**Delivery-log growth rate and retention.**
Each delivery writes one `webhook_deliveries` row plus one
`webhook_delivery_attempts` row per attempt (migration 054). At demo event rates this
is a handful of rows. **Known gap:** there is currently **no automated retention /
cleanup job** for `webhook_deliveries` or `public_api_audit_logs` — the tables grow
unbounded. For the demo this is irrelevant (tiny volume); for production we recommend
a 30-day delivery-log / 90-day audit-log retention window (sized in
[`ai-cost-analysis.md`](./ai-cost-analysis.md)).

### 1.2 — Budget & Cost Ceilings

**Weekly LLM budget for the Epic 7 agent rewire, and before/after verification.**
The platform itself does zero LLM work; spend is attributable only to user-initiated
agent turns (one LLM call per turn). The rewire is meant to change the agent's *access
path* (OAuth app + SDK + public API), not its token volume, so the before/after token
count per agent turn should be unchanged. **Known gap:** Epic 7 is **not yet built**
(the agent in `api/src/routes/claude.ts` still makes direct service calls), so the
before/after measurement is a planned verification, not a completed one. Budget target
is a few dollars/week of Sonnet-class spend at demo activity.

**Daily CI-minutes ceiling.**
Today CI (`.github/workflows/pr-tests.yml`) runs only `pnpm run test` (api + web +
probe + sdk unit suites) on Postgres 16 — a few minutes per PR. The PRD wants the TTFE
drill and the OAuth Playwright flow added; budget for that is roughly +2–4 minutes/PR.
The TTFE drill is **now wired into CI** (the `ttfe-drill` job in `pr-tests.yml` runs
`pnpm drill ttfe` on every PR). **Known gap:** the OAuth Playwright flow is **not yet
wired into CI**.

**SDK install footprint budget and enforcement.**
Target is the PRD's < 250 KB gzipped, production deps only. The SDK
(`@ryanjagger/ship-sdk`) is deliberately dependency-light (Node crypto + fetch; no
heavy runtime deps). **Known gap:** there is **no CI size gate** yet
(`size-limit`/`bundlesize`); the budget is currently a manual commitment, and adding an
automated check is planned.

**Runaway webhook-deliverer cost ceiling.**
A subscriber that 5xx's forever is bounded by the retry schedule itself: 6 retries
(1s, 4s, 16s, 1m, 5m, 30m) then dead-letter — deliveries do **not** retry forever
(`webhooks/retry.ts`). A permanently broken subscriber costs at most 7 attempts per
event, then stops and lands in the DLQ. This caps runaway cost structurally rather than
via a separate budget mechanism.

### 1.3 — Timeline & Scope Reality

**Which epics are must-ship, and which reference integration.**
Must-ship and shipped: OAuth contract layer, public `/api/v1` boundary, webhooks,
SDK, and the **CLI** reference integration (`sdk/src/cli/` — `ship login`,
`docs ls/create`, `issues create`, `webhooks tail/replay`). The CLI is the recommended
must-ship and it is done. Epic 7 (agent rewire) is the highest-value remaining work
and is not yet started.

**Hours/day and day-by-day reality.**
A one-week sprint at full-time effort. The platform core (OAuth → boundary → error
shape → OpenAPI → webhooks → SDK → CLI → portal) landed across the week per the PRD
Build Strategy ordering; remaining days are reserved for Epic 7 and CI hardening.

**Developer-portal kill criterion.**
The portal (`web/src/pages/DeveloperPortal.tsx`) is should-ship. The minimum viable
version is a read-only delivery-log viewer plus shown-once secret on app creation; if
time ran short, manage-subscriptions and replay would be the first to cut. As built,
the full portal (apps, secret rotation, subscriptions, delivery log, replay, API-audit
tab) shipped.

### 1.4 — Security & Data Sensitivity

**Where `client_secret` lives at rest.**
Hashed with **bcrypt, cost factor 12** via `bcryptjs` (`api/src/platform/oauth/apps.ts`).
The raw secret is high-entropy random, shown **exactly once** on creation/rotation, and
is **never recoverable** — only the bcrypt hash is stored (`client_secret_hash`). bcrypt
is appropriate here because a secret is verified exactly once per token exchange, so a
slow hash is not a hot path. If an owner loses a secret, the recovery path is **rotation**
(`POST /api/admin/oauth-apps/:id/rotate-secret`), which issues a new secret and
invalidates the old hash.

**Token lifetimes and refresh policy.**
Access tokens are valid **1 hour** (`ACCESS_TOKEN_TTL_MS` in `oauth/tokens.ts`);
authorization codes are valid **10 minutes** and single-use (`oauth/codes.ts`). **We
deliberately do not implement refresh tokens or stolen-refresh-token family
invalidation.** Instead, tokens are short-lived and revocation is instant: every request
re-validates the token against `revoked_at` and live workspace membership, and deleting
an app cascades to its tokens. This is a defended tradeoff — it removes the complexity
and footgun surface of refresh-token rotation in exchange for re-authentication after an
hour, which is acceptable for a CLI + browser + first-party agent. (The PRD lists
refresh rotation as an optional drill; we chose the simpler, safer posture.)

**What goes in webhook payloads vs. fetched on demand.**
Payloads ship a Stripe-style **signed envelope** (`WebhookEnvelopeSchema` in
`webhooks/registry.ts`): `id`, `type`, `api_version`, `created`, `workspace_id`,
`actor_user_id`, `idempotency_key`, and `data.object` carrying the resource's
**identifiers + metadata** (plus `previous_attributes` on updates). `*.deleted` events
ship a minimal **tombstone** (`{ id, object, deleted: true }`). There are **no public
`document.*` events** and no raw `document_type` leakage. The tradeoff: subscribers get
enough to act and to fetch the full resource via the API under their own scopes, while
we minimize exposure surface in the payload itself. Sensitive directory data
(`person.*`) requires `people:read` with **no** `documents:read` fallback.

**Protecting the shown-once secret display from leakage.**
The portal reveals a new secret in a one-time modal and never re-fetches it (the API
only ever returns the bcrypt hash thereafter). Secrets are never logged: the public
audit logger (`api/src/platform/api/v1/audit/service.ts`) explicitly never records
bodies, bearer tokens, or client secrets. The leakage residual risk (screenshot /
shoulder-surf) is mitigated by the one-time, copy-once UX and the always-available
rotation path.

### 1.5 — Team Skill Inventory

**OAuth 2.0 — implemented or only consumed?**
Implemented end-to-end here: Authorization Code + PKCE (S256, timing-safe verify in
`oauth/pkce.ts`) and Device Authorization Grant (RFC 8628, `oauth/device-codes.ts`),
hand-rolled to IETF spec for learning rather than delegated to a library. The negative
case (wrong `code_verifier` → `400 invalid_grant`) is covered by
`oauth/__tests__/token-exchange.test.ts`.

**Zod and zod-to-openapi comfort.**
High. The OpenAPI 3.1 spec is generated in-process from Zod schemas via
`@asteasolutions/zod-to-openapi` (`api/src/platform/api/v1/openapi/spec.ts`) and
validated in `openapi/__tests__/spec.test.ts`. The fallback if generation broke late
would be the committed static copy at `docs/openapi.json`, regenerated via
`pnpm --filter @ship/api openapi:export`.

**SDK design experience.**
The SDK is hand-written for type quality and parity-tested against the spec (drift
fails CI via `sdk/src/contract.test.ts` + `manifest.ts`). Design choices (discriminated
error union, async-iterator pagination, pluggable `ITokenStore`) are informed by the
consuming side of less pleasant SDKs — the guiding principle is that the worst SDK bugs
surface when a real consumer (our own CLI) compiles against it.

---

## Phase 2: Architecture Discovery

### 2.1 — OAuth Flow Choices

**Refresh tokens from day one?** No — long-lived-enough (1h) access tokens with instant
revocation, no refresh (see 1.4). The "migration cost if you wait" is low because tokens
are already hashed and per-request-validated; adding refresh later is additive (a new
grant type + token family table) and does not break existing tokens.

**Scope upgrades / incremental consent.** A token carries exactly the scopes granted at
consent. Upgrading from `documents:read` to `documents:write` requires a fresh
authorization with the wider scope (re-consent), which the scope registry validates at
authorize time (`api/src/platform/api/v1/scopes/registry.ts`). We do not silently widen
an existing token.

**Where the consent screen lives, and clickjacking protection.** The consent screen is
an authenticated Ship page, `web/src/pages/OAuthConsent.tsx`, reached via
`GET /api/oauth/authorize`. It runs inside Ship's session (the user logs in if needed),
so it is protected by the same session-cookie posture as the rest of the app
(SameSite-strict session cookies), and the approval is a same-origin authenticated POST
rather than a cross-site embeddable action.

**Device Authorization Grant verification UX.** Users **paste a `user_code`** into a
form at `web/src/pages/DeviceVerify.tsx` (normalized `XXXX-XXXX`), then approve. RFC
8628 allows both paste and embed-in-URL; we chose paste for the explicit, phishing-
resistant confirmation step.

### 2.2 — Public API Shape

**Uniform error shape?** Yes — every `/api/v1` failure ships the exact same
`ApiError { code, message, details?, request_id }` (`api/src/platform/api/v1/errors.ts`),
asserted across all routes by `__tests__/api-error.fitness.test.ts`. `details` carries
route-specific context (e.g. `required_scope`, 401 `reason`) but the top-level shape is
invariant. The line is: shape is fixed, `details` is the only place richness lives.

**Field-level filtering / sparse fieldsets?** Skipped for the week — no `?fields=` or
`Prefer:` support. Defended: it adds spec/SDK surface and drift risk for no demo value;
responses are already lean (identifiers + metadata).

**Versioning policy past `/api/v1/`.** Additive-only within `v1`; breaking changes would
go to a future `/v2/`. This is documented in the architecture doc and the
grader-quickstart; the spec's `api_version` on webhooks (`2026-06-03`) is the parallel
mechanism for payload evolution.

**Cursor pagination everywhere, or skip small lists?** List resource endpoints return
`{ data, next_cursor }` with opaque base64 keyset cursors over `(created_at, id)`
(`api/src/platform/api/v1/cursor.ts`). Truly static/singleton responses (`/me`, the
spec itself) are not lists and carry no cursor. The fitness test knows a route is a list
by its response schema declaring `data` + `next_cursor`.

### 2.3 — Webhook Reliability

**What exactly is signed?** The HMAC-SHA256 input is **`<timestamp>.<raw-json-body>`**
(byte-exact), keyed by the subscription signing secret, emitted as
`Ship-Signature: t=<unix>,v1=<hex>` (`api/src/platform/webhooks/signing.ts`, mirrored in
`sdk/src/webhooks.ts`). Signing the timestamp alongside the body is what makes the
anti-replay window enforceable: a captured body can't be re-presented with a fresh
timestamp without invalidating `v1`.

**Retry schedule and how it's tested without sleeping.** 1s, 4s, 16s, 1m, 5m, 30m with
±10% jitter (`webhooks/retry.ts`). Tests use **deterministic clock / injected time**,
not `setTimeout` waits, so they assert the computed `next_attempt_at` deltas without
flaking (`webhooks/__tests__/retry.test.ts`, `dispatcher.test.ts`).

**Permanent vs transient classification.** 2xx = success; **4xx = permanent** (no
retry, straight to DLQ); **5xx / timeout / network error = transient** (retried). This
is the documented contract; it is deliberately simple (not per-status nuance like
410-vs-429) for the week, and is centralized in the classifier so it can be refined
later in one place.

**`Idempotency-Key` flow and subscriber dedupe contract.** Every event carries an
`idempotency_key` in the envelope. Replay (`POST /api/v1/webhook-deliveries/:id/replay`)
re-emits the **same** event with the **same** `idempotency_key`, linked via
`replay_of_delivery_id`. The documented subscriber contract is: dedupe on
`idempotency_key` — a replay is byte-identical in identity to the original, so a correct
subscriber processes it at most once.

### 2.4 — SDK Design

**Generated or hand-written?** Hand-written for type quality, **parity-tested** against
the spec so drift fails CI (`sdk/src/contract.test.ts` walks `docs/openapi.json` and
asserts every operation has an SDK method via `manifest.ts`; `contract-types.ts` does
type-level assignability checks). This trades a little manual upkeep for far better
ergonomics than generated clients.

**Error model.** Typed **discriminated union**:
`{ kind: 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server', ... }`
(`sdk/src/index.ts`), normalized from API errors, network failures, and parse failures
via `toShipSDKError()`. Consumers `switch (err.kind)` exhaustively — the most
TypeScript-native model.

**Pagination.** Async-iterators (`for await (const doc of client.documents.iterate())`)
that hide cursors entirely, plus a lower-level `list()` returning `{ data, next_cursor }`
for consumers who want manual control. Both, with iterators as the clean default.

**`ITokenStore` contract.** Pluggable with three implementations — `MemoryTokenStore`,
`FileTokenStore` (`~/.ship/`, 0600 perms), `LocalStorageTokenStore`
(`sdk/src/auth/token-store.ts`). Because there are no refresh tokens, the store persists
only the access token (+ expiry), which sidesteps the concurrent-refresh threading
problem entirely — there is no refresh race to manage.

### 2.5 — Developer Portal & Self-Service

**Reuse the public API or privileged internal endpoint?** The portal is a first-party
Ship UI backed by `api/src/routes/developer.ts` (session-authenticated, same-origin) —
it does not consume the public OAuth `/api/v1` surface with a bearer token; it is the
admin/owner surface. This is the pragmatic split: external clients use `/api/v1` with
OAuth; the owner manages their own apps through an authenticated first-party route.

**Secret rotation model.** Rotation immediately invalidates the old secret (the old
bcrypt hash is replaced) and shows the new one once — no grace-period dual-secret window.
Stripe supports a roll-with-expiry; we chose immediate invalidation for simplicity and a
smaller live-secret surface, accepting that the owner must update their client promptly.

**Delivery-log view scaling.** Server-side filtering + pagination by subscription,
event type, and status (`api/src/platform/api/v1/routes/webhook-deliveries.ts`,
`audit/service.ts`), which is build-cheap and scales; a virtualized list is a cheap
future add on top. Time-bucket filters would be the next increment.

**Payloads in full, redacted, or click-to-reveal?** Click-to-reveal in the delivery
detail view, consistent with the 1.4 leakage posture — the log lists metadata by
default, and the full payload is revealed only on explicit interaction.

### 2.6 — Agent-as-Citizen Rewire

> **This epic is NOT yet built.** The answers below are the intended design.

**Which OAuth flow for the agent?** Client-credentials-style first-party machine auth:
the agent is a seeded first-party OAuth app with a confidential `client_secret`, not a
device/auth-code flow (no human in the loop per turn). It authenticates as itself and
acts on behalf of the invoking user/workspace.

**How the agent's app is seeded.** Via the seed layer (alongside the grader app) so it
exists deterministically in every environment, including deployed ones — the same
idempotent-seed approach as `db:seed:grader`.

**Which scopes, and the defense.** The narrowest set the agent's actions require —
read scopes for the resources it inspects, and write scopes only for the resources it is
explicitly allowed to mutate (e.g. `issues:write`). The defense is least-privilege:
prefer read + a recommendation pattern where possible, granting write only where the
agent genuinely creates/updates on the user's behalf.

**Proving Part 2's tests pass with the flag on and off.** The rewire sits behind a
feature flag toggling direct-service-calls vs. SDK-through-public-API. CI would run the
Part 2 agent test suite **twice** — flag off (legacy path) and flag on (SDK path) — and
require both green, proving behavioral equivalence.

---

## Phase 3: Post-Stack Refinement

### 3.1 — Security & Failure Modes

**OAuth app owner deleted.** Apps are owned by `owner_user_id`; the recovery story is
deactivation (the app stops working) rather than silent orphaning, with admin able to
force-delete (which cascades to tokens and instantly revokes access).

**Webhook deliverer crashes mid-batch.** **At-least-once** delivery. Events and their
deliveries are written in the same transaction as the resource write (transactional
outbox, migration 054), so nothing is lost on crash and nothing is emitted for a
rolled-back write. On restart the 30s cron re-claims due deliveries with
`FOR UPDATE SKIP LOCKED` and a retry lease, so a crash mid-batch resumes safely.
Subscribers dedupe on `idempotency_key`.

**Leaked `client_secret` detection/response.** Owner-driven rotation is the primary path
(invalidates the old hash immediately); admins can force-rotate. The audit signal worth
alerting on is anomalous `client_id` usage in `public_api_audit_logs` (new IPs, scope
patterns, error spikes). Automatic rotation is not implemented this week.

**CSRF on portal app-form and rotate-secret.** The portal endpoints
(`api/src/routes/developer.ts`) are session-authenticated and same-origin; Ship's
session cookies are SameSite-strict (the project's session-cookie hardening standard),
which is the primary CSRF defense for these state-changing forms.

### 3.2 — Testing Strategy

**How the TTFE drill is written.** A real `pnpm install` of the packed SDK tarball into
a clean working dir, then the full loop (login → subscribe → create → receive → verify)
with per-stage timing (`drill/results/ttfe.json` shows the packed
`ryanjagger-ship-sdk-0.1.0-rc.5.tgz` install + 6 instrumented stages). A real install
proves more than a workspace symlink because it catches packaging/peer-dep problems.
The drill harness is **committed** (the `drill/` workspace package with `package.json`
and the `pnpm drill` script) and **wired into CI** (the `ttfe-drill` job in
`pr-tests.yml` runs it on every PR and uploads `drill/results/ttfe.json`).

**OAuth Playwright stability.** No external IdP — Ship is its own authorization server,
so the auth-code Playwright flow drives Ship's own consent screen against a containerized
Postgres, with no third-party IdP to stub. This keeps CI minutes low and removes external
flakiness. **Known gap:** this Playwright flow is **not yet in the PR CI workflow.**

**Retry-schedule testing without sleeping.** Deterministic clock injection — tests assert
computed `next_attempt_at` deltas, never wall-clock waits (`webhooks/__tests__/retry.test.ts`,
`dispatcher.test.ts`).

### 3.3 — Tooling & CI

**Boundary lint rules.** ESLint `no-restricted-imports` (error, not warn) forbids
`api/src/platform/**` from importing internal route handlers (`eslint.config.mjs`), and
external integrations must depend only on `@ryanjagger/ship-sdk`. **Known gap:**
`pnpm lint` is **not yet a CI step**, so the boundary is currently enforced locally /
in review rather than gated in CI — adding it is planned.

**OpenAPI fitness test wiring.** Spec↔route parity and 3.1 schema validation run in the
api unit suite (`openapi/__tests__/spec.test.ts`) and the SDK contract suite, which run
under `pnpm run test` in CI today — so drift **fails the build**. Additive changes pass
as long as every route still has a spec entry and every operation still has an SDK method.

**+10% performance regression budget.** Captured in
[`regression-gate-results.md`](./regression-gate-results.md) as a measured baseline
comparison (P95, bundle size, per-route query counts vs. the Part 1 baseline). **Known
gap:** this is currently a recorded manual gate, **not an automated CI perf job** that
fails the PR — automating it is planned.

### 3.4 — Deployment & Hosting

**Where the deployed instance lives and grader app provisioning.** Ship deploys to a
public origin (`SHIP_URL`); the grader gets a pre-registered, read-only
(`documents:read`) OAuth app seeded idempotently via
`pnpm --filter @ship/api db:seed:grader` (`grader-quickstart.md`), with throwaway
credentials and a dedicated grader login — so graders never touch real tenant data.

**OpenAPI served live and/or statically.** Both: live at `/api/v1/openapi.json` on the
deployed instance (`api/src/platform/api/v1/router.ts`), plus a committed static copy at
[`../openapi.json`](../openapi.json).

**One-command grader setup against the deployed instance.** Documented in
`grader-quickstart.md`: export `SHIP_URL`, `pnpm install @ryanjagger/ship-sdk`, then
either the curl PKCE walkthrough or the SDK snippet. The grader app credentials live in
that doc.

### 3.5 — Observability of API Usage

**Per-call metrics recorded.** Every `/api/v1` call records timestamp, `client_id`,
`app_id`, `token_id`, `user_id`, `workspace_id`, method, **route template** (not raw
URL), matched scope, status, `latency_ms`, `request_id`, IP, and user-agent — never
bodies or secrets (`api/src/platform/api/v1/audit/service.ts`, migration 058). Surfaced
in the portal's API-audit tab.

**Proving the agent went through the public API.** Once Epic 7 ships: query
`public_api_audit_logs` for rows whose `client_id` equals the agent's OAuth app — every
agent action should appear there with its scope and status. A fitness test that runs an
agent turn and asserts the audit trail is the rigorous version. **Until then this is a
planned check, not a passing one.**

**`Idempotency-Key` reuse vs. fresh keys in the delivery log.** Replays reuse the
original `idempotency_key` and are linked via `replay_of_delivery_id`, so the delivery
log distinguishes an original from its replays — you can tell from the portal alone
whether a subscriber received a duplicate key (and thus whether its dedupe should have
fired).

---

## Summary of explicitly-flagged gaps

These are stated as gaps above rather than claimed as done:

- **Epic 7 agent-as-citizen rewire** — not yet built (intended design documented in 2.6).
- **`pnpm lint` (boundary rule) in CI** — enforced locally, not yet a CI gate (3.3).
- **Automated perf-regression CI job** — baseline recorded manually, not auto-gated (3.3).
- **SDK bundle-size CI check** — budget is a manual commitment, no size gate (1.2).
- **Delivery-log / audit-log retention job** — no automated cleanup yet (1.1).
- **`sprint.started`/`sprint.completed`/`project.completed`** — registered but
  `emitted: false` (read-time-inferred, deferred).
- **Refresh tokens** — intentionally omitted in favor of short-lived tokens + instant
  revocation (defended in 1.4 / 2.1).
