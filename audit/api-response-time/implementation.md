# API Response Time Audit — Implementation Notes

Companion to `README.md` (audit baseline) and `peer-review.md` (reviewer pass). Documents the planned fixes, in what order, and how to reproduce each result. Branch: `implement/api-response-time-2`.

Work is ordered easiest-lift first. Phase 1 is one-line config / middleware additions and a single-statement migration. Phase 2 is small surgical code edits. Phase 3 covers targeted refactors that touch a handful of files. Phase 4 captures structural changes that are real wins under production traffic but need larger diffs and follow-up.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **1. One-line wins** | `compression()` middleware, throttle session/api_token write churn, add missing `api_tokens.token_hash` index | **Done** (4 / 4 items landed) |
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

### 1.2 Throttle `sessions.last_activity` UPDATE — Status: **Done**

**Before.** `api/src/middleware/auth.ts:205-208` wrote `UPDATE sessions SET last_activity = $1 WHERE id = $2` on **every** authenticated request — even though the cookie refresh on the same path was already throttled to once every 60 s by `COOKIE_REFRESH_THRESHOLD_MS` (line 212). With a many-connection benchmark using one session cookie this is a hot-row UPDATE; in real traffic it's a serialized write per user per request.

**Change.** Hoisted the UPDATE into the same `inactivityMs > 60 s` branch the cookie refresh already used, and renamed the constant to `ACTIVITY_REFRESH_THRESHOLD_MS` (it now gates both DB write + cookie reissue):

```ts
const ACTIVITY_REFRESH_THRESHOLD_MS = 60 * 1000;
if (inactivityMs > ACTIVITY_REFRESH_THRESHOLD_MS) {
  await pool.query(
    'UPDATE sessions SET last_activity = $1 WHERE id = $2',
    [now, sessionId]
  );
  res.cookie('session_id', sessionId, { /* sliding expiration */ });
}
```

The 15-minute inactivity timeout policy is unaffected — 60 s of write coalescing is well below the 15-minute expiration boundary, so a session expiring mid-window still has a recent-enough `last_activity` value to be detected as expired on the next request (the read at `:127-133` happens regardless of the threshold).

**Test infrastructure fix.** Surfaced a latent brittleness in `api/src/__tests__/auth.test.ts`: `beforeEach` was calling `vi.clearAllMocks()`, which clears call history but NOT the `mockResolvedValueOnce` queue. Tests had been relying on exact queue depletion — fine when every code path consumed exactly N onces, but my change consumed one fewer in the within-60 s branch, leaving one mock queued for the next test. Switched to `vi.resetAllMocks()` so the queue clears between tests. All 15 tests pass; total api 451/451, web 151/151.

**After (verified 2026-05-23, second API instance on :3001 against seeded `ship_dev`).**

End-to-end smoke test logging the actual `sessions.last_activity` timestamp around a series of requests:

```
T0 immediately after login:        2026-05-23 15:07:01.744-05
5 authenticated requests at 1/s:   T1 = 2026-05-23 15:07:01.744-05  (UNCHANGED)
sleep 65s + 1 more request:        T2 = 2026-05-23 15:08:12.126-05  (ADVANCED)
```

Within the 60 s window: zero UPDATEs across 5 requests. Beyond the window: the next request fires the UPDATE. Behavior matches the design exactly.

**Reproducibility.** Boot a fresh API instance and seed; the script is in the smoke-test command but condensed:

```bash
# In one terminal — run a second API:
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5432/ship_dev \
  PORT=3001 SESSION_SECRET=smoke-test E2E_TEST=1 \
  pnpm --filter @ship/api dev

# In another:
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5432/ship_dev pnpm db:seed
# Login (POST /api/auth/login, capture session_id cookie), then:
psql -d ship_dev -tA -c "SELECT last_activity FROM sessions ORDER BY last_activity DESC LIMIT 1"
# Fire 5 requests within ~5s; re-read; expect unchanged.
# Sleep 65s, fire once more; re-read; expect advanced.
```

### 1.3 Throttle `api_tokens.last_used_at` UPDATE — Status: **Done**

**Before.** `api/src/middleware/auth.ts:52-55` wrote `UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1` synchronously on every API-token request. Same shape as §1.2 — a serialized hot-row write on a single token row per token per request.

