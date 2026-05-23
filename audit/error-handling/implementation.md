# Runtime Error and Edge Case Handling — Implementation Notes

Companion to `README.md` (audit baseline, 2026-05-19) and `peer-review.md` (independent pass). Documents what was fixed, how, and how to reproduce the result. Branch: `implement/error-handling`.

The work is structured into four phases (see the plan section at the bottom). Each phase is independently shippable; later phases assume earlier ones have landed but do not strictly depend on them.

## Summary

| Area | Before | After | Commit |
| --- | --- | --- | --- |
| `pg.Pool` idle-client error handler | Absent — idle-client errors crashed the API process | `pool.on('error', ...)` logs and continues | `f15e6ee` |
| Documents list 500 response (README Fix 1) | Rendered "No documents yet", indistinguishable from an empty workspace | Explicit error card + Retry; stale-data banner when cached docs exist; sidebar shows compact error+retry | `8747738` |
| Realtime `/events` WebSocket reconnect under 429 (README Fix 3) | Fixed 3 s reconnect retried straight into 30/IP/min limit; ~200 silent console errors per audit run; server 429s unlogged | Full-jitter exponential backoff (1 s … 30 s); inferred `rate-limited` state; non-blocking UI indicator; server `console.warn` on every 429 rejection. Verified end-to-end in Playwright. | `dd305b3`, `f3889fc` |
| AI analysis routes returned 200 on failure (peer-review §5) | `res.json({ error: 'ai_unavailable' })` — TanStack Query treated failures as success | `res.status(503).json(...)` so HTTP layer reflects the failure | `16a5f3b` |
| `warning` color missing from Tailwind palette | `bg-warning` / `bg-warning/10` in indicator + stale-data banner emitted no CSS | Added `warning: '#d97706'` to `web/tailwind.config.js` | `9bab3d4` |
| Realtime reconnect after logout (review feedback on `dd305b3`) | `disconnect()` closed the WS, but the still-pending `onclose` closure read a stale truthy `user` and scheduled a fresh reconnect — opening an unauthenticated socket against the just-cleared session | `shouldReconnectRef` is the single source of truth; flipped to `false` in `disconnect()` before close, checked in `onclose`. Verified in Playwright. | `570d6ec` |

## Implementation

### Phase 1 — Crash prevention

#### 1. Attach `pool.on('error', ...)` to the pg pool (peer-review §1)

**Before.** `api/src/db/client.ts:17-26` created a `pg.Pool` but never attached a pool-level `'error'` listener. The `pg` docs explicitly warn that "the client comes back from the pool with an active error" and you must register a pool-level error handler, or "your application will crash with an unhandled exception when an idle client emits an error." Combined with the absence of any `process.on('uncaughtException')` handler in the repo (only `SIGTERM`/`SIGINT` in `api/src/db/client.ts:29,36`), an RDS failover, network blip, or admin `pg_terminate_backend` was a guaranteed process crash with no recovery.

**Change.** Added a pool error listener immediately after the `Pool` constructor in `api/src/db/client.ts`:

```ts
pool.on('error', (err, _client) => {
  console.error('[db] idle client error:', err);
});
```

The listener intentionally only logs. The pool itself evicts the bad client and creates a fresh one on the next checkout; the process should keep serving healthy connections.

**After.** Idle-client errors no longer escape to the event loop. Subsequent queries proceed against fresh connections from the pool. No change to request-path behavior on healthy connections.

**Reproducibility.** With the dev API running, force-terminate a backend from a `psql` session:

```sql
SELECT pid, application_name FROM pg_stat_activity WHERE application_name LIKE 'node%';
SELECT pg_terminate_backend(<pid>);
```

Before the fix: the API process exits with an unhandled exception stack trace. After the fix: a single `[db] idle client error: ...` line is logged and the API keeps serving.

**Commit.** `f15e6ee`

### Phase 2 — User-visible data-loss/confusion

