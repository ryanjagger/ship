# Top-level docs/ audit findings

Audit of factual claims in `docs/*.md` (top-level only) against the actual codebase.

Ground-truth references used:
- `shared/src/types/document.ts` (DocumentType enum: wiki, issue, program, project, sprint, person, weekly_plan, weekly_retro, standup, weekly_review)
- `api/src/db/schema.sql` (documents table, document_associations, sprint_iterations)
- `api/src/db/migrations/` (001-037; 027/029 dropped legacy columns; 033 renamed sprint_plan→weekly_plan, sprint_retro→weekly_retro)
- `api/src/app.ts` (route mounting), `api/src/routes/*`
- `api/src/collaboration/index.ts` (WebSocket setup)
- `web/src/main.tsx` (router), `web/src/components/Editor.tsx`

---

## unified-document-model.md

### [HIGH] unified-document-model.md:80-86 — Claims `program_id` field still exists
**Claim:** "The `program_id` field describes **where** the document lives:" with table showing `null` for workspace-level and `<program_id>` for program-level.
**Reality:** `api/src/db/schema.sql:122-124` explicitly states: "Legacy columns (project_id, sprint_id, program_id) were removed by migrations 027 and 029." All three columns were dropped (027 dropped project_id and sprint_id, 029 dropped program_id).
**Suggested fix:** Replace with "Program association is stored in document_associations table with relationship_type='program'"; remove the `program_id` column description.

### [HIGH] unified-document-model.md:115-122 — Week document has program_id column
**Claim:** "Week documents have: `program_id`: which program"
**Reality:** `program_id` column was dropped in migration 029. Program association is now in `document_associations`.
**Suggested fix:** "Week documents associate with a program via `document_associations` (relationship_type='program')".

### [HIGH] unified-document-model.md:204-231 — Document interface lists removed columns
**Claim:** Document interface shows `program_id: string | null` and `project_id: string | null`.
**Reality:** Both columns were dropped (migrations 027 and 029). Only `parent_id` remains as a column for hierarchy; all org relationships now in `document_associations`.
**Suggested fix:** Remove `program_id` and `project_id` from the interface; document them as junction-table relationships.

### [HIGH] unified-document-model.md:185-198 — Issue lifecycle references project_id/program_id columns
**Claim:** "`program_id` - always set (required)" and "`project_id: "proj_1"` (kept)" as columns on issues.
**Reality:** Both columns dropped in migrations 027/029. Issue→program/project relationships are in `document_associations`.
**Suggested fix:** Reword to "program association (required)" and "project association (kept)" referencing the junction table.

### [HIGH] unified-document-model.md:76 — `view` listed as document type
**Claim:** Table includes `view` document type as "Saved filter/query".
**Reality:** `view` is NOT in the document_type enum in `api/src/db/schema.sql:100` or `shared/src/types/document.ts:38-44`. The doc later notes "Not yet in schema enum" but lists it in the primary types table.
**Suggested fix:** Either remove from main table or clearly mark as "(planned, not yet implemented)".

### [MEDIUM] unified-document-model.md:179-181 — Iteration endpoints under /weeks
**Claim:** "`POST /api/weeks/:id/iterations`" and "`GET /api/weeks/:id/iterations`"
**Reality:** Endpoints exist (`api/src/routes/iterations.ts:26,96` mounted at `/api/weeks` in `app.ts:191`). However, the `sprint_id` parameter in the path actually references the document UUID, regardless of name. Endpoint paths are correct.
**Suggested fix:** No change needed; endpoints verified.

### [LOW] unified-document-model.md:160-171 — sprint_iterations columns described as VARCHAR
**Claim:** "story_id: VARCHAR(200) - PRD story ID", "story_title: VARCHAR(500)", "blockers_encountered: TEXT".
**Reality:** Per `api/src/db/schema.sql:270-282`, `story_id` is `TEXT`, `story_title` is `TEXT`, status uses CHECK constraint not ENUM. Functionally equivalent in PostgreSQL.
**Suggested fix:** Update column types to TEXT (or note "TEXT/VARCHAR equivalent").

