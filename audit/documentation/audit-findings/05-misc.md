# Documentation Audit — Miscellaneous Files

Findings for `research/`, `terraform/README.md`, `e2e/AGENTS.md`, `docs/research/`, `docs/solutions/`, and assorted historical files at repo root.

---

## Historical / Dated Snapshots

### [MEDIUM] notes.md — file is a dated onboarding-Q&A snapshot
**Claim:** Whole file ("Phase 1: First Contact" through "Phase 3: Synthesis") presented as questions/answers about the codebase, including ad-hoc test-run results ("28 files, 451 tests, about 12.4 seconds", "1 failed, 6 flaky, 47 did not run") and observations like "I did not find active `Pick<...>` or `Omit<...>` usage".
**Reality:** This is a personal onboarding exercise capturing a single point-in-time exploration. Test counts and specific failures will be stale within days. Some content is accurate (e.g. document_type enum members, migration narrative) but the file as a whole is not authoritative documentation.
**Suggested fix:** Move to a `docs/onboarding-notes/` or personal directory, or mark with a banner: "Personal onboarding notes — point-in-time, not maintained."

### [MEDIUM] test-failures.md — dated test-run snapshot with `$(date)` placeholder
**Claim:** "Generated: $(date)" and "Summary: 15 failing tests across 6 categories" with specific failing-test names like `offline-07-session-handling.spec` and `program-mode-sprint-ux.spec`.
**Reality:** The `$(date)` literal was never substituted, suggesting this was committed raw. Test files referenced no longer all exist (e.g. `program-mode-sprint-ux.spec` — the repo has `program-mode-week-ux.spec.ts` after the sprint→week rename in migration 033). Several "offline-NN" spec names also don't appear in the current e2e/ tree.
**Suggested fix:** Delete this file, or replace with a pointer to the canonical test-status source (CI dashboards / `test-results/summary.json`).

### [MEDIUM] PRESENTATION.md — feature demo from a feature branch
**Claim:** "Branch: `feature/ship-clarity-claude-integration`", "Commits: 15+", "174 unit tests passing", and API endpoints like `GET /api/sprints/:id/standups`, `POST /api/sprints/:id/review`, `GET /api/projects/:id/retro`.
**Reality:** These endpoints don't exist in current code. `api/src/routes/standups.ts` registers under `/api/standups` (api/src/app.ts:192), not `/api/sprints/:id/standups`. There is no `sprint-reviews.ts` or `project-retros.ts` route file (only test files referenced as `sprint-reviews.test.ts`, `project-retros.test.ts` exist, but no corresponding route module is registered). The sprint→week terminology rename (migration 033) is not reflected; document tabs are now `WeekOverviewTab/WeekPlanningTab/WeekReviewTab/WeekStandupsTab` (web/src/components/document-tabs/). The "174 unit tests" count is stale.
**Suggested fix:** Archive this file under `docs/historical/` with a banner noting it describes a past feature-branch state, or update to reflect the current `/api/standups` + week-based naming.

### [MEDIUM] ship-changelog-72h.md — dated 72-hour snapshot (Jan 20-22 2026)
**Claim:** Whole file documents specific work done over 72 hours including "Sprint Workflow Enhancement" with `BacklogPickerModal.tsx` (NEW - 359 lines), `SprintSidebar.tsx`, `SprintDetailView.tsx`, `ProgramSprintsTab.tsx`, etc.
**Reality:** Several referenced components no longer exist or have been renamed under the sprint→week refactor. The current `web/src/components/document-tabs/` directory uses `Week*Tab.tsx` filenames. Document types extended beyond what the file shows (current enum: `'wiki', 'issue', 'program', 'project', 'sprint', 'person', 'weekly_plan', 'weekly_retro', 'standup', 'weekly_review'` per api/src/db/schema.sql).
**Suggested fix:** Move under `docs/historical/changelogs/` with the date range clearly in the title. Don't treat as current architecture documentation.