#### 1. Explicit error state for the documents list (README Fix 1)

**Before.** `web/src/hooks/useDocumentsQuery.ts:197` returned `documents` defaulted to `[]` and exposed only `loading`, dropping `isError` / `error` from the underlying `useQuery` result. `web/src/lib/queryClient.ts:161-164` logs query errors globally but does not surface them to consumers. When `GET /api/documents?type=wiki` returned 500, `DocumentsPage` (`web/src/pages/Documents.tsx:257-279`) and the app-shell `DocumentsTree` (`web/src/pages/App.tsx:618-620`) both fell through to the `documents.length === 0` branch and rendered "No documents yet" — indistinguishable from an actual empty workspace. There was no retry affordance and no signal that anything had gone wrong.

**Change.**

- `web/src/hooks/useDocumentsQuery.ts:197-244` — `useDocuments()` now also returns `isError` and `error` (typed as `Error | null`) from the underlying `useQuery`. `refreshDocuments` already wrapped `refetch`, so no new retry plumbing was needed.
- `web/src/contexts/DocumentsContext.tsx:17-26` — added `isError: boolean` and `error: Error | null` to `DocumentsContextValue` so consumers reading through the (deprecated-but-still-used) context see the same surface.
- `web/src/pages/Documents.tsx:39,256-307` — destructure `isError` and `refreshDocuments`; when `isError && documents.length === 0`, render a `role="alert"` error card ("Documents could not be loaded", recovery hint, Retry button wired to `refreshDocuments`) in place of the empty state. When `isError && documents.length > 0`, render a non-blocking stale-data banner above the existing list ("Showing cached documents — couldn't reach the server. Retry") so cached content stays visible on transient failures.
- `web/src/pages/App.tsx:47,491-497,606-635` — parent pulls `isError`/`refreshDocuments` from `useDocuments()` and passes them into `DocumentsTree`; the sidebar tree renders a compact "Couldn't load documents" + Retry block when there's no cached data, and falls through to its existing render path when cached data is present.

The two render paths follow the README's "After behavior" prescription exactly: error UI when there's nothing to show, stale-data banner when there is.

**After.** A 500 on the documents query produces a clear error message and a Retry button in both the main page and the sidebar. Cached documents are preserved during transient failures with a visible banner indicating staleness. The `documents.length === 0` empty state is now only reached when the workspace is genuinely empty.

**Reproducibility.** With dev API + web running, intercept the documents request and observe both surfaces:

1. Empty cache → error: open DevTools, block `GET /api/documents?type=wiki` (or stop the API process), then navigate to `/docs`. Expect "Documents could not be loaded" with Retry on the page, and "Couldn't load documents" with Retry in the sidebar. Click Retry with the API restored to see the list populate.
2. Warm cache → stale banner: load `/docs` successfully first to populate the cache, then block the endpoint and reload. Expect the document list to remain visible with a "Showing cached documents — couldn't reach the server. Retry" banner above it.

**Commit.** `8747738`

#### 2. Realtime rate-limit visibility and reconnect backoff (README Fix 3)

**Before.** The `/events` WebSocket in `web/src/hooks/useRealtimeEvents.tsx:96-117` reconnected on a fixed 3-second timer after every close, regardless of close code. The server enforces 30 connections/IP/minute at `api/src/collaboration/index.ts:19-27` and returns `HTTP/1.1 429 Too Many Requests` before the upgrade. The client saw a normal close, waited 3 s, reconnected, was rejected with 429, closed, waited 3 s, repeated — a self-DoS loop that produced ~200 browser-side `Unexpected response code: 429` console errors during the audit run. The 429 rejections at `api/src/collaboration/index.ts:620-657` were not logged on the server side, so the issue was invisible in stdout/stderr. Every `ws.onerror` / `ws.onclose` also wrote to the console regardless of attempt count. The provider only exposed `isConnected: boolean`, so consumers could not distinguish "briefly reconnecting" from "rate-limited" and the UI showed nothing.

