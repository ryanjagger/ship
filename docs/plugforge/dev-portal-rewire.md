# Developer Portal Rewire: Dogfooding the Public API

The Developer Portal used to be a privileged internal client: session-authenticated
routes under `/api/developer/*` that called the platform domain services directly.
It is now an OAuth client of the public API — the same `/api/v1` contract, SDK,
scopes, rate limits, and audit trail any third-party integration uses. The domain
services did not change; only the path to them did.

## Before — direct domain calls

```
┌──────────────────────────┐
│  DeveloperPortal.tsx     │
│  (5 tabs)                │
└────────────┬─────────────┘
             │ api.developer.*          session cookie + CSRF
             ▼
┌──────────────────────────┐
│  /api/developer/*        │   api/src/routes/developer.ts (~626 lines)
│  authMiddleware          │   internal { success, data } envelope
│  workspaceAdminMiddleware│
└────────────┬─────────────┘
             │ direct function calls
             ▼
┌─────────────────────────────────────────────────────────┐
│  Platform domain services                               │
│   oauth/apps.ts          (create / list / rotate / del) │
│   oauth/connections.ts   (list / revoke)                │
│   webhooks/subscriptions.ts · webhooks/deliveries.ts    │
│   api/v1/audit/service.ts                               │
└────────────┬────────────────────────────────────────────┘
             ▼
         PostgreSQL
```

Nothing about this traffic looked like API usage: no bearer token, no scopes,
no rate limiting, no row in `public_api_audit_logs`. The portal exercised a
private side door the public contract never saw.

## After — OAuth app → SDK → public API → same domain services

```
┌──────────────────────────┐
│  DeveloperPortal.tsx     │
│  (5 tabs)                │
└────┬─────────────────┬───┘
     │ once per 15 min │ every data call
     │                 ▼
     │   ┌─────────────────────────────┐
     │   │  @ryanjagger/ship-sdk       │   client.apps / .connections /
     │   │  via usePortalClient()      │   .audit / .scopes /
     │   │  (lib/portal-client.ts:     │   .apps.webhooks / .apps.deliveries
     │   │   token cache + re-mint)    │
     │   └──────────────┬──────────────┘
     │                  │ Authorization: Bearer <token>
     ▼                  ▼
┌─────────────────┐  ┌──────────────────────────────────────┐
│ POST /api/      │  │  /api/v1/* (public contract)         │
│ developer/token │  │   bearerAuth → audit → rate limit    │
│ (session+CSRF,  │  │   requireScope(apps:manage | …)      │
│  workspace-     │  │   requireWorkspaceAdmin (runtime)    │
│  admin gated)   │  │   ApiError shape, OpenAPI-registered │
└────────┬────────┘  └────────────┬─────────────────────────┘
         │ mints 15-min token for │ same function calls as before
         │ system OAuth app       ▼
         │ client_ship_  ┌─────────────────────────────────────────────────────────┐
         │ developer_    │  Platform domain services (UNCHANGED)                   │
         │ portal        │   oauth/apps.ts · oauth/connections.ts                  │
         │ (migration    │   webhooks/subscriptions.ts · webhooks/deliveries.ts    │
         │  061)         │   api/v1/audit/service.ts                               │
         │               └────────────┬────────────────────────────────────────────┘
         │                            ▼
         └──────────────────────► PostgreSQL
```

## What flows where

| Concern | Before | After |
|---|---|---|
| Transport | internal `{ success, data }` envelope | public `ApiError` / DTO contract |
| Auth | session cookie + CSRF on every call | OAuth bearer token (`apps:manage`, `connections:manage`, `audit:read`); session only at the mint |
| Admin check | `workspaceAdminMiddleware` at the internal route | `requireWorkspaceAdmin` re-checked per request at `/api/v1` (scopes alone never grant admin) |
| Rate limits | none | per-app + per-token buckets, like any client |
| Audit | invisible | every portal call recorded in `public_api_audit_logs` (hidden from the Audit tab by default via `exclude_client_id`) |
| Client code | hand-rolled `fetch` wrappers in `web/src/lib/api.ts` | generated-contract-checked SDK clients |

## What deliberately stayed internal

```
┌──────────────────────────┐
│  /api/developer/* (slim) │   ~210 lines
│   POST /token            │   session → bearer exchange (the bootstrap)
│   GET/POST/DELETE        │   super-admin scope=all lens: cross-workspace
│   /apps?scope=all        │   by definition, no home in a workspace-scoped
└──────────────────────────┘   public token. Backs /admin?tab=oauth-apps.
```

The token mint is the one first-party shortcut (no consent screen, no refresh
token — the session is the refresh credential; the SPA re-mints on expiry).
Everything else the portal does now travels the same road a stranger's
integration would.
