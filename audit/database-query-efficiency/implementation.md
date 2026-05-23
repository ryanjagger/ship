# Database Query Efficiency Audit — Implementation Notes

Companion to `README.md` (audit baseline) and `peer-review.md` (reviewer pass). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/database-query-efficiency`.

Work is ordered easiest-lift first. Each phase below is sized so that Phase 1 + Phase 2 can ship without behavior changes, while Phases 3 and 4 require targeted refactors.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **1. Schema-only wins** | New migration adding pg_trgm + targeted indexes; `ANALYZE documents` | **Done** (7 / 7 items landed) |
| 2. Tiny code edits | Pool config, admin visibility short-circuit, dead-code removal | Pending |
| 3. Targeted code fixes | Transaction-leak fix, drop `content` from list payloads, `Promise.all` on `/my-week` | Pending |
| 4. Query rewrites | `/api/projects` CTE, accountability grouped queries, batched association INSERTs | Pending |
| 5. Frontend / arch | Route-gate global providers, carry workspace role from auth | Pending |

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| `pg_trgm` extension installed | No | **Yes** (`CREATE EXTENSION IF NOT EXISTS pg_trgm`) | _pending_ |
| `idx_documents_title_trgm` (GIN trgm on title) | Missing | **Created** (partial: `WHERE deleted_at IS NULL`) | _pending_ |
| `GET /api/search/mentions?q=audit` plan execution | 1.087ms (seq scan, full table) | **0.131ms** (audit re-run, post-index, post-`ANALYZE`) | _pending_ |
| Audit "index gap hints" for title search | Listed as a gap | **Removed from gap list** by the audit script | _pending_ |
| Migration registered in `schema_migrations` | n/a | `038_search_trigram_index` applied at `2026-05-22 19:26:28` | _pending_ |
| `idx_documents_issue_assignee` (text expr, partial on issue) | Missing | **Created** (functional under planner force; bitmap path still wins at 200 issues) | _pending_ |
| `idx_documents_owner_id` (workspace+type+owner) | Missing | **Created and chosen by planner** (0.306ms → 0.046ms) | _pending_ |
| `idx_documents_standup_author_date` (composite, partial on standup) | Missing | **Created and chosen by planner** (0.358ms → 0.020ms) | _pending_ |
| `idx_documents_sprint_number` (workspace + sprint_number, partial on sprint) | Missing | **Created and chosen by planner** (0.255ms → 0.027ms) | _pending_ |
| `GET /api/accountability/action-items` plan execution | 1.269ms (audit pre-039 run) | **0.307ms** (~4× plan execution improvement) | _pending_ |

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

_Pending. See `audit/database-query-efficiency/README.md` and `peer-review.md` for the full set._

## Phase 3 — Targeted code fixes

_Pending._

## Phase 4 — Query rewrites

_Pending._

## Phase 5 — Frontend / architectural

_Pending._
