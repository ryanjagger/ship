# Database Query Efficiency Audit

## Scope

Measured database query count and slow query shape for the unified document model. The audit focuses on N+1 patterns, missing indexes, full scans, and unnecessary data fetching across five common authenticated user flows.

## Seeded Data

The local audit database used the standard seed plus the audit volume seed from `audit/api-reponse-time/seed-volume.mjs`.

| Data type | Count |
| --- | ---: |
| Users | 36 |
| Documents | 718 |
| Wiki documents | 347 |
| Issues | 200 |
| Programs | 5 |
| Projects | 15 |
| Weeks / sprints | 35 |
| People | 36 |
| Weekly plans | 34 |
| Weekly retros | 25 |
| Standups | 6 |
| Weekly reviews | 15 |

## Method

I counted every SQL statement executed through the shared `pg.Pool` while exercising the API in-process with an authenticated `dev@ship.local` session. This is the same signal as `log_statement = 'all'`, scoped to the audit run so the local PostgreSQL config is not permanently changed.

For a Docker-based run, enable server-side logging with:

```yaml
postgres:
  command:
    - postgres
    - -c
    - log_statement=all
    - -c
    - log_min_duration_statement=0
```

The counts below include authentication/session middleware queries because they are paid by real browser flows. They exclude the login setup request.

Flow endpoint sets:

| Flow | Endpoints traced |
| --- | --- |
| Load main page | App shell endpoints plus `GET /api/dashboard/my-week` |
| View a document | App shell endpoints plus `GET /api/documents/:id`, `GET /api/team/people`, `GET /api/documents/:id/comments` |
| List issues | App shell endpoints ending on `GET /api/issues` |
| Load sprint board | App shell endpoints plus `GET /api/team/grid`, `GET /api/team/projects`, `GET /api/team/assignments` |
| Search content | `GET /api/search/mentions?q=audit` |

The app shell currently includes `GET /api/auth/me`, `GET /api/auth/session`, `GET /api/team/people?includeArchived=true`, `GET /api/documents?type=wiki`, `GET /api/programs`, `GET /api/projects`, `GET /api/issues`, `GET /api/standups/status`, and `GET /api/accountability/action-items`.

## Audit Deliverable

| User Flow | Total Queries | Slowest Query (ms) | N+1 Detected? |
| --- | ---: | ---: | --- |
| Load main page | 57 | 3.42ms | Yes |
| View a document | 59 | 2.38ms | Yes |
| List issues | 48 | 2.57ms | Yes |
| Load sprint board | 65 | 2.00ms | Yes |
| Search content | 5 | 0.84ms | No |

## EXPLAIN ANALYZE Findings

| Query | Execution | Plan signal | Finding |
| --- | ---: | --- | --- |
| `GET /api/projects` list query | 2.679ms | 3 correlated subplans, each `loops=15`; 235 primary-key lookups inside count subplans | Slowest query shape. Counts and inferred status are computed once per project instead of batched. |
| `GET /api/documents?type=wiki` | 0.636ms | Sequential scan of 720 document rows, 347 returned, sort on `position, created_at DESC` | Fast locally, but no index supports the active wiki list order. |
| `GET /api/issues` list query | 1.152ms | Uses `idx_documents_document_type`; sorts 200 rows by JSONB priority and `updated_at` | No SQL N+1 for issue associations because `getBelongsToAssociationsBatch` batches them. Payload is still heavy because `content` is fetched for every issue. |
| `GET /api/search/mentions?q=audit` | 1.087ms | Sequential scan; `title ILIKE '%audit%'`; 440 rows matched before top-N sort | Missing trigram/search index. This will degrade as the unified `documents` table grows. |

## Detailed Observations

- The largest query-count driver is the global app shell, not a specific page. Every protected route mounts deprecated global providers for wiki documents, programs, projects, and issues, even on routes that do not need those lists.
- Auth adds repeated overhead. Each authenticated endpoint runs a session lookup and session activity update. Many route handlers then run another workspace role lookup through `getVisibilityContext`.
- `GET /api/projects` has the clearest N+1-shaped database plan. It executes per-project subplans for sprint count, issue count, and inferred status.
- `GET /api/accountability/action-items` contains application-level N+1 risk. `checkMissingStandups`, `checkSprintAccountability`, and `checkWeeklyPersonAccountability` loop over active sprints or allocations and issue follow-up queries.
- `GET /api/issues` avoids an association N+1 by batching `belongs_to`, but it fetches `content` for every issue in the list view. That is unnecessary list payload.
- `GET /api/search/mentions` is not N+1, but it does a full scan because leading-wildcard `ILIKE` cannot use the existing btree-style indexes.

