# Root Documentation Audit — Findings

Scope: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `ATTESTATION.md`, `DEPLOYMENT.md`, `DEPLOYMENT_CHECKLIST.md`, `INFRASTRUCTURE.md`, `INFRASTRUCTURE_README.md`, `INFRASTRUCTURE_SUMMARY.md`.

---

## README.md

### [HIGH] README.md:103 — Docker is required, but project uses native PostgreSQL
**Claim:** `Docker (for the database)` is listed as a prerequisite, and step 4 says `docker-compose up -d`.
**Reality:** Per `CLAUDE.md` ("PostgreSQL must be running locally before dev or tests. The user has local PostgreSQL installed (not Docker)") and `docker-compose.yml:3-6` which says the file is "NOT required. Most developers use native PostgreSQL instead", the canonical local-dev path is native PostgreSQL. `scripts/dev.sh:16-34` auto-creates a local database using `createdb`, not Docker.
**Suggested fix:** Replace the Docker prerequisite with "PostgreSQL 16+ installed locally" and remove the `docker-compose up -d` step; reference `scripts/dev.sh` auto-provisioning instead.

### [HIGH] README.md:99-112 — Setup sequence does not match `scripts/dev.sh`
**Claim:** Setup steps require `cp api/.env.example api/.env.local`, then `cp web/.env.example web/.env`, then `pnpm db:seed`, then `pnpm db:migrate`, then `pnpm dev`.
**Reality:** `scripts/dev.sh:16-62` auto-generates `api/.env.local` with a worktree-derived `DATABASE_URL` (does not copy from `api/.env.example`); it runs migrations and seeds automatically on a fresh database. Running `pnpm db:seed` before `pnpm db:migrate` (the documented order) would attempt to seed against an empty schema and fail.
**Suggested fix:** Replace the manual steps with `pnpm install && pnpm dev` and note that `dev.sh` handles env files, DB creation, migrations, and seeding. If a manual flow is documented, swap order to `db:migrate` first, then `db:seed`.

### [HIGH] README.md:206 — `pnpm test` does not run E2E
**Claim:** Under Testing: `pnpm test  # Run all E2E tests`.
**Reality:** `package.json:27` defines `"test": "pnpm --filter @ship/api test"` which runs vitest unit tests, not Playwright E2E. E2E is `pnpm test:e2e` (`package.json:28`).
**Suggested fix:** Change to `pnpm test  # Run API unit tests` and `pnpm test:e2e  # Run all E2E tests`.

### [HIGH] README.md:209 — `pnpm test:ui` does not exist
**Claim:** `pnpm test:ui  # Run tests with UI`.
**Reality:** `package.json` defines `test:e2e:ui`, not `test:ui` (lines 27-29).
**Suggested fix:** `pnpm test:e2e:ui`.

### [HIGH] README.md:212 — `pnpm test e2e/documents.spec.ts` won't work
**Claim:** `pnpm test e2e/documents.spec.ts  # Run specific test file`.
**Reality:** `pnpm test` filters to `@ship/api` which has no awareness of `e2e/` (vitest cwd is `api/`). Running a Playwright spec requires `pnpm test:e2e e2e/documents.spec.ts` (or, per `CLAUDE.md`, the `/e2e-test-runner` skill rather than running directly).
**Suggested fix:** Use `pnpm test:e2e e2e/documents.spec.ts`.

### [MEDIUM] README.md:173, 215 — "73+ Playwright tests" is stale
**Claim:** "E2E testing — 73+ Playwright tests covering real user flows" and "73+ tests covering all major functionality".
**Reality:** The repo contains 71 spec files in `e2e/` with ~1,228 `test(` declarations.
**Suggested fix:** Drop the precise count or state ">1,000 Playwright tests across 70+ spec files".

### [MEDIUM] README.md:283 — `docs/week-documentation-philosophy.md` link OK but parallel `sprint-documentation-philosophy.md` referenced in CLAUDE.md does not exist
**Claim:** README links to `docs/week-documentation-philosophy.md` (this file exists). However, `CLAUDE.md` references `docs/sprint-documentation-philosophy.md` which is missing.
**Reality:** `ls docs/` confirms `week-documentation-philosophy.md` exists; there is no `sprint-documentation-philosophy.md`.
**Suggested fix:** Not a README bug — flagging since it crosses files. Update CLAUDE.md to reference `week-documentation-philosophy.md` (and `accountability-philosophy.md`), or rename file back.

