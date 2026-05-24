-- Migration 040: Ticket-number lookup index for issue creation
--
-- Background: every POST that mints an issue ticket_number runs
--
--     SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
--     FROM documents
--     WHERE workspace_id = $1 AND document_type = 'issue'
--
-- under a pg_advisory_xact_lock (issues.ts, documents.ts, feedback.ts).
-- Without a matching index this is an index scan over the entire workspace
-- and an in-memory MAX() over every issue row. At 200 issues it is sub-ms;
-- at 50,000 issues it dominates issue-create wall time, and because every
-- call holds the advisory lock, concurrent issue creates serialize through
-- the same scan.
--
-- A DESC-ordered index lets the planner skip the aggregate entirely:
-- pick the first row in index order and return.
--
-- See audit/database-query-efficiency/peer-review.md §8.

CREATE INDEX IF NOT EXISTS idx_documents_issue_ticket
  ON documents (workspace_id, ticket_number DESC)
  WHERE document_type = 'issue';

ANALYZE documents;
