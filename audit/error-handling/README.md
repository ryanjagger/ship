# Runtime Error and Edge Case Handling Audit

Date: 2026-05-19

## Scope

This audit measured how the local Ship app behaves when requests fail, realtime collaboration disconnects, malformed input is submitted, concurrent edits happen, and network conditions degrade. The frontend was exercised at `http://localhost:5175` with the local API on port `3001`.

I used the in-app browser for the first authenticated smoke pass and a Playwright browser run for network/offline/throttle controls. The run used a fresh browser context, signed in as `dev@ship.local`, disabled the action-items modal, and captured console errors, warnings, page errors, and attached API server output per scenario.

## Audit Deliverable

| Metric | Your Baseline |
| --- | --- |
| Console errors during normal usage | **1 error, 0 warnings** during fresh login + `/docs` + create/edit flow. The error was the expected unauthenticated `GET /api/auth/me` 401 before login. Manual post-login `/docs` smoke in the in-app browser showed **0 errors, 0 warnings**. |
| Unhandled promise rejections (server) | **0 observed in attached API stdout/stderr during the rerun.** Server output showed startup, CAIA skipped, event WebSocket connect/disconnect churn, and collaboration room initialization; no stack traces, `UnhandledPromiseRejection`, or `uncaughtException` messages appeared. Source review still found no `process.on('unhandledRejection')` / `uncaughtException` handlers in `api/src/index.ts`. |
| Network disconnect recovery | **Pass for document body edits.** Offline edits survived reconnect and reload: `Online segment. Offline segment. Recovered segment.` Sync returned to `Saved`. |
| Missing error boundaries | **Partial coverage.** Boundaries exist around the main route outlet and editor body, but not around the root provider stack, app shell/sidebar providers, realtime provider, or router-level route errors. |
| Silent failures identified | **4 high-signal failures**: document-list 500 renders `No documents yet`; realtime WebSocket 429s only appear in console; title conflicts are last-writer-wins with no warning; throttled 3G left stale loading text visible. |

## Test Matrix

| Scenario | Result | Evidence |
| --- | --- | --- |
| Normal usage: login, `/docs`, search, create document, edit body | Pass with noise | 1 console error from pre-login `/api/auth/me` 401; no warnings; no page errors. |
| API 500 on `GET /api/documents?type=wiki` | Partial | UI stayed mounted, but rendered `No documents yet` instead of an explicit error/retry state. Console logged two 500 resource errors. |
| Empty login form | Pass | Submit showed `Email address is required`; email with no password showed `Password is required`. |
| Long text, special characters, HTML/script payloads | Partial | Script payloads did not execute. Editor body accepted long/special text. Long/script title triggered a 400 update response and console error. |
| Offline while editing document body, then reconnect and reload | Pass | Offline badge appeared, typing continued, reconnect returned to `Saved`, all body text survived reload. |
| Two pages editing the same document body | Pass for body | Both pages converged on `Base. A-simultaneous B-simultaneous`. |
| Two pages editing the same document title | Partial | Final title was last-writer-wins (`Audit title from A` in this run); no conflict indicator or recovery prompt was shown. |
| 3G throttled create/edit | Partial | Flow completed in 34.5s and sync status reached `Saved`, but `Loading...` text was still present and console recorded `/events` WebSocket 429s. |

## Findings

