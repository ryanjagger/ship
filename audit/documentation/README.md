# Documentation Audit Report

**Date:** 2026-05-19
**Branch:** `worktree-docs-audit`
**Scope:** all `*.md` files in the repo except `node_modules/`, `.git/`, and `/audit/`
**Method:** five parallel sub-agents verified every concrete claim (file paths, commands, schemas, routes, migrations, env vars) against the actual code. Detailed per-section findings are in `./audit-findings/01-05`.

---

## Headline numbers

| Severity | Count |
|---|---|
| HIGH (actively misleads or breaks a workflow) | 177 |
| MEDIUM (stale but unlikely to cause immediate harm) | 51 |
| LOW (cosmetic / minor) | 61 |
| **Total** | **289** |

Distribution by area:

| Section | File | HIGH | MED | LOW |
|---|---|---|---|---|
| `.claude/` | `audit-findings/01-claude-dir.md` | 9 | 8 | 12 |
| `docs/*.md` (top-level) | `audit-findings/02-docs-toplevel.md` | 26 | 9 | 15 |
| `docs/claude-reference/` | `audit-findings/03-claude-reference.md` | 122 | 10 | 12 |
| Root `*.md` (README, DEPLOYMENT, INFRASTRUCTURE, …) | `audit-findings/04-root.md` | 10 | 13 | 10 |
| Misc (research/, e2e/, terraform/, docs/solutions, ship-*, notes, …) | `audit-findings/05-misc.md` | 10 | 11 | 12 |

The bulk of the HIGH count (122) lives in `docs/claude-reference/` — the auto-reference docs are the most stale tier of the documentation by an order of magnitude.

---

## The five cross-cutting themes

Almost every HIGH finding stems from one of these five drifts. Fix these systemically and the count collapses.

### 1. `sprint → week` rename (migration 033) not propagated

Migration `033_sprint_to_week_rename.sql` renamed enum values `sprint_plan` → `weekly_plan` and `sprint_retro` → `weekly_retro`. The `document_type = 'sprint'` enum value was kept (referring to the week-document itself), but most user-facing terminology shifted to "week".

Docs still saying `sprint_plan` / `sprint_retro` / `sprint_review`: `docs/claude-reference/data-model.md`, `architecture.md`, `glossary.md`, `diagrams.md`, `ship-welcome-guide.md`, `PRESENTATION.md`, `ship-changelog-72h.md`, `test-failures.md`.

The internal API and query params **still use `sprint_id`** (e.g., `api/src/routes/issues.ts:117`, `claude.ts:23`). Docs that claim a `week_id` query-param or `/api/projects/:id/weeks` POST endpoint are wrong.

### 2. `hypothesis → plan` rename (migration 032) not propagated

Migration `032_rename_hypothesis_to_plan.sql` renamed the property and the endpoint. Real endpoint: `PATCH /api/weeks/:id/plan` (`api/src/routes/weeks.ts:1349`). Real property: `plan` (with `plan_validated`, `plan_history`, `plan_approval`).

Docs still using `hypothesis`/`hypothesis_validated`/`PATCH /:id/hypothesis`: `docs/claude-reference/api-reference.md` (many lines), `whats-new-accountability-system.md`, `developer-workflow-guide.md`, `entity-relationships-feature.md`.

### 3. Legacy association columns (`program_id`, `project_id`, `sprint_id`) dropped

Migration 027 dropped `project_id` + `sprint_id`; migration 029 dropped `program_id`. All org relationships now live in the `document_associations` junction table. `shared/src/types/document.ts:245` confirms with an in-code comment.

Docs still showing these as live columns on the `documents` table: `CLAUDE.md:88` (HIGH), `docs/unified-document-model.md` (5 places), `docs/claude-reference/architecture.md`, `data-model.md`, `diagrams.md`, `code-examples.md` (uses old `source_document_id`/`target_document_id` names — actual is `document_id`/`related_id`).

### 4. `document_type` enum and `IssueState`/`IssueSource` are stale

Current `document_type` enum (`api/src/db/schema.sql:100`, `shared/src/types/document.ts:34-44`) has **10 values**: `wiki`, `issue`, `program`, `project`, `sprint`, `person`, `weekly_plan`, `weekly_retro`, `standup`, `weekly_review`.

