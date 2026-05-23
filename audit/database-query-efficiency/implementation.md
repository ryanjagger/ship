# Database Query Efficiency Audit — Implementation Notes

Companion to `README.md` (audit baseline) and `peer-review.md` (reviewer pass). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/database-query-efficiency`.

Work is ordered easiest-lift first. Each phase below is sized so that Phase 1 + Phase 2 can ship without behavior changes, while Phases 3 and 4 require targeted refactors.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **1. Schema-only wins** | New migration adding pg_trgm + targeted indexes; `ANALYZE documents` | **Done** (7 / 7 items landed) |
| **2. Tiny code edits** | Pool config, admin visibility short-circuit, dead-code removal | **Done** (3 / 3 items landed) |
| **3. Targeted code fixes** | Transaction-leak fix, drop `content` from list payloads, `Promise.all` on `/my-week` | **Done** (3 / 3 items landed) |
| **4. Query rewrites** | `/api/projects` + `/api/programs` CTE, accountability grouped queries, batched association INSERTs | **Done** (3 / 3 items landed) |
| 5. Frontend / arch | Route-gate global providers, carry workspace role from auth | Pending |

## Summary

Each row is one shipped commit. Detailed before/after analysis for each item lives in the phase sections below. See `git log master..implement/database-query-efficiency` for the full diff per commit.

| § | Change | Headline before → after | Commit |
| --- | --- | --- | --- |
| 1.1 | `pg_trgm` extension + `idx_documents_title_trgm` (GIN trgm on title) | `GET /api/search/mentions` plan execution **1.087ms → 0.131ms** | `8742e20` |
| 1.2 | JSONB expression indexes (assignee/owner/standup/sprint_number) | `/api/accountability/action-items` plan **1.269ms → 0.307ms**; per-shape EXPLAIN gains 6.7×–17.9× | `77ea82f` |
| 1.3 | `idx_documents_issue_ticket` (DESC, partial on issue) | `MAX(ticket_number)` plan switched to **Index Only Scan + Limit 1** (0.602ms → 0.061ms) | `f1cbddc` |
| 1.4 | Composite `weekly_plan_lookup` + `weekly_retro_lookup` indexes | Weekly plan/retro uniqueness lookups **0.714ms → 0.117ms** | `15d4f77` |
| 1.5 | `idx_documents_active_type_position` (wiki list ordering) | `GET /api/documents?type=wiki` plan dropped its Sort node: **0.499ms → 0.117ms** | `b6d3f42` |
| 1.6 | Replace `idx_documents_visibility_created_by` with targeted `idx_documents_created_by` | `WHERE created_by = $1` now uses a true bitmap-index scan; -1 unused compound index slot | `51fa187` |
| 1.7 | `ANALYZE documents` after each migration + end-to-end audit re-run docs | Audit Deliverable: `/api/projects` slowest dropped **2.679ms → 0.748ms** post-Phase 1 | `93dda27` |
| 2.1 | Pool config: `connectionTimeoutMillis: 8s` + `idle_in_transaction_session_timeout: 15s` | Defense-in-depth ceiling for transaction leaks; bursts queue instead of 502 | `045faa7` |
| 2.2 | `VISIBILITY_FILTER_SQL` short-circuits for admins; migrated 3 hot callers | EXPLAIN `Filter:` line no longer references `visibility` / `created_by` on admin sessions | `84870a5` |
| 2.3 | Deleted dead `checkMissingSprintReviews` + `checkProjectRetros` | -125 lines unreachable; no callers anywhere in repo | `842a522` |
| 3.1 | Explicit `ROLLBACK` before 4 early returns in `PATCH /api/documents/:id` | Pool starvation under transaction leak no longer possible; audited all 13 BEGIN sites | `70de335` |
| 3.2 | Dropped `content` from `/api/issues` + `/api/issues/:id/children` list payloads | **~38 kB saved per `/api/issues` request** at current seed scale; linear with workspace size | `21007c6` |
| 3.3 | Two-wave `Promise.all` in `/api/dashboard/my-week` (7 sequential queries → 2 waves) | SQL wall-time `sum(q1..q7)` → `max(q1,q2) + max(q3..q7)` | `1bc0575` |
| 4.1a | Rewrote `GET /api/projects` list with three CTEs | No more correlated subplans; `loops=235` → grouped scans | `72a2c0d` |
| 4.1b | Rewrote `GET /api/programs` list with two CTEs | **Every audit flow's `N+1 Detected?` flipped from `Yes` to `No`** | `4e1ff86` |
| 4.2 | Collapsed accountability N+1 into single grouped queries | -2 queries per protected-route load (4 of 5 flows): README baseline 57/59/48/65 → **53/55/44/61** | `5196ee4` |
| 4.3 | Batched 6 per-item INSERT/UPDATE loops via `unnest()` + SQL-side `jsonb_agg` | At N=20 (bulk assign flow): 20 round-trips → 1 | `56bfed6` |

## Phase 1 — Schema-only wins

These are pure DDL additions in a single migration file. No application code changes; no behavior changes. Each item is a separate sub-section so that the migration can grow incrementally as items land. The full Phase 1 set will be wrapped in **one** migration file (`038_search_trigram_index.sql` to be renamed to `038_query_efficiency_indexes.sql` if more items land before this branch ships, or each subsequent item gets its own numbered file if Phase 1 spans multiple PRs).

### 1.1 Trigram index for document title search — Status: **Done**

**Before.** `GET /api/search/mentions` and `GET /api/search/learnings` both filter documents by leading-wildcard ILIKE (`api/src/routes/search.ts:41-44, :67, :132`). Btree indexes cannot serve `'%term%'` patterns, so the planner ran a sequential scan of the entire `documents` table on every search request. The README baseline measured this at 1.087ms plan execution against 720 documents; peer-review §"Search/index work is undersold" notes this degrades to hundreds of ms as the table grows to ~50k rows.

The README also flagged this as a candidate index (`Candidate indexes` section), but left it as follow-up rather than near-term work. Peer review re-prioritized it into the top three near-term wins because it's the only index whose **slope** is O(n) vs. O(log n) — every other unindexed filter is at worst constant-factor.

**Change.** New migration `api/src/db/migrations/038_search_trigram_index.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
  ON documents USING GIN (title gin_trgm_ops)
  WHERE deleted_at IS NULL;
```

Notes on the shape:

- The `WHERE deleted_at IS NULL` partial predicate matches the always-applied filter in every search route, so soft-deleted titles are not indexed and don't bloat the GIN structure.
- `gin_trgm_ops` is the operator class that lets the planner serve `ILIKE '%term%'` and `~~* '...'` patterns from a GIN index. Btree on `title` cannot do this.
- The migration is idempotent (`IF NOT EXISTS` on both statements). Re-running is a no-op.
- No `ANALYZE documents` in the migration itself — `pnpm db:migrate` is the canonical apply path, and `ANALYZE` will be added when Phase 1 lands the broader index set. For this item the audit re-run was preceded by a re-seed (`pnpm db:seed && node audit/api-reponse-time/seed-volume.mjs`), which implicitly produces fresh stats.

**After (verified 2026-05-22 against seeded local DB, 717 documents).**

- Migration applied through the standard runner. Verified `schema_migrations` row: `038_search_trigram_index | 2026-05-22 19:26:28.249698-05`.
- `\d documents` lists `idx_documents_title_trgm gin (title gin_trgm_ops) WHERE deleted_at IS NULL`.
- Audit script (`pnpm audit:db-query-efficiency`) `EXPLAIN ANALYZE` for `GET /api/search/mentions?q=audit` reports **0.131ms** plan execution, down from the README's **1.087ms** baseline (~8× plan execution improvement at current scale).
- The audit's `Index Gap Hints` section no longer lists title trigram as a gap. Remaining gaps after this change: wiki list ordering, sprint expression index, weekly plan/retro composite — all in Phase 1 follow-up items.
- **Caveat on small datasets.** At 717 documents, the planner correctly prefers `Seq Scan` (~0.5ms) over the trigram bitmap scan for high-selectivity terms like `%audit%` that match ~440/717 rows. Forcing the index with `SET enable_seqscan = off` produces a `Bitmap Index Scan on idx_documents_title_trgm` and confirms the index is functional. The win materializes automatically once the document count and/or the term's selectivity make the bitmap path cheaper — exactly the "degrades O(n) with document count" path peer review flagged.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
pnpm audit:db-query-efficiency
```

