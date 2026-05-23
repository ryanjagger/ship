# Test Coverage and Quality Audit - Peer Review

Date: 2026-05-19

Reviewer of `README.md` (same date). This document does not restate the original — it adds findings, corrections, and grounded recommendations.

## What the original audit got right

- Inventory and run counts (28 API files / 451 tests, 16 web files / 151 tests, 71 E2E spec files / 869 tests) match what I observed.
- The `pnpm test` gate gap is real: `package.json` line 33 (`"test": "pnpm --filter @ship/api test"`) excludes web and E2E.
- The `@vitest/coverage-v8` provider is missing — `api/package.json` has the script but no dependency.
- The flake list (My Week retro, allocation grid plan linkage, bulk delete undo, mention sync) is correct; I confirmed all four are real by reading the specs.
- `e2e/AGENTS.md` does forbid the very patterns the suite uses everywhere.
- The Bedrock "ResourceNotFoundException" silent-pass fallback is a genuine risk in `api/src/services/ai-analysis.ts`.

## What the original audit missed or downplayed

### 1. The empty-test pre-commit hook has a critical gap

`scripts/check-empty-tests.sh` only flags tests that contain **neither** `expect(` **nor** `page.` (lines 31-50). It is satisfied if a test merely *references* `page.`, even when it never asserts anything. I confirmed by adding a synthetic spec; tests using `await loginAsAdmin(page); await navigateToProject(page);` with no `expect()` pass the hook.

Two existing tests already exploit this gap:

- `e2e/accessibility-remediation.spec.ts:1398` — `test('code blocks have language indication', ...)` runs `getAttribute` in a loop but has no `expect()`. It always passes.
- `e2e/file-attachments.spec.ts:161` — `test('should validate file type', ...)` uploads a `.exe`, comments "This test just verifies that validation happens", and has no `expect()`. A security regression where executables get accepted would be invisible.

The hook also does not handle nested `test.describe` correctly when a test body contains a callback that uses `page.` inside an inner helper — those silently pass.

### 2. "Tests-that-test-the-test" in collaboration

`api/src/collaboration/__tests__/collaboration.test.ts:434-470` defines a local `RATE_LIMIT` object (lines 436-441) — a copy of the constants from `api/src/collaboration/index.ts:19-27` — and then "tests" that copy:

```ts
expect(RATE_LIMIT.MAX_CONNECTIONS_PER_IP).toBe(30)   // line 444
expect(RATE_LIMIT.MAX_MESSAGES_PER_SECOND).toBe(50)  // line 449
```

These are tautologies (`expect(30).toBe(30)`). The real `isConnectionRateLimited` / `isMessageRateLimited` / `recordConnectionAttempt` / `recordMessage` functions in `collaboration/index.ts` are never exported and never called from any test. Same pattern at `collaboration.test.ts:716` (`expect(true).toBe(true)` in an "error handling" test).

Add to the list: `web/src/components/icons/uswds/Icon.test.tsx:80-94` has three "tests" whose entire body is `expect(true).toBe(true)` with a comment "This is a compile-time check". `web/src/hooks/useSessionTimeout.test.ts:774` does the same.

### 3. "Heavy-mock" route tests give false coverage signal

The audit reports 40% line coverage on API but doesn't flag which kind of coverage. Five route tests stub out the DB, auth, AND visibility middleware so completely that they cannot catch the bugs they appear to cover:

| File | Mocks |
|---|---|
| `api/src/routes/projects.test.ts:4-23` | `pool`, `authMiddleware`, `VISIBILITY_FILTER_SQL → '1=1'` |
| `api/src/routes/iterations.test.ts:4-23` | same pattern |
| `api/src/routes/issues-history.test.ts` | same pattern |
| `api/src/routes/api-tokens.test.ts:4-13` | mocks DB and audit; tests only the pure `hashToken` util — **the actual token CRUD/bearer-auth routes are not exercised at all** despite the file's name |
| `api/src/__tests__/auth.test.ts:4-8` | mocks pool entirely |

`VISIBILITY_FILTER_SQL` always returning `'1=1'` means any SQL bug that omits the visibility join in production code passes these tests. Documents/issues/standups tests by contrast use `createApp()` and a real DB (correct pattern).

### 4. Whole route modules have zero direct test files

The audit notes "weekly-plans.ts at 5.09%" but does not enumerate that **16 of 28 route modules have no `*.test.ts` sibling**:

```
accountability  activity  admin  admin-credentials  ai  associations
caia-auth  claude  comments  dashboard  feedback  invites  programs
setup  team  weekly-plans
```

