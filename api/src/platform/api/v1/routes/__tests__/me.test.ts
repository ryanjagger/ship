import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken, hashToken } from '../../../../oauth/tokens.js';

/**
 * GET /api/v1/me — auth-only route, proving the Bearer middleware end-to-end
 * (PRD §5.5a, §5.4). Validates the public flat shape and the three distinct
 * 401 reasons (missing / invalid / expired).
 */
describe('GET /api/v1/me', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let accessToken: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('Me Test WS') RETURNING id`
    );
    workspaceId = ws.rows[0]!.id;

    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`me-test-${Date.now()}@ship.local`, 'Me Tester']
    );
    userId = u.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [workspaceId, userId]
    );

    const created = await createOAuthApp({
      name: 'Me Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
    });
    appId = created.app.id;

    const issued = await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] });
    accessToken = issued.accessToken;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('returns the flat public user + workspace for a valid token (no scope needed)', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    // Public contract shape — NOT the internal success/data envelope.
    expect(res.body).not.toHaveProperty('success');
    expect(res.body.id).toBe(userId);
    expect(res.body.name).toBe('Me Tester');
    expect(res.body.email).toMatch(/@ship\.local$/);
    expect(res.body.workspace).toMatchObject({ id: workspaceId, name: 'Me Test WS', role: 'admin' });
  });

  it('401 missing_token when no Authorization header', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.details?.reason).toBe('missing_token');
    expect(typeof res.body.request_id).toBe('string');
  });

  it('401 invalid_token for an unknown token', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', 'Bearer ship_at_deadbeef');
    expect(res.status).toBe(401);
    expect(res.body.details?.reason).toBe('invalid_token');
  });

  it('401 token_expired for a token past its expiry (distinct code)', async () => {
    const expiredRaw = `ship_at_${crypto.randomBytes(32).toString('hex')}`;
    await pool.query(
      `INSERT INTO access_tokens (token_hash, token_prefix, app_id, user_id, workspace_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 hour')`,
      [hashToken(expiredRaw), expiredRaw.substring(0, 16), appId, userId, workspaceId, ['documents:read']]
    );
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${expiredRaw}`);
    expect(res.status).toBe(401);
    expect(res.body.details?.reason).toBe('token_expired');
  });

  it('403 workspace_access_revoked once the user loses workspace membership', async () => {
    const issued = await issueAccessToken({ appId, userId, workspaceId, scopes: [] });
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2', [
      workspaceId,
      userId,
    ]);
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${issued.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.details?.reason).toBe('workspace_access_revoked');
    // Restore membership so teardown/order stays clean.
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
      [workspaceId, userId]
    );
  });
});
