# Audit: `.claude/` documentation

Audit of factual claims in `.claude/CLAUDE.md`, `.claude/rules/reference-docs.md`, and the three `.claude/skills/*/SKILL.md` files against the actual repository.

Ground truth references used:
- `shared/src/types/document.ts`
- `api/src/db/schema.sql`
- `api/src/db/migrations/*.sql`
- `package.json`, `api/package.json`
- `scripts/*.sh`
- `api/src/middleware/auth.ts`, `api/src/app.ts`, `api/src/index.ts`
- `.claude/skills/` directory listing

---

## HIGH severity

### [HIGH] CLAUDE.md:12 — Referenced doc does not exist
**Claim:** "`docs/sprint-documentation-philosophy.md` - Sprint workflow and required documentation"
**Reality:** No such file exists. The actual file is `docs/week-documentation-philosophy.md` (confirmed by `ls docs/`).
**Suggested fix:** Rename to `docs/week-documentation-philosophy.md` (the project has been renamed from sprint→week, see migration `033_sprint_to_week_rename.sql`).

### [HIGH] CLAUDE.md:78 — `document_type` enum incomplete
**Claim:** "stored in a single `documents` table with a `document_type` field (wiki, issue, program, project, sprint, person)"
**Reality:** `shared/src/types/document.ts:34-44` and `api/src/db/schema.sql:100` define the enum as: `wiki, issue, program, project, sprint, person, weekly_plan, weekly_retro, standup, weekly_review` (10 values, not 6).
**Suggested fix:** Add `weekly_plan, weekly_retro, standup, weekly_review` to the list (or rephrase as "including ...").

### [HIGH] CLAUDE.md:88 — Stale claim about legacy columns
**Claim:** "Legacy columns `program_id` and `project_id` still exist; `sprint_id` was dropped by migration 027."
**Reality:** Migration `027_drop_legacy_association_columns.sql` dropped BOTH `sprint_id` AND `project_id`. Migration `029_drop_program_id_column.sql` then dropped `program_id`. `shared/src/types/document.ts:245` confirms: "program_id, project_id, and sprint_id removed ... dropped by migrations 027 and 029". No legacy association columns remain on `documents`.
**Suggested fix:** "Legacy columns `program_id`, `project_id`, and `sprint_id` have all been dropped (migrations 027 and 029); all relationships now live in `document_associations`."

### [HIGH] CLAUDE.md:96 — Referenced skill does not exist
**Claim:** "See `/ship-openapi-endpoints` skill for the full pattern"
**Reality:** No skill named `ship-openapi-endpoints` exists. `ls .claude/skills/` shows only `ship-deploy`, `ship-philosophy-reviewer`, `ship-worktree-preflight`. No matching commands directory either.
**Suggested fix:** Remove the reference or create the skill; in the interim point to `api/src/openapi/registry.ts` and `api/src/scripts/generate-openapi.ts`.

### [HIGH] CLAUDE.md:56 — Referenced skill does not exist
**Claim:** "ALWAYS use `/e2e-test-runner` when running E2E tests."
**Reality:** No skill named `e2e-test-runner` exists in `.claude/skills/` or `~/.claude/skills/`. Also referenced in `.claude/rules/reference-docs.md:17`.
**Suggested fix:** Remove the reference or create the skill. Document the actual mechanism (e.g., `pnpm test:e2e` plus `test-results/summary.json` polling).

### [HIGH] CLAUDE.md:122 — Referenced workflow does not exist
**Claim:** "Use `/workflows:deploy` for the full workflow"
**Reality:** No `workflows:deploy` command/skill exists in `.claude/`. Only `ship-deploy` skill is present. (The string appears only inside `scripts/deploy.sh` as a comment and inside `docs/ship-claude-cli-integration.md`.)
**Suggested fix:** Replace with `/ship-deploy` (the actual skill name).

### [HIGH] CLAUDE.md:147 — Referenced skill does not exist
**Claim:** "See `/ship-security-compliance` skill for pre-commit hooks (`comply opensource`)"
**Reality:** No skill named `ship-security-compliance` exists in `.claude/skills/`.
**Suggested fix:** Remove the reference or create the skill.

### [HIGH] CLAUDE.md:45 — Misleading example database name
**Claim:** "Creates database (e.g., `ship_auth_jan_6`) if it doesn't exist"
**Reality:** `scripts/dev.sh:18-20` derives the DB name from `basename "$ROOT_DIR"` — for this worktree the actual DB is `ship_docs_audit`. `ship_auth_jan_6` is a stale example from a long-gone worktree.
**Suggested fix:** Use a generic example: "Creates database (named `ship_<worktree-name>`, e.g., `ship_docs_audit`) if it doesn't exist".

