# Test Coverage Audit — Implementation Notes

Companion to `README.md` (audit baseline, 2026-05-19). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/test-coverage`.

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| Root `pnpm test` scope | API only (451 tests) | API + web (602 tests) | `3282195` |
| Web vitest pass rate | 138/151 (13 failing) | 151/151 | `5203450`, `01a7b18`, `4044dc0` |
| API coverage script | Blocked by missing provider | Runs, emits text + HTML report | `e42e29e` |
| `my-week-stale-data.spec.ts` plan test | Flaky (1 audit run) | 6/6 deterministic | `2e8ff40` |
| `my-week-stale-data.spec.ts` retro test | Flaky (3/3 audit runs) | 6/6 deterministic | `2e8ff40` |
| `inline-comments.spec.ts` cancel highlight | Flaky (audit run 2; recurred at 12 workers) | 5/5 deterministic | `229ddc5` |
| `session-timeout.spec.ts` extend-session API | Flaky (audit run 2; recurred at 12 workers) | 5/5 deterministic | `34efdc7` |

## Quality gate changes

### 1. Root `pnpm test` now runs both API and web vitest

**Before.** `pnpm test` invoked `pnpm --filter @ship/api test`. The 16-file, 151-test web vitest suite was never gated by the root command. The audit called this out as misleading CI semantics.

**Change.** `package.json`:
- `test` now runs `@ship/api test` then `@ship/web test` (chained with `&&`)
- Added `test:api` and `test:web` aliases for targeted runs

**After.** Root command exercises 602 tests across both packages. Either suite failing fails the gate.

**Reproducibility.** `pnpm test`

### 2. API coverage provider installed

**Before.** `api/vitest.config.ts` specified `provider: 'v8'` and `api/package.json` had a `test:coverage` script, but `@vitest/coverage-v8` was not declared as a dependency. `pnpm --filter @ship/api test:coverage` failed before producing any report (audit confirmed).

**Change.**
- Added `@vitest/coverage-v8@^4.0.18` to api devDependencies. Pinned to the 4.0.x line — `^4.0.16` resolved to `4.1.7` which has a peer-dep mismatch against installed `vitest@4.0.17`.
- Added `coverage/` to `.gitignore` so reports don't get committed.

**After.** Coverage runs end-to-end. Numbers exactly match the audit's exploratory baseline:

| Metric | Value |
| --- | --- |
| Tests | 451/451 pass |
| Runtime | ~12s |
| Statements | 40.34% |
| Branches | 33.44% |
| Lines | 40.52% |

**Reproducibility.** `pnpm --filter @ship/api test:coverage`

## Web vitest — stale test fixes

All three buckets failed because the source code was refactored and the tests were not updated. Source is the source of truth; assertions updated.

### 1. `document-tabs.test.ts` — 10 failures

**Root cause.** Tab registry was refactored:
- Project/program tab id `sprints` was renamed to `weeks`
- Project tab order changed (`issues` is now the first tab; was `details`)
- Sprint documents gained 4 status-aware tabs (overview/plan/review/standups); previously had none
- Comment at `web/src/lib/document-tabs.tsx:70` ("sprint... will render directly... without a tab bar") was also stale

Tests still asserted the pre-refactor shape: looked for `sprints` tab id, expected `details` first, expected sprint to return empty.

**Change.** Updated assertions to match the current registry: `weeks` instead of `sprints`, `issues` as project default, sprint expected to return its 4 tabs, `documentTypeHasTabs('sprint')` expects `true`. The dynamic-label tests were also restructured to use program's `weeks` tab (which has the dynamic label function) rather than project's static `weeks` tab.

**After.** 22/22 pass.

**Reproducibility.** `pnpm --filter @ship/web exec vitest run src/lib/document-tabs.test.ts`

### 2. `DetailsExtension.test.ts` — 3 failures

**Root cause.** `DetailsExtension` was refactored from a single `Node.create` with `content: 'block+'` into a composite of three nodes: `details` (content: `detailsSummary detailsContent`), and supporting `DetailsSummary` and `DetailsContent` nodes exported separately. Test only imported `DetailsExtension` and registered it alone in the editor — ProseMirror then threw `SyntaxError: No node type or group 'detailsSummary' found` during schema construction.

**Change.** Imported `DetailsSummary` and `DetailsContent` alongside `DetailsExtension` and registered all three in the editor instantiations. Updated the content-expression assertion from `'block+'` to `'detailsSummary detailsContent'`.

**After.** 10/10 pass.

**Reproducibility.** `pnpm --filter @ship/web exec vitest run src/components/editor/DetailsExtension.test.ts`

### 3. `useSessionTimeout.test.ts` — 1 failure + 6 latent

**Root cause (visible failure).** Test "does NOT call onTimeout if dismissed before 0" stubbed `global.fetch` with `{ ok: true, json: ... }`. When `resetTimer` awaited `apiPost`, `lib/api.ts` called `response.headers.get('content-type')` — `headers` was undefined, threw `TypeError`. `resetTimer`'s catch block force-logged-out via `onTimeoutRef.current()`. Test then saw `onTimeout` called once and failed its `.not.toHaveBeenCalled` assertion.

**Latent issues found during the fix (per code review).**
- **P2.** Six other tests still used the broken mock shape and silently hit the same force-logout path. They passed only because they didn't assert on `onTimeout` — but stderr was full of `"Network error extending session - forcing logout"` lines, and any future regression in the catch path would be invisible.
- **P3.** `lib/api.ts` caches the CSRF token in module scope. `beforeEach` reset `mockFetch` but never cleared the cache, so later tests in the file could skip `/api/csrf-token` entirely depending on test order, coupling tests together.

**Change.**
- Added a `jsonResponse(data, status?)` helper at the top of the file that returns a Response-like object with a working `headers.get('content-type')` and resolvable `json()`.
- Replaced all 7 broken `{ ok: true, json: async () => ({ success: true }) }` mock sites with `jsonResponse({ success: true, token: 'csrf-token' })`.
- Added `expect(onTimeout).not.toHaveBeenCalled()` to the `resetTimer` success-path tests so any future regression in the catch path fails loudly instead of silently triggering force-logout.
- Imported `clearCsrfToken` from `@/lib/api` and called it in both `beforeEach` blocks (main describe + Edge Cases) so the module-level CSRF cache doesn't leak across tests.

**Follow-up (P2 found during commit).** The "activity does NOT reset absolute timeout" test had been overlooked in the first pass — it used `mockResolvedValue` with the broken shape and silently force-logged-out from the `resetTimer` call, just like the others. Two extra changes there:
- Switched to `mockImplementation` that branches by URL: `/api/auth/session` (raw fetch, no Response-shape needs) keeps the session-info data shape; CSRF + extend-session calls get `jsonResponse(...)`.
- `onTimeout.mockClear()` is called *between* the 11h45m time-advance and the `resetTimer` call, and `expect(onTimeout).not.toHaveBeenCalled()` runs immediately after `resetTimer`. This scopes the regression guard to "resetTimer didn't force-logout" without being tripped by the inactivity countdown's `setInterval` firing thousands of times during the long simulated advance — a separate fake-timers + React batching artifact (vi keeps queuing 1s interval ticks because the `clearInterval` inside the state updater doesn't take effect until React commits) that isn't in scope for this test.

**After.** 34/34 useSessionTimeout tests pass with no `Network error extending session - forcing logout` stderr. Full web suite: 151/151.

**Reproducibility.** `pnpm --filter @ship/web exec vitest run src/hooks/useSessionTimeout.test.ts`

## E2E flake fixes

All three fixes share an anti-pattern: **the test asserted on a side effect that landed asynchronously after the user-visible signal it was waiting on.** The visible signal (modal closes, input appears, editor shows "Saved") arrived first; the persisted state behind that signal arrived seconds later. The replacements all wait for the real contract instead of the convenient proxy.

### 1. `my-week-stale-data.spec.ts` — plan + retro edits

**Before measurement.**
- Audit (`README.md`): the retro test "fails on first attempt in every audit run." Plan test was the listed sibling.
- 10-worker run this session: both tests failed on first attempt, passed on retry (2 of 5 total flakes).
- Severity: high-recurrence (3/3 audit runs); plan test had less coverage but same code path.

**Root cause.** TipTap edits flow: editor → Yjs update → WebSocket to collaboration server → server persists Yjs binary state → server also flushes Yjs state to the `content` JSONB column.

The `"Saved"` indicator the test was waiting on only signals the WebSocket round-trip. The JSONB write happens asynchronously after that. `/my-week` reads from `content`, not from Yjs state, so navigating back immediately races the persistence. `page.waitForTimeout(3000)` was a guess-buffer that was sometimes wrong, especially under contention.

**Fix.** Added a `waitForDocumentContent(page, expectedText)` helper that polls `GET /api/documents/:id` (15s timeout, 250/500/1000ms intervals) and asserts the typed text appears in the persisted `content` JSONB before allowing the test to navigate. Both plan and retro tests replaced their `Saved` + `waitForTimeout(3000)` block with one call to the helper.

The persisted content is the actual contract `/my-week` depends on — the test now waits for the real signal instead of an approximation. Risk-mitigated comment added: *"users can return to My Week and see stale or missing plan/retro content after editing."*

**After measurement.** 6/6 passed in 34.9s with `--repeat-each=3 --workers=2`. No retries, no flakes.

**Reproducibility.** `pnpm exec playwright test e2e/my-week-stale-data.spec.ts --repeat-each=3 --workers=2`

**Commit.** `2e8ff40`

### 2. `inline-comments.spec.ts:118` — canceling a comment removes the highlight

**Before measurement.**
- Audit: failed in run 2 (one of 15 unique first-attempt failures across 3 runs); audit RCA called it "UI cleanup is async and lacks a deterministic assertion target."
- 10-worker run this session: passed.
- 12-worker run (higher contention): failed on first attempt, passed on retry.
- Severity: surfaces under contention.

**Root cause.** The pending comment input is rendered inside a ProseMirror Decoration widget that auto-focuses via `requestAnimationFrame` (`web/src/components/editor/CommentDisplay.tsx:184-188`):

```js
requestAnimationFrame(() => {
  const input = container.querySelector('.comment-pending-field') as HTMLInputElement;
  input?.focus();
});
```

The Escape handler at `CommentDisplay.tsx:302, 315` only fires when the pending input is the event target (`event.target.classList.contains('comment-pending-field')`).

The test sequence was:
```ts
await expect(commentInput).toBeVisible({ timeout: 3000 })   // element in DOM
await page.keyboard.press('Escape')                         // sent to whatever has focus
```

`toBeVisible` resolves as soon as the element is in the DOM — before the rAF callback has set focus on it. Under contention, the rAF was sometimes delayed past Playwright's keystroke, so Escape hit the editor body. The cancel handler never ran, the `commentMark` stayed, and `.comment-highlight` remained visible until the 10s assertion timeout.

**Fix.** One-line change: `page.keyboard.press('Escape')` → `commentInput.press('Escape')`. Playwright's `locator.press` focuses the element first, atomic from Playwright's perspective, then dispatches the key. This makes the test independent of the rAF timing and honors the source contract (Escape only fires when the pending input is focused).

**After measurement.** 5/5 passed in 29.4s with `--repeat-each=5 --workers=2`. No retries, no flakes.

**Reproducibility.** `pnpm exec playwright test e2e/inline-comments.spec.ts -g "canceling a comment removes the highlight" --repeat-each=5 --workers=2`

**Commit.** `229ddc5`

### 3. `session-timeout.spec.ts:629` — Stay Logged In calls extend session endpoint

**Before measurement.**
- Audit run 2 reported a `session-timeout.spec.ts` flake ("focus returns after modal closes"); this specific test was not in the audit's table but came from the same spec.
- 10-worker run this session: passed.
- 12-worker run (higher contention): failed on first attempt, passed on retry.
- Severity: surfaces under contention.

**Root cause.** `resetTimer` in `web/src/hooks/useSessionTimeout.ts:90-122` is async. The body executes in two phases:
1. **Synchronous:** `setShowWarning(false)`, `clearAllTimers()`, `scheduleInactivityWarning()`. The modal dismisses here.
2. **Async:** `await apiPost('/api/auth/extend-session')`. This goes through `ensureCsrfToken` → fetch (the CSRF endpoint) → second fetch (the actual extend-session POST).

The test relied on the modal dismissing as the proxy signal that the call had been made:
```ts
await button.click();
await expect(modal).not.toBeVisible();           // polled (correct)
expect(extendCalls.length).toBe(1);              // single-shot (wrong)
```

`extendCalls` was populated inside a `page.route('**/api/auth/extend-session', ...)` handler, which only fires once the actual fetch is intercepted by Playwright. Under contention, the apiPost was sometimes still in flight when modal-not-visible resolved, so the single-shot assertion saw `extendCalls.length === 0` and failed.

**Fix.** Replaced the synchronous `expect(extendCalls.length).toBe(1)` with `await expect.poll(() => extendCalls.length, { timeout: 5000 }).toBe(1)`. The assertion auto-retries until the route handler has actually recorded the call. `extendCalls[0]` is then safe to read because polling exited successfully.

**After measurement.** 5/5 passed in 24.8s with `--repeat-each=5 --workers=2`. No retries, no flakes.

**Reproducibility.** `pnpm exec playwright test e2e/session-timeout.spec.ts -g "Stay Logged In calls extend session endpoint" --repeat-each=5 --workers=2`

**Commit.** `34efdc7`

## E2E worker-count diagnosis

Not a fix, but a diagnostic finding worth recording.

**Before.** `pnpm test:e2e` on a 36GB Mac printed `[Memory] Total: 36.0GB, Available: 0.9GB`, warned about low memory, and dropped to 1 worker.

**Root cause.** Both `e2e/global-setup.ts:22` and `playwright.config.ts:37` use Node's `os.freemem()`. On macOS, that only counts *literally unused* pages — it ignores file cache, inactive pages, and compressed memory, all of which are reclaimable on demand. A 36GB Mac can plausibly report 0.9GB "free" while holding 15+GB of reclaimable cache. The heuristic in `getWorkerCount()` does `(freeMemGB - 2) / 0.5` and clamps to 1 when negative.

**Workaround.** `PLAYWRIGHT_WORKERS=N pnpm test:e2e` — the env override already exists at `playwright.config.ts:26-28`.

**After.**
- `PLAYWRIGHT_WORKERS=10`: 869/869 ultimately passed (5 first-attempt flakes auto-passed on retry) in **6m 12s**, down from the 28-37 min audit baseline at 1 worker.
- `PLAYWRIGHT_WORKERS=12`: 869/869 ultimately passed (2 first-attempt flakes — the inline-comments and session-timeout cases above) — higher contention surfaced two latent races the 10-worker run had not.

**Deferred.** Parse `vm_stat` on Darwin to compute real available memory (free + inactive + speculative + purgeable pages). ~20 lines in `getWorkerCount()`. Linux/CI is fine as-is.

## Pattern recap

All three e2e fixes (sections 6 + 7a + 7b in the personal session log) are the same anti-pattern: **wait for the real signal, not a proxy that happens to be close enough most of the time.**

| Spec | Proxy signal it relied on | Real contract it now waits on |
| --- | --- | --- |
| `my-week-stale-data` | "Saved" indicator + 3s buffer | `GET /api/documents/:id` returns content containing the typed text |
| `inline-comments` cancel | input element visible | input element focused (via `locator.press`) |
| `session-timeout` extend | modal closed | intercepted call count reached 1 (via `expect.poll`) |

Worth flagging this pattern as a code-review checklist item for new e2e tests: if you're about to assert on a side effect, ask whether the signal you're waiting on actually proves the side effect has landed.

## Branch state at time of writing

- **9 commits** on `implement/test-coverage`: `3282195`, `5203450`, `01a7b18`, `e42e29e`, `2e8ff40`, `229ddc5`, `34efdc7`, `3304378`, `4044dc0`
- All committed changes verified locally; branch pushed to origin