## Existing Index Coverage

Useful existing indexes:

- `idx_documents_active ON documents(workspace_id, document_type) WHERE archived_at IS NULL AND deleted_at IS NULL`
- `idx_documents_properties ON documents USING GIN (properties)`
- `idx_documents_person_user_id ON documents ((properties->>'user_id')) WHERE document_type = 'person'`
- `idx_document_associations_related_type ON document_associations(related_id, relationship_type)`
- `idx_document_associations_document_type ON document_associations(document_id, relationship_type)`

Gaps:

- No index supports wiki list ordering by `(position ASC, created_at DESC)`.
- No expression index supports sprint lookup by `properties.project_id` and `properties.sprint_number`.
- No lookup index supports weekly plan/retro by `person_id`, `project_id`, and `week_number`.
- No trigram index supports `ILIKE '%term%'` title search.

Candidate indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_active_type_position
  ON documents (workspace_id, document_type, position ASC, created_at DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_sprint_project_week
  ON documents (
    workspace_id,
    ((NULLIF(properties->>'project_id', ''))::uuid),
    (((properties->>'sprint_number')::int))
  )
  WHERE document_type = 'sprint' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_weekly_plan_lookup
  ON documents (
    workspace_id,
    (properties->>'person_id'),
    (properties->>'project_id'),
    (((properties->>'week_number')::int))
  )
  WHERE document_type = 'weekly_plan'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_weekly_retro_lookup
  ON documents (
    workspace_id,
    (properties->>'person_id'),
    (properties->>'project_id'),
    (((properties->>'week_number')::int))
  )
  WHERE document_type = 'weekly_retro'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
  ON documents USING GIN (title gin_trgm_ops)
  WHERE deleted_at IS NULL;
```

## Reduction Plan

### 1. Reduce total query count on sprint board

Baseline: `Load sprint board` executes 65 SQL statements.

Target: reduce to 32 or fewer statements.

Plan:

1. Remove the deprecated global `DocumentsProvider`, `ProgramsProvider`, `ProjectsProvider`, and `IssuesProvider` from the protected app root, or gate their queries by active route. The sprint board needs `team/grid`, `team/projects`, and `team/assignments`; it should not fetch all wiki documents, all issues, and all projects through unrelated providers.
2. Reuse the `/api/auth/me` response for session timeout metadata, or defer `/api/auth/session` until the warning window. This removes one request and about three SQL statements from every cold route load.
3. Carry workspace role/admin state from `authMiddleware` onto the request and let `getVisibilityContext` use it. This avoids repeated `workspace_memberships` lookups per endpoint.
4. Re-run the same trace. Expected result: remove 4 global list endpoints plus duplicate role/session checks, cutting the sprint board from 65 queries to roughly 25-32.

### 2. Improve the slowest query by at least 50%

Baseline: project list query is the slowest statement, measured at 3.42ms in the trace and 2.679ms under `EXPLAIN ANALYZE`.

Target: `EXPLAIN ANALYZE` execution time under 1.34ms and trace time under 1.71ms.

Plan:

1. Rewrite `GET /api/projects` so counts and inferred status are batched in CTEs:
   - `project_docs`: visible project rows.
   - `association_counts`: one grouped scan of `document_associations` joined to `documents` for issue and sprint counts.
   - `sprint_status`: one grouped scan of sprint documents by `properties.project_id`.
2. Join those aggregates back to `project_docs` instead of running correlated subqueries per project.
3. Add `idx_documents_sprint_project_week` so sprint status does not rescan all sprint documents for each project.
4. Verify the new plan has no correlated subplans and no per-project sprint scan loops.

### 3. Follow-up search/index work

Add `pg_trgm` for title search, then re-run `EXPLAIN ANALYZE` on `GET /api/search/mentions?q=audit`. The goal is to replace the current sequential scan with a trigram bitmap scan as document volume grows.

### 4. Payload reduction

Change issue list responses to omit full `content` by default and fetch content only on issue detail. This will not materially reduce SQL count, but it reduces memory, serialization, and transfer cost for `GET /api/issues`.
