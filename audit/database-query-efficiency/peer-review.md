# Peer Review: Database Query Efficiency Audit

This is an independent review of `README.md`. It adds findings the original missed, calls out a few overstatements, and re-orders recommendations by likely query-time impact at production scale.

The original audit was run against ~720 documents. Several issues below are latent at that size and become severe at ~10x.

---

## What the original audit got right

- `GET /api/projects` correlated subplans are the dominant cost. The CTE rewrite plan is correct.
- `idx_documents_title_trgm` for `ILIKE '%term%'` search is the right fix — `/api/search/mentions` and `/api/search/learnings` both do this (`api/src/routes/search.ts:41-44`, `:67`, `:132`).
- App-shell query count reduction is genuinely the biggest single win for total queries-per-page. Most flows are not bottlenecked on any one query — they're bottlenecked on the count of queries.
- `getBelongsToAssociationsBatch` (`api/src/utils/document-crud.ts:148`) is correctly identified as the working pattern. The pity is that only `GET /api/issues` uses it.

---

## What the audit missed

### 1. The JSONB filter columns have no usable index

This is the largest missed finding. The single `idx_documents_properties USING GIN (properties)` (schema.sql:357) only accelerates containment / key-existence operators (`@>`, `?`, `?&`, `?|`). It does **not** accelerate the dominant filter pattern in this codebase:

```sql
WHERE (properties->>'state')::... = '...'
WHERE (properties->>'assignee_id')::uuid = $N
WHERE (properties->>'owner_id')::uuid = $N
WHERE (properties->>'author_id')::uuid = $N
WHERE (properties->>'sprint_number')::int = $N
WHERE (properties->>'project_id') = $N
WHERE (properties->>'date') = $N         -- standups
```

Every one of these is a sequential scan over the matching `(workspace_id, document_type)` rows. Grep shows ~28 routes joining on these expressions. Examples:

- `api/src/routes/weeks.ts:325` — correlated `op.id = (d.properties->>'owner_id')::uuid` subquery in the active-sprints list.
- `api/src/routes/team.ts:131` — `i.properties->>'assignee_id' IS NOT NULL` plus a `LEFT JOIN documents person_doc ON person_doc.properties->>'user_id' = d.properties->>'assignee_id'`. With 200 issues × 36 people, this is a hash join the planner cannot optimize.
- `api/src/routes/standups.ts:62-63` — idempotency check on `(workspace_id, document_type, author_id, date)` runs on every standup POST and is fully sequential.
- `api/src/routes/accountability.ts` → `api/src/services/accountability.ts:167, 181, 192, 256, 386, 411, 461, 528` — at least 8 queries per `/api/accountability/action-items` request, all filtering on `properties->>` expressions.
- `api/src/routes/dashboard.ts:102`, `:188`, `:230` — three queries on `/api/dashboard/my-work`, each filtering on `(properties->>'assignee_id'|'owner_id')::uuid`.

The original audit recommended four targeted expression indexes (`sprint_project_week`, `weekly_plan_lookup`, `weekly_retro_lookup`, `person_user_id`-already-exists) and that's a good start, but the broader pattern — assignee/owner/author lookups across all document types — is unindexed.

**Recommended additions:**

```sql
-- The single most-touched property in the codebase
CREATE INDEX IF NOT EXISTS idx_documents_assignee_id
  ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue' AND deleted_at IS NULL;

-- Owner_id is used for projects, sprints, programs
CREATE INDEX IF NOT EXISTS idx_documents_owner_id
  ON documents (workspace_id, document_type, (properties->>'owner_id'))
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- Standup author_id+date lookup (idempotency check + status check + dashboard)
CREATE INDEX IF NOT EXISTS idx_documents_standup_author_date
  ON documents ((properties->>'author_id'), (properties->>'date'))
  WHERE document_type = 'standup' AND deleted_at IS NULL;

-- Sprint by sprint_number (replaces multiple full scans of all sprints)
CREATE INDEX IF NOT EXISTS idx_documents_sprint_number
  ON documents (workspace_id, ((properties->>'sprint_number')::int))
  WHERE document_type = 'sprint' AND deleted_at IS NULL;
```

