# Claude-Reference Audit Findings

## INDEX.md

### [LOW] INDEX.md:83 — week-documentation-philosophy.md filename
**Claim:** "`docs/week-documentation-philosophy.md` - Week workflow"
**Reality:** Actual filename is `docs/week-documentation-philosophy.md` exists, but project CLAUDE.md references `docs/sprint-documentation-philosophy.md`. Both filenames exist in repo? Verified: `docs/week-documentation-philosophy.md` IS present (`ls docs/` confirms). LOW because filename matches reality.
**Suggested fix:** No change needed; documented path is correct.

### [LOW] INDEX.md:102-103 — Deploy commands use deploy-web.sh
**Claim:** "`./scripts/deploy-web.sh shadow`"
**Reality:** Both `scripts/deploy-web.sh` and `scripts/deploy-frontend.sh` exist; CLAUDE.md uses `deploy-frontend.sh`. The INDEX.md command is valid since the script exists.
**Suggested fix:** No fix required.

---

## architecture.md

### [HIGH] architecture.md:62-65 — document_type enum is stale
**Claim:** `CREATE TYPE document_type AS ENUM ('wiki', 'issue', 'program', 'project', 'sprint', 'person', 'sprint_plan', 'sprint_retro');`
**Reality:** Actual enum in `api/src/db/schema.sql:100`: `('wiki', 'issue', 'program', 'project', 'sprint', 'person', 'weekly_plan', 'weekly_retro', 'standup', 'weekly_review')`. Doc lists `sprint_plan`/`sprint_retro` (wrong) and is missing `standup` and `weekly_review`.
**Suggested fix:** Update enum list to match schema.sql:100.

### [HIGH] architecture.md:71-75 — Document type table missing types
**Claim:** Table lists wiki, issue, program, project, sprint, person only.
**Reality:** Shared types include `weekly_plan`, `weekly_retro`, `standup`, `weekly_review` (`shared/src/types/document.ts:34-44`).
**Suggested fix:** Add the four missing types to the table.

### [HIGH] architecture.md:74 — sprint properties claim
**Claim:** "`sprint` ... `sprint_number, owner_id`"
**Reality:** `WeekProperties` in `shared/src/types/document.ts:154-173` includes many more fields (status, plan, success_criteria, confidence, plan_history, plan_approval, review_approval, review_rating). Listing only `sprint_number, owner_id` is incomplete but factually accurate that these are required keys. LOW.
**Suggested fix:** Note this is partial list.

### [HIGH] architecture.md:90-92 — Document interface includes program_id/project_id
**Claim:** `program_id?: string | null; project_id?: string | null;` are on Document interface.
**Reality:** `shared/src/types/document.ts:245-246`: "Note: program_id, project_id, and sprint_id removed - use belongs_to array instead. These columns were dropped by migrations 027 and 029." Document interface has no `program_id` or `project_id` fields.
**Suggested fix:** Remove `program_id` and `project_id` from Document interface example; note they were dropped by migrations 027 and 029.

### [HIGH] architecture.md:109-117 — IssueProperties type signature
**Claim:** `state: IssueState; // 'triage' | 'backlog' | 'todo' | 'in_progress' | 'done' | 'cancelled'`
**Reality:** `shared/src/types/document.ts:47`: `IssueState = 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'`. The doc is missing `'in_review'`.
**Suggested fix:** Add `'in_review'` to enumerated values.

### [HIGH] architecture.md:116 — IssueSource values
**Claim:** "`source: IssueSource; // 'internal' | 'external'`"
**Reality:** `shared/src/types/document.ts:53`: `IssueSource = 'internal' | 'external' | 'action_items'`. Missing `'action_items'`.
**Suggested fix:** Add `'action_items'` to source enum.

### [HIGH] architecture.md:340-348 — computeWeekDates function does not exist
**Claim:** `// shared/src/types/document.ts:341-366  export function computeWeekDates(sprintNumber: number, workspaceStartDate: Date) {...}`
**Reality:** No such function in `shared/src/types/document.ts`. The only exported function is `computeICEScore` (line 339). No `computeWeekDates` or equivalent exists in shared/.
**Suggested fix:** Remove this code example or replace with a real function.

### [HIGH] architecture.md:373-376 — schema.sql line refs and columns wrong
**Claim:** "`-- api/src/db/schema.sql:107-116`  `program_id UUID REFERENCES documents(id), project_id UUID REFERENCES documents(id),`"
**Reality:** `schema.sql:122-124` says: "Associations: program, project, and sprint relationships are stored in document_associations table -- Legacy columns (project_id, sprint_id, program_id) were removed by migrations 027 and 029." These columns no longer exist.
**Suggested fix:** Remove the SQL snippet showing `program_id`/`project_id` columns; reference the associations table.

### [LOW] architecture.md:182-202 — collaboration line ref 598-720
**Claim:** "`// api/src/collaboration/index.ts:598-720 (key sections)`"
**Reality:** `setupCollaboration` is at line 606, file is 834 lines (the 598-720 range is roughly accurate).
**Suggested fix:** Update line range to e.g. 606-700.

### [LOW] architecture.md:48 — api/src/index.ts:1-44
**Claim:** "`api/src/index.ts:1-44`"
**Reality:** File is 48 lines.
**Suggested fix:** Adjust to 1-48.

### [MEDIUM] architecture.md:236 — sprint room prefix
**Claim:** "`sprint:{uuid} - Weeks (historical room prefix)`"
**Reality:** Room prefix is determined by client; `parseDocId` only extracts the UUID. Modules/editor.md and other docs use `wiki:`, `issue:`, etc. Document type enum still uses `sprint`. Statement is acceptable but ambiguous.
**Suggested fix:** Clarify that this is the room prefix used when the document_type is `sprint`.

---

## anti-patterns.md

### [HIGH] anti-patterns.md:16-19 — Wrong absolute paths
**Claim:** Paths like `/Users/jonesshaw/Documents/code/ship/api/src/routes/issues.ts:283`
**Reality:** This is a different user's home directory. Project is at `/Users/ryan/gauntlet/ship/`. Actual issues.ts line 240 has `console.error('List issues error:', err);` (doc says line 283).
**Suggested fix:** Use repo-relative paths (`api/src/routes/issues.ts:240`) instead of absolute jonesshaw paths throughout this file.

### [HIGH] anti-patterns.md:17 — standups.ts line ref
**Claim:** "`api/src/routes/standups.ts:108`"
**Reality:** Actual line: `api/src/routes/standups.ts:299`.
**Suggested fix:** Update line number.

