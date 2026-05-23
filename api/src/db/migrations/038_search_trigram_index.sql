-- Migration 038: Trigram index for document title search
--
-- Background: GET /api/search/mentions and GET /api/search/learnings both use
-- leading-wildcard ILIKE '%term%' filters on documents.title. Btree indexes
-- cannot serve leading wildcards, so the planner falls back to a sequential
-- scan over the entire documents table on every search request.
--
-- The pg_trgm extension provides trigram-based GIN indexing that does serve
-- leading-wildcard ILIKE patterns. Once this index exists, the search query
-- becomes a bitmap heap scan over only matching candidate rows.
--
-- Reference: audit/database-query-efficiency/README.md (search/index work)
-- and audit/database-query-efficiency/peer-review.md §"Search/index work is
-- undersold".

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
  ON documents USING GIN (title gin_trgm_ops)
  WHERE deleted_at IS NULL;
