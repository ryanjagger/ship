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