### [HIGH] anti-patterns.md:34 — logger import path
**Claim:** "`import { logger } from '../utils/logger';`"
**Reality:** No `api/src/utils/logger.ts` exists. Available utils: `allocation.ts`, `business-days.ts`, `document-content.ts`, `document-crud.ts`, `extractHypothesis.ts`, `transformIssueLinks.ts`, `yjsConverter.ts`.
**Suggested fix:** Either acknowledge no logger exists yet, or document this as a recommended utility to add.

### [HIGH] anti-patterns.md:174-199 — All file paths use wrong user prefix
**Claim:** `/Users/jonesshaw/Documents/code/ship/...`
**Reality:** Throughout this file all absolute paths are wrong (foreign user). Should be repo-relative.
**Suggested fix:** Replace all `/Users/jonesshaw/Documents/code/ship/` prefixes with relative paths.

### [HIGH] anti-patterns.md:256-259 — issues.ts line numbers
**Claim:** "`api/src/routes/issues.ts:284-933`", "`issues.ts:517`"
**Reality:** issues.ts has 1900+ lines but those specific line numbers don't correspond to the described content (line 240, 241 etc are the actual error sites).
**Suggested fix:** Update line numbers to current code (e.g., 240, 241 for List issues error).

### [HIGH] anti-patterns.md:319-321 — Types in route files line refs
**Claim:** "`api/src/routes/weeks.ts:265`", "`api/src/routes/backlinks.ts:158`", "`api/src/routes/issues.ts:105`"
**Reality:** Cannot verify all without reading each, but `issues.ts:105` does not contain `interface BelongsToEntry` — `BelongsToEntry` is imported from shared (`issues.ts:12: type BelongsToEntry,`). It is NOT defined locally.
**Suggested fix:** Remove `issues.ts:105 - BelongsToEntry interface` claim; BelongsToEntry is exported from `@ship/shared` (`shared/src/types/document.ts:10`).

### [MEDIUM] anti-patterns.md:420-421 — Transaction line refs
**Claim:** "`api/src/routes/issues.ts:513-582` - Issue creation"
**Reality:** Issue POST handler is at `issues.ts:563`. The range 513-582 covers a region but may not match. LOW.
**Suggested fix:** Update to actual range starting at 563.

### [MEDIUM] anti-patterns.md:461-462 — Transactions in documents.ts
**Claim:** "`api/src/routes/documents.ts:907-1002`"
**Reality:** documents.ts router includes POST /:id/convert at line 1144, undo-conversion at line 1346. Line range 907-1002 likely is within PATCH /:id (line 594). LOW – impossible to verify exact transaction location without re-reading.
**Suggested fix:** Re-verify line ranges.

---

## api-reference.md

### [HIGH] api-reference.md:113 — Document types list incomplete
**Claim:** "All content types (wiki, issue, program, project, sprint, person) are stored as documents"
**Reality:** Also includes `weekly_plan`, `weekly_retro`, `standup`, `weekly_review`.
**Suggested fix:** Add the four additional document types.

### [HIGH] api-reference.md:122 — Document type filter values
**Claim:** "`type` - Filter by document_type (wiki, issue, program, project, sprint, person)"
**Reality:** Same as above — missing 4 newer types.
**Suggested fix:** Include all 10 types.

### [HIGH] api-reference.md:178 — sprint_status property name
**Claim:** "Week fields: `start_date`, `end_date`, `sprint_status` (historical name), `goal`"
**Reality:** `WeekProperties` (`shared/src/types/document.ts:154-173`) has `status` (not `sprint_status`), `plan` (not `goal`). No `start_date`/`end_date` (dates are computed from `sprint_number`).
**Suggested fix:** Remove `start_date`/`end_date`/`sprint_status`/`goal`; document `status`, `plan`, `sprint_number`, `owner_id`.

### [HIGH] api-reference.md:209 — priority values
**Claim:** "`priority` - urgent, high, medium, low, none"
**Reality:** `IssuePriority` type (`shared/src/types/document.ts:50`) is `'low' | 'medium' | 'high' | 'urgent'`. No `none`.
**Suggested fix:** Remove `none`.

### [HIGH] api-reference.md:243 — week_id query param
**Claim:** "`week_id` - Filter by week association (via document_associations table)"
**Reality:** `api/src/routes/issues.ts:117` destructures `sprint_id`, not `week_id`. The filter uses `sprint_id` as the param name (line 182).
**Suggested fix:** Change `week_id` to `sprint_id`.

### [HIGH] api-reference.md:438-440 — Project response fields
**Claim:** `"missing_fields": ["hypothesis"]`, `inferred_status`
**Reality:** Project hypothesis field was renamed to `plan` by migration 032 (`032_rename_hypothesis_to_plan.sql`). Field `plan` is the current term. The response example claims `hypothesis` as a missing field.
**Suggested fix:** Change `hypothesis` to `plan` in example.

### [HIGH] api-reference.md:467 — POST /api/projects fields
**Claim:** Request body includes `"hypothesis": null`
**Reality:** Migration 032 renamed `hypothesis` to `plan`.
**Suggested fix:** Replace `hypothesis` with `plan`.

### [HIGH] api-reference.md:507-512 — POST /api/projects/:id/weeks fields
**Claim:** Fields include `goal`, `hypothesis`
**Reality:** Migration 032/030 deprecated/renamed these. Weeks have `plan`. The `projects/:id/sprints` POST exists (`api/src/routes/projects.ts:1323`); not `/weeks`.
**Suggested fix:** Note that the actual project sub-route is POST `/api/projects/:id/sprints` (line 1323); fields should use `plan`.

### [HIGH] api-reference.md:496-500 — POST /api/projects/:id/weeks endpoint
**Claim:** "POST /api/projects/:id/weeks"
**Reality:** `api/src/routes/projects.ts` exposes `/api/projects/:id/sprints` (POST at line 1323) and `/api/projects/:id/weeks` (GET at line 1205 only). No POST to `/weeks`.
**Suggested fix:** Document POST as `/api/projects/:id/sprints` or note the actual route.

### [HIGH] api-reference.md:516-543 — Project retro fields
**Claim:** `hypothesis_validated`, etc.
**Reality:** Migration 030 deprecated `goal` to `hypothesis`, migration 032 renamed `hypothesis` to `plan`. ProjectProperties has `plan_validated` (`document.ts:119`), not `hypothesis_validated`.
**Suggested fix:** Replace `hypothesis_validated` with `plan_validated`.