### [LOW] unified-document-model.md:166 — status described as ENUM
**Claim:** "status: ENUM('pass', 'fail', 'in_progress')"
**Reality:** `schema.sql:276` uses `TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'in_progress'))`, not a real enum.
**Suggested fix:** Describe as "TEXT with CHECK constraint".

### [LOW] unified-document-model.md:215 — "sprint_id column was dropped by migration 027" but program_id/project_id also dropped
**Claim:** Code comment says: "Note: sprint_id column was dropped by migration 027. Week assignments now use the document_associations table."
**Reality:** True for sprint_id, but the comment omits that program_id (migration 029) and project_id (migration 027) were also dropped.
**Suggested fix:** Expand comment: "sprint_id, project_id (migration 027), and program_id (migration 029) columns were all dropped".

---

## document-model-conventions.md

### [HIGH] document-model-conventions.md:60 — Document types list omits standup and weekly_review
**Claim:** "**Document types:** `wiki`, `issue`, `program`, `project`, `sprint`, `weekly_plan`, `weekly_retro`, `person`"
**Reality:** Enum in `schema.sql:100` and `shared/src/types/document.ts:38-44` also includes `standup` and `weekly_review`.
**Suggested fix:** Add `standup` and `weekly_review` to the list.

### [HIGH] document-model-conventions.md:191-208 — Documents `updateWeekAssociation` function name
**Claim:** Code example calls `updateWeekAssociation(documentId, newWeekId)`.
**Reality:** Actual function in `api/src/utils/document-crud.ts:406` is named `updateSprintAssociation` (historical name retained); no `updateWeekAssociation` exists.
**Suggested fix:** Use the actual function name `updateSprintAssociation` or note "(historical name)".

### [HIGH] document-model-conventions.md:145 — relationship_type set includes 'week'
**Claim:** SQL example: `relationship_type TEXT NOT NULL, -- 'program' | 'project' | 'week'`
**Reality:** `schema.sql:203` defines: `CREATE TYPE relationship_type AS ENUM ('parent', 'project', 'sprint', 'program');`. There is no `'week'` relationship type; the type is `'sprint'`. Also it's an ENUM not TEXT.
**Suggested fix:** Update to `relationship_type relationship_type NOT NULL` with values `'parent' | 'project' | 'sprint' | 'program'`.

### [HIGH] document-model-conventions.md:197,200,211-215 — Examples use `'week'` as relationship_type
**Claim:** `addBelongsToAssociation(issueId, weekId, 'week')`, `syncBelongsToAssociations(..., { id: weekId, type: 'week' })`.
**Reality:** The valid relationship_type is `'sprint'` (per ENUM in schema and `BelongsToType` in `shared/src/types/document.ts:7`).
**Suggested fix:** Replace `'week'` with `'sprint'` in all code examples.

### [HIGH] document-model-conventions.md:356-360 — Team Allocation queries owner_id on weeks
**Claim:** "Week `owner_id` - who is explicitly assigned as week owner ... The `/api/team/assignments` endpoint queries week documents by `owner_id`, not issues by `assignee_id`."
**Reality:** `api/src/routes/team.ts:262-294,459-657` does NOT query by `owner_id`. It uses `properties->'assignee_ids'` (a JSONB array) on sprint documents. The `POST/DELETE /api/team/assign` routes manipulate `assignee_ids` arrays, not a singular `owner_id`.
**Suggested fix:** Update to "uses `properties.assignee_ids` array on sprint documents" or fix the implementation to match the documented model.

### [HIGH] document-model-conventions.md:782-788 — Decision log claims `owner_id` fix was applied
**Claim:** "GET /api/team/assignments - Now queries week documents by `owner_id` (was querying issues by `assignee_id`)"
**Reality:** Current implementation in `team.ts:262-294` queries via `properties->'assignee_ids'`, not `owner_id`. Either the fix was reverted, or never actually shipped.
**Suggested fix:** Reconcile docs with current implementation, or restore the documented `owner_id` model.