Other stale enums:
- `IssueState` is missing `'in_review'` in many docs (real: `triage | backlog | todo | in_progress | in_review | done | cancelled`).
- `IssueSource` is missing `'action_items'` (real: `internal | external | action_items`).
- `IssuePriority` doesn't include `'none'` in some examples (real: `low | medium | high | urgent`).

Docs affected: `CLAUDE.md:78`, `docs/document-model-conventions.md:60`, `docs/claude-reference/architecture.md`, `api-reference.md`, `data-model.md`, `glossary.md`, `developer-workflow-guide.md`.

### 5. Referenced skills / scripts / commands don't exist

- `CLAUDE.md` references four non-existent commands/skills: `/ship-openapi-endpoints`, `/e2e-test-runner`, `/workflows:deploy`, `/ship-security-compliance`. Only `ship-deploy`, `ship-philosophy-reviewer`, `ship-worktree-preflight` exist in `.claude/skills/`.
- `research/INDEX.md`, `research/configs/README.md` reference `./scripts/check-ports.sh` and `pnpm run worktree:status` — neither exists.
- `docs/application-architecture.md` references `"dev": "concurrently …"` — actual is `./scripts/dev.sh`.
- `docs/application-architecture.md` describes `web/src/stores/` and `web/src/db/` directories that don't exist.
- `docs/entity-relationships-feature.md` references `ActivityChart.tsx` and `IncompleteBanner.tsx` — neither exists.
- `docs/document-model-conventions.md` references a `CardGrid` component that doesn't exist.
- `docs/fpki-auth-client-dcr-analysis.md` documents a `/api/federation` mount, `services/fpki.ts`, `services/credential-store.ts`, and `vendor/@fpki/auth-client` — none of these exist.
- `docs/solutions/patterns/shared-collaborative-editor-component.md` references `web/src/pages/DocumentEditor.tsx` and `IssueEditor.tsx` — both removed; routing was unified into `UnifiedDocumentPage.tsx`.

---

## Top single-file problems

### `CLAUDE.md` (HIGH × 9)
The most important doc has the most damaging stale claims:
- Links to `docs/sprint-documentation-philosophy.md` — file is `docs/week-documentation-philosophy.md`.
- Lists only 6 document types; 4 are missing.
- Claims `program_id`/`project_id` "still exist"; both were dropped (migrations 027/029).
- References four non-existent skills/commands.
- Stale example DB name (`ship_auth_jan_6`).

### `docs/claude-reference/data-model.md` (HIGH × 17)
Almost every section has at least one factual error:
- Every document subtype's property list is wrong (`IssueProperties`, `ProgramProperties`, `ProjectProperties`, `WeekProperties`, `PersonProperties`, `StandupProperties`, `WeeklyReviewProperties`).
- `audit_logs.actor_user_id` cascade documented as `CASCADE` — actual is `SET NULL`.
- Documents-table example still has `program_id`/`project_id`.
- Claims 27 migrations; actual is ~43.
- Lists `idx_documents_program_id`/`project_id` indexes that no longer exist.