**Change.**

- Server logging — `api/src/collaboration/index.ts`. Both 429 branches now log path, client IP, current attempt count, and the configured window before destroying the socket, and the 429 response gains a `Retry-After: 60` header so well-behaved clients can honor it.

  ```ts
  if (isConnectionRateLimited(clientIp)) {
    const recentCount = (connectionAttempts.get(clientIp) || []).length;
    console.warn(`[Collaboration] 429 rate-limit /events ip=${clientIp} attempts=${recentCount}/${RATE_LIMIT.MAX_CONNECTIONS_PER_IP} window=${RATE_LIMIT.CONNECTION_WINDOW_MS}ms`);
    socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n');
    socket.destroy();
    return;
  }
  ```

- Client backoff — `web/src/hooks/useRealtimeEvents.tsx`. Replaced the fixed `setTimeout(connect, 3000)` with full-jitter exponential backoff:

  ```ts
  function computeReconnectDelay(attempt: number): number {
    const exp = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
    return Math.floor(Math.random() * exp);
  }
  ```

  `RECONNECT_BASE_MS = 1000`, `RECONNECT_CAP_MS = 30_000`. Attempt counter increments on every close and resets to zero on a successful `onopen`. After the first attempt, subsequent close logs are emitted only every fifth retry so the console stays usable. The `ws.onerror` handler no longer logs at all — it only requests close, deferring the retry decision to `onclose`.

- Status surface — same file. Provider now exposes `status: 'connected' | 'connecting' | 'reconnecting' | 'rate-limited' | 'disconnected'` alongside the existing `isConnected`. The provider infers `'rate-limited'` when the WebSocket closes without ever firing `onopen` within <1 s and the attempt counter is ≥ 2, since the browser hides the upgrade-time 429 status from JS (the close event carries no HTTP status). This is heuristic but matches the actual server behavior closely enough to drive UI copy.

- UI indicator — new `web/src/components/RealtimeStatusIndicator.tsx`. A small fixed-position pill (bottom-center, `pointer-events-none`, `role="status"`, `aria-live="polite"`) that renders only when status is `'reconnecting'` or `'rate-limited'`. Two copies: "Realtime reconnecting…" and "Realtime updates limited — reconnecting with backoff." Mounted in `web/src/pages/App.tsx` alongside the other shell-level overlays so it sits over every authenticated route.