### [MEDIUM] document-model-conventions.md:511 — CardGrid component
**Claim:** "**CardGrid** | `<CardGrid>` | Navigable card collections"
**Reality:** No `CardGrid.tsx` component exists in `web/src/components/` (only DocumentTreeItem, KanbanBoard, SelectableList exist).
**Suggested fix:** Remove CardGrid pattern entry, or implement it before documenting.

### [LOW] document-model-conventions.md:125,131 — parent_id examples
**Claim:** "Wiki children, sprint_plan → sprint"
**Reality:** `sprint_plan` was renamed to `weekly_plan` in migration 033.
**Suggested fix:** Use `weekly_plan → sprint` (since sprint document_type was kept).

---

## application-architecture.md

### [HIGH] application-architecture.md:38-68 — Repository structure shows non-existent directories
**Claim:** Lists `web/src/stores/` (Zustand) and `web/src/db/` (IndexedDB access) as directories.
**Reality:** Neither directory exists. `web/src/` actually has: `contexts/`, `test/`, `styles/`, `components/`, `hooks/`, `lib/`, `pages/`, `services/`.
**Suggested fix:** Update the structure to reflect actual layout (no stores/ or db/ dirs).

### [HIGH] application-architecture.md:535-549 — Component folder structure
**Claim:** Shows `web/src/components/documents/` and `web/src/components/layout/` subdirectories.
**Reality:** Neither exists. Actual subdirs are: `ui/`, `document-tabs/`, `week/`, `dashboard/`, `sidebars/`, `review/`, `icons/`, `dialogs/`, `editor/`.
**Suggested fix:** Update component tree to match actual structure.

### [HIGH] application-architecture.md:622-655 — Migration filename convention
**Claim:** "touch api/src/db/migrations/YYYYMMDD_migration_name.sql" with example "20241230_add_sprint_number.sql"
**Reality:** Actual migrations use sequential `NNN_description.sql` format (001-037), not date-based. CLAUDE.md explicitly states "Name files: `NNN_description.sql`".
**Suggested fix:** Update to NNN_description.sql format with current example.

### [HIGH] application-architecture.md:683-700 — Docker setup
**Claim:** "Start database: docker compose up -d postgres"
**Reality:** Per CLAUDE.md and `scripts/dev.sh`, PostgreSQL is run locally (not Docker). `docker-compose.local.yml` exists but the documented dev path is `pnpm dev` against local Postgres.
**Suggested fix:** Replace with `pnpm dev` (which auto-creates DB and runs migrations).

### [HIGH] application-architecture.md:712-720 — Scripts section uses concurrently
**Claim:** `"dev": "concurrently \"pnpm --filter api dev\" \"pnpm --filter web dev\""`
**Reality:** Actual `package.json` has `"dev": "./scripts/dev.sh"`; uses `pnpm --parallel --recursive run dev` internally as `dev:raw`. No `concurrently` package is used.
**Suggested fix:** Quote actual scripts from package.json.

### [HIGH] application-architecture.md:732-737 — Claude integration endpoint table
**Claim:** "`POST /api/issues/:id/history` | Log verification failures" and "`GET /api/search/learnings` | Query past learnings"
**Reality:** Both endpoints exist (`issues.ts:1069`, `search.ts:81`). These are correct. However "`POST /api/weeks`" is documented as creating weeks — but documents use `POST /api/documents` (no dedicated POST /api/weeks for creation; `weeks.ts` is for actions on existing weeks).
**Suggested fix:** Verify each row; `POST /api/weeks` for creation likely should reference document creation flow.

### [MEDIUM] application-architecture.md:457-471 — Dockerfile example
**Claim:** Dockerfile uses `FROM node:20-slim` and `RUN npm ci --production`.
**Reality:** This is illustrative; actual repo Dockerfile may differ.
**Suggested fix:** Note "(illustrative)" or sync with the real Dockerfile if one exists.

### [LOW] application-architecture.md:478 — Aurora Serverless v2
**Claim:** "Database: Aurora Serverless v2 (PostgreSQL)"
**Reality:** Confirmed in `terraform/README.md:144,161` — correct.