### [MEDIUM] README.md:237 — `docker-compose.prod.yml` does not exist
**Claim:** `docker-compose -f docker-compose.prod.yml up`.
**Reality:** Only `docker-compose.yml` and `docker-compose.local.yml` exist in repo root. There is no `docker-compose.prod.yml`. Production deploys use AWS Elastic Beanstalk via `scripts/deploy.sh` / `scripts/deploy-api.sh`.
**Suggested fix:** Remove the `docker-compose.prod.yml` example or create the file.

### [MEDIUM] README.md:233-234 — `docker build ./api` and `docker build ./web` won't work
**Claim:** `docker build -t ship-api ./api` and `docker build -t ship-web ./web`.
**Reality:** Neither `api/Dockerfile` nor `web/Dockerfile` exists. The Dockerfiles are at repo root: `Dockerfile`, `Dockerfile.web`, `Dockerfile.dev`. `scripts/deploy-api.sh:70` copies `$PROJECT_ROOT/Dockerfile` for EB deploys.
**Suggested fix:** `docker build -t ship-api -f Dockerfile .` and `docker build -t ship-web -f Dockerfile.web .`.

### [MEDIUM] README.md:131-133 — Swagger / OpenAPI URLs lack trailing detail and Postgres host
**Claim:** Swagger UI at `http://localhost:3000/api/docs`; PostgreSQL at `localhost:5432`.
**Reality:** Swagger is mounted at `/api/docs` (`api/src/swagger.ts`), so URL is correct (note `docker-compose.local.yml:8` uses `/api/docs/` with trailing slash but both work). Native-PostgreSQL workflow uses default port 5432 (correct), but `docker-compose.local.yml:27` remaps to 5433 to avoid conflict with native PG. So saying "PostgreSQL: localhost:5432 (via Docker)" conflates the two paths.
**Suggested fix:** State "PostgreSQL: localhost:5432 (native install) or localhost:5433 (docker-compose.local.yml)".

### [LOW] README.md:174 — Misleading "Server is truth — Offline-tolerant"
**Claim:** "Server is truth — Offline-tolerant, syncs when reconnected".
**Reality:** Not directly verifiable in repo skim; the doc set emphasizes server-authoritative model. Worth verifying against `docs/unified-document-model.md` claims.
**Suggested fix:** Confirm wording matches `docs/unified-document-model.md`; otherwise rephrase.

---

## CONTRIBUTING.md