The `/collaboration/wiki:<id>` Yjs WebSocket (driven by y-websocket's `WebsocketProvider`) was intentionally left alone for this pass. y-websocket has its own internal reconnection logic that overriding requires either monkey-patching `provider.ws` or forking the library. The server-side log change covers 429 rejections on that path too (the warn line includes `url.pathname`), and the new UI indicator covers the global `/events` channel; if 429s on the editor path become a recurring problem, a follow-up can apply the same backoff strategy to the editor provider.

**After.** A burst of reconnects no longer hammers the server: the first retry sleeps 0–1 s, the second 0–2 s, then 0–4 s, … up to 0–30 s. Once the server's 1-minute window clears, the next reconnect succeeds and the attempt counter resets. The console emits one log line on the first retry and one every five retries thereafter, instead of two per close. The server logs every 429 with enough context (IP, count, window) to diagnose the cause. Users see a small non-blocking pill when reconnects are degraded.

**Reproducibility.**

- Backoff: in DevTools, stop the API process. Watch the console — the next reconnect log should show a delay distributed in `[0, 1000)`, then `[0, 2000)`, `[0, 4000)`, etc.
- Rate-limit log: from a Node REPL on the dev box, open `> 30` WebSockets to `ws://localhost:3001/events` in under a minute. The API server's stdout should print `[Collaboration] 429 rate-limit /events ip=... attempts=...` for each rejection past the 30th.
- UI indicator: stop the API process and reload the app. After the second close (~1–3 s in), the bottom-center pill should appear; restart the API and confirm it disappears on the next successful open.

**Commit.** `dd305b3` (initial), `f3889fc` (didOpen fix — see "Verification" below)

#### 3. AI routes return 503 on failure instead of 200 (peer-review §5)

**Before.** `api/src/routes/ai.ts:42,72` caught analysis errors and called `res.json({ error: 'ai_unavailable' })` with no status. The HTTP response was `200 OK` with an error body. TanStack Query's `mutateAsync` and any caller that branches on `res.ok` treats a 200 as success — `onError`/retry never runs, the mutation is recorded as successful, and only a body-shape inspection inside the success handler exposes the failure.

**Change.** Both catch handlers now use `res.status(503).json({ error: 'ai_unavailable' })`. The body shape is unchanged; only the HTTP status differs. Existing callers — `web/src/components/PlanQualityBanner.tsx:189,433` (branches on `r.ok` before parsing) and `web/src/components/sidebars/QualityAssistant.tsx:196,327` (uses an `isError` helper that checks the body shape) — both continue to behave the same way from the user's perspective; the failures simply stop masquerading as successes at the network layer.

**After.** Mutations and queries against the AI routes now fail correctly when the analysis service errors. Network panel shows 503, not 200. Future code that uses these endpoints will get the right HTTP-layer signal without having to know the magic `ai_unavailable` string.

**Reproducibility.** Stop the AI analysis service (or pass a malformed payload that throws inside `analyzePlan`/`analyzeRetro`), POST to either endpoint, and confirm the response is HTTP 503 with `{"error":"ai_unavailable"}` rather than HTTP 200.

**Commit.** `16a5f3b`

#### 4. Reconnect-after-logout via `shouldReconnectRef` (follow-up to `dd305b3`)

**Before.** After fixing the rate-limit backoff in commit `dd305b3`, code review surfaced a subtler bug in the same hook. The `onclose` handler still gated its reconnect decision on the `user` value captured at the time `connect()` ran. When the user logged out (or the provider unmounted), `disconnect()` cleared the timer and called `wsRef.current.close()`, but the resulting `onclose` event was handled by the closure registered earlier — one whose `user` was still truthy. The handler fell through the `if (!user)` guard and scheduled a new `setTimeout(connect, …)` (a different timer than the one `disconnect` just cleared). The reconnect then opened an unauthenticated WebSocket against the just-cleared session.

**Change.** Introduced `shouldReconnectRef = useRef(false)` in the provider as the single source of truth for reconnect intent. `connect()` flips it to `true` at the top; `disconnect()` flips it to `false` **before** clearing the timer and closing the socket so even a synchronous `onclose` reads the right value. The `onclose` handler now branches on `shouldReconnectRef.current` instead of the closure-captured `user`. Since `connect` no longer references `user`, its `useCallback` deps were dropped to `[]` (the existing `useEffect([user, connect, disconnect])` continues to re-run on user changes via the `user` dep itself).

**After.** Logout / unmount reliably tear the realtime connection down. No leftover reconnect timer fires; no unauthenticated WebSocket gets opened.

**Verification.** Drove the change through Playwright. Logged in, confirmed the events WebSocket reached `readyState === 1` via a React fiber walk into `RealtimeEventsProvider`. Located the auth context's `logout` callback the same way, called it, then waited 5 seconds while sampling the console:

```
[LOG] [RealtimeEvents] Connected
[LOG] === TEST: about to call logout ===
[LOG] === TEST: logout returned, waiting 5s ===
[LOG] === TEST: 5s elapsed, afterWsState=null ===
```

No `[RealtimeEvents] Reconnecting in Xms (attempt N)` line appeared between the logout marker and the 5s-elapsed marker — pre-fix, one would have fired within the first second. The fiber walk after the 5s wait found no `/events` WebSocket attached to the provider (`afterWsState: null`), confirming the connection was fully released.

**Commit.** `570d6ec`

**Verification.** Drove the change through Playwright against `pnpm dev` (web on `:5173`, API on `:3000`). Logged in as `dev@ship.local`, landed on `/docs`, then ran a flood-and-close scenario from the page itself:

1. Opened 35–60 fresh `WebSocket('ws://localhost:3000/events')` instances in one tick to saturate the server's 30/IP/min budget.
2. Reached into the React fiber tree to find `RealtimeEventsProvider`'s `wsRef.current` (the app's own `/events` WebSocket) and called `.close()` on it so the hook would attempt to reconnect into the now-saturated budget.
3. Sampled the indicator pill text every 500 ms for 6 s, then captured a screenshot.

