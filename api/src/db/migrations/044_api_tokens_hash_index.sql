-- Migration 044: token_hash lookup index for API-token authentication
--
-- Background: every API-token-authenticated request runs
--
--     SELECT t.id, t.user_id, t.workspace_id, t.expires_at, t.revoked_at,
--            t.last_used_at, u.is_super_admin
--     FROM api_tokens t
--     JOIN users u ON t.user_id = u.id
--     WHERE t.token_hash = $1
--
-- (api/src/middleware/auth.ts:validateApiToken). The existing api_tokens
-- indexes are on user_id, workspace_id, token_prefix — none of which are
-- queried in the auth path. token_hash had no index at all, so every
-- request did a sequential scan of the table. At a handful of tokens this
-- is sub-ms; once CI / CLI / Claude integrations land real automation
-- traffic, the seq scan dominates per-request latency and contends with
-- INSERT/UPDATE traffic on the table.
--
-- Partial-on-revoked: the auth path only accepts non-revoked tokens
-- (line 46 in auth.ts returns null on revoked_at), so revoked rows
-- shouldn't pollute the index. The unique constraint
-- UNIQUE(user_id, workspace_id, name) already prevents name collisions
-- but doesn't help with hash lookup.
--
-- See audit/api-response-time/peer-review.md §6 and
-- audit/api-response-time/implementation.md §1.4.

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens (token_hash)
  WHERE revoked_at IS NULL;

ANALYZE api_tokens;
