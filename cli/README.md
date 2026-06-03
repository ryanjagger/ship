# ship CLI

A small command-line client for the Ship Platform API. The published `ship`
binary is packaged with [`@ryanjagger/ship-sdk`](../sdk), so a clean drill can
install one package and then run `ship login`. This workspace package is kept as
an internal development wrapper.

## Usage

```bash
ship login                       # device flow: prints a code + opens /device
ship docs create --title "hello" # create a document
ship docs list                   # list your documents
```

`ship login` requests a `user_code`, opens the `/device` approval page in your
browser, and polls until you approve — then saves the access token to
`~/.ship/credentials.json` (mode `0600`). Tokens last 1 hour (no refresh yet), so
re-run `ship login` after they expire.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `SHIP_API_URL` | `https://ship-app-development-development.up.railway.app` | Ship API base URL |
| `SHIP_CLIENT_ID` | `client_ship_cli` | OAuth client (seed with `pnpm --filter @ship/api db:seed:cli`) |

### Local dev note

In local dev the API (`:3000`) and web app (`:5173`) run on different ports. Run
the CLI with `SHIP_API_URL=http://localhost:3000`. The `/device` page is served
by the web app, but the API builds the verification URL from its own host. So
when running against `pnpm dev`, start the API with:

```bash
PUBLIC_BASE_URL=http://localhost:5173
```

so the printed verification URL opens the web-served `/device` page. In
production (single origin) this isn't needed.

## Build

```bash
pnpm --filter @ryanjagger/ship-sdk build
node sdk/dist/cli/index.js login
```
