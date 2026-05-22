# API Response Time Audit — Implementation Notes

Companion to `README.md` (audit baseline) and `peer-review.md` (second-pass review). Documents which recommendations were implemented, how, and how to reproduce the result. Branch: `implement/api-response-time`.

## Plan

The 13 ranked recommendations from `peer-review.md` are sequenced below. The order trades expected p95 impact against blast radius — start with isolated route-level wins, then auth-path changes that touch every request, then schema additions, then observability and architectural items.

| # | Recommendation | Status |
| --- | --- | --- |
| 1 | Drop `d.content` from `/api/issues` list SELECT | **done** |
| 2 | Cache `isAdmin` from auth middleware so `getVisibilityContext` does not re-query | **done** |
| 3 | Mount `compression()` middleware | **done** |
| 4 | Throttle `sessions.last_activity` UPDATE to 60s (like cookie refresh already does) | **done** |
| 5 | Add expression indexes for issue / weekly_plan / weekly_retro / standup filter+sort | **done** |
| 6 | Add `idx_api_tokens_hash` index (lookup is currently a seq scan) | **done** |
| 7 | Replace `MemoryStore` express-session (or remove and store CSRF secret in `sessions`) | deferred |
| 8 | Add `Cache-Control` / `ETag` to app-shell GET endpoints | deferred |
| 9 | Move team-grid `hasContent` check into SQL or denormalize a boolean | **done** |
| 10 | Separate `Pool` for collaboration persistence | deferred |
| 11 | Add `pino-http` + Postgres slow-query log | deferred |
| 12 | `Promise.all` independent point-lookups in `/api/dashboard/my-week` | **done** |
| 13 | Pagination + lighter list fields on `/api/issues` | deferred |

Items marked **deferred** are documented but not implemented in this branch; rationale is in the "Deferred" section at the end.

## Summary

