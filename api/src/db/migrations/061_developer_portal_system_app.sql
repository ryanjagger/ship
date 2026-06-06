-- Migration 061: Developer Portal first-party system client
--
-- The Developer Portal SPA consumes the public API (/api/v1) through the SDK like
-- any other client. It authenticates with short-lived access tokens minted by the
-- session-authenticated exchange endpoint (POST /api/developer/token) — no consent
-- screen, no client secret. A PUBLIC client (NULL secret hash, allowed since
-- migration 059) with no redirect URIs: it never goes through the auth-code or
-- device legs, so tokens can only come from the first-party exchange.
INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, client_type, allow_device_flow, is_system)
VALUES (
  'client_ship_developer_portal',
  NULL,
  'Developer Portal',
  ARRAY[]::text[],
  NULL,
  ARRAY['apps:manage', 'connections:manage', 'audit:read'],
  'public',
  false,
  true
)
ON CONFLICT (client_id) DO UPDATE SET
  is_system        = true,
  requested_scopes = EXCLUDED.requested_scopes,
  client_type      = 'public',
  client_secret_hash = NULL,
  updated_at       = now();