**Change.** Added `t.last_used_at` to the existing token SELECT, then gated the UPDATE on the same 60 s window (`TOKEN_USE_REFRESH_THRESHOLD_MS`). First-ever use is detected via NULL `last_used_at` (`lastUsedMs = 0` → `Date.now() - 0 > 60_000` is trivially true), so the timestamp is initialized on the first request and only refreshed when the prior write is more than 60 s old.

```ts
const TOKEN_USE_REFRESH_THRESHOLD_MS = 60 * 1000;
const lastUsedMs = tokenRow.last_used_at
  ? new Date(tokenRow.last_used_at).getTime()
  : 0;
if (Date.now() - lastUsedMs > TOKEN_USE_REFRESH_THRESHOLD_MS) {
  await pool.query(
    'UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1',
    [tokenRow.id]
  );
}
```

The token's `last_used_at` is shown in the admin UI; 60 s resolution is fine for that surface.

**After (verified 2026-05-23 end-to-end against seeded `ship_dev`, second API on :3001).**

```
After token mint:                         last_used_at = NULL
After first Bearer request:               2026-05-23 15:18:38.184026  (UPDATE fired — NULL crossed the threshold)
After 5 more Bearer requests over ~5s:    2026-05-23 15:18:38.184026  (UNCHANGED — throttled)
After sleep 65s + 1 more request:         2026-05-23 15:19:48.592074  (ADVANCED — UPDATE fired)
```

Within the 60 s window: 5 requests, 0 UPDATEs. Across the boundary: 1 UPDATE. Behavior matches the design.

Tests: api 451/451, web 151/151 still green.

**Reproducibility.** Mint a token via `POST /api/api-tokens` (CSRF-protected, session-cookie auth), then in a loop:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/issues -o /dev/null
psql -d ship_dev -tA -c "SELECT last_used_at FROM api_tokens WHERE id='$TOKEN_ID';"
```

Within 60 s the timestamp stays put; after a 65 s gap the next request advances it.

### 1.4 Add `idx_api_tokens_hash` index — Status: **Done**

**Before.** `validateApiToken` (`api/src/middleware/auth.ts`) filters `api_tokens` by `token_hash = $1`. Per peer-review §6, there was no index on `api_tokens.token_hash` — the existing indexes (`schema.sql:409-411`) covered `user_id`, `workspace_id`, `token_prefix`, none of which are queried in the auth path. With N tokens this is a seq scan on every API-token-authenticated request.

**Change.** New migration `api/src/db/migrations/044_api_tokens_hash_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens (token_hash)
  WHERE revoked_at IS NULL;

ANALYZE api_tokens;
```

Partial-on-`revoked_at IS NULL` matches the route's filter (`api_tokens` validation never accepts a revoked token) so revoked rows don't bloat the index. Closing `ANALYZE` so the planner picks up stats immediately — same convention as the DB-audit Phase 1 migrations.

**After (verified 2026-05-23 against `ship_dev`).** `\d api_tokens` lists the new index:

```
"idx_api_tokens_hash" btree (token_hash) WHERE revoked_at IS NULL
```

`EXPLAIN ANALYZE` against 100 synthetic tokens:

```sql
-- Planner-default plan:
Seq Scan on api_tokens (cost=2.04..6.29 rows=1 width=32)
  Filter: ((revoked_at IS NULL) AND (token_hash = $0))
  Rows Removed by Filter: 99 / Buffers: shared hit=5
Execution Time: 0.059 ms

-- Forced index (SET enable_seqscan = off):
Index Scan using idx_api_tokens_hash on api_tokens
  Index Cond: (token_hash = $0)
Execution Time: 0.014 ms (actual time for the scan)
```

At 100 rows the table fits in ~2 pages and the planner correctly prefers the Seq Scan — cheaper than the index lookup at that scale. As the table grows to thousands of tokens (CI / CLI / Claude-integration usage), the planner will switch to `idx_api_tokens_hash` automatically; the index is functional and the partial predicate is matched. Per peer-review: "tens of ms per API-token request once any non-trivial number of tokens exist."

Tests: api 451/451, web 151/151 still green.

**Migration apply caveat.** The repo's `api/src/db/migrate.ts` has a pre-existing bug: when `schema.sql` throws "already exists" on a database that already has the base schema, the surrounding `catch` swallows the error but also short-circuits past the pending-migration loop. Most of migrations 010-042 are visibly applied to `ship_dev` but only 11 rows exist in `schema_migrations` (`001-009` + `043`), confirming the migrations have been getting applied via side channels (manual `psql -f`, direct DB resets, etc.). This change was applied the same way: `psql -f .../044_api_tokens_hash_index.sql` + an explicit `INSERT INTO schema_migrations`. Worth fixing separately so prod deploys don't silently skip migrations — out of scope for this audit.

**Reproducibility.** Once the migrate-script bug is fixed, the canonical apply is `pnpm db:migrate`. Today:

```bash
psql -d ship_dev -f api/src/db/migrations/044_api_tokens_hash_index.sql
psql -d ship_dev -c "INSERT INTO schema_migrations (version) VALUES ('044_api_tokens_hash_index') ON CONFLICT DO NOTHING;"

