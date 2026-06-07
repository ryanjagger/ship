-- Migration 062: Fleet agent first-party system client + sweep service user
--
-- The Fleet agent (FleetGraph chat, plan review, scheduled drift sweep) consumes
-- the public API (/api/v1) through the SDK like any third-party agent. Its
-- capabilities ARE this app's scopes. A PUBLIC client (NULL secret hash, allowed
-- since migration 059) with no redirect URIs: tokens are minted in-process
-- (issueAccessToken) — it never goes through the auth-code or device legs.
-- Modeled on migration 061 (Developer Portal system client).
INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, client_type, allow_device_flow, is_system)
VALUES (
  'client_ship_fleet_agent',
  NULL,
  'Fleet Agent',
  ARRAY[]::text[],
  NULL,
  ARRAY['projects:read', 'projects:write', 'issues:read', 'issues:write', 'sprints:read', 'programs:read', 'people:read', 'standups:read', 'comments:read', 'comments:write', 'documents:read'],
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

-- Service user for the scheduled drift sweep (no user session exists there).
-- Non-login: password_hash IS NULL and the password login path rejects
-- NULL-hash users (routes/auth.ts). is_super_admin only neutralizes the
-- workspace-membership check in validateAccessToken — every minted token is
-- bound to ONE workspace with only the app's scopes and a 15-minute TTL, and
-- the v1 read paths have no admin bypass. No workspace_memberships rows are
-- created, so this user is invisible to team/people queries.
INSERT INTO users (email, password_hash, name, is_super_admin)
VALUES ('fleet@ship.system', NULL, 'Fleet', true)
ON CONFLICT (email) DO UPDATE SET
  password_hash  = NULL,
  is_super_admin = true,
  updated_at     = now();
