# Plugforge — Per-Epic Write-up

Before → fix → after → proof for each item in the PRD build strategy (`docs/plugforge/plugforge-prd.md` §Build Strategy). All work landed on `develop` over the past week (May 30 – Jun 6, 2026). Epic mapping: item 1 = E1, items 2–3 = E2, item 4 = E3, item 5 = E4, item 6 = E5, item 7 = E6, item 8 = E7.

---

## 1. OAuth foundation first (E1)

**Before.** Ship had exactly one way in: session cookies with a 15-minute inactivity timeout, minted by the login form. No tokens, no scopes, no consent, no path for any client that isn't the Ship web app. Nothing downstream (SDK, CLI, webhooks, portal) had a contract to build against.

**Fix.** Built a full OAuth 2.0 authorization server under `api/src/platform/oauth/`:

- **Authorization Code + PKCE** (`routes.ts`, `pkce.ts`, `codes.ts`): `/api/oauth/authorize` → consent screen (commit `c19eb36`) → `/api/oauth/token`. PKCE is S256-only — `plain` is explicitly rejected (`pkce.ts:25`) — with timing-safe comparison. Public (secret-less) PKCE clients supported (`d0ec2b4`), with CORS allowed per registered origin (`135847d`).
- **Device Authorization Grant** (RFC 8628, commit `18db9b8`): `device-codes.ts` state machine (issuance → approve/deny → single-use consumption), `/device` approval page in the web app (`45945a7`), `slow_down`/`authorization_pending` polling semantics. Device flow is opt-in per client via `allow_device_flow` (migration 052, `c07177c`) so secret-less polling can't be turned on against arbitrary apps.
- **Rotating refresh tokens** with family-based revocation (`tokens.ts`), `offline_access` scope-gated.
- **First-party system clients** (`is_system`, migration 053, `29dcce8`): `client_ship_cli` is seeded by migration and protected from deletion/secret rotation (409 in the admin API).
- Scope grammar + validation (`authorize-request.ts`, scope registry at `api/src/platform/api/v1/scopes/registry.ts`), enforced downstream by `requireScope()` in the bearer middleware.

**After.** Three grant types (auth code + PKCE, device code, refresh) issuing scope-bounded 15-minute bearer tokens; consent and device-approval UIs; an admin surface to create/rotate/revoke apps (`039f136`, later merged into the portal). Every later epic authenticates through this layer — including, by the end of the week, Ship's own agent.

**Proof.**
- ~53 unit tests across `api/src/platform/oauth/__tests__/` (token-exchange 13, apps 13, device-codes 8, device-flow 10, public-cors 5).
- Negative path, day one as planned: `rejects a wrong code_verifier with 400 invalid_grant` (`token-exchange.test.ts:147`).
- Playwright-driven E2E, both grants end-to-end against a real browser:
  - `e2e/oauth-pkce.spec.ts` — `full flow: consent → token → scoped API access`, which *also* attempts the exchange with a wrong verifier mid-flow (lines 76–87, expects `invalid_grant`) and asserts a scope-denied write returns 403.
  - `e2e/device-flow.spec.ts` — `approve at /device → poll token → Platform API access` and `deny at /device → poll returns access_denied`.
- All green in CI (`pnpm run test` job on `develop`, run 27081489472).

---

## 2. Public/internal API boundary on Day 1 (E2)

**Before.** One Express app where every route shared the same middleware stack: session parsing, CSRF, fixed-origin CORS, legacy `{ error: string }` bodies. Any "public API" grown out of that stack would inherit session coupling forever.

**Fix.** `/api/v1` is a fresh router (`api/src/platform/api/v1/router.ts:34`) mounted separately in `app.ts` (lines 213, 293) sharing **no** middleware with the internal API — and the lint rule that forbids cross-imports landed before there was anything to violate it:

| | Internal `/api/*` | Public `/api/v1` |
|---|---|---|
| Auth | Session cookie + CSRF | Bearer token (`middleware/bearer.ts`) |
| CORS | Fixed env-configured origins | Dynamic, from registered public clients' origins |
| Rate limiting | Global `/api/` limiter | Dual-bucket per-token + per-app (E5 work) |
| Errors | Legacy `{ error: string }` | `ApiError` envelope |
| Route files | `api/src/routes/*` | `api/src/platform/api/v1/routes/*` |

