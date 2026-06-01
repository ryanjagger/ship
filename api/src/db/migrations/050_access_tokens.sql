-- Migration 050: access_tokens — opaque OAuth 2.0 access tokens
--
-- Mirrors the existing api_tokens design (PRD §5.3, locked decision #2): opaque
-- high-entropy strings, SHA-256-hashed at rest (NOT bcrypt — validated on every
-- request, so a fast digest is correct; the token's entropy makes a work factor
-- unnecessary). Buys instant revocation (delete/flag the row), a natural audit
-- hook, and a clean path to refresh-token rotation later — at the cost of one
-- indexed lookup per request.
--
-- Adds app_id + scopes versus api_tokens (which is per-user/workspace only).
-- 1h lifetime, no refresh tokens for the MVP.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS access_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT NOT NULL UNIQUE,
  token_prefix  TEXT NOT NULL,
  app_id        UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- token_hash UNIQUE already indexes the per-request validation lookup.