### [LOW] ship-welcome-guide.md — uses "Sprint" terminology throughout
**Claim:** Hierarchy diagram showing "SPRINTS — Sprint 12 (done) → Sprint 13 (done) → Sprint 14 (now)", "Sprint Planning", "Sprint Tabs: Overview, Plan, Review, Standups", commands like `/ship:standup` to post to "current sprint".
**Reality:** Product terminology shifted to "week" after migration 033 (sprint→week rename, 2026-XX). Component names are `Week*Tab.tsx`. CLAUDE.md states: "Sprint Tabs: Overview, Plan, Review, Standups" still appears in places but week is the canonical product name now. Note: the "Concept" table in the guide already lists "Week" with description "7-day accountability window" — so the guide mixes old and new vocabulary inconsistently.
**Suggested fix:** Either pick "week" everywhere or "sprint" everywhere; the current mix confuses new users.

---

## research/ folder — older planning docs (pre-implementation)

The entire `research/` folder dates from `2025-12-30` (per its own dating). Its recommendations were partially adopted, partially superseded. Tag the whole folder as historical to avoid misleading readers.

### [HIGH] research/INDEX.md, SUMMARY.md, FILE-STRUCTURE.md — hardcoded `/Users/corcoss/` paths
**Claim:** Many file references like "[SUMMARY.md](/Users/corcoss/code/ship/research/SUMMARY.md)" and "All research materials are in `/Users/corcoss/code/ship/research/`".
**Reality:** These paths refer to a specific developer's machine. The repo lives under e.g. `/Users/ryan/gauntlet/ship/` for other developers. Links are broken for anyone but the original author.
**Suggested fix:** Replace with repo-relative paths (`./SUMMARY.md`, `research/configs/`) throughout INDEX.md, SUMMARY.md, FILE-STRUCTURE.md.

### [HIGH] research/INDEX.md, configs/README.md — `check-ports.sh` script does not exist
**Claim:** "Run `./scripts/check-ports.sh`" (INDEX.md:278, configs/README.md:125, etc.) and "`pnpm run worktree:status # Check ports and databases`" (INDEX.md:184).
**Reality:** `scripts/check-ports.sh` doesn't exist (`ls scripts/` shows no such file). Root `package.json` defines `worktree:init` but NOT `worktree:status` (verified in package.json).
**Suggested fix:** Either create the script or remove references to it from the research docs.

### [HIGH] research/INDEX.md:184, configs/README.md — `pnpm run worktree:status` does not exist
**Claim:** "pnpm run worktree:status   # Check ports and databases".
**Reality:** Root `package.json` defines only `worktree:init`. No `worktree:status` script.
**Suggested fix:** Remove the line, or add the script and a `check-ports.sh` to back it.

### [MEDIUM] research/INDEX.md:251, configs/README.md:478 — testing/linting listed as "next steps" but already exist
**Claim:** "Next Steps After Setup: 1. Add Testing — Vitest for unit tests, Playwright for E2E tests" and "Add ESLint configuration for code quality".
**Reality:** Both Vitest (`@vitest/ui` in root devDependencies) and Playwright (`@playwright/test`) are installed and in active use. The research doc reads as if testing is unimplemented.
**Suggested fix:** Add a banner: "This is a 2025-12-30 planning document. Most of these 'next steps' have been adopted — see `docs/application-architecture.md` for current state."

### [MEDIUM] research/configs/README.md:332 — recommends Drizzle/Prisma; project uses direct `pg`
**Claim:** "Add database migration tooling (Drizzle, Prisma)" as a next step; multiple example snippets using `drizzle-kit migrate`.
**Reality:** Per CLAUDE.md and the actual codebase: "PostgreSQL with direct SQL queries via `pg` (no ORM)". Numbered migration files in `api/src/db/migrations/`, run by `api/src/db/migrate.ts`. The decision NOT to use an ORM is explicit. The research doc recommending Drizzle/Prisma would mislead a reader who treats it as authoritative.
**Suggested fix:** Add a banner clarifying that the project chose direct `pg` + numbered SQL migrations.

### [MEDIUM] research/configs/README.md:332 — Turborepo listed as next step
**Claim:** "Set up Turborepo for build caching" and discussion of turbo.json in pnpm-monorepo-best-practices.md.
**Reality:** Project explicitly uses `pnpm --recursive` / `pnpm --filter` scripts (root package.json). Turborepo is NOT installed; no turbo.json. This was a deliberate "boring technology" choice per `docs/application-architecture.md`.
**Suggested fix:** Note that Turborepo was considered and not adopted.

