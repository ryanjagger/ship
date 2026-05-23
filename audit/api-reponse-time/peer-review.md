# API Response Time Audit — Peer Review (README2)

A second-pass review of `README.md` in this directory. The original audit
measured five endpoints with `ab` against a local server and ranked them by
p99. This review focuses on what the methodology and recommendations missed,
and what would actually move p95/p99 in production.

## What the original audit got right

- Correctly identified that `GET /api/issues` is the heaviest endpoint and
  that returning the full TipTap `content` for every list row is a problem
  (the SELECT does include `d.content` — `api/src/routes/issues.ts:126`).
- Correctly flagged the lack of pagination on the issue list.
- Correctly identified that the dev pool cap of 10 connections
  (`api/src/db/client.ts:20`) is queueing work at 25/50 concurrent.
- Correctly noted that `sessions.last_activity` write contention will
  understate the real-world headroom.
- Correctly suggested expression indexes on the JSONB hot fields used for
  filter/sort (state, priority, source, assignee_id, person_id, week_number).
  See "missed: indexes" below for the specific ones to add.

## What it missed

### 1. Auth + visibility do 4 DB round trips on every authenticated request

The audit treated authentication as a single fixed cost. It is not. Per
authenticated request, the cookie-auth path issues:

1. `SELECT ... FROM sessions JOIN users` — `api/src/middleware/auth.ts:126-133`
2. `SELECT id FROM workspace_memberships ...` — `api/src/middleware/auth.ts:184-187`
3. `UPDATE sessions SET last_activity = $1 WHERE id = $2`
   — `api/src/middleware/auth.ts:205-208`

Then nearly every route handler also calls `getVisibilityContext`, which runs
a **fourth** query that is essentially the same as #2:

```
SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2
```
(`api/src/middleware/visibility.ts:7-11`, called from
`api/src/routes/issues.ts:122`, `api/src/routes/projects.ts:328`,
`api/src/routes/team.ts:1615`, and most others).

So the floor for *any* authenticated GET is 4 sequential DB round trips
before the route does its own work. At 50 connections that floor is
amplified by pool queueing. The audit's measured p50 of 31 ms for
`/api/dashboard/my-week` (which returns 0.8 KB and only point queries) is
almost entirely this fixed overhead — the route itself runs 6 small queries
on top of it.

API-token requests have a similar issue: `validateApiToken` *also* writes
`UPDATE api_tokens SET last_used_at = NOW()` synchronously on every request
(`api/src/middleware/auth.ts:52-55`).

Fix: in `authMiddleware`, return `isAdmin` (from the membership lookup it
already does) on `req` and have `getVisibilityContext` read it from there.
The `last_activity` update should be debounced the same way the cookie
refresh already is (`COOKIE_REFRESH_THRESHOLD_MS`, line 212) — it currently
writes on every single request even though the cookie refresh is throttled
to 60 s. Same for `api_tokens.last_used_at`.

Estimated impact: 2-4 ms off p50 for every endpoint, more under load
because it removes two writes from the contended path.

### 2. `express-session` is mounted with the default in-memory store on *every* request

`app.ts:147-157` mounts `express-session` globally. There is no `store:`
argument, so connect uses `MemoryStore`. Every authenticated request
parses, validates, and (on `saveUninitialized: false, resave: false`) at
minimum reads/touches the session map. This is in addition to the custom
cookie/session_id auth in `middleware/auth.ts`. It only exists so that
`csrf-sync` has somewhere to put its secret.

Two problems:
- It is a process-local memory store. In a multi-instance prod deploy
  (Elastic Beanstalk) the CSRF token bound to one instance will fail on
  any other instance — unless sticky sessions are configured, which CSRF
  failures would silently mask in metrics. This is a correctness bug, not
  just perf.
- It adds set-cookie traffic on responses (signed `connect.sid`) on top of
  the app's own `session_id` cookie — every response in the benchmark
  carries both.