The boundary is enforced mechanically: `eslint.config.mjs:107–127` applies `no-restricted-imports` at **error** severity to all of `api/src/platform/**`, blocking any import that climbs out of the platform tree into `api/src/routes/**` (patterns `../**/routes/*`, `../**/routes/**`), while still allowing the platform's own `./routes/*`. The public layer reaches the shared db/services layer directly — never an internal route handler (rationale documented at `router.ts:25–29`, PRD §5.1).

**After.** The boundary held for the whole week with zero retrofits: every later addition (typed resources, webhooks routes, audit, rate limits) was forced onto the platform side by construction. When Epic 7 needed write parity, the fix was to re-platform both paths onto shared service cores — not to let v1 import the internal handler.

**Proof.** The rule itself (`eslint.config.mjs:107–127`, severity `error` — build-failing via `pnpm lint` and pre-commit), and the absence of a single cross-import in `api/src/platform/**` after a week of growth to 42 public paths.

---

## 3. Error shape and `ApiError` before any resource endpoint (E2)

**Before.** Internal API failures were ad-hoc: different shapes per route, no request correlation, internals occasionally leaking through unhandled throws. A public API that inherits that teaches every consumer a different error per endpoint.

**Fix.** Commit `2062b46` shipped the error contract *with* the first endpoint, not after it:

- `ApiError` envelope — `{ code, message, details?, request_id }` with 7 codes (`unauthorized`, `forbidden`, `not_found`, `validation_failed`, `conflict`, `rate_limited`, `server_error`) — `api/src/platform/api/v1/errors.ts:1–94`.
- `ApiErrorException` (`errors.ts:77–93`) so handlers throw instead of threading `res` through call stacks.
- Central terminators registered last on the router (`router.ts:71–72`): `errorHandler` maps exceptions to the envelope and converts anything unhandled to a generic `server_error` (logged with `request_id`, no internals leaked); `notFoundHandler` makes even unmatched v1 paths return the shape (`error-middleware.ts:9–32`).
- The 429 path emits `ApiError` on `/api/v1` while legacy `/api/*` keeps its old body — the boundary applies to errors too.

**After.** Every `/api/v1` failure — auth, validation, 404, conflict, rate-limit, crash — ships the identical envelope with a `request_id` that correlates to the audit log. The SDK's typed error union (E5) is a direct projection of these 7 codes.

**Proof.** The fitness test the PRD called for: `api/src/platform/api/v1/__tests__/api-error.fitness.test.ts` enumerates v1 routes and asserts the shape on every failure path — parameterized unauthenticated-failure tests per route, an unmatched-route 404 test, and forced-429 tests proving v1 gets `ApiError` while non-v1 keeps the legacy body. **7/7 passing** locally and in CI.

---

## 4. OpenAPI generated from route metadata, never hand-written (E3)

**Before.** No spec. The naive alternative — a hand-written `openapi.yaml` — drifts the day after it's written, and an SDK generated from a drifted spec compiles against an API that doesn't exist.

**Fix.** The spec is generated from the same Zod schemas the routes validate with, via `@asteasolutions/zod-to-openapi` (`api/src/platform/api/v1/openapi/spec.ts`, 739 lines; `buildRegistry()` registers every path + schema). Started with one resource (documents + `/me`) per the plan, then the typed-document resources were added as a *loop over a metadata table* (`TYPED_DOCUMENT_RESOURCES`, `spec.ts:130–230`) — adding a resource adds its spec by construction. Served publicly at `GET /api/v1/openapi.json` (`router.ts:44–46`); a static copy is exported to `docs/openapi.json` via `pnpm openapi:export`.

Drift is guarded at three layers (commit `96fc9ed`):
1. **Spec ↔ routes**: `openapi/__tests__/spec.test.ts` validates against the OpenAPI 3.1 meta-schema, enumerates the full expected path set, asserts the endpoint serves it, and asserts the committed static copy matches the generator output.
2. **Spec ↔ SDK surface**: `sdk/src/__tests__/contract.test.ts` walks every `(method, path)` operation in `docs/openapi.json` and fails if the SDK's `OPERATION_MANIFEST` (`sdk/src/manifest.ts`) misses one — or carries a stale one.
3. **Spec ↔ SDK types**: `sdk/src/contract-types.ts` holds 11 compile-time `AssertMutual` checks pinning hand-written interfaces to the generated `openapi-types.ts` (4,927 generated lines); `tsc` fails on drift.