### [LOW] research/configs/README.md — describes a `configs/` directory that doesn't appear in repo
**Claim:** "Production-ready pnpm monorepo configuration... Copy all config files to your ship/ directory: `cp -r configs/* /path/to/ship/`"
**Reality:** `research/configs/` directory does NOT exist in the repo (only README.md is in research/). The "25 ready-to-use configuration files" referenced throughout INDEX.md/SUMMARY.md/FILE-STRUCTURE.md were never committed (or were committed and later removed). All "copy these configs" instructions are vestigial.
**Suggested fix:** Either commit the configs dir or rewrite the README to reflect that the setup it describes has been applied to the repo itself.

### [LOW] research/SUMMARY.md, INDEX.md — "Quick Start (3 Minutes)" instructions are now wrong
**Claim:** "`./scripts/worktree-init.sh && pnpm install && pnpm run build:shared && pnpm run dev`"
**Reality:** Current `pnpm dev` (root package.json) runs `./scripts/dev.sh`, which already creates `.env.local`, runs migrations, seeds DB, and finds available ports. `worktree-init.sh` exists but is not the primary onboarding entry. Per CLAUDE.md, the canonical command is just `pnpm dev`.
**Suggested fix:** Replace "Quick Start" with a pointer to README.md / CLAUDE.md.

### [LOW] research/INDEX.md:140-156, FILE-STRUCTURE.md — architecture diagram shows incomplete tree
**Claim:** Shows just `shared/ + api/ + web/ + scripts/` with `worktree-init.sh` and `check-ports.sh`.
**Reality:** Repo has many more top-level directories: `terraform/`, `e2e/`, `docs/`, `plans/`, multiple Dockerfiles, etc. The research doc's "Architecture Overview" is misleading for a reader trying to understand the current repo.
**Suggested fix:** Either update the diagram or move the doc to a `historical/` location.

---

## docs/research/tiptap-extensions-research.md — stale 2025-12-31 research

### [HIGH] docs/research/tiptap-extensions-research.md:5,506 — claims Image extension NOT installed
**Claim:** Line 5: "Current Version: Ship uses TipTap ^2.10.4 (with Link at ^2.27.1)" and line 506: "Image Extension... Currently Installed in Ship: ❌ No"
**Reality:** While `@tiptap/extension-image` is indeed not in package.json, Ship now has its OWN image implementation: `web/src/components/editor/ResizableImage.tsx` (custom Node-based ResizableImage) and `ImageUpload.tsx` extension. Both are used in Editor.tsx (lines 9, 31, 562, 587). The research doc's "Recommendations: Immediate Additions: 2. Image Extension" is already done.
**Suggested fix:** Update the "Currently Installed" status, and remove image extension from the "Immediate Additions" recommendations list.

### [HIGH] docs/research/tiptap-extensions-research.md:1435 — claims Mention extension is "Immediate Addition"
**Claim:** "Immediate Additions (High Value, Low Complexity): 1. Mention Extension"
**Reality:** `@tiptap/extension-mention` ^2.27.1 is installed (web/package.json:35). Custom implementation at `web/src/components/editor/MentionExtension.ts`, `MentionList.tsx`, `MentionNodeView.tsx`. Editor.tsx:30 imports `createMentionExtension`. Already done.
**Suggested fix:** Mark mentions as adopted.

### [HIGH] docs/research/tiptap-extensions-research.md:1442,1452 — Task List and Table recommended; both already installed
**Claim:** "Task List Extension... Minimal setup required" listed as immediate addition; "Table Extension... Consider when users request it" listed as medium priority.
**Reality:** `@tiptap/extension-task-item`, `@tiptap/extension-task-list`, `@tiptap/extension-table`, `@tiptap/extension-table-cell`, `@tiptap/extension-table-header`, `@tiptap/extension-table-row` all installed (web/package.json:37-42). Code block lowlight is also installed (line 30).
**Suggested fix:** Update recommendations — these were adopted.

### [HIGH] docs/research/tiptap-extensions-research.md:805,887,1518-1521 — hardcoded `/Users/corcoss/` paths
**Claim:** "Ship's collaboration server at `/Users/corcoss/code/ship/.worktrees/docs-mode/api/src/collaboration/index.ts`" and several more.
**Reality:** Personal machine paths. Broken for any other reader. Correct location is `api/src/collaboration/index.ts` (relative to repo root).
**Suggested fix:** Replace with repo-relative paths throughout.