### [LOW] application-architecture.md:716-718 — db:generate script
**Claim:** "db:generate": "pnpm --filter api db:generate"
**Reality:** No `db:generate` script in `package.json`. Only `db:seed`, `db:migrate`, `db:orphan-check`.
**Suggested fix:** Remove or replace with actual scripts.

### [LOW] application-architecture.md:386-391 — API tokens endpoints
**Claim:** Endpoints listed: POST `/api/api-tokens`, GET `/api/api-tokens`, DELETE `/api/api-tokens/:id`.
**Reality:** Verified — match `api/src/routes/api-tokens.ts:32,116,152`.

---

## developer-workflow-guide.md

### [HIGH] developer-workflow-guide.md:124-126 — weekly_retro/weekly_plan don't exist
**Claim:** "MISSING: `weekly_retro` document type doesn't exist" and "MISSING: `weekly_plan` document type doesn't exist".
**Reality:** Both ARE in the enum at `schema.sql:100` and `shared/src/types/document.ts:41-42`. Migration 033 (2025) renamed `sprint_plan`/`sprint_retro` → `weekly_plan`/`weekly_retro`. The doc itself is dated 2025-12-30 (per line 5) and is stale.
**Suggested fix:** Update workflows 4-5 to reflect that the types exist; describe the actual creation flow.

### [HIGH] developer-workflow-guide.md:161,260 — URLs use /weeks/
**Claim:** "View week | URL: `/weeks/{id}/view`" and "`/weeks/{id}` | Week editor (document)"; "`/weeks/{id}/view` | Week planning view"
**Reality:** Actual routes in `web/src/main.tsx:228-234` use `sprints/`, not `weeks/`. Examples: `sprints/:id`, `sprints/:id/view`, `sprints/:id/plan`, `sprints/:id/planning`, `sprints/:id/standups`, `sprints/:id/review`. The `weeks` path is not registered (`sprints` was a navigate alias to `/team/allocation`).
**Suggested fix:** Replace `/weeks/...` with `/sprints/...` to match real routes, or rename routes.

### [HIGH] developer-workflow-guide.md:148 — "Week has `goal` field but it's just a text field"
**Claim:** "Week has `goal` field but it's just a text field, not a full document"
**Reality:** Per migration 030 (deprecated goal→hypothesis) and 032 (hypothesis→plan), the field is now `plan` in properties. The `goal` field is deprecated.
**Suggested fix:** Update to reference the `plan` property.

### [MEDIUM] developer-workflow-guide.md:213-217 — Claude CLI commands
**Claim:** Lists `/prd`, `/work`, `/standup`, `/document` as Claude Code commands integrated with Ship.
**Reality:** Cannot verify within Ship repo, but ship-claude-cli-integration.md describes the same commands. Likely accurate.
**Suggested fix:** No change needed.

---

## week-documentation-philosophy.md

### [LOW] week-documentation-philosophy.md:45-53 — Week document type label
**Claim:** "Week (AUTH's Week of Jan 27)    ← document_type: 'sprint'"
**Reality:** Correct — `sprint` is retained as the document_type (per migration 033 note and schema enum).
**Suggested fix:** No change needed.

### [LOW] week-documentation-philosophy.md:23 — sprint_start_date setting
**Claim:** "Workspace has a `sprint_start_date` setting (historical name retained in database)"
**Reality:** Verified in `schema.sql:9` — `sprint_start_date DATE NOT NULL DEFAULT CURRENT_DATE`.
**Suggested fix:** No change needed.

---

## ship-philosophy.md

### [MEDIUM] ship-philosophy.md:158-172 — Issue states
**Claim:** "triage → backlog → todo → in_progress → in_review → done" with `cancelled` as a side state.
**Reality:** Verified in `shared/src/types/document.ts:47`: `IssueState = 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'`. Correct.
**Suggested fix:** No change needed.