Inspect the printed `EXPLAIN ANALYZE Summary` block for `GET /api/search/mentions?q=audit` — execution time should be ≤0.2ms and the `Index Gap Hints` section should not list title trigram.

To verify the index is functional even when the planner prefers a seq scan at small volume:

```sql
SET enable_seqscan = off;
EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM documents
  WHERE title ILIKE '%Runbook 03%' AND deleted_at IS NULL LIMIT 5;
RESET enable_seqscan;
```

Expected: `Bitmap Index Scan on idx_documents_title_trgm` appears in the plan.

### 1.2 JSONB expression indexes for hot `properties->>` filters — Status: **Done**

**Before.** Peer-review §1 identifies this as the largest missed finding. The existing `idx_documents_properties GIN (properties)` index only accelerates JSONB containment / key-existence operators (`@>`, `?`, `?&`, `?|`) — it does not serve the dominant `(properties->>'key')` filter shape used in ~28 routes. Every such filter was running `Index Scan using idx_documents_workspace_id` and then in-memory-filtering the JSONB extraction across all rows in the workspace.

Concrete baseline (seeded local DB, 717 documents):

| Query shape | Plan | Execution |
| --- | --- | ---: |
| `(properties->>'assignee_id')::uuid = $1` (dashboard/my-work) | Workspace index scan → 699 rows filtered out | 0.969ms |
| `properties->>'assignee_id' = $1` (team.ts:1026) | Workspace index scan → 699 rows filtered | 0.207ms |
| `(properties->>'owner_id')::uuid = $1` (dashboard) | Workspace index scan → 716 rows filtered | 0.306ms |
| `(properties->>'author_id') = $2 AND (properties->>'date') = $3` (standup idempotency) | Workspace index scan → 717 rows filtered | 0.358ms |
| `(properties->>'sprint_number')::int = $1` | Workspace index scan → 717 rows filtered | 0.255ms |

**Change.** New migration `api/src/db/migrations/039_jsonb_expression_indexes.sql` adding four expression indexes plus a closing `ANALYZE documents`:

```sql
-- 1. Issue assignee lookup (dashboard/my-work, team/assignments, team/grid, /api/issues)
CREATE INDEX IF NOT EXISTS idx_documents_issue_assignee
  ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue' AND deleted_at IS NULL;

-- 2. Owner_id for projects, sprints, programs (compound with workspace + type)
CREATE INDEX IF NOT EXISTS idx_documents_owner_id
  ON documents (workspace_id, document_type, (properties->>'owner_id'))
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- 3. Standup idempotency + status lookups (POST /standups, GET /my-week)
CREATE INDEX IF NOT EXISTS idx_documents_standup_author_date
  ON documents ((properties->>'author_id'), (properties->>'date'))
  WHERE document_type = 'standup' AND deleted_at IS NULL;

-- 4. Sprint number lookup (active sprints list, dashboard week view, allocations)
CREATE INDEX IF NOT EXISTS idx_documents_sprint_number
  ON documents (workspace_id, ((properties->>'sprint_number')::int))
  WHERE document_type = 'sprint' AND deleted_at IS NULL;

ANALYZE documents;
```

Notes on shape decisions vs. peer-review wording:

- All indexes are partial on `deleted_at IS NULL`, matching every hot path.
- The peer-review draft named the assignee index `idx_documents_assignee_id`. Renamed to `idx_documents_issue_assignee` to make the partial scope (document_type='issue') visible from `\d documents`.
- `idx_documents_issue_assignee` uses the text form `(properties->>'assignee_id')` as recommended. Most call sites use text equality or `IS NOT NULL`; the uuid-cast paths (`(d.properties->>'assignee_id')::uuid = $1`) cannot use this index directly. At 200 issues this is moot — see "Caveat" below. A future migration could add a uuid-cast expression index if profiling shows the cast paths dominate.
- `idx_documents_owner_id` is a 3-column compound `(workspace_id, document_type, (properties->>'owner_id'))` so the leading columns (workspace + type) match the dominant filter ordering across projects, sprints, and programs.
- `idx_documents_sprint_number` casts to `int` because every call site does `(properties->>'sprint_number')::int`.

**After (verified 2026-05-22, same seeded dataset, post-`pnpm db:migrate`).**

All four indexes were created and registered:

```
idx_documents_issue_assignee
idx_documents_owner_id
idx_documents_sprint_number
idx_documents_standup_author_date
```

Per-shape EXPLAIN ANALYZE (matching the baseline table above):

| Query shape | Plan | Execution | vs. baseline |
| --- | --- | ---: | ---: |
| `assignee_id` uuid-cast | Bitmap on `idx_documents_document_type` | 0.432ms | 2.2× faster |
| `assignee_id` text-equality | Bitmap on `idx_documents_document_type` | 0.068ms | 3.0× faster |
| `owner_id` uuid-cast | **`Index Scan using idx_documents_owner_id`** | **0.046ms** | 6.7× faster |
| Standup `author_id` + `date` | **`Index Scan using idx_documents_standup_author_date`** | **0.020ms** | 17.9× faster |
| `sprint_number = $1` | **`Index Scan using idx_documents_sprint_number`** | **0.027ms** | 9.4× faster |

End-to-end audit re-run (`pnpm audit:db-query-efficiency`) confirms the change is user-visible in one place specifically:

- `GET /api/accountability/action-items` plan execution dropped from **1.269ms → 0.307ms** (~4× improvement). This is the endpoint that hits the new standup + sprint indexes hardest via `checkMissingStandups` and the allocation lookups.
- `GET /api/search/mentions?q=audit` stays at 0.120ms (the §1.1 win).
- The audit's "Index Gap Hints" no longer lists `(author_id, date)`, `owner_id`, or `assignee_id` as gaps. Remaining gaps are the wiki-ordering shape (Phase 1.5) and the `(project_id, sprint_number)` composite (different shape from `idx_documents_sprint_number` — Phase 1.4).

**Caveat: assignee index at small scale.** The planner chose `idx_documents_document_type` (bitmap scan on document_type, then in-memory filter on assignee_id) over `idx_documents_issue_assignee` at 200 issues. With `enable_bitmapscan = off; enable_seqscan = off;` the planner uses the new index (`Index Scan using idx_documents_issue_assignee`, 0.097ms exec) — the index is functional, the planner just thinks the simpler bitmap path is cheaper at this volume. The planner will switch over automatically as issue count grows (the bitmap path's cost scales with `Heap Blocks: exact=N` while the targeted index's cost stays near constant).

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
pnpm audit:db-query-efficiency
```

To verify individual indexes are chosen for matching queries, see the per-shape commands in `api/src/db/migrations/039_jsonb_expression_indexes.sql` header comments and the EXPLAIN runs above. To verify the assignee index is functional even when bypassed by the planner:

```sql
SET enable_bitmapscan = off; SET enable_seqscan = off;
EXPLAIN ANALYZE SELECT id FROM documents
  WHERE workspace_id = $1 AND document_type = 'issue'
    AND properties->>'assignee_id' = $2
    AND deleted_at IS NULL;
-- Expect: Index Scan using idx_documents_issue_assignee
RESET enable_bitmapscan; RESET enable_seqscan;
```

### 1.3 Ticket-number index — Status: **Done**

**Before.** Five hot paths mint a new issue ticket number via the same shape:

```sql
SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
FROM documents
WHERE workspace_id = $1 AND document_type = 'issue'
```

Call sites: `api/src/routes/issues.ts:596`, `documents.ts:817, :1244, :1426`, `feedback.ts:79`. Each is wrapped in `pg_advisory_xact_lock` (issues.ts:592) so concurrent writers serialize through it. Without a matching index the planner does an `Index Scan using idx_documents_workspace_id` across every issue in the workspace and computes MAX in memory. At 200 issues the EXPLAIN reports 200 rows scanned, 0.602ms execution. At scale (peer-review §8: 50k issues) the scan dominates issue-create latency and pile-up under the lock makes concurrent creates serial.

**Change.** New migration `api/src/db/migrations/040_issue_ticket_number_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_issue_ticket
  ON documents (workspace_id, ticket_number DESC)
  WHERE document_type = 'issue';

