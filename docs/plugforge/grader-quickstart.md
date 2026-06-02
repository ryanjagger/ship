# Ship Platform API — Quickstart (Plugforge MVP)

The public, versioned API a stranger can build on. OAuth 2.0 (Authorization Code
+ PKCE), scopes, one fully-contracted resource (`documents`), a generated
OpenAPI 3.1 spec, and a typed SDK.

> Set `SHIP_URL` to your deployment origin (e.g. `https://ship.example.com`).
> Locally that's the web origin (`http://localhost:5173`), which proxies `/api`
> to the API server.

```bash
export SHIP_URL="http://localhost:5173"
```

## 1. Read the spec

```bash
curl -s "$SHIP_URL/api/v1/openapi.json" | jq '.openapi, (.paths | keys)'
# "3.1.0"
# [ "/documents", "/documents/{id}", "/me" ]
```

A committed copy also lives at [`docs/openapi.json`](../openapi.json).

## 2. Pre-registered read-only grader app

Seeded by `pnpm --filter @ship/api db:seed:grader` (idempotent):

| Field | Value |
|-------|-------|
| Ship login | `grader@ship.local` / `GraderDemo123!` |
| `client_id` | `client_grader_readonly` |
| `client_secret` | `secret_grader_readonly_demo` |
| Scopes | `documents:read` (read-only — `POST` is expected to 403) |
| Redirect URIs | `http://localhost:5173/callback`, `https://oauth.pstmn.io/v1/callback` |

These are throwaway demo credentials; overridable via `GRADER_*` env vars.

## 3. Authorization Code + PKCE

**a) Make a PKCE verifier + challenge (S256):**

```bash
CODE_VERIFIER=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" \
  | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
STATE=$(openssl rand -hex 8)
REDIRECT_URI="http://localhost:5173/callback"
echo "verifier=$CODE_VERIFIER"
```

**b) Open the authorization URL in a browser** (the consent screen is an
authenticated Ship page — log in as the grader if prompted):

```bash
echo "$SHIP_URL/api/oauth/authorize?response_type=code\
&client_id=client_grader_readonly\
&redirect_uri=$REDIRECT_URI\
&scope=documents:read\
&state=$STATE\
&code_challenge=$CODE_CHALLENGE\
&code_challenge_method=S256"
```

Approve the consent screen. The browser is redirected to
`$REDIRECT_URI?code=<CODE>&state=$STATE`. Copy the `code`.

**c) Exchange the code for an access token** (back-channel; no browser):

```bash
CODE="<paste code here>"
curl -s -X POST "$SHIP_URL/api/oauth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"authorization_code\",\"code\":\"$CODE\",\
\"redirect_uri\":\"$REDIRECT_URI\",\"client_id\":\"client_grader_readonly\",\
\"client_secret\":\"secret_grader_readonly_demo\",\"code_verifier\":\"$CODE_VERIFIER\"}" | jq
# { "access_token": "ship_at_…", "token_type": "Bearer", "expires_in": 3600, "scope": "documents:read" }
```

A **wrong `code_verifier`** returns `400 { "error": "invalid_grant" }`.

## 4. Call the API

```bash
TOKEN="ship_at_…"

# Auth-only (no scope): typed user + current workspace
curl -s "$SHIP_URL/api/v1/me" -H "Authorization: Bearer $TOKEN" | jq

# documents:read
curl -s "$SHIP_URL/api/v1/documents" -H "Authorization: Bearer $TOKEN" | jq '.data[].document_type, .next_cursor'
curl -s "$SHIP_URL/api/v1/documents/<id>" -H "Authorization: Bearer $TOKEN" | jq

# documents:write — DENIED for the read-only token (this is expected):
curl -s -X POST "$SHIP_URL/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Nope","document_type":"wiki"}' | jq
# { "code": "forbidden", "message": "Insufficient scope: this action requires \"documents:write\".",
#   "details": { "required_scope": "documents:write", ... }, "request_id": "…" }
```

### Error shape

Every `/api/v1` failure ships the same `ApiError`:

```json
{ "code": "unauthorized | forbidden | not_found | validation_failed | rate_limited | server_error",
  "message": "…", "details": { }, "request_id": "…" }
```

`401`s carry `details.reason` (`missing_token` / `invalid_token` / `token_expired`).

## 5. SDK

```ts
import { ShipClient } from '@ryanjagger/ship-sdk';

const ship = new ShipClient({ token: process.env.SHIP_TOKEN!, baseUrl: process.env.SHIP_URL });

const me = await ship.me();                 // typed { id, name, email?, workspace }
const docs = await ship.documents.list();   // { data, next_cursor }
```

## Endpoint reference

| Endpoint | Auth | Scope |
|----------|------|-------|
| `GET /api/v1/openapi.json` | none | — |
| `GET /api/oauth/authorize` | browser (redirects to consent) | — |
| `POST /api/oauth/token` | client_id + client_secret | — |
| `GET /api/v1/me` | Bearer | none (auth-only) |
| `GET /api/v1/documents` | Bearer | `documents:read` |
| `GET /api/v1/documents/:id` | Bearer | `documents:read` |
| `POST /api/v1/documents` | Bearer | `documents:write` |
