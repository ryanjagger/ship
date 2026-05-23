-- Migration 039: Expression indexes for the hot properties->> filter patterns
--
-- Background: the existing idx_documents_properties GIN index on the full
-- properties JSONB column only accelerates containment / key-existence
-- operators (@>, ?, ?&, ?|). It cannot serve the dominant filter pattern
-- in this codebase:
--
--     WHERE (properties->>'assignee_id') = $N
--     WHERE (properties->>'owner_id')    = $N
--     WHERE (properties->>'author_id')   = $N AND (properties->>'date') = $M
--     WHERE (properties->>'sprint_number')::int = $N
--
-- Without expression indexes, every one of these is a sequential scan
-- over the matching (workspace_id, document_type) rows, multiplied across
-- ~28 routes that join on these expressions. See
-- audit/database-query-efficiency/peer-review.md §1 for the analysis.
--
-- All indexes here are partial on (deleted_at IS NULL) — soft-deleted rows
-- are excluded from every hot path — and scoped to the specific
-- document_type that uses the property, so the indexes stay small.

-- 1. Issue assignee lookup: feeds dashboard/my-work, team/assignments,
--    team/grid, and the join in /api/issues.
CREATE INDEX IF NOT EXISTS idx_documents_issue_assignee
  ON documents ((properties->>'assignee_id'))
  WHERE document_type = 'issue' AND deleted_at IS NULL;

-- 2. Owner_id is used for projects, sprints, and programs. The (workspace_id,
--    document_type, owner_id) shape matches the typical filter ordering.
CREATE INDEX IF NOT EXISTS idx_documents_owner_id
  ON documents (workspace_id, document_type, (properties->>'owner_id'))
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- 3. Standup idempotency + status lookups: POST /api/standups checks
--    (author_id, date) on every create; GET /api/dashboard/my-week and
--    GET /api/standups range-scan by author_id + date window.
CREATE INDEX IF NOT EXISTS idx_documents_standup_author_date
  ON documents ((properties->>'author_id'), (properties->>'date'))
  WHERE document_type = 'standup' AND deleted_at IS NULL;

-- 4. Sprint number lookup: the active-sprints list, dashboard week view,
--    and project allocation queries all filter sprints by sprint_number.
CREATE INDEX IF NOT EXISTS idx_documents_sprint_number
  ON documents (workspace_id, ((properties->>'sprint_number')::int))
  WHERE document_type = 'sprint' AND deleted_at IS NULL;

-- Refresh planner statistics so the new expression indexes are picked up
-- without waiting for autovacuum.
ANALYZE documents;
