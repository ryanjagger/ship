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

## Planned

- Probe group timing: include per-group elapsed time in the CLI summary and report metadata.