### [HIGH] CLAUDE.md:88 — `document_associations` relationship types match but documentation about parent_id is silent
**Claim:** Lists `relationship types: parent, project, sprint, program`.
**Reality:** Verified correct against `api/src/db/schema.sql:203` (`CREATE TYPE relationship_type AS ENUM ('parent', 'project', 'sprint', 'program')`). However, `parent_id` column still exists on `documents` and is the canonical parent reference; the `parent` value in `document_associations` is secondary. Not strictly incorrect, but combined with the false claim that `program_id`/`project_id` "still exist" (above), the picture is wrong.
**Suggested fix:** Note that `parent_id` column remains and is the canonical parent pointer; `document_associations` carries the other relationships.

---

## MEDIUM severity

### [MEDIUM] CLAUDE.md:25 — Hardcoded port claim is misleading
**Claim:** "pnpm dev:api          # Express server on :3000"
**Reality:** `scripts/dev.sh:65-89` dynamically picks the first available port starting at 3000 (e.g., a second worktree gets 3001). `pnpm dev:api` alone uses 3000 by default but `pnpm dev` (the recommended command) does not guarantee 3000.
**Suggested fix:** Note "defaults to :3000 (auto-incremented for additional worktrees)".

### [MEDIUM] CLAUDE.md:26 — Same as above for web port
**Claim:** "pnpm dev:web          # Vite dev server on :5173"
**Reality:** Auto-increments same as API port. `web/vite.config.ts` reads `.ports` file written by `scripts/dev.sh`.
**Suggested fix:** Note "defaults to :5173 (auto-incremented for additional worktrees)".

### [MEDIUM] CLAUDE.md:125-126 — Deploy commands don't match script signatures
**Claim:**
```
./scripts/deploy.sh prod           # Backend → Elastic Beanstalk
./scripts/deploy-frontend.sh prod  # Frontend → S3/CloudFront
```
**Reality:** `scripts/deploy.sh` accepts `dev|shadow|prod` (line 44). `scripts/deploy-frontend.sh` accepts only `dev|prod` (line 9, no shadow). There is also a separate `scripts/deploy-web.sh` that accepts `dev|shadow|prod`. Commands as documented work but the doc obscures that shadow is supported on API but not on `deploy-frontend.sh`.
**Suggested fix:** Mention valid environments per script, or point to `deploy-web.sh` if shadow frontend deploys are needed.

### [MEDIUM] CLAUDE.md:130 — Prod API hostname format
**Claim:** "Prod API: `http://ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com/health`"
**Reality:** `scripts/deploy.sh:60` only confirms env name `ship-api-prod`; the EB CNAME (`eba-xsaqsg9h`) isn't anywhere in the repo to verify. May be correct but is unverifiable from code.
**Suggested fix:** Either confirm with `aws elasticbeanstalk describe-environments --environment-names ship-api-prod` and pin the URL, or replace with the dynamic command.

### [MEDIUM] CLAUDE.md:133 — Shadow deploy branch claim unverifiable
**Claim:** "**Shadow (UAT):** Deploy to shadow from `feat/unified-document-model-v2` before merging to master."
**Reality:** No enforcement of this branch in any script. `scripts/deploy.sh` accepts `shadow` regardless of branch.
**Suggested fix:** Either remove the branch constraint or make it a recommendation.

### [MEDIUM] ship-deploy/SKILL.md:13-25 — Skill omits `prod` argument
**Claim:** `./scripts/deploy.sh` (no env argument)
**Reality:** `scripts/deploy.sh:44-51` requires `<dev|shadow|prod>` and exits with usage if missing.
**Suggested fix:** Show `./scripts/deploy.sh prod` (matches CLAUDE.md).

### [MEDIUM] ship-deploy/SKILL.md:18-21 — Skill ignores the existing deploy-frontend.sh script
**Claim:** Hand-rolls `pnpm build:web`, `aws s3 sync`, and `aws cloudfront create-invalidation` via inline commands.
**Reality:** A dedicated `scripts/deploy-frontend.sh prod` (and `scripts/deploy-web.sh`) already does all of this, including pulling bucket/distribution IDs from SSM via `sync-terraform-config.sh`. The inline commands miss the SSM sync step and the cache-control header used by `deploy-frontend.sh:56`.
**Suggested fix:** Use `./scripts/deploy-frontend.sh prod` to match the deploy.sh pattern.

