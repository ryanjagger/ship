-- Migration 041: Composite lookup indexes for weekly_plan and weekly_retro
--
-- Background: POST /api/weekly-plans, POST /api/weekly-retros, and the
-- corresponding GET fetches all look up rows by (person_id, week_number)
-- within a workspace. Migration 037 collapsed the previous per-project
-- shape into per-person-per-week, so the active filter is
--
--     workspace_id = $1
--     AND document_type IN ('weekly_plan' | 'weekly_retro')
--     AND (properties->>'person_id') = $2
--     AND (properties->>'week_number')::int = $3
--     AND archived_at IS NULL
--
-- Without a matching expression index every call falls back to scanning
-- the workspace and filtering the JSONB extractions in memory.
--
-- These indexes drop the original README candidate's project_id column
-- because that column is no longer part of the filter shape after
-- migration 037. The README's audit text (audit/database-query-efficiency
-- /README.md "Candidate indexes") predates that migration; the
-- implementation notes in audit/database-query-efficiency/implementation.md
-- §1.4 record the divergence.

CREATE INDEX IF NOT EXISTS idx_documents_weekly_plan_lookup
  ON documents (
    workspace_id,
    (properties->>'person_id'),
    (((properties->>'week_number')::int))
  )
  WHERE document_type = 'weekly_plan'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_weekly_retro_lookup
  ON documents (
    workspace_id,
    (properties->>'person_id'),
    (((properties->>'week_number')::int))
  )
  WHERE document_type = 'weekly_retro'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

ANALYZE documents;
