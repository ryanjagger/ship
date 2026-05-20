# Railway Deployment Plan — Ship (demo/staging)

## Context

Ship currently deploys to AWS Elastic Beanstalk (backend Docker) + S3/CloudFront (web static). We want a **demo/staging environment on Railway** to share a working URL without AWS. Decisions:

- **Goal:** demo/staging (not prod replacement)
- **Topology:** two Railway services with two Railway-generated domains — `api-*.up.railway.app` and `web-*.up.railway.app`
- **File storage:** Railway object storage bucket (S3-compatible, reuses existing AWS SDK code)
- **Auth:** local username/password only — skip CAIA OAuth entirely

Out of scope: custom domains, sticky sessions / horizontal scaling, CAIA, AWS SSM, CloudFront-specific code paths.

## Architecture

```
Railway project: ship-demo
  ├── Postgres (managed)                   — DATABASE_URL injected
  ├── Bucket: ship-uploads                  — S3-compatible, presigned URLs
  ├── Service: api    (Node/Express + WS)   — Dockerfile.railway, /health
  └── Service: web    (Nginx static)        — Dockerfile.web.railway, serves web/dist
```

Single replica per service. WebSocket runs on the same HTTP port as Express, which Railway supports natively (no extra config). In-memory Yjs state is fine at one replica; `pendingSaves` debounce flushes to Postgres every 2s (`api/src/collaboration/index.ts:185`).

## Critical files to modify

### 1. New `Dockerfile.railway` (API) — builds in-container
The existing root `Dockerfile:21-23` expects `shared/dist/` and `api/dist/` pre-built by `scripts/deploy.sh`. Railway builds from the repo, so we need a multi-stage Dockerfile that runs `pnpm build:shared && pnpm build:api` inside the image.

Mirror the existing structure but:
- Use `node:20-slim` from Docker Hub (no ECR-public needed off-VPN)
- Stage 1: install all deps + build (`pnpm install --frozen-lockfile`, then `pnpm build:api`)
- Stage 2: copy `node_modules`, `shared/dist`, `api/dist`, package.json files
- `EXPOSE 8080`, drop the hardcoded `ENV PORT=80` — let Railway inject `PORT`
- `CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]` (unchanged)

### 2. New `Dockerfile.web.railway` (web) — Nginx static serve
Build `web/dist` then copy into `nginx:alpine`. Single `nginx.conf` with SPA fallback (`try_files $uri /index.html`) and `listen $PORT` via envsubst at startup. Same idea as `Dockerfile.web` (`Dockerfile.web:1`) but that one runs Vite dev — we need a production static-serve image.

### 3. `web/package.json:9` + `Dockerfile.web.railway` — bake API URL into build

Currently `build:web` is `"tsc && VITE_API_URL= vite build"` (`web/package.json:9`). The inline `VITE_API_URL=` wins over any environment-injected value, so a Railway build-time variable alone would be silently overridden. Consumers across `web/src` read it as `import.meta.env.VITE_API_URL ?? ''` (`web/src/lib/api.ts:3`, `web/src/services/upload.ts:8`, `web/src/components/editor/MentionExtension.ts:9`, `web/src/components/editor/BacklinksPanel.tsx:7`, …).

Approach (keeps local same-origin behavior intact):
- Leave `web/package.json:9` alone so `pnpm build` on a dev machine continues to bundle relative paths.
- In `Dockerfile.web.railway`, declare `ARG VITE_API_URL` and run the build with that value in the env: `RUN VITE_API_URL=$VITE_API_URL pnpm --filter @ship/web exec vite build` (skip the npm script wrapper that hardcodes the empty value). Pre-build `shared` and run `tsc` in the same stage.
- In Railway, pass `VITE_API_URL` as a service variable on the web service and forward it via `--build-arg VITE_API_URL=$VITE_API_URL` in the Dockerfile build (Railway exposes service variables to Docker builds when referenced via `ARG`).
- Confirm WebSocket URL is derived from the same base (swap `https://` → `wss://`) — if not, add a small helper in `web/src/lib/api.ts`.

