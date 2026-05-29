-- Rename sprint-related document types to week terminology
-- Part of Sprint → Week rename refactor

-- Rename document_type enum values.
-- PostgreSQL 10+ supports ALTER TYPE ... RENAME VALUE, but it is NOT idempotent.
-- On a diverged DB BOTH the old and new labels can coexist, so a guard on "old
-- label exists" alone still errors ("enum label <new> already exists"). Only
-- rename when the OLD label exists AND the NEW label does NOT — otherwise the
-- rename is already done (or unnecessary), so skip it.
DO $$
DECLARE
  rename RECORD;
BEGIN
  FOR rename IN (
    SELECT * FROM (VALUES
      ('sprint_plan',   'weekly_plan'),
      ('sprint_retro',  'weekly_retro'),
      ('sprint_review', 'weekly_review')
    ) AS r(old_label, new_label)
  ) LOOP
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'document_type' AND e.enumlabel = rename.old_label)
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                       WHERE t.typname = 'document_type' AND e.enumlabel = rename.new_label) THEN
      EXECUTE format('ALTER TYPE document_type RENAME VALUE %L TO %L', rename.old_label, rename.new_label);
    END IF;
  END LOOP;
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
