# Runtime Error Audit - Peer Review

Date: 2026-05-19
Reviewer: Independent pass

This is a peer review of `audit/error-handling/README.md`. The original audit ran a Playwright smoke test against the running app and is good at describing what the user sees during specific failure modes. This pass focuses on the source-code surface area the original underweighted: process-level safety, error response shapes, validation coverage, and infrastructure-level error paths.

## What the original got right

- **Documents list 500 -> "No documents yet"** (Fix 1) is correctly the highest-impact UX bug. The screenshot + reproduction is solid.
- **Title-save mismatch** (Fix 2) is a real data-loss-shaped confusion bug, and `useAutoSave` is correctly identified as the root cause. The hook at `web/src/hooks/useAutoSave.ts:39-46` silently swallows the final retry failure with only a `console.error`, returning no state to the caller.
- **No process-level handlers in `api/src/index.ts`** is correctly flagged - I confirmed there is no `process.on('unhandledRejection')` or `process.on('uncaughtException')` anywhere in the repo (only SIGTERM/SIGINT in `api/src/db/client.ts:29,36`).
- **No central Express error middleware** is correctly flagged - `api/src/app.ts:240-242` ends the middleware chain with `initializeCAIA().catch(...)` and never registers an `(err, req, res, next)` handler.
- **Root error boundary missing** at `web/src/main.tsx:251-268` is correct. The single `ErrorBoundary` at `web/src/pages/App.tsx:542-544` only wraps the `<Outlet>`, so a render error in `WorkspaceProvider`, `AuthProvider`, `RealtimeEventsProvider`, `DocumentsProvider`, `ProgramsProvider`, `ProjectsProvider`, `IssuesProvider`, `UploadProvider`, `CurrentDocumentProvider`, `ReviewQueueProvider`, or `ToastProvider` produces a white screen.

## What it missed

### 1. `pool` has no `'error'` listener - one idle-client error crashes the API

`api/src/db/client.ts:17-26` creates a `pg.Pool` but never attaches `pool.on('error', ...)`. The `pg` docs explicitly warn that "the client comes back from the pool with an active error" and you must register a pool-level error handler or "your application will crash with an unhandled exception when an idle client emits an error." Combined with the missing `process.on('uncaughtException')` handler, an RDS failover or `pg_terminate_backend` from an admin is a guaranteed crash with no recovery. This is more severe than the rejection-handler omission the original called out.

### 2. WebSocket `wss.on('connection')` handler is async and unguarded

`api/src/collaboration/index.ts:683-686`:
```
wss.on('connection', async (ws, _request, docName, sessionData) => {
  const doc = await getOrCreateDoc(docName);
  const aw = getAwareness(docName, doc);
  ...
```
`ws` does not await listener promises. If `getOrCreateDoc` throws (DB outage, corrupt `yjs_state`), the rejection escapes to the event loop. The same is true for the events `wss.on('connection')` listener at line 789. Neither WSS instance has an `'error'` handler either.

### 3. `Y.applyUpdate(doc, result.rows[0].yjs_state)` at line 214 - the *outer* try/catch is wide, but the broadcast loop on document `update` (lines 262-276) runs `ws.send(message)` with no per-send try/catch. A socket in a half-open state can throw synchronously from `ws.send`, taking down the entire update broadcast.

### 4. Native `alert()` for "access revoked" and "document converted"

`web/src/components/Editor.tsx:404,418,423` calls `alert(...)` for ws close codes 4403/4100. Playwright's `page.on('dialog')` auto-dismisses these, which is likely why the original audit didn't see them. Real users get a modal dialog mid-edit, blocking the page until they click OK. There is a `ToastProvider` already wired up at `web/src/main.tsx:257` - use it.

### 5. `/api/ai/analyze-plan` and `/analyze-retro` return HTTP 200 on error

`api/src/routes/ai.ts:42` and `:72` use `res.json({ error: 'ai_unavailable' })` with no `.status(500)`. TanStack Query treats a 200 response as success, so its `onError`/retry logic never fires and the mutation is recorded as successful. The client has to inspect the payload shape to know it failed.

### 6. Inconsistent error response shape across the API

Auth middleware (`api/src/middleware/auth.ts:79-86`) returns `{ success: false, error: { code, message } }`. Route handlers return `{ error: 'Internal server error' }` - I counted **399** short-form responses across `api/src/routes/*.ts` versus only the auth/structured ones. The web client at `web/src/lib/api.ts:158-205` expects `ApiResponse<T>` shape (`success`, `data`, `error.code`) - it parses route-level errors as if `error` were a `{ code, message }` object but it's a string. This is why some failed mutations surface as `"[object Object]"` or empty error messages in the toast.

### 7. No request correlation IDs in logs

No `morgan`, no `X-Request-Id` middleware, no async-local-storage trace context. Every `console.error('List projects error:', err)` (and there are ~190 of them) is a bare stack trace with no way to correlate to which user, which workspace, which document, or which HTTP request triggered it. CloudWatch ingest is fine, but the data going in is unusable for production debugging. This is hidden by the original audit's "Server Log Check" passing - in local dev with one user, console output is readable; in prod with concurrent traffic, it isn't.

