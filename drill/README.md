# `@ship/drill` — the Time-to-First-Event drill

> A platform is judged not by the size of its surface but by how quickly a
> stranger can compose a useful loop on top of it.

This package implements the **Time-to-First-Event (TTFE) drill** (issue #73): a
single command that runs the full developer loop end-to-end against a
freshly-spawned Ship, times each stage, and **fails the build** if any stage
regresses past its threshold.

```bash
pnpm drill ttfe
```

## What it does

Against an ephemeral Ship API (spawned from the built `api/dist`, with webhook
delivery enabled), it drives the five-line developer story and times six stages:

| Stage       | What runs                                                              |
| ----------- | --------------------------------------------------------------------- |
| `install`   | `pnpm pack` the SDK → install the tarball into a clean temp dir → type-check a snippet (proves clean resolution, types load, no peer-dep errors) |
| `login`     | `ShipClient.deviceLogin` (RFC 8628); the device code is auto-approved through the seeded `dev@ship.local` admin session |
| `subscribe` | `client.webhooks.create({ events: ['issue.created'] })`               |
| `trigger`   | `client.issues.create(...)`                                           |
| `receive`   | a local `127.0.0.1` listener receives the signed `POST`              |
| `verify`    | `verifyWebhook` passes for the real delivery; **tampered body, expired timestamp, and missing `v1`** each fail |

It then runs a **CLI smoke check** that proves the published `ship` binaries run
the same loop (`ship login` → `ship issues create` → `ship webhooks tail`).

Results print as a table and are written to `drill/results/ttfe.json` (gitignored;
uploaded as a CI artifact for trend visibility).

## Requirements

- The built workspace packages:
  `pnpm run build:shared && pnpm --filter @ryanjagger/ship-sdk build && pnpm --filter @ship/api build`
- A Postgres to migrate + seed into:
  - set `DATABASE_URL` (CI reuses the `postgres:16` service container), **or**
  - leave it unset and the drill starts a throwaway `@testcontainers/postgresql`
    container (needs Docker).

```bash
# local, against a fresh database
createdb ship_ttfe_drill
DATABASE_URL="postgresql://localhost/ship_ttfe_drill" pnpm drill ttfe
```

## Thresholds (the gate)

Per-stage and total ceilings live in `src/thresholds.ts`; total is the issue's
hard contract of **< 60 s**. The drill exits non-zero if any stage exceeds its
limit or any assertion fails. Override a ceiling for a one-off slow runner via
env, e.g. `TTFE_MAX_TOTAL_MS=90000`. Set `DRILL_DEBUG=1` to stream API logs.

## CI

The `ttfe-drill` job in `.github/workflows/pr-tests.yml` runs `pnpm drill ttfe`
on every PR. Any regression past the configured threshold fails the build.

## Layout

| File                 | Responsibility                                                |
| -------------------- | ------------------------------------------------------------- |
| `src/bin.ts`         | `pnpm drill <name>` dispatcher (room for future drills)       |
| `src/env.ts`         | spawn a migrated/seeded Ship API; resolve Postgres; teardown  |
| `src/auto-approve.ts`| programmatic device-code approval via the admin session       |
| `src/listener.ts`    | raw-body webhook listener with `waitFor`                      |
| `src/ttfe.ts`        | the drill: timed stages, assertions, report, results JSON     |
| `src/cli-smoke.ts`   | functional pass over the `ship` CLI binaries                  |
| `src/thresholds.ts`  | per-stage + total ceilings (the build gate)                   |