### 4. Cookie SameSite — relax at **all four** call sites (not just `app.ts:154`)

`sameSite: 'strict'` blocks cookies from `web-*.up.railway.app` → `api-*.up.railway.app`. The earlier draft of this plan only touched the express-session cookie at `app.ts:154`, but that cookie is used for CSRF token storage — the actual auth cookie is `session_id`, set and read in four places. All four must be updated together:

| Site | File:line | Purpose |
|------|-----------|---------|
| express-session (CSRF) | `api/src/app.ts:147-157` | session middleware cookie |
| login | `api/src/routes/auth.ts:185-191` | first issue of `session_id` |
| extend-session | `api/src/routes/auth.ts:364-370` | sliding refresh on `/api/auth/extend-session` |
| sliding-expiration | `api/src/middleware/auth.ts:214` | rewrites `session_id` on every authed request |
| WebSocket auth (read) | `api/src/collaboration/index.ts:352` | no change needed, just verify the relaxed cookie still reaches the WS handshake |

Recommended: introduce a shared `SESSION_COOKIE_OPTIONS` constant (e.g. in `api/src/middleware/auth.ts`) so the four set-sites can't drift again:

```ts
// COOKIE_SAMESITE defaults to 'strict' so AWS prod and local dev keep the tight setting.
// Railway sets COOKIE_SAMESITE=none for cross-domain web ↔ api auth.
const sameSite = (process.env.COOKIE_SAMESITE ?? 'strict') as 'strict' | 'lax' | 'none';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite,
  maxAge: SESSION_TIMEOUT_MS,
  path: '/',
};
```

Keying off an explicit `COOKIE_SAMESITE` env var (not `NODE_ENV`) avoids weakening AWS prod by accident — if AWS prod is same-origin it should stay `strict`; if it's also cross-domain that's a separate diagnosis. `SameSite=None` requires `Secure`, which Railway HTTPS satisfies. Also check any `res.clearCookie('session_id', …)` on logout — Set-Cookie deletes must use matching `sameSite`/`secure`/`path` or the browser ignores them and the cookie sticks.

Also remove or guard the CloudFront `Via`-header trust shim (`api/src/app.ts:100-107`) — harmless on Railway but confusing.

### 5. `api/src/routes/files.ts:33` — point S3 client at Railway bucket

The S3Client currently uses default AWS endpoints. Railway buckets are S3-compatible — set endpoint + credentials, and let the URL style be driven by an explicit env var (new Railway buckets use virtual-hosted-style by default; only some legacy buckets need path-style):

```js
new S3Client({
  region: AWS_REGION,
  endpoint: process.env.S3_ENDPOINT_URL,        // Railway provides
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: process.env.S3_ACCESS_KEY_ID ? {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  } : undefined,
});
```

Default `S3_FORCE_PATH_STYLE=false` on Railway and flip to `true` only if Railway's bucket UI says the bucket needs it. When Railway bucket vars are absent (local dev), the client falls back to current behavior. Verify presigned URL generation works against the Railway endpoint (it should — `@aws-sdk/s3-request-presigner` is endpoint-agnostic).

### 6. `api/src/routes/files.ts:253` + new GET path — private-bucket download path

Production confirm at `files.ts:253-257` writes `cdn_url = https://${CDN_DOMAIN}/${file.s3_key}` and **requires** `CDN_DOMAIN` (line 254). The only presigner in the file is `PutObjectCommand` at line 412. Railway buckets are private, so this static URL would 403 even if it pointed at the bucket public host.

Two options; pick the proxy for a demo (simpler, preserves auth, mirrors the existing `/serve` route):

- **Proxy (recommended):** widen `GET /api/files/:id/serve` (`files.ts:282`) to also handle production by streaming `GetObjectCommand({ Bucket, Key }).Body` to the response. Keeps the existing `authMiddleware`, keeps `cdn_url = /api/files/${fileId}/serve` for both envs.
- **Presigned GET redirect:** new route returns 302 to `getSignedUrl(client, new GetObjectCommand({...}), { expiresIn: 900 })`. Lower egress on the api service; harder to revoke mid-flight.

