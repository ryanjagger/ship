import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { createOAuthApp } from '../apps.js';
import { approveDeviceCode, denyDeviceCode, normalizeUserCode } from '../device-codes.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Device Authorization Grant endpoints (RFC 8628) end-to-end through the app:
 * the public `device/authorization` + `token` poll. Approval is driven via the
 * model (the session-gated /device decision endpoint is covered by e2e).
 */
describe('OAuth Device Flow · /api/oauth endpoints', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let clientId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Device Flow WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Device Flow Tester') RETURNING id`,
      [`device-flow-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const created = await createOAuthApp({
      name: 'Device Flow CLI',
      redirectUris: [],
      ownerUserId: userId,
      requestedScopes: ['documents:read', 'documents:write'],
    });
    clientId = created.app.client_id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE client_id = $1', [clientId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const authorize = (scope?: string) =>
    request(app).post('/api/oauth/device/authorization').send({ client_id: clientId, scope });
  const poll = (deviceCode: string) =>
    request(app).post('/api/oauth/token').send({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId });
  const ageLastPoll = (userCode: string) =>
    pool.query(`UPDATE oauth_device_codes SET last_polled_at = now() - interval '30 seconds' WHERE user_code = $1`, [
      normalizeUserCode(userCode),
    ]);

  it('device/authorization returns the RFC 8628 shape', async () => {
    const res = await authorize('documents:read');
    expect(res.status).toBe(200);
    expect(res.body.device_code).toBeTruthy();
    expect(res.body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.verification_uri).toMatch(/\/device$/);
    expect(res.body.verification_uri_complete).toContain(`code=${encodeURIComponent(res.body.user_code)}`);
    expect(res.body.expires_in).toBe(600);
    expect(res.body.interval).toBe(5);
  });

  it('device/authorization rejects an unknown client → invalid_client', async () => {
    const res = await request(app).post('/api/oauth/device/authorization').send({ client_id: 'client_nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('device/authorization rejects a scope the client lacks → invalid_scope', async () => {
    const res = await authorize('webhooks:manage');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });

  it('poll before approval → authorization_pending', async () => {
    const { body } = await authorize('documents:read');
    const res = await poll(body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('authorization_pending');
  });

  it('approve → poll yields a usable token; re-poll → invalid_grant (single-use)', async () => {
    const { body } = await authorize('documents:read');
    await approveDeviceCode({ userCode: body.user_code, userId, workspaceId });

    const tokenRes = await poll(body.device_code);
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.body.expires_in).toBe(3600);
    expect(tokenRes.body.scope).toBe('documents:read');
    const token = tokenRes.body.access_token as string;
    expect(token.startsWith('ship_at_')).toBe(true);

    // The minted token authenticates the Platform API.
    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(userId);

    // Second redemption fails (well-spaced so it isn't a slow_down).
    await ageLastPoll(body.user_code);
    const reuse = await poll(body.device_code);
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
  });

  it('deny → poll returns access_denied', async () => {
    const { body } = await authorize('documents:read');
    await denyDeviceCode(body.user_code);
    const res = await poll(body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('access_denied');
  });

  it('expired device_code → expired_token', async () => {
    const { body } = await authorize('documents:read');
    await pool.query(`UPDATE oauth_device_codes SET expires_at = now() - interval '1 minute' WHERE user_code = $1`, [
      normalizeUserCode(body.user_code),
    ]);
    const res = await poll(body.device_code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('expired_token');
  });

  it('unknown device_code → invalid_grant', async () => {
    const res = await poll('device_does_not_exist');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('too-fast re-poll → slow_down', async () => {
    const { body } = await authorize('documents:read');
    await poll(body.device_code); // first poll stamps last_polled_at
    const second = await poll(body.device_code);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('slow_down');
  });

  it('device_code from another client → invalid_grant (not burned for the owner)', async () => {
    const other = await createOAuthApp({
      name: 'Other CLI',
      redirectUris: [],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
    });
    try {
      const { body } = await authorize('documents:read');
      await approveDeviceCode({ userCode: body.user_code, userId, workspaceId });
      // Wrong client polls the code → invalid_grant.
      const wrong = await request(app)
        .post('/api/oauth/token')
        .send({ grant_type: DEVICE_GRANT, device_code: body.device_code, client_id: other.app.client_id });
      expect(wrong.body.error).toBe('invalid_grant');
      // The legitimate client can still redeem it.
      await ageLastPoll(body.user_code);
      const ok = await poll(body.device_code);
      expect(ok.status).toBe(200);
    } finally {
      await pool.query('DELETE FROM oauth_apps WHERE id = $1', [other.app.id]);
    }
  });
});