Combined size: **~9,963 lines of routing code, no direct route tests**. The largest are `team.ts` (2195), `admin.ts` (1802), `weekly-plans.ts` (1165), `programs.ts` (892), `dashboard.ts` (731), `claude.ts` (691), `admin-credentials.ts` (703). These get incidental E2E coverage at best, and `weekly-plans.ts` underpins the four most-flaky E2E paths.

`associations.ts` (407 lines, exposes `/:id/associations`, `/:id/reverse-associations`, `/:id/context`) is the foundation of the unified document model and has no direct tests. `associations-regression.test.ts` tests the issues route's *use* of associations, not the associations route itself.

### 5. Migrations are completely untested

`api/src/db/migrate.ts` runs 42 migrations in order against production. There is **no test** that:

- Replays migrations against an empty DB and checks the final schema matches `schema.sql`.
- Detects a missing `INSERT INTO schema_migrations` (a silent re-run risk).
- Tests data-mutating migrations like `028_backfill_program_associations.sql`, `034_backfill_past_weekly_docs_submitted.sql`, `031_cleanup_accountability_issues.sql`, or `019_migrate_ice_333_to_null.sql` against representative seed data.
- Verifies the `025_prevent_circular_parent.sql` trigger actually fires (only one test in `circular-reference.test.ts` even uses the trigger indirectly).

`migrate.ts:106` swallows any `"already exists"` error from `schema.sql`. If a migration partially applies, the next deploy will silently treat it as new — no test catches this.

### 6. CI does not exist; coverage gating is not "missing" it is impossible

`find . -path ./node_modules -prune -o -name "*.yml" -path "*workflows*" -print` returns nothing. There is no `.github/workflows/`, no `circleci`, no `buildkite`. The audit recommendation to "track flaky retries as failures" assumes a CI gate that does not exist. `playwright.config.ts:60` sets `retries: process.env.CI ? 2 : 1` — meaning every flake is silently retried even in local runs. There is no published artifact, no coverage threshold, no test-results aggregation pipeline.

This is a much bigger finding than the audit conveyed. Coverage and gating are not "needs tuning" — they are absent.

### 7. Web unit tests are not just "stale or brittle" — they reference renamed concepts

13 failing web tests include `web/src/lib/document-tabs.test.ts` failures on terms `sprint`/`sprints` — but migration `033_sprint_to_week_rename.sql` renamed the entity. The tests test code that no longer exists in the expected shape. Similarly `web/src/components/editor/DetailsExtension.test.ts:16` asserts `content === 'block+'` but the implementation returns `'detailsSummary detailsContent'`. These were not flakes — they were code-product drift that nobody enforces because the suite is not gated.

### 8. Vitest setup creates a within-file race window

`api/src/test/setup.ts:14-19` does one `TRUNCATE TABLE ... CASCADE` in `beforeAll`. `api/vitest.config.ts:11` sets `fileParallelism: false`, but vitest's default `test.concurrent` and the fact that **tests within a file can run in parallel** means files like `weeks.test.ts` (52 tests) and `documents.test.ts` (41 tests) rely on per-test data uniqueness (random `testRunId`s) to avoid races. The standup 404→201 flake the original audit mentioned is almost certainly this: `standups.test.ts:133` does `DELETE FROM documents WHERE document_type = 'standup'` in `beforeEach` while the `testSprintId` document might be re-truncated by another concurrent test. The audit attributes this to "order-sensitive setup state" but the real cause is no per-test transaction isolation.

### 9. Conditional-assertion mention tests are systemic, not isolated

`grep -E "if \(await.*isVisible" e2e/*.spec.ts | wc -l` → **81 occurrences**. The audit calls out a few; the issue is the pattern. Examples beyond what the audit listed:

- `e2e/mentions.spec.ts:166` — "should create person mention" gates the entire assertion on `await personOption.isVisible()`.
- `e2e/mentions.spec.ts:295` — "should navigate to document on click" wraps the navigation assertion behind `if (await documentOption.isVisible())`.
- `e2e/mentions.spec.ts:328, 358, 386` — three more deleted/renamed/sync tests with the same shape.
- `e2e/security.spec.ts:330` — `if (imgs > 0)` gate on the executable-rejection test means the test passes whether the file was correctly rejected OR silently accepted with no image rendered.

Each of these is one production regression away from being a green test for a broken feature.

### 10. WebSocket reconnect test does not verify reconnect

`e2e/error-handling.spec.ts:127-152` ("handles websocket reconnection") toggles `setOffline(true/false)` and then types more text. It never:

- Reloads the page to verify the Yjs state survived.
- Opens a second tab to confirm broadcasts after reconnect.
- Asserts the WebSocket re-handshaked (the test would pass even if the editor stayed in local-only mode forever).

