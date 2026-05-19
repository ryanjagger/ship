# Test Coverage and Quality Audit

Date: 2026-05-19

## Scope

This audit measures what Ship's current automated tests cover, what they miss, and how reliable they are. I ran the API unit suite three times with `pnpm test`, listed and ran the Playwright E2E suite three times, read the API/web/E2E test files, and configured package coverage for API and web.

Important scope finding: root `pnpm test` does not run the full test suite. It only runs `pnpm --filter @ship/api test`. The Playwright E2E suite and web Vitest suite are separate gates.

## Test Inventory

| Area | Files | Test count | Current gate |
| --- | ---: | ---: | --- |
| API Vitest | 28 | 451 passing | Included in root `pnpm test` |
| Web Vitest | 16 | 151 total, 138 passing, 13 failing | Not included in root `pnpm test` |
| Shared package | 0 | 0 | No test or coverage script |
| Playwright E2E | 71 spec files | 869 executable tests listed by Playwright | `pnpm test:e2e` / `pnpm exec playwright test` |

## Command Results

### `pnpm test`

The first sandboxed attempt failed with `[ERROR] fetch failed`; rerunning outside the sandbox completed normally. I then ran the root command three times.

| Run | Result | Test files | Tests | Runtime |
| --- | --- | ---: | ---: | ---: |
| 1 | Pass | 28 passed | 451 passed | 12.89s wall, Vitest 11.95s |
| 2 | Pass | 28 passed | 451 passed | 12.59s wall, Vitest 11.70s |
| 3 | Pass | 28 passed | 451 passed | 12.43s wall, Vitest 11.57s |

During later verification, a run of `pnpm test` failed once in `src/routes/standups.test.ts` because standup creation returned 404 instead of 201. An immediate rerun passed all 451 tests in 11.24s, so this should be treated as an additional API unit flake.

### Playwright E2E

I ran the full E2E suite with one worker because the runner repeatedly warned about low available memory, and the Playwright config estimates each worker needs roughly 500 MB. Artifacts were copied to `audit/test-coverage/e2e-run-*.jsonl` and `audit/test-coverage/e2e-run-*-summary.json`.

| Run | Result | Passed | Flaky | Failed | Did not run | Runtime |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Fail | 815 | 7 | 1 | 46 | 27.6m, 1657.94s wall |
| 2 | Fail | 811 | 10 | 1 | 47 | 37.6m, 2258.32s wall |
| 3 | Pass with retries | 863 | 6 | 0 | 0 | 28.0m, 1682.71s wall |

The E2E suite identified 15 unique first-attempt failures across the three runs. Four recurred in all three runs: bulk delete undo, My Week retro freshness, project-weeks navigation, and weekly allocation grid plan linkage.

## Coverage Baseline

Coverage tooling is not fully configured in the repo. API has an intended coverage script and Vitest coverage block, but the required `@vitest/coverage-v8` provider is not installed, so `pnpm --filter @ship/api test:coverage` fails in the current repo state. Web has no coverage script or coverage block, and shared has no tests or coverage setup.

The numeric baselines below were captured during the audit with temporary local coverage tooling. They should be treated as exploratory measurements, not reproducible repo behavior until coverage support is intentionally added.

| Package | Command | Suite result | Statements | Branches | Lines | Notes |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `@ship/api` | `pnpm --filter @ship/api test:coverage` | Current repo: blocked by missing `@vitest/coverage-v8`; exploratory run: 451/451 pass | 40.34% | 33.44% | 40.52% | Low coverage in collaboration, services, and many route modules |
| `@ship/web` | Not configured in current repo | Exploratory run with temporary config: 138/151 pass, 13 fail | 27.63% | 19.38% | 28.53% | Web coverage needs intentional setup; failing tests are stale or brittle |
| `@ship/shared` | N/A | No tests | N/A | N/A | N/A | No package test or coverage setup |

Notable low-coverage zones:

| Package | Area | Line coverage | Risk |
| --- | --- | ---: | --- |
| API | `src/collaboration` | 8.83% | Real-time sync and persistence are E2E-heavy and flaky |
| API | `src/services` | 20.87% | AI, CAIA, OAuth state, and token logic have limited direct coverage |
| API | `src/routes/weekly-plans.ts` | 5.09% | Critical sprint/accountability behavior relies heavily on E2E |
| Web | `components/editor` | 5.02% | Editor extensions, uploads, mentions, and collaboration UI are mostly E2E-tested |
| Web | `services` | 8.53% | Upload service behavior is weakly covered outside browser tests |
| Web | `lib/api.ts` | 8.92% | API client error/retry behavior is mostly untested |

## Covered User Flows