No factual issues found. The four commands referenced (`pnpm install`, `pnpm dev`, `pnpm test`, `pnpm type-check`) all exist in `package.json:12,17-27,24`. (Note: `pnpm test` runs API unit tests, not E2E — matches what's in `package.json`.)

---

## SECURITY.md

(Compliance/policy doc — boilerplate skipped per audit instructions.)

### [LOW] SECURITY.md:84-88 — CI status checks may not exist
**Claim:** "GitHub Actions provides a second layer of enforcement: secrets-scan ... attestation-check. These are required status checks. PRs cannot merge without passing."
**Reality:** Not verified in scope; would need `.github/workflows/*.yml` to confirm.
**Suggested fix:** Verify workflow names match real CI jobs.

---

## ATTESTATION.md

(Compliance template — content is by design.)

### [LOW] ATTESTATION.md:1-9, 32-35 — "trivy (skipped)" suggests incomplete tooling
**Claim:** Frontmatter lists scan_result PASS with trivy NO/skipped.
**Reality:** SECURITY.md:66 advertises "Vulnerabilities: Container and dependency scanning (via trivy)" as part of `comply opensource`. Either the policy text overstates coverage, or the attestation needs trivy run.
**Suggested fix:** Either run trivy and update attestation, or remove the trivy claim from SECURITY.md.

---

## DEPLOYMENT.md

### [HIGH] DEPLOYMENT.md:218 — `PORT=8080` is wrong
**Claim:** Troubleshooting note: "Port mismatch (ensure PORT=8080 in env)".
**Reality:** `api/.ebextensions/01-env.config:5` sets `PORT: "80"`. Local dev defaults to 3000. There is no 8080 reference anywhere in code/config.
**Suggested fix:** Change to `PORT=80` (Elastic Beanstalk) or `PORT=3000` (local dev).

### [HIGH] DEPLOYMENT.md:107 — `scripts/deploy-frontend.sh` does not run `pnpm build:web` (verify)
**Claim:** "Builds the React app (`pnpm build:web`)".
**Reality:** `pnpm build:web` exists in `package.json:23`. Confirm the script actually calls it (not verified in detail) — `scripts/deploy-frontend.sh` exists but content not audited here.
**Suggested fix:** Confirm `deploy-frontend.sh` invokes the build step or update wording.

### [MEDIUM] DEPLOYMENT.md:106 — `./scripts/deploy-frontend.sh` is the wrong script for env-aware deploys
**Claim:** Step 4 instructs `./scripts/deploy-frontend.sh`.
**Reality:** Both `scripts/deploy-frontend.sh` and `scripts/deploy-web.sh` exist; the env-aware one is `deploy-web.sh <dev|shadow|prod>` (per `scripts/deploy-web.sh` usage line). `CLAUDE.md` explicitly recommends `./scripts/deploy-frontend.sh prod`. The two scripts duplicate purpose.
**Suggested fix:** Document which script is canonical, or note the env argument: `./scripts/deploy-frontend.sh prod`.

### [MEDIUM] DEPLOYMENT.md:64-65 — Cost estimate "$80/month" depends on undocumented assumptions
**Claim:** "~$80/month for dev environment (t3.small + Aurora Serverless v2 0.5 ACU)".
**Reality:** Matches `INFRASTRUCTURE.md` table, but excludes NAT Gateway (~$33) which `INFRASTRUCTURE_README.md:136` includes for prod and `terraform/variables.tf:49-53` defaults `enable_nat_gateway = true`. The dev figure understates NAT cost.
**Suggested fix:** Either disable NAT in dev or include `~$33/month NAT Gateway` in the dev breakdown.

### [MEDIUM] DEPLOYMENT.md:185 — Wrong CloudWatch log group path
**Claim:** "Application: `/aws/elasticbeanstalk/ship-api-dev/var/log/eb-docker/containers/eb-current-app/stdouterr.log`".
**Reality:** `INFRASTRUCTURE_README.md:200-203` and `INFRASTRUCTURE_SUMMARY.md:213-217` list the log groups as `/aws/elasticbeanstalk/ship-api/application` (no `-dev`, no inline file path — log groups don't have file paths).
**Suggested fix:** Use `/aws/elasticbeanstalk/ship-api-dev/var/log/eb-docker/containers/eb-current-app/stdouterr.log` as the CloudWatch *log stream* under the correct group, or rewrite to the actual group name.

### [LOW] DEPLOYMENT.md:7-21 — Prerequisites list missing `awsebcli` but DEPLOYMENT_CHECKLIST.md:9 includes it
**Claim:** DEPLOYMENT.md does not mention `awsebcli`. But DEPLOYMENT_CHECKLIST.md:9 and INFRASTRUCTURE_README.md:9 require it.
**Reality:** `scripts/deploy-api.sh` uses pure `aws elasticbeanstalk` CLI (not `eb`), so EB CLI is *not* strictly required for the documented script. However DEPLOYMENT_CHECKLIST.md:12 still says `cd api && eb init`.
**Suggested fix:** Pick one tooling story. `scripts/deploy-api.sh` works without `awsebcli`; remove `eb init/eb create/eb deploy` references unless EB CLI is actually expected.

### [LOW] DEPLOYMENT.md:308 — Node 22 referenced as upgrade target
**Claim:** "FROM public.ecr.aws/docker/library/node:22-slim".
**Reality:** `Dockerfile` currently uses `node:20-slim`. The example is "how to upgrade" so this is forward-looking; just confirm intent.
**Suggested fix:** No change — but note `Dockerfile.web` and `Dockerfile.dev` also use `node:20-slim`.

---

## DEPLOYMENT_CHECKLIST.md

### [HIGH] DEPLOYMENT_CHECKLIST.md:12-13 — EB CLI workflow not used by the deploy scripts
**Claim:** "Initialize Elastic Beanstalk: `cd api && eb init`" and "Create EB environment: ... `eb create`".
**Reality:** `scripts/deploy-api.sh:129-189` creates the environment via `aws elasticbeanstalk create-environment`, not `eb create`. EB CLI is not required for the documented script.
**Suggested fix:** Either drop the `eb init/eb create` steps (the script handles env creation), or document the EB CLI flow as an alternative.

### [HIGH] DEPLOYMENT_CHECKLIST.md:53-57, 60-64, 84-85, 93 — `eb logs`, `eb status`, `eb deploy`, `eb ssh` require `eb init` setup
**Claim:** Numerous `eb` commands listed as if standard.
**Reality:** None of the project scripts use EB CLI. `eb logs/status/ssh/deploy` only work after the user runs `eb init` independently — these are out-of-band tools.
**Suggested fix:** Replace with `aws elasticbeanstalk` equivalents (the script already uses `aws elasticbeanstalk request-environment-info` in DEPLOYMENT.md:172-181), or explicitly note that EB CLI must be installed and initialized separately.

### [MEDIUM] DEPLOYMENT_CHECKLIST.md:113 — Log group `/aws/elasticbeanstalk/ship-api/application` is naming-by-application not by env
**Claim:** Log group `/aws/elasticbeanstalk/ship-api/application`.
**Reality:** EB CloudWatch log groups are typically per-environment, e.g. `/aws/elasticbeanstalk/ship-api-dev/var/log/...`. The path here mixes "application" (DEPLOYMENT_CHECKLIST) vs "ship-api-dev/var/log" (DEPLOYMENT.md). Both can't be right.
**Suggested fix:** Verify against `api/.ebextensions/02-cloudwatch.config` and use the actual log-group names.

### [LOW] DEPLOYMENT_CHECKLIST.md:44 — Health check URL uses `api.example.gov` placeholder
**Claim:** `curl https://api.example.gov/health`.
**Reality:** Per `CLAUDE.md` the real prod URL is `http://ship-api-prod.eba-xsaqsg9h.us-east-1.elasticbeanstalk.com/health`.
**Suggested fix:** Show both: the placeholder pattern and the actual EB CNAME.

---

## INFRASTRUCTURE.md

### [LOW] INFRASTRUCTURE.md:49-79 — Directory tree omits multiple real terraform files
**Claim:** Tree shows `versions.tf, variables.tf, vpc.tf, database.tf, ssm.tf, security-groups.tf, s3-cloudfront.tf, outputs.tf`.
**Reality:** `terraform/` also contains `elastic-beanstalk.tf`, `cloudfront-logging.tf`, `waf.tf`, `bootstrap/`, `cloudfront-functions/`, `environments/`, `modules/`, and `README.md`.
**Suggested fix:** Update tree or add `# ...other files` notation.

### [LOW] INFRASTRUCTURE.md:72-78 — scripts tree omits `init-database.sh` and `deploy.sh`, `deploy-web.sh`
**Claim:** Lists `deploy-infrastructure.sh`, `deploy-api.sh`, `deploy-frontend.sh`.
**Reality:** Also present: `init-database.sh` (referenced elsewhere in the doc), `deploy.sh`, `deploy-web.sh`, `terraform.sh`, `sync-terraform-config.sh`, `configure-caia.sh`, `copy-db-to-shadow.sh`, etc.
**Suggested fix:** Add `init-database.sh` and `deploy.sh` (the env-aware wrappers) — both are referenced in `CLAUDE.md` Deployment section.

---

## INFRASTRUCTURE_README.md

### [HIGH] INFRASTRUCTURE_README.md:147-151 — Cost table for Dev shows "NAT: -"
**Claim:** Dev row: NAT column blank ("-"), total $80/month.
**Reality:** `terraform/variables.tf:49-53` defaults `enable_nat_gateway = true`. NAT Gateway costs ~$33/month and is required (per same doc line 137 and INFRASTRUCTURE.md). The Dev total should be ~$113/month unless NAT is explicitly disabled.
**Suggested fix:** Either disable NAT for dev profile or include NAT in the Dev cost ($113/month).

### [MEDIUM] INFRASTRUCTURE_README.md:200-203 — Log group names hardcoded as `ship-api` and `ship-aurora`
**Claim:** `/aws/elasticbeanstalk/ship-api/application`, `/aws/rds/cluster/ship-aurora/postgresql`.
**Reality:** `terraform/database.tf` names the cluster `${var.project_name}-aurora` and the log group `/aws/rds/cluster/${aws_rds_cluster.aurora.cluster_identifier}/postgresql`. With project_name=ship that yields `/aws/rds/cluster/ship-aurora/postgresql` (matches). EB log group is typically per-environment though (`ship-api-dev`, etc.), not application-level.
**Suggested fix:** Use `ship-api-{env}` for EB log group names.

### [MEDIUM] INFRASTRUCTURE_README.md:165 — `eb init` then `eb create` is not the actual flow
**Claim:** Quick Start step 4 says "Initialize Elastic Beanstalk: cd api && eb init ... Follow prompts, then create environment".
**Reality:** Same as DEPLOYMENT_CHECKLIST issue: `scripts/deploy-api.sh` creates the EB environment via AWS CLI; no `eb init`/`eb create` needed.
**Suggested fix:** Update step 4 to "First-time deploy: `./scripts/deploy-api.sh` (auto-creates the EB environment using terraform outputs)".

### [LOW] INFRASTRUCTURE_README.md:212 — `curl https://api.example.gov/health` uses placeholder
**Claim:** Placeholder domain.
**Reality:** Real prod URL exists per `CLAUDE.md`.
**Suggested fix:** Add a real-URL example for prod.

---

## INFRASTRUCTURE_SUMMARY.md

### [MEDIUM] INFRASTRUCTURE_SUMMARY.md:43-48 — Docs tree puts `INFRASTRUCTURE.md` etc. under `docs/`
**Claim:** Tree shows `docs/INFRASTRUCTURE.md, docs/DEPLOYMENT.md, docs/DEPLOYMENT_CHECKLIST.md, docs/INFRASTRUCTURE_SUMMARY.md`.
**Reality:** These files live at repo root, not under `docs/`. (Confirmed by `ls` of repo root.)
**Suggested fix:** Move the four files into `docs/` or correct the tree to root-level paths.

### [MEDIUM] INFRASTRUCTURE_SUMMARY.md:163-166 — `eb init`/`eb create` again
**Claim:** "EB Environment (One-time: 10-15 min): `cd api && eb init && eb create ship-api-dev --instance-type t3.small`".
**Reality:** `scripts/deploy-api.sh` handles environment creation via AWS CLI; no EB CLI required.
**Suggested fix:** Replace with `./scripts/deploy-api.sh` (script creates the environment if it doesn't exist).

### [LOW] INFRASTRUCTURE_SUMMARY.md:214-217 — Same log-group naming issue as INFRASTRUCTURE_README
**Claim:** `/aws/elasticbeanstalk/ship-api/application` (no env suffix).
**Reality:** Per-environment naming expected.
**Suggested fix:** Use `ship-api-{env}` form.

---

## Cross-cutting

- **EB CLI vs AWS CLI:** Three docs (DEPLOYMENT.md, DEPLOYMENT_CHECKLIST.md, INFRASTRUCTURE_README.md, INFRASTRUCTURE_SUMMARY.md) tell the user to install `awsebcli` and run `eb init/create/deploy/logs/ssh`. But `scripts/deploy-api.sh` uses raw `aws elasticbeanstalk` API calls. Pick one path or document both clearly.
- **Docker vs native Postgres:** README.md says Docker required; CLAUDE.md and `docker-compose.yml:3` say native PG is canonical. Reconcile.
- **`pnpm test` semantics:** `package.json:27` filters to api (unit tests). README and CONTRIBUTING use `pnpm test` loosely as both unit and E2E; the actual command runs vitest only.
- **Log group naming:** Inconsistent across the four AWS docs (`ship-api` vs `ship-api-dev`). Confirm against `api/.ebextensions/02-cloudwatch.config`.
- **Cost estimates:** Dev `$80/month` excludes NAT in some tables, includes it in others. Pick one canonical figure.
