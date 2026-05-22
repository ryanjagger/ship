# Probe Features

This document tracks the probe surfaces as they are added.

## Implemented

- Auth/session probe: login, CSRF, session cookie hardening, forged session rejection, unauthenticated protected route access, API-token lifecycle, generated admin/member role boundaries, cleanup reporting, and optional DB-backed session expiry.
- WebSocket validation probe: unauthenticated upgrade rejection, `/events` malformed/unexpected messages, collaboration unknown/malformed/oversized frames, post-probe health checks, and probe document cleanup reporting.
- Dependency vulnerability probe: runs `pnpm audit --json`, reports high/critical advisories, and maps affected packages to likely Ship feature areas.
- Input sanitization probe: creates dedicated wiki/issue/comment fixtures with XSS canaries, checks stored API round trips, optionally verifies browser execution with Playwright, sends reflected-XSS and SQL-injection query payloads to representative endpoints, validates long-input rejection, and reports cleanup.
- Headers/secrets probe: checks hostile-origin CORS behavior, baseline security headers on API/web targets, verbose error leakage from malformed authenticated requests, and common live HTTP secret paths.
- Rate-limit probe: sends production-safe low-volume bursts to CSRF, login, authenticated search/read, and invalid authenticated write endpoints, then reports whether 429 responses, Retry-After, or rate-limit headers were observed.

## Planned

- Aggressive rate-limit proof mode: optional higher-volume checks behind an explicit flag.