This is the only e2e coverage of a reconnect path and it is a smoke test.

### 11. No contract tests against the OpenAPI surface

The CLAUDE.md and `api/src/openapi/` directory show all routes are registered with `@asteasolutions/zod-to-openapi`. There is no test that:

- Loads the generated OpenAPI doc and verifies every registered path has a route handler.
- Verifies response payloads conform to the declared schemas (no zod parse against responses).
- Exercises the MCP server tools that are auto-generated from OpenAPI.

A change that breaks the schema-vs-implementation contract ships green.

### 12. AI / Bedrock / OAuth / Audit services are completely untested

`api/src/services/` has 7 production modules and **1 test file**:

| File | LoC | Tests |
|---|---|---|
| `ai-analysis.ts` | 378 | none |
| `caia.ts` | 388 | none |
| `secrets-manager.ts` | 217 | none |
| `oauth-state.ts` | 102 | none |
| `invite-acceptance.ts` | 117 | none |
| `audit.ts` | 41 | none (and `logAuditEvent` is mocked away in `api-tokens.test.ts:11-13`, so no test ever asserts that a security-relevant event is actually emitted) |
| `accountability.ts` | — | tested |

For an app with AU-9 compliance triggers on `audit_logs`, **zero** tests assert that a particular workflow (failed login, role grant, super-admin action, token revoke) writes a log row.

### 13. The test pyramid is upside-down