Fix: switch the CSRF mechanism to a stateless double-submit cookie (which
is what `csrf-sync` actually supports via `getCsrfSecret`/`storeCsrfSecret`
overrides — point them at the existing `session_id` row instead of
mounting `express-session`). Or drop `express-session` and store the CSRF
secret in the existing sessions table.

### 3. No HTTP compression

There is no `compression` middleware mounted anywhere (`grep -r
compression api/src` returns nothing). The audit observed `/api/issues` at
228.5 KB and `/api/documents?type=wiki` at 176.5 KB. Both are highly
compressible JSON. With brotli or gzip these drop ~80%. ApacheBench on
loopback won't show much wall-clock improvement, but over CloudFront and
real client links this is the single biggest win for perceived latency.

Note that `helmet` does not enable compression — only security headers.
Cloudfront *may* be doing it at the edge, but the origin should compress
too (or at minimum advertise `Accept-Encoding`-aware caching).

Fix: `import compression from 'compression'; app.use(compression())`. One
line, will not change correctness.

### 4. `GET /api/issues` returns the full TipTap `content` for every issue

The original audit hinted at this ("return lighter list fields"), but
didn't pin it down. The SELECT at `api/src/routes/issues.ts:124-139`
includes `d.content` for every row. With only 200 seeded issues containing
fixture-sized content the response is 228 KB; in production, where issues
have real descriptions, code blocks, and embedded images, this scales
linearly with average issue body size. A single 50-issue ticket discussion
could easily 5x the response.

Fix: drop `d.content` from the list SELECT entirely (the UI doesn't render
it in list view). Detail view at `:id` (line 493) already fetches content.

### 5. The accountability grid SELECTs full `content` for every plan + retro just to call `hasContent()`

`api/src/routes/team.ts:1838-1868` runs:
```
SELECT (properties->>'person_id') ..., id, content
FROM documents WHERE document_type = 'weekly_plan' AND week_number BETWEEN ...
```
…and identical for `weekly_retro`. Then in JS it calls `hasContent(content)`
(line 1878) which only checks whether the text-extracted body, with three
template headings stripped, has length > 0.

That check should be in SQL:
```
length(regexp_replace(jsonb_path_query_array(content, '$.**.text')::text,
       '"What I plan to accomplish this week"|"What I delivered this week"|"Unplanned work"', '', 'g')) > 0
```
or, simpler, store a boolean `has_content` flag on the document when the
collaboration server persists (`api/src/collaboration/index.ts:172`).

With a few hundred plans + retros each carrying 5-50 KB of TipTap JSON,
this single endpoint pulls megabytes from Postgres just to call a JS
function that returns a boolean. Cross-program rollups will scale poorly.

### 6. Missing indexes — specifics

The schema (`api/src/db/schema.sql:353-377`) defines a GIN index on
`documents(properties)` but no expression btree indexes for the actual
filter/sort patterns used in routes. Migrations 001-037 add none either.
The GIN index helps `?` and containment, but **not** for `properties->>'x'
= 'y'` filters with point btree lookups, ranges, or `ORDER BY`.

High-value additions, ranked by route hotness:

