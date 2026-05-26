---
title: API test suite truncates the shared dev database
date: 2026-05-26
category: test-failures
module: api
problem_type: test_failure
component: testing_framework
symptoms:
  - "Running `pnpm test` (or any API vitest run) empties the local dev database (ship_dev) — documents/users/workspaces all drop to 0"
  - "Seeded/dev data has to be re-created (`pnpm db:seed`) after every test run; it keeps vanishing"
  - "A fix appears to have no effect because a stale `node dist/index.js` build server keeps serving the old compiled code"
root_cause: test_isolation
resolution_type: config_change
severity: high
related_components:
  - database
  - development_workflow
tags:
  - vitest
  - test-database
  - truncate
  - database-url
  - test-isolation
  - dev-server
  - tsx-watch
  - stale-build
---

# API test suite truncates the shared dev database

## Problem
The API vitest setup `TRUNCATE`s every table in `beforeAll`, and it connects through the **same** `DATABASE_URL` as local development (`ship_dev`). There was no dedicated test database, so any `pnpm test` / vitest run — including a single targeted test file — silently wiped the developer's local data (seeded projects, manually created docs, everything).

## Symptoms
- After running the API suite, `SELECT count(*) FROM documents` returns 0; the app shows no projects/users.
- Re-seeding restores data, but the next test run empties it again — the wipe looks intermittent and "haunted."
- A *separate* trap compounds the confusion: code fixes seem not to take effect in the running app (the bug persists after editing source), because a stale `node dist/index.js` server (an old compiled build) is still serving requests alongside the `tsx watch` dev server.

## What Didn't Work
- **Assuming a separate test DB already existed.** It did not — `db/client.ts` reads `process.env.DATABASE_URL`, which `.env.local` points at `ship_dev` for both dev and tests.
- **Re-seeding repeatedly.** Each `pnpm db:seed` was undone by the next vitest run; treating the symptom, not the cause.
- **Blaming the dev server restart / file edits / a phantom `vitest --watch`.** Significant time was lost suspecting that editing `api/src` files (triggering `tsx watch` to restart) wiped the DB. It did not — `tsx watch` only restarts the server; the server does not truncate. The real wiper was the suite's `setup.ts` `TRUNCATE` running against the shared `DATABASE_URL`.
- **Killing servers with `pkill -f "tsx watch"` / `pkill -f vite` only.** Old `node dist/index.js` servers (from a prior `pnpm build`/`start`) survived these pattern kills and kept serving stale code on odd ports, so verified-correct fixes looked broken until those processes were found and killed.

## Solution
Two changes: point the suite at a dedicated `ship_test` database, and add a hard guard so the truncate can never run against a non-test DB.

**1. `api/vitest.config.ts` — override `DATABASE_URL` for tests.** `db/client.ts` calls dotenv `config()`, and dotenv does **not** override an already-set `process.env` value, so a vitest `env` entry wins over `.env.local`:

```ts
test: {
  setupFiles: ['./src/test/setup.ts'],
  env: {
    DATABASE_URL:
      process.env.DATABASE_URL_TEST ||
      'postgresql://ship:ship_dev_password@localhost:5432/ship_test',
    NODE_ENV: 'test',
  },
  // ...
}
```

**2. `api/src/test/setup.ts` — refuse to truncate a non-test DB.** Belt-and-suspenders: even if `DATABASE_URL` is misconfigured, the suite fails loudly instead of destroying data.

```ts
beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db')
  const dbName = rows[0]?.db ?? ''
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to TRUNCATE: connected to "${dbName}", which is not a test database. ` +
      `API tests must run against a DB whose name contains "test" (e.g. ship_test).`
    )
  }
  await pool.query(`TRUNCATE TABLE ... CASCADE`)
})
```

**3. One-time `ship_test` setup.** `schema.sql` lacks later migrations' enum values, and the migration runner aborts re-applying `001..` against an existing schema — so apply `schema.sql` plus only the migrations that add schema not already in it (here, `045`):

```bash
createdb -O ship ship_test
psql -U ship -d ship_test -f api/src/db/schema.sql
psql -U ship -d ship_test -f api/src/db/migrations/045_fleetgraph_document_types.sql
```

Verified: full API suite green against `ship_test`, with `ship_dev` doc count unchanged before and after the run.

## Why This Works
- **dotenv precedence:** `dotenv.config()` never overwrites an existing `process.env` key. Setting `DATABASE_URL` via vitest `env` (applied before any test module imports `db/client.ts`) therefore beats the `.env.local` value the dev server uses.
- **The guard is defense-in-depth:** `current_database()` reflects the *actual* live connection, not config intent. If anything ever points the suite back at a dev/prod DB, it throws before the destructive `TRUNCATE` instead of silently wiping data.

## Prevention
- **Any destructive test setup (`TRUNCATE`, `DROP`, mass `DELETE`) must (a) target an isolated test database and (b) assert at runtime that the live DB is a test DB.** A name check on `current_database()` is cheap and catches misconfiguration loudly.
- **Never share `DATABASE_URL` between dev and the test runner.** Use a distinct DB name containing `test` and an env override in the test config.
- **When a fix "doesn't take effect," suspect a stale build server.** This repo runs dev via `tsx watch src/index.ts` (source), but a prior `pnpm build` + `node dist/index.js` leaves a compiled server running old code. Kill by the actual command, not just the dev pattern:

  ```bash
  pkill -f "node dist/index.js"          # stale compiled build servers
  pkill -f "tsx watch src/index.ts"      # dev source server
  lsof -nP -iTCP -sTCP:LISTEN | grep -E ':30[0-9][0-9]\b'  # confirm only intended server listens
  ```

  Then verify behavior by curling the server directly (and confirm which port the Vite proxy targets) rather than trusting the browser, which may show a cached response or hit a shadow server.
- **Recovery when data is lost:** `pnpm db:seed` regenerates seed data (not hand-created rows). Note the seed reuses projects by title without resetting properties, so re-seeds can leave older projects in a stale state.

## Related Issues
- `docs/solutions/performance-issues/vite-dev-memory-explosion-parallel-tests.md` — another test-harness footgun in this repo (running the full suite/dev together blows up memory). Same theme: the local test/dev setup has sharp edges worth isolating.
