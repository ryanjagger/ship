-- Migration 049: oauth_authorization_codes — short-lived PKCE auth codes
--
-- Issued at the consent decision and exchanged once at /api/oauth/token for an
-- access token (PRD §5.3). The raw code is SHA-256-hashed before storage (same
-- treatment as access tokens — never store the secret in the clear). Single-use
-- is enforced atomically at exchange via UPDATE ... WHERE consumed_at IS NULL.
--
-- code_challenge / code_challenge_method capture the PKCE challenge supplied at
-- /api/oauth/authorize; the verifier is checked at exchange and never stored.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             TEXT NOT NULL UNIQUE,
  app_id                UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- code_hash UNIQUE already indexes the exchange lookup.