### 8. `fetch()` calls have no timeout and no AbortSignal

`web/src/lib/api.ts` - none of the helpers (`apiGet`, `apiPost`, `apiPatch`, `apiDelete`, `request<T>`) pass a `signal` or `AbortController`. The only `AbortController` usage in the codebase is for image/file upload cancellation (`web/src/components/Editor.tsx:239`, `web/src/services/upload.ts:87`). A hanging fetch waits forever (or until the browser default, ~5 min). Same for TanStack Query - queries can't be cancelled on unmount or route change.

### 9. `useRealtimeEvents` reconnects with fixed 3s delay - no backoff, no 429 awareness

`web/src/hooks/useRealtimeEvents.tsx:107-110` schedules a reconnect 3 seconds after every close, regardless of close code or reason. The server enforces 30 connections/IP/minute at `api/src/collaboration/index.ts:23,620-625` and returns `HTTP/1.1 429 Too Many Requests` before the upgrade. The client sees a normal close, waits 3s, reconnects, gets 429, closes, waits 3s, repeats. This is the mechanism behind the original audit's "198 console errors" finding - it's not just a UX issue, it's a self-DoS loop. The Yjs `wsProvider` at `web/src/components/Editor.tsx:385-394` only listens for `'status'` and `'connection-close'`, not `'connection-error'`, so even errors that the y-websocket library exposes are ignored.

### 10. `req.body` shape introspection in file upload local endpoint

`api/src/routes/files.ts:172-191`:
```
let buffer: Buffer;
if (Buffer.isBuffer(req.body)) { buffer = req.body; }
else if (req.body instanceof Uint8Array) { ... }
else if (typeof req.body === 'object' && req.body !== null) {
  const data = req.body.data || req.body;
  if (Array.isArray(data)) { buffer = Buffer.from(data); }
  else { buffer = Buffer.from(JSON.stringify(req.body)); }
}
else if (typeof req.body === 'string') { buffer = Buffer.from(req.body, 'base64'); }
```
`express.raw({ type: '*/*' })` always produces a `Buffer`. The fallback that does `Buffer.from(JSON.stringify(req.body))` will silently write JSON-text into the file if the parser ever changes. The branch that does `Buffer.from(req.body, 'base64')` will silently corrupt a binary file that happened to be valid base64. Either remove the fallbacks or assert.

### 11. 1GB upload + 15-min session = guaranteed mid-upload session expiry on slow links

`api/src/routes/files.ts:24` allows 1GB uploads. `api/src/app.ts:155` sets a 15-minute session cookie. A user on a 5 Mbps connection takes ~30 minutes to push 1GB - their session expires mid-upload and the request returns 401. The client at `web/src/services/upload.ts:90-92,120-123` does `await res.json()` on the error path, which throws when CloudFront returns the HTML login redirect, masking the actual cause. Either chunk uploads, refresh the cookie on long requests, or warn the user.

### 12. `req.query` casts to `string` without runtime check

Many handlers do `req.query.date_from as string` (`api/src/routes/standups.ts:178`), `req.query.q as string` (`api/src/routes/search.ts:19`), `req.query.sort as string` (`api/src/routes/projects.ts:316`). Express returns arrays for repeated params (`?date_from=a&date_from=b`). When the value is `['a','b']`, passing it to `pool.query` as `$3` makes pg serialize it as `{a,b}` which fails the date comparison and returns a 500 with an unhelpful `invalid input syntax for type date: "{a,b}"` log entry. Trivial DoS vector and a noisy 500 source. The Zod schemas only run on request bodies, never on query strings.

### 13. No PostgreSQL error-code branching

Searched for `23505` / `23503` / `23502` / `unique_violation` - zero hits in `api/src/`. A unique-constraint violation (e.g., trying to invite the same email twice, or two clients racing to create the same document with the same `ticket_number`) surfaces to the client as a generic 500. The advisory locks in `api/src/routes/documents.ts:811-813,1239-1241` reduce the race window but don't eliminate it.

### 14. Editor uses `react-router` route definitions but no `errorElement`

`web/src/main.tsx:158-247` uses the v6 `<Routes>` API exclusively. There is no `errorElement` on any route, and `react-router-dom` doesn't propagate render errors to the router-level handler when you use this API. Pair with the missing root `ErrorBoundary` and a render error anywhere up the provider tree -> blank screen with the error only in console.

### 15. CSRF token failure path can recurse indefinitely

`web/src/lib/api.ts:101-114`: if the first request returns 403/JSON (CSRF error), `clearCsrfToken()` then `ensureCsrfToken()` then retry. If the retry *also* returns 403/JSON, the function returns it - but `request<T>` at line 208-221 starts its own retry, calling `ensureCsrfToken()` again. There's no max-retry guard. If the server is misconfigured so CSRF always fails, the client makes two requests per attempt and never gives up. Not directly user-visible today, but worth a counter.