### [HIGH] api-reference.md:548 — Weeks document_type
**Claim:** "Weeks are documents with `document_type = 'sprint'` (historical name). They have numbered weeks and hypothesis-driven goals."
**Reality:** Sprints use `plan` not `hypothesis` per migration 032.
**Suggested fix:** Update "hypothesis-driven goals" to "plan-driven goals" or similar.

### [HIGH] api-reference.md:556-558 — /api/weeks/my-action-items
**Claim:** "GET /api/weeks/my-action-items"
**Reality:** No such route in `api/src/routes/weeks.ts`. Closest match is `GET /action-items` in issues.ts at line 246 (`/api/issues/action-items`). Weeks router has `GET /my-week` at line 548.
**Suggested fix:** Remove or move this endpoint to `/api/issues/action-items`.

### [HIGH] api-reference.md:592-604 — PATCH /api/weeks/:id/hypothesis
**Claim:** "PATCH /api/weeks/:id/hypothesis" with `hypothesis` field
**Reality:** `api/src/routes/weeks.ts:1349` is `router.patch('/:id/plan', ...)`. Endpoint is `/plan` not `/hypothesis` (migration 032 rename).
**Suggested fix:** Rename to `PATCH /api/weeks/:id/plan` and `plan` body field.

### [HIGH] api-reference.md:613-617 — /api/weeks/:id/scope-changes
**Claim:** Endpoint listed without auth specifics; verified it exists at `weeks.ts:1609`.
**Reality:** OK.
**Suggested fix:** None.

### [HIGH] api-reference.md:640-655 — /api/weeks/:id/review
**Claim:** GET/POST/PATCH `/api/weeks/:id/review`
**Reality:** Endpoints exist at `weeks.ts:2157, 2271, 2384`. OK.
**Suggested fix:** None.

### [HIGH] api-reference.md:752 — /api/workspaces/:id/audit-logs
**Claim:** Endpoint exists.
**Reality:** Confirmed at `workspaces.ts:1021`. OK.
**Suggested fix:** None.

### [MEDIUM] api-reference.md:864-865 — WebSocket message types
**Claim:** "Message Types: `0` - Sync message, `1` - Awareness message"
**Reality:** `api/src/collaboration/index.ts:14-17` defines 4 types: `messageSync = 0`, `messageAwareness = 1`, `messageCustomEvent = 2`, `messageClearCache = 3`.
**Suggested fix:** Add messages 2 (custom event) and 3 (clear cache).

### [LOW] api-reference.md:856 — WebSocket route format
**Claim:** "WebSocket /collaboration/:docType::docId"
**Reality:** Format uses single colon between type and ID: `/collaboration/wiki:uuid` (shown in example line 878). The `::docId` notation is wrong (extra colon).
**Suggested fix:** Use `/collaboration/{docType}:{docId}`.

---

## code-examples.md

### [HIGH] code-examples.md:106-110 — DELETE issue uses wrong column names
**Claim:** `'DELETE FROM document_associations WHERE source_document_id = $1 OR target_document_id = $1'`
**Reality:** `document_associations` table uses `document_id` and `related_id` (`schema.sql:211-212`), not `source_document_id`/`target_document_id`. The legacy migration 020 used those names but migration 020 was renumbered and the table now uses document_id/related_id (per schema).
**Suggested fix:** Use `document_id = $1 OR related_id = $1`.

### [HIGH] code-examples.md:354-366 — Migration 020 column names
**Claim:** Migration 020 example shows `source_document_id`, `target_document_id`.
**Reality:** Per `schema.sql:209-222`, the live table uses `document_id`, `related_id`. Original migration may have used the source/target names which is why this looks confusing.
**Suggested fix:** Update example to reflect current production column names `document_id`, `related_id`.

### [HIGH] code-examples.md:386-396 — testcontainers postgres image
**Claim:** `new PostgreSqlContainer('postgres:16')`
**Reality:** `e2e/fixtures/isolated-env.ts` uses a specific postgres image — patterns.md line 473 shows `postgres:15`. Likely actual image differs from `postgres:16`.
**Suggested fix:** Verify against `e2e/fixtures/isolated-env.ts` and use the actual image tag.

### [HIGH] code-examples.md:462 — WebSocket URL construction
**Claim:** "`const wsUrl = ${import.meta.env.VITE_WS_URL}/collaboration;`"
**Reality:** `web/src/components/Editor.tsx:332` constructs `wsUrl` from `apiUrl` (not `VITE_WS_URL`). No `VITE_WS_URL` env var is used.
**Suggested fix:** Show actual URL construction from the API URL.

### [LOW] code-examples.md:412-415 — E2E login fixture credentials
**Claim:** `dev@ship.local / admin123`
**Reality:** Matches usage in actual E2E tests. OK.
**Suggested fix:** None.

### [MEDIUM] code-examples.md:330-340 — VISIBILITY_FILTER_SQL signature
**Claim:** Function accepts `(tableAlias, userIdParam, isAdminParam)`.
**Reality:** Confirmed in `api/src/middleware/visibility.ts:49`. OK.
**Suggested fix:** None.

---

## commands.md

### [LOW] commands.md:15 — `.ports` file claim
**Claim:** "5. Writes `.ports` file showing which ports are in use"
**Reality:** `scripts/dev.sh` line 7 mentions ".ports file for reference" — confirmed.
**Suggested fix:** None.

### [LOW] commands.md:132 — deploy-web.sh
**Claim:** "`./scripts/deploy-web.sh <dev|shadow|prod>`"
**Reality:** Both `deploy-web.sh` and `deploy-frontend.sh` exist. CLAUDE.md uses `deploy-frontend.sh`. Both are functional.
**Suggested fix:** Consider clarifying which is canonical (CLAUDE.md prefers `deploy-frontend.sh`).

### [LOW] commands.md:73 — Seed script location
**Claim:** "Script: `api/src/db/seed.ts`"
**Reality:** Confirmed exists. OK.
**Suggested fix:** None.

---

## data-model.md

### [HIGH] data-model.md:13 — Tables overview missing document_snapshots, sprint_iterations, issue_iterations, etc
**Claim:** Lists `documents`, `document_associations`, `document_history`, `document_links` for content.
**Reality:** Schema also has `document_snapshots` (`schema.sql:237`), `issue_iterations`, `comments`, `oauth_state`.
**Suggested fix:** Add missing tables to overview.

### [HIGH] data-model.md:25 — sprint_iterations description
**Claim:** "`sprint_iterations` | Claude Code work session tracking (historical table name)"
**Reality:** Table exists at `schema.sql:270`. The description is OK but `issue_iterations` is also a table.
**Suggested fix:** Add `issue_iterations` to overview.

