# Plugforge MVP — Product Requirements

**Scope:** The Tuesday 11:59 PM CT hard gate, nothing past it.
**Repo:** `ryanjagger/ship` (pnpm monorepo — `web/`, `api/`, `shared/`)
**Status:** Draft for the Monday architectural defense.

---

## 1. What we're building

Ship is a collaborative doc/issue platform with an internal API at `/api/` and an
existing OpenAPI 3.0 spec at `/api/openapi.json`. The MVP adds the smallest real
*public* contract a stranger could build on: a versioned API at `/api/v1/`, OAuth 2.0
Authorization Code + PKCE, one fully-contracted resource (`documents`), a generated
OpenAPI 3.1 spec, and an SDK skeleton that can authenticate against a live server.

The MVP is not the platform. It's the spine: tokens, scopes, a public/internal boundary,
one resource done correctly, and a spec that can't drift from the routes. Everything else
in the full brief (webhooks, device flow, refresh rotation, rate limiting, dev portal, CLI,
agent rewire) builds on this spine later in the week — but is **explicitly out of scope for
the gate**.

## 2. Definition of done

A grader, given only the deployed URL and the README, can:

1. Read the public spec at `/api/v1/openapi.json` and have it validate as OpenAPI 3.1.
2. Use a pre-registered read-only OAuth app to complete Auth Code + PKCE and get a token.
3. Call `GET /api/v1/documents` and `GET /api/v1/documents/:id` with that token and get data
   back; call `POST /api/v1/documents` and get a **403 naming `documents:write`** — the
   read-only token is denied, proving scope enforcement live.
4. Call `GET /api/v1/me` with the token (no scope required) and get a typed user + workspace.
5. See the consistent `ApiError` shape on every failure, with the missing scope named on the 403.
6. `new ShipClient({ token }).me()` returns the typed authenticated user (hitting `/api/v1/me`).

…and the existing Playwright suite still passes on `main` within the +10% perf budget.

## 3. In scope (the 10 gate items)

| # | Item | Acceptance |
|---|------|-----------|
| 1 | OAuth app registration | Admin creates an app, gets `client_id` + raw `client_secret` **shown once**; secret stored hashed. |
| 2 | Auth Code + PKCE, end-to-end | Playwright drives `/oauth/authorize` → consent → `/oauth/token` to a usable token. Wrong `code_verifier` → `400 invalid_grant` (negative test mandatory). |
| 3 | Bearer token middleware | Guards every `/api/v1/*` route. Invalid → 401, missing → 401, expired → 401 with a **distinct** error code. |
| 4 | `documents` resource | `GET` list, `GET` by id, `POST`. Each route declares its scope via a `require(scope)` factory. |
| 4b | `GET /api/v1/me` | Requires a valid token but **no scope**. Returns a small public user shape + current workspace in the public contract style (not the internal `success/data` envelope). |
| 5 | Consistent `ApiError` | `{ code, message, details?, request_id }` on every public failure, **including 429 from the existing limiter** (see §5.6). Fitness test asserts it across all `/api/v1` routes. |
| 6 | `ScopeRegistry` | Scopes-as-data. Insufficient scope → 403 naming the missing scope explicitly (no opaque "forbidden"). |
| 7 | OpenAPI 3.1 | Served at `/api/v1/openapi.json`, **generated from route metadata** (never hand-written), validated against the OpenAPI schema in a unit test. |
| 8 | SDK skeleton | `@ship/sdk` workspace package; `new ShipClient({ token }).me()` returns the typed authed user. Workspace + Railway Docker build stay green (see §5.8). |
| 9 | Regression intact | Existing Playwright suite passes on `main`; P95 latency, bundle size, per-route query counts within +10% of the Part 1 baseline. |
| 10 | Deployed + grader access | Deployed Ship + public spec URL + ≥1 pre-registered OAuth app with read-only scopes, credentials in README. |

## 4. Explicitly out of scope for the gate

Do not build these before Tuesday, even if they're tempting:

- Device Authorization Grant (`/oauth/device/*`) — Wednesday, with the CLI.
- Refresh tokens and stolen-token family invalidation — long-lived access tokens are fine for the MVP.
- Webhooks — event registry, signing, retries, DLQ, replay. None of it.
- *New* rate limiting (token-bucket, per-app/per-token, `X-RateLimit-*` headers). Note: the
  app's **existing** global `express-rate-limit` still applies to `/api/v1/*` and must be made
  to emit `ApiError` on that prefix — see §5.6. We add no new limiter.
