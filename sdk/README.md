# @ryanjagger/ship-sdk

Typed SDK and command-line client for the Ship Platform API.

## Install

```bash
pnpm install @ryanjagger/ship-sdk
```

The package provides both:

- `ShipClient` for application code
- `ship` for the command line

For local installs, the binary is available through `node_modules/.bin`. The
TTFE drill prepends that directory to `PATH` before running `ship login`.

## SDK Usage

```ts
import { ShipClient } from '@ryanjagger/ship-sdk';

const client = new ShipClient({ token: process.env.SHIP_TOKEN! });
const me = await client.me();
console.log(me.workspace.name);
```

> The package name `@ship/sdk` is reserved as a future alias. Until the npm
> scope is published, install and import from `@ryanjagger/ship-sdk`.

## Authentication helpers

The SDK drives both OAuth flows end-to-end and persists the token through a
pluggable `ITokenStore` (`MemoryTokenStore`, `FileTokenStore`,
`LocalStorageTokenStore`). Stores never log raw tokens.

### Device flow (CLI / headless)

```ts
import { ShipClient, FileTokenStore } from '@ryanjagger/ship-sdk';

const client = await ShipClient.deviceLogin({
  clientId: process.env.SHIP_CLIENT_ID!,
  baseUrl: process.env.SHIP_API_URL,
  scope: 'documents:read documents:write',
  store: new FileTokenStore(),
  onUserCode: (auth) => {
    console.log(`Visit ${auth.verification_uri} and enter ${auth.user_code}`);
  },
});
```

### Authorization Code + PKCE

```ts
// Node CLI/dev — local loopback redirect:
const client = await ShipClient.authorizationCodeFlow({
  clientId, clientSecret, redirectUri: 'http://127.0.0.1:8765/callback',
  baseUrl: process.env.SHIP_API_URL, scope: 'issues:read',
  redirect: 'loopback',
});

// Browser SPA — window.location redirect + LocalStorageTokenStore (two-phase:
// call once to redirect, and again on the callback page to finish):
const client = await ShipClient.authorizationCodeFlow({
  clientId, redirectUri: `${location.origin}/callback`,
  scope: 'issues:read', redirect: 'browser', store: new LocalStorageTokenStore(),
});
```

Pass a custom `AuthCodeRedirectAdapter` as `redirect` to own the consent leg
yourself. Pass `clientSecret` only for confidential server-side clients; browser
PKCE clients should use only `clientId`.

## Paginated lists

Every cursor-paginated client exposes a lazy async iterator that hides cursor
walking — it fetches the next page only as you consume it:

```ts
for await (const issue of client.issues.iterate({ limit: 100 })) {
  console.log(issue.display_id);
}
```

`client.issues.list({ cursor })` remains available when you need page boundaries
or response metadata.

## Typed errors

Every non-2xx response throws a `ShipApiError` whose `.kind` is a stable,
exhaustively-switchable discriminator. Normalize anything (including network
failures) with `toShipSDKError`:

```ts
import { toShipSDKError } from '@ryanjagger/ship-sdk';

try {
  await client.issues.create({ title: 'Bug' });
} catch (err) {
  const e = toShipSDKError(err);
  switch (e.kind) {
    case 'auth': /* 401/403 */ break;
    case 'rate_limit': console.log(`retry after ${e.retryAfter}s`); break;
    case 'not_found': break;
    case 'validation': console.log(e.details); break;
    case 'server': break;
  }
}
```

## Rate limits

Authenticated `/api/v1` responses carry `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and `X-RateLimit-Reset`. A 429 includes `Retry-After`;
the SDK parses both into the `rate_limit` error variant above. Limits apply per
OAuth app and per access token (the stricter of the two wins).

## Verifying Webhooks

Ship signs every webhook delivery with a `Ship-Signature: t=<unix>,v1=<hex-hmac>`
header (HMAC-SHA256 over `<timestamp>.<raw-body>`, keyed by your subscription's
`whsec_…` secret). `verifyWebhook` checks it in constant time and rejects stale
timestamps (default tolerance 5 minutes).

**Always verify against the RAW request body** — the exact bytes Ship sent, not a
re-serialized JSON object.

### Express

```ts
import express from 'express';
import { verifyWebhook } from '@ryanjagger/ship-sdk';

const app = express();
const SECRET = process.env.SHIP_WEBHOOK_SECRET!;

// Capture the raw body for this route (do NOT use express.json() here).
app.post('/ship/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8');
  if (!verifyWebhook(req.headers, rawBody, SECRET)) {
    return res.status(400).send('invalid signature');
  }
  const event = JSON.parse(rawBody);
  // event.type, event.data.object, event.id (== idempotency_key) …
  // Deduplicate by event.id — delivery is at-least-once.
  res.sendStatus(200);
});
```

### Fetch / Request (Workers, Deno, Next.js route handlers)

```ts
import { verifyWebhook } from '@ryanjagger/ship-sdk';

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text(); // raw bytes, parse only after verifying
  if (!verifyWebhook(request.headers, rawBody, process.env.SHIP_WEBHOOK_SECRET!)) {
    return new Response('invalid signature', { status: 400 });
  }
  const event = JSON.parse(rawBody);
  return new Response('ok');
}
```

A custom tolerance: `verifyWebhook(headers, rawBody, secret, { toleranceSec: 600 })`.

## CLI Usage

```bash
ship login
ship docs create --title "hello"
ship docs list
```

The CLI defaults to the current Railway development deployment. Override the
target for local development or future production:

```bash
SHIP_API_URL=http://localhost:3000 ship login
SHIP_API_URL=https://your-ship-origin.example.com ship login
```

`ship login` uses the OAuth 2.0 Device Authorization Grant and stores the bearer
token at `~/.ship/credentials.json` with owner-only file permissions.
