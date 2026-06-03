-- System (platform-managed) OAuth clients.
--
-- Distinguishes first-party clients that the product itself depends on (e.g. the
-- `ship` CLI) from apps a super-admin registers. System clients are provisioned
-- here, shown read-only in the admin UI, and cannot be deleted or rotated — so a
-- well-known client_id like `client_ship_cli` can't be accidentally broken.
ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- First-party system client for the `ship` CLI (device-authorization grant, RFC 8628).
-- This is a PUBLIC client: the device grant authenticates by device_code, never by
-- client_secret, and redirect_uris is empty (no auth-code leg), so the stored hash is
-- an unused sentinel that exists only to satisfy the NOT NULL column.
-- On a fresh database this creates the row; on a database where `db:seed:cli` already
-- created it, it marks the existing row system and leaves its real bcrypt hash intact.
INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow, is_system)
VALUES (
  'client_ship_cli',
  'unused-public-client-no-secret',
  'Ship CLI',
  ARRAY[]::text[],
  NULL,
  ARRAY['documents:read', 'documents:write'],
  true,
  true
)
ON CONFLICT (client_id) DO UPDATE SET
  is_system         = true,
  allow_device_flow = true,
  updated_at        = now();
