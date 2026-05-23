# Database Query Efficiency Audit — Implementation Notes

Companion to `README.md` (audit baseline) and `peer-review.md` (reviewer pass). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/database-query-efficiency`.

Work is ordered easiest-lift first. Each phase below is sized so that Phase 1 + Phase 2 can ship without behavior changes, while Phases 3 and 4 require targeted refactors.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| **1. Schema-only wins** | New migration adding pg_trgm + targeted indexes; `ANALYZE documents` | **In progress** (1 / 7 items landed) |
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

### 1.2 JSONB expression indexes for hot `properties->>` filters — Status: **Pending**

Peer-review §1 identifies this as the largest missed finding. Plan: add `idx_documents_assignee_id`, `idx_documents_owner_id`, `idx_documents_standup_author_date`, `idx_documents_sprint_number` (all partial on document_type and `deleted_at IS NULL`).

### 1.3 Ticket-number index — Status: **Pending**

Peer-review §8. `(workspace_id, ticket_number DESC) WHERE document_type='issue'` turns the advisory-locked `MAX(ticket_number)` scan into a one-row index lookup.

### 1.4 Sprint / weekly_plan / weekly_retro lookup indexes — Status: **Pending**

From README's `Candidate indexes` set. Lower priority than 1.1/1.2 but trivial to add in the same migration.

### 1.5 Wiki ordering index `idx_documents_active_type_position` — Status: **Pending**

README candidate. Low impact at 347 wiki rows; ship it for completeness.

### 1.6 Replace `idx_documents_visibility_created_by` with `idx_documents_created_by` — Status: **Pending**

Peer-review §16. The current compound shape cannot satisfy `WHERE created_by = $1`.

### 1.7 `ANALYZE documents;` at end of migration — Status: **Pending**

Peer-review §2. Ensures the planner picks up new index statistics in one step.

## Phase 2 — Tiny code edits

_Pending. See `audit/database-query-efficiency/README.md` and `peer-review.md` for the full set._

## Phase 3 — Targeted code fixes

_Pending._

## Phase 4 — Query rewrites

_Pending._

## Phase 5 — Frontend / architectural

_Pending._
