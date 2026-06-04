---
title: E2E developer-portal suite fails — schema.sql has drifted from migrations
date: 2026-06-04
category: test-failures
module: api
problem_type: test_failure
component: testing_framework
symptoms:
  - "All e2e/developer-portal.spec.ts tests fail in setup with `error: relation \"webhook_subscriptions\" does not exist`"
  - "Stack points at e2e/fixtures/isolated-env.ts:423 (the webhook seed), before any test body runs"
  - "Failure is identical across every test in the file and across retries — it's environment setup, not a flaky test"
root_cause: schema_drift
resolution_type: schema_sync
severity: high
related_components:
  - database
  - e2e-testing
  - webhooks
  - developer-portal
tags:
  - e2e
  - playwright
  - schema-sql
  - migrations
  - isolated-env
  - schema-drift
  - test-database
---

# E2E developer-portal suite fails — schema.sql has drifted from migrations

## Problem

The entire `e2e/developer-portal.spec.ts` suite fails during fixture setup:

```
error: relation "webhook_subscriptions" does not exist
   at fixtures/isolated-env.ts:423   (the pre-existing webhook seed)
```

This is **not** caused by any individual test — it's the isolated-env fixture
failing to seed, so every test in the file fails identically (including any
newly added one, e.g. the Connections tab test).

## Root Cause

`e2e/fixtures/isolated-env.ts → runMigrations()` builds each worker's test
database from **`api/src/db/schema.sql` only**. It then *marks* every migration
as applied (inserts rows into `schema_migrations`) **without running them** —
the comment at that step says schema.sql "represents the full current state."

But `schema.sql` is hand-maintained (there is no regen script — `api` build just
`cp`s it to dist) and has **drifted**. It is missing 7 tables that later
migrations created:

| Table | Added by migration |
|-------|--------------------|
| `user_emails` | `013_fix_duplicate_users.sql` |
| `webhook_subscriptions` | `054_webhooks.sql` |
| `webhook_deliveries` | `054_webhooks.sql` |
| `webhook_delivery_attempts` | `054_webhooks.sql` |
| `webhook_events` | `054_webhooks.sql` |
| `public_api_rate_limit_buckets` | `057_public_api_rate_limit_buckets.sql` |
| `public_api_audit_logs` | `058_public_api_audit_logs.sql` |

The last commit to touch `schema.sql` (29dcce8, 2026-06-02) added the OAuth
tables (`access_tokens`, `oauth_device_codes`) but did not fold in the webhook /
public-API / user_emails tables. Because the fixture never runs the migration
files, those tables simply never get created in the test DB.

Reproduce the gap:

```bash
grep -hoiE "CREATE TABLE (IF NOT EXISTS )?[a-z_]+" api/src/db/migrations/*.sql | awk '{print $NF}' | sort -u > /tmp/mig.txt
grep -hoiE "CREATE TABLE (IF NOT EXISTS )?[a-z_]+" api/src/db/schema.sql            | awk '{print $NF}' | sort -u > /tmp/schema.txt
comm -23 /tmp/mig.txt /tmp/schema.txt   # → the 7 missing tables
```

## Fix

Fold the missing tables into `schema.sql` so it once again reflects the full
current schema (it is the source of truth for fresh-DB setup, including the e2e
isolated-env). Port the `CREATE TABLE` + index + trigger DDL verbatim from:

- `013_fix_duplicate_users.sql` (just the `user_emails` table + indexes — not the
  one-off data-migration logic)
- `054_webhooks.sql` (the four webhook tables, their indexes, and the
  `updated_at` trigger)
- `057_public_api_rate_limit_buckets.sql`
- `058_public_api_audit_logs.sql`

Then confirm the `comm -23` diff above is empty and re-run the suite.

> Per CLAUDE.md, "never modify schema.sql for **existing** tables" — adding the
> full set of **current** tables for fresh-DB setup is exactly what schema.sql is
> for, and is consistent with that rule.

### Longer-term

Consider generating `schema.sql` from migrations (apply all migrations to a
scratch DB, `pg_dump --schema-only`) in CI so drift like this fails loudly
instead of silently breaking the e2e harness. A CI check that asserts the
`comm -23` diff is empty would catch the next occurrence at PR time.

## Notes

- The feature work that surfaced this (the Developer Portal "Connections" tab —
  apps holding live access tokens, with revoke) was verified independently:
  type-check, API unit tests, and direct SQL of `listWorkspaceConnections` /
  `revokeWorkspaceConnection` against a scratch DB built from `schema.sql`. Its
  e2e test (`e2e/developer-portal.spec.ts` "Connections tab …") is correct and
  will pass once this drift is fixed; the matching seed is already in
  `isolated-env.ts` (a live `access_tokens` row for the seeded dev app).
