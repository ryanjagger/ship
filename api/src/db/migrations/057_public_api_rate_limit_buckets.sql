-- Migration 057: public API rate-limit token buckets (PRD §6)
--
-- Enforces per-OAuth-app and per-access-token limits on `/api/v1/*`, layered on
-- top of the existing per-IP limiter (defense in depth). Each row is one
-- continuous-refill token bucket; the limiter refills + consumes inside a single
-- transaction per request. Bucket keys:
--
--   app:<app_id>      — the coarse per-application budget
--   token:<token_id>  — the finer per-access-token budget
--
-- The effective decision is the STRICTER of the two buckets: a request is
-- allowed only if both have capacity. `remaining` is NUMERIC so fractional
-- continuous refill is exact between requests.
--
-- v1 is Postgres-backed (no Redis dependency); the schema is compact and keyed
-- by primary key so a Redis adapter can replace it later without contract change.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public_api_rate_limit_buckets (
  bucket_key   TEXT PRIMARY KEY,
  bucket_limit INTEGER     NOT NULL,
  remaining    NUMERIC     NOT NULL,
  reset_at     TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public_api_rate_limit_buckets IS
  'Continuous-refill token buckets for /api/v1 rate limiting, keyed app:<id> / token:<id> (migration 057).';