# Verify
psql -d ship_dev -c "\d api_tokens" | grep idx_api_tokens_hash
# Expect: "idx_api_tokens_hash" btree (token_hash) WHERE revoked_at IS NULL
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

The full reproduction is in `README.md` §1-6 (`pnpm db:seed`, `node audit/api-response-time/seed-volume.mjs`, `pnpm build:api`, start API on :3001, `node audit/api-response-time/benchmark-ab.mjs | tee results/benchmark.json`, `node audit/api-response-time/format-results.mjs results/benchmark.json`).

**Migrate caveat for any re-run.** `pnpm db:migrate` short-circuits past pending migrations when `schema.sql` throws "already exists" — see the §1.4 apply caveat. For the disposable benchmark DB the workaround is to run each pending migration file with `psql -v ON_ERROR_STOP=1 -f migrations/NNN_*.sql` and skip the ones whose post-state is already in `schema.sql` (treating "already exists" / "not an existing enum label" / etc. as "applied via schema.sql"). The re-run scripted below uses that pattern.

## Post-Phase-1 audit re-run

Ran `audit/api-response-time/benchmark-ab.mjs` against the disposable `ship_api_response_time_audit` DB after applying all 49 migrations (including 044) and the same `pnpm db:seed` + `seed-volume.mjs` pipeline the README baseline used. The build was `pnpm build:api` (production-style artifact, `node api/dist/index.js`) on this branch's HEAD (`baa7155`).

Volume matches baseline within noise: **35 users / 717 documents** (README expected 36/718 — within tolerance), 347 wiki / 200 issues / 35 weeks / 15 projects / 5 programs.

### Audit Deliverable — 50 simultaneous connections

| Endpoint | Items | Resp size | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. `GET /api/documents?type=wiki` | 347 | 172.4 KB | 92 ms | 110 ms | 118 ms |
| 2. `GET /api/issues` | 200 | 185.3 KB | 83 ms | 91 ms | 96 ms |
| 3. `GET /api/team/accountability-grid-v3` | n/a | 49.6 KB | 51 ms | 56 ms | 62 ms |
| 4. `GET /api/dashboard/my-week` | n/a | 1.2 KB | 22 ms | 33 ms | 35 ms |
| 5. `GET /api/projects` | 15 | 13.3 KB | 14 ms | 16 ms | 18 ms |

### Delta vs. README baseline (concurrency 50)

