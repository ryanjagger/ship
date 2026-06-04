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
