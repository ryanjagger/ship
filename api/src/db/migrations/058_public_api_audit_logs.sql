-- Migration 058: public API audit trail (PRD §7)
--
-- One row per authenticated `/api/v1/*` request, written on res.finish so status
-- and latency are accurate. Powers the developer-portal "API audit" view and
-- operator request-id correlation. SEPARATE from the internal `audit_logs`
-- table (which has AU-9 compliance triggers); this is customer-visible platform
-- telemetry, not internal security audit.
--
-- Privacy: NO request/response bodies, bearer tokens, or client secrets are
-- ever stored here (enforced by the writer). `client_id` is denormalized so
-- historical logs survive OAuth app deletion (hence no FK on it).
--
-- Retention: default 90 days (pruned by a scheduled job); indexes support the
-- portal's filters (workspace/app/user/status over time).
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public_api_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_id     TEXT,                 -- denormalized: survives app deletion
  app_id        UUID,                 -- no FK: keep the row if the app is deleted
  token_id      UUID,
  user_id       UUID,
  workspace_id  UUID,
  method        TEXT        NOT NULL,
  route         TEXT        NOT NULL,  -- route TEMPLATE (e.g. /api/v1/issues/:id), not raw URL
  scope         TEXT,                 -- the scope actually matched for this call
  status        INTEGER     NOT NULL,
  latency_ms    INTEGER     NOT NULL,
  request_id    TEXT,
  ip_address    TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_public_api_audit_ws_created   ON public_api_audit_logs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_app_created  ON public_api_audit_logs (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_user_created ON public_api_audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_api_audit_status_created ON public_api_audit_logs (status, created_at DESC);

COMMENT ON TABLE public_api_audit_logs IS
  'Customer-visible audit trail of authenticated /api/v1 requests (migration 058).';