The original `idx_documents_sprint_project_week` is fine but the more selective shape is `(workspace_id, sprint_number)` because most queries don't filter by `project_id` — they read it from the row.

### 2. `idx_documents_active` is not being chosen for `GET /api/issues`

The audit reports that the issues list query uses `idx_documents_document_type`. That index is just `(document_type)` — strictly worse than `idx_documents_active(workspace_id, document_type) WHERE archived_at IS NULL AND deleted_at IS NULL`, whose predicate exactly matches the query (`api/src/routes/issues.ts:137, 143`). The planner is picking the wrong index.

This is usually one of:
- Statistics out of date (`ANALYZE documents`).
- The visibility filter `(visibility = 'workspace' OR created_by = $userId OR $isAdmin = TRUE)` makes the planner think the result set is large enough to seq-scan, ignoring the partial index.
- The active index includes `document_type` after `workspace_id`, so the planner thinks the leading column workspace selectivity is weak in single-workspace dev environments.

Suggested fix: `ANALYZE documents` after seeding, and consider re-ordering the active index columns to `(document_type, workspace_id)` since `workspace_id` has very low cardinality in a typical workspace install and `document_type` is more selective.

### 3. Application-level N+1 — `checkMissingStandups` is genuinely 1+2N

The audit listed `accountability/action-items` as having "N+1 risk" but undersold it. Looking at `api/src/services/accountability.ts:160-232`:

1. One query to find active sprints with assigned issues (1).
2. For each active sprint: one query for today's standup (N).
3. For each sprint without a today-standup: one query for `MAX(created_at::date)` of last standup (≤N).

Plus `checkSprintAccountability` (`:262-321`) does the same — one query for sprints, then one `COUNT(*)` per sprint for `issue_count`. With multi-sprint allocations, this multiplies.

The whole accountability path can be a single SQL with grouped joins. At 35 sprints × 36 users this is fine; once the workspace has 12 months of weekly sprints, it becomes a real cost.

### 4. PATCH `/api/documents/:id` can leak transactions on validation errors

`api/src/routes/documents.ts:594-1098` opens a transaction (`client.query('BEGIN')` at :645) then has several early `res.status(...).json(...); return;` paths AFTER BEGIN that never run ROLLBACK:

- `:732` — `Only workspace admins can set the reports_to field`
- `:795` — `Only the document creator can change its type`
- `:802` — `Cannot change to or from program or person document types`
- `:839` — `No fields to update`

The `client.release()` in finally returns the connection to the pool with an open transaction. Postgres will eventually time it out via `idle_in_transaction_session_timeout` (which is **not set** on the connection — only `statement_timeout: 30000` is configured in `api/src/db/client.ts:25`). Until then the connection holds row locks acquired by prior reads in the same transaction.

This is a correctness and pool-starvation issue, not just a perf one. Same shape exists in `api/src/routes/issues.ts:719` (early return from PATCH /issues/:id after `client.query('BEGIN')` — actually safer there because BEGIN comes later, but worth auditing every transactional handler).

**Fix:** Move BEGIN after all input validation, OR add explicit ROLLBACK before the early returns.

**Defense-in-depth:** add `idle_in_transaction_session_timeout: '15s'` to the pool config or set it server-side.

### 5. `pg.Pool` config does not match production load

`api/src/db/client.ts:17-26`:

```ts
max: isProduction ? 20 : 10,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 2000,
maxUses: 7500,
statement_timeout: 30000,
```