| Critical flow | Existing coverage | Assessment |
| --- | --- | --- |
| Document CRUD | API delete, visibility, conversion, issue fields; E2E create/edit/title/list, document isolation, data persistence, private docs, properties sidebar | Broad coverage, but wiki delete/restore is mostly API-level and editor persistence is flaky around Yjs/content-column timing |
| Real-time sync | API collaboration tests for Yjs state and access control; E2E mentions sync, backlinks realtime, offline edits, WebSocket reconnect | Partial and unreliable. Multi-tab sync fails intermittently and normal editor tests emit WebSocket 429s |
| Auth and authorization | API login/logout/me/session, auth middleware, workspace isolation; E2E auth, security, session timeout, CSRF, impersonation, admin controls | Strong breadth, but web session-timeout unit tests currently fail and produce act/network warnings |
| Sprint management | E2E programs, weeks, program-mode week UX, team mode, project weeks, weekly accountability, manager reviews, request changes, status overview | Very broad but high flake concentration. Weekly plan/retro and allocation APIs are critical and unstable |
| Workspace/admin | E2E workspace switcher, admin dashboard, settings, invites, member roles, audit logs, private doc access | Good coverage. Some workspace tests did not run in failed E2E runs because earlier failures/retries consumed the run |
| Editor features | E2E mentions, backlinks, images, files, tables, toggles, TOC, inline comments/code, syntax highlighting, drag handles, content caching | Feature breadth is high, but many specs depend on fixed sleeps and conditional assertions |
| Accessibility/performance | E2E axe/accessibility remediation, status color checks, session modal a11y, load/typing/memory performance | Useful coverage, but performance assertions run in a low-memory local environment and should be separated from functional gates |

## Gaps and Reliability Risks

1. Root `pnpm test` is not a complete quality gate. It excludes web unit tests and all Playwright E2E tests.
2. Web Vitest is currently red: 13 failing tests across `document-tabs`, `DetailsExtension`, and `useSessionTimeout`.
3. Shared has no tests or coverage.
4. Real-time sync is not deterministic enough. The suite repeatedly emits WebSocket 429s, and multi-client mention sync fails intermittently.
5. AI/review tests hit live Bedrock paths and log `ResourceNotFoundException` for Anthropic model access. Tests often pass through fallback behavior, but stderr is noisy and environment-dependent.
6. The E2E suite has 619 `waitForTimeout(...)` calls, 106 `catch(() => false)` visibility swallows, and 81 conditional `isVisible` branches. The local `e2e/AGENTS.md` explicitly warns against these patterns.
7. Several tests contain silent-pass branches. For example, `mentions.spec.ts` skips assertions when an option is not visible, and `features-real.spec.ts` catches failed upload responses as `null` in several places.
8. `debug-create.spec.ts` is included in the normal E2E suite and prints debug console output. It should not be part of a production CI gate.

## Audit Deliverable

| Metric | Your Baseline |
| --- | --- |
| Console errors during normal usage | Present. Repeated WebSocket 429 errors appear in `debug-create.spec.ts`, `file-attachments.spec.ts`, `images.spec.ts`, and `mentions.spec.ts`; AI/review flows log Bedrock `ResourceNotFoundException`; `debug-create.spec.ts` also logs an initial 401. |
| Unhandled promise rejections (server) | None observed as unhandled. Server stderr includes expected/handled DB failure tests in API Vitest, Bedrock errors in AI paths, and Postgres pool timeouts during concurrent E2E issue creation. |
| Network disconnect recovery | Partial. Offline/reconnect flows are tested, but normal editor flows still produce WebSocket 429 disconnects, and collaborator mention sync failed in runs 1 and 3. |
| Missing error boundaries | Partial. `ErrorBoundary` exists around the app outlet and editor section, but there is no router-level `errorElement` coverage and no granular boundaries observed for dashboard/team/reviews/settings async panels. |
| Silent failures identified | See list below with reproduction steps. |

Silent failures and reproductions:

| Issue | Reproduction |
| --- | --- |
| Backlink removal can pass without observing the expected API event | Run `pnpm exec playwright test e2e/backlinks.spec.ts`. The "removing mention removes backlink" path logs that no `/links` POST was detected after mention removal, then continues. |
| Mention tests skip assertions when options are missing | In `e2e/mentions.spec.ts`, tests such as deleted target, renamed target, and collaborator sync wrap the main assertions in `if (await option.isVisible())`. A missing option can turn a regression into a pass. |
| AI provider failures are swallowed by fallback behavior | Run manager review or My Week E2E tests without Bedrock model access. The server logs `ResourceNotFoundException`, but many tests still pass, masking provider availability as non-fatal. |
| WebSocket 429s do not fail most editor tests | Run file attachment or image E2E specs. Console errors show event and collaboration WebSocket handshakes returning 429 while the tests continue. |

## Flaky Tests and Root Cause Notes

