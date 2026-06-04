-- Migration 056: grant the first-party CLI client the webhook scopes.
--
-- The `ship` CLI now has a `webhooks` command group. Managing subscriptions
-- requires `webhooks:manage`, and subscribing to `person.*` events requires
-- `people:read` (which `documents:read` does not cover). Issued device-flow
-- tokens are constrained to the app's `requested_scopes`, so the CLI client
-- must register these before a CLI token can call the webhook routes.
--
-- Migration 053 seeded client_ship_cli with only documents:read/write and does
-- NOT update scopes on conflict, so this is a standalone idempotent UPDATE.
-- Users must re-run `ship login` to obtain a token carrying the new scopes.

UPDATE oauth_apps
SET requested_scopes = ARRAY['documents:read', 'documents:write', 'webhooks:manage', 'people:read'],
    updated_at = now()
WHERE client_id = 'client_ship_cli';