### [MEDIUM] docs/research/tiptap-extensions-research.md:7 — claims TipTap version pinning
**Claim:** "Current Version: Ship uses TipTap ^2.10.4 (with Link at ^2.27.1)"
**Reality:** Mixed versions — partly correct, but many packages are now at ^2.27.1 (core, dropcursor, link, mention, extension-task-item, extension-task-list, suggestion). Not just Link.
**Suggested fix:** Update the version note, or remove the parenthetical entirely.

---

## docs/solutions/

### [HIGH] docs/solutions/patterns/shared-collaborative-editor-component.md:122-123 — file references don't exist
**Claim:** "Related Files: web/src/pages/DocumentEditor.tsx — Document usage; web/src/pages/IssueEditor.tsx — Issue usage with sidebar"
**Reality:** Neither `DocumentEditor.tsx` nor `IssueEditor.tsx` exists in `web/src/pages/` (only `Documents.tsx`, `Issues.tsx`, `UnifiedDocumentPage.tsx`, `PersonEditor.tsx`, `FeedbackEditor.tsx`, etc.). Routing was unified — all editor pages flow through `UnifiedDocumentPage.tsx` per the "Unified Document Routing" change documented in ship-changelog-72h.md.
**Suggested fix:** Update Related Files to `web/src/pages/UnifiedDocumentPage.tsx` + `web/src/components/Editor.tsx`. The pattern is still valid; only the consumer files changed.

### [MEDIUM] docs/solutions/patterns/shared-collaborative-editor-component.md:108-109 — line-count statistics likely stale
**Claim:** "Before: IssueEditor.tsx was ~360 lines... After: IssueEditor.tsx is ~196 lines"
**Reality:** IssueEditor.tsx no longer exists, so the before/after comparison can't be verified against current code. Was likely accurate at the time of writing (date listed: 2024-12-30).
**Suggested fix:** Either remove the stale numbers or anchor them to a git SHA.

### [LOW] docs/solutions/integration-issues/claude-context-api-for-ai-skills.md:158 — line-count claim
**Claim:** "api/src/routes/claude.ts - New endpoint (707 lines)"
**Reality:** Current file is 691 lines (`wc -l api/src/routes/claude.ts`).
**Suggested fix:** Either remove the precise line count or update to ~691.

### [LOW] docs/solutions/integration-issues/claude-context-api-for-ai-skills.md:46-47 — query param naming inconsistency note
**Claim:** "uses sprint_id param for historical compatibility" — described as a transition.
**Reality:** Verified accurate — api/src/routes/claude.ts:23,62,79,83,87,91 etc. still uses `sprint_id` as the query param name. Doc correctly describes the historical-naming choice. No change needed, but flag: the `week_id` rename has NOT happened, so calling this "historical compatibility" understates the situation — it's the current canonical name.
**Suggested fix:** Note "the query param is still named sprint_id; the rename has not been done".

### [LOW] docs/solutions/performance-issues/vite-dev-memory-explosion-parallel-tests.md — references obsolete fixture path
**Claim:** Code samples show fixture modifications and don't specify exact file, but the pattern was implemented.
**Reality:** Verified: `e2e/fixtures/isolated-env.ts` lines 204-231 implements `vite preview`, `e2e/global-setup.ts` builds web (line 45). Doc accurately describes the adopted solution.
**Suggested fix:** No change needed, but consider adding the specific file path (`e2e/fixtures/isolated-env.ts`) to the "Related" section so readers can find the implementation.

### [LOW] docs/solutions/websocket-cloudfront-configuration.md:67 — line-number reference
**Claim:** "`/events` | Real-time updates (accountability) | `api/src/collaboration/index.ts:690`"
**Reality:** Line numbers will drift with edits. Better to reference the function name (e.g., `handleEventsUpgrade` or similar).
**Suggested fix:** Replace `:690` with the function/handler name.

---

## terraform/README.md

