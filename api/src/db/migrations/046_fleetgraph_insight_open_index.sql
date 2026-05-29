-- Migration 046: FleetGraph insight document — defense-in-depth constraints
--
-- The `insight.ts` service (api/src/services/fleetgraph/insight.ts) serializes
-- create-or-refresh upserts via `pg_advisory_xact_lock` keyed on
-- `(workspace_id, subject_id, kind)`. This migration adds the SAFETY NET that
-- catches out-of-band writers (manual SQL, future code paths that forget the
-- lock, backfills) so the "one OPEN insight per (subject, kind)" invariant
-- survives even when the service path is bypassed.
--
-- Two constraints, both idempotent (IF NOT EXISTS / DO NOTHING WHEN EXISTS):
--
--   1. A partial unique index on the JSONB extract keys that enforces
--      "one OPEN row per (workspace_id, subject_id, kind)". Resolved /
--      snoozed / dismissed rows are intentionally NOT covered — append-only
--      history is the design (see plan Decision 5), so multiple non-open
--      rows per (subject, kind) accumulate over time.
--
--   2. A CHECK constraint that validates the shape of
--      `properties.fleetgraph_insight` on insight rows: required sub-fields
--      are non-null and `state` is one of the four valid statuses. Without
--      this, a malformed insert (e.g., missing `subject_id`) silently
--      bypasses the partial unique index — Postgres treats NULL keys as
--      "distinct from everything", so the unique constraint never fires
--      and the defense-in-depth claim is defeated.
--
-- The service never expects to hit the unique index conflict (the advisory
-- lock catches the race first); a 23505 from `insights_open_per_subject_kind`
-- is a contract violation worth alerting on. Likewise the CHECK constraint
-- never fires on service-authored rows; a 23514 indicates an out-of-band
-- writer producing malformed insights.

-- 1. Partial unique index — one OPEN insight per (workspace_id, subject_id, kind)
CREATE UNIQUE INDEX IF NOT EXISTS insights_open_per_subject_kind
  ON documents (
    workspace_id,
    (properties->'fleetgraph_insight'->>'subject_id'),
    (properties->'fleetgraph_insight'->>'kind')
  )
  WHERE document_type = 'insight'
    AND properties->'fleetgraph_insight'->>'state' = 'open'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

-- 2. CHECK constraint — validate insight properties.fleetgraph_insight shape.
-- Idempotent via NOT EXISTS check on pg_constraint (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS in earlier versions; this guards against
-- re-running the migration).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_insight_properties_shape'
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_insight_properties_shape CHECK (
      document_type <> 'insight'
      OR (
        properties->'fleetgraph_insight'->>'subject_id' IS NOT NULL
        AND properties->'fleetgraph_insight'->>'kind' IS NOT NULL
        AND properties->'fleetgraph_insight'->>'state' IN
          ('open', 'resolved', 'snoozed', 'dismissed')
      )
    ) NOT VALID;
    -- NOT VALID skips the full-table check on existing rows (none exist for
    -- insight today). Future migrations can VALIDATE CONSTRAINT once we trust
    -- backfilled data; for now the constraint enforces shape only on new writes.
  END IF;
END $$;