Counts: ~551 API unit tests + ~163 web unit tests = 714 unit. **866 E2E tests** (more than unit total). Combined with per-worker isolated Postgres + API + Vite preview, this is the root cause of the 27-37 minute wall-clock E2E times the audit measured. Many of the E2E tests exist because the underlying route/service modules have no unit tests (see #4 and #12). Moving feedback consolidation, audit emission, AI fallback, weekly-plans CRUD, and association mutations down to integration tests against a single shared Postgres would cut E2E runtime and surface regressions faster.

### 14. Reusable helpers are documented but unused

`e2e/fixtures/test-helpers.ts` provides `triggerMentionPopup`, `hoverWithRetry`, `waitForTableData`. `grep -l "triggerMentionPopup\|hoverWithRetry\|waitForTableData" e2e/*.spec.ts` returns only **2 files** (`backlinks.spec.ts`, `bulk-selection.spec.ts`). 69 other spec files reinvent wait/retry logic with `waitForTimeout`. Removing the 619 `waitForTimeout` calls in favor of these helpers is the single largest flake-reduction lever available, and it requires no architectural change.

### 15. Dead/unused code in the fixture itself

`e2e/fixtures/isolated-env.ts:69-75` defines `getSafeWorkerCount()` that is never called (the config in `playwright.config.ts:24-51` has its own equivalent). The duplication invites drift between the documented memory math (300MB worker) and what the runner actually allocates. Worth deleting or consolidating.

## What the original audit overstated or mis-prioritized

- **"AI/review tests hit live Bedrock paths"** — Only `e2e/ai-analysis-api.spec.ts` does. The unit test surface is empty (item #12), so a faked provider per the audit's Recommendation 3 would not just stabilize CI, it would be the first AI tests, period.
- **"Shared has no tests or coverage"** — true but tiny. `shared/src/` is types-and-constants only. Pushing tests there is the lowest-impact recommendation in the audit and shouldn't lead the list.
- **The audit lists 7 numbered "Gaps and Reliability Risks"** but does not call out the absence of CI (#6 above) which dominates all of them — without a gate, nothing the audit recommends will be enforced.
- **"Existing coverage tooling … is intended"** — The script exists but the dependency does not. This is not "tooling not fully configured", this is a script that has never worked.

## Concrete additional recommendations (ordered by impact)

1. **Stand up a CI workflow with three jobs.** API unit + web unit + E2E (with 0 retries). Until this exists nothing else is enforced. Block PRs on green.

2. **Tighten the empty-test hook** so it requires `expect(` (no `page.` fallback) and add a second rule rejecting `expect(true).toBe(true)` and `expect(1).toBe(1)`. Remove or fix the two real-world silent-pass tests at `e2e/accessibility-remediation.spec.ts:1398` and `e2e/file-attachments.spec.ts:161`.

3. **Add route-level integration tests for the 16 untested route modules**, starting with `weekly-plans.ts`, `associations.ts`, `admin.ts`, `team.ts`, `dashboard.ts`. Use the `documents.test.ts` real-DB pattern, not the `projects.test.ts` mock-everything pattern. Convert `projects.test.ts` and `iterations.test.ts` to the real-DB pattern in the same pass.

4. **Replace the tautological rate-limiter tests** in `collaboration.test.ts:434-470` with real exercises. Export `isConnectionRateLimited` and `recordConnectionAttempt` (or wrap them in a class) and assert that 31 connections from one IP cause a 429.

5. **Add a contract test** that loads `/api/openapi.json`, walks every registered path, and verifies (a) the route exists in Express, (b) a sample 200 response parses against the declared zod schema, (c) at least one 4xx error response parses. This catches the schema-vs-impl drift that the team-wide OpenAPI policy assumes is impossible.

6. **Add a migration replay test.** Spin up an empty Postgres (testcontainers already in use), run `migrate.ts`, dump the schema, diff against `schema.sql + sum-of-migrations`. Catch dropped DDL and partial migrations.

7. **Fix the upside-down pyramid.** For each chronically-flaky E2E (the audit's four recurring failures), write the equivalent route-level integration test and mark the E2E `test.fixme` until it can pass deterministically. Specifically: weekly allocation plan linkage and My Week retro freshness are integration concerns, not browser concerns.

8. **Audit-log assertion suite.** Add tests that assert `logAuditEvent` is called for: failed login, super-admin impersonation, role change, token revocation, document deletion. Currently `audit.ts` is mocked everywhere it appears in tests.

9. **A real WebSocket reconnect test** with two pages. Page A edits → page B sees edit. Disconnect B's WebSocket. Page A edits while B is offline. Reconnect B. Assert B catches up. The current `error-handling.spec.ts:127` test does not exercise the actual sync.

10. **Migrate the 81 `if (await x.isVisible())` blocks** to assertions (`await expect(x).toBeVisible()`). Where the option might genuinely not exist, the test should fail with an actionable message — same pattern the CLAUDE.md mandates for seed-data assertions.

11. **Remove `debug-create.spec.ts` from the default suite** (the original audit recommended this; restating because it is a one-line fix in `playwright.config.ts` via `testIgnore`). Same for any other "debug-" prefixed specs.

12. **Per-test transactions for API tests within a file.** Wrap each test in a `BEGIN; ... ROLLBACK;` via a fixture; remove the `beforeEach` `DELETE FROM documents` patterns. Eliminates the standups intermittent 404.

13. **Web unit gate.** `pnpm test` should run both API and web. Fix the 13 stale web tests (`document-tabs.test.ts` sprint→week references, `DetailsExtension.test.ts` content-expression assertion) before turning the gate on so the first green run is honest.

## File-specific evidence index

| Claim | Evidence |
|---|---|
| Empty-test hook flawed | `scripts/check-empty-tests.sh:33-50` matches any `page.` |
| Real silent-pass tests | `e2e/accessibility-remediation.spec.ts:1398`, `e2e/file-attachments.spec.ts:161` |
| Tautological tests | `api/src/collaboration/__tests__/collaboration.test.ts:444,449,716`; `web/src/components/icons/uswds/Icon.test.tsx:83,88,93`; `web/src/hooks/useSessionTimeout.test.ts:774` |
| Heavy-mock route tests | `api/src/routes/projects.test.ts:4-23`; `api/src/routes/iterations.test.ts:4-23`; `api/src/routes/api-tokens.test.ts:4-13` |
| Untested route modules | `api/src/routes/{accountability,activity,admin,admin-credentials,ai,associations,caia-auth,claude,comments,dashboard,feedback,invites,programs,setup,team,weekly-plans}.ts` |
| Untested services | `api/src/services/{ai-analysis,caia,secrets-manager,oauth-state,invite-acceptance,audit}.ts` |
| No CI | absence of `.github/workflows/` |
| Coverage dep missing | `api/package.json` script `test:coverage`, no `@vitest/coverage-v8` dep |
| Retry masking flakes | `playwright.config.ts:60` `retries: process.env.CI ? 2 : 1` |
| Stale web tests | `web/src/lib/document-tabs.test.ts:25,34,47,75,97`; `web/src/components/editor/DetailsExtension.test.ts:16` |
| Conditional assertions | `grep "if (await.*isVisible" e2e/*.spec.ts` → 81 hits; concrete examples at `e2e/mentions.spec.ts:166,266,295,328,358,386` and `e2e/security.spec.ts:330` |
| Shallow reconnect test | `e2e/error-handling.spec.ts:127-152` |
| Helpers unused | only `e2e/backlinks.spec.ts` and `e2e/bulk-selection.spec.ts` import from `test-helpers.ts` |
| Dead code in fixture | `e2e/fixtures/isolated-env.ts:69-75` `getSafeWorkerCount` unreferenced |
| Migration replay untested | `api/src/db/migrate.ts:106` silently swallows `already exists` |
