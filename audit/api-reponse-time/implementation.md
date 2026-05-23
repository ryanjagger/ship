# API Response Time Audit — Implementation Notes

Companion to `README.md` (audit baseline) and `peer-review.md` (reviewer pass). Documents the planned fixes, in what order, and how to reproduce each result. Branch: `implement/api-response-time-2`.

Work is ordered easiest-lift first. Phase 1 is one-line config / middleware additions and a single-statement migration. Phase 2 is small surgical code edits. Phase 3 covers targeted refactors that touch a handful of files. Phase 4 captures structural changes that are real wins under production traffic but need larger diffs and follow-up.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **1. One-line wins** | `compression()` middleware, throttle session/api_token write churn, add missing `api_tokens.token_hash` index | In progress (1.1 done) |
| **2. Small code edits** | Carry `isAdmin` on `req` to eliminate 4th auth-path query; tighten PATCH `pool.connect()` scope; static `Cache-Control` on app-shell endpoints | Pending |
| **3. Targeted refactors** | Replace `MemoryStore`-backed `express-session`; SQL-side or denormalized `hasContent` for accountability grid; ETag (content-hash) on cacheable list endpoints | Pending |
| **4. Structural** | Separate `Pool` for collaboration persistence + collapse pre-UPDATE SELECT; `pino-http` + Postgres slow-query log; `/api/issues` pagination; generated `priority_rank` column for issue ORDER BY | Pending |

## Overlap with the Database Query Efficiency audit

Several peer-review items are already shipped on `master` via the database-query-efficiency audit. They are listed here so we don't re-do the work, with pointers to the prior commits and notes for the audit re-run measurement.

| Peer-review item (§) | Status | Where it landed |
| --- | --- | --- |
| §1 — admin short-circuit so visibility OR doesn't defeat partial indexes | **Done** | DB-audit §2.2 (`84870a5`) — three hot list endpoints migrated; broader migration is follow-up |
| §4 — drop `d.content` from `/api/issues` list SELECT | **Done** | DB-audit §3.2 (`21007c6`) — also dropped on `/api/issues/:id/children`. `weekly-plans.ts` `hasContent` site deferred (see §3.2 here) |
| §6 — JSONB expression indexes (assignee/owner/standup/sprint_number/weekly composite/ticket_number) | **Done** | DB-audit Phase 1 (`77ea82f`, `f1cbddc`, `15d4f77`) |
| §6 — `api_tokens.token_hash` index | **Pending** | Not covered by DB audit. Tackled in §1.4 below |
| §9 — `/api/projects` correlated subplan rewrite | **Done** | DB-audit §4.1a (`72a2c0d`) |
| §9 — `/api/dashboard/my-week` sequential queries | **Done** | DB-audit §3.3 (`1bc0575`) — two-wave `Promise.all` |
| §11 — PATCH transaction-leak fix | **Done** for `documents.ts`; **Pending** scope-tightening for `issues.ts` PATCH | DB-audit §3.1 (`70de335`) fixed the leak in `documents.ts:645`. Peer-review §11 is a different point about `issues.ts:676` holding the pool client longer than needed — tracked in §2.2 below |
| §5 — `hasContent` SQL-side / denormalized boolean (accountability grid) | **Pending** | Tracked in §3.2 below |

Everything in the Roadmap table is genuinely net-new from this audit.

## Phase 1 — One-line wins

### 1.1 Mount HTTP compression — Status: **Done**

**Before.** `grep -r compression api/src` was empty. `helmet` was mounted but only sets security headers; it does not compress responses. Audit measured `/api/issues` at 228.5 KB and `/api/documents?type=wiki` at 176.5 KB. Both are highly compressible JSON.

**Change.**

