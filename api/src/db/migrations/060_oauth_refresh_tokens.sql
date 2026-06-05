-- Migration 060: OAuth refresh tokens — rotating, hashed-at-rest token families.
--
-- Refresh tokens are opt-in via the `offline_access` scope. Each use rotates to
-- a new refresh token in the same family; reuse of an already-used token revokes
-- the entire family.

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash            TEXT NOT NULL UNIQUE,
  token_prefix          TEXT NOT NULL,
  family_id             UUID NOT NULL,
  app_id                UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  replaced_by_token_id  UUID REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_active
  ON oauth_refresh_tokens (app_id, user_id, workspace_id)
  WHERE revoked_at IS NULL;
