-- Migration 052: oauth_apps.allow_device_flow — restrict the Device Grant to opted-in clients
--
-- The Device Authorization Grant (RFC 8628) authenticates a PUBLIC client by the
-- device_code alone — there is no client_secret check. Without a per-client gate,
-- anyone who knows a CONFIDENTIAL app's (non-secret) client_id could start a
-- device flow under that app's name/scopes and, after tricking a user into
-- approving at /device, receive a bearer token — bypassing the secret the
-- auth-code flow requires.
--
-- So device flow is opt-in per client, defaulting OFF. Only clients explicitly
-- flagged (the first-party CLI seed, or an admin who sets it) may use it;
-- existing confidential apps keep auth-code-only.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS allow_device_flow BOOLEAN NOT NULL DEFAULT false;