**After.** 42 paths across 11 typed-document resources plus documents, `/me`, comments, document-history, webhooks/deliveries, and the admin surfaces (scopes/apps/connections/audit) — all described by one generator, consumed by one generated-types pipeline.

**Proof.** Spec fitness **4/4 passing**; SDK contract gate **3/3 passing**; type guards enforced by `pnpm type-check`. All run in CI on every PR.

---

## 5. Webhooks end-to-end on Day 4 (E4)

**Before.** No outbound events at all. An integration platform where the only way to learn something changed is to poll.

**Fix.** All seven slices, each small, all under `api/src/platform/webhooks/` (headline commit `d8dc135`):

| Slice | File | Notes |
|---|---|---|
| Event registry | `registry.ts` | `buildRegistry()` / `allEventTypes()` — the typed catalog |
| Event bus | `event-bus.ts` | `InProcessEventBus.publish()` with visibility-scoped fan-out |
| Subscriptions | `subscriptions.ts` + v1 routes | CRUD in `webhook_subscriptions` (migration 054) |
| Signer | `signing.ts` | HMAC-SHA256 over `<timestamp>.<rawBody>`, header `Ship-Signature: t=<unix>,v1=<hex>` (Stripe-style), `timingSafeEqual`, 300s default tolerance |
| Queue deliverer | `dispatcher.ts` | `deliverOne()` signs + POSTs; 2xx → delivered, 4xx → permanent, 5xx/timeout → retry |
| Delivery log | `deliveries.ts` | `webhook_deliveries` + per-attempt rows, `claimDueDeliveries()`, dead-lettering |
| Replay | v1 `webhook-deliveries.ts:65` | `POST /api/v1/webhook-deliveries/:id/replay` → 202 |

Retry policy (`retry.ts`): 1s → 4s → 16s → 1m → 5m → 30m, ±10% jitter, 7 total attempts, then DLQ. Post-merge hardening: visibility leak + SSRF both fixed at P1 (`6e12270`); publishing moved into the domain layer so internal and v1 writes emit identically (`154b465`).

**After.** Subscribe → mutate → receive a signed POST → verify with the SDK → replay from the log. This is the exact pipeline the TTFE drill (E6) exercises and the CLI tails.

**Proof.** The signer has its own suite exactly as specified — positive, negative, replay, tamper: `__tests__/signing.test.ts`, **8 tests** (`verifies a valid signature (positive)`, `rejects a wrong secret`, `rejects a malformed header`, `rejects a stale timestamp (replay)`, `rejects a tampered payload`, `rejects re-serialized (whitespace-differing) raw body`, `honors a configurable tolerance`, `parses t/v1 order-independently`). **42 webhook infrastructure tests** total across signing/crypto/dispatcher/event-bus/events/retry/integration. Emission coverage is audited in `docs/plugforge/webhook-coverage-audit.md` (gaps are deliberate, per PRD non-goals).

---

## 6. SDK skeleton + one resource client + auth helpers (E5)

**Before.** No client library — every consumer (CLI, portal, drill, eventually the agent) would hand-roll fetch, auth, pagination, and error handling, each slightly differently.

**Fix.** `@ryanjagger/ship-sdk`, published to npm (`0.1.0-rc.0` → `0.1.0` → `0.2.0`), built strictly outside-in: the CLI consumed it as it grew, exactly as planned, and consumer pressure surfaced the real bugs (`6845861` invalid `--interval` accepted, `b665d47` CLI scopes missing from the e2e seed, the rc.3 release existing solely to ship `verifyWebhook` to the drill).

- **17 resource clients** on `ShipClient` — documents, documentHistory, 10 typed-document resources, webhooks, scopes, apps, connections, audit.
- **Auth helpers** (`528d04a`): `deviceLogin()` (RFC 8628 with `authorization_pending`/`slow_down` handling), `authorizationCodeFlow()` (loopback/browser/custom redirect adapters), `refreshAccessToken()`; pluggable `ITokenStore` (memory / file at `~/.ship/credentials.json` mode 0600 / localStorage).
- **Typed error union**: 6-variant discriminated `ShipSDKError` (`auth | rate_limit | not_found | validation | conflict | server`) — a projection of the E2 `ApiError` codes; `toShipSDKError()` normalizes even network failures into it.
- **`verifyWebhook(headers, rawBody, secret)`** mirroring the server signer, constant-time, 300s tolerance.
- **`iterate()`** async-generator pagination on every list client.
- **0.2.0** (`913ce40`, for the agent rewire): comments, document history, list filters, the `conflict` error member (minor bump + release note for exhaustive switches).

