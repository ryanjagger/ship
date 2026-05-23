-- Migration 042: Wiki/document list ordering index
--
-- Background: GET /api/documents?type=wiki (api/src/routes/documents.ts:129)
-- sorts by (position ASC, created_at DESC) within a (workspace_id,
-- document_type) bucket. Without a matching ordered index, every wiki
-- list request does a sequential scan of the active documents and a
-- top-N heap sort.
--
-- This is the wiki sidebar / wiki list rendering on every protected
-- route until the global wiki provider is route-gated (Phase 5). The
-- impact at 347 wiki rows is small (~0.5ms); it scales linearly.
--
-- See audit/database-query-efficiency/README.md "Candidate indexes".

CREATE INDEX IF NOT EXISTS idx_documents_active_type_position
  ON documents (workspace_id, document_type, position ASC, created_at DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

ANALYZE documents;
