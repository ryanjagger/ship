-- Migration 043: Replace idx_documents_visibility_created_by with a targeted
-- created_by index.
--
-- Background: idx_documents_visibility_created_by is btree (visibility, created_by).
-- The intent was to help the OR-shaped visibility predicate:
--
--     visibility = 'workspace' OR created_by = $userId OR $isAdmin = TRUE
--
-- but the planner does not use compound btree indexes for OR predicates
-- (it picks idx_documents_workspace_id and filters in memory). What the
-- compound index DOES get used for is plain WHERE created_by = $1 lookups
-- (weeks.ts has_plan/has_retro correlated subqueries) — but it serves
-- those as an index-cond filter scan over visibility groups, not a true
-- seek.
--
-- A single-column index on created_by, partial on deleted_at IS NULL,
-- is strictly better for those lookups and slightly smaller. The
-- visibility column has its own dedicated index (idx_documents_visibility)
-- if it ever gets used (currently 0 scans).
--
-- See audit/database-query-efficiency/peer-review.md §16.

-- Step 1: create the targeted index.
CREATE INDEX IF NOT EXISTS idx_documents_created_by
  ON documents (created_by)
  WHERE deleted_at IS NULL;

-- Step 2: refresh statistics so the planner can compare the new and
-- old indexes when choosing.
ANALYZE documents;

-- Step 3: drop the compound index that is no longer load-bearing.
-- The planner will route prior consumers (created_by = $1 lookups) to
-- idx_documents_created_by automatically.
DROP INDEX IF EXISTS idx_documents_visibility_created_by;