- Cursor pagination beyond the minimal `{ data, next_cursor }` envelope (see §5.5).
- Developer portal UI. Registration can be an admin endpoint + seed script for now.
- CLI, Slack, GitHub integrations.
- Agent-as-citizen rewire (Epic 7).
- Typed endpoints (`/api/v1/issues`, `/api/v1/sprints`, `/api/v1/wiki`) — `documents` is the
  only resource for the gate, and it already returns every type (see §5.5).

If a task isn't in the §3 table, it doesn't ship Tuesday.

## 5. Requirements detail

### 5.1 Public / internal boundary

- New router lives at `/api/v1/`, mounted separately from the existing `/api/` router.
  Suggested home: `api/src/platform/api/v1/`.
- The `/api/v1/` layer must **not** import from internal handler files. Add the ESLint
  no-cross-import rule on Day 1, before there are any imports to catch — it's a one-way
  door and far cheaper to enforce than retrofit.
- `/api/v1/` routes call the same domain/db services the internal routes call. Auth, scope,
  and audit attach only at the public layer.

### 5.2 OAuth app model + registration

- `oauth_apps` table: `id`, `client_id`, `client_secret_hash`, `redirect_uris`, `owner`,
  `requested_scopes`, timestamps.
- Hash the secret with **bcrypt via the existing `bcryptjs` dependency** (the auth route
  already imports `bcrypt` from `bcryptjs` — reuse it, add no new dependency; `bcryptjs` is
  pure-JS so there's no native-module Docker risk). Raw secret returned in the creation
  response body once; never recoverable after. bcrypt is the right choice *here* because
  client-secret verification happens only once, at token exchange — not per request (contrast
  §5.3). `client_secret` is high-entropy random, so the hash is about not storing plaintext,
  not brute-force resistance.
- Registration for the MVP can be an admin-only endpoint plus a seed entry for the grader
  app. A self-service UI is portal work and is out of scope.

### 5.3 Auth Code + PKCE

- At `/oauth/authorize`: record `code_challenge` and `code_challenge_method`, validate the
  `redirect_uri` against the registered set, render a consent screen.
- Consent screen lives inside Ship's existing React UI as an authenticated route (e.g.
  `/oauth/consent`), inheriting Ship's session and styling. It displays the requesting app
  and requested scopes and POSTs approve/deny.
- CSRF: the approve POST rides Ship's existing CSRF protection if present; otherwise a
  per-render signed token minted with the consent page and verified on submit. (The OAuth
  `state` parameter covers the client↔Ship leg; this protects the consent form itself.)
- At `/oauth/token`: require `code_verifier`, recompute the challenge, mismatch → `400`
  with `invalid_grant`.
- Access tokens are **opaque high-entropy random strings backed by an `access_tokens` table**,
  not JWTs. Store a **SHA-256 hash** of the token (matching the existing API-token
  implementation), never bcrypt — token validation runs on *every* request, so a slow hash is
  the wrong tradeoff; the token's high entropy means a fast digest is sufficient (no salt, no
  work factor). Contrast §5.2: bcrypt for the client secret is fine because it's verified once.
  The table stores `{ token_hash, app_id, user_id, scopes, expires_at, created_at, last_used_at }`.
  This buys instant revocation (delete the row), a natural audit hook for Epic 7, and a clean
  path to refresh-token rotation next week — at the cost of one indexed lookup per request
  (well within the +10% query-count budget; capture the baseline to prove it).
- Access token lifetime: 1h. No refresh tokens for the MVP.

### 5.4 Token middleware + scopes

- Bearer middleware populates the request with `{ app, user, grantedScopes }`.
- `ScopeRegistry` is a data structure, not a switch statement. MVP scopes:
  `documents:read`, `documents:write`. `documents:read` is the broadest read scope — it covers
  every `document_type` (see §5.5). Register the others (`issues:*`, `sprints:*`,
  `webhooks:manage`) now if cheap, but only `documents:*` is exercised at the gate.
- `require(scope)` is a middleware factory used per route. Missing token → 401, expired →
  401 with a distinct code, insufficient scope → 403 with the missing scope named in the body.
- **Auth-only routes:** `/api/v1/me` requires a valid token but no scope. Model this explicitly
  (e.g. an `authOnly()` marker) so the §5.6 fitness test treats "valid token, no scope" as a
  legitimate declaration rather than a missing-scope failure.

### 5.5 `documents` resource