Either way:
- Drop the `CDN_DOMAIN` requirement at `files.ts:254`.
- Remove `CDN_DOMAIN` from the SSM `Promise.all` at `api/src/config/ssm.ts:48` (or make it optional) — it's an AWS-only assumption.
- Add `GetObjectCommand` to the imports at `files.ts:10` if going with the proxy/presigned-GET option.

### 7. `api/src/config/ssm.ts:38` — skip SSM when the platform already injects config

Startup at `api/src/index.ts:15` runs `loadProductionSecrets()` whenever `NODE_ENV === 'production'`, and the loader unconditionally hits AWS SSM (`ssm.ts:48-54`). On Railway with no AWS creds, this fails fast.

Add an early-return inside `loadProductionSecrets()` that checks whether the platform has already injected config. Cleanest test: presence of `DATABASE_URL` (Railway sets it via reference variable; AWS EB does not — it relies on SSM to populate it). No new env var needed, no change on the AWS side:

```ts
export async function loadProductionSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.DATABASE_URL) return;   // Railway / any platform-injected config
  // … existing SSM Promise.all
}
```

Keep `NODE_ENV=production` on Railway (drives cookie `secure`/`sameSite` and SSL on the pg Pool at `migrate.ts:32` / `seed.ts:44`).

### 8. Seed step — local accounts for demo login
Since CAIA is off, users need seeded local accounts. Add a Railway **pre-deploy command** on the api service: `node dist/db/migrate.js && node dist/db/seed.js` (verify `api/src/db/seed.ts` exists and is included in dist — `api/package.json` build script copies `migrations/` but may not include seed; check before relying on it). Document the demo login credentials in the deploy notes.

## Railway provisioning steps (executed via MCP)

1. `mcp__railway__create_project` → `ship-demo`
2. `mcp__railway__deploy_template` with `template_code: postgres` → managed Postgres, exposes `DATABASE_URL` via reference variable
3. `mcp__railway__create_bucket` → `ship-uploads` (region `sjc`); capture bucket name + endpoint + access keys
4. **Apply bucket CORS** for browser uploads (mirrors `terraform/modules/cloudfront-s3/main.tf:423-433`). Railway MCP does not expose a CORS tool, so use aws-cli against the Railway endpoint with the **bucket** creds from step 3 — inlined so it doesn't fall back to the developer's IAM creds via the default credential chain:
   ```sh
   AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" \
   AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
   aws s3api put-bucket-cors \
     --bucket "$S3_UPLOADS_BUCKET" \
     --endpoint-url "$S3_ENDPOINT_URL" \
     --cors-configuration '{
       "CORSRules": [{
         "AllowedHeaders": ["*"],
         "AllowedMethods": ["PUT", "POST"],
         "AllowedOrigins": ["https://web-*.up.railway.app"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }]
     }'
   ```
   Tighten `AllowedOrigins` to the actual generated web domain once step 7 captures it (re-run this command).
5. `mcp__railway__create_service` (api) — connect repo via `source_repo: "ryan/ship"` (or deploy from local tarball via `mcp__railway__deploy`). `create_service` only accepts `name` / `source_repo` / `source_image` / `environment_id` / `project_id`; *all* build, health-check, and restart settings go on `update_service` in the next step.
6. `mcp__railway__update_service` (api) — apply the service settings `create_service` won't take:
   - `dockerfile_path: "Dockerfile.railway"`
   - `health_check_path: "/health"`, `healthcheck_timeout: 30000`
   - `restart_policy_type: "ON_FAILURE"`, `restart_policy_max_retries: 3`
