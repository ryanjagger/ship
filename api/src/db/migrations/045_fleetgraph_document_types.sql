-- Migration 045: FleetGraph backing-store document/relationship types
-- Adds the hidden 'conversation' document type (chat backing store) and the
-- 'discusses' relationship type linking a conversation to the entity it
-- discussed. Also reserves 'insight' now (no consumer this iteration) to avoid
-- a second ALTER TYPE migration when the deferred no-user-present sweep builds
-- insights-as-documents.
--
-- These enum values are NOT used in this same transaction (no INSERT references
-- them here), so ADD VALUE is safe through the migration runner's per-migration
-- BEGIN/COMMIT wrapper. Mirrors migration 017's idempotency pattern exactly.

-- Add 'conversation' to document_type enum (hidden backing store for chat)
DO $$ BEGIN
  ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'conversation';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add 'insight' to document_type enum (reserved; no consumer this iteration)
DO $$ BEGIN
  ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'insight';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add 'discusses' to relationship_type enum (conversation -> discussed entity)
DO $$ BEGIN
  ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'discusses';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
