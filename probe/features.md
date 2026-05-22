# Probe Features

This document tracks the probe surfaces as they are added.

## Implemented

- Auth/session probe: login, CSRF, session cookie hardening, forged session rejection, unauthenticated protected route access, API-token lifecycle, generated admin/member role boundaries, cleanup reporting, and optional DB-backed session expiry.
- WebSocket validation probe: unauthenticated upgrade rejection, `/events` malformed/unexpected messages, collaboration unknown/malformed/oversized frames, post-probe health checks, and probe document cleanup reporting.
- Dependency vulnerability probe: runs `pnpm audit --json`, reports high/critical advisories, and maps affected packages to likely Ship feature areas.

## Planned

- Input sanitization probe: stored/reflected XSS, SQL injection payloads, and excessive input length across representative user-facing fields.
- Headers/secrets probe: CORS/CSP/security header checks, verbose error leakage, and live HTTP secret-path exposure checks.
- Rate-limit probe: production-safe low-volume checks by default, with aggressive proof behind an explicit flag.
