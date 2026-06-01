import { describe, it, expect } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { createApp } from '../../../../app.js';
import { apiRateLimitHandler } from '../rate-limit.js';
import type { ApiErrorCode } from '../errors.js';

/**
 * Fitness test for the Platform API error contract (PRD §5.6).
 *
 * Two guarantees:
 *  1. Every `/api/v1/*` route ships the `ApiError` shape on a failure path.
 *  2. The existing global rate limiter emits `ApiError` (code `rate_limited`)
 *     on `/api/v1` — and ONLY there; other `/api/*` paths keep the legacy body.
 *
 * This is intentionally the spec's TODO list: it enumerates every public route
 * and asserts the unauthenticated failure status, so it stays red until the
 * Bearer middleware and resource routes land, then green once they do.
 *
 * None of these assertions require a database: a missing Bearer token is
 * rejected before any query runs, and an unmatched route 404s at the router.
 */

const API_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'server_error',
]);

function expectApiErrorShape(body: unknown): asserts body is Record<string, unknown> {
  expect(body, 'failure body should be an object').toBeTypeOf('object');
  const b = body as Record<string, unknown>;
  expect(API_ERROR_CODES.has(b.code as string), `code "${String(b.code)}" should be a known ApiError code`).toBe(true);
  expect(typeof b.message, 'message should be a string').toBe('string');
  expect((b.message as string).length, 'message should be non-empty').toBeGreaterThan(0);
  expect(typeof b.request_id, 'request_id should be a string').toBe('string');
  expect((b.request_id as string).length, 'request_id should be non-empty').toBeGreaterThan(0);
  // Must NOT be the internal success/data envelope, nor the legacy { error }.
  expect(b).not.toHaveProperty('success');
}

// Every public /api/v1 route + the status an unauthenticated caller must get.
// All are Bearer-guarded → 401 with no token (auth runs before scope/CSRF).
const ROUTES: Array<{ method: 'get' | 'post'; path: string; expected: number }> = [
  { method: 'get', path: '/api/v1/me', expected: 401 },
  { method: 'get', path: '/api/v1/documents', expected: 401 },
  { method: 'get', path: '/api/v1/documents/00000000-0000-0000-0000-000000000000', expected: 401 },
  { method: 'post', path: '/api/v1/documents', expected: 401 },
];

describe('Platform API · ApiError fitness', () => {
  const app = createApp();

  describe('every /api/v1 route returns ApiError on the unauthenticated failure path', () => {
    for (const route of ROUTES) {
      it(`${route.method.toUpperCase()} ${route.path} → ${route.expected} ApiError`, async () => {
        const res = await request(app)[route.method](route.path).send();
        expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(route.expected);
        expectApiErrorShape(res.body);
        expect(res.headers['x-request-id'], 'X-Request-Id header present').toBeTruthy();
      });
    }
  });

  it('unmatched /api/v1 routes 404 with ApiError', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expectApiErrorShape(res.body);
    expect(res.body.code).toBe('not_found');
  });
});

describe('Platform API · rate limiter emits ApiError on /api/v1 (PRD §5.6)', () => {
  // Minimal app reproducing the global limiter wiring with max:1 so a 429 is
  // forced deterministically without hammering thousands of requests.
  function makeLimitedApp(): express.Express {
    const app = express();
    app.use(
      '/api/',
      rateLimit({
        windowMs: 60 * 1000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests. Please slow down.' },
        handler: apiRateLimitHandler,
      })
    );
    app.get('/api/v1/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('forced 429 on /api/v1 is ApiError-shaped with code rate_limited', async () => {
    const app = makeLimitedApp();
    await request(app).get('/api/v1/ping').expect(200);
    const limited = await request(app).get('/api/v1/ping');
    expect(limited.status).toBe(429);
    expectApiErrorShape(limited.body);
    expect(limited.body.code).toBe('rate_limited');
  });

  it('forced 429 on a non-v1 /api path keeps the legacy { error } body (not ApiError)', async () => {
    const app = makeLimitedApp();
    await request(app).get('/api/ping').expect(200);
    const limited = await request(app).get('/api/ping');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests. Please slow down.' });
    expect(limited.body).not.toHaveProperty('code');
    expect(limited.body).not.toHaveProperty('request_id');
  });
});