### 16. `pgsql` `statement_timeout: 30000` set on pool but no client-side retry on `57014` (query_canceled)

`api/src/db/client.ts:25`. When a query exceeds 30s it cancels. The route catches the error generically and returns 500. The user has no idea their request was killed by a deliberate limit rather than a real bug. Surface the 57014 specifically as a 504/408 with "request took too long, try filtering further."

## What the original overstated or mis-prioritized

- **Pre-login `/api/auth/me` 401 listed as a finding**. This is benign and listed at "Low" - fine - but it's not really a finding; it's the only way `useAuth` knows the user isn't signed in. Removing it would require a different auth probe mechanism. The audit lists it but doesn't recommend a fix, which is correct, so this is just noise.
- **"Collaboration persistence catches and logs DB write failures instead of throwing through the WebSocket path"** is technically true (`api/src/collaboration/index.ts:176-178`), but listed as Source review notes rather than a finding. It IS a finding: if `persistDocument` fails repeatedly, the user keeps typing into Yjs but nothing reaches the database. The `sync` status (`web/src/components/Editor.tsx:443`) only reflects ws-sync, not durable-persist. That's exactly the same shape of bug as Fix 2 (title) but for body content.
- **3G throttle "Loading..." finding** ranks Medium. That ranking is probably right per the audit's framing, but the actual cause (`web/src/main.tsx:96-101` and `:113-119` show `<div className="text-muted">Loading...</div>` literals) isn't a recovery problem - it's just an unspun loading state. Worth mentioning the root cause to avoid the next reviewer rediscovering it.

## Additional recommendations (in order of user-facing impact)

1. **Add `pool.on('error', ...)` in `api/src/db/client.ts`** - log and don't crash. This is one line of code that prevents one of the most common production crash modes (RDS failover, network blip).

2. **Wrap the async WebSocket connection listeners** in `api/src/collaboration/index.ts:683` and `:789` with try/catch that closes the socket with code 1011 and logs. Add `wss.on('error', ...)` and `eventsWss.on('error', ...)`.

3. **Add `app.use((err, req, res, next) => ...)` at the bottom of `api/src/app.ts`**. In production, return `{ error: 'Internal server error', requestId }`. Log the actual error with the request ID. Strip stack traces in prod responses. Without this, *any* synchronous throw from a route bypasses every per-route try/catch and goes to Express's default handler.

4. **Fix the AI route status codes** in `api/src/routes/ai.ts:42,72` - use `.status(503).json(...)` so TanStack Query treats it as a failure.

5. **Pick one error response shape and convert routes to it**. The 399 short-form `{ error: 'message' }` responses don't match `web/src/lib/api.ts:5-12 ApiResponse`. The toast in `web/src/components/MutationErrorToast.tsx` currently shows generic messages because of this mismatch. Either change the client to handle both shapes or migrate routes.

6. **Reuse `ToastProvider` instead of native `alert()`** in `web/src/components/Editor.tsx:404,418,423`. Block focus, not the page.

7. **Add exponential backoff with jitter** in `web/src/hooks/useRealtimeEvents.tsx:107-110` and listen for HTTP 429 specifically. Today's 3-second fixed reconnect is the exact thing the IP rate limiter is meant to prevent and the client retries straight into it.

8. **Surface `useAutoSave` save state** (the original's Fix 2 implementation note). After the third retry, return `{ status: 'failed', error }` to the caller so the UI can render a persistent failed-save banner. While you're there, also surface the *Yjs persist* failure - body-save fail is invisible the same way title-save fail is.

9. **Validate `req.query` with Zod at every route that touches it**. The pattern `const { date_from, date_to } = z.object({ ... }).parse(req.query)` is already used for bodies; copy it to queries. Today, repeated query params silently produce 500s.

10. **Add an `errorElement` route or wrap the entire `<App />` in a top-level `ErrorBoundary`** in `web/src/main.tsx:251-268`. The current single boundary at `App.tsx:542` does not cover provider-tree errors.

11. **Add request IDs**: a one-line middleware `(req, _res, next) => { req.id = randomUUID(); next(); }` plus include `req.id` in every `console.error`. Without correlation, prod CloudWatch logs are write-only.

12. **Set per-request fetch timeouts** in `web/src/lib/api.ts`. 20-30s is fine. Without these, a hung backend causes UI to wedge with no recovery.

13. **Catch `57014` (query_canceled)** in routes that touch large data sets (search, dashboard aggregates). Return 408/504 with explicit "took too long" text.

14. **Catch `23505` (unique_violation)** specifically in invite, workspace-member, and document-create routes. Return 409 Conflict with a meaningful message.

15. **Remove the multi-branch `req.body` introspection** in `api/src/routes/files.ts:172-191`. `express.raw()` is deterministic; trust it and `res.status(415)` if it isn't a Buffer.

16. **Decide what 1GB uploads + 15-min sessions means**. Either chunk uploads (S3 multipart from the browser), or sliding-refresh the session during long requests, or cap upload size below what fits in a 15-minute session at typical bandwidth.