**After.** Four real consumers compile against it — CLI, TTFE drill, Developer Portal, and the Fleet agent — all through the same npm artifact the drill installs from a packed tarball.

**Proof.** **44 SDK tests** (auth flows, token stores, error mapping, webhook verification, pagination, admin clients) driven through an injected `fetch` — no live server; the contract drift gate (3/3) pins it to the spec; npm carries the three published versions; and every downstream epic's green proof is transitively this epic's proof.

---

## 7. CLI reference integration — must-ship (Epic 6)

**Before.** No way to demonstrate the platform working for someone who isn't Ship. "It has OAuth and webhooks" is a claim; a stranger's terminal receiving a signed event is evidence.

**Fix.** The `ship` CLI ships inside the SDK package (`bin: ship → dist/cli/index.js`), 100% SDK-mediated — no raw HTTP anywhere in `sdk/src/cli/`:

- `ship login` — device flow via `ShipClient.deviceLogin()`; prints the user code, opens the browser (respecting `SHIP_NO_BROWSER`/`CI`), polls per RFC 8628, persists credentials to `~/.ship/credentials.json`.
- `ship docs create --title "..."` + full typed-resource commands (issues, projects, sprints, wiki, people, standups, weekly-*) — writes through the SDK and the public API.
- `ship webhooks list|create|delete|tail|replay` — `tail` polls the delivery log (default 3s, validated `--interval`), dedupes seen deliveries, and streams fresh ones oldest-first: the demo moment.

And the proof harness itself: the **Time-to-First-Event drill** (`2110712`, CI-wired in `5b07d26`). `pnpm drill ttfe` (`drill/src/ttfe.ts`) runs the five-line developer story against a freshly built API with per-stage budgets (`drill/src/thresholds.ts`): **install** (pack + install the SDK tarball in a clean dir + type-check a snippet, 45s) → **login** (device flow, 10s) → **subscribe** (5s) → **trigger** (`issues.create`, 5s) → **receive** (signed POST to a local listener, 8s) → **verify** (1s — valid signature passes *and* tampered body, expired timestamp, and missing `v1` all fail). 60s total budget.

**After.** A developer with the published tarball and docs goes from `pnpm install @ryanjagger/ship-sdk` to a verified `issue.created` event in their terminal — and CI proves that story on every PR.

**Proof — the TTFE drill passing in CI.** Job `pnpm drill ttfe` in `.github/workflows/pr-tests.yml:71–131` is **green on the latest `develop` run** (run 27081489472, 2026-06-07; also green on both `feature/fleet-agent-rewire` runs and every branch run that day). Results artifact (`drill/results/ttfe.json`, uploaded per run):

```json
{ "drill": "ttfe", "passed": true, "totalMs": 853, "totalLimitMs": 60000,
  "stages": [
    { "stage": "install",   "ms": 752, "limitMs": 45000, "ok": true, "note": "installed ryanjagger-ship-sdk-0.2.0.tgz, types OK" },
    { "stage": "login",     "ms": 54,  "limitMs": 10000, "ok": true },
    { "stage": "subscribe", "ms": 11,  "limitMs": 5000,  "ok": true },
    { "stage": "trigger",   "ms": 35,  "limitMs": 5000,  "ok": true },
    { "stage": "receive",   "ms": 0,   "limitMs": 8000,  "ok": true },
    { "stage": "verify",    "ms": 0,   "limitMs": 1000,  "ok": true, "note": "event=issue.created issue=fda939b1-..." }
  ] }
```

**853ms against a 60,000ms budget**, every stage within its individual limit, signature verification including all three negative cases.

---

## 8. Developer portal + agent rewire (Epic 7)