```sql
-- Issues list filter+sort (api/src/routes/issues.ts:115)
CREATE INDEX idx_issues_state    ON documents ((properties->>'state'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_issues_priority ON documents ((properties->>'priority'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_issues_assignee ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_issues_source   ON documents ((properties->>'source'))
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;

-- Weekly plan/retro lookup by person+week (dashboard.ts:567, team.ts:1839)
CREATE INDEX idx_weekly_plan_person_week ON documents
  ((properties->>'person_id'), ((properties->>'week_number')::int))
  WHERE document_type = 'weekly_plan' AND deleted_at IS NULL;
CREATE INDEX idx_weekly_retro_person_week ON documents
  ((properties->>'person_id'), ((properties->>'week_number')::int))
  WHERE document_type = 'weekly_retro' AND deleted_at IS NULL;

-- Standup lookup by date (dashboard.ts:648)
CREATE INDEX idx_standups_author_date ON documents
  ((properties->>'author_id'), (properties->>'date'))
  WHERE document_type = 'standup' AND deleted_at IS NULL;

-- Sprint assignee_ids array membership (dashboard.ts:684, team.ts:1693)
CREATE INDEX idx_sprint_assignee_ids ON documents
  USING GIN ((properties->'assignee_ids'))
  WHERE document_type = 'sprint';

-- API token last_used_at writes hit a unique row every request — see #1
-- but the lookup index on token_hash is missing entirely:
CREATE INDEX idx_api_tokens_hash ON api_tokens (token_hash) WHERE revoked_at IS NULL;
```

That last one is notable: `validateApiToken` (`auth.ts:33-39`) filters by
`token_hash = $1` and there is *no* index on `api_tokens.token_hash`. With
N tokens this is a seq scan on every API-token-authenticated request. The
existing indexes (`api/src/db/schema.sql:404-406`) are on `user_id`,
`workspace_id`, `token_prefix` — none of which are queried in the auth
path. As soon as API tokens see real use (CI, CLI, Claude integrations)
this becomes a bottleneck.

### 7. WebSocket collaboration shares the HTTP pool

`setupCollaboration(server)` (`api/src/index.ts:36`) attaches a
WebSocketServer to the same `http.Server` that serves the REST API, and
`persistDocument` (`api/src/collaboration/index.ts:111-179`) writes Yjs
state and JSON content to the same `pool` (max 20 in prod). Each open
document schedules a write every 2 s of activity
(`schedulePersist`, line 181-189). With 20-40 active editors at once,
collaboration writes can fully saturate the connection pool, starving REST
requests. The audit ran no collaboration traffic during the benchmark, so
this is invisible in the numbers.

Worse, `persistDocument` does a `SELECT ... FROM documents WHERE id = $1`
*before* the UPDATE (line 127-130) to fetch existing properties/content —
each persist is two queries, holding two pool slots over a network
round-trip.

Fix options (in order of effort):
- Separate pool for the collaboration server (`new Pool({ max: 10 })`),
  isolating REST from sync write spikes.
- Fold the SELECT into the UPDATE via `RETURNING` or a single statement
  with a CTE.
- Move yjs persistence onto a queue (e.g., `pg-boss`) so saves don't block
  pool slots.

### 8. JSON responses do not advertise cache headers or ETag-friendly identifiers

There is no `Cache-Control`, `ETag`, `Last-Modified`, or `Vary: Cookie`
header set anywhere in `routes/` (`grep -ri etag\|cache-control api/src`
is empty). Express's default behavior emits a weak ETag on `res.json`,
but it is computed *after* serializing the body, so it saves bandwidth
on conditional GETs only, not CPU.

For app-shell endpoints like `GET /api/documents?type=wiki` (the audit
noted this is hit on "nearly every route") this is the lowest-hanging
fruit: `Cache-Control: private, max-age=30, must-revalidate` would cut
the request rate from the SPA by an order of magnitude.

For `/api/dashboard/my-week`, a per-user `Last-Modified` derived from
`MAX(updated_at)` across the plan/retro/standup rows would let the client
do a `If-Modified-Since` and get a 304.

### 9. The "fast" endpoints aren't actually cheap — they just return small payloads

`/api/projects` looks great at p50=20ms, but the SELECT
(`api/src/routes/projects.ts:385-402`) includes two correlated subqueries
counting sprints and issues per project, plus a third large CASE that
joins back to sprints. With 15 projects this is fine; this scales O(N) on
project count with O(M) work per row from the correlated COUNT
subqueries. At ~200 projects it will be visibly slow.

