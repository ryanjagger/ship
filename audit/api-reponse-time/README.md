# API Response Time Audit

## Scope

Measured backend response time under seeded, realistic local data volume. This audit used the app's normal seed first, then added audit-specific volume without changing the production seed.

## Seeded Data

Commands used:

```bash
pnpm db:seed
node audit/api-reponse-time/seed-volume.mjs
```

Final live data volume:

| Data type | Count |
| --- | ---: |
| Users | 36 |
| Documents | 718 |
| Wiki documents | 347 |
| Issues | 200 |
| Weeks / sprints | 35 |
| Projects | 15 |
| Programs | 5 |

## Frontend Trace

Traced the frontend with Playwright across these common flows:

- Login
- My Week
- Docs
- Issues
- Projects
- Team Allocation
- Team Status

Trace command:

```bash
node audit/api-reponse-time/trace-frontend.mjs
```

The trace showed frequent app-shell calls like `GET /api/auth/session`, `GET /api/auth/me`, and `GET /api/documents?type=wiki`. I excluded the lightweight auth/session polling endpoints from the benchmark target set and focused on the most important data-bearing endpoints from common user flows.

Benchmarked endpoints:

1. `GET /api/documents?type=wiki`
2. `GET /api/issues`
3. `GET /api/projects`
4. `GET /api/dashboard/my-week`
5. `GET /api/team/accountability-grid-v3`

## Benchmark Method

Tool: ApacheBench (`ab`)

Command pattern:

```bash
/usr/sbin/ab -q -n 300 -c <connections> -H "Cookie: <authenticated session>" http://localhost:3001<endpoint>
```

I ran a temporary API instance on port `3001` against the same local PostgreSQL database:

```bash
PORT=3001 CORS_ORIGIN=http://localhost:5173 E2E_TEST=1 node api/dist/index.js
```

`E2E_TEST=1` avoids the development IP rate limiter dominating the benchmark. All requests were authenticated with a real session cookie. Each endpoint/concurrency run used 300 requests. Failed requests: `0` for every run.

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
- None of the measured endpoints failed under load, and all P99 values stayed below `120ms` in this local environment.