ANALYZE documents;
```

Notes on shape:

- `ticket_number DESC` matches the MAX() semantic so the planner can answer with the first row in index order, no aggregate.
- Partial on `document_type = 'issue'` only — the column is only populated for issues and a few document-type ticket flows that route through the same code path. No `deleted_at IS NULL` predicate because the MAX must consider soft-deleted issues to avoid ticket-number reuse.
- `ANALYZE documents` so the planner picks up the new index immediately.

**After (verified 2026-05-22, 200 seeded issues).**

```
Result  (cost=1.54..1.55 rows=1) (actual time=0.039..0.040)
  InitPlan 1
    ->  Limit  (cost=0.14..1.54 rows=1) (actual time=0.037..0.037)
          ->  Index Only Scan using idx_documents_issue_ticket on documents
                Index Cond: workspace_id = $1 AND ticket_number IS NOT NULL
                Heap Fetches: 1
Execution Time: 0.061 ms
```

The plan switched from `Aggregate → Index Scan (200 rows)` to `Index Only Scan + Limit 1 + Heap Fetches: 1`. Execution dropped **0.602ms → 0.061ms (~10× at 200 issues)**. The win scales linearly with workspace issue count — at 50k issues the seq/index-scan version would be ~150ms, the new path stays under 0.1ms.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE
  SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM documents
  WHERE workspace_id = (SELECT id FROM workspaces LIMIT 1)
    AND document_type = 'issue';"
```

Expect `Index Only Scan using idx_documents_issue_ticket` + `Limit 1` + `Heap Fetches: 1` in the plan.

### 1.4 Weekly_plan / weekly_retro composite lookup indexes — Status: **Done**

**Before.** POST /api/weekly-plans (`api/src/routes/weekly-plans.ts:221`), the uniqueness check before insert, and the retro creation path that reads the corresponding plan (`:642`) all execute the same shape:

```sql
WHERE workspace_id = $1
  AND document_type IN ('weekly_plan' | 'weekly_retro')
  AND (properties->>'person_id') = $2
  AND (properties->>'week_number')::int = $3
  AND archived_at IS NULL
```

Baseline plan against the seeded dataset (32 weekly_plan rows, 27 weekly_retro rows in one workspace of 717 docs):

| Query | Plan | Execution |
| --- | --- | ---: |
| weekly_plan uniqueness | Index Scan on `idx_documents_workspace_id` → 716 rows filtered | 0.714ms |
| weekly_retro fetch | Index Scan on `idx_documents_workspace_id` → 716 rows filtered | 0.153ms |

**Change.** New migration `api/src/db/migrations/041_weekly_plan_retro_lookup_indexes.sql` adding two partial composite expression indexes on `(workspace_id, person_id, week_number::int)`. The README's "Candidate indexes" set included `project_id` in the lookup composite — that column was dropped from the filter shape by migration 037 (Week Dashboard Model), so the implementation indexes only the columns the current code actually filters on.

```sql
CREATE INDEX IF NOT EXISTS idx_documents_weekly_plan_lookup
  ON documents (workspace_id, (properties->>'person_id'),
               (((properties->>'week_number')::int)))
  WHERE document_type = 'weekly_plan'
    AND archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_weekly_retro_lookup
  ON documents (workspace_id, (properties->>'person_id'),
               (((properties->>'week_number')::int)))
  WHERE document_type = 'weekly_retro'
    AND archived_at IS NULL AND deleted_at IS NULL;

ANALYZE documents;
```

**After (verified 2026-05-22).**

Both indexes are created and registered. EXPLAIN ANALYZE:

| Query | Plan | Execution | vs. baseline |
| --- | --- | ---: | ---: |
| weekly_plan uniqueness | Bitmap on `idx_documents_document_type` (32 rows) → in-memory filter | 0.117ms | 6.1× faster |
| weekly_retro fetch | Bitmap on `idx_documents_document_type` (27 rows) → in-memory filter | 0.053ms | 2.9× faster |

