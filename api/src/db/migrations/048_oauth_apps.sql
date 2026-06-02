-- Migration 048: oauth_apps — registered OAuth 2.0 client applications
--
-- Backs the Plugforge Platform API authorization server (Ship as OAuth
-- *provider*). This is unrelated to the CAIA *client* flow (Ship authenticating
-- its own users against an external IdP) in api/src/routes/caia-auth.ts.
--
-- An admin registers an app and receives a client_id plus a raw client_secret
-- shown exactly once (PRD §5.2). Only the bcrypt hash of the secret is stored;
-- the raw value is never recoverable. bcrypt is the right choice HERE because
-- the secret is verified once, at token exchange — not per request. (Contrast
-- access tokens in migration 050, verified on every request, which use SHA-256.)
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, so reruns are no-ops.

CREATE TABLE IF NOT EXISTS oauth_apps (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  name               TEXT NOT NULL,
  redirect_uris      TEXT[] NOT NULL DEFAULT '{}',
  owner_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_scopes   TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- client_id is looked up at /oauth/authorize and /oauth/token. The UNIQUE
-- constraint already provides the supporting index, so no separate index here.