7. `mcp__railway__create_service` (web) — `source_repo: "ryan/ship"` only.
8. `mcp__railway__update_service` (web) — `dockerfile_path: "Dockerfile.web.railway"`.
9. `mcp__railway__generate_domain` on each service → capture `api-*.up.railway.app` and `web-*.up.railway.app`.
10. `mcp__railway__set_variables` (api) **with `skip_deploys: true`** (avoid a redeploy now; we'll trigger one explicitly after step 12):
    - `DATABASE_URL` ← `${{Postgres.DATABASE_URL}}` reference (presence of this triggers the SSM skip in section #7)
    - `SESSION_SECRET` ← random 64-char hex
    - `CORS_ORIGIN` ← `https://web-*.up.railway.app`
    - `APP_BASE_URL` ← same
    - `NODE_ENV=production`
    - `COOKIE_SAMESITE=none` (enables cross-domain auth per section #4; AWS prod intentionally leaves this unset to keep `strict`)
    - `S3_UPLOADS_BUCKET`, `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` ← Railway bucket
    - `S3_FORCE_PATH_STYLE` — omit (defaults to `false`); set to `true` only if Railway's bucket panel says the bucket requires path-style addressing
    - `AWS_REGION=us-east-1` (placeholder; SDK needs *something*)
    - Do **not** set `CDN_DOMAIN` — downloads go through the proxy/presigned-GET path from section #6
    - Explicitly unset/omit CAIA vars
11. `mcp__railway__set_variables` (web) **with `skip_deploys: true`**:
    - `VITE_API_URL` ← `https://api-*.up.railway.app` — Railway exposes service variables to Docker builds via `ARG VITE_API_URL` in `Dockerfile.web.railway` (see section #3). Variable must be set *before* the web service's first build, or the bundle will bake in an empty string.
12. `mcp__railway__update_service` (api): set `pre_deploy_command: ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js"]`. Seed is mandatory — CAIA is off, so without it the demo has no login. (If `dist/db/seed.js` turns out to be missing per section #8, fall back to `["node dist/db/migrate.js"]` and run seed once via `railway run`.)
13. Trigger deploys (`mcp__railway__deploy` on each service); tail `mcp__railway__get_logs` until both are healthy.

**Bootstrap order matters:** api domain must exist before building web (web bakes the API URL into the bundle). Likewise web domain must exist before setting api `CORS_ORIGIN` *and* the bucket CORS allow-list. Solution: generate domains (step 9) on both services *before* triggering builds (step 13); use `skip_deploys: true` on the `set_variables` calls (steps 10–11) so they don't kick a deploy with stale config; re-run the bucket CORS command from step 4 once the real web domain is known.

## Verification (end-to-end)

1. `curl https://api-*.up.railway.app/health` → `{"status":"ok"}`
2. Open `https://web-*.up.railway.app/` in a browser — app loads, no console errors
3. Log in with a seeded local account — session cookie set, dashboard loads
4. Create a new wiki document — title saves, content persists across reload (confirms Postgres write)
5. Open the same doc in two browser windows — typing in one shows live cursor in the other (confirms WebSocket + Yjs)
6. Upload an attachment — browser PUT must succeed (validates bucket CORS); then re-open the doc and verify the attachment renders (validates the new proxy/presigned-GET download path against the private bucket)
7. WebSocket: from devtools Network → WS, confirm the `/collaboration/...` handshake includes the `session_id` cookie and stays open (validates `SameSite=None` propagation to WS)
8. `mcp__railway__service_metrics` — check CPU/memory baseline for sanity

## Known risks / open items

- **WebSocket URL derivation** — confirm `web/src` derives the WS URL from `VITE_API_URL` (swap `https://` → `wss://`); if a component hardcodes same-origin, add a small helper in `web/src/lib/api.ts`.
- **CSRF** — `csrf-sync` uses the express-session cookie; with `SameSite=None; Secure` it should still flow cross-domain. Test the login flow specifically (CSRF token fetch → login POST → first authed GET).
- **Build context size** — `pnpm install` in the api Dockerfile pulls dev deps too in a multi-stage build. Acceptable for demo; revisit if image size becomes a problem.
- **Seed data** — verify `db:seed` exists in dist before relying on it; if not, run a one-shot via `railway run` after first deploy.
- **Download path performance** — the recommended proxy in section #6 doubles egress (S3 → api → browser). Fine for demo traffic; if it becomes a bottleneck, swap to the presigned-GET 302 redirect variant described in the same section.
- **`S3_FORCE_PATH_STYLE` default** — set to `false`. If presigned PUT works but the response from Railway is "no such bucket", the bucket likely needs path-style — flip the var and redeploy.
