# Manual Security Review


## Scope

- Auth/session handling: are sessions, cookies, OAuth flows, CSRF, and authorization checks handled safely?
- WebSocket validation: are collaboration connections authenticated, authorized, origin-checked, and bounded?
- Input sanitization: are untrusted inputs validated before storage, rendering, SQL, file handling, and redirects?
- CORS and CSP configuration: are cross-origin requests properly restricted?
- Environment variable and secret handling: are secrets ever exposed to the client bundle or logged?
- Rate limiting: can a single client hammer the API or WebSocket endpoint without restriction?
- Error message verbosity: do error responses leak stack traces, SQL, or internal paths?

## Audit Baseline

| Metric | Baseline (Pre Implementation) | Baseline (Post Implementation) |
| --- | --- | --- |
| Security probe tool | None | Yes — `probe/` workspace with `pnpm probe` runs 7 probe groups (preflight, auth, websocket, dependencies, inputs, headers, rate-limit). Produces JSON + Markdown reports under `probe/results/`. Anonymous run shape: 25 checks, 10 pass, 5 findings, 10 not-tested (require `--allow-mutation` or a working seed login). |
| Auth/session vulnerabilities found | Medium: WebSocket sessions are validated only during upgrade, so an already-open collaboration socket can outlive HTTP session expiry or later workspace access revocation. Medium: CAIA logs OAuth code prefix and state. Low/Medium: password login distinguishes PIV-only accounts, which can disclose account auth mode for known emails. | Unchanged at the code level. Post-upgrade revalidation, CAIA code/state logging (`api/src/services/caia.ts:221-222`), and PIV-account enumeration on password login are all still present. Probe additionally surfaces a high-severity preflight finding (`preflight.credentials.login`) because the configured local creds couldn't authenticate — that's an environment/login-limiter side effect, not a regression, but it gates the deeper authenticated checks. |
| WebSocket validation failures | Medium: no `Origin` validation on upgrade. Medium: no per-message session/access revalidation. Medium: no explicit `maxPayload` cap. Medium: rate limiting is in-memory and extracts client IP from the leftmost `x-forwarded-for` entry (attacker-controlled). | Partially fixed. **Fixed:** explicit `maxPayload: 10 MB` is now set on both `WebSocketServer` instances and enforced as a defense-in-depth check in `ws.on('message')` (`api/src/collaboration/index.ts:647-651,769-774`); progressive rate-limit-violation penalties added (`:36-37,782-799`). **Still present:** no `Origin` validation on upgrade (`:653-728`); session/workspace/document-access still validated only at upgrade (no per-message recheck); IP still extracted from leftmost `x-forwarded-for` (`:659-661,693-695`). Probe confirms `/events` and `/collaboration/*` correctly reject unauthenticated upgrades (401). |
| Input sanitization failures | Medium: uploads use an extension blocklist and allow active formats such as SVG, then serve files inline with stored MIME type. Low: filenames are reflected in `Content-Disposition` without application-level header-safe normalization. No SQL injection failure found in reviewed paths; parameterized queries, Zod schemas, LIKE escaping, and sort allowlists are used in key routes. | Unchanged. `BLOCKED_EXTENSIONS` is still a blocklist (`api/src/routes/files.ts:63-83`); SVG and other active types remain allowed; local download still issues `Content-Disposition: inline` with the stored filename (`:310`). Authenticated input fuzzing was `not-tested` by the probe (gated on login). |
| High/Critical CVEs in dependencies | Not verified. `pnpm audit --prod --audit-level high` failed with `fetch failed` under restricted network. Count/list unavailable without an external advisory lookup. | Verified via the new dependency probe. `pnpm audit --json` returns **32 high/critical advisories** (2 critical, 30 high; 39 medium, 4 low). Criticals: `protobufjs <7.5.5` (RCE, transitive via testcontainers→dockerode) and `fast-xml-parser <5.3.5` (entity-encoding bypass, transitive via `@aws-sdk/client-bedrock-runtime`). Other notable highs touching the API path: `path-to-regexp` (express + MCP SDK), `express-rate-limit` IPv4-mapped IPv6 bypass, `@hono/node-server`, `hono`, `fast-uri`, `vite` dev-server file read, `rollup`, `svgo`, `lodash`, `picomatch`, `flatted`, `undici`. Full list in `probe/results/security-report.md` under `dependencies.audit.high_critical`. |
| CORS/CSP misconfiguration | Yes. REST CORS is restricted to configured `CORS_ORIGIN`, but the static frontend has no CloudFront CSP response header, API CSP is broad (allows `'unsafe-inline'` scripts and all `ws:`/`wss:`), WebSocket upgrades do not validate `Origin`, `apiLimiter` is mounted before `cors()` so 429s ship without CORS headers, `crossOriginResourcePolicy: 'cross-origin'` is applied globally, and the custom CSP directives object should be verified to still emit `frame-ancestors`. | Unchanged. API CSP still includes `script-src 'self' 'unsafe-inline'` and `connect-src 'self' wss: ws:` (`api/src/app.ts:117,120`); probe captures this as `headers.security_headers.baseline` finding (`unsafeInlineScript` on `/health`). `apiLimiter` is still mounted before `cors()` (`:137-138`). `crossOriginResourcePolicy: 'cross-origin'` is still global (`:112`; observed on `/health`). CloudFront still has no response-headers policy or CSP (`grep -rn response_headers_policy terraform/` returns nothing). One incidental improvement: Helmet's default does emit `frame-ancestors 'self'` despite the custom directives map, so #3 is no longer ambiguous (but `'none'` would still be tighter). `headers.cors.hostile_origin` probe passes — hostile Origin is rejected. |
| Secrets exposure risk | **High**. No evidence that server secrets are bundled into the Vite client. However: (a) `caia.ts:272` `JSON.stringify(error, Object.getOwnPropertyNames(error), 2)` on token-exchange failure can serialize the outbound `Authorization` header containing the CAIA `client_secret`; (b) `SESSION_SECRET` falls back to a hard-coded dev value for any non-`production` `NODE_ENV` (unset, blank, `staging`, typos); (c) OAuth code prefix/state and credential URLs/client IDs are logged in several CAIA paths. | Unchanged. (a) `JSON.stringify(error, Object.getOwnPropertyNames(error), 2)` still runs in the token-exchange catch block (`api/src/services/caia.ts:272`). (b) `SESSION_SECRET` still falls back to `'dev-only-secret-do-not-use-in-production'` for any non-`production` `NODE_ENV` (`api/src/app.ts:40-44`). (c) Code prefix and state are still logged (`api/src/services/caia.ts:221-222`); admin-credential validation still echoes issuer URL, client ID, and error name/code/cause. `secrets.live_http` probe passes (common secret paths like `/.env`, `/.aws/credentials`, `*.js.map` all 404, no exposed indicators). |
| Rate limiting absent on endpoints | Yes, multiple gaps. `POST /api/feedback` is public, unauthenticated, no CSRF, and protected only by the 100/min general limiter — trivial spam/storage exhaustion. `loginLimiter` is IP-only, so distributed credential stuffing is unmitigated. No upload count/size quota on `/api/files`. `trust proxy 1` likely under-counts CloudFront→ELB→EB hops, making `req.ip` spoofable and bypassing every IP-keyed limiter. `/health` is not rate-limited. WebSocket limits are per process/per connection. No shared store; per-instance limits effectively multiply by instance count. | Unchanged. No dedicated limiter on `publicFeedbackRouter` (`api/src/routes/feedback.ts:9,53`); `loginLimiter` still IP-only (`api/src/app.ts:71-78`); no upload count/size quota on `/api/files`; `trust proxy 1` still in production (`:95`); no shared `rate-limit-redis`/`MemoryStore` in `api/src/`. Probe confirms the limiter is responsive: `rate_limit.auth_login` shows `429` with `RateLimit-Policy: 5;w=900` after configured-credential burst; `/api/csrf-token` reports `1000;w=60` (dev). Findings #5, #14, #15, #16, #17, #18, #19 from the original review remain. |
| Verbose error leakage | Yes. **No global Express error handler is registered**, so any uncaught throw past a route handler hits Express's default `finalhandler` and returns the stack as HTML. CAIA/admin credential flows return or redirect raw `error.message` values to clients (including `fetch` failure details that can reveal internal hostnames/ports/TLS subjects). Audit-event payloads embed raw error strings and secret paths. | Unchanged. `grep -rn 'app.use((err\\|ErrorRequestHandler\\|asyncHandler' api/src/` still returns no matches — no terminal 4-arg middleware and no async wrapper. `admin-credentials.ts` still returns `Failed to save credentials: ${errorMessage}` (`:580`), `CAIA connection failed: ${errorMessage}` (`:634`), and redirects raw error strings (`:679`). Audit-event payloads still embed `{ error: errorMessage, secretPath: getCAIASecretPath() }` (`:566-575`). Probe's `headers.verbose_errors` check was `not-tested` (gated on login). |

## Findings

### Frontend / CSP / CORS

1. **Frontend CSP is missing from the deployed static app path.**

   Helmet CSP is only applied by Express in `api/src/app.ts:105`, while the React app is served by CloudFront/S3 via the default cache behavior in `terraform/modules/cloudfront-s3/main.tf:178`. No `aws_cloudfront_response_headers_policy` or CSP header policy was found.

2. **CSP is too permissive where it does exist.**

   `scriptSrc` allows `'unsafe-inline'`, and `connectSrc` allows all `ws:` and `wss:` targets in `api/src/app.ts:111`. `'unsafe-inline'` defeats most reflected-XSS protections across the entire API surface just to support a few inline scripts on the admin credentials HTML page. Convert those inline scripts to nonces (Helmet supports per-request nonces), remove `'unsafe-inline'` globally, and replace broad `ws:`/`wss:` with explicit deployed origins.

3. **Custom CSP directives may have dropped `frame-ancestors`.**

   `api/src/app.ts:108` supplies a `directives` map without `frameAncestors`. Verify via `curl -I` on a deployed response that `frame-ancestors 'none'` is still present; otherwise clickjacking on `/api/admin/credentials` HTML is open.

4. **`crossOriginResourcePolicy: 'cross-origin'` is global.**

   `api/src/app.ts:106` weakens CORP for every response just to permit cross-origin image embedding. Scope to the file-serving routes (`/api/files/*`) so JSON API responses retain `same-origin` CORP.

5. **Middleware order: `apiLimiter` is mounted before `cors()`.**

   `api/src/app.ts:131-135`. When the API limit trips, the 429 lacks `Access-Control-Allow-Origin`, so browsers report a misleading CORS error and the client never sees the 429. Move `cors()` above `apiLimiter`.

### WebSocket

6. **WebSocket cross-origin protection relies on cookies/session checks, not `Origin` validation.**

   The upgrade handler checks path, rate limit, session, and document access in `api/src/collaboration/index.ts:601`, but does not compare `request.headers.origin` against the allowed app origin. SameSite strict cookies reduce exploitability, but this should still be enforced server-side.

7. **WebSocket connections are not revalidated after connection.**

   `validateWebSocketSession()` checks the session at upgrade time and updates `last_activity`, but `ws.on('message')` only applies message rate limiting before processing Yjs messages in `api/src/collaboration/index.ts:669`. There is no later session expiry, workspace membership, or document access recheck for a long-lived socket.

8. **WebSocket IP extraction trusts the leftmost `X-Forwarded-For`.**

   `api/src/collaboration/index.ts:611-613` splits `x-forwarded-for` and takes `[0]` — the client-supplied value, not the closest-trusted hop. Combined with finding #15, every WS rate-limit key is spoofable.

9. **No explicit WebSocket `maxPayload` cap.**

   The `WebSocketServer` is constructed without `maxPayload`. Combined with the missing per-message revalidation in #7, a long-lived authed connection can send arbitrarily large frames.

### Secrets / environment

10. **`caia.ts:272` can leak the CAIA `client_secret`.** **(High)**

    `console.error('[CAIA]   Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))` runs in the token-exchange catch block. `oauth4webapi` error subclasses attach `response`/`request` properties; depending on the failure path, the serialized request can include the outbound `Authorization: Basic <base64(client_id:client_secret)>` header. Replace with a redacted log: name, message, status, and OAuth `error`/`error_description` only.

11. **`SESSION_SECRET` guard fails open outside `NODE_ENV=production`.**

    `api/src/app.ts:35-39`:
    ```ts
    if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
      throw new Error(...);
    }
    const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production';
    ```
    Any non-`production` value (unset, empty, `staging`, `qa`, typo) silently uses the hard-coded fallback. Cookie signing and CSRF token storage become forgeable. Invert the check: require `SESSION_SECRET` unless `NODE_ENV` is explicitly `development` or `test`.

12. **OAuth/credential metadata is logged.**

    OAuth callback logs code prefix and state in `api/src/services/caia.ts:220`. Validation flow at `api/src/routes/admin-credentials.ts:502-524` echoes issuer URL, client ID, and full error name/code/cause to stdout. Client IDs are credential material in OIDC and shouldn't land in CloudWatch.

13. **No client bundle secret exposure was found.**

    Vite only loads `VITE_` env vars in `web/vite.config.ts:24`, production build clears `VITE_API_URL` in `web/package.json:9`, server secrets are loaded from SSM/Secrets Manager in `api/src/config/ssm.ts:48`, and no `process.env.*` references appear in `web/src/` outside the `VITE_` namespace.

### Rate limiting

14. **`POST /api/feedback` is the largest unprotected write surface.** **(High)**

    `api/src/app.ts:170` mounts `publicFeedbackRouter` before any auth/CSRF middleware. The endpoint accepts anonymous POSTs that insert into `documents` and is protected only by the 100/min general limiter. An attacker can fill the table at 100 rows/minute/IP, vastly more across a botnet. Add a dedicated low-rate limiter (e.g. 5/hour/IP) plus a CAPTCHA/Turnstile gate.

15. **`trust proxy 1` likely under-counts hops; every IP-keyed limiter is spoofable.**

    `api/src/app.ts:89`. In a CloudFront → ELB → EB topology, requests typically traverse two trusted hops before reaching Express. `trust proxy 1` makes Express trust only the rightmost XFF entry, so an attacker can prepend arbitrary IPs in `X-Forwarded-For` and rotate `req.ip` per request. This silently breaks `apiLimiter`, `loginLimiter`, and the WebSocket connection limiter. Use explicit CloudFront/ELB CIDR ranges or a numeric hop count matching the real topology.

16. **`loginLimiter` is IP-only; per-account brute force is unrestricted.**

    `api/src/app.ts:65-72` keys by IP. Distributed credential-stuffing against a single account is unmitigated. Add a second limiter keyed by submitted `email` (e.g. 10 failures / 15 min / account).

17. **No upload count/size limit on `/api/files`.**

    POSTs inherit only the 100/min general limiter. Combined with the broad upload allowlist (#19), an authed user can fill the bucket. Add per-user upload quotas (e.g. N MB/day) enforced before S3 PUT.

18. **CSRF-token GET is itself rate-limited.**

    `api/src/app.ts:154` is registered after `app.use('/api/', apiLimiter)`, so a rate-limited user cannot fetch a CSRF token to recover. Move above the limiter or exempt via `skip`.

19. **No process-shared rate-limit store.**

    On EB with `N` instances, every limit is effectively `N × configured`. Move to `rate-limit-redis` or push baseline limits to WAF and keep app-level limits for fine-grained per-route policy.

### Input sanitization

20. **File upload sanitization allows active content classes.**

    Upload validation uses a dangerous-extension blocklist in `api/src/routes/files.ts:40` and allows any non-blocked extension. The client MIME fallback includes `.svg` as `image/svg+xml` in `web/src/services/upload.ts:196`, and local file serving reflects the stored MIME type and serves inline in `api/src/routes/files.ts:282`. This is a stored active-content risk, especially without a strong frontend CSP.

### Error verbosity

21. **No global Express error handler is registered.** **(High)**

    Grepped `api/src/**/*.ts` for `app.use((err`/`ErrorRequestHandler`/4-arg middleware — none found. Any uncaught synchronous throw or unhandled async rejection past a route handler falls through to Express's built-in `finalhandler`, which returns `Error.stack` as `text/html` when `NODE_ENV !== 'production'` and can leak `err.message` even in production. The "generic 500s" elsewhere only hold for routes that wrap their handlers in try/catch.

    Add a terminal middleware after all routes:
    ```ts
    app.use((err, req, res, _next) => {
      const correlationId = crypto.randomUUID();
      console.error(`[${correlationId}]`, err);
      res.status(500).json({ error: 'Internal server error', correlationId });
    });
    ```
    Wrap async route handlers with an `asyncHandler` helper so rejections actually reach this middleware.

22. **CAIA / admin credential endpoints echo raw error messages back to clients.**

    `api/src/routes/admin-credentials.ts:578` returns `Failed to save credentials: ${errorMessage}`. `api/src/routes/admin-credentials.ts:622-636` returns `CAIA connection failed: ${errorMessage}`. `api/src/routes/caia-auth.ts:310` redirects raw callback errors to `/login`. `oauth4webapi`/`undici` errors can include internal hostnames, port numbers, TLS cert subjects, and DNS resolution paths. Replace with `{ error, correlationId }` and keep details server-side.

23. **Audit-event payloads embed raw error strings and secret paths.**

    `api/src/routes/admin-credentials.ts:570-575` writes `{ error: errorMessage, secretPath: getCAIASecretPath() }` into the audit log. If audit-read endpoints return the `details` blob to less-privileged admins (verify), this becomes a secondary leak surface.

### Dependencies

24. **Dependency CVEs were not verified in this run.**

    `pnpm audit --prod --audit-level high` was attempted, but failed with `fetch failed` because advisory lookup requires network access. No high/critical count should be claimed until an approved dependency audit or equivalent advisory scan is run.

## Evidence Notes

- REST CORS is configured with a single `corsOrigin` value and credentials enabled in `api/src/app.ts:132`.
- Production `CORS_ORIGIN` is loaded from SSM before `createApp()` is imported in `api/src/index.ts:15`.
- Terraform sets the SSM CORS origin to the frontend URL in `terraform/modules/ssm/main.tf:75` and `terraform/ssm.tf:68`.
- API rate limiting uses `express-rate-limit`: general API limit is 100 requests per minute, login limit is 5 failed attempts per 15 minutes in `api/src/app.ts:65` and `api/src/app.ts:75`.
- WebSocket rate limits are defined as 30 connection attempts per IP per minute and 50 messages per second per connection in `api/src/collaboration/index.ts:16`.
- Session cookies are `httpOnly`, `secure` in production, and `sameSite: 'strict'` in `api/src/app.ts:141`, `api/src/routes/auth.ts:181`, and `api/src/middleware/auth.ts:214`.
- Password sessions are generated with 256 bits of entropy in `api/src/routes/auth.ts:11`.
- Session middleware enforces a 15-minute inactivity timeout and a 12-hour absolute timeout for HTTP requests in `api/src/middleware/auth.ts:145`.
- CAIA server-side return paths only allow relative URLs in `api/src/routes/caia-auth.ts:44`; the client also validates same-origin return paths in `web/src/pages/Login.tsx:9`.
- Search routes escape SQL LIKE wildcards in `api/src/routes/search.ts:8`.
- Project sorting uses a field allowlist before interpolating `ORDER BY` clauses in `api/src/routes/projects.ts:281`.
- File ID path parameters are UUID-validated before local file serving/deletion in `api/src/routes/files.ts:18`.

## Priority Ranking

| # | Severity | Item | Location |
| --- | --- | --- | --- |
| 1 | High | `client_secret` leak via `JSON.stringify(error, ...)` on token-exchange failure | `api/src/services/caia.ts:272` |
| 2 | High | No global Express error handler → stack traces on unhandled paths | `api/src/app.ts` (missing) |
| 3 | High | Public feedback POST has no dedicated rate limit / CAPTCHA | `api/src/app.ts:170` |
| 4 | Medium | Frontend CSP missing on CloudFront/S3-served SPA | `terraform/modules/cloudfront-s3/main.tf:178` |
| 5 | Medium | CSP `scriptSrc 'unsafe-inline'` and broad `ws:`/`wss:` connectSrc | `api/src/app.ts:111` |
| 6 | Medium | WebSocket upgrade does not validate `Origin` | `api/src/collaboration/index.ts:601` |
| 7 | Medium | WebSocket session/access not revalidated post-upgrade | `api/src/collaboration/index.ts:669` |
| 8 | Medium | `trust proxy 1` enables `X-Forwarded-For` spoofing → every IP limiter bypassable | `api/src/app.ts:89` |
| 9 | Medium | No per-account login limiter (distributed credential stuffing) | `api/src/app.ts:65` |
| 10 | Medium | `SESSION_SECRET` dev fallback active for any non-`production` NODE_ENV | `api/src/app.ts:35-39` |
| 11 | Medium | Upload sanitization is a blocklist; allows SVG; served inline | `api/src/routes/files.ts:40,282` |
| 12 | Medium | CAIA test/save endpoints echo `fetch` error details to browser | `api/src/routes/admin-credentials.ts:578,622-636` |
| 13 | Medium | OAuth code/state and credential metadata logged | `api/src/services/caia.ts:220`, `api/src/routes/admin-credentials.ts:502-524` |
| 14 | Medium | No upload count/size quota per user | `api/src/routes/files.ts` |
| 15 | Medium | No shared rate-limit store; per-instance limits multiply by N | `api/src/app.ts` |
| 16 | Medium | No explicit WebSocket `maxPayload` | `api/src/collaboration/index.ts` |
| 17 | Low | `apiLimiter` mounted before `cors()` — 429s missing CORS headers | `api/src/app.ts:131-135` |
| 18 | Low | CSRF-token GET is itself rate-limited | `api/src/app.ts:154` |
| 19 | Low | `crossOriginResourcePolicy: 'cross-origin'` applied globally | `api/src/app.ts:106` |
| 20 | Low | Verify `frame-ancestors 'none'` still emitted under custom CSP directives | `api/src/app.ts:108` |
| 21 | Low | Audit-event `details` may surface raw error strings to admin readers | `api/src/routes/admin-credentials.ts:570-575` |
| 22 | Unknown | Dependency CVE scan not run (network-restricted) | `pnpm audit` |

## Recommended Fixes

1. **Add a CloudFront response headers policy with CSP** for the SPA.
2. **Add a terminal Express error middleware** that returns `{ error: 'Internal server error', correlationId }` and logs server-side. Wrap async route handlers in an `asyncHandler` helper so rejections actually reach it.
3. **Redact CAIA error logging** to `{ name, message, status, oauthError }` only; never `JSON.stringify` the whole error.
4. **Add a dedicated low-rate limiter + CAPTCHA to `POST /api/feedback`.**
5. **Invert the `SESSION_SECRET` guard**: require it unless `NODE_ENV` is explicitly `development` or `test`.
6. **Validate WebSocket `Origin`** against the configured frontend origin before `handleUpgrade`.
7. **Revalidate WebSocket session, workspace membership, and document access** periodically or before accepting mutation messages.
8. **Set an explicit WebSocket `maxPayload`** and close (rather than silently drop) repeated over-limit messages.
9. **Reconfigure `trust proxy`** with explicit CloudFront/ELB CIDR ranges or the correct numeric hop depth. Mirror the same logic in the WebSocket IP extractor.
10. **Add a per-account (email-keyed) login failure limiter** alongside the existing IP-keyed one.
11. **Add per-user upload count/size quotas** to `/api/files`. Change upload validation from a broad blocklist to a positive allowlist per feature. Serve risky types as attachments or from a sandboxed domain.
12. **Convert admin inline scripts to nonces** and remove `'unsafe-inline'` from global CSP. Replace broad `ws:`/`wss:` with explicit origins.
13. **Move `cors()` above `apiLimiter`**, and move `/api/csrf-token` above the limiter (or exempt it).
14. **Replace browser-facing CAIA/admin error strings** with `{ error, correlationId }`.
15. **Replace raw auth/admin error messages everywhere** with generic client messages plus server-side correlation IDs.
16. **Remove OAuth code/state/full-error logging**; redact PII-heavy CAIA debug logs; stop logging issuer URL and client ID on credential validation.
17. **Move API/WebSocket rate limits to a shared store** (`rate-limit-redis`) or WAF-backed layer for production.
18. **Scope `crossOriginResourcePolicy: 'cross-origin'`** to file-serving routes only; restore `same-origin` globally.
19. **Verify the deployed CSP response header includes `frame-ancestors 'none'`**; if not, add it explicitly.
20. **Strip raw error strings from audit-log `details` blobs**, or scrub them on read.
21. **Run an approved dependency advisory scan** and record the high/critical CVE count and list.