### [LOW] ship-philosophy.md:147-154 — Issue association example uses `program_id`
**Claim:** "Issues belong to **programs** (always)" — implicitly suggests as a column.
**Reality:** Program relationships are now in `document_associations`, not a column. This is not strictly wrong (the concept still holds) but may mislead readers seeking the implementation.
**Suggested fix:** Add note about implementation via junction table.

---

## entity-relationships-feature.md

### [HIGH] entity-relationships-feature.md:155-160 — Component locations
**Claim:** "`ActivityChart` | `web/src/components/ActivityChart.tsx`" and "`IncompleteBanner` | `web/src/components/IncompleteBanner.tsx`"
**Reality:** Neither file exists in the repo (verified via `find web/src -name "ActivityChart*" -o -name "IncompleteBanner*"`).
**Suggested fix:** Remove or update with real component locations.

### [MEDIUM] entity-relationships-feature.md:53-64 — Activity endpoint
**Claim:** "GET /api/activity/:entityType/:entityId" with response format including `days` array.
**Reality:** `api/src/routes/activity.ts` defines `/activity/{entityType}/{entityId}` (verified). However, the SQL queries reference `da_sprint` (sprint associations), so entityType values would be program/project/sprint per the implementation.
**Suggested fix:** Document supported entityType values: `program`, `project`, `sprint`.

### [LOW] entity-relationships-feature.md:102-108 — Completeness rules use start_date/end_date
**Claim:** "Week is complete if: `properties.goal && properties.start_date && properties.end_date && linked_issues.length > 0`"
**Reality:** Per document-model-conventions.md and migrations, week dates are computed from `sprint_number`, not stored as `start_date`/`end_date`. The `goal` field is deprecated (now `plan`).
**Suggested fix:** Update rule to reference `properties.plan`, computed dates, and remove start_date/end_date.

---

## ship-claude-cli-integration.md

### [HIGH] ship-claude-cli-integration.md:61-63 — SHIP_URL vs SHIP_API_URL
**Claim:** Uses `SHIP_URL=https://your-ship-instance.example.com` for both Claude Code CLI config and MCP.
**Reality:** application-architecture.md:401-403 documents `SHIP_API_URL` (with `/api` suffix). The MCP server file (`api/src/mcp/server.ts:47`) reads `SHIP_URL`. Two different conventions documented across files.
**Suggested fix:** Standardize: `SHIP_URL` is base URL (no /api), `SHIP_API_URL` (with /api) is for direct curl. Both docs should use the same.

### [MEDIUM] ship-claude-cli-integration.md:122-124 — Issue state transition `claude_metadata.updated_by='claude'`
**Claim:** `claude_metadata.updated_by='claude'` set on `in_progress`.
**Reality:** `IssueProperties` (shared/src/types/document.ts) does not explicitly type `claude_metadata`; the ClaudeMetadata interface is documented in application-architecture.md but not enforced via shared types.
**Suggested fix:** Confirm typing or note that it's stored unstructured in properties JSONB.

---

## fpki-auth-client-dcr-analysis.md

### [HIGH] fpki-auth-client-dcr-analysis.md:725-733 — Federation routes mounted at /api/federation
**Claim:** "Ship mounts federation routes at `/api/federation`" with code example `app.use('/api/federation', federationRoutes);`
**Reality:** No `/api/federation` mount exists in `api/src/app.ts`. No `routes/federation.ts` file exists. PIV auth routes use `caia-auth.ts` mounted at `/api/auth/piv` and `/api/auth/caia` (app.ts:226-227).
**Suggested fix:** Either implement the documented federation routes or remove the "Ship Implementation Details" section as aspirational.

### [HIGH] fpki-auth-client-dcr-analysis.md:840-855 — Vendor SDK
**Claim:** "Ship vendors the SDK locally" with `"@fpki/auth-client": "file:../vendor/@fpki/auth-client"` in api/package.json.
**Reality:** No `vendor/` directory exists in repo. No `@fpki/auth-client` dependency in `api/package.json`.
**Suggested fix:** Remove vendor section or restore the dependency/vendor folder.