`/api/dashboard/my-week` runs **8 sequential queries** for one response
(`dashboard.ts:504, 521, 567, 590, 615, 648, 684`). Each is small, but
they could be `Promise.all`'d once the workspace-id-dependent ones (#1-2)
return. Currently the 8 queries are strictly sequential, meaning the
endpoint's p50 is roughly 8 × (network RTT to PG + plan time).

### 10. No request logging / APM means you can't see this in production

There is no `morgan`, `pino-http`, OpenTelemetry, Datadog APM, or even
basic `console.time` around request handlers (`grep -r morgan\|pino api/src`
empty). The audit measured local p95 via `ab`; production p95 is
unknown. Until at least access logging with response-time annotations is
on, future audits will have to repeat this synthetic measurement instead
of looking at real traffic.

Fix: `pino-http` is the lightest option; emits structured JSON
including response time. Pair with a slow-query log on Postgres
(`log_min_duration_statement = 100ms`) to catch query regressions.

### 11. `pool.connect()` held for the whole request on PATCH

`api/src/routes/issues.ts:676` acquires a dedicated pool client at the top
of the PATCH handler but does not `BEGIN` until line 918. Between those
lines it does several small queries that could have used `pool.query`
without holding a slot. The Visibility/existing-issue checks at lines
689-698 happen before any write, holding a pool slot for ~5 sequential
network round-trips before the transaction even begins. Under load this
starves the pool faster than a properly scoped transaction would.

Fix: move `pool.connect()` to immediately before `BEGIN` at line 918.

### 12. Issue list `ORDER BY` is unindexable in its current form

```sql
ORDER BY
  CASE d.properties->>'priority'
    WHEN 'urgent' THEN 1
    WHEN 'high'   THEN 2
    ...
  END,
  d.updated_at DESC
```
(`api/src/routes/issues.ts:213-221`). No index covers `(priority_rank,
updated_at desc)`. Even with the suggested
`((properties->>'priority'))` index from #6, the CASE expression can't use
it for ordering. Either:
- Add an expression index on the CASE itself, or
- Store priority as `1..5` integer in properties (encoded), or
- Move to a generated column and index it:
  ```sql
  ALTER TABLE documents ADD COLUMN priority_rank int GENERATED ALWAYS AS (
    CASE properties->>'priority'
      WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5
    END) STORED;
  CREATE INDEX idx_issues_priority_rank_updated ON documents (priority_rank, updated_at DESC)
    WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;
  ```

## What the original audit overstated or mis-prioritized

### "Add pagination to /api/issues" is third-priority, not first