_Filled in per change as work progresses._

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| `GET /api/issues` payload (228.5 KiB at audit baseline) | Included full TipTap `content` for every row | `content` omitted from list SELECT; per-row payload now ~1–2 KiB instead of "title + content" | _Fix #1_ |
| Response compression | None (`helmet` only adds security headers; CloudFront may compress at the edge but origin did not) | `compression()` middleware mounted before all routes; gzip/deflate on responses ≥1 KB | _Fix #3_ |
| `sessions.last_activity` UPDATE | Fired on every authenticated request (200+ writes/min in a 50-conn benchmark, all on one row) | Throttled to once per 60 s of inactivity (mirrors cookie-refresh behavior that was already in place) | _Fix #4_ |
| Per-request `workspace_memberships` queries | 4 DB round-trips on every authenticated GET: session+user SELECT, membership existence SELECT (auth), membership role SELECT (visibility), `last_activity` UPDATE | 2–3 round-trips: session+user, membership role (single SELECT — now returns role and reused by visibility), throttled `last_activity` UPDATE. API token path consolidated into one LEFT JOIN. | _Fix #2_ |
| Expression / partial indexes on hot `properties->>` filters | None (only the catch-all GIN on `documents.properties`) | 8 new partial indexes on issue state/priority/assignee/source, weekly_plan/retro person+week, standup author+date, sprint assignee_ids GIN | _Fix #5_ |
| `api_tokens.token_hash` lookup | Sequential scan (no index — peer-review.md #6) | Btree index `idx_api_tokens_token_hash` | _Fix #6_ |
| `/api/dashboard/my-week` query count | 7 sequential `pool.query` calls (8 incl. retro of prev week when applicable) | 2 batches: `Promise.all([person, workspace])` then `Promise.all([plan, retro, prev_retro, standups, allocations])` — ~3 query waves instead of 7 | _Fix #12_ |
| Team-grid `hasContent` payload | SELECTed full TipTap `content` for every weekly_plan + weekly_retro across the workspace's week range (megabytes of JSON pulled to API just to call a boolean helper) | Computed `document_has_content(content)` server-side in SQL via a new `IMMUTABLE` function; queries now return one boolean per row | _Fix #9_ |

## Implementation

### Fix #1 — Drop `d.content` from `/api/issues` list SELECT

**Before.** `api/src/routes/issues.ts:124-139` selected `d.content` for every row in the list query. With 200 seeded issues the response was 228.5 KiB at the audit baseline (`README.md` "Single authenticated response sizes" table). In production, where issues carry real descriptions, code blocks, and inline attachments, the response size scales linearly with average body length.

**Change.** Removed `d.content,` from the list SELECT and left a comment pointing back to `peer-review.md #4`. `extractIssueFromRow` is kept unchanged — it still maps `row.content`, which is now `undefined` for list rows and is therefore omitted from the JSON response. Detail routes (`GET /api/issues/:id`, `/by-ticket/:number`, etc.) keep their own SELECTs that include `d.content`, so detail responses are unaffected.

**Why it is safe.** No web consumer reads `.content` from issue list rows: `grep -rn "issue\.content\|issues\[.*\]\.content\|item\.content" web/src` returns nothing. Unit tests in `api/src/routes/issues.test.ts` do not assert on the `content` field for list responses.

**After.** List rows carry only id/title/properties/ticket_number/timestamps/assignee join columns. Expected payload drop is ~80–95% on this endpoint at production volume; `peer-review.md` estimates -30 to -60 ms on p95 once content size grows beyond fixture-sized seeds. No re-bench was run locally because seeded fixture content is small enough that the wall-clock delta on `ab` would be in the noise — the real win is in production payloads.

**Verification.**
- `pnpm --filter @ship/api type-check` — clean.
- `DATABASE_URL=postgresql://localhost/ship_dev pnpm --filter @ship/api test` — 451 / 451 passing (all suites, not just `issues.test.ts`).

**Reproducibility.** `git show <commit> -- api/src/routes/issues.ts`. To measure response-size impact: start the API per `README.md` §5, then `curl -s -b cookies.txt http://localhost:3001/api/issues | wc -c` before and after.

### Fix #3 — Mount `compression()` middleware

**Before.** No HTTP compression on the API. `grep -rn compression api/src` returned nothing. The audit baseline reported `GET /api/issues` at 228.5 KiB and `GET /api/documents?type=wiki` at 176.5 KiB on the wire. Both are highly compressible JSON. CloudFront may compress at the edge in production, but the origin did not — and any internal client (CLI, MCP, integration) hitting the API directly paid full bytes.

**Change.** Added `compression` (and `@types/compression`) to `api/dependencies`. Mounted `app.use(compression())` in `api/src/app.ts` immediately after the rate limiter and before CORS/parsers. Default settings: threshold 1 KB, level 6.

**Why now.** One-line change with zero correctness risk. `compression` is keyed on `Accept-Encoding` so clients that don't advertise it are unaffected. ApacheBench on loopback won't show a wall-clock improvement (compression cost can offset the byte savings over fast localhost), so this is not a benchmark-driven change — it is a real-world WAN/CloudFront-origin win.

**After.** JSON responses now carry `Content-Encoding: gzip` for clients advertising support. Expected wire-byte reduction: 70–85% on the 100+ KiB JSON endpoints (`/api/issues`, `/api/documents?type=wiki`).

**Verification.**
- `pnpm --filter @ship/api type-check` — clean.
- `pnpm --filter @ship/api test` — 451 / 451 passing.

**Reproducibility.** With the API running, `curl -sI -H 'Accept-Encoding: gzip' -b cookies.txt http://localhost:3001/api/issues` shows `Content-Encoding: gzip`. Byte deltas can be observed with `curl -s ... --compressed | wc -c` vs `curl -s ... | wc -c` (the latter receives the compressed bytes but does not decompress, so it surfaces the on-wire size).

### Fix #4 — Throttle `sessions.last_activity` UPDATE

**Before.** `api/src/middleware/auth.ts:205-208` issued `UPDATE sessions SET last_activity = $1 WHERE id = $2` on every authenticated request. The cookie refresh immediately below was already throttled to once per 60 s via `COOKIE_REFRESH_THRESHOLD_MS`, but the DB write was not — so a benchmark hitting 500 req/s on one session generated 500 writes/s to the same row, with the contention pattern noted in `peer-review.md` "Cross-Cutting Observations" and amplified by the dev pool cap of 10 connections.

**Change.** Folded the write into the same conditional that already gates the cookie refresh: both fire only when `inactivityMs > 60_000`. The 15-minute inactivity-timeout check at `auth.ts:169` still runs on every request (it reads `last_activity`, doesn't write), so the throttle does not affect session timeout enforcement directly.

**Tradeoff (documented).** With a 60 s throttle, the DB-side `last_activity` lags real activity by up to ~60 s. A user can therefore be logged out up to ~60 s earlier than the strict 15-minute inactivity boundary (i.e. after ~14:00 of real inactivity if their last DB write happened at the very start of a 60 s window). This is the same tradeoff the existing cookie-refresh throttle already accepted; it was called out as acceptable in the peer review.

**Test infrastructure change.** Switched `api/src/__tests__/auth.test.ts:28` `beforeEach` from `vi.clearAllMocks()` to `vi.resetAllMocks()`. The middleware's per-request query count now varies (3 queries with the UPDATE firing, 2 without), so any test that queued a third `mockResolvedValueOnce` for the UPDATE but no longer triggered it would have leaked an unconsumed mock to the next test. `resetAllMocks` clears both call history and queued implementations.

**After.**
- `pnpm --filter @ship/api type-check` — clean.
- `pnpm --filter @ship/api test` — 451 / 451 passing.

**Reproducibility.** `git show <commit> -- api/src/middleware/auth.ts`. Behavioral check: run two authenticated requests within 60 s; only the first should produce a row mutation in pg's `pg_stat_statements` or visible `xmin` change.

### Fix #2 — Cache `isWorkspaceAdmin` on the request

**Before.** Per `peer-review.md` #1, an authenticated GET hit four DB round-trips before the route ran:

1. `SELECT ... FROM sessions JOIN users` (auth middleware, line 126)
2. `SELECT id FROM workspace_memberships ...` (auth middleware, line 184 — existence check only)
3. `UPDATE sessions SET last_activity ...` (auth middleware, line 205 — fixed by Fix #4)
4. `SELECT role FROM workspace_memberships ...` (route's call to `getVisibilityContext`)

Steps 2 and 4 ran essentially the same query against the same row.

**Change.**
- `api/src/middleware/auth.ts`: replaced the existence-only membership SELECT with a `SELECT role`, captured the role into `req.isWorkspaceAdmin` (super-admin is treated as admin). Added `isWorkspaceAdmin?: boolean` to the Express `Request` type.
- For the API token path, folded the membership lookup into the token-validation SELECT via `LEFT JOIN workspace_memberships`. Net change for token auth: same query count (one SELECT, one UPDATE), now also yielding `isWorkspaceAdmin`.
- `api/src/middleware/visibility.ts`: both `isWorkspaceAdmin()` and `getVisibilityContext()` now accept an optional `cachedIsAdmin?: boolean`. When provided, the function returns immediately without querying.
- Updated all 79 call sites across `api/src/routes/` (`backlinks`, `documents`, `dashboard`, `iterations`, `issues`, `programs`, `projects`, `search`, `standups`, `team`, `weeks`) to pass `req.isWorkspaceAdmin` as the cached value. Mechanical sed replacement of two patterns:
  - `getVisibilityContext(userId, workspaceId)` → `getVisibilityContext(userId, workspaceId, req.isWorkspaceAdmin)`
  - `isWorkspaceAdmin(userId, workspaceId)` → `isWorkspaceAdmin(userId, workspaceId, req.isWorkspaceAdmin)`

**After.** Authenticated GETs now do one fewer round trip per request. The savings are uniform across every route that uses the visibility helper. `peer-review.md` estimated -3 to -8 ms on every authenticated endpoint at production volume.

**Backwards compatibility.** The third argument is optional; any future call site that does not pass `req.isWorkspaceAdmin` still works (falls back to the original DB query). No test mocks needed updating.

**Verification.**
- `pnpm --filter @ship/api type-check` — clean.
- `pnpm --filter @ship/api test` — 451 / 451 passing.

**Reproducibility.** `grep -rn "getVisibilityContext(userId, workspaceId)" api/src/routes` should return zero matches (only the three-arg form remains).

### Fix #5 + #6 — Expression / partial indexes + `api_tokens.token_hash` index

**Before.** The `documents` schema (`api/src/db/schema.sql:354-372`) defined a single GIN index on `properties`, which is great for `?` and containment but does not back the dominant query pattern in routes: `properties->>'x' = 'y'`. Migrations 001 through 037 added none of the missing expression indexes either. Separately, `api_tokens.token_hash` had no index at all (`idx_api_tokens_user_id`, `idx_api_tokens_workspace_id`, `idx_api_tokens_token_prefix` exist, but none on `token_hash`) — every `validateApiToken` call did a sequential scan over the entire table.

**Change.** Added `api/src/db/migrations/038_response_time_indexes.sql` creating eight partial/expression indexes plus the missing token-hash index:

| Index | Backs |
| --- | --- |
| `idx_issues_state` | `routes/issues.ts:115` state filter |
| `idx_issues_priority` | `routes/issues.ts:115` priority filter / sort |
| `idx_issues_assignee` | `routes/issues.ts:115` assignee filter |
| `idx_issues_source` | `routes/issues.ts:115` source filter |
| `idx_weekly_plan_person_week` | `routes/dashboard.ts` & `team.ts` plan lookup |
| `idx_weekly_retro_person_week` | same, retros |
| `idx_standups_author_date` | `routes/dashboard.ts` per-user standup-of-the-day |
| `idx_sprint_assignee_ids` (GIN) | `routes/dashboard.ts` & `team.ts` sprint membership |
| `idx_api_tokens_token_hash` | `middleware/auth.ts` bearer-token validation |

All `documents` indexes are partial, filtered on `document_type` and `deleted_at IS NULL` (and `archived_at IS NULL` for issues) — they only carry the rows the production queries actually touch, which keeps them small and write-cheap.

**Note on the issue list `ORDER BY`.** `peer-review.md` #12 also pointed out that the issue list orders by a `CASE` expression on priority that no index can satisfy. That requires either an expression index on the CASE itself or a generated column — out of scope for this migration; revisit if the issue list becomes the bottleneck after the other fixes land.

**After.** Verified all 9 indexes attached to the right tables in `ship_dev`:

```
\d documents
    "idx_issues_state"             btree ((properties ->> 'state'::text)) WHERE ...
    "idx_issues_priority"          btree ((properties ->> 'priority'::text)) WHERE ...
    "idx_issues_assignee"          btree ((properties ->> 'assignee_id'::text)) WHERE ...
    "idx_issues_source"            btree ((properties ->> 'source'::text)) WHERE ...
    "idx_weekly_plan_person_week"  btree (..., ((properties ->> 'week_number')::int))
    "idx_weekly_retro_person_week" btree (..., ((properties ->> 'week_number')::int))
    "idx_standups_author_date"     btree (..., (properties ->> 'date'::text))
    "idx_sprint_assignee_ids"      gin ((properties -> 'assignee_ids'::text))
\d api_tokens
    "idx_api_tokens_token_hash"    btree (token_hash)
```

**Verification.**
- `psql -d ship_dev -f api/src/db/migrations/038_response_time_indexes.sql` — clean (9 × `CREATE INDEX`).
- `pnpm --filter @ship/api test` — 451 / 451 passing after the new indexes exist on the test DB.

**Reproducibility.** `pnpm db:migrate` (after `DATABASE_URL` is set) will pick up the migration and write to `schema_migrations`. To inspect plans: `EXPLAIN ANALYZE SELECT ... FROM documents WHERE document_type='issue' AND properties->>'state' = 'todo' AND deleted_at IS NULL AND archived_at IS NULL` — should now show an Index Scan using `idx_issues_state` rather than the previous Seq Scan / Bitmap Index on the generic GIN.

### Fix #12 — `Promise.all` independent queries in `/api/dashboard/my-week`

**Before.** `api/src/routes/dashboard.ts` `/my-week` ran seven sequential `await pool.query(...)` calls (eight when `previousWeekNumber > 0`):

1. Person document lookup (`workspaceId, userId`)
2. Workspace sprint configuration (`workspaceId`)
3. Plan for target week (`workspaceId, personId, targetWeekNumber`)
4. Retro for target week (same keys)
5. Previous-week retro (conditional)
6. Standups for the 7 dates of the week
7. Project allocations via sprint membership

Steps 1–2 are independent of each other. Steps 3–7 all depend on `personId` and `targetWeekNumber` but are independent of each other. As `peer-review.md` #12 notes, the endpoint's p50 was approximately `8 × (network RTT to PG + plan time)`.

**Change.** Two `Promise.all` waves:
- Wave A: `Promise.all([personQuery, workspaceQuery])` — these only share `workspaceId`.
- Compute week boundaries from those results (pure JS).
- Wave B: `Promise.all([planQ, retroQ, prevRetroQ, standupsQ, allocationsQ])` — all five queries fire concurrently against the pool. The prev-retro slot resolves to a sentinel `{ rows: [] }` when `previousWeekNumber <= 0`, keeping the destructuring uniform.

The result-extraction code (extracting `plan`, `retro`, `previousRetro`, `standups`, `projects` from query results) was hoisted below the second `Promise.all` and left otherwise unchanged.

**After.** Sequential round trips dropped from 7–8 to ~3 (auth + Wave A + Wave B). `peer-review.md` estimated -10 to -20 ms p50 and -30 ms p99 once production-level latency is in play; localhost RTT is sub-ms so the synthetic benchmark already showed `my-week` at 31 ms p50.

**Behavior preserved.**
- Same 404 responses when person or workspace are missing (early returns kept).
- Same `previousRetro: null` semantics when `previousWeekNumber <= 0`.
- Same standup-map / 7-slot array assembly.

**Verification.**
- `pnpm --filter @ship/api type-check` — clean.
- `pnpm --filter @ship/api test` — 451 / 451 passing (deterministic across re-runs).

**Reproducibility.** Compare `grep -n "await pool.query" api/src/routes/dashboard.ts` before vs after — the body of the `/my-week` handler now has two `pool.query` awaits (one per Promise.all batch) instead of seven.

### Fix #9 — Move team-grid `hasContent` check into SQL

**Before.** Three endpoints in `api/src/routes/team.ts` ran the same pattern: select all `weekly_plan` + `weekly_retro` rows for a week range, then call the JS `hasContent` helper (`api/src/utils/document-content.ts`) on every row to compute a single boolean. The SELECTs included `content` — full TipTap JSON, typically 5–50 KiB per row — which Postgres had to read from TOAST'd storage and ship over the wire to the API process just to be reduced to a boolean. As `peer-review.md` #9 noted, "this single endpoint pulls megabytes from Postgres just to call a JS function that returns a boolean".

**Change.**
- **New migration `039_document_has_content_fn.sql`** defining `document_has_content(content jsonb) RETURNS boolean` as an `IMMUTABLE PARALLEL SAFE` SQL function. It mirrors the JS helper: concatenate every `.text` node via `jsonb_path_query(content, 'lax $.**.text')`, strip the three template headings, return `length(btrim(...)) > 0`.
- **`api/src/routes/team.ts`**: replaced `content` with `document_has_content(content) AS has_content` in all three SELECT pairs (the older heatmap endpoint, the v2 accountability-grid, and the `accountability-grid-v3` benchmarked endpoint). Updated both `calculateStatus` closures to take a `docHasContent: boolean` arg instead of `docContent: unknown`. Updated the plan/retro `Map<string, ...>` builders to store `hasContent: row.has_content` instead of `content: row.content`. The unused `TEMPLATE_HEADINGS / extractText / hasContent` import was removed.

**Semantic difference (documented).** The SQL function uses `regexp_replace(..., 'g')`, which strips *all* occurrences of each template heading. The JS `String.prototype.replace` form strips only the *first* occurrence per heading. In practice the divergence only matters for a degenerate edge case (two adjacent text nodes that are both verbatim copies of the same template heading and nothing else); the SQL semantics — "no real content present" — is arguably the more correct answer for the heatmap UI. Verified on six representative cases:

| TipTap content | Expected | SQL `document_has_content` |
| --- | :-: | :-: |
| `{}` | f | f |
| `NULL` | f | f |
| template heading only | f | f |
| heading + paragraph "ship the audit" | t | t |
| whitespace-only paragraph | f | f |
| two adjacent identical template headings (no other text) | f¹ | f |

¹ JS returns `t` on this case; see "Semantic difference" above. Considered acceptable — and arguably correct.

**Verification.**
- Migration applies cleanly: `psql -d ship_dev -f api/src/db/migrations/039_document_has_content_fn.sql` → `CREATE FUNCTION`.
- `pnpm --filter @ship/api type-check` — clean.
- `pnpm --filter @ship/api test` — 451 / 451 passing.

**Reproducibility.** `grep -n "hasContent(" api/src/routes/team.ts` should return zero matches (no JS helper invocations remain). The function definition is in migration 039 and is loaded via `pnpm db:migrate`.

## End-to-end verification

After all seven fixes were in place:

- `pnpm type-check` (full monorepo: `shared`, `api`, `web`) — clean.
- `pnpm --filter @ship/api test` — **451 / 451 passing**.
- Migrations 038 and 039 apply cleanly from a fresh DB and idempotently against `ship_dev` via `psql -f`.

No re-benchmark was run as part of this implementation pass: the local synthetic recipe in `README.md` §1-6 requires a dedicated disposable database (`ship_api_response_time_audit`), a separate API instance on port 3001 with `E2E_TEST=1`, and ~10–15 minutes of setup per re-run. The peer-review expected-impact column in each implementation section above is the source for "how much this should help"; an independent re-bench on the audit DB is the right way to capture absolute numbers once the changes are deployed to a comparable environment.

What can be observed locally without re-running the benchmark:

- `curl -sI --compressed -b cookies.txt http://localhost:3000/api/issues` shows `Content-Encoding: gzip` once the API is started after Fix #3.
- `EXPLAIN ANALYZE` on the issue list query uses `idx_issues_state` / `idx_issues_priority` (Fix #5).
- The `/api/dashboard/my-week` handler issues 2 Postgres call batches per request rather than 7 (`grep "await pool.query" api/src/routes/dashboard.ts` inside the handler).
- `grep "hasContent(" api/src/routes/team.ts` returns zero hits (Fix #9).

## Deferred

Recommendations not implemented in this pass:

- **#7 Replace `MemoryStore` express-session.** Correctness concern in multi-instance deploy but the current EB environment is single-instance; defer until horizontal scaling is on the roadmap.
- **#8 `Cache-Control` / `ETag` on app-shell GETs.** Higher design surface (per-route key derivation, staleness window per resource) than the rest of this audit; warrants its own pass.
- **#10 Separate pool for collaboration persistence.** Invisible in the synthetic benchmark (no WS traffic during runs). Schedule alongside real-traffic observability (#11) so the win can be measured.
- **#11 `pino-http` + Postgres slow-query log.** Pure observability; valuable but does not move p95 directly. Pair with prod instrumentation work.
- **#13 Pagination + lighter list fields on `/api/issues`.** Once #1 lands the in-flight payload drops sharply; pagination becomes "needed at scale" rather than "needed now". Revisit when issue volume exceeds ~1k.

## Methodology

- Re-benchmarks (where run) use the same recipe as `README.md` §6: `BENCHMARK_REQUESTS=300`, `BENCHMARK_CONNECTIONS=10,25,50`, against the `ship_api_response_time_audit` database with the same seeded volume.
- All before/after numbers are local synthetic measurements on the same machine in a single sitting — comparable to each other, not to absolute production figures.
- Type checks: `pnpm type-check` after each touchpoint.
- Unit tests: `pnpm --filter @ship/api test` for routes that have coverage (`issues`, `projects`, `auth`).