Results across multiple runs:

| Observation | Expected | Actual |
| --- | --- | --- |
| Pill renders after close | Within ~1 s | t = 500 ms: "Realtime reconnecting…" |
| Pill transitions to rate-limited | Around attempt 2 (~3–5 s) | t = 5000 ms: "Realtime updates limited — reconnecting with backoff." |
| Pill clears on recovery | After successful reconnect | Pill removed once a reconnect attempt opened (when the 60 s rate-limit window cleared) |
| Reconnect backoff distribution | Attempt 1 delay ∈ [0, 1000) ms; attempt 6 ∈ [0, 30000) ms (capped) | Attempt 1: 348 / 545 / 548 ms across runs; attempt 6: 12 651 ms |
| Hook `console.log` volume | First attempt + every 5th | Across ~110 browser-emitted 429 errors, the hook logged 4 lines total (attempts 1, 1, 1, 6) |
| Hook `console.error` volume | Zero (we no longer log onerror or onclose) | Zero — all remaining 429 lines in the console are browser-internal handshake errors, which JS cannot suppress |
| TanStack Query devtools / other UI unaffected | No layout shift | Pill is `position: fixed` with `pointer-events-none`; no displacement |

Evidence screenshots saved under `audit/error-handling/evidence/` (gitignored, kept for local reference):

- `05-realtime-rate-limited-indicator.png` — pill close-up showing "Realtime updates limited — reconnecting with backoff."
- `06-realtime-rate-limited-fullpage.png` — full viewport with pill anchored bottom-center

**Bug caught during verification.** The first verification run showed the pill rendering but staying as "Realtime reconnecting…" indefinitely instead of transitioning to "Realtime updates limited…". Root cause: the original `wasConnected` check read `ws.readyState === WebSocket.CLOSED` inside `onclose`, which is always `true` (readyState always becomes `CLOSED` before `onclose` fires). Replaced with a per-connection `let didOpen = false` flag set inside `onopen` and read inside `onclose`. The follow-up commit `f3889fc` also removed the now-unused `lastConnectAtRef`. Re-ran the Playwright scenario to confirm the transition fires at the expected time.

## Deferred (planned)

Carrying the rest of Phase 1 and Phases 2–4 from the plan:

### Phase 1 — remaining

- **Process-level rejection/exception handlers** in `api/src/index.ts` (peer-review §"got right"). Log and exit cleanly instead of dying silently on unhandled rejections.
- **Express error middleware** at the bottom of `api/src/app.ts` (peer-review §3, §"got right"). Sync throws from any route currently bypass per-route try/catch and hit Express's default handler.
- **Async-safe WebSocket connection listeners** at `api/src/collaboration/index.ts:683` and `:789` (peer-review §2). Wrap in try/catch, close socket with 1011 on throw, and add `wss.on('error', ...)` on both WSS instances.
- **Per-send try/catch** around the broadcast loop at `api/src/collaboration/index.ts:262-276` (peer-review §3). One half-open socket should not break broadcast for the rest.

### Phase 2 — user-visible data-loss/confusion