### [MEDIUM] ship-worktree-preflight/SKILL.md:44 — `vendor/@fpki` fix references nonexistent path
**Claim:** "vendor/@fpki missing | Create symlink: `mkdir -p vendor/@fpki && ln -sf /path/to/main/repo/vendor/@fpki/auth-client vendor/@fpki/auth-client`"
**Reality:** There is no `vendor/` directory anywhere in the repo (confirmed `find . -name vendor -maxdepth 3 -type d` returns nothing). Either the fix is stale, the dependency was removed, or it's a documentation aspiration.
**Suggested fix:** Verify whether `vendor/@fpki` is still required (it's referenced in `docs/fpki-auth-client-dcr-analysis.md`); if not, remove the row.

---

## LOW severity

### [LOW] rules/reference-docs.md:17 — References nonexistent `/e2e-test-runner` skill
**Claim:** "Dev commands: `pnpm dev`, `pnpm test`, `/e2e-test-runner`"
**Reality:** Same as CLAUDE.md:56 finding — skill does not exist.
**Suggested fix:** Remove or replace with actual command.

### [LOW] CLAUDE.md:40 — Test command framing
**Claim:** "pnpm test             # Runs api unit tests via vitest"
**Reality:** `package.json:27` confirms `"test": "pnpm --filter @ship/api test"` and `api/package.json` shows `"test": "vitest run"`. Correct — but only api tests run, not all packages; the comment is accurate but could be misread. Web/shared have no `test` scripts; flagging only for clarity.
**Suggested fix:** Optional: "Runs API unit tests via vitest (web/shared have no unit tests)".

### [LOW] CLAUDE.md:43 — `scripts/dev.sh` description is accurate but step 2 misleading
**Claim:** "Creates database (e.g., `ship_auth_jan_6`) if it doesn't exist"
**Reality:** Already flagged as HIGH for the example name. The "if it doesn't exist" portion is correct per `dev.sh:26-34`.

### [LOW] CLAUDE.md:92 — Session timeout phrasing
**Claim:** "Auth uses session cookies with 15-minute timeout."
**Reality:** `api/src/middleware/auth.ts:154,168` shows TWO timeouts: 15-minute inactivity AND 12-hour absolute (NIST SP 800-63B-4 AAL2). `rules/reference-docs.md:20` correctly describes both. CLAUDE.md only mentions the inactivity portion.
**Suggested fix:** "Auth uses session cookies with 15-minute inactivity timeout and 12-hour absolute timeout."

### [LOW] CLAUDE.md:60-69 — `expect(... 'Run: pnpm db:seed')` example
**Claim:** Example tells user to run `pnpm db:seed` when test fails for missing seed.
**Reality:** `pnpm db:seed` exists (`package.json:31`). Correct.

### [LOW] CLAUDE.md:131 — Prod Web URL
**Claim:** "Prod Web: `https://ship.awsdev.treasury.gov`"
**Reality:** `scripts/copy-db-to-shadow.sh:309` and `copy-db-via-ssm.sh:178` only mention `https://shadow.ship.awsdev.treasury.gov` (the shadow subdomain). The prod URL is not verifiable from code in repo but is plausible.
**Suggested fix:** Verify externally; leave as-is if confirmed.

### [LOW] ship-philosophy-reviewer/SKILL.md:13 — `On-demand` invocation
**Claim:** "On-demand: Invoke `/ship-philosophy-reviewer` to audit current changes."
**Reality:** Skill exists at `.claude/skills/ship-philosophy-reviewer/SKILL.md`. Correct.

### [LOW] ship-worktree-preflight/SKILL.md:18 — `brew services restart postgresql@16`
**Claim:** Implies PostgreSQL 16 via Homebrew.
**Reality:** Not directly verifiable from the repo (depends on user's local install). CLAUDE.md:18 only says "local PostgreSQL installed (not Docker)" without a version. Minor inconsistency but not actionable.

### [LOW] ship-worktree-preflight/SKILL.md:26-28 — `source api/.env.local` then parse `DATABASE_URL`
**Claim:** Sources `api/.env.local`; falls through silently if missing.
**Reality:** `scripts/dev.sh` creates `api/.env.local` on first run, but if the file doesn't exist when this checklist runs, `$DATABASE_URL` is empty and `DB_NAME` becomes empty — `createdb ""` will fail silently due to the `2>/dev/null`. Bug in the checklist, not the docs per se.
**Suggested fix:** Add a check that `.env.local` exists before sourcing, or run `./scripts/dev.sh` once first.

### [LOW] CLAUDE.md:106-108 — Migration file naming examples are real files
**Claim:** Lists `001_properties_jsonb.sql`, `002_person_membership_decoupling.sql`.
**Reality:** Confirmed real files in `api/src/db/migrations/`. Correct.

### [LOW] CLAUDE.md:80 — Collaboration server path
**Claim:** "`api/src/collaboration/index.ts`"
**Reality:** File exists (verified). Correct.

### [LOW] CLAUDE.md:7-12 — Other doc references
**Claim:** Lists `docs/unified-document-model.md`, `docs/application-architecture.md`, `docs/document-model-conventions.md`.
**Reality:** All three exist (verified `ls docs/`). Only `sprint-documentation-philosophy.md` is missing (flagged HIGH above).