- Added `compression@^1.x` to `api/package.json` dependencies and `@types/compression` to devDependencies.
- In `api/src/app.ts`, added `import compression from 'compression';` and mounted `app.use(compression())` inside `createApp`, before `helmet` (so security headers are computed on the compressed body, not before — actually compression middleware only sets `Content-Encoding`/`Vary`, the body transform happens at write time, so order vs. helmet doesn't matter functionally; placed before helmet so the per-response middleware chain starts with compression).

Default thresholds (1 KB minimum, `compressible`-matched content types) are fine. No allowlist, no per-route opt-in.

**After (verified 2026-05-23 against the running dev API on :3000).**

Unauthenticated probe on `/api/openapi.json` (158.5 KB JSON):

| Header | Value |
| --- | --- |
| `Content-Encoding` | `gzip` |
| `Vary` | `Origin, Accept-Encoding` |
| `Transfer-Encoding` | `chunked` |

Wire bytes:

```
identity: 158,520 bytes
gzip:      18,100 bytes   (-88.6%, 8.8×)
```

The middleware response-shape (`Vary: Accept-Encoding` + `Content-Encoding: gzip` on supporting clients) was also observed on every other JSON response that exceeded the 1 KB threshold. Small responses (`/health` at 15 bytes, error bodies at 78 bytes) correctly pass through uncompressed — by design, gzip overhead exceeds the savings under the threshold.

Tests: api 451/451, web 151/151 still green (`pnpm run test`).

**Reproducibility.**

```bash
# Headers
curl -sI -H 'Accept-Encoding: gzip' http://localhost:3000/api/openapi.json \
  | grep -iE 'content-encoding|vary|transfer-encoding'

# Bytes-on-wire delta
printf "identity: "; curl -s -o /dev/null -w '%{size_download}\n' \
  -H 'Accept-Encoding: identity' http://localhost:3000/api/openapi.json
printf "gzip:     "; curl -s -o /dev/null -w '%{size_download}\n' \
  -H 'Accept-Encoding: gzip' http://localhost:3000/api/openapi.json
```

For authenticated endpoints (`/api/issues`, `/api/documents?type=wiki`), log in and pass the session cookie via `-b "$COOKIE_JAR"`; the headers and ratio behave the same way.

**Caveat on loopback measurement.** ApacheBench over loopback won't show a wall-clock improvement — compression's win is wire-bytes, not server CPU, and the loopback wire is effectively free. The real benefit lands on CloudFront-edge / WAN clients where 88% fewer bytes is 88% less transfer time at the user.

### 1.2 Throttle `sessions.last_activity` UPDATE — Status: Pending

**Before.** `api/src/middleware/auth.ts:205-208` writes `UPDATE sessions SET last_activity = $1 WHERE id = $2` on **every** authenticated request — even though the cookie refresh on the same path is already throttled to once every 60 s by `COOKIE_REFRESH_THRESHOLD_MS` (line 212). With a many-connection benchmark using one session cookie this is a hot-row UPDATE; in real traffic it's still a serialized write per user per request.

**Change.** Reuse the existing `COOKIE_REFRESH_THRESHOLD_MS` window: only write `last_activity` when more than `COOKIE_REFRESH_THRESHOLD_MS` (60 s) has passed since the last activity timestamp already on the session row. The threshold is already computed at `:212-213`; reorder so the UPDATE is gated by the same boolean.

```ts
const inactivityMs = now.getTime() - lastActivity.getTime();
const SESSION_TOUCH_THRESHOLD_MS = 60 * 1000; // same 60s window as cookie refresh
if (inactivityMs > SESSION_TOUCH_THRESHOLD_MS) {
  await pool.query(
    'UPDATE sessions SET last_activity = $1 WHERE id = $2',
    [now, session.id],
  );
}
```

The 15-minute inactivity timeout policy (`docs/claude-reference/architecture.md`) is unaffected — 60 s of write coalescing is well below the 15-minute expiration boundary, so a session expiring mid-window still has a recent enough `last_activity` value to be detected as expired on the next request (the read at `:127-133` happens regardless).

**Expected after.** Under the benchmark's one-cookie traffic shape, write contention on the single session row drops by ~60x at 1 req/s and proportionally more at higher rates. -1 to -3 ms p50 + a larger contention drop at concurrency 50.

**Reproducibility.**

```bash
# Tail Postgres and confirm UPDATE sessions firing only every ~60s
psql "$DATABASE_URL" -c "ALTER SYSTEM SET log_min_duration_statement = 0;" && \
  psql "$DATABASE_URL" -c "SELECT pg_reload_conf();"
# Run benchmark; grep the PG log for "UPDATE sessions SET last_activity"
# Expect: ~one UPDATE per minute per session, not per request.
# Restore: ALTER SYSTEM RESET log_min_duration_statement;
```

### 1.3 Throttle `api_tokens.last_used_at` UPDATE — Status: Pending

**Before.** `api/src/middleware/auth.ts:52-55` writes `UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1` synchronously on every API-token request. Same shape as §1.2 — a serialized hot-row write on a single token row per token per request.

**Change.** Same pattern as §1.2: skip the UPDATE if the token's existing `last_used_at` is within the last 60 s. Read the value alongside the existing lookup at `:35`, gate the write on the threshold.

```ts
if (!token.last_used_at ||
    (Date.now() - new Date(token.last_used_at).getTime()) > 60_000) {
  await pool.query(
    'UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1',
    [token.id],
  );
}
```

The token's `last_used_at` is shown in the admin UI for token management; 60 s resolution is fine for that surface.

**Expected after.** Once API tokens see real CI / CLI / Claude-integration traffic, this prevents per-request write churn on whatever single token a script holds.

**Reproducibility.** Hit any authenticated endpoint with a Bearer token in a loop; tail PG log; confirm ~one UPDATE per 60 s, not per request.

### 1.4 Add `idx_api_tokens_hash` index — Status: Pending

**Before.** `validateApiToken` (`api/src/middleware/auth.ts:33-39`) filters `api_tokens` by `token_hash = $1`. Per peer-review §6, there is no index on `api_tokens.token_hash` — the existing indexes (`schema.sql:404-406`) cover `user_id`, `workspace_id`, `token_prefix`, none of which are queried in the auth path. With N tokens this is a seq scan on every API-token-authenticated request.

**Change.** New migration `api/src/db/migrations/044_api_tokens_hash_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens (token_hash)
  WHERE revoked_at IS NULL;

ANALYZE api_tokens;
```

Partial-on-`revoked_at IS NULL` matches the route's filter (`api_tokens` validation never accepts a revoked token) so revoked rows don't bloat the index. Closing `ANALYZE` so the planner picks up stats immediately — same convention as Phase 1 of the DB-audit migrations.

**Expected after.** `EXPLAIN ANALYZE SELECT … FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL` switches from a seq scan to an `Index Scan using idx_api_tokens_hash`. The seq scan cost grows linearly with row count; the index keeps lookup constant-time. Per peer-review: "tens of ms per API-token request once any non-trivial number of tokens exist."

**Reproducibility.**

```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE
  SELECT id FROM api_tokens
  WHERE token_hash = (SELECT token_hash FROM api_tokens LIMIT 1)
    AND revoked_at IS NULL;"
# Expect: Index Scan using idx_api_tokens_hash
```

## Phase 2 — Small code edits

### 2.1 Carry `isAdmin` on `req` from auth middleware — Status: Pending

**Before.** Per peer-review §1, the floor for any authenticated GET is 4 sequential DB round-trips before the route does its own work:

1. `SELECT … FROM sessions JOIN users` — `auth.ts:126-133`
2. `SELECT id FROM workspace_memberships …` — `auth.ts:184-187`
3. `UPDATE sessions SET last_activity = $1 WHERE id = $2` — `auth.ts:205-208` (throttled by §1.2 above)
4. `SELECT role FROM workspace_memberships …` — `visibility.ts:7-11`, called from nearly every route handler

Query #4 is essentially the same lookup as #2. The DB-audit's §2.2 work added an admin **SQL** short-circuit (so `VISIBILITY_FILTER_SQL` constant-folds for admins), but it didn't eliminate the `getVisibilityContext` call itself — handlers still pay one round-trip just to learn whether the cached membership row is admin.

**Change.** Two parts:

1. In `authMiddleware` (`auth.ts:184-187`), the workspace_memberships SELECT already reads enough to know the role. Have it select `role` in addition to `id`, and attach `(req as any).workspaceRole` (or extend the typed AuthenticatedRequest shape).
2. In `getVisibilityContext` (`middleware/visibility.ts:7-11`), if `req.workspaceRole` is already populated, skip the query and return `{ isAdmin: req.workspaceRole === 'admin', userId, workspaceId }`. Fall back to the existing query only for code paths that call the helper without going through `authMiddleware` (e.g., service-internal flows).

**Expected after.** -1 query on the auth path floor for every authenticated route. Peer-review estimate: -3 to -8 ms on every authenticated endpoint at concurrency 50, more under contention. The biggest beneficiary is `/api/dashboard/my-week` (audit p50 31 ms, 0.8 KB response, dominated by auth-path overhead).

**Reproducibility.** Tail PG log with `log_min_duration_statement = 0`, hit any GET endpoint, count the queries on the auth path. Before: 4 (or 3 after §1.2 dedups one). After: 3 (or 2).

### 2.2 Tighten PATCH `/api/issues/:id` pool client scope — Status: Pending

**Before.** Per peer-review §11: `api/src/routes/issues.ts:676` acquires a dedicated pool client at the top of the PATCH handler but does not `BEGIN` until line 918. Between those lines it does several small queries (visibility, existing-issue lookup) that could have used `pool.query` without holding a pool slot — under load this starves the pool faster than a properly scoped transaction would.

This is **not** the same as the DB-audit's PATCH transaction-leak fix (which fixed `documents.ts:645`); that one was about missing `ROLLBACK` on early returns. This one is about acquiring the dedicated client too early.

**Change.** In `api/src/routes/issues.ts`:

- Replace the early `const client = await pool.connect()` (around `:676`) with direct `pool.query(...)` calls for the read-only validation steps (visibility check, existing-issue fetch, parent constraints).
- Move `const client = await pool.connect()` to immediately before `await client.query('BEGIN')` at `:918`.
- Adjust the `finally` block to release only when the connect succeeded (existing pattern is already release-in-finally — guard it on a boolean or `client?.release()`).

**Expected after.** Under concurrent issue edits, the pool slot is held only for the write path, not the read-validation path. Pool starvation surfaces later. -5 to -15 ms under concurrency 50 on the slow path; near-zero on the fast path.

**Reproducibility.** Eyeball the diff: every read-side query between line ~676 and ~918 should go through `pool.query`, not `client.query`. Run the audit's benchmark targeting `PATCH /api/issues/:id` (not currently in the primary set — add it for this measurement) at concurrency 50.

### 2.3 `Cache-Control` headers on app-shell endpoints — Status: Pending

**Before.** Per peer-review §8: `grep -ri 'etag\|cache-control' api/src` is empty. No route sets cache headers; Express's default weak ETag is computed after serializing the body, so it only saves bandwidth on conditional GETs, not CPU.

**Change.** For the app-shell endpoints (those the audit's frontend trace hit on "nearly every route"), set static `Cache-Control: private, max-age=30, must-revalidate` in the response. The 30 s window matches the typical SPA navigation cadence — repeated requests during a single user session hit the cache.

Candidate routes:

- `GET /api/documents?type=wiki`
- `GET /api/projects` (list)
- `GET /api/programs` (list)
- `GET /api/team/people`

Implementation: a small middleware applied per-route, or `res.set('Cache-Control', '…')` before `res.json(…)` in each handler.

Skip endpoints whose response can change mid-session in user-visible ways without a navigation (`/api/dashboard/my-week`, `/api/auth/session`).

**Expected after.** SPA repeat requests for the wiki tree etc. return 200 from the browser's HTTP cache (no network round-trip) for up to 30 s. Server request volume drops on the affected endpoints; perceived latency drops because there's no request at all.

ETag (content-hash) is tracked separately in §3.3 as a larger change.

**Reproducibility.**

```bash
curl -sI -b "session_id=…" http://localhost:3001/api/documents?type=wiki \
  | grep -i cache-control
# Expect: cache-control: private, max-age=30, must-revalidate
```

Then in DevTools, navigate the SPA and confirm subsequent `/api/documents?type=wiki` fetches show `(disk cache)` for up to 30 s before re-issuing.

## Phase 3 — Targeted refactors

### 3.1 Replace `MemoryStore`-backed `express-session` — Status: Pending

**Before.** Per peer-review §2: `app.ts:147-157` mounts `express-session` globally with no `store:` argument, so it uses the default `MemoryStore`. It exists only so that `csrf-sync` has somewhere to put its secret. Two problems:

- **Correctness in multi-instance.** In Elastic Beanstalk with multiple instances, a CSRF token bound to instance A fails on instance B unless sticky sessions are configured. CSRF failures would silently mask in metrics.
- **Per-request overhead.** Every authenticated request parses, validates, and at minimum reads/touches the in-memory session map, and every response carries the signed `connect.sid` cookie on top of the app's own `session_id`.

**Change.** Two options. Prefer **B**:

- **A. Switch to a stateless double-submit cookie.** `csrf-sync` supports `getCsrfSecret`/`storeCsrfSecret` overrides — point them at the existing `sessions` row, dropping `express-session` entirely. Largest diff but eliminates the correctness bug at the root.
- **B. Drop `express-session` and store the CSRF secret on the existing `sessions` row.** Add a `csrf_secret` column (new migration `045_sessions_csrf_secret.sql`), populate on session create, read in the CSRF middleware. Removes `express-session` from the mount entirely.

**Expected after.** Multi-instance deploys are correct without sticky sessions; one fewer set-cookie pair per response; 1-2 ms saved per request from removing the global session middleware.

**Reproducibility.** `grep -rn express-session api/src/app.ts` → no results. Multi-instance test: rotate which EB instance serves a request mid-session; CSRF still validates.

### 3.2 Move accountability grid `hasContent` into SQL or denormalize — Status: Pending

**Before.** Per peer-review §5: `api/src/routes/team.ts:1838-1868` SELECTs full `content` for every weekly_plan + weekly_retro just to call `hasContent(content)` in JS (line 1878). The check strips three template heading strings and tests for non-empty residual text.

Same shape exists at `api/src/routes/weekly-plans.ts:990-1009` (deferred from DB-audit §3.2 for the same reason). With a few hundred plans + retros each carrying 5-50 KB of TipTap JSON, this single endpoint pulls megabytes from Postgres to compute a boolean.

**Change.** Two options. Prefer **B**:

- **A. SQL-side check.** Use `jsonb_path_query_array(content, '$.**.text')` to extract text nodes, then `length(regexp_replace(...))` to strip template headings and check for residual text. Doable but the template headings would have to live in SQL too, which couples the migration to the editor's template wording.
- **B. Denormalize a `has_content` boolean on the document row.** Compute and write it on every `persistDocument` save (`api/src/collaboration/index.ts:172`) and on every direct `PATCH /api/documents/:id` content update. The check stays in JS (reusing `hasContent`) but runs once per save instead of per read.

Then change the team-grid (and weekly-plans alloc) SELECT to read `has_content` instead of `content`.

**Expected after.** Per peer-review: -15 to -40 ms on accountability grid at production volume; scales with plan/retro count. The savings are payload-side, so they get further amplified by §1.1 (compression) and §2.3 (cache).

**Reproducibility.** Inspect `EXPLAIN (ANALYZE, BUFFERS)` on the team-grid SELECTs before/after; the `Buffers: shared hit=…` count should drop substantially because content TOAST pages no longer need to be read.

### 3.3 ETag (strong, content-hash) on cacheable list endpoints — Status: Pending

**Before.** Same starting point as §2.3 — no app-set ETag. Express's default weak ETag saves bandwidth but not CPU (because it serializes the body before hashing).

**Change.** A small middleware (or per-route helper) that:

1. Computes the response body.
2. Hashes it (sha1 or fnv) to produce a strong ETag.
3. Compares against the request's `If-None-Match` header; returns `304 Not Modified` if it matches.
4. Otherwise sets `ETag: "<hash>"` and sends the body.

Apply to the same endpoints as §2.3 (`/api/documents?type=wiki`, `/api/projects`, `/api/programs`, `/api/team/people`).

**Expected after.** When a client revalidates a stale Cache-Control entry (after the 30 s window), the server can answer with a 304 if nothing has changed. The hash is still computed server-side, but the response body isn't shipped over the wire. Per peer-review: "304s on most repeat hits, ~zero server cost on those."

Bigger lever for `/api/documents?type=wiki` specifically — that endpoint is hit on "nearly every route" per the audit's frontend trace.

**Reproducibility.**

```bash
ETAG=$(curl -sI -b "session_id=…" http://localhost:3001/api/documents?type=wiki | grep -i '^etag:' | awk '{print $2}' | tr -d '\r')
curl -sI -b "session_id=…" -H "If-None-Match: $ETAG" http://localhost:3001/api/documents?type=wiki | head -1
# Expect: HTTP/1.1 304 Not Modified
```

## Phase 4 — Structural

### 4.1 Separate `Pool` for collaboration persistence — Status: Pending

**Before.** Per peer-review §7: `setupCollaboration(server)` attaches a WebSocketServer to the same `http.Server` that serves the REST API, and `persistDocument` (`api/src/collaboration/index.ts:111-179`) writes Yjs state and JSON content to the same `pool` (max 20 in prod). Each open doc schedules a write every 2 s of activity (`schedulePersist`, line 181-189). With 20-40 active editors, collaboration writes can saturate the connection pool, starving REST requests. The audit ran no collaboration traffic during the benchmark, so this is invisible in the numbers.

Worse, `persistDocument` does a `SELECT … FROM documents WHERE id = $1` *before* the UPDATE (line 127-130) to fetch existing properties/content — each persist is two queries, holding two pool slots over a network round-trip.

**Change.** Three parts, in order of effort:

1. **Separate pool.** In `api/src/db/client.ts`, export a second `Pool` with `max: 10` for collaboration. `api/src/collaboration/index.ts:111` uses the new pool. REST is isolated from collab write spikes.
2. **Fold the SELECT into the UPDATE.** Use a single `UPDATE … FROM (SELECT …) WHERE … RETURNING …` or a CTE. One round-trip per persist instead of two.
3. **Optional follow-up.** Move yjs persistence onto a queue (e.g., `pg-boss`) so saves don't block pool slots at all. Tracked but not blocking.

**Expected after.** Under simulated mixed REST + collaboration load (not in the current audit harness), REST p95 stays flat as collab editor count rises, instead of degrading proportionally to active document count.

**Reproducibility.** Add a collab-traffic harness to the audit (drive N WebSocket clients holding open editors, measure REST p95 alongside).

### 4.2 `pino-http` access logging + Postgres slow-query log — Status: Pending

**Before.** Per peer-review §10: `grep -r 'morgan\|pino' api/src` is empty. No request logging, no APM, no `console.time` around handlers. The audit measured local p95 via `ab`; production p95 is unknown. Until access logging with response-time annotations is on, future audits will have to repeat the synthetic measurement instead of looking at real traffic.

**Change.** Two parts:

1. `pino-http` mounted in `app.ts` early in the middleware chain. Emits structured JSON with `req.id`, method, path, status, response time. Light enough to leave on in production.
2. Postgres: `log_min_duration_statement = 100ms` in the prod config. Slow queries land in CloudWatch (EB) or wherever PG logs are shipped.

**Expected after.** Real-traffic p50 / p95 / p99 visibility per endpoint, and a slow-query feed to catch regressions before the next synthetic audit.

**Reproducibility.** After deploy, query the access log for p95 by endpoint over a representative window. Cross-reference with the slow-query log for any single-statement outliers.

### 4.3 Pagination on `/api/issues` — Status: Pending

**Before.** `/api/issues` returns every issue in one response. The DB-audit's §3.2 already dropped `d.content` (the biggest payload contributor), but the row count itself is still unbounded. At 200 seeded issues this is fine; in a mature workspace (5k-50k issues) the JSON serialization alone becomes the dominant cost.

Peer-review §13 ranks this last because pagination's impact on p95 in the current benchmark is small — the row count is small and `d.content` is already gone. But it's a known production hazard.

**Change.** Add `?limit=` (default 100, max 500) and `?cursor=<id|updated_at>` to `/api/issues`. Frontend (`web/src/hooks/useIssuesQuery.ts`, `IssuesList.tsx`, `KanbanBoard.tsx`) gains infinite-scroll behavior with `useInfiniteQuery`.

The ORDER BY shape complicates cursor selection — see §4.4 for the related priority sort change.

**Expected after.** O(1) first-page latency regardless of workspace size. Lazy load subsequent pages on scroll.

**Reproducibility.** Re-run the benchmark with `/api/issues?limit=100` against a synthetic 10k-issue dataset; compare to baseline.

### 4.4 Generated `priority_rank` column + index for issue ORDER BY — Status: Pending

**Before.** Per peer-review §12: `api/src/routes/issues.ts:213-221` orders by:

```sql
ORDER BY
  CASE d.properties->>'priority'
    WHEN 'urgent' THEN 1
    WHEN 'high'   THEN 2
    …
  END,
  d.updated_at DESC
```

No index can serve `(priority_rank, updated_at)` in this shape — the CASE expression is opaque to even the new expression indexes from DB-audit Phase 1.

**Change.** New migration `046_issue_priority_rank_generated.sql`:

```sql
ALTER TABLE documents ADD COLUMN priority_rank int
  GENERATED ALWAYS AS (
    CASE properties->>'priority'
      WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
      WHEN 'medium' THEN 3 WHEN 'low'  THEN 4
      ELSE 5
    END
  ) STORED;

CREATE INDEX idx_issues_priority_rank_updated
  ON documents (priority_rank, updated_at DESC)
  WHERE document_type = 'issue'
    AND archived_at IS NULL AND deleted_at IS NULL;

ANALYZE documents;
```

Route handler stays the same (the planner picks the new index for the CASE-equivalent ordering); if Postgres' planner can't infer the equivalence, change the ORDER BY to read `priority_rank` directly.

**Expected after.** Issue list ORDER BY uses an index scan instead of a sort node; flat scaling with workspace issue count. Pairs naturally with §4.3 — a paginated issue list needs a stable, indexable sort.

**Reproducibility.**

```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE
  SELECT id FROM documents
  WHERE document_type = 'issue' AND deleted_at IS NULL AND archived_at IS NULL
  ORDER BY priority_rank, updated_at DESC LIMIT 100;"
# Expect: Index Scan using idx_issues_priority_rank_updated, no Sort node.
```

## Expected impact summary

Peer-review §"Concrete additional recommendations" gives expected p95 wins per item; reproducing here ordered by phase:

| Phase | Item | Est. p95 impact |
| ---: | --- | --- |
| 1.1 | `compression()` | -60 to -80% wire bytes (WAN); near-zero loopback |
| 1.2 | Throttle `last_activity` | -1 to -3 ms p50 + big contention drop under load |
| 1.3 | Throttle `api_tokens.last_used_at` | -tens of ms per API-token req under sustained automation |
| 1.4 | `idx_api_tokens_hash` | -tens of ms per API-token req once N tokens non-trivial |
| 2.1 | `isAdmin` on req | -3 to -8 ms on every authenticated endpoint |
| 2.2 | PATCH pool scope | -5 to -15 ms under concurrency 50 on slow path |
| 2.3 | `Cache-Control` | drops SPA request volume on app-shell endpoints |
| 3.1 | Drop `MemoryStore` | correctness in multi-instance + 1-2 ms |
| 3.2 | `hasContent` denormalize | -15 to -40 ms on accountability grid at prod volume |
| 3.3 | Content-hash ETag | 304s on most repeat hits, ~zero server cost on those |
| 4.1 | Separate collab pool | prevents collab write storms blocking REST under real usage |
| 4.2 | `pino-http` + slow-query log | visibility into real prod p95 |
| 4.3 | `/api/issues` pagination | necessary at workspace scale; small win at current volume |
| 4.4 | `priority_rank` generated col | flat scaling on issue list ORDER BY |

## Audit re-run protocol

After each phase, re-run the audit's primary benchmark and append a "Post-Phase N" subsection here with:

- New `Audit Deliverable` table (5 endpoints, p50/p95/p99 at concurrency 50).
- Delta vs. README baseline.
- Any new gap or surprise that surfaced.

The full reproduction is in `README.md` §1-6 (`pnpm db:seed`, `node audit/api-reponse-time/seed-volume.mjs`, `pnpm build:api`, start API on :3001, `node audit/api-reponse-time/benchmark-ab.mjs | tee results/benchmark.json`, `node audit/api-reponse-time/format-results.mjs results/benchmark.json`).
