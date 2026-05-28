-- Rename sprint-related document types to week terminology
-- Part of Sprint → Week rename refactor

-- Rename document_type enum values.
-- PostgreSQL 10+ supports ALTER TYPE ... RENAME VALUE, but it is NOT idempotent:
-- replaying it once the rename has happened errors ("sprint_plan is not an
-- existing enum label"). Guard each rename on the OLD label still existing so
-- re-running the migration is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'document_type' AND e.enumlabel = 'sprint_plan') THEN
    ALTER TYPE document_type RENAME VALUE 'sprint_plan' TO 'weekly_plan';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'document_type' AND e.enumlabel = 'sprint_retro') THEN
    ALTER TYPE document_type RENAME VALUE 'sprint_retro' TO 'weekly_retro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'document_type' AND e.enumlabel = 'sprint_review') THEN
    ALTER TYPE document_type RENAME VALUE 'sprint_review' TO 'weekly_review';
  END IF;
END $$;

-- Note: We keep 'sprint' as a document_type because it represents the sprint document itself.
-- The terminology change is "Sprint 3" → "Week of Jan 27" in UI, but the underlying
-- document concept remains valid. The sprint document stores sprint_number and owner_id
-- for derived 7-day windows.

-- Update accountability_type values in issue properties
-- Sprint-related accountability types become week-related
UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_plan"')
WHERE properties->>'accountability_type' = 'sprint_plan';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_review"')
WHERE properties->>'accountability_type' = 'sprint_review';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_start"')
WHERE properties->>'accountability_type' = 'sprint_start';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_issues"')
WHERE properties->>'accountability_type' = 'sprint_issues';