| Endpoint | README P50/P95/P99 | Post-Phase-1 P50/P95/P99 | ΔP99 | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/issues` | 96 / 112 / 119 | 83 / 91 / 96 | **−23 ms (−19%)** | Mostly DB-audit §3.2 (drop `d.content`, payload 228.5 KB → 185.3 KB) plus DB-audit §1.2 indexes; compression CPU absorbed by the bigger win |
| `GET /api/documents?type=wiki` | 88 / 95 / 99 | 92 / 110 / 118 | **+19 ms (+19%)** | **Loopback regression** — see analysis below |
| `GET /api/team/accountability-grid-v3` | 57 / 64 / 67 | 51 / 56 / 62 | −5 ms | Mostly DB-audit §4.2 (accountability N+1 collapse) |
| `GET /api/dashboard/my-week` | 31 / 48 / 51 | 22 / 33 / 35 | **−16 ms (−31%)** | DB-audit §3.3 two-wave `Promise.all` (8 seq queries → 2 waves) |
| `GET /api/projects` | 20 / 25 / 28 | 14 / 16 / 18 | **−10 ms (−36%)** | DB-audit §4.1a CTE rewrite (no more correlated subplans) |

Req/s (concurrency 50): `/api/projects` 2254 → 3333 (+48%), `/api/dashboard/my-week` 1450 → 2062 (+42%), `/api/issues` 494 → 581 (+18%), `/api/team/accountability-grid-v3` 830 → 937 (+13%), `/api/documents?type=wiki` 560 → 531 (−5%, ties to the wiki regression).

### What the deltas actually measure

This is a **combined** delta, not a pure isolation of API-audit Phase 1. Between the README baseline and now, *both* the database-query-efficiency audit (merged via PR #10, commit `e494b26`) and this branch's Phase 1 landed. Most of the big wins above are pre-existing on `master` and would show up regardless of this branch. The contribution *unique to API-audit Phase 1* on this concurrency-50 row is:

- **§1.1 (compression):** wire bytes drop ~85-90% on every JSON response (verified `/api/openapi.json` 158.5 KB → 18.1 KB, `/api/documents?type=wiki` 176.5 KB → 14.7 KB). Loopback wall-clock doesn't see those bytes saved. CPU cost is real and shows up as the wiki regression.
- **§1.2 (session throttle):** under one-cookie benchmark traffic, drops the per-request `UPDATE sessions SET last_activity` write from every request to one per 60 s. Smoke-test verified end-to-end. Impact on this benchmark is masked by ApacheBench reusing the keep-alive connection (peer-review §"Methodology notes").
- **§1.3 (api_tokens throttle):** identical pattern, no effect on this benchmark which uses session-cookie auth.
- **§1.4 (`idx_api_tokens_hash`):** same — token-auth path isn't exercised by the cookie-based benchmark.

To isolate API-audit Phase 1 alone, compare to a build at `master` HEAD just before this branch. Not done here — `master` already carries the DB wins, so the comparison would be "this branch vs. master HEAD" rather than vs. the README baseline. The four endpoints that *improved* relative to README all owe most of their improvement to DB-audit work that this branch builds on top of.

### The wiki regression

`GET /api/documents?type=wiki` is the only endpoint that moved against us: **+19 ms P99 (+19%)** and **−5% req/s** at concurrency 50. Diagnosis:

- The response is **172 KB of JSON** containing 347 wiki documents.
- Compression turns that into 14.7 KB on the wire (12× ratio), but on loopback there is no wire — the saved bytes never translate into less wall-clock.
- Compressing 172 KB of JSON 300 times across 50 concurrent workers is ~50 MB of compression work in one benchmark run. That's measurable CPU.
- At concurrency 10 and 25 the regression is much smaller or absent (P50: 18 / 43 / 92 vs. README's 18 / 44 / 88 — only the 50-connection number moved meaningfully).

This is the textbook ApacheBench-on-loopback caveat: compression's win is in wire bytes, not server CPU, and the test rig is byte-free. **For any client over a real network** (the SPA over CloudFront, mobile, anything not on the loopback) the 92% byte reduction more than pays back the CPU cost. The peer review called this out: "ApacheBench on loopback won't show much wall-clock improvement, but over CloudFront and real client links this is the single biggest win for perceived latency."

Options if we want this benchmark number to also move in the right direction:

1. **Tune the compression threshold up** so 172 KB still compresses but smaller payloads don't pay the overhead. (Current default: 1 KB. Raising to e.g. 8 KB would skip `/api/dashboard/my-week` (1.2 KB) and other small responses.) Marginal benefit — none of the small endpoints are CPU-bound today.
2. **Pre-encode the wiki tree response** behind a cache (§2.3 / §3.3 work). With `Cache-Control: private, max-age=30` plus a content-hash ETag, the second-and-onward responses in a 60 s window become 304s, paying no compression CPU at all. This is exactly what §2.3 and §3.3 are designed for.
3. **Brotli-static or brotli-precomputed.** Out of scope; this is a JSON API, not a static asset server.

Right call: leave the threshold at 1 KB; tackle wiki specifically via §2.3 + §3.3.

### New gaps surfaced

Two operational issues discovered during the re-run, both pre-existing rather than introduced by this branch but worth recording:

1. **`pnpm db:migrate` short-circuits past pending migrations** when `schema.sql` throws "already exists" on an existing DB. The `schema_migrations` table on `ship_dev` had only 11 rows before this re-run despite migrations 010-043 being applied via side channels. Fixed locally by applying pending migrations one-by-one through `psql -v ON_ERROR_STOP=1`; the underlying script bug remains. Out of scope for this audit — needs a separate fix.
2. **The audit's volume target was 36 users / 718 documents**; the current seed pipeline produces 35 / 717. One off. Not consequential (within run-to-run variance) but worth noting if anyone re-runs and gets a different number.

### Result files

- `audit/api-response-time/results/benchmark.json` — raw `ab` output (re-rendered via `format-results.mjs`).
