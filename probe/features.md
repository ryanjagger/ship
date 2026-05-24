# Probe Features

This document tracks the probe surfaces as they are added.

## Implemented

- Preflight probe: verifies API and optional web target reachability, configured credential login, mutating-probe readiness, and `pnpm audit --json` availability before the attack-surface probes run.
- Auth/session probe: login, CSRF, session cookie hardening, forged session rejection, unauthenticated protected route access, API-token lifecycle, generated admin/member role boundaries, cleanup reporting, and optional DB-backed session expiry.
- WebSocket validation probe: unauthenticated upgrade rejection, `/events` malformed/unexpected messages, collaboration unknown/malformed/oversized frames, post-probe health checks, and probe document cleanup reporting.
- Dependency vulnerability probe: runs `pnpm audit --json`, reports high/critical advisories, and maps affected packages to likely Ship feature areas.
- Input sanitization probe: creates dedicated wiki/issue/comment fixtures with XSS canaries, checks stored API round trips, optionally verifies browser execution with Playwright, sends reflected-XSS and SQL-injection query payloads to representative endpoints, validates long-input rejection, and reports cleanup.
- Headers/secrets probe: checks hostile-origin CORS behavior, baseline security headers on API/web targets, verbose error leakage from malformed authenticated requests, and common live HTTP secret paths.
- Rate-limit probe: sends production-safe low-volume bursts to CSRF, login, authenticated search/read, and invalid authenticated write endpoints, then reports whether rate-limit headers or retry signals were observed without exhausting the login limiter by default.
- Probe selection: supports `--only` and `--skip` for focused reruns by probe group.
- Report safety and usability: redacts token, cookie, password, secret, database URL, private-key, JWT, and AWS-key shaped values before writing reports; CLI and markdown output include per-surface summaries.
- Aggressive rate-limit proof mode: `--aggressive-rate-limit` explicitly forces invalid-login attempts until a 429 is observed, and is disabled by default to keep normal reruns repeatable.
- Per-run report files with history: each run writes `<run-id>.{json,md,html}` alongside the existing `security-report.{json,md,html}` alias, so past runs accumulate in `probe/results/` instead of being overwritten.
- Self-contained HTML viewer: each run also writes a single HTML file (CSS, JS, and the run's JSON all inlined) with a sortable findings table, status filter tabs, search, severity-mix KPI band, and a dark/light theme toggle that persists in `localStorage`. Opens on `file://` with no fetches, so a single report can be emailed or Slacked.
- Run history index: `probe/results/index.html` is regenerated after every run, listing past runs newest-first with timestamp, target hostname, finding count, and severity mix, with links into each per-run report.
- Interactive CLI prompts: invoking `pnpm probe` with no flags from a terminal prompts for target URL, credentials, probe groups, and mutation/rate-limit confirms (each non-obvious option shows inline hint text). Any flag OR a non-TTY stdin short-circuits prompts entirely, so CI and scripted runs are unchanged.
- Browser auto-open: after an interactive run completes, the per-run HTML opens in the default browser. Non-interactive runs (any flag, non-TTY) skip auto-open; browser-launch failures (headless SSH, missing default browser) log a soft warning and never fail the run.

## Planned

- Probe group timing: include per-group elapsed time in the CLI summary and report metadata.
