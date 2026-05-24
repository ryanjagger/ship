# Probe

Active security probe for the Ship app. Runs a set of attack-surface checks
against a **running** target (local dev, shadow/UAT, or any reachable
deployment) and writes a redacted report in JSON, Markdown, and a
self-contained HTML viewer.

Probe is read-only by default. Checks that create data (test wikis, issues,
comments, API tokens, invited users) only run when you pass `--allow-mutation`.

## Prerequisites

- A reachable target. For local runs, start the app first:
  ```bash
  pnpm dev          # from the repo root — starts api + web
  ```
- Login credentials for the target. Local dev is seeded with
  `dev@ship.local` / `admin123` (run `pnpm db:seed` if login fails).

## Quick start (interactive)

Run with no flags from a terminal and probe prompts you for everything —
target URL, credentials, which probe groups to run, and the mutation /
aggressive-rate-limit confirmations:

```bash
pnpm probe
```

When the run finishes, the HTML report opens automatically in your browser.
Each row in the report is clickable — click to expand the full evidence and
reproduction steps.

## Scripted / CI usage

Pass any flag and probe runs non-interactively (no prompts), so existing
automation is unaffected:

```bash
pnpm probe --api-url http://localhost:3000 --allow-mutation
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `--api-url <url>` | `http://localhost:3000` | API base URL to probe |
| `--web-url <url>` | — | Optional web app base URL |
| `--email <email>` | `dev@ship.local` | Login email |
| `--password <pw>` | `admin123` | Login password |
| `--allow-mutation` | off | Enable probes that create tokens, invites, users, or DB changes |
| `--aggressive-rate-limit` | off | Force a 429 proof against login rate limiting (locks the test account ~15 min) |
| `--only <groups>` | — | Comma-separated probe groups to run |
| `--skip <groups>` | — | Comma-separated probe groups to skip |
| `--keep-data` | off | Keep audit-created data where cleanup is supported |
| `--output-dir <dir>` | `probe/results` | Report output directory |
| `--timeout-ms <ms>` | `30000` | Per-request timeout |
| `--run-id <id>` | auto | Stable run id / filename stem (see constraints below) |

Run `pnpm probe -- --help` for the authoritative flag list.

Environment variables (`PROBE_API_URL`, `PROBE_WEB_URL`, `PROBE_EMAIL`,
`PROBE_PASSWORD`, `PROBE_ALLOW_MUTATION=1`, `PROBE_ONLY`, `PROBE_SKIP`,
`PROBE_AGGRESSIVE_RATE_LIMIT=1`, `PROBE_OUTPUT_DIR`, `PROBE_TIMEOUT_MS`) are
honored when the matching flag is absent.

## Probe groups

`preflight`, `auth`, `websocket`, `dependencies`, `inputs`, `headers`,
`rate-limit`. Use `--only` / `--skip` to focus a rerun. See
[features.md](features.md) for what each group checks.

## Output

Every run writes to `probe/results/` (gitignored):

- `<run-id>.{json,md,html}` — the durable per-run report (history accumulates)
- `security-report.{json,md,html}` — alias overwritten each run, pointing at
  the latest report (stable path for any caller that hard-codes it)
- `index.html` — run-history index, newest first; links into each per-run HTML

Open `probe/results/index.html` to browse past runs, or any per-run `.html`
on its own — they are self-contained (CSS, JS, and the run's JSON all inlined)
so a single file can be emailed or shared.

The JSON is the machine-readable source of truth; the HTML is for humans.
Token, cookie, password, secret, database-URL, private-key, JWT, and AWS-key
shaped values are redacted before any report is written.

### `--run-id` constraints

The run id is used as a filename stem, so it must match
`^[A-Za-z0-9_][A-Za-z0-9._-]*$` and may not be a reserved name
(case-insensitive: `index`, `security-report`, or a Windows device name such
as `CON`, `NUL`, `COM1`). Invalid values are rejected before the run starts.

## Safety notes

- **Mutation is opt-in.** Without `--allow-mutation`, probe never creates data;
  mutating checks report as "not tested" instead.
- **Aggressive rate-limit mode locks the login limiter** for ~15 minutes after
  the run. Leave it off for repeatable reruns; use a throwaway account if you
  need the 429 proof.
- **Against shared/deployed targets**, use a dedicated probe account and avoid
  `--allow-mutation` / `--aggressive-rate-limit` unless you understand the
  blast radius.

## Development

```bash
pnpm --filter probe test         # unit + jsdom tests (vitest)
pnpm --filter probe type-check   # tsc --noEmit
```