| Severity | Finding | Reproduction | Evidence / Location |
| --- | --- | --- | --- |
| High | Document-list API failure shows a misleading empty state instead of an error state. | Intercept `GET /api/documents?type=wiki` with HTTP 500, then open `/docs`. | Body rendered `No documents yet`; `useDocuments()` defaults failed query data to `[]` at `web/src/hooks/useDocumentsQuery.ts:197-235`; query errors are only logged globally at `web/src/lib/queryClient.ts:161-164`. |
| High | Realtime WebSocket connection rate limits produce repeated console errors and degrade slow/concurrent collaboration UX. | Open/edit the same document in two tabs or run under 3G throttle. | Repeated 429s from `/events` and `/collaboration/wiki:<id>`; connection cap is 30/IP/min in `api/src/collaboration/index.ts:19-27`, enforced at `api/src/collaboration/index.ts:620-657`; client reconnect logs errors in `web/src/hooks/useRealtimeEvents.tsx:96-117`. Attached server logs did not record those 429 rejections. |
| Medium | Title edits are not collaborative and conflicts silently resolve by last writer. | Open the same document in two pages, edit the title in both near-simultaneously, reload. | Body CRDT content merged, but title final value was last writer with no user notice. Title saves use optimistic REST mutation at `web/src/pages/UnifiedDocumentPage.tsx:236-276`. |
| Medium | Slow network can leave stale loading language on screen. | Throttle to 3G, login, create a document, type text, wait 5s. | Rerun ended with sync status `Saved`, but `Loading...` was still present after 34.5s and 5 console errors were recorded, mostly realtime `/events` WebSocket 429s. |
| Medium | Error boundaries do not cover the whole app shell. | Source review. | `ErrorBoundary` wraps the route `Outlet` in `web/src/pages/App.tsx:540-544` and editor content in `web/src/components/Editor.tsx:980-982`, but `web/src/main.tsx:251-270` wraps providers/router without a root boundary. |
| Low | Normal fresh login emits a DevTools console error for expected unauthenticated session check. | Open `/login` in a clean context and sign in. | `GET /api/auth/me` returns 401 before login. This is expected behavior but still counts as a DevTools console error during normal first-run usage. |

## Fix Plan

These are the three error-handling gaps to fix first. Each item includes reproduction steps, current behavior, target behavior, and screenshot evidence. Fix 2 is the required real user-facing data-loss/confusion scenario.

### Fix 1: Show an Explicit Documents Load Failure

**Gap:** When the wiki document list request fails, `/docs` renders `No documents yet`. This tells users their workspace is empty when the real problem is an API failure.

**Reproduction steps:**

1. Sign in as `dev@ship.local`.
2. Intercept `GET /api/documents?type=wiki` and return HTTP 500.
3. Open `/docs`.
4. Observe the sidebar and main document list.

**Before behavior:** The page stays mounted but shows `No documents yet` with skeleton rows in the main area. There is no retry affordance, no error copy, and no distinction between an empty workspace and a failed request.

**After behavior:** The documents sidebar and main list show an explicit error state: `Documents could not be loaded`, a short recovery hint, and a `Retry` button wired to `refetch()`. If cached documents exist, keep them visible with a non-blocking stale-data banner instead of replacing them with an empty state.

**Evidence:** Current failure screenshot: [01-docs-500-empty-state.png](./evidence/01-docs-500-empty-state.png)

![Documents 500 empty state](./evidence/01-docs-500-empty-state.png)

**Implementation notes:** Preserve `isError` / `error` from `useDocumentsQuery()` through `useDocuments()` and `DocumentsProvider`, then render error UI in `DocumentsPage` and the app-shell document sidebar. Add a focused Playwright test that fails before the fix by asserting the 500 does not render `No documents yet`.

### Fix 2: Surface Failed Title Saves and Preserve the Draft

**Gap:** A failed title save can leave the document showing a green `Saved` status and the new title in the editor while the sidebar still shows `Untitled`. This is a real user-facing confusion/data-loss scenario: the user believes the title is saved, but the persisted document title is not reliable.

**Reproduction steps:**

1. Sign in as `dev@ship.local`.
2. Create a new document.
3. Intercept `PATCH /api/documents/:id` and return HTTP 500.
4. Change the title to `Audit title that appears saved but is lost`.
5. Wait for autosave retries, then reload or navigate away and back.

**Before behavior:** The editor header shows the new title and a green `Saved` indicator. The document list still shows `Untitled`, and there is no persistent inline title-save error. The screenshots below show the mismatch and the title still appearing accepted after reload from client state.

**After behavior:** Title save failure changes the title status to `Not saved` or `Save failed`, keeps the user's typed title as a local draft, and exposes `Retry` and `Revert` actions. The global `Saved` indicator should not imply title/property persistence when a title/property mutation is failing. Navigation away from a failed title draft should warn or keep a recoverable local draft.

**Evidence:** Current failure screenshots: [02-title-save-failure-before-reload.png](./evidence/02-title-save-failure-before-reload.png), [03-title-save-failure-after-reload.png](./evidence/03-title-save-failure-after-reload.png)

![Title save failure before reload](./evidence/02-title-save-failure-before-reload.png)

![Title save failure after reload](./evidence/03-title-save-failure-after-reload.png)