| Test | Runs observed | Symptom | Likely root cause |
| --- | --- | --- | --- |
| `bulk-selection.spec.ts` - undo restores deleted issues from trash | 1, 2, 3 | Strict locator failure on restored issue title such as `#5`, matching `#50`/`#51` too | Test selector is ambiguous. It should assert within the restored row using exact issue identity, not broad text search. |
| `my-week-stale-data.spec.ts` - retro edits visible after navigating back | 1, 2, 3 | Retro text missing on `/my-week` after save/navigation | The test file already documents this as known flaky: Yjs content is not persisted to the `content` column before the `/my-week` API reads it. |
| `project-weeks.spec.ts` - project link navigates back to project | 1, 2, 3 | Properties sidebar link for the project is not found | Context/sidebar population is racing navigation to the weekly plan document. Needs an explicit readiness signal or backend context contract. |
| `weekly-accountability.spec.ts` - allocation grid plan/retro status | 1, 2, 3 | `week1Data.planId` is `null` after creating a weekly plan | Backend grid query or test setup does not consistently link the freshly created plan to the project/week/person tuple. |
| `mentions.spec.ts` - sync mentions between collaborators | 1, 3 | Second tab never sees `.mention` after 15s | Real-time/Yjs sync readiness is not deterministic and is affected by WebSocket rate limiting. |
| `program-mode-week-ux.spec.ts` - sprint card click/double-click/API response | 1, 2 | Card selection/navigation/API wait timed out | Very large serial spec with cleanup and UI timing races. Many assertions are guarded by `catch(() => false)`. |
| `critical-blockers.spec.ts` - concurrent issue creation | 1 | Concurrent POSTs hit Postgres pool timeout | Testcontainer/Postgres pool capacity is too low for the concurrency assertion under low memory. |
| `data-integrity.spec.ts` - multiple images persist in correct order | 2 | Expected two images after reload, found zero | Upload/persistence race between editor state, upload confirmation, and reload. |
| `inline-comments.spec.ts` - cancel removes highlight | 2 | Highlight remained after cancel | UI cleanup is async and lacks a deterministic assertion target for comment state. |
| `private-documents.spec.ts` - private doc mention placeholder | 2 | Test timed out/context closed | Long two-user private-doc flow is sensitive to setup and navigation timing. |
| `session-timeout.spec.ts` - focus returns after modal closes | 2 | Previous element was not focused after close | Focus restoration behavior or test target is race-prone after modal dismissal. |
| `feedback-consolidation.spec.ts` - External badge | 3 | Seeded external issue row not found after filter | Seed data/filter state is not guaranteed before assertion, or the test assumes a fixture row not always present. |
| `src/routes/standups.test.ts` - creates standup with valid sprint_id | Post-change root verification | Expected 201, received 404 once; immediate rerun passed | API unit setup likely depends on sprint fixture availability or order-sensitive setup state. |

## Recommendations

### Fix at least 3 flaky tests with documented RCA

1. Fix bulk delete undo selector.
   RCA: the test stores row text and later searches the whole table for that text, so short ticket numbers can match other rows. Use a stable row identifier or exact issue title cell, then assert the restored row contains the same document ID/title. Add a test comment: `// Risk mitigated: undo can silently fail and leave issues in trash after bulk delete.`

2. Fix My Week retro freshness.
   RCA: "Saved" does not prove the `/my-week` API-readable `content` column has been persisted. Add a deterministic persistence signal or poll the document API until the retro content is visible before navigating. Add a test comment: `// Risk mitigated: users can return to My Week and see stale or missing retro content after editing.`

3. Fix weekly allocation grid plan linkage.
   RCA: the grid returns allocation data but sometimes omits the plan ID for the just-created person/project/week. Either fix the backend join or make the test create the same tuple the grid actually queries. Add a test comment: `// Risk mitigated: accountability dashboards can show an allocated person as missing a plan even after submission.`

### Add meaningful tests for undercovered critical paths

1. Add a deterministic two-client document body sync test that waits for explicit collaboration readiness, edits in tab A, verifies tab B receives body text, disconnects/reconnects tab B, edits again, and verifies no data loss. Comment to include: `// Risk mitigated: collaboration reconnect can drop edits or leave collaborators with divergent document state.`

2. Add a wiki document delete/restore E2E test covering parent with child documents, direct URL after delete, sidebar disappearance, undo/restore, and child visibility. Comment to include: `// Risk mitigated: document deletion can orphan children or make restored docs unreachable.`

3. Add an AI fallback/provider test using a fake provider rather than live Bedrock. Assert the user-facing fallback and server response shape when provider access is denied. Comment to include: `// Risk mitigated: external AI provider failures should not block review workflows or pass silently.`

### Gate changes

1. Make root `pnpm test` either run API plus web unit tests or rename it to `test:api` so CI semantics are honest.
2. Add a separate, explicit E2E gate with stable worker/memory settings. Track flaky retries as failures until the recurring flakes above are fixed.
3. Add a console-error budget helper for E2E. Expected offline tests should whitelist their own network errors; normal editor flows should fail on WebSocket 429s and unexpected console errors.
4. Move `debug-create.spec.ts` out of the default suite or mark it as a non-CI diagnostic.