### [HIGH] fpki-auth-client-dcr-analysis.md:778-795 — `isFPKIConfigured` and `services/fpki.ts`
**Claim:** References `api/src/services/fpki.ts` and `api/src/services/credential-store.ts`.
**Reality:** No `services/fpki.ts` or `services/credential-store.ts` exists (verified via find). FPKI configuration is referenced but the documented module structure is absent.
**Suggested fix:** Remove references or implement the modules.

### [LOW] fpki-auth-client-dcr-analysis.md:13,45,95,176 — Off-repo file paths
**Claim:** References `/Users/neumankyle/coding/fpki-validator/...` paths.
**Reality:** These are paths on another developer's machine, not portable references.
**Suggested fix:** Use repo-relative or package-relative references like `node_modules/@fpki/auth-client/...`.

---

## shadow-env-testing.md

### [LOW] shadow-env-testing.md:78-92 — Deploy scripts
**Claim:** `./scripts/deploy-api.sh shadow`, `./scripts/deploy-web.sh shadow`, `./scripts/deploy.sh shadow`.
**Reality:** All three scripts exist (`scripts/deploy-api.sh`, `scripts/deploy-web.sh`, `scripts/deploy.sh`). Note `scripts/deploy-frontend.sh` also exists (CLAUDE.md references it instead of deploy-web.sh).
**Suggested fix:** Clarify difference between `deploy-web.sh` and `deploy-frontend.sh`.

---

## whats-new-accountability-system.md

### [MEDIUM] whats-new-accountability-system.md:299-336 — `/hypothesis` slash command
**Claim:** "`/hypothesis` slash command for weeks" with bidirectional sync to `week.properties.hypothesis`.
**Reality:** Migration 032 renamed `hypothesis` → `plan` in properties for both sprint and project document types. The component `HypothesisBlockExtension.ts` still exists (web/src/components/editor/HypothesisBlockExtension.ts), but the property is now `plan`. Also a `PlanReferenceBlock.ts` exists.
**Suggested fix:** Document `/plan` (or whichever is current) and reference `properties.plan` not `properties.hypothesis`.

### [LOW] whats-new-accountability-system.md:407 — "dates now computed from sprint number"
**Claim:** "Week properties cleaned up (dates now computed from sprint number)"
**Reality:** Verified in document-model-conventions.md and schema.
**Suggested fix:** No change needed.

---

## accountability-manager-guide.md / accountability-philosophy.md / performance-management.md / notion-features-research.md

No verifiable factual errors found. These are largely philosophy/UX guides without specific code references. Minor note:

### [LOW] accountability-manager-guide.md:13 — "Teams > Accountability"
**Claim:** "Navigate to **Teams** > **Accountability** to see the grid view."
**Reality:** Routes in `web/src/main.tsx` show `/team/accountability-grid` style paths; `/team/allocation` is the allocation tab. There's no clear "Teams > Accountability" navigation item visible in main.tsx routes (only seeing team/allocation, team/directory, team/status, team/reviews, team/org-chart).
**Suggested fix:** Verify and update navigation reference; possibly "Team > Status" or similar.

---

## Cross-cutting issues

### [HIGH] Multiple docs — Documentation lags 2025 sprint→week rename
Migration 033 (2025) renamed `sprint_plan`→`weekly_plan`, `sprint_retro`→`weekly_retro`. Migration 032 renamed `hypothesis`→`plan`. Many docs still use `hypothesis` exclusively (whats-new-accountability-system.md, entity-relationships-feature.md, accountability-philosophy.md) and don't reflect that `plan` is the canonical property name post-032.
**Suggested fix:** Sweep all docs to use `plan` (with note that `hypothesis` was the previous name).

### [MEDIUM] Multiple docs — Columns presented as if they exist
Several docs still describe `program_id`, `project_id`, `sprint_id` as document columns:
- unified-document-model.md (multiple sections)
- ship-philosophy.md (implicitly)
- entity-relationships-feature.md (week start_date/end_date)

All three columns have been dropped by migrations 027 and 029.
**Suggested fix:** Sweep to replace column references with junction-table associations.