- `GET /api/v1/documents` (requires `documents:read`) → `{ data, next_cursor }`.
- `GET /api/v1/documents/:id` (requires `documents:read`).
- `POST /api/v1/documents` (requires `documents:write`).
- **`documents` is the superset resource.** Ship stores many types in one table keyed by
  `document_type` — user-facing types (`wiki`, `issue`, `program`, `project`, `sprint`,
  `person`, `weekly_plan`, `weekly_retro`, `standup`, `weekly_review`, …) **plus backing-store
  types** the UI never shows directly (`conversation`, `insight`). The public `documents`
  resource returns **any user-facing type**, mirroring Ship's "everything is a document" model,
  but **excludes the backing-store types** — exposing `conversation`/`insight` under
  `documents:read` would leak internal machinery. **Reuse the existing document route's
  exclusion list rather than hand-rolling a new one**, so the public filter and the internal UI
  filter can't drift. Confirm the exact exclusion in the current route before coding the query.
- The typed endpoints planned for later (`/api/v1/wiki`, `/api/v1/sprints`, `/api/v1/issues`,
  …) are **additive convenience surfaces with their own narrower scopes** — they do not replace
  `documents`, and `documents` does not narrow when they ship. This keeps `/api/v1/documents`
  from ever taking a breaking change.
- Consequently, `documents:read` is the **broadest read scope** ("read all document content"),
  strictly above the future `wiki:read` / `issues:read` / `sprints:read`. Name and comment it
  that way in the `ScopeRegistry` so the privilege hierarchy is intentional, not accidental,
  and answerable in the interview.
- Each returned row carries its `document_type` field so consumers can distinguish a wiki page
  from a sprint. Free now, saves a guessing game later.
- Cursor envelope: return `{ data, next_cursor }` even if `next_cursor` is just an opaque
  base64 of `{ id, timestamp }`. Because the list mixes types, the sort key must be a shared,
  stable field across all types (`created_at` + `id`), never a per-type field. Full cursor
  semantics are post-MVP, but the stable sort matters now.

### 5.5a `GET /api/v1/me`

- Requires a valid token, **no scope** (auth-only, per §5.4). Backs the SDK's `.me()`.
- Returns a small public user shape (`id`, `name`, `email`?) plus current workspace, in the
  public `ApiError`/contract style — **not** the internal `/api/auth/me` `success/data`
  envelope. Do not proxy the internal route; build a thin public handler so the SDK's typed
  surface is consistent with every other `/api/v1` response.

### 5.6 `ApiError` + fitness test

```ts
interface ApiError {
  code: "unauthorized" | "forbidden" | "not_found"
      | "validation_failed" | "rate_limited" | "server_error";
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}
```

- One error middleware ensures every `/api/v1` failure ships this shape with a `request_id`.
- **Existing rate limiter:** the app already configures global `express-rate-limit` for `/api/`
  in `app.ts`, and `/api/v1/*` sits under it. Its default 429 response is **not** `ApiError`
  shaped, which would break the "every public failure ships `ApiError`" claim. Fix:
  **customize the limiter's handler to emit `ApiError` (code `rate_limited`) for the `/api/v1`
  prefix** (preferred), or exempt `/api/v1` from it (fast fallback — but then the public API
  has no 429 path). Do not rely on mount order. This is the *only* path allowed to emit
  `rate_limited` for the gate; we add no new limiter.
- Fitness test enumerates every `/api/v1/*` route and asserts the shape on a failure path,
  **including a forced 429** to prove the limiter emits `ApiError`. This test is your E2 TODO
  list — write it early and let it fail.

### 5.7 OpenAPI 3.1 generation

- Request/response schemas live in Zod adjacent to each handler.
- Generate the spec in-process from route metadata via `zod-to-openapi`
  (`@asteasolutions/zod-to-openapi`). Serve at `/api/v1/openapi.json`. This is a **separate**
  spec from the existing 3.0 one at `/api/openapi.json` — don't reuse that generator.
- Unit test validates the output against the OpenAPI 3.1 JSON schema.
- Commit a static copy at `docs/openapi.json`.
- Fallback if generation breaks late: document where a hand-maintained partial spec would
  live, but treat that as failure, not plan A.

### 5.8 SDK skeleton

- `@ship/sdk` as a new pnpm workspace package. The workspace currently lists only `api`, `web`,
  `shared`, `probe` — adding `sdk/` means **updating both `pnpm-workspace.yaml` and the Railway
  Dockerfile**, which explicitly copies each package's manifest before `pnpm install` for layer
  caching. Skipping either breaks the frozen-lockfile install or silently loses caching.
- MVP surface: `ShipClient` constructor taking `{ token }`, plus `.me()` (hitting `/api/v1/me`)
  returning the typed authenticated user. Resource clients (`documents`, etc.) are stubs for now.
- Keep the `class ShipClient { readonly documents; readonly issues; ... }` shape from the
  brief so later work slots in without reshaping the public surface.
