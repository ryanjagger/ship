-- Migration 054: webhooks — signed, retryable, replayable outbound delivery
--
-- Public `/api/v1` resource events delivered to per-OAuth-app subscriptions
-- (PRD docs/plugforge/webhooks-prd.md). Four tables:
--
--   webhook_subscriptions     — per app+workspace target URL + event set
--   webhook_events            — immutable event store (the outbox)
--   webhook_deliveries        — current delivery state per subscription/event
--   webhook_delivery_attempts — append-only attempt history
--
-- Atomicity: events + their fanned-out deliveries are inserted in the SAME
-- transaction as the document write (transactional outbox), so no event is lost
-- on a crash and none is emitted for a rolled-back write. HTTP dispatch happens
-- after commit, driven by a durable cron tick over `webhook_deliveries`.
--
-- Signing secrets are stored AES-256-GCM-encrypted (HMAC needs the raw secret,
-- so bcrypt is unusable here) plus a one-way fingerprint for display/audit.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  events             TEXT[] NOT NULL,
  encrypted_secret   TEXT NOT NULL,          -- AES-256-GCM: base64(iv|tag|ciphertext)
  secret_fingerprint TEXT NOT NULL,          -- 'sha256:...' — safe to display
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_ws_active
  ON webhook_subscriptions (workspace_id, active);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_app
  ON webhook_subscriptions (app_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT PRIMARY KEY,           -- 'evt_...'
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,
  api_version     TEXT NOT NULL,
  payload         JSONB NOT NULL,             -- full envelope as signed/sent
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_ws_created
  ON webhook_events (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id           UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id                  TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|failed|dead_lettered|replayed
  attempt_count             INT NOT NULL DEFAULT 0,
  next_attempt_at           TIMESTAMPTZ,       -- NULL once terminal
  last_attempt_at           TIMESTAMPTZ,
  last_response_status      INT,
  last_response_body_excerpt TEXT,
  last_error                TEXT,
  delivered_at              TIMESTAMPTZ,
  dead_lettered_at          TIMESTAMPTZ,
  replay_of_delivery_id     UUID REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- THE tick-driving index: only pending rows that are due. Partial keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
-- One ORIGINAL delivery per (subscription, event); replays carry a non-null
-- replay_of_delivery_id and are exempt so a replay can reuse the same event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_deliveries_sub_event_original
  ON webhook_deliveries (subscription_id, event_id)
  WHERE replay_of_delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id           UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  subscription_id       UUID NOT NULL,
  event_id              TEXT NOT NULL,
  attempt_number        INT NOT NULL,
  response_status       INT,
  response_body_excerpt TEXT,
  duration_ms           INT,
  error                 TEXT,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_delivery
  ON webhook_delivery_attempts (delivery_id, attempt_number);
