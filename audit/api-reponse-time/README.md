# API Response Time Audit

## Scope

Measured backend response time under seeded, realistic local data volume. This audit uses the app's normal seed first, then adds audit-specific volume without changing the production seed.

This benchmark is reproducible as a local synthetic test: the scripts, seed data, endpoint list, concurrency levels, and result formatter are checked in. Exact millisecond values will still vary by machine, PostgreSQL state, Node version, and concurrent local workload.

## Reproduction Runbook

Run these commands from the repository root.

### 1. Prerequisites

- Node `>=20`
- pnpm `>=9` (`package.json` currently pins `pnpm@10.27.0`)
- PostgreSQL available locally
- ApacheBench available at `/usr/sbin/ab` on macOS, or set `AB_PATH`
- Playwright browsers installed if you rerun the frontend trace

Install dependencies if needed:

```bash
pnpm install
```

### 2. Use a disposable database

Use a clean database for comparable counts. This deletes only the named benchmark database:

```bash
dropdb --if-exists ship_api_response_time_audit
createdb ship_api_response_time_audit
export DATABASE_URL=postgresql://localhost/ship_api_response_time_audit
```

Every terminal that runs database or API commands needs this `DATABASE_URL` value. If you intentionally want to use `api/.env.local` instead, omit the `DATABASE_URL` export. Do not run this audit against a shared or production-like database.

### 3. Migrate and seed

```bash
pnpm db:migrate
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
```

Verify the final volume without mutating data:

```bash
node audit/api-reponse-time/seed-volume.mjs --summary-only
```

Expected counts for a comparable run:

| Data type | Count |
| --- | ---: |
| Users | 36 |
| Documents | 718 |
| Wiki documents | 347 |
| Issues | 200 |
| Weeks / sprints | 35 |
| Projects | 15 |
| Programs | 5 |

If these counts differ, the benchmark still runs, but the numbers should not be compared directly to the results below.

### 4. Optional frontend trace

The trace is how the original endpoint set was selected. Rerun it when changing benchmark scope.

Start the normal API in one terminal:

```bash
DATABASE_URL=postgresql://localhost/ship_api_response_time_audit \
PORT=3000 \
CORS_ORIGIN=http://localhost:5173 \
SESSION_SECRET=local-trace-secret \
pnpm --filter @ship/api dev
```

Start the web app in a second terminal:

```bash
API_PORT=3000 VITE_PORT=5173 pnpm --filter @ship/web dev
```

Then run the trace in a third terminal:

```bash
WEB_BASE_URL=http://localhost:5173 \
  node audit/api-reponse-time/trace-frontend.mjs \
  | tee audit/api-reponse-time/results/trace-frontend.json
```

The trace logs in, visits these flows, and emits raw request records plus an endpoint summary:

- Login
- My Week
- Docs
- Issues
- Projects
- Team Allocation
- Team Status

### 5. Build and start the benchmark API

Build the production-style API artifact:

```bash
pnpm build:api
```

Start a temporary API instance in a dedicated terminal:

```bash
DATABASE_URL=postgresql://localhost/ship_api_response_time_audit \
PORT=3001 \
CORS_ORIGIN=http://localhost:5173 \
E2E_TEST=1 \
SESSION_SECRET=local-benchmark-secret \
node api/dist/index.js
```

`E2E_TEST=1` raises the local API limiter to `10000` requests per minute. The `3000` request appendix needs pacing to stay below that limit.

If startup fails with `EADDRINUSE`, another process is already using the selected port. Either stop the existing process or choose another port:

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
kill <pid>
```

Or keep the existing process and start the benchmark API on a different port:

```bash
DATABASE_URL=postgresql://localhost/ship_api_response_time_audit \
PORT=3002 \
CORS_ORIGIN=http://localhost:5173 \
E2E_TEST=1 \
SESSION_SECRET=local-benchmark-secret \
node api/dist/index.js

API_BASE_URL=http://localhost:3002 \
BENCHMARK_ENDPOINT_SET=documents-appendix \
BENCHMARK_REQUESTS=3000 \
BENCHMARK_CONNECTIONS=50 \
BENCHMARK_ENDPOINT_DELAY_MS=65000 \
node audit/api-reponse-time/benchmark-ab.mjs
```

### 6. Run the benchmark

In another terminal:

```bash
API_BASE_URL=http://localhost:3001 \
BENCHMARK_REQUESTS=300 \
BENCHMARK_CONNECTIONS=10,25,50 \
node audit/api-reponse-time/benchmark-ab.mjs \
  | tee audit/api-reponse-time/results/benchmark.json
```

Render the Markdown tables from the raw JSON:

```bash
node audit/api-reponse-time/format-results.mjs \
  audit/api-reponse-time/results/benchmark.json