Things missing or wrong:
- `connectionTimeoutMillis: 2000` is aggressive when paired with `max: 20`. Under any sudden burst the pool will reject requests with a connection-acquire error instead of queuing. Either raise to 5-10s or expect 502s on traffic spikes.
- No `query_timeout` or `idle_in_transaction_session_timeout`.
- `statement_timeout: 30000` is OK as a DDoS cap but is also long enough that a slow query will sit on a connection for half a minute. Most app queries here finish in <10ms — a 5s timeout would be more useful as an alarm.
- The pool is shared between HTTP handlers and the WebSocket collaboration server. There is no separate pool for the long-lived collaboration writes, so a Yjs-state write storm can starve API requests. (See `api/src/collaboration/index.ts` usage of `pool` — same pool.)

### 6. Bulk inserts of associations are individual statements inside transactions

The audit didn't mention this. Multiple hot paths do per-item INSERTs in a loop:

- `api/src/routes/documents.ts:544-552` (POST /api/documents) — one INSERT per `belongs_to` entry.
- `api/src/routes/documents.ts:865-874` (PATCH /api/documents/:id) — diff-based: per-row DELETE then per-row INSERT.
- `api/src/routes/issues.ts:627-634` (POST /api/issues) — one INSERT per association.
- `api/src/routes/issues.ts:944-953` (PATCH /api/issues/:id) — DELETE-all then per-row INSERT.
- `api/src/routes/programs.ts:813-826` (POST /api/programs/:id/merge) — per-child INSERT into `document_history`.
- `api/src/routes/team.ts:570-577` (POST /api/team/assign) — loop of UPDATEs to remove a person from conflicting sprints.
- `api/src/utils/document-crud.ts:206-212` (`syncBelongsToAssociations`) — same antipattern; currently unused but documented as the canonical helper.

The right shape (already used in `api/src/routes/backlinks.ts:127-138`) is a single multi-VALUES INSERT or `unnest($1::uuid[], $2::text[], $3::text[])`. None of these loops will dominate a single request, but during a bulk import (Claude auto-creating issues, sprint board "assign 20 people" flow) they add measurable latency.

### 7. `document_links` has no `workspace_id` column

`api/src/db/schema.sql:313-319`. The `backlinks.ts:39-50` query has to join through `documents d` to recover the workspace, then filter via the visibility predicate. This works but means `idx_document_links_target ON document_links(target_id)` returns rows that may not even belong to the same workspace before the join filters them out.

For typical use this is fine. If link counts grow into the millions, adding `workspace_id` to `document_links` (with `idx_document_links_workspace_target`) would let the index do the workspace filter.

### 8. `ticket_number` is unindexed but read via MAX under an advisory lock

`api/src/routes/issues.ts:594-600`, `api/src/routes/documents.ts:817, 1244, 1426`, `api/src/routes/feedback.ts:79`:

```sql
SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
FROM documents
WHERE workspace_id = $1 AND document_type = 'issue'
```

This is run under `pg_advisory_xact_lock` for every issue create. Without an index on `(workspace_id, document_type, ticket_number DESC)`, this aggregate scans every issue in the workspace. With 200 issues per workspace it's fast; at 50,000 issues it will be the bottleneck of issue creation, and worse, it serializes through the advisory lock so multi-user concurrent creates pile up.

Two improvements:
- Add `CREATE INDEX idx_documents_issue_ticket ON documents (workspace_id, ticket_number DESC) WHERE document_type = 'issue';` — turns MAX into an index-only scan of one row.
- Or replace with a per-workspace sequence stored on the workspaces table, incremented atomically; advisory lock can be dropped entirely.

### 9. The `documents.content` JSONB column is selected unnecessarily

The audit flagged this for `/api/issues` but missed several other endpoints that pull `content` into the list payload:

