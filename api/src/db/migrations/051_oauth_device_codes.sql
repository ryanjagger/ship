-- Migration 051: oauth_device_codes — OAuth 2.0 Device Authorization Grant (RFC 8628)
--
-- Backs `ship login` for the CLI: an input-constrained / headless client cannot
-- complete the Auth-Code + PKCE redirect flow, so it requests a device_code +
-- a short human-typable user_code, the user approves at /device in a browser,
-- and the client polls /api/oauth/token until a token is issued.
--
-- The device_code is the bearer secret the client polls with, so it is
-- SHA-256-hashed at rest (same treatment as authorization codes / access
-- tokens). The user_code is the short value the human types; it is low-value and
-- short-lived, kept in the clear so the approval page can look it up.
--
-- Single-use is enforced atomically at redemption via
-- UPDATE ... WHERE consumed_at IS NULL. user_id / workspace_id are NULL until the
-- user approves (binding the eventual token to their current workspace).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code        TEXT NOT NULL UNIQUE,
  app_id           UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  scopes           TEXT[] NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  workspace_id     UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at   TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  approved_at      TIMESTAMPTZ,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- device_code_hash + user_code are both UNIQUE (and thus indexed): the poll
-- lookup is by device_code_hash, the approval lookup is by user_code.