```

The benchmark runner logs in as `dev@ship.local`, sends a real authenticated cookie to ApacheBench, warms each endpoint once, then runs each endpoint/concurrency pair.

### 7. Run the documents appendix

Run this optional appendix when you want p99 for the generic `GET /api/documents` route across all document types. It uses `3000` requests by default for a more meaningful p99 sample and runs only at 50 concurrent connections unless you override `BENCHMARK_CONNECTIONS`.

If you just ran the primary benchmark, wait 65 seconds before starting the appendix so the local rate-limit window resets.

```bash
API_BASE_URL=http://localhost:3001 \
BENCHMARK_ENDPOINT_SET=documents-appendix \
BENCHMARK_REQUESTS=3000 \
BENCHMARK_CONNECTIONS=50 \
BENCHMARK_ENDPOINT_DELAY_MS=65000 \
node audit/api-reponse-time/benchmark-ab.mjs \
  | tee audit/api-reponse-time/results/documents-appendix.json
```

Render the appendix table:

```bash
node audit/api-reponse-time/format-results.mjs \
  audit/api-reponse-time/results/documents-appendix.json
```

The appendix includes `GET /api/documents`, plus `GET /api/documents?type=<document_type>` for every document type. These are generic document-list route measurements; they do not replace dedicated route benchmarks like `GET /api/issues` or `GET /api/projects`, which add their own enrichment and response shape.

### 8. Cleanup

Stop any API or web server terminals with `Ctrl-C`, then remove the disposable database if you no longer need the seeded benchmark data:

```bash
dropdb --if-exists ship_api_response_time_audit
unset DATABASE_URL
```

Generated trace and benchmark JSON files are local artifacts under `audit/api-reponse-time/results/` and are ignored by git. Remove them when you want a clean local output directory:

```bash
rm -f audit/api-reponse-time/results/*.json
```

Configurable script environment:

| Variable | Default | Used by |
| --- | --- | --- |
| `DATABASE_URL` | `api/.env.local` | `seed-volume.mjs`, API server |
| `API_BASE_URL` | `http://localhost:3001` | `benchmark-ab.mjs` |
| `WEB_BASE_URL` | `http://localhost:5173` | `trace-frontend.mjs` |
| `AB_PATH` | `/usr/sbin/ab` | `benchmark-ab.mjs` |
| `BENCHMARK_ENDPOINT_SET` | `primary` | `benchmark-ab.mjs` |
| `BENCHMARK_REQUESTS` | `300` for `primary`, `3000` for `documents-appendix` | `benchmark-ab.mjs` |
| `BENCHMARK_CONNECTIONS` | `10,25,50` for `primary`, `50` for `documents-appendix` | `benchmark-ab.mjs` |
| `BENCHMARK_ENDPOINT_DELAY_MS` | `0` | `benchmark-ab.mjs` |
| `BENCHMARK_EMAIL` / `BENCHMARK_PASSWORD` | `dev@ship.local` / `admin123` | `benchmark-ab.mjs` |
| `TRACE_EMAIL` / `TRACE_PASSWORD` | `dev@ship.local` / `admin123` | `trace-frontend.mjs` |

## Benchmarked Endpoints

The frontend trace showed frequent app-shell calls like `GET /api/auth/session`, `GET /api/auth/me`, and `GET /api/documents?type=wiki`. I excluded the lightweight auth/session polling endpoints from the benchmark target set and focused on the most important data-bearing endpoints from common user flows.

1. `GET /api/documents?type=wiki`
2. `GET /api/issues`
3. `GET /api/projects`
4. `GET /api/dashboard/my-week`
5. `GET /api/team/accountability-grid-v3`

## Documents Appendix

The appendix endpoint set expands the generic documents list route to all types:

- `GET /api/documents`
- `GET /api/documents?type=wiki`
- `GET /api/documents?type=issue`
- `GET /api/documents?type=program`
- `GET /api/documents?type=project`
- `GET /api/documents?type=sprint`
- `GET /api/documents?type=person`
- `GET /api/documents?type=weekly_plan`
- `GET /api/documents?type=weekly_retro`
- `GET /api/documents?type=standup`
- `GET /api/documents?type=weekly_review`

Use `BENCHMARK_ENDPOINT_SET=documents-appendix` to run this set. The formatter includes item count and single authenticated response size when the raw benchmark JSON contains warmup metadata.

## Audit Deliverable

50 simultaneous connections:

| Endpoint | P50 | P95 | P99 |
| --- | ---: | ---: | ---: |
| 1. `GET /api/issues` | 96ms | 112ms | 119ms |
| 2. `GET /api/documents?type=wiki` | 88ms | 95ms | 99ms |
| 3. `GET /api/team/accountability-grid-v3` | 57ms | 64ms | 67ms |
| 4. `GET /api/dashboard/my-week` | 31ms | 48ms | 51ms |
| 5. `GET /api/projects` | 20ms | 25ms | 28ms |

## Detailed Results

| Endpoint | Concurrency | P50 | P95 | P99 | Req/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/documents?type=wiki` | 10 | 18ms | 26ms | 34ms | 524.06 |
| `GET /api/documents?type=wiki` | 25 | 44ms | 51ms | 53ms | 560.41 |
| `GET /api/documents?type=wiki` | 50 | 88ms | 95ms | 99ms | 560.01 |
| `GET /api/issues` | 10 | 20ms | 28ms | 30ms | 491.58 |
| `GET /api/issues` | 25 | 49ms | 59ms | 70ms | 496.02 |
| `GET /api/issues` | 50 | 96ms | 112ms | 119ms | 494.03 |
| `GET /api/projects` | 10 | 4ms | 6ms | 8ms | 2221.50 |
| `GET /api/projects` | 25 | 9ms | 12ms | 14ms | 2467.41 |
| `GET /api/projects` | 50 | 20ms | 25ms | 28ms | 2254.38 |
| `GET /api/dashboard/my-week` | 10 | 6ms | 8ms | 9ms | 1643.15 |
| `GET /api/dashboard/my-week` | 25 | 14ms | 29ms | 31ms | 1580.94 |
| `GET /api/dashboard/my-week` | 50 | 31ms | 48ms | 51ms | 1450.14 |
| `GET /api/team/accountability-grid-v3` | 10 | 12ms | 15ms | 18ms | 798.18 |
| `GET /api/team/accountability-grid-v3` | 25 | 28ms | 32ms | 34ms | 855.69 |
| `GET /api/team/accountability-grid-v3` | 50 | 57ms | 64ms | 67ms | 830.67 |

Single authenticated response sizes:

| Endpoint | Response size |
| --- | ---: |
| `GET /api/issues` | 228.5KB |
| `GET /api/documents?type=wiki` | 176.5KB |
| `GET /api/team/accountability-grid-v3` | 52.8KB |
| `GET /api/projects` | 13.7KB |
| `GET /api/dashboard/my-week` | 0.8KB |

## Slowest Endpoints

### 1. `GET /api/issues`

Slowest result: P99 `119ms` at 50 concurrent connections.

Hypothesis: this endpoint returns the full issue list and had the largest response payload in the benchmark. The route joins users and person documents, extracts and sorts JSONB properties, then batch-fetches `belongs_to` associations for every returned issue. It is probably paying for both database work and JSON serialization/transfer.

Likely improvements:

- Add pagination or list virtualization instead of returning every issue.
- Return lighter list fields and fetch full issue content on detail view.
- Add targeted expression indexes for common JSONB filters/sorts such as state, priority, source, and assignee.
- Keep association fetching batched, but consider precomputed list-view association summaries if this grows.

### 2. `GET /api/documents?type=wiki`

Slowest result: P99 `99ms` at 50 concurrent connections.

Hypothesis: this endpoint is used broadly by the app shell/sidebar and returns all wiki metadata in one response. With 347 wiki documents the payload is already 176.5KB, and the frontend trace showed this endpoint being requested across nearly every route.

Likely improvements:

- Split sidebar tree metadata from full document metadata.
- Cache the wiki tree more aggressively client-side or use ETags.
- Consider incremental loading for deep tree branches.

### 3. `GET /api/team/accountability-grid-v3`

Slowest result: P99 `67ms` at 50 concurrent connections.

Hypothesis: the response is not huge, but the route performs several workspace-wide queries, expands sprint assignment JSON arrays, scans plans and retros for a week range, then groups person/week/program status in application code. This will scale with people count and week range.

Likely improvements:

- Add expression indexes for `weekly_plan` and `weekly_retro` lookup by `person_id`, `project_id`, and `week_number`.
- Precompute or cache plan/retro status per person/week.
- Narrow the default range if the UI does not need all returned weeks at first paint.

## Cross-Cutting Observations

- Tail latency rises roughly linearly from 10 to 50 concurrent connections for the heavier endpoints. The API's development database pool is capped at 10 connections, so 25 and 50 connection runs necessarily queue database work.
- Session auth updates `sessions.last_activity` on authenticated requests. This is realistic for browser traffic, but a many-connection benchmark using one session cookie can add lock contention that would be lower with many real users.
- `300` requests is enough for a quick local regression check, but thin for p99. Use `BENCHMARK_REQUESTS=3000` when p99 is the decision metric.
- None of the measured endpoints failed under load, and all P99 values stayed below `120ms` in this local environment.