### [HIGH] terraform/README.md:138-149 — "Infrastructure Components" table omits files actually in repo
**Claim:** Table lists `versions.tf`, `variables.tf`, `vpc.tf`, `security-groups.tf`, `database.tf`, `ssm.tf`, `elastic-beanstalk.tf`, `s3-cloudfront.tf`, `outputs.tf`.
**Reality:** Actual `terraform/*.tf` files include additional `cloudfront-logging.tf`, `waf.tf`, and `cloudfront-functions/` directory not listed. Also missing: `terraform.tfvars.example`. The table is incomplete.
**Suggested fix:** Add `cloudfront-logging.tf`, `waf.tf`, `cloudfront-functions/`.

### [HIGH] terraform/README.md:6-21 — "Directory Structure" tree omits `environments/shadow/`
**Claim:** Tree shows only `environments/dev/` and `environments/prod/`.
**Reality:** `terraform/environments/` contains `dev`, `prod`, AND `shadow` (verified `ls terraform/environments/`). Shadow environment is referenced elsewhere in CLAUDE.md as the UAT environment.
**Suggested fix:** Add `environments/shadow/` to the tree and document its purpose alongside dev/prod.

### [MEDIUM] terraform/README.md:18-19 — modules list missing nothing critical but reordered
**Claim:** Module list: `vpc/`, `aurora/`, `elastic-beanstalk/`, `cloudfront-s3/`, `security-groups/`, `ssm/`.
**Reality:** Verified — these 6 modules exist (`ls terraform/modules/`). Accurate.
**Suggested fix:** None.

### [MEDIUM] terraform/README.md:495 — references "ship-aurora" / "ship-aurora-restored" example
**Claim:** Specific cluster identifier `ship-aurora` used in recovery example.
**Reality:** Actual cluster name is set by Terraform from variables; the literal `ship-aurora` may or may not match. Example is illustrative but could mislead readers into typing wrong names.
**Suggested fix:** Use `<your-aurora-cluster-id>` placeholder.

### [LOW] terraform/README.md:495 — DATABASE_URL example uses hardcoded db name `ship_main`
**Claim:** Example URL: `postgresql://user:pass@new-endpoint:5432/ship_main`
**Reality:** Database name in production may differ; this is just an example. Low risk.
**Suggested fix:** Note "your db name" in the example.

---

## e2e/AGENTS.md

### [LOW] e2e/AGENTS.md:11,13 — helper imports verified correct
**Claim:** "Import helpers from `e2e/fixtures/test-helpers.ts`" — `triggerMentionPopup`, `hoverWithRetry`, `waitForTableData`.
**Reality:** All three functions exist in `e2e/fixtures/test-helpers.ts` (lines 29, 67, 95). Accurate.
**Suggested fix:** None.

### [LOW] e2e/AGENTS.md:148-162 — UTC/timezone "sprint number" reference
**Claim:** "UTC/timezone mismatches in seed data... causing sprint number mismatches"
**Reality:** Post sprint→week rename (migration 033), the concept is "week number" not "sprint number". The advice itself is still correct but the terminology is stale.
**Suggested fix:** Change "sprint number" to "week number".

### [LOW] e2e/AGENTS.md:131-146 — fullyParallel example uses "sprint"
**Claim:** Example test names: "accepts a triage issue (Moves triage → backlog)" — generic terminology fine. No issue.
**Reality:** Accurate.
**Suggested fix:** None.

---

## Cross-cutting Note

The most common factual issue across these docs is **terminology drift around the sprint→week rename** (migration 033). Many docs still describe sprint-prefixed routes, components, and types that were renamed. A single sweep replacing:
- `IssueEditor.tsx` / `DocumentEditor.tsx` → `UnifiedDocumentPage.tsx`
- `SprintXxxTab.tsx` → `WeekXxxTab.tsx`
- `/api/sprints/:id/...` route claims → `/api/standups`, `/api/documents/:id/...`
- "sprint number" → "week number" (where appropriate; some internal field names still use sprint_id)

…would resolve most of the medium-severity issues at once.

Files most affected and most worth updating (because they're prominent / actively read):
- terraform/README.md — should be authoritative for infra
- docs/solutions/patterns/shared-collaborative-editor-component.md — patterns doc, broken file refs
- docs/research/tiptap-extensions-research.md — claims extensions unadopted that are now installed
- e2e/AGENTS.md — minor terminology nits only; otherwise solid

Files best archived (don't fix line-by-line):
- notes.md, test-failures.md, PRESENTATION.md, ship-changelog-72h.md, ship-welcome-guide.md
- research/ (entire folder)