**Implementation notes:** Extend `useAutoSave()` to return save state (`idle`, `saving`, `failed`, `saved`) and last error instead of only a callback. In `Editor`, track title-save state separately from Yjs body sync state and render it next to the title. In `UnifiedDocumentPage`, include mutation metadata (`operation: 'save title'`) and avoid treating editor-body sync as whole-document save success. Add a Playwright test that forces title PATCH failure and asserts the UI shows a failed-save state and retains the draft.

### Fix 3: Make Realtime Rate-Limit / Reconnect Failure Visible

**Gap:** Collaboration and events WebSocket failures can produce repeated 429 console errors while the editor still shows `Saved`. Users have no indication that collaborator presence, realtime notifications, or multi-user sync may be degraded.

**Reproduction steps:**

1. Sign in as `dev@ship.local`.
2. Open the same document in many tabs or run the audit script's connection-flood step.
3. Watch DevTools console for `Unexpected response code: 429` from `/events` or `/collaboration/wiki:<id>`.
4. Observe the editor header.

**Before behavior:** The editor can show green `Saved` while the browser records realtime 429 errors. In the evidence run, the connection-flood scenario produced 198 browser-side 429 console errors and no visible warning in the editor.

**After behavior:** Realtime connection state is separate from document persistence state. When `/events` or `/collaboration` fails with 429, the UI shows a non-blocking warning such as `Realtime reconnect delayed` or `Collaboration limited`. The client should use exponential backoff with jitter after 429, and the server should log rate-limit rejections with IP/path counters so the issue is visible in server logs.

**Evidence:** Current no-visible-warning screenshot: [04-realtime-429-no-visible-warning.png](./evidence/04-realtime-429-no-visible-warning.png)

![Realtime 429 no visible warning](./evidence/04-realtime-429-no-visible-warning.png)

**Implementation notes:** Add explicit WebSocket close/error state to `RealtimeEventsProvider` and the editor's `WebsocketProvider` status handling. Distinguish `body saved locally`, `body synced to server`, and `realtime/collaboration degraded`. Add server-side logging at `api/src/collaboration/index.ts:620-657` for 429 upgrade rejections. Add a Playwright test or short recording that triggers 429 and verifies the warning appears and clears after successful reconnect.

## Server Log Check

I restarted the local API dev server inside Codex on port `3001` and reran the audit while monitoring stdout/stderr. `pnpm` was hanging in this environment, so the equivalent direct dev commands were used:

- API: `PORT=3001 CORS_ORIGIN=http://localhost:5175 ./node_modules/.bin/tsx watch src/index.ts`
- Web: `API_PORT=3001 VITE_PORT=5175 VITE_API_URL=http://localhost:3001 ./node_modules/.bin/vite --host ::1`

Observed API output:

- Startup: `Yjs collaboration server attached`, `Events WebSocket server attached`, `CAIA not configured, skipping initialization`, `API server running on http://localhost:3001`.
- During browser scenarios: repeated `[Events] User ... connected/disconnected` lines.
- For created documents: `[Collaboration] No content found for wiki:<id>, starting with empty document`.
- No server stack traces, unhandled rejection messages, uncaught exception messages, database error logs, or request-handler 500 logs appeared during the rerun.
- Browser-side WebSocket 429s were not mirrored by an API log line, which makes rate-limit diagnosis harder from server logs alone.

Source review notes:

- `api/src/index.ts` catches startup failure, but does not install process-level `unhandledRejection` or `uncaughtException` handlers.
- Most API route handlers catch and return 500s locally, but `api/src/app.ts` does not define a final Express error-handling middleware after route registration.
- Collaboration persistence catches and logs DB write failures instead of throwing through the WebSocket path.

## Recommendations

1. Add explicit query error UI for list pages. For `/docs`, preserve cached data if available; otherwise render an error/retry state instead of `No documents yet`.
2. Treat unexpected console errors as E2E failures. Whitelist only deliberate unauthenticated/session/offline cases.
3. Back off realtime reconnects after 429 and expose a user-facing `Reconnecting` / `Rate limited` state instead of logging repeated socket failures.
4. Add conflict handling or at least visible conflict feedback for non-CRDT fields such as document titles and properties.
5. Add a root error boundary or router `errorElement` outside the provider/app-shell stack.
6. Attach dev server output to a log file or add structured server error logging so future audits can count unhandled rejections and request failures directly.