- `api/src/routes/weeks.ts:1856-1866` (sprint standups list) selects `d.content` for every standup in the sprint.
- `api/src/routes/weekly-plans.ts:990-1009` selects `content` for every weekly_plan AND every weekly_retro for a project — twice. This is the project allocation grid endpoint; it's run on every project detail page.
- `api/src/routes/dashboard.ts:399-409` (my-focus) selects `content` for every weekly_plan in the current and previous week across all the user's allocated projects.
- `api/src/routes/dashboard.ts:567, :591, :649` — all select `content` for retro/standup lookups.

The `content` JSONB stores full TipTap document trees. For a populated retro it can be tens of KB. List endpoints should select only the columns they read; if they need to determine "has content" they should select `(content IS NOT NULL) as has_content` or a length probe.

### 10. `yjs_state` is BYTEA on the same row as everything else

`documents.yjs_state BYTEA` (schema.sql:116) lives on the main `documents` row. Postgres TOAST will out-of-line large values, but every `SELECT *` (and there are several: `api/src/routes/issues.ts:957`, `api/src/routes/documents.ts:934`, the `RETURNING *` in inserts) detoasts the column for no reason. Worse, in `api/src/routes/documents.ts:668` an update sets `yjs_state = NULL` whenever content is patched — this is a write-then-read of a TOAST page on a hot path.

If yjs_state were moved to a separate `document_yjs(document_id PK, state bytea)` table with `LEFT JOIN` semantics, all the existing `SELECT *` callers would skip the BYTEA entirely. This is a bigger refactor; flagged for future.

### 11. `getAllocations` does `SELECT DISTINCT ON (project_id)` after a UNION — efficient locally, but unindexed

`api/src/utils/allocation.ts:33-70`. The query has two arms; both filter on:

- `s.properties->>'sprint_number')::int = $3` — no index.
- `s.properties->'assignee_ids' @> to_jsonb($2::text)` — this **can** use the `idx_documents_properties GIN` index, but only if the planner knows it.
- `(i.properties->>'assignee_id')::uuid = $4` — no index.

This function is called twice per accountability check (`accountability.ts:117, 122`). For each project allocation, the accountability service then issues additional queries. Combined with the N+1 over standups, a single `/api/accountability/action-items` request can easily run 15-25 queries.

### 12. Dashboard `/api/dashboard/my-week` does 7+ sequential queries

`api/src/routes/dashboard.ts:498-729`. Each of these is sequential (no `Promise.all`):

1. Person doc lookup.
2. Workspace start date.
3. Plan for week N.
4. Retro for week N.
5. Previous retro for week N-1.
6. Standups for the week (in `ANY($3)`).
7. Project allocations for the week.

Items 3-7 are independent and could run in parallel via `Promise.all` — would cut wall-clock latency by ~5x without changing query count. The audit listed this endpoint as the slowest user flow ("Load main page" = `GET /api/dashboard/my-week`) at 3.42ms; with 5 of 7 queries parallelized it should drop to ~1ms wall-time.

### 13. `getSprintAccountability` runs a COUNT(*) per sprint instead of a grouped scan

`api/src/services/accountability.ts:262-321`. The outer query finds all sprints the user owns; then the loop issues a `COUNT(*)` for each one (`:297-306`). One LEFT JOIN with GROUP BY on the outer query would eliminate the N queries.

### 14. `team.ts:265` (`GET /api/team/assignments`) selects all sprints then all issues with assignees

The assignments grid does:

- One query for all sprints with non-empty `assignee_ids` in the workspace.
- One query for all issues with assignees, joining to their sprints and projects (`:349-372`).

Both queries are unbounded — no LIMIT, no sprint_number filter. As the workspace ages, both grow without bound and this endpoint becomes the new sprint-board cost.

### 15. The visibility filter prevents the partial-index hit in several places

`VISIBILITY_FILTER_SQL` injects `(d.visibility = 'workspace' OR d.created_by = $userId OR $isAdmin = TRUE)` into nearly every list query. When `isAdmin` is bound as a parameter and is `TRUE`, the planner can't prove the filter is trivially true without seeing the bound value — meaning even admin queries scan as if the filter applied. Newer Postgres (14+) handle this with generic vs custom plans, but the boolean OR shape defeats the index in some routes.