**Before.** Two privileged insiders. The Developer Portal hit internal `/api/developer/*` endpoints — session-cookie auth, no scopes, no rate limits, invisible to the audit trail. The Fleet agent was worse: direct SQL with an admin visibility bypass, its capabilities defined by whatever code it could reach rather than any declared contract.

**Fix.**

*Portal* (`fd24342`, `1983e2b`, `db91e6b`; design in [`dev-portal-rewire.md`](./dev-portal-rewire.md)): the portal is now an OAuth client of its own platform — `client_ship_developer_portal` (migration 061, public client, scopes `apps:manage connections:manage audit:read`, no redirect URIs). `web/src/lib/portal-client.ts` mints a 15-minute token via `POST /api/developer/token` (session-bootstrapped, the one piece that stays internal), caches it keyed `${userId}:${workspaceId}` (`0add3f9` — user-scoped so a logout/login as someone else can't ride the old token), and drives every tab (apps, connections, webhooks, deliveries, audit) through `ShipClient`. The audit tab excludes the portal's own client_id to avoid watching itself.

*Agent rewire* (PR #96, closes #95): every Fleet **domain** read/write now travels `/api/v1` through the SDK as `client_ship_fleet_agent` (migration 062 — public system client with 11 scopes; non-login `fleet@ship.system` service user for the scheduled sweep). The transport (`api/src/services/fleetgraph/api-client.ts`) mints in-process via `issueAccessToken()` but sends requests over **loopback HTTP**, so bearer auth, scope checks, rate limits, and the audit trail all genuinely execute. Token cache keyed `${userId}:${workspaceId}`, never widened (PR #94 P1 invariant). Read tools, write tools (proposal → human confirm → execute, with content-hash tamper check), plan-review signals, and the drift sweep all swapped (`4678dc4`, `95034bf`, `03bba4a`, `b502b6c`). Agent machinery (LLM calls, checkpoints, caches, locks) deliberately stays internal per the #95 boundary rule.

**After.** The agent stopped being a privileged insider and became a platform citizen: its capabilities ARE its app's scopes, its reads carry the acting user's visibility (no admin bypass), and every call it makes is indistinguishable in the audit log from a third-party developer's. Verification on the PR: api **1078/1078**, full E2E **873 passed / 0 failed**.

**Proof — the agent's audit-log rows showing OAuth app authentication.** `public_api_audit_logs` (migration 058; written by `beginAudit()` on `res.finish`, no bodies or tokens ever recorded) on the dev database after an agent session, filtered to the agent's client:

```
          created_at           |        client_id        | method |             route              |     scope      | status | latency_ms
-------------------------------+-------------------------+--------+--------------------------------+----------------+--------+-----------
 2026-06-06 22:21:04.265989-05 | client_ship_fleet_agent | GET    | /api/v1/document-history       | documents:read |    200 |          5
 2026-06-06 22:21:04.258119-05 | client_ship_fleet_agent | GET    | /api/v1/issues                 | issues:read    |    200 |          7
 2026-06-06 22:21:04.249001-05 | client_ship_fleet_agent | GET    | /api/v1/documents/:id/comments | comments:read  |    200 |          3
 2026-06-06 22:21:04.243476-05 | client_ship_fleet_agent | GET    | /api/v1/standups               | standups:read  |    200 |          6
 2026-06-06 22:21:04.240263-05 | client_ship_fleet_agent | GET    | /api/v1/sprints                | sprints:read   |    200 |          7
 2026-06-06 22:21:04.226424-05 | client_ship_fleet_agent | GET    | /api/v1/people                 | people:read    |    200 |          9
 2026-06-06 22:21:04.22333-05  | client_ship_fleet_agent | GET    | /api/v1/projects/:id           | projects:read  |    200 |          6
 2026-06-06 22:21:04.213964-05 | client_ship_fleet_agent | GET    | /api/v1/documents/:id          | documents:read |    200 |          3
```

36 rows total for `client_ship_fleet_agent` across 10 distinct route/scope pairs — including a confirmed write: `PATCH /api/v1/projects/:id`, scope `projects:write`, status 200 (the retro-apply noted in PR #96's manual verification, visible through the portal's audit tab). The same assertion is locked in CI: `api/src/services/fleetgraph/tools/write.test.ts:278` — *"an executed write lands in public_api_audit_logs under the fleet client_id"* — expects `client_id = 'client_ship_fleet_agent'`, route containing `/issues`, status 201.