### [HIGH] data-model.md:49-51 — program_id/project_id columns
**Claim:** Documents table still has `program_id`, `project_id` columns.
**Reality:** Per `schema.sql:122-124`: legacy columns were removed by migrations 027 and 029. Documents table no longer has these columns.
**Suggested fix:** Remove these columns from the example; reference `document_associations` instead.

### [HIGH] data-model.md:79-90 — document_type enum
**Claim:** Lists 10 enum values including `sprint_plan`, `sprint_retro`, `sprint_review` for week subtypes.
**Reality:** Actual enum (`schema.sql:100`): `'wiki', 'issue', 'program', 'project', 'sprint', 'person', 'weekly_plan', 'weekly_retro', 'standup', 'weekly_review'`. Doc uses `sprint_plan`/`sprint_retro`/`sprint_review` — these names are WRONG; actual values use `weekly_*` prefix.
**Suggested fix:** Replace `sprint_plan` → `weekly_plan`, `sprint_retro` → `weekly_retro`, `sprint_review` → `weekly_review`.

### [HIGH] data-model.md:99-105 — Issue/Program/Project properties wrong
**Claim:** "`issue` | `state`, `priority`, `assignee_id`, `source`, `rejection_reason`, `feedback_status`, `estimate_hours`, `claude_metadata`"
**Reality:** `IssueProperties` (`document.ts:73-89`) has `state`, `priority`, `assignee_id`, `estimate` (not `estimate_hours`), `source`, `rejection_reason`, `due_date`, `is_system_generated`, `accountability_target_id`, `accountability_type`. No `feedback_status` or `claude_metadata` fields.
**Suggested fix:** Replace with actual IssueProperties fields.

### [HIGH] data-model.md:100 — Program properties wrong
**Claim:** "`program` | `prefix` (e.g., \"AUTH\"), `color`, `emoji`"
**Reality:** `ProgramProperties` (`document.ts:91-100`): `color`, `emoji`, `owner_id`, `accountable_id`, `consulted_ids`, `informed_ids`. No `prefix` field.
**Suggested fix:** Remove `prefix`; add RACI fields.

### [HIGH] data-model.md:101 — Project properties wrong
**Claim:** "`project` | `prefix`, `color`, `emoji`"
**Reality:** `ProjectProperties` (`document.ts:105-131`): ICE scores (`impact`, `confidence`, `ease`), RACI fields, color, emoji, `plan_validated`, monetary impact, success_criteria, approvals. No `prefix`.
**Suggested fix:** Replace with actual ProjectProperties fields.

### [HIGH] data-model.md:102 — Sprint properties wrong
**Claim:** "`sprint` | `sprint_number` (historical field), `owner_id`, `goal`"
**Reality:** `WeekProperties` (`document.ts:154-173`): `sprint_number`, `owner_id`, `status`, `plan`, `success_criteria`, `confidence`, `plan_history`, `plan_approval`, `review_approval`, `review_rating`. No `goal` field.
**Suggested fix:** Replace `goal` with `plan`; list other fields.