- **Acceptance check (hard):** after adding `sdk`, all three pass — `pnpm install
  --frozen-lockfile`, `pnpm build`, and the Railway Docker build. Add this to CI / the §6 budget.

### 5.9 Deployment + grader access

- Deploy on the existing Railway setup. Public URL reachable, `/api/v1/openapi.json` resolves.
- Seed one OAuth app with read-only (`documents:read`) scopes; put `client_id`, the consent
  flow steps, and a curl/SDK quickstart in the README.

## 6. Non-functional / regression budget

- Existing Playwright suite (73+ tests in `e2e/`) passes on `main`.
- P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline.
  Capture the baseline numbers before adding `/api/v1/` so the comparison is real.
- New OAuth/PKCE Playwright tests live alongside the existing suite.
- After adding the `sdk` package: `pnpm install --frozen-lockfile`, `pnpm build`, and the
  Railway Docker build all pass (workspace + Dockerfile manifest copy updated — see §5.8).

## 7. Build order to the gate

Roughly Monday (after the arch defense) through Tuesday 11:59:

1. **Boundary + lint rule.** Fresh `/api/v1/` router, no-cross-import ESLint rule. (~1h, do it first.)
2. **`ApiError` + error middleware + fitness test.** Test fails until routes exist — that's fine.
   Reconcile the existing limiter so its 429 emits `ApiError` on `/api/v1` (§5.6).
3. **OAuth app model + admin registration + secret hashing** (bcryptjs).
4. **Auth Code + PKCE end-to-end**, including the wrong-verifier negative Playwright test.
5. **Token middleware + `ScopeRegistry` + `require(scope)` + `authOnly()` factory.** Access
   tokens are SHA-256-hashed opaque strings in `access_tokens`.
6. **`GET /api/v1/me`** (auth-only) — backs the SDK and is the simplest route to prove the
   middleware end-to-end before the resource.
7. **`documents` resource** (list/get/post) with Zod schemas adjacent to handlers; reuse the
   existing backing-store type exclusion.
8. **OpenAPI generator** wired to those schemas; unit-test validation; static copy committed.
9. **SDK skeleton** with `.me()`; update `pnpm-workspace.yaml` + Railway Dockerfile; verify
   frozen-lockfile install + build + Docker build.
10. **Deploy, seed grader app, write README.** Confirm the spec URL resolves publicly.
11. **Run full regression**, capture perf numbers vs baseline.

## 8. Locked decisions

These were open at draft and are now decided:

1. **Client-secret hashing: bcrypt via the existing `bcryptjs`** dependency (verified once at
   token exchange; pure-JS, no new dep, no native Docker risk). (§5.2)
2. **Access tokens: opaque high-entropy strings, SHA-256-hashed in an `access_tokens` table**
   (matching the existing API-token impl — *not* bcrypt, which is wrong per-request), 1h
   lifetime, no refresh for the MVP. Chosen for instant revocation and a clean path to
   refresh/audit next week. (§5.3)
3. **`documents` is the superset resource.** Returns any *user-facing* `document_type`,
   excluding backing-store types (`conversation`, `insight`) by reusing the existing route's
   exclusion; `documents:read` is the broadest read scope; future typed endpoints (`/wiki`,
   `/sprints`, `/issues`) are additive and narrower, and `documents` never narrows. (§5.5)
4. **`GET /api/v1/me` is a gate item** — auth-only (no scope), public contract shape, not the
   internal `/api/auth/me` envelope; it backs the SDK's `.me()`. (§5.5a)
5. **Consent screen: a route inside the existing React app**, reusing Ship's session and CSRF
   protection (per-render signed token if none exists). (§5.3)
6. **Read-only grader app: `POST /api/v1/documents` is expected to 403** naming `documents:write`
   — that denial is part of the demo, not a bug. (§2)
7. **No new rate limiter; the existing one must emit `ApiError`** (code `rate_limited`) on
   `/api/v1`, or be exempted. No token bucket, no `X-RateLimit-*` headers for the gate. (§5.6, §4)
8. **Adding `sdk` updates the workspace and Railway Dockerfile**, gated by a frozen-lockfile +
   build + Docker-build check. (§5.8, §6)

Before coding the list query, confirm in the current document route the **exact** set of
user-facing `document_type` values and the backing-store types it already excludes
(`conversation`, `insight`, and any others). Reuse that exclusion verbatim rather than
re-deriving it — the known user-facing set (`wiki`, `issue`, `program`, `project`, `sprint`,
`person`, `weekly_plan`, `weekly_retro`, `standup`, `weekly_review`, …) is wider than the
original six and may grow.