The audit led with pagination. Pagination is correct but its impact on
p95 in this benchmark is small because the row count (200) is small. The
dominant cost is (a) serializing `d.content` for every row (#4 above) and
(b) the per-request auth/visibility floor (#1 above). With those two
fixed and a couple of indexes (#6), the same 200-row list will be near
the floor latency of the auth path. Pagination matters once issue count
> 1k or content size > 5 KB avg, but it should be sequenced after the
real win (drop `d.content`).

### "Cache wiki tree client-side or use ETags" understates the server-side option

The audit suggests client-side caching and ETags for
`/api/documents?type=wiki`. Both are good, but the bigger lever is the
ETag/`Cache-Control` headers from #8 above plus splitting the response
into a tree-only endpoint (id/title/parent_id/position only — under 20 KB
even at 1000 wikis) and a separate per-document fetch. The current
endpoint already excludes `content`, so it isn't pathological — but with
the proposed headers + brotli, the same data drops to ~25-35 KB on the
wire and most requests return 304.

### "Tail latency rises roughly linearly from 10 to 50" is an artifact of pool sizing

The cross-cutting observation attributes this to "the pool's 10
connections" but stops there. It really is the auth/visibility queries
(#1) being write-heavy and serialized, plus the missing
`api_tokens.token_hash` index (#6). Bumping the pool from 10 → 30 would
help, but only because it papers over the redundant queries — fix the
queries first.

## Concrete additional recommendations, ranked by expected impact

| # | Change | Files | Est. p95 impact |
|---|---|---|---|
| 1 | Drop `d.content` from `/api/issues` SELECT | `api/src/routes/issues.ts:126` | -30 to -60 ms on `/api/issues`; payload -50% |
| 2 | Cache `isAdmin` from auth middleware so `getVisibilityContext` doesn't re-query | `api/src/middleware/auth.ts:184`, `middleware/visibility.ts:26` | -3 to -8 ms on every authenticated endpoint |
| 3 | Mount `compression()` | `api/src/app.ts:111` | -60 to -80% wire bytes; big perceived latency win over WAN, near-zero on loopback |
| 4 | Throttle `sessions.last_activity` UPDATE to once every 60 s (like cookie refresh already does) | `api/src/middleware/auth.ts:205-208` | -1 to -3 ms p50 + huge contention drop under load |
| 5 | Add expression indexes from #6 (priority/state/assignee/person+week/standup date) | new migration | -10 to -30 ms on issue list and accountability grid at production volume |
| 6 | Add `idx_api_tokens_hash` index | new migration | -tens of ms per API-token request once any non-trivial number of tokens exist |
| 7 | Replace `MemoryStore` express-session with the existing `sessions` table or drop it entirely | `api/src/app.ts:147` | Correctness in multi-instance deploy + 1-2 ms |
| 8 | Add `Cache-Control: private, max-age=N` + `ETag` (strong, content-hash) to `/api/documents?type=wiki`, `/api/projects`, `/api/programs`, `/api/team/people` | each route | 304s on most repeat hits, ~zero server cost on those |
| 9 | Move team-grid `hasContent` check into SQL or denormalize a boolean | `api/src/routes/team.ts:1838-1868`, `collaboration/index.ts:172` | -15 to -40 ms on accountability grid; scales with plan/retro volume |
| 10 | Separate `Pool` for collaboration persistence | `api/src/db/client.ts`, `collaboration/index.ts:111` | Prevents collab write storms from blocking REST under real usage |
| 11 | Add `pino-http` + Postgres slow-query log | `api/src/app.ts` and PG config | Visibility into real prod p95 |
| 12 | `Promise.all` independent point-lookups in `/api/dashboard/my-week` (plan, retro, prev_retro, standups, allocations all key off person_id) | `api/src/routes/dashboard.ts:567-700` | -10 to -20 ms p50; -30 ms p99 |
| 13 | Pagination + lighter list fields on `/api/issues` | `api/src/routes/issues.ts:115` | Necessary at scale; smaller win at current volume |

## Methodology notes

The benchmark methodology is sound for a local synthetic test, but a few
caveats worth documenting in any follow-up:

- 300 requests is a small sample for p99 — at concurrency 50 that is only
  6 samples per virtual user. Future runs should bump to `-n 3000` for
  meaningful p99.
- `ab` reuses the keep-alive connection; the auth path that gates real
  traffic (cookie auth + CSRF + session middleware) is measured once and
  then short-circuited by Express's keep-alive. This understates per-
  request setup cost.
- The benchmark uses a single session cookie, so the
  `sessions.last_activity` UPDATE contention is on one row — measured
  contention is *worse* than it would be in production with 30 users,
  but the cookie-refresh check (`COOKIE_REFRESH_THRESHOLD_MS`) is on a
  single row too, so still useful as an upper bound.
- The seed produced 200 issues and 347 wikis. Production volume on a
  mature workspace will be 10-100x that, so the "linear with concurrency"
  observation is the *floor* of the curve, not its real shape at scale.
- The audit ran the API in `E2E_TEST=1` mode (`README.md:72`) which
  also short-circuits some logic in `/api/issues/action-items`
  (`api/src/routes/issues.ts:249-252`). For benchmark purposes the right
  flag is the rate-limiter bypass, but make sure other branches don't
  shortcut the work being measured.