### `docs/claude-reference/api-reference.md` (HIGH × 15)
- Six endpoints documented under `/api/weeks/*` use wrong names (`/hypothesis` instead of `/plan`, `/my-action-items` doesn't exist, etc.).
- Project endpoint paths wrong (POST `/api/projects/:id/sprints` documented as `/weeks`).
- Wrong query param name (`week_id` should be `sprint_id`).
- Document type filter list missing 4 newer types.

### `docs/claude-reference/anti-patterns.md` (HIGH × 6)
- All absolute file paths use `/Users/jonesshaw/Documents/code/ship/...` — a different user's home dir.
- Documents `import { logger } from '../utils/logger'` — `utils/logger.ts` does not exist.
- Almost all `:line` references are off.

### `README.md` (HIGH × 5)
Top-of-funnel setup is broken:
- Tells reader to use Docker for PostgreSQL — project uses native PG (per `CLAUDE.md` and `docker-compose.yml:3-6`).
- Setup sequence runs `db:seed` before `db:migrate` (wrong order; `pnpm dev` already does both).
- `pnpm test` documented as "Run all E2E tests" — actually runs API unit tests; E2E is `pnpm test:e2e`.
- `pnpm test:ui` doesn't exist (only `test:e2e:ui`).
- `pnpm test e2e/documents.spec.ts` uses wrong tool (vitest not Playwright).

### `DEPLOYMENT.md` / `DEPLOYMENT_CHECKLIST.md` / `INFRASTRUCTURE_README.md` (HIGH × 4 combined)
- `PORT=8080` documented — actual is `PORT: "80"` (`api/.ebextensions/01-env.config:5`).
- EB-CLI workflow (`eb init/create/deploy/logs/ssh`) documented heavily, but `scripts/deploy-api.sh` uses raw `aws elasticbeanstalk` CLI — EB CLI is **not** required.
- Dev cost estimate ($80/mo) omits NAT Gateway (~$33/mo) which is enabled by default in `terraform/variables.tf:49-53`.

### `docs/fpki-auth-client-dcr-analysis.md` (HIGH × 3)
The "Ship Implementation Details" section describes routes, services, and vendored packages that don't exist in the repo. Either the implementation never landed or was removed.

### `research/` folder (HIGH × ~6)
This whole directory is a 2025-12-30 planning snapshot:
- Hardcoded `/Users/corcoss/` paths throughout.
- References `scripts/check-ports.sh` and `pnpm run worktree:status` — neither exists.
- Recommends Drizzle/Prisma and Turborepo as "next steps" — both explicitly rejected by the project (CLAUDE.md says "no ORM").
- References a `research/configs/` directory ("25 ready-to-use files") that doesn't exist in the repo.

---

## Files that should be archived rather than fixed

These are dated point-in-time snapshots, not maintained documentation. Fixing them line-by-line is wasted effort — better to move to `docs/historical/` (or delete) with a banner indicating the date frozen.

| File | What it is |
|---|---|
| `notes.md` | Personal onboarding-Q&A snapshot |
| `test-failures.md` | Frozen test-run output (literal `$(date)` placeholder was never substituted) |
| `PRESENTATION.md` | Demo notes from a feature branch (`feature/ship-clarity-claude-integration`) |
| `ship-changelog-72h.md` | 72-hour changelog (Jan 20-22 2026) |
| `ship-welcome-guide.md` | Mixes "sprint" and "week" vocabulary inconsistently |
| `research/` (entire folder) | 2025-12-30 planning material; partially adopted, partially superseded |
| `docs/research/tiptap-extensions-research.md` | Claims extensions are unadopted that are now installed (Image, Mention, Task List, Table, Code Block) |
| `docs/fpki-auth-client-dcr-analysis.md` | "Ship Implementation Details" section describes nonexistent routes/services |

---

## Recommended remediation order

1. **CLAUDE.md.** Fix the 9 HIGH issues. This doc is loaded into every Claude conversation, so stale claims here propagate furthest.
2. **README.md.** Fix the broken setup instructions and `pnpm test` semantics. First impressions for new contributors.
3. **Cross-cutting sweep #1: dropped columns.** Grep-and-replace in `docs/` and `docs/claude-reference/` for any reference to `program_id`/`project_id` as a column on `documents`. Replace with `document_associations` references.
4. **Cross-cutting sweep #2: `hypothesis → plan`.** Grep for `hypothesis` in docs; almost all property/endpoint mentions need to become `plan`.
5. **Cross-cutting sweep #3: `document_type` enum.** Update every doc that lists the enum to include all 10 values, and rename `sprint_plan/_retro/_review` → `weekly_plan/_retro/_review`.
6. **`docs/claude-reference/`.** This subtree is so stale it may be best to either regenerate it from current code or delete it. Given the volume of HIGH findings (122), per-line edits are probably not worth the effort.
7. **Deploy docs.** Reconcile EB-CLI vs raw `aws elasticbeanstalk` paths; pick one. Fix `PORT=8080` → `PORT=80`. Fix NAT-Gateway cost line.
8. **Archive the 8 dated snapshots** listed above.
9. **`docs/fpki-auth-client-dcr-analysis.md`.** Either remove the "Ship Implementation Details" section as aspirational, or implement it.

---

## Where to read the full findings

Each sub-report is in `./audit-findings/` with structured entries per issue (verbatim claim, code reality with file:line, suggested fix):

- `./audit-findings/01-claude-dir.md`
- `./audit-findings/02-docs-toplevel.md`
- `./audit-findings/03-claude-reference.md`
- `./audit-findings/04-root.md`
- `./audit-findings/05-misc.md`
