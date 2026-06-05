import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';
import { consumeRateLimit } from '../service.js';

/**
 * Platform rate limiter (PRD §6): per-app + per-token token buckets, stricter of
 * the two, with X-RateLimit-* headers on every authenticated response and a 429
 * + Retry-After on exhaustion.
 */
describe('Platform API · rate limiter', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let token: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // Small token budget so exhaustion is deterministic over the HTTP path.
    process.env.PLATFORM_RATE_LIMIT_TOKEN_PER_MIN = '2';
    process.env.PLATFORM_RATE_LIMIT_APP_PER_MIN = '100';
    process.env.PLATFORM_RATE_LIMIT_WINDOW_SEC = '60';

    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('RL Test WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'RL Tester') RETURNING id`,
      [`rl-test-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const created = await createOAuthApp({
      name: 'RL Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
    });
    appId = created.app.id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] })).accessToken;
  });

  afterAll(async () => {
    process.env.PLATFORM_RATE_LIMIT_TOKEN_PER_MIN = savedEnv.PLATFORM_RATE_LIMIT_TOKEN_PER_MIN;
    process.env.PLATFORM_RATE_LIMIT_APP_PER_MIN = savedEnv.PLATFORM_RATE_LIMIT_APP_PER_MIN;
    process.env.PLATFORM_RATE_LIMIT_WINDOW_SEC = savedEnv.PLATFORM_RATE_LIMIT_WINDOW_SEC;
    await pool.query(`DELETE FROM public_api_rate_limit_buckets WHERE bucket_key IN ($1, $2)`, [`app:${appId}`, `token:${token ? '' : ''}`]).catch(() => {});
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('stamps X-RateLimit-* headers on a successful authenticated response', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeTruthy();
    expect(res.headers['x-ratelimit-remaining']).toBeTruthy();
    expect(res.headers['x-ratelimit-reset']).toBeTruthy();
  });

  it('returns 429 rate_limited with Retry-After once the token bucket is exhausted', async () => {
    // One request already consumed above; budget is 2. Drain then exceed.
    await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`); // 2nd (may be allowed)
    let limited: request.Response | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited, 'a 429 should occur within a few requests at limit=2').toBeDefined();
    expect(limited!.body.code).toBe('rate_limited');
    expect(typeof limited!.body.request_id).toBe('string');
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited!.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('openapi.json is exempt (no auth, no rate-limit headers required)', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('rate-limit service · stricter-of-two buckets', () => {
  it('denies when the APP bucket is exhausted even if the token bucket has room', async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('RL Svc WS') RETURNING id`);
    const workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'RL Svc') RETURNING id`,
      [`rl-svc-${Date.now()}@ship.local`]
    );
    const userId = u.rows[0]!.id;
    const created = await createOAuthApp({
      name: 'RL Svc App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
    });
    const appId = created.app.id;
    await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] });
    // The service treats the token id purely as a distinct bucket key.
    const tokenId = randomUUID();
    const config = { appLimit: 1, tokenLimit: 100, windowSeconds: 60 };

    try {
      const first = await consumeRateLimit(appId, tokenId, config);
      expect(first.allowed).toBe(true);
      const second = await consumeRateLimit(appId, tokenId, config);
      expect(second.allowed).toBe(false);
      // The limiting bucket is the app bucket, and Retry-After is positive.
      expect(second.limiting.key).toBe(`app:${appId}`);
      expect(second.limiting.retryAfterSec).toBeGreaterThanOrEqual(1);
      // Token bucket still has plenty of room (proves "stricter of the two").
      expect(second.token.remaining).toBeGreaterThan(50);
    } finally {
      await pool.query(`DELETE FROM public_api_rate_limit_buckets WHERE bucket_key IN ($1, $2)`, [`app:${appId}`, `token:${tokenId}`]);
      await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });
});