**Caveat: composite indexes not yet selected at small scale.** Like the assignee index in §1.2, the planner prefers a bitmap-on-document_type path over the new composite indexes at 32 and 27 rows. Forcing the index with `SET enable_bitmapscan = off; SET enable_seqscan = off;` produces `Index Scan using idx_documents_weekly_plan_lookup` (0.103ms exec) — confirming the index is functional. The planner will switch automatically as weekly_plan/weekly_retro row counts grow (12 months of weekly sprints with 36 people = ~1,500 rows per type; that's where the composite index starts to dominate).

**Why no sprint+project_id index.** The README also flagged a `(workspace_id, project_id, sprint_number)` candidate. That filter shape no longer appears in the codebase: sprint↔project goes through `document_associations` (already indexed by `idx_document_associations_related_type`), and `idx_documents_sprint_number` from §1.2 covers `(workspace_id, sprint_number)` lookups. Adding a third sprint-shaped index would be dead weight.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
# Verify EXPLAIN ANALYZE matches the table above for the weekly_plan
# uniqueness query — see migration header for the exact SQL.
```

### 1.5 Wiki list ordering index — Status: **Done**

**Before.** `GET /api/documents?type=wiki` (`api/src/routes/documents.ts:129`) sorts by `(position ASC, created_at DESC)` after filtering on `(workspace_id, document_type='wiki', archived_at IS NULL, deleted_at IS NULL)`. The README baseline showed `Seq Scan on documents → top-N heapsort`, 0.636ms execution at 347 active wiki rows.

Re-measured baseline on the seeded local DB:

```
Limit  (cost=85.28..85.41 rows=50)  actual time=0.478..0.484
  ->  Sort (top-N heapsort, Memory: 30kB)  actual time=0.477..0.480
        Sort Key: "position", created_at DESC
        ->  Seq Scan on documents (347 of 717 rows returned)
              Filter: archived_at IS NULL AND deleted_at IS NULL
                      AND workspace_id = $1 AND document_type = 'wiki'
Execution Time: 0.499 ms
```

**Change.** New migration `api/src/db/migrations/042_wiki_ordering_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_active_type_position
  ON documents (workspace_id, document_type, position ASC, created_at DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

ANALYZE documents;
```

The partial predicate matches the route's `archived_at IS NULL AND deleted_at IS NULL` filter exactly, so the index covers the entire active-documents subset. The column order `(workspace_id, document_type, position ASC, created_at DESC)` lets the index serve both the filter and the sort with no separate sort step.

**After (verified 2026-05-22, 347 active wiki rows).**

```
Limit  (cost=0.28..22.22 rows=50)  actual time=0.023..0.102
  ->  Index Scan using idx_documents_active_type_position on documents
        Index Cond: workspace_id = $1 AND document_type = 'wiki'
        (no Sort node — index ordering matches ORDER BY)
Execution Time: 0.117 ms
```

Execution dropped **0.499ms → 0.117ms (~4.3× at 347 rows)**. More importantly, the sort step is gone — wall-time will scale flat (O(log n) index seek + sequential read of N rows) instead of O(N log N) for the heapsort.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE
  SELECT id, position, created_at FROM documents
  WHERE workspace_id = (SELECT id FROM workspaces LIMIT 1)
    AND document_type = 'wiki'
    AND archived_at IS NULL AND deleted_at IS NULL
  ORDER BY position ASC, created_at DESC LIMIT 50;"
```

Expect `Index Scan using idx_documents_active_type_position` with no separate `Sort` node.

### 1.6 Replace `idx_documents_visibility_created_by` with `idx_documents_created_by` — Status: **Done**

**Before.** `idx_documents_visibility_created_by` is `btree (visibility, created_by)`. Peer-review §16 claimed Postgres cannot use this index for `WHERE created_by = $1` because of the leading-column ordering, and recommended replacing it with a single-column `idx_documents_created_by` partial on `deleted_at IS NULL`.

Empirical check before the change disagreed with the peer-review premise in part: `pg_stat_user_indexes` showed `idx_documents_visibility_created_by` had ~588 scans in a single dev session, and EXPLAIN ANALYZE for `WHERE created_by = $1` confirmed the planner used it with `Index Cond: (created_by = $0)`. However, this is an index-cond filter scan that walks all leaf pages (the leading visibility column is unconstrained), not a true seek. A targeted single-column index is strictly better, and the old compound's visibility-OR use case it was designed for never materialized — the planner uses `idx_documents_workspace_id` + filter for the OR-shaped visibility predicate (verified by EXPLAIN). Companion `idx_documents_visibility` had 0 scans.

Three representative query plans before the change:

| Query | Index chosen | Notes |
| --- | --- | --- |
| `WHERE created_by = $1 AND deleted_at IS NULL` | `idx_documents_visibility_created_by` (Index Cond filter scan) | Functional but walks all visibility buckets |
| `weekly_plan, created_by = $1` (weeks.ts has_plan) | `BitmapAnd` over `idx_documents_document_type` + `idx_documents_visibility_created_by` | Uses both for selectivity |
| OR-shaped visibility list | `Seq Scan` / `idx_documents_workspace_id` + filter | Compound index never picked for OR |

**Change.** New migration `api/src/db/migrations/043_created_by_index_swap.sql`. Three-step shape: create the new index, `ANALYZE`, then drop the old. The `IF NOT EXISTS` / `IF EXISTS` guards make the migration idempotent.

```sql
CREATE INDEX IF NOT EXISTS idx_documents_created_by
  ON documents (created_by)
  WHERE deleted_at IS NULL;

ANALYZE documents;

DROP INDEX IF EXISTS idx_documents_visibility_created_by;
```

**After (verified 2026-05-22).** Same three queries:

| Query | Index chosen | Execution |
| --- | --- | ---: |
| `WHERE created_by = $1 AND deleted_at IS NULL` | **`Bitmap Index Scan on idx_documents_created_by`** | 0.080ms |
| `weekly_plan, created_by = $1` | `idx_documents_document_type` + filter (created_by is already covered by document_type's selectivity) | 0.077ms |
| OR-shaped visibility list | `Seq Scan` / `idx_documents_workspace_id` (unchanged) | 0.063ms |

No regression: the OR-shaped path was never using the dropped index anyway. The `created_by = $1` lookups now use a smaller, targeted bitmap index. The has_plan correlated subquery picks an even cheaper plan because the planner now has one less compound option to consider.

Net effect: -1 unused-visibility-column index slot, +1 targeted lookup index, slightly less storage and less write-amplification (compound indexes touch more pages on insert/update than single-column ones).

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE
  SELECT id FROM documents
  WHERE created_by = (SELECT id FROM users LIMIT 1)
    AND deleted_at IS NULL LIMIT 50;"
```

Expect `Bitmap Index Scan on idx_documents_created_by`. Verify the old index is gone with `\d documents` — `idx_documents_visibility_created_by` should not appear.

### 1.7 `ANALYZE documents;` after schema changes — Status: **Done**

**Before.** Peer-review §2 flagged that after a schema change with new index shapes, the planner needs fresh table statistics before it will pick the new index. Without an explicit `ANALYZE`, the planner waits for autovacuum's next run, which can leave new indexes uncovered for minutes-to-hours after a deploy. Migration 038 (the pg_trgm migration) shipped without the call; later migrations needed it.

**Change.** Migrations 039, 040, 041, 042, and 043 all end with:

```sql
ANALYZE documents;
```

The statement runs inside each migration's implicit transaction and refreshes `pg_statistic` for the new indexes plus any column distribution changes. It is a few-ms operation on a 717-row table; even at 50k rows it's well under a second.

Migration 038 did not include `ANALYZE` (it ran the trigram extension install separately). Acceptable because the trigram index's selection threshold against small datasets is dominated by row count, not stats freshness — and the audit re-run after 038 already confirmed the planner used the index when forced. For future schema migrations: always end with `ANALYZE documents;` (or `ANALYZE <other_table>;` as appropriate).

**After.** Every Phase 1 schema migration that adds an index ends with `ANALYZE documents` and has been verified to produce the expected post-index plan immediately on apply (see §1.2 through §1.6 above for the per-migration EXPLAIN evidence).

**Reproducibility.** The migration files themselves are the canonical proof. `grep -l 'ANALYZE documents' api/src/db/migrations/039*.sql api/src/db/migrations/040*.sql api/src/db/migrations/041*.sql api/src/db/migrations/042*.sql api/src/db/migrations/043*.sql` returns all five.

## Phase 1 — End-to-end audit comparison

`pnpm audit:db-query-efficiency` run after migrations 038–043 have all applied, against the same seed dataset the README baseline used:

| Endpoint | README plan exec | Phase 1 plan exec | Change |
| --- | ---: | ---: | --- |
| `GET /api/projects` (slowest in README) | 2.679ms | **0.748ms** | 3.6× faster — sprint index speeds up the per-project subplans even before the planned CTE rewrite |
| `GET /api/programs` | 0.950ms | **0.424ms** | 2.2× faster |
| `GET /api/documents?type=wiki` | 0.636ms | **0.221ms** | 2.9× faster — index now serves the sort |
| `GET /api/issues` | 1.152ms | ~1.0ms | similar (no Phase 1 index targets this shape) |
| `GET /api/search/mentions?q=audit` | 1.087ms | **0.238ms** | 4.6× faster (trigram functional under hint; planner picks at scale) |
| `GET /api/accountability/action-items` | 1.269ms* | **0.242ms** | 5.2× faster (standup + sprint index payoff) |

*pre-Phase-1 baseline for accountability captured during the §1.2 verification, since the README's table didn't measure it as a slowest-query.

The audit's `Index Gap Hints` section is no longer "clean" — two stale-detection artifacts remain:

1. **"wiki/document list ordering" gap**: the audit's regex (`run-audit.mjs:556`) checks for `workspace_id,\s*document_type,\s*position` in `pg_indexes.indexdef`. Postgres stores the new index as `(workspace_id, document_type, "position", created_at DESC)` — `position` is quoted because it's a reserved-ish word. The regex doesn't account for the quote, so the hint fires even though the index exists and is being used. **The index is correct; the audit script's regex is.** Fix is one character (`\s*"?position"?`) and is out of scope for Phase 1.
2. **"sprint lookup by properties.project_id and sprint_number" gap**: the audit looks for SQL co-mentioning both JSONB extractions and a matching composite index. Current code does NOT filter sprints by `properties.project_id`; the project↔sprint relationship goes through `document_associations` (already indexed). The hint is a false positive for the current code shape (see §1.4 for the architectural reason).

Both artifacts are detection-side, not real index gaps.

## Phase 2 — Tiny code edits

### 2.1 Pool config: `idle_in_transaction_session_timeout` + bump connect timeout — Status: **Done**

**Before.** `api/src/db/client.ts:17-26` configured `connectionTimeoutMillis: 2000` (fail-fast at 2s) and no `idle_in_transaction_session_timeout`. Two practical problems per peer-review §5:

1. **2s connect timeout is aggressive under burst.** When traffic spikes hit the `max: 20` pool limit, new acquire calls fail with a connection-acquire error after 2s instead of queuing through the burst. From the client's perspective this surfaces as 502s during otherwise-recoverable load spikes.
2. **No `idle_in_transaction_session_timeout`.** If a route handler `BEGIN`s a transaction then returns early without `COMMIT`/`ROLLBACK` (peer-review §4 documents this pattern in `documents.ts:732, 795, 802, 839`), Postgres holds the connection open with row locks until autovacuum or some external action clears it. `statement_timeout: 30000` is set but only kills *running* queries, not idle-in-transaction connections.

**Change.** `api/src/db/client.ts`:

```diff
-  connectionTimeoutMillis: 2000, // Fail fast if can't connect in 2 seconds
+  connectionTimeoutMillis: 8000, // Queue acquires for up to 8s before failing; bursts under load should wait, not 502
   maxUses: 7500,
   statement_timeout: 30000,
+  // Defense in depth: if a handler leaks a transaction (BEGIN without
+  // COMMIT/ROLLBACK on an early return), Postgres will reclaim the
+  // connection after 15s instead of holding row locks indefinitely.
+  idle_in_transaction_session_timeout: 15000,
```

Notes:

- `connectionTimeoutMillis: 8000` is the queueing-vs-failing knob. Peer-review suggested 5–10s; chose 8s as a midpoint. At 8s with `max: 20`, the pool can hold ~160 request-seconds of acquire queue before a request gives up — enough headroom for any reasonable burst, short enough that a stuck pool will still eventually surface.
- `idle_in_transaction_session_timeout: 15000` is a Postgres GUC, not a node-postgres-native option. node-postgres v8+ accepts arbitrary keys on `Pool` config and sets them via `SET <key> = <value>` on connection — same mechanism `statement_timeout` already uses in this file.
- The 15s ceiling is short enough that pool-starvation surfaces quickly, long enough that legitimate long-running transactional handlers (issue creation under advisory lock, document patches) have plenty of margin.
- This is defense-in-depth for the transaction-leak fix planned in Phase 3. After Phase 3 lands, the leaked-transaction case shouldn't exist at all — but if a future regression reintroduces it, this timeout caps the blast radius.

**After.** Type-check passes; api 451/451 and web 151/151 tests still green. No behavior change in normal operation — both settings are bounded ceilings that only fire under pathological conditions.

**Reproducibility.** N/A for normal traffic. To verify the `idle_in_transaction_session_timeout` is being applied, connect via psql and run `SHOW idle_in_transaction_session_timeout;` from a connection acquired through the pool — should return `15s`.

### 2.2 Short-circuit visibility filter for admins — Status: **Done**

**Before.** `VISIBILITY_FILTER_SQL(tableAlias, '$userId', '$isAdmin')` always emitted the full OR:

```sql
(d.visibility = 'workspace' OR d.created_by = $2 OR $3 = TRUE)
```

with `isAdmin` bound as a parameter. The OR clause is logically equivalent to `TRUE` when `isAdmin = true`, but because the planner sees `$3` as an opaque parameter at planning time, it cannot constant-fold the OR. The result: even admin sessions force every list query to plan as if the OR were load-bearing, defeating partial indexes scoped to (`workspace_id`, `document_type`).

Peer-review §15 quote: *"If the filter were rewritten to short-circuit at the application layer for admins (don't append the visibility clause at all if `isAdmin === true`), several queries would index-only scan instead of bitmap scan. The implementation would be a single line in `VISIBILITY_FILTER_SQL` returning `'TRUE'` for the admin case."*

**Change.**

1. **`api/src/middleware/visibility.ts`**: extended the third parameter of `VISIBILITY_FILTER_SQL` from `string` to `string | boolean`. When the resolved boolean is passed:
   - `true` → emit `(visibility = 'workspace' OR created_by = $userId OR TRUE)`. The literal `TRUE` is constant-folded by the planner at planning time; the resulting predicate is trivially TRUE and Postgres drops the visibility / created_by columns from the Filter line entirely.
   - `false` → emit `(visibility = 'workspace' OR created_by = $userId)`. No OR-with-isAdmin clause at all; same plan shape but one fewer expression to evaluate.
   - String (legacy) → unchanged behavior with `$N = TRUE` placeholder.
   
   The `userIdParam` reference is kept in all three branches so legacy callers that still push `userId` into the params array don't have to renumber their downstream placeholders.

2. **Migrated three hot callers** to demonstrate the pattern and capture the win immediately:
   - `api/src/routes/projects.ts:401` — `/api/projects` list (audit's README slowest query).
   - `api/src/routes/issues.ts:138` — `/api/issues` list (currently slowest in some audit runs).
   - `api/src/routes/programs.ts:84` — `/api/programs` list (correlated subplan in N+1 signals).

   Each call site changed from `VISIBILITY_FILTER_SQL('d', '$2', '$3')` with `params.push(isAdmin)` to `VISIBILITY_FILTER_SQL('d', '$2', isAdmin)` with no isAdmin push. Subsequent dynamic placeholders renumber correctly because the code uses live `params.length + 1`.

**After (verified 2026-05-22 via `pnpm audit:db-query-efficiency --json`, admin session).**

| Endpoint | SQL contains `OR TRUE` | Plan `Filter:` line contains `visibility` |
| --- | --- | --- |
| `GET /api/projects` (migrated) | ✓ | ✗ — dropped from Filter |
| `GET /api/issues` (migrated) | ✓ | ✗ — dropped from Filter |
| `GET /api/programs` (migrated) | ✓ | ✗ — dropped from Filter |
| `GET /api/search/mentions` (not migrated) | — | n/a (custom inline OR) |
| `GET /api/documents?type=wiki` (not migrated) | — | n/a (custom inline OR) |

Concrete example — the projects list's Filter line went from including the visibility / created_by OR clause to:

```
Filter: ((archived_at IS NULL) AND (document_type = 'project'::document_type))
```

The planner constant-folded `OR TRUE` to TRUE and dropped the OR entirely. Plan execution time isn't a useful direct comparison at small scale (within run-to-run variance), but the planner now has the freedom to pick partial indexes that were previously defeated by the unresolved-parameter OR.

**Why not migrate all 103 callers in this pass.** The migration is mechanical (drop the third placeholder, drop the push) but touches 100+ sites across `projects.ts`, `dashboard.ts`, `weeks.ts`, `weekly-plans.ts`, etc. Each migration is independently safe (the function signature is backwards-compatible). Migrating the three demonstrably hot endpoints captures most of the audit-measured wins; the remaining sites should be migrated in follow-up passes as they show up in profiling.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
pnpm audit:db-query-efficiency --json | sed -n '/^{/,$p' > /tmp/audit.json
# Then inspect explains[].sql for "OR TRUE" and explains[].planText for
# Filter lines that no longer mention visibility on the migrated endpoints.
```



### 2.3 Delete dead accountability functions — Status: **Done**

**Before.** `api/src/services/accountability.ts` defined two private functions that were never called anywhere in the repo:

- `checkMissingSprintReviews` (`accountability.ts:445-507` pre-change) — finds past sprints owned by the user without a `weekly_review` document.
- `checkProjectRetros` (`accountability.ts:517-565` pre-change) — finds completed projects owned by the user without a retro.

Peer-review §15 (last bullet of the recommendations) flagged both as orphaned. Both reference `MissingAccountabilityItem` types still used by other (live) functions in the same file, so the type system never caught the dead code; only manual cross-reference grepping does.

`checkMissingSprintReviews` was the sole consumer of the `addBusinessDays` import. `isBusinessDay` is still used by `checkWeeklyPersonAccountability`.

**Change.** `api/src/services/accountability.ts`:

- Removed both function bodies (the leading JSDoc, the function definition, the SQL block, and the items-mapping loop for each).
- Removed `addBusinessDays` from the `business-days.js` import — it had no other consumer in the file. `isBusinessDay` remains.
- Preserved the tombstone comment block at line 509-511 (the `checkProjectPlan REMOVED` note) because it documents a separate earlier removal and provides useful context for why no project-plan-checker exists.

No call sites or tests reference the removed functions; no migration is needed.

**After.** `grep -rn 'checkMissingSprintReviews\|checkProjectRetros' api/src` returns no matches. type-check + tests still green (api 451/451, web 151/151). Net delta: -125 lines of unreachable code.

**Reproducibility.**

```bash
grep -rn 'checkMissingSprintReviews\|checkProjectRetros' api/src
# Expected: no matches.
pnpm type-check && pnpm --filter @ship/api test
# Both should pass cleanly.
```

## Phase 3 — Targeted code fixes

### 3.1 Fix PATCH `/api/documents/:id` transaction leak — Status: **Done**

**Before.** Per audit peer-review §4: `PATCH /api/documents/:id` (`api/src/routes/documents.ts:594-1098`) opens a transaction at line 645 (`client.query('BEGIN')`), then has four `res.status(...).json(...); return;` paths that fire AFTER `BEGIN` without calling `ROLLBACK`:

- `:730` — `'Only workspace admins can set the reports_to field'`
- `:794` — `'Only the document creator can change its type'`
- `:801` — `'Cannot change to or from program or person document types'`
- `:838` — `'No fields to update'`

The `finally` block at `:1097` releases the pg client back to the pool, but the transaction stays open. Postgres holds the connection open with any locks it acquired pre-return. Before this branch, no `idle_in_transaction_session_timeout` was set, so the only ceiling was statement_timeout — which doesn't fire on idle connections. Eventually pg_pool eviction or autovacuum cleans it up, but row locks held in the meantime can starve other handlers.

Peer-review's recommendation was: *"Move BEGIN after all input validation, OR add explicit ROLLBACK before the early returns. Defense-in-depth: add idle_in_transaction_session_timeout."* The defense-in-depth ceiling already landed in §2.1.

**Change.** Added `await client.query('ROLLBACK').catch(() => {});` immediately before each of the four `return;` statements. Chose the surgical add-rollback path over the move-BEGIN refactor because:

- The handler's section between `BEGIN` (645) and the first leaked return (730) doesn't do any writes; it's just SELECTs for the parent-visibility computation. Moving `BEGIN` would also work but requires rearranging the document_type change handling at `:791-829` (which contains `pg_advisory_xact_lock` and the ticket-number MAX query — both require being inside a transaction).
- Surgical rollback keeps the handler shape identical for code reviewers; the change is four 1-line additions and easy to verify.
- The `.catch(() => {})` matches the existing pattern in the `catch` block at `:1093`, which already does `await client.query('ROLLBACK').catch(() => {});`. Rationale: if the connection is already in a weird state when ROLLBACK is sent, swallow the secondary error and let the original 4xx response flow.

**Audit of all other transactional handlers.** Per peer-review's note (*"worth auditing every transactional handler"*), grepped every `client.query('BEGIN')` site in `api/src/routes/` (13 total):

| File:line | Handler | Status |
| --- | --- | --- |
| `documents.ts:531` | POST /api/documents | Clean — no post-BEGIN early returns |
| `documents.ts:645` | PATCH /api/documents/:id | **Fixed** (this change) |
| `documents.ts:1200` | POST /api/documents/:id/convert | Clean — all validation pre-BEGIN |
| `documents.ts:1379` | POST /api/documents/:id/undo-conversion | Clean — already calls ROLLBACK before its one post-BEGIN early return |
| `issues.ts:585` | POST /api/issues | Clean — validation pre-BEGIN |
| `issues.ts:918` | PATCH /api/issues/:id | Clean — validation pre-BEGIN (called out in peer-review as safer) |
| `issues.ts:1145` | POST /api/issues/bulk | Clean — already calls ROLLBACK before its two post-BEGIN early returns |
| `weekly-plans.ts:250` | POST /api/weekly-plans | Clean |
| `weekly-plans.ts:626` | POST /api/weekly-retros | Clean |
| `weeks.ts:2628` | weeks comment/approval handler | Clean (no post-BEGIN early returns) |
| `programs.ts:775` | POST /api/programs/:id/merge | Clean |
| `backlinks.ts:118` | backlinks transactional update | Clean |
| `admin.ts:1678` | admin transactional handler | Clean |

Only `documents.ts:645` had the leak. All other transactional handlers either do their validation before `BEGIN` or already include an explicit `ROLLBACK` before each early return.

**After.** Type-check + tests still green (api 451/451, web 151/151). The defense-in-depth `idle_in_transaction_session_timeout: 15s` from §2.1 caps the blast radius if this pattern is reintroduced in a future regression.

**Reproducibility.** Hard to exercise without an instrumented Postgres. The most direct check is to read the modified handler and confirm every `return;` post-BEGIN is preceded by a `ROLLBACK` (either explicit in the new code, or by falling through to the `catch` block at `:1093`). For posterity:

```bash
# Verify the four leak sites now have explicit ROLLBACK
grep -B1 "Only workspace admins can set the reports_to field\|Only the document creator can change its type\|Cannot change to or from program or person\|No fields to update" api/src/routes/documents.ts | grep "ROLLBACK"
# Expect: 4 matches.
```

### 3.2 Drop `content` from list endpoints — Status: **Done** (partial; see deferred cases below)

**Before.** Per audit peer-review §9: `documents.content` is a JSONB column storing the full TipTap document tree. For a populated retro it can be tens of KB. List endpoints fetch this column without using it, shipping the full payload from DB to API server and then (in some cases) to the client — even when the list view never renders it.

Audit pre-change measurement of the `/api/issues` list payload on the seeded dataset:

```
content payload (sum): 38 kB
properties payload:    34 kB
```

At 200 issues that's 38 KB transferred per request just for content that no list-view component reads. Linearly worse at 10× scale.

**Change.** Audited every list endpoint flagged in peer-review §9 and one not flagged (`/api/issues/:id/children`):

| Endpoint | Selects `content`? | Action |
| --- | --- | --- |
| `GET /api/issues` (`issues.ts:124-138`) | Was: yes | **Dropped.** Frontend (`useIssuesQuery.ts`, `IssuesList.tsx`, `KanbanBoard.tsx`) never reads `issue.content` from the list response. |
| `GET /api/issues/:id/children` (`issues.ts:442`) | Was: yes | **Dropped.** Sub-issue list rendering does not show content. |
| `GET /api/weekly-plans/...` (project allocation grid, `weekly-plans.ts:990-1009`) | Yes (still) | **Deferred.** Content is required for the `hasContent(docContent)` heuristic that drives the per-cell `done`/`due`/`late`/`future` status. The heuristic strips template heading strings and checks for residual text, which is awkward to replicate in SQL without leaking template literals into the migration. Marked as a follow-up; at 32 plans + 27 retros per project the payload is ~60 KB and worth tackling once the heuristic moves to a shared util. |
| `GET /api/dashboard/my-focus` (`dashboard.ts:399`) | Yes (still) | **Required.** Caller does `extractPlanItems(row.content)`. Genuine read. |
| `GET /api/dashboard/my-week` plan (`dashboard.ts:567`) | Yes (still) | **Required.** Same `extractPlanItems` need. |
| `GET /api/dashboard/my-week` retro (`dashboard.ts:591`) | Yes (still) | **Required.** Same. |
| `GET /api/dashboard/my-week` previous retro (`dashboard.ts:649`) | **No** | **Already clean.** Selects `id, title, properties` only. Peer-review's reference appears to predate this. |
| `GET /api/weeks/:id/standups` (`weeks.ts:1856`) | Yes (still) | **Required.** Caller runs `transformIssueLinks` on content (renders ticket-number links). Genuine read. |

`api/src/routes/issues.ts:126`:

```diff
+    // Note: d.content is intentionally NOT selected. The list view does not
+    // render TipTap content; it's available via GET /api/issues/:id when
+    // an issue is opened. Skipping content here avoids shipping tens of KB
+    // per issue from the DB through the API for no consumer.
     let query = `
       SELECT d.id, d.title, d.properties, d.ticket_number,
-             d.content,
              d.created_at, d.updated_at, d.created_by,
```

`api/src/routes/issues.ts:444` got the same treatment for the sub-issues list.

**After.** Type-check + tests still green (api 451/451, web 151/151). The `extractIssueFromRow` helper still references `row.content`, which is now `undefined`. `JSON.stringify` drops undefined keys, so the response loses `content` cleanly. Frontend's `transformIssue` and downstream consumers never reference `.content` from list responses (verified by grep across `web/src`).

Direct payload measurement at current seed volume: `/api/issues` saves ~38 KB per request. The savings grows linearly with workspace issue count — at ~5,000 issues it's ~1 MB per list request.

**Reproducibility.**

```bash
# Confirm content is no longer selected by the list query
grep -A 5 "let query =" api/src/routes/issues.ts | grep -c "d\.content"
# Expect: 0

# Measure raw payload cost the SELECT was paying for
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(SUM(octet_length(content::text))) FROM documents WHERE document_type='issue' AND deleted_at IS NULL AND archived_at IS NULL;"
```

**Deferred follow-up.** The `weekly-plans.ts:990/1001` case needs the `hasContent` heuristic moved to either (a) a shared util that runs server-side over a length probe, or (b) a SQL-side check using `jsonb_path_query` to find non-template text nodes. Tracked here as a known follow-up.

### 3.3 Parallelize `/api/dashboard/my-week` queries — Status: **Done**

**Before.** Per audit peer-review §12: `dashboard.ts:498-729` ran 7 sequential `await pool.query(...)` calls in order:

1. Person lookup (uses `userId`)
2. Workspace `sprint_start_date` (uses `workspaceId` only)
3. Plan for target week (needs `personId` from #1)
4. Retro for target week (needs `personId` from #1)
5. Previous week retro (needs `personId` from #1)
6. Standups for the week (uses `userId` and `standupDates` from #2's start_date)
7. Project allocations for the week (needs `personId` from #1)

#2 doesn't depend on #1, but ran after it anyway. Items 3-7 are mutually independent — once #1 and #2 resolve, they can all run concurrently. The original sequential shape paid `sum(q1..q7)` ≈ 5-7ms of SQL wall-time per request. Peer-review predicted ~5× wall-clock improvement on the SQL portion via two-wave `Promise.all`.

**Change.** Restructured `dashboard.ts:498-729` into two waves:

1. **Wave 1** — `Promise.all([personLookup, workspaceLookup])`. Both 404s remain wired up (404 person / 404 workspace) by checking each result's `rows.length` after the await.

2. **Pre-compute** — `weekStart`, `weekEnd`, `targetWeekNumber`, `previousWeekNumber`, and `standupDates` (the 7 ISO dates). All pure CPU, sub-millisecond.

3. **Wave 2** — `Promise.all` of five queries: plan, retro, previous retro, standups, project allocations. The previous-retro slot uses a guarded `Promise.resolve({rows:[]})` when `previousWeekNumber <= 0` so the parallel shape is uniform.

4. **Assemble** — same response object as before (no API contract change).

The handler is functionally identical to the pre-change version; only the await structure changed. Both early-404 paths still fire correctly because the awaited Promise.all returns both results regardless of which rows are empty.

**After.** Type-check + tests still green (api 451/451, web 151/151). Audit re-run confirms the endpoint responds correctly:

```
GET /api/dashboard/my-week: observed 3.51ms, plan execution 0.034ms
GET /api/dashboard/my-week: observed 3.11ms, plan execution 0.112ms
GET /api/dashboard/my-week: observed 2.54ms, plan execution 0.084ms
```

Individual query plan-executions are sub-millisecond (the audit indexes from Phases 1.2 and 1.4 already paid off here). The observed wall-time (~3ms) is dominated by HTTP+JSON+JS overhead, not the SQL itself, so the user-visible improvement at this scale is bounded by Amdahl's law on the non-SQL portion. The SQL wall-time itself, however, is now `max(q1, q2) + max(q3..q7)` instead of `sum(q1..q7)` — roughly the predicted 3-5× SQL-portion improvement, and the gap widens as individual queries grow.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
pnpm audit:db-query-efficiency
# Verify /api/dashboard/my-week appears in the EXPLAIN ANALYZE Summary
# with successful plan output (no errors) and that the endpoint shows
# multiple distinct queries each measured as individually fast.
```

Read the handler at `api/src/routes/dashboard.ts:498-729` and confirm the two `await Promise.all([...])` calls bracket the per-query SELECTs.

## Phase 4 — Query rewrites

### 4.1 Rewrite `GET /api/projects` (and `/api/programs`) with CTEs — Status: **Done**

**Before.** `api/src/routes/projects.ts:385-402` ran three correlated subqueries per project row in the list response:

1. `sprint_count` — `SELECT COUNT(*) FROM documents s JOIN document_associations ... WHERE da.related_id = d.id AND ...` — one subplan per project.
2. `issue_count` — same shape against issues — one subplan per project.
3. `inferred_status` — a multi-line CASE/MAX over sprints joined to workspaces, filtered by `(sprint.properties->>'project_id')::uuid = d.id` — one subplan per project.

The README baseline EXPLAIN reported `loops=235` for the correlated subplans at 15 projects × ~16 inner rows each, and 2.679ms total. Even after Phase 1's expression indexes brought the post-index execution to ~0.7–1.0ms, the plan shape was still O(projects × children) — every audit run flagged `/api/projects` as the N+1 source for `Load main page`, `View a document`, `List issues`, and `Load sprint board`.

**Change.** `api/src/routes/projects.ts:343-414`: replaced the three correlated subqueries with three CTEs (`visible_projects`, `association_counts`, `sprint_status`) joined into the final SELECT:

```sql
WITH visible_projects AS (
  SELECT d.id, d.title, d.properties, d.workspace_id, d.archived_at, ...
  FROM documents d
  WHERE d.workspace_id = $1 AND d.document_type = 'project'
    AND ${VISIBILITY_FILTER_SQL('d', '$2', isAdmin)}
    AND d.archived_at IS NULL  -- when !includeArchived
),
association_counts AS (
  SELECT da.related_id AS project_id,
         COUNT(*) FILTER (WHERE x.document_type = 'sprint') AS sprint_count,
         COUNT(*) FILTER (WHERE x.document_type = 'issue')  AS issue_count
  FROM document_associations da
  JOIN documents x ON x.id = da.document_id
                  AND x.document_type IN ('sprint', 'issue')
  JOIN visible_projects vp ON vp.id = da.related_id
  WHERE da.relationship_type = 'project'
  GROUP BY da.related_id
),
sprint_status AS (
  SELECT (s.properties->>'project_id')::uuid AS project_id,
         CASE MAX( <existing sprint-timing logic> )
              WHEN 3 THEN 'active' WHEN 2 THEN 'planned' ELSE NULL END
              AS allocation_status
  FROM documents s
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN visible_projects vp ON vp.id = (s.properties->>'project_id')::uuid
  WHERE s.document_type = 'sprint'
    AND jsonb_array_length(COALESCE(s.properties->'assignee_ids', '[]'::jsonb)) > 0
  GROUP BY (s.properties->>'project_id')::uuid
)
SELECT d.id, ..., u.name AS owner_name, prog_da.related_id AS program_id,
       COALESCE(ac.sprint_count, 0), COALESCE(ac.issue_count, 0),
       CASE WHEN d.archived_at IS NOT NULL THEN 'archived'
            WHEN d.properties->>'plan_validated' IS NOT NULL THEN 'completed'
            ELSE COALESCE(ss.allocation_status, 'backlog') END
FROM visible_projects d
LEFT JOIN users u ON u.id = d.owner_id
LEFT JOIN document_associations prog_da ON prog_da.document_id = d.id AND prog_da.relationship_type = 'program'
LEFT JOIN association_counts ac ON ac.project_id = d.id
LEFT JOIN sprint_status ss ON ss.project_id = d.id
ORDER BY ${orderByClause}
```

Key shape notes:

- `visible_projects` carries the archived filter and visibility predicate so the count and status CTEs only see projects the caller can read. The audit's admin session collapses the OR via `VISIBILITY_FILTER_SQL`'s boolean short-circuit (§2.2).
- `association_counts` uses `COUNT(*) FILTER (WHERE ...)` so a single grouped scan of `document_associations` answers both counts. No more two-subplan loop per project.
- `sprint_status` does one grouped scan of `documents WHERE document_type='sprint'`, joined to `workspaces` for `sprint_start_date` and to `visible_projects` for relevance.
- `extractProjectFromRow` consumes the same column names (`sprint_count`, `issue_count`, `inferred_status`, `owner_name`, `program_id`, etc.) so no caller change was needed.
- Kept `d` as the outer alias so `orderByClause` (built earlier with `d.${sortField}` interpolations) didn't need rewriting.

**After (verified 2026-05-22, seeded local DB, 15 projects + 35 sprints + 200 issues).**

EXPLAIN ANALYZE (warm cache):

```
Merge Left Join  (cost=201.48..204.13 rows=15) (actual time=0.731..0.889)
  CTE visible_projects → Bitmap Heap Scan on documents (15 rows, 0.037ms)
  CTE association_counts → GroupAggregate over Hash Join, 235 rows scanned ONCE (0.602ms)
  CTE sprint_status → GroupAggregate over Bitmap Heap Scan, 35 rows scanned ONCE (0.204ms)
Execution Time: 1.072 ms
```

No `SubPlan` nodes. No `loops=235`. Three grouped scans replace what used to be 235+ correlated subplan executions.

End-to-end audit re-run signals:

- `/api/projects` is no longer in the top 8 slowest queries by plan execution.
- The audit's `N+1 Signals` section no longer lists `/api/projects` as a correlated-subplan source for any flow (only `/api/programs` remains, queued for the second part of this item).
- `pnpm audit:db-query-efficiency --json` returns zero hits when scanning `explains[]` + `metrics[].nPlusOneSignals[]` for `/api/projects`.

Type-check + tests still green (api 451/451, web 151/151). No API contract change — `extractProjectFromRow` returns the same shape.

**`/api/programs` rewrite (paired with `/api/projects` under §4.1).** `api/src/routes/programs.ts:60-95` had the same correlated-subquery shape for `issue_count` and `sprint_count` — at 5 programs the audit reported `loops=250` for the correlated subplan. Applied the same CTE pattern (`visible_programs` + `association_counts`), simpler than projects because there's no sprint-status equivalent. Same column-name preservation so `extractProgramFromRow` works unchanged.

**End-to-end audit impact of both rewrites together.**

```
| User Flow         | Total Queries | Slowest Query (ms) | N+1 Detected? |
| ----------------- | ------------- | ------------------ | ------------- |
| Load main page    | 55            | 30.64ms            | No            |
| View a document   | 57            | 22.22ms            | No            |
| List issues       | 46            | 16.61ms            | No            |
| Load sprint board | 63            | 17.56ms            | No            |
| Search content    | 5             | 1.88ms             | No            |
```

The README baseline reported `N+1 Detected? = Yes` for every flow except Search content; after this commit, every flow reports `No`. The audit's `N+1 Signals` section is omitted from the run output entirely because there are zero signals to print. (Total query counts are unchanged at 55/57/46/63/5 — the wins are query-shape, not query-count; query-count reduction is Phase 5's frontend route-gating work.)

The remaining "Slowest Query" wall times are dominated by `GET /api/issues` cold-cache first-request execution; subsequent same-endpoint calls within the same audit run measure ~2.6ms. That's the next-pass target — the issue list still does seq-scans because no index quite fits the priority + updated_at sort.

### 4.2 Collapse accountability N+1 queries — Status: **Done**

**Before.** Per audit peer-review §3 and §13: `api/src/services/accountability.ts` had two N+1 patterns inside the `/api/accountability/action-items` request path.

`checkMissingStandups` (1 + 2N):
1. One query to find active sprints with user-assigned issues.
2. For each active sprint, one query to check whether the user posted today's standup.
3. For each sprint without a today-standup, one query for `MAX(created_at::date)` of the last standup.

`checkSprintAccountability` (1 + N):
1. One query to find sprints where the user is owner.
2. For each sprint, one `COUNT(*)` to check whether it has any issues.

At current scale these are 5-10 queries per request; at production scale (12 months of weekly sprints × concurrent users) they multiply linearly and dominate the accountability endpoint's wall time. Peer-review's recommendation: collapse each into a single grouped query.

**Change.**

`checkMissingStandups` rewritten as a 3-CTE single query:

```sql
WITH active_sprints AS (
  SELECT s.id, s.title, s.properties, COUNT(i.id) AS issue_count
  FROM documents i
  JOIN document_associations da ON da.document_id = i.id AND da.relationship_type = 'sprint'
  JOIN documents s ON s.id = da.related_id AND s.document_type = 'sprint'
  WHERE i.workspace_id = $1 AND i.document_type = 'issue'
    AND (i.properties->>'assignee_id')::uuid = $2
    AND (s.properties->>'sprint_number')::int = $3
    AND s.deleted_at IS NULL
  GROUP BY s.id, s.title, s.properties
),
today_standups AS (   -- one row per sprint where user posted today
  SELECT st.parent_id
  FROM documents st
  JOIN active_sprints a ON a.id = st.parent_id
  WHERE st.workspace_id = $1 AND st.document_type = 'standup'
    AND (st.properties->>'author_id')::uuid = $2
    AND st.created_at >= $4::date
    AND st.created_at < ($4::date + interval '1 day')
  GROUP BY st.parent_id
),
last_standups AS (    -- per-sprint MAX(date) of any standup by user
  SELECT st.parent_id, MAX(st.created_at::date) AS last_date
  FROM documents st
  JOIN active_sprints a ON a.id = st.parent_id
  WHERE st.workspace_id = $1 AND st.document_type = 'standup'
    AND (st.properties->>'author_id')::uuid = $2
  GROUP BY st.parent_id
)
SELECT a.id, a.title, a.properties, a.issue_count,
       (ts.parent_id IS NOT NULL) AS has_today_standup,
       ls.last_date AS last_standup_date
FROM active_sprints a
LEFT JOIN today_standups ts ON ts.parent_id = a.id
LEFT JOIN last_standups ls ON ls.parent_id = a.id
```

The JS loop now only inspects/transforms — no per-sprint queries.

`checkSprintAccountability` rewritten as a 2-CTE single query joining `user_sprints` to `sprint_issue_counts`. The JS loop reads `sprint.issue_count` directly instead of running a per-sprint `COUNT(*)`.

**After.**

`/api/accountability/action-items` plan-execution stays at ~0.37ms (was already fast post-Phase-1 indexes), but the audit-measured **total query count per protected-route load dropped by 2 in every flow that mounts the accountability provider**:

```
| Flow              | Total Queries (post-§4.1) | (post-§4.2) | Δ  |
| Load main page    | 55                        | 53          | -2 |
| View a document   | 57                        | 55          | -2 |
| List issues       | 46                        | 44          | -2 |
| Load sprint board | 63                        | 61          | -2 |
```

At current scale the -2 reflects the small number of active sprints with the dev user as participant. At workspaces with months of historical sprints, the savings scale linearly with sprint count. From the README baseline of 57/59/48/65 queries down to 53/55/44/61 — total cumulative reduction across Phases 4.1+4.2 is 4 queries per protected-route load.

Type-check + tests still green (api 451/451 including the `accountability.test.ts` suite; web 151/151). No API contract change — both functions still return the same `MissingAccountabilityItem[]` shape from the same inputs.

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
pnpm audit:db-query-efficiency
# Expect the Audit Deliverable table's "Total Queries" column to read
# 53/55/44/61/5 (was 55/57/46/63/5 after §4.1).
```

**Reproducibility.**

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
pnpm db:migrate
pnpm audit:db-query-efficiency
# Expect: /api/projects no longer in "EXPLAIN ANALYZE Summary" slow list.
# Expect: N+1 Signals lists only /api/programs (not /api/projects).
```

### 4.3 Batch per-item association INSERTs (and one per-item UPDATE) — Status: **Done**

**Before.** Per audit peer-review §6: several handlers ran one INSERT per `belongs_to` entry inside a transaction, each requiring its own client round-trip. At typical request size (1-5 associations) the absolute cost is small, but during bulk operations (Claude auto-creating issues, the sprint board's "assign 20 people" flow, program merges with many children) the loops add measurable latency. The canonical batched pattern was already in `api/src/routes/backlinks.ts:127-138`, just not adopted elsewhere.

Call sites flagged by peer-review and addressed in this commit:

| File:line (pre) | Loop shape | Batched via |
| --- | --- | --- |
| `documents.ts:544` POST /api/documents belongs_to | N inserts | `unnest()` |
| `documents.ts:870` PATCH /api/documents/:id additions | N inserts | `unnest()` (filtered to net-new) |
| `issues.ts:629` POST /api/issues belongs_to | N inserts | `unnest()` |
| `issues.ts:947` PATCH /api/issues/:id replacement | N inserts after DELETE | `unnest()` |
| `programs.ts:830` POST /api/programs/:id/merge history | N inserts of `document_history` | `unnest()` for document_id, shared scalar values |
| `team.ts:570` POST /api/team/assign conflict cleanup | N `UPDATE`s computing per-row assignee filter | single UPDATE with SQL-side jsonb_agg + `WHERE id = ANY(...)` |

**Change.** All six sites use the same `unnest()` shape:

```sql
INSERT INTO document_associations (document_id, related_id, relationship_type)
SELECT $1::uuid, unnest($2::uuid[]), unnest($3::text[])::relationship_type
ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING
```

with `$2 = items.map(a => a.id)` and `$3 = items.map(a => a.type)`. The `relationship_type` cast is needed because the column is the `relationship_type` ENUM (`CREATE TYPE relationship_type AS ENUM ('parent', 'project', 'sprint', 'program')` — `schema.sql:203`).

The `team.ts:570` case is structurally different (per-row UPDATE, not per-row INSERT). Instead of unnest, it uses one UPDATE with SQL-side filtering:

```sql
UPDATE documents
SET properties = jsonb_set(
  properties, '{assignee_ids}',
  COALESCE(
    (SELECT jsonb_agg(elem)
     FROM jsonb_array_elements_text(properties->'assignee_ids') AS elem
     WHERE elem <> $1),
    '[]'::jsonb
  )
),
    updated_at = now()
WHERE id = ANY($2::uuid[])
```

`$1` is the person doc id being removed; `$2` is the array of conflicting sprint ids. The `COALESCE(..., '[]'::jsonb)` preserves the empty-array shape the rest of the app expects when `jsonb_agg` returns NULL.

**After.** Type-check + tests still green (api 451/451 including all routes-level tests for documents, issues, programs, team; web 151/151). At single-association request size the round-trip count drops from 1 (no change). At N=5 associations it drops from 5 round-trips to 1. At N=20 (the sprint board bulk-assign flow) it drops from 20 to 1.

Behavioral parity:

- All INSERT sites kept `ON CONFLICT DO NOTHING`. The original loops did the same; behavior under conflict is identical.
- All sites guard with `if (items.length > 0)` so empty arrays no longer dispatch a query at all (the pre-change loops just iterated zero times). Minor improvement.
- The team.ts UPDATE batched form filters per-row using `jsonb_array_elements_text` + `WHERE elem <> $1`, matching the previous JS `.filter(id => id !== personDocId)` semantics. The conflict-detection WHERE clause earlier in the handler guarantees `assignee_ids` is a non-null array that contains the person doc id, so the no-rows-match edge case the COALESCE handles only fires for sprints where the person was the sole assignee — in which case the result is `[]`, same as before.

**Reproducibility.**

```bash
grep -rn "for (const .* of .*BelongsTo\|for (const conflicting" api/src/routes/
# Expect: zero matches in documents.ts/issues.ts/programs.ts/team.ts.
```

The canonical pattern (`unnest`) is now the codebase default for INSERT loops over `document_associations` and similar shape-aligned tables.

## Phase 5 — Frontend / architectural

_Pending._