If the filter were rewritten to short-circuit at the application layer for admins (don't append the visibility clause at all if `isAdmin === true`), several queries would index-only scan instead of bitmap scan. The implementation would be a single line in `VISIBILITY_FILTER_SQL` returning `'TRUE'` for the admin case.

### 16. `documents.created_by` indexed only via `(visibility, created_by)`

`idx_documents_visibility_created_by` (schema.sql:362). The intent is to help the visibility OR-clause, but the planner usually cannot use compound indexes for OR predicates. A `WHERE created_by = $1` lookup (used in `documents.ts` for "documents I created" filters and in the visibility clause) cannot use this index because `visibility` comes first. If you keep the OR-based visibility shape, drop this index and instead add `idx_documents_created_by ON documents(created_by) WHERE deleted_at IS NULL`.

---

## What the audit overstated or mis-prioritized

### Sprint board reduction plan is over-confident

The audit's target ("65 → 32 or fewer queries") assumes removing the deprecated global providers is purely client-side. It is — but the queries themselves are not the cost; each runs in 0.5-2ms locally. The user-visible improvement on a real network will mostly be network round-trip reduction, not DB time saved. The DB-side win is small. The audit should re-frame this as a frontend / network win rather than a DB-efficiency win.

### `GET /api/projects` "slowest query" framing

At 2.679ms on 15 projects with 200 issues and 35 sprints, the project list query is fine. The correlated subplan structure is wrong-shaped, yes, but the absolute time is dominated by row-formatting and visibility filtering, not the correlated count subplans. Rewriting it as CTEs is still a good idea — but at this dataset size you will not measure a 50% improvement. The audit's "<1.34ms" target is plausible only after pg_trgm and the partial index work also land. Suggest framing the rewrite as "structural fix that scales linearly with project count" rather than "50% wall-clock today."

### `idx_documents_active_type_position` for wiki order

The audit recommends adding a partial index covering `(workspace_id, document_type, position ASC, created_at DESC)`. At 347 active wiki rows, a sequential scan + in-memory sort is roughly free. The wiki order index is fine to add but ranks low in impact; it should not be in the "Reduction Plan" top items.

### Search/index work is undersold

The trigram index is more important than the audit positioned it. `/api/search/mentions` and `/api/search/learnings` are both leading-wildcard `ILIKE` queries that will degrade O(n) with document count. At 720 docs the existing seq-scan is sub-ms; at 50,000 docs it will be hundreds of ms. This belongs in the top three near-term wins, not "follow-up."

---

## Recommendations, re-ordered by estimated query-time impact

Numbers below are rough order-of-magnitude; precise gains require running against a 10x-seeded database.

1. **Add expression indexes on JSONB filter columns** (assignee_id, owner_id, author_id+date, sprint_number, project_id where the property is the lookup key). Affects ~60% of all queries in the codebase. Largest single win.

2. **Add the trigram index now**, not as follow-up. Two `ILIKE '%term%'` endpoints become O(log n) instead of O(n).

3. **Fix the transaction leak in `PATCH /api/documents/:id`** (and audit all other transactional handlers for the same pattern). This is correctness, not perf, but the pool starvation it causes will look like perf regressions in prod.

4. **Set `idle_in_transaction_session_timeout`** on the pool (defense in depth for #3).

5. **Rewrite `checkMissingStandups` and `checkSprintAccountability` as single grouped queries.** Removes 8-15 queries per `/api/accountability/action-items` call.

6. **Parallelize the independent queries in `GET /api/dashboard/my-week`** via `Promise.all`. Free latency win, no query-count change.

7. **Rewrite `GET /api/projects` with CTEs** (already in original plan, keep it).

8. **Add an issue ticket-number index** `(workspace_id, ticket_number DESC) WHERE document_type = 'issue'`. Eliminates a full table scan from every issue create.

9. **Stop selecting `content` in list endpoints** — `weekly-plans.ts:990-1009`, `weeks.ts:1856`, `dashboard.ts:399-409`, `dashboard.ts:567-649`. Replace with `has_content` derivation or fetch on detail only.

10. **Short-circuit the visibility filter for admins** at the application layer. Affects every list query.

11. **Batch the per-item INSERTs for `document_associations`** in documents.ts, issues.ts, and programs.ts merge. Per-request gain is small but each bulk operation matters.

12. **Re-analyze `documents`** after seed and consider re-ordering `idx_documents_active` columns. May fix the wrong-index-chosen issue.

13. **Add `workspace_id` to `document_links`** + composite index. Long-term scale only.

14. **Move `yjs_state` to a side table.** Big refactor; only pursue if BYTEA detoasting shows up in profiling.

15. **Drop dead code** in `accountability.ts:445` (`checkMissingSprintReviews`) and `:517` (`checkProjectRetros`) — both functions are defined but never called from `checkMissingAccountability`. Not perf, but it's confusing future work.

---

## File reference quick-list

| File:line | Issue |
| --- | --- |
| `api/src/db/client.ts:17-26` | Pool config gaps |
| `api/src/db/schema.sql:357` | GIN on `properties` is the wrong index shape for `->>` filters |
| `api/src/db/schema.sql:362` | `idx_documents_visibility_created_by` won't help `WHERE created_by = $1` |
| `api/src/db/schema.sql:367` | `idx_documents_active` — verify it's being chosen |
| `api/src/middleware/visibility.ts:49-55` | OR-shaped filter defeats partial indexes |
| `api/src/middleware/auth.ts:126-208` | Two queries per request (session + membership) — known cost |
| `api/src/routes/documents.ts:645, 732, 795, 802, 839` | Transaction-leak paths |
| `api/src/routes/documents.ts:817` | Unindexed MAX(ticket_number) under advisory lock |
| `api/src/routes/issues.ts:115-238` | List query joins person_doc on unindexed expression |
| `api/src/routes/issues.ts:594-600` | Same MAX(ticket_number) scan |
| `api/src/routes/issues.ts:944-953` | Per-association INSERT in loop |
| `api/src/routes/projects.ts:343-396, 430-475` | Correlated subplan duplicated in list + detail |
| `api/src/routes/team.ts:265-457` | Assignments endpoint is unbounded |
| `api/src/routes/team.ts:570-577` | UPDATE per conflicting sprint in `/api/team/assign` |
| `api/src/routes/weeks.ts:321-356` | 7 correlated subselects per sprint row |
| `api/src/routes/weeks.ts:750-784` | Same pattern repeated in `/api/weeks/:id` |
| `api/src/routes/weekly-plans.ts:990-1009` | Selects `content` for every plan + retro on a project |
| `api/src/routes/dashboard.ts:148-191` | Inferred-status correlated subplan repeated again |
| `api/src/routes/dashboard.ts:498-729` | 7 sequential queries that could be `Promise.all` |
| `api/src/routes/standups.ts:56-65, 168-179` | Idempotency + range queries with no `(author_id, date)` index |
| `api/src/routes/comments.ts:24-32` | Comments list — no `(document_id, workspace_id)` composite |
| `api/src/services/accountability.ts:160-232` | N+1 over standups |
| `api/src/services/accountability.ts:262-321` | N+1 over sprint issue counts |
| `api/src/services/accountability.ts:445, 517` | Dead code (never called) |
| `api/src/utils/document-crud.ts:148-181` | `getBelongsToAssociationsBatch` — the canonical pattern, used too rarely |
| `api/src/utils/document-crud.ts:206-212` | `syncBelongsToAssociations` — unused, but documented as the pattern |
| `api/src/utils/allocation.ts:33-70` | Called twice per `/api/accountability/action-items` |