- **`useAutoSave` returns save state** (README Fix 2 root cause; `web/src/hooks/useAutoSave.ts:39-46`). Replace the silent third-retry `console.error` with a returned `{ status, error }` state so callers can react.
- **Title save failure UI** (README Fix 2). Consume the new save state in `Editor`/`UnifiedDocumentPage`; show `Save failed` with Retry/Revert; decouple from the global `Saved` indicator.
- **Body persist failure UI** (peer-review §"overstated"). Same shape as the title fix but for `persistDocument` failures at `api/src/collaboration/index.ts:176-178`. Currently invisible.
- **Replace native `alert()` with toasts** in `web/src/components/Editor.tsx:404,418,423` (peer-review §4). `ToastProvider` is already wired at `web/src/main.tsx:257`.

### Phase 3 — provider-tree resilience

- **Root error boundary** wrapping `web/src/main.tsx:251-268`. Today, a render error in any provider produces a white screen.
- **`errorElement` or data-router migration** so router-level errors surface (peer-review §14).
- **Per-request fetch timeouts** in `web/src/lib/api.ts` (peer-review §8). `AbortSignal.timeout(30_000)` on all helpers.
- **CSRF retry guard** at `web/src/lib/api.ts:101-114,208-221` (peer-review §15). Bounded retry counter.

### Phase 4 — consistency and observability

- **Unify API error response shape** (peer-review §6). ~399 routes return `{ error: 'message' }` strings; client expects `{ success, error: { code, message } }`. Either migrate routes or teach the client both shapes.
- **Request correlation IDs** (peer-review §7). One-line middleware adding `req.id = randomUUID()`; include in every `console.error` and in the Phase 1 error middleware response body.
- **Zod-validate `req.query`** at routes that read repeated/typed params — search, standups, projects sort (peer-review §12).
- **PG error code branching** (peer-review §13, §16). `23505 → 409 Conflict`, `57014 → 504 Gateway Timeout` with explicit copy.
- **File upload hardening** at `api/src/routes/files.ts:172-191` (peer-review §10). Remove the multi-branch `req.body` introspection; trust `express.raw()`.
- **1GB upload / 15-min session mismatch** (peer-review §11). Either chunked uploads, sliding session refresh during long requests, or cap upload size.
- **Whitelist-only console errors in E2E.** Fail tests on unexpected console errors so future regressions are caught (audit recommendation 2).

## Pattern recap

The shape of the bugs the audit and peer review identified falls into a few recurring categories. Worth keeping in mind as new code lands:

| Pattern | Examples |
| --- | --- |
| Async work in a listener with no try/catch / no `'error'` handler | `pg.Pool` (fixed), `wss.on('connection', async ...)`, `ws.send` in broadcast loops |
| Failed mutation silently reported as success | `useAutoSave` third retry, AI routes returning 200 on error, Yjs body persist failures |
| Failure surfaces as an empty state instead of an error state | `/docs` list 500 → "No documents yet" |
| Realtime/transport state conflated with document save state | Editor `Saved` indicator while WebSocket 429s repeat |
| Error boundary or `errorElement` missing above the failing code | Provider-tree render errors → white screen; router-level errors not handled |
| Inconsistent contracts between client and server | Two error-response shapes, no request IDs, untyped `req.query` casts |

In each case the fix is to add the missing boundary or signal at the layer where failure actually occurs, rather than trying to make the failure not happen.

## Branch state at time of writing

- **7 implementation commits** on `implement/error-handling`: `f15e6ee` (pg pool error handler), `8747738` (documents list error state), `dd305b3` (realtime 429 backoff and visibility), `f3889fc` (realtime didOpen fix found in Playwright verification), `16a5f3b` (AI routes return 503), `9bab3d4` (Tailwind warning color), `570d6ec` (realtime reconnect-after-logout fix)
- Plus this docs file
- Remaining Phase 1 items, the rest of Phase 2, and Phases 3–4 are planned but not implemented