### [HIGH] data-model.md:103 — Person properties wrong
**Claim:** "`person` | `user_id` (links to users.id), `email`, `capacity_hours`, `skills`"
**Reality:** `PersonProperties` (`document.ts:175-181`): `email`, `role`, `capacity_hours`, `reports_to`. No `user_id` field, no `skills` field. (NOTE: schema.sql:131 mentions user_id but it isn't on PersonProperties.)
**Suggested fix:** Update to actual PersonProperties; remove `user_id` and `skills`; add `role`, `reports_to`.

### [HIGH] data-model.md:104 — standup properties wrong
**Claim:** "`standup` | `author_id`, `posted_at`"
**Reality:** `StandupProperties` (`document.ts:207-212`): `author_id`, `date`, `submitted_at`. No `posted_at`.
**Suggested fix:** Replace `posted_at` with `submitted_at` and `date`.

### [HIGH] data-model.md:105 — sprint_review properties wrong
**Claim:** "`sprint_review` | `hypothesis_validated`, `key_learnings` (week review properties)"
**Reality:** `WeeklyReviewProperties` (`document.ts:215-220`): `sprint_id`, `owner_id`, `plan_validated`. No `hypothesis_validated`, no `key_learnings`.
**Suggested fix:** Replace with actual fields.

### [HIGH] data-model.md:109-115 — Issue states list incomplete
**Claim:** "Issues have a `state` property with 4 required states: backlog, todo, in_progress, done. Additional states: cancelled, custom states per workspace."
**Reality:** `IssueState` (`document.ts:47`): `'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'`. No "custom states per workspace" — enum is fixed. Missing `triage` and `in_review`.
**Suggested fix:** List all 7 states; remove claim of custom states.

### [HIGH] data-model.md:123-125 — Indexes that don't exist
**Claim:** "`CREATE INDEX idx_documents_program_id ON documents(program_id);  CREATE INDEX idx_documents_project_id ON documents(project_id);`"
**Reality:** Since the columns were dropped (migrations 027/029), these indexes don't exist either. Actual indexes in `schema.sql:354-377` use parent_id, document_type, properties, visibility, etc.
**Suggested fix:** Remove these example indexes.

### [HIGH] data-model.md:129-132 — Unique program prefix index doesn't exist
**Claim:** "`CREATE UNIQUE INDEX idx_documents_workspace_prefix ON documents(workspace_id, (properties->>'prefix')) WHERE document_type = 'program'`"
**Reality:** No such index exists in `schema.sql` and program no longer has `prefix` property.
**Suggested fix:** Remove this index from documentation.

### [MEDIUM] data-model.md:318 — `last_auth_provider` enum values
**Claim:** "`last_auth_provider TEXT, -- 'password', 'piv', 'oauth'`"
**Reality:** `schema.sql:25`: `last_auth_provider VARCHAR(50), -- 'fpki_validator', 'caia', null (legacy)`. Values are different.
**Suggested fix:** Update example values to actual ones.

### [HIGH] data-model.md:349-358 — workspace_invites schema wrong
**Claim:** "`token TEXT NOT NULL UNIQUE`"
**Reality:** `schema.sql:51`: `token TEXT UNIQUE, -- NULL for PIV invites (certificate proves identity)`. Field is nullable, not NOT NULL.
**Suggested fix:** Mark token as nullable; add `x509_subject_dn` field shown in schema.

### [HIGH] data-model.md:399 — audit_logs FK actor_user_id
**Claim:** "`actor_user_id UUID REFERENCES users(id) ON DELETE CASCADE`"
**Reality:** `schema.sql:64`: `actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL`. Cascade vs SET NULL is different.
**Suggested fix:** Change to ON DELETE SET NULL.

### [HIGH] data-model.md:424-428 — Migrations count and ranges
**Claim:** "Current migrations (27 files): 001-006: ... 017-022: ..."
**Reality:** `api/src/db/migrations/` has 37+ files (001 through 037, plus 007b, 014b, 015b, 018b, 020b, 024). Total ~43 files. Migration ranges in the doc are stale.
**Suggested fix:** Update count to current (43 files) and add ranges for 023-037.

### [HIGH] data-model.md:437 — Computed week dates
**Claim:** "Weeks are computed - Dates derived from `sprint_number` (historical field) + workspace start date"
**Reality:** No `computeWeekDates` function in shared package; computation is done inline in routes. Concept is roughly true but the implementation function doesn't exist.
**Suggested fix:** Reference where this is actually computed (likely in api routes).

---

## diagrams.md

### [HIGH] diagrams.md:108-114 — documents schema includes project_id, program_id
**Claim:** ER diagram includes `uuid project_id FK uuid program_id FK`
**Reality:** Dropped by migrations 027/029. No longer exists on documents.
**Suggested fix:** Remove `project_id` and `program_id` from documents in diagram; show `document_associations` as the relationship table.

### [HIGH] diagrams.md:121-123 — document_associations columns
**Claim:** "`uuid source_document_id FK  uuid target_document_id FK`"
**Reality:** Schema uses `document_id` and `related_id` (`schema.sql:211-212`).
**Suggested fix:** Update column names.

### [MEDIUM] diagrams.md:147-151 — Document Types diagram has Week → Standup
**Claim:** Week contains Standup
**Reality:** Standups have no required parent — `StandupProperties` only has `author_id`, `date`. They're standalone daily entries per user.
**Suggested fix:** Remove "Week → Standup" link; standups are not contained by weeks.

### [LOW] diagrams.md:286-307 — Issue state machine
**Claim:** Transitions like "Triage → Cancelled", "Backlog → Cancelled", "Todo → Cancelled".
**Reality:** Cannot verify all transitions without reading state machine; states themselves are accurate. LOW.
**Suggested fix:** Verify state machine logic in code.

---

## faq.md

### [HIGH] faq.md:19 — pnpm version requirement
**Claim:** "pnpm 9+"
**Reality:** `package.json:9`: `"pnpm": ">=9.0.0"` (consistent). LOW.
**Suggested fix:** None.

### [HIGH] faq.md:99 — Playwright debug commands reference test:e2e directly
**Claim:** "Run with debug: `DEBUG=1 pnpm test:e2e e2e/specific-test.spec.ts`"
**Reality:** This directly contradicts other guidance not to run `pnpm test:e2e`. Inconsistent guidance.
**Suggested fix:** Either remove this or note it's only for non-Claude debugging.

### [HIGH] faq.md:103-107 — Test data seeded counts
**Claim:** "1 workspace with 11 users, 5 programs, 3 projects each, 7 weeks per program, ~40 issues"
**Reality:** Not verified in seed.ts. Cannot confirm without reading. MEDIUM (possibly stale).
**Suggested fix:** Verify against `api/src/db/seed.ts`.

### [LOW] faq.md:185 — Migrations run on startup
**Claim:** "Migrations run automatically on application startup via `api/src/db/migrate.ts`"
**Reality:** Confirmed via `package.json` and CLAUDE.md docs (run on deploy). OK.
**Suggested fix:** None.

---

## glossary.md

### [HIGH] glossary.md:11 — document_type list uses wrong names
**Claim:** "`wiki`, `issue`, `program`, `project`, `sprint` (week), `person`, `standup`, `sprint_review` (week review), `sprint_retro` (week retro), `sprint_plan` (week plan)"
**Reality:** Actual enum uses `weekly_review`, `weekly_retro`, `weekly_plan` (not `sprint_*` variants). Per `schema.sql:100`.
**Suggested fix:** Replace `sprint_plan` → `weekly_plan`, `sprint_retro` → `weekly_retro`, `sprint_review` → `weekly_review`.

### [HIGH] glossary.md:184 — Weekly Plan db type
**Claim:** "Database document type is `'sprint_plan'` (historical name)"
**Reality:** Actual type name is `weekly_plan`.
**Suggested fix:** Update to `weekly_plan`.

### [HIGH] glossary.md:190 — Week Review db type
**Claim:** "Database document type is `'sprint_review'` (historical name)"
**Reality:** Actual type name is `weekly_review`.
**Suggested fix:** Update to `weekly_review`.

### [HIGH] glossary.md:193 — Weekly Retro db type
**Claim:** "Database document type is `'sprint_retro'` (historical name)"
**Reality:** Actual type name is `weekly_retro`.
**Suggested fix:** Update to `weekly_retro`.

### [HIGH] glossary.md:201 — Program has prefix
**Claim:** "Program: Has `prefix`, `color`, `emoji`."
**Reality:** `ProgramProperties` has no `prefix` field. Only color, emoji, RACI fields.
**Suggested fix:** Remove `prefix`.

### [HIGH] glossary.md:210 — Ticket Number format
**Claim:** "Unique identifier for issues: `{prefix}-{number}` (e.g., `SHIP-123`)"
**Reality:** `extractIssueFromRow` and route code uses `#{ticket_number}` format (e.g., `display_id: \`#${issue.ticket_number}\``) at `issues.ts:233`. No prefix is used.
**Suggested fix:** Update to actual `#{number}` format.

### [HIGH] glossary.md:88 — Error response shape
**Claim:** "Standard JSON format: `{ error: string }` or `{ success: false, error: { code, message, details? } }`"
**Reality:** Both shapes exist (matches gotchas.md note about inconsistency). OK.
**Suggested fix:** None.

### [HIGH] glossary.md:102 — SessionContext reference
**Claim:** "Examples: `WorkspaceContext`, `SessionContext`"
**Reality:** `web/src/contexts/SessionContext.tsx` does NOT exist. Actual contexts: ArchivedPersons, CurrentDocument, Documents, Issues, Programs, Projects, ReviewQueue, SelectionPersistence, Upload, Workspace.
**Suggested fix:** Replace `SessionContext` with a real context (e.g., `IssuesContext`).

---

## gotchas.md

### [HIGH] gotchas.md:15 — schema.sql:103 line ref
**Claim:** "`api/src/db/schema.sql:103` - `parent_id UUID REFERENCES documents(id) ON DELETE CASCADE`"
**Reality:** Actual location: `schema.sql:119`.
**Suggested fix:** Update to line 119.

### [HIGH] gotchas.md:18 — project ON DELETE SET NULL
**Claim:** "Risk: Deleting a project document does NOT cascade to issues (uses `ON DELETE SET NULL` at schema.sql:108)"
**Reality:** `project_id` column on documents no longer exists (dropped by migration 029). Project-to-issue relationships are via `document_associations` which uses `ON DELETE CASCADE` on both `document_id` and `related_id` (`schema.sql:211-212`). Deleting a project DOES cascade delete the association rows (but issues themselves persist).
**Suggested fix:** Remove the schema.sql:108 reference; explain associations cascade via document_associations.

### [HIGH] gotchas.md:30-31 — constants.ts line numbers
**Claim:** "`shared/src/constants.ts:28` - `SESSION_TIMEOUT_MS`", "`:31` - `ABSOLUTE_SESSION_TIMEOUT_MS`"
**Reality:** Actual lines: `26` and `29` (`constants.ts:26`, `constants.ts:29`).
**Suggested fix:** Update line numbers to 26 and 29.

### [HIGH] gotchas.md:32 — auth.ts line ref
**Claim:** "`api/src/middleware/auth.ts:154-169` - Both timeouts checked"
**Reality:** `authMiddleware` starts at line 65. Line range 154-169 may be off (file content not verified at that exact range).
**Suggested fix:** Re-verify line range.

### [HIGH] gotchas.md:43-46 — Dual system claim with current columns
**Claim:** "program_id UUID REFERENCES documents(id), project_id UUID REFERENCES documents(id)"
**Reality:** Both columns dropped (migrations 027 and 029). The "dual system" is no longer in effect.
**Suggested fix:** Remove the "dual system" claim; document_associations is now the only system.

### [HIGH] gotchas.md:56-58 — seed.ts line refs
**Claim:** "`api/src/db/seed.ts:532-564` - Seed data writes to BOTH systems"
**Reality:** Cannot verify without reading. Given that legacy columns are gone, seed should only write to associations.
**Suggested fix:** Verify and update.

### [HIGH] gotchas.md:67 — auth.ts response shape
**Claim:** "`api/src/routes/auth.ts:22-28`"
**Reality:** auth.ts line 18: `router.post('/login', ...)`. The response shape exists in this file but line numbers should be verified.
**Suggested fix:** Re-verify.

### [HIGH] gotchas.md:79 — standups.ts:45 reference
**Claim:** "`api/src/routes/standups.ts:45`" with `Workspace not found`
**Reality:** Cannot verify without read. Possibly stale.
**Suggested fix:** Verify line ref.

### [MEDIUM] gotchas.md:135 — Buffer.from yjs persist line
**Claim:** "`api/src/collaboration/index.ts:129-131`"
**Reality:** Line numbers in collaboration/index.ts are likely off since file is 834 lines and `pool.query('UPDATE documents SET yjs_state...` location may differ.
**Suggested fix:** Re-verify line ranges.

### [HIGH] gotchas.md:143 — schema.sql:99-100 yjs column
**Claim:** "`api/src/db/schema.sql:99-100` - Column definition"
**Reality:** Actual `yjs_state BYTEA,` is at `schema.sql:116`.
**Suggested fix:** Update line ref to 116.

### [HIGH] gotchas.md:171-174 — migration file list ends at 022
**Claim:** Migration list shown ends at `022_sprint_project_associations.sql`
**Reality:** Migrations exist through 037. List is severely outdated.
**Suggested fix:** Update list/range to current.

### [HIGH] gotchas.md:189 — issues.ts:105 BelongsToEntry interface
**Claim:** "`api/src/routes/issues.ts:105` - `interface BelongsToEntry`"
**Reality:** `BelongsToEntry` is IMPORTED from `@ship/shared` at `issues.ts:12`, not declared locally. It is defined in `shared/src/types/document.ts:10`.
**Suggested fix:** Remove this entry; BelongsToEntry is in shared types.

---

## onboarding.md

### [HIGH] onboarding.md:13 — pnpm version
**Claim:** "pnpm | 8+"
**Reality:** `package.json:9` requires `>=9.0.0`.
**Suggested fix:** Change to 9+.

### [HIGH] onboarding.md:91 — Zustand stores
**Claim:** "│ │ ├── stores/ # Zustand stores"
**Reality:** No `web/src/stores/` directory exists. No Zustand usage in `web/src`.
**Suggested fix:** Remove `stores/` from layout.

### [HIGH] onboarding.md:113-114 — program_id / project_id columns
**Claim:** "`program_id` - Which program a document belongs to ... `project_id` - Which project an issue belongs to"
**Reality:** Both columns dropped by migrations 027/029. Use `document_associations`.
**Suggested fix:** Remove these column references; use document_associations.

### [HIGH] onboarding.md:139-156 — requireAuth middleware
**Claim:** "`import { requireAuth } from '../middleware/auth';`"
**Reality:** `api/src/middleware/auth.ts` exports `authMiddleware`, not `requireAuth`.
**Suggested fix:** Replace with `authMiddleware`.

### [HIGH] onboarding.md:139 — pool path
**Claim:** "`import { pool } from '../db/pool';`"
**Reality:** Actual: `../db/client.js` (e.g., `issues.ts:2`).
**Suggested fix:** Replace `../db/pool` with `../db/client.js`.

### [HIGH] onboarding.md:158 — Register in api/src/index.ts
**Claim:** "Register in `api/src/index.ts`"
**Reality:** Routes are registered in `api/src/app.ts:179-237`, not index.ts. `api/src/index.ts` is the bootstrap entry.
**Suggested fix:** Reference `api/src/app.ts`.

### [HIGH] onboarding.md:316-317 — useDocuments hook
**Claim:** "React hooks: Follow patterns in `web/src/hooks/useDocuments.ts`"
**Reality:** Actual file: `web/src/hooks/useDocumentsQuery.ts`.
**Suggested fix:** Rename to `useDocumentsQuery.ts`.

### [HIGH] onboarding.md:335 — pool path again
**Claim:** "`import { pool } from '../db/pool';`"
**Reality:** Actual: `'../db/client.js'`.
**Suggested fix:** Replace.

### [HIGH] onboarding.md:357 — req.session usage
**Claim:** "`const { userId, workspaceId } = req.session;`"
**Reality:** `authMiddleware` attaches `req.userId`, `req.workspaceId` directly on req (see `code-examples.md:533`, `req.userId = ...`). No `req.session` object.
**Suggested fix:** Use `req.userId` and `req.workspaceId` directly.

### [HIGH] onboarding.md:365 — Zustand for UI state
**Claim:** "UI state: Zustand stores"
**Reality:** No zustand in the project (no `web/src/stores/`, no zustand imports).
**Suggested fix:** Remove Zustand claim.

### [HIGH] onboarding.md:413 — schema_migrations applied_at column
**Claim:** "`SELECT * FROM schema_migrations ORDER BY applied_at;`"
**Reality:** `schema_migrations` table has `version` and `applied_at` columns (`migrate.ts:46-48`). Query is valid.
**Suggested fix:** None — this is correct.

---

## patterns.md

### [HIGH] patterns.md:25 — issues.ts:160 line ref
**Claim:** "`api/src/routes/issues.ts:160`"
**Reality:** First `router.get('/'`... in issues.ts is at line 115 (per grep). Line 160 doesn't match the snippet shown.
**Suggested fix:** Update to actual line.

### [HIGH] patterns.md:39-45 — createIssueSchema content
**Claim:** Includes `belongs_to: z.array(belongsToEntrySchema).optional().default([])` at lines 17-23
**Reality:** Cannot verify the exact zod schema without reading. Real schema may differ.
**Suggested fix:** Re-verify against `issues.ts`.

### [HIGH] patterns.md:78 — weeks.ts:44 extractWeekFromRow
**Claim:** "`api/src/routes/weeks.ts:44 - extractWeekFromRow`"
**Reality:** Cannot verify without read. May be stale.
**Suggested fix:** Re-verify.

### [HIGH] patterns.md:165-175 — claude.ts query example uses sprint_id
**Claim:** "`api/src/routes/claude.ts:123-141`" with `s.properties->>'sprint_number'`, `s.properties->>'status'`, `da.relationship_type = 'sprint'`
**Reality:** These query patterns are plausible but line range can't be confirmed.
**Suggested fix:** Verify line range.

### [HIGH] patterns.md:215 — file references for vitest
**Claim:** "Configuration at `api/vitest.config.ts`"
**Reality:** Confirmed exists. OK.
**Suggested fix:** None.

### [HIGH] patterns.md:472-476 — postgres:15 vs postgres:16
**Claim:** `new PostgreSqlContainer('postgres:15')`
**Reality:** Compared to code-examples.md which says `postgres:16`. Inconsistent. Real version should be verified in `e2e/fixtures/isolated-env.ts`.
**Suggested fix:** Verify and unify.

### [MEDIUM] patterns.md:227-231 — Other contexts list
**Claim:** Lists IssuesContext, ProjectsContext, ProgramsContext.
**Reality:** All exist. Confirmed. OK.
**Suggested fix:** None.

---

## security.md

### [HIGH] security.md:18-21 — Constants line refs
**Claim:** "`shared/src/constants.ts:28-31`"
**Reality:** Actual lines: 26 and 29.
**Suggested fix:** Update to 26-29.

### [HIGH] security.md:24 — auth.ts:148-180 line range
**Claim:** "`api/src/middleware/auth.ts:148-180`"
**Reality:** authMiddleware is at line 65. Specific timeout check lines need verification.
**Suggested fix:** Verify line ranges.

### [HIGH] security.md:75 — auth.ts:25-63 token validation
**Claim:** "`api/src/middleware/auth.ts:25-63`"
**Reality:** authMiddleware starts at line 65, so token validation lines 25-63 are outside it. Sketchy.
**Suggested fix:** Verify.

### [HIGH] security.md:96 — authMiddleware lines 65-240
**Claim:** "`api/src/middleware/auth.ts:65-240`"
**Reality:** authMiddleware starts at line 65 (confirmed). Line 240 end unverified.
**Suggested fix:** Verify end line.

### [HIGH] security.md:101-110 — superAdminMiddleware, workspaceAdminMiddleware lines
**Claim:** "`auth.ts:243-260`", "`auth.ts:263-317`", "`auth.ts:320-372`"
**Reality:** Cannot verify without reading. Likely off given other line discrepancies.
**Suggested fix:** Verify each.

### [HIGH] security.md:135-138 — collaboration.ts:551-596 handleVisibilityChange
**Claim:** "`api/src/collaboration/index.ts:551-596`"
**Reality:** `handleVisibilityChange` is at line 530 (confirmed by grep).
**Suggested fix:** Update to ~530.

### [HIGH] security.md:209 — createDocumentSchema fields
**Claim:** "`document_type: z.enum(['wiki', 'issue', 'program', 'project', 'sprint', 'person'])`"
**Reality:** Actual schema must support all 10 types (weekly_plan, weekly_retro, standup, weekly_review). Either zod is incomplete or doc is.
**Suggested fix:** Verify in documents.ts; update doc accordingly.

### [HIGH] security.md:228-243 — Collaboration line refs
**Claim:** "`api/src/collaboration/index.ts:421-467`", "`collaboration/index.ts:470-493`", "`collaboration/index.ts:601-643`"
**Reality:** Actual: `validateWebSocketSession` at line 347, `canAccessDocumentForCollab` at line 396, `setupCollaboration` at line 606. Doc line refs are off.
**Suggested fix:** Update to 347, 396, 606.

### [HIGH] security.md:303-312 — Quick reference line refs
**Claim:** Multiple line refs for files including `shared/src/constants.ts:28`, `:31`, etc.
**Reality:** Actual: 26, 29.
**Suggested fix:** Update.

---

## testing.md

### [HIGH] testing.md:60 — isolated-env.ts:91-117 container setup
**Claim:** "`e2e/fixtures/isolated-env.ts:91-117`"
**Reality:** Cannot verify exact lines without read.
**Suggested fix:** Verify.

### [HIGH] testing.md:520-526 — getWorkerPort base port
**Claim:** "`BASE_PORT = 50000`, `PORTS_PER_WORKER = 100`"
**Reality:** Cannot verify; line ref in patterns.md says `e2e/fixtures/isolated-env.ts:37-44`.
**Suggested fix:** Verify constants.

### [HIGH] testing.md:23 — DB clean via beforeAll
**Claim:** "Tests share a single database connection via `api/src/db/client.js` but clean up via `beforeAll` in setup."
**Reality:** `api/src/test/setup.ts` exists; statement plausible.
**Suggested fix:** None.

### [MEDIUM] testing.md:295-296 — CI worker count
**Claim:** "4 workers (CI runners have good resources), 2 retries on failure"
**Reality:** Need to verify against `playwright.config.ts`. LOW.
**Suggested fix:** Verify.

---

## modules/collaboration.md

### [HIGH] modules/collaboration.md:19 — Wrong absolute path
**Claim:** "`/Users/jonesshaw/Documents/code/ship/api/src/collaboration/index.ts`"
**Reality:** Wrong user prefix. Use repo-relative.
**Suggested fix:** Use `api/src/collaboration/index.ts`.

### [HIGH] modules/collaboration.md:38 — Editor.tsx wrong absolute path
**Claim:** "`/Users/jonesshaw/Documents/code/ship/web/src/components/Editor.tsx`"
**Reality:** Same issue.
**Suggested fix:** Repo-relative path.

### [HIGH] modules/collaboration.md:72 — Room name docType list
**Claim:** "where docType is `doc`, `issue`, `program`, `project`, or `sprint` (historical name for weeks)"
**Reality:** roomPrefix is a free-form string set by caller. Some places use `doc` for wikis, others use `wiki:` (see modules/editor.md:89). Both exist.
**Suggested fix:** Note variance; include actual values.

### [HIGH] modules/collaboration.md:76-80 — Only 2 message types listed
**Claim:** "Two message types (defined as constants): messageSync = 0, messageAwareness = 1"
**Reality:** `collaboration/index.ts:14-17` defines 4 types: 0 sync, 1 awareness, 2 customEvent, 3 clearCache.
**Suggested fix:** Add 4 message types.

### [HIGH] modules/collaboration.md:262 — setupCollaboration single wss
**Claim:** "`const wss = new WebSocketServer({ noServer: true });`"
**Reality:** Server creates TWO WebSocketServers: `wss` (collab) and `eventsWss` (events) (`collaboration/index.ts:607-608`).
**Suggested fix:** Mention the events WS server.

### [HIGH] modules/collaboration.md:367 — /api/auth/refresh endpoint
**Claim:** "Frontend must call `/api/auth/refresh` periodically. The `useSessionTimeout` hook handles this."
**Reality:** No `/api/auth/refresh` endpoint exists. Actual endpoint is `/api/auth/extend-session` (`auth.ts:345`). `useSessionTimeout.ts:109` uses `'/api/auth/extend-session'`.
**Suggested fix:** Replace with `/api/auth/extend-session`.

---

## modules/editor.md

### [HIGH] modules/editor.md:29 — StarterKit configure
**Claim:** "StarterKit is configured with `history: false` (Yjs handles undo/redo) and `codeBlock: false`"
**Reality:** `Editor.tsx:543-547` also sets `dropcursor: false`. Statement is incomplete but factually correct for what it says.
**Suggested fix:** Mention `dropcursor: false` as well.

### [HIGH] modules/editor.md:42 — Placeholder/Dropcursor as part of StarterKit table
**Claim:** "Dropcursor | `@tiptap/extension-dropcursor` | Visual drop indicator"
**Reality:** Confirmed extension exists and is used (`Editor.tsx:10`).
**Suggested fix:** None.

### [HIGH] modules/editor.md:138-141 — Vision/Goals only on program
**Claim:** "Vision | program | Insert Vision heading"
**Reality:** `SlashCommands.tsx:535,562`: `documentTypes: ['program']` for both Vision and Goals. Confirmed.
**Suggested fix:** None.

### [HIGH] modules/editor.md:152-153 — Mention person navigation
**Claim:** "person | id, label, mentionType | `/team/{id}`"
**Reality:** Confirmed `/team/${id}` at `MentionNodeView.tsx:22` and `MentionExtension.ts:124`.
**Suggested fix:** None.

### [HIGH] modules/editor.md:153 — Mention document navigation
**Claim:** "document | id, label, mentionType, documentType | `/{documentType}/{id}`"
**Reality:** Cannot verify exact pattern without reading both files.
**Suggested fix:** Verify.

### [HIGH] modules/editor.md:209-227 — Editor props complete list
**Claim:** Props list includes `onCreateSubDocument`, `secondaryHeader`, `onDocumentConverted`.
**Reality:** Confirmed at `Editor.tsx:48-80`. OK.
**Suggested fix:** None.

### [LOW] modules/editor.md:251-252 — extractDocumentMentionIds and POST to /links
**Claim:** "Debounced POST to `/api/documents/{id}/links` with `target_ids`"
**Reality:** Confirmed at `Editor.tsx:716, 727`.
**Suggested fix:** None.

---

## Cross-cutting issues

### [HIGH] CROSS-CUTTING — Document type enum referenced as `sprint_plan`/`sprint_retro`/`sprint_review` throughout docs
**Claim:** Multiple files use these names.
**Reality:** Actual PG enum values are `weekly_plan`, `weekly_retro`, `weekly_review` (`schema.sql:100`; `shared/src/types/document.ts:34-44`).
**Suggested fix:** Globally replace `sprint_plan` → `weekly_plan`, `sprint_retro` → `weekly_retro`, `sprint_review` → `weekly_review` in all claude-reference files.

### [HIGH] CROSS-CUTTING — Foreign user prefix `/Users/jonesshaw/Documents/code/ship/`
**Claim:** Many files use this absolute path prefix.
**Reality:** Project root is `/Users/ryan/gauntlet/ship/` in this worktree; documentation should use repo-relative paths.
**Suggested fix:** Replace all absolute paths with repo-relative paths.

### [HIGH] CROSS-CUTTING — Migrations count and ranges stale
**Claim:** Multiple files reference 22-27 migration files.
**Reality:** Actual migrations: 001 through 037 plus suffixed (007b, 014b, 015b, 018b, 020b, 024) — ~43 files.
**Suggested fix:** Update counts and ranges everywhere.

### [HIGH] CROSS-CUTTING — Legacy associations columns (program_id, project_id, sprint_id) still referenced
**Claim:** Multiple files still describe these as live columns.
**Reality:** Dropped by migrations 027 and 029. The `program_id` and `project_id` columns no longer exist; `sprint_id` was dropped earlier. All associations now use `document_associations`.
**Suggested fix:** Globally remove these column references; explain associations via the junction table.

### [HIGH] CROSS-CUTTING — `hypothesis` field name (renamed to `plan` by migration 032)
**Claim:** API docs still reference `hypothesis`, `hypothesis_validated`, `/api/weeks/:id/hypothesis`.
**Reality:** Migration 032 renamed `hypothesis` → `plan`. Endpoint is `/api/weeks/:id/plan` (weeks.ts:1349). Project retro uses `plan_validated`.
**Suggested fix:** Globally rename `hypothesis` → `plan` and `hypothesis_validated` → `plan_validated`.
