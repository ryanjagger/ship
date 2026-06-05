-- Migration 059: OAuth public clients for browser Auth Code + PKCE
--
-- Browser/SPAs are public OAuth clients: they can keep a client_id, but cannot
-- keep a client_secret. PKCE is the proof of possession for the auth-code
-- exchange. Existing registered apps remain confidential for compatibility.

ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'confidential';

ALTER TABLE oauth_apps
  ALTER COLUMN client_secret_hash DROP NOT NULL;

UPDATE oauth_apps
SET client_type = 'public',
    client_secret_hash = NULL,
    updated_at = now()
WHERE client_id = 'client_ship_cli'
  AND is_system = true;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_apps_client_type_check'
  ) THEN
    ALTER TABLE oauth_apps
      ADD CONSTRAINT oauth_apps_client_type_check
      CHECK (client_type IN ('public', 'confidential'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_apps_confidential_secret_check'
  ) THEN
    ALTER TABLE oauth_apps
      ADD CONSTRAINT oauth_apps_confidential_secret_check
      CHECK (client_type = 'public' OR client_secret_hash IS NOT NULL);
  END IF;
END $$;
