import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

/**
 * First-party token exchange (POST /api/developer/token): the session-authed
 * bridge that lets the Developer Portal SPA consume /api/v1 through the SDK.
 * Workspace-admin gated at mint; the minted token carries exactly the portal
 * scopes with a 15-minute TTL and works against the /api/v1 admin surface.
 */
describe('Developer portal token exchange', () => {
  const app = createApp();
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let adminUserId: string;
  let memberUserId: string;
  let adminCookie: string;
  let adminCsrf: string;
  let memberCookie: string;
  let memberCsrf: string;

  beforeAll(async () => {
    // The portal system client is provisioned by migration 061; recreate it
    // defensively for databases where migrations were marked but not run.
    await pool.query(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, client_type, allow_device_flow, is_system)
       VALUES ('client_ship_developer_portal', NULL, 'Developer Portal', ARRAY[]::text[], NULL, ARRAY['apps:manage', 'connections:manage', 'audit:read'], 'public', false, true)
       ON CONFLICT (client_id) DO NOTHING`
    );

    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Portal Token WS ${testRunId}`,
    ]);
    workspaceId = ws.rows[0]!.id;

    const mkUser = async (label: string, role: 'admin' | 'member') => {
      const u = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', $2) RETURNING id`,
        [`portal-token-${label}-${testRunId}@ship.local`, `Portal Token ${label}`]
      );
      const userId = u.rows[0]!.id;
      await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [
        workspaceId,
        userId,
        role,
      ]);
      const sessionId = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [sessionId, userId, workspaceId]
      );
      let cookie = `session_id=${sessionId}`;
      const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', cookie);
      const connectSid = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
      if (connectSid) cookie = `${cookie}; ${connectSid}`;
      return { userId, cookie, csrf: csrfRes.body.token as string };
    };

    const admin = await mkUser('admin', 'admin');
    adminUserId = admin.userId;
    adminCookie = admin.cookie;
    adminCsrf = admin.csrf;
    const member = await mkUser('member', 'member');
    memberUserId = member.userId;
    memberCookie = member.cookie;
    memberCsrf = member.csrf;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM access_tokens WHERE user_id = ANY($1)`,
      [[adminUserId, memberUserId]]
    );
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[adminUserId, memberUserId]]);
    await pool.query('DELETE FROM public_api_audit_logs WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminUserId, memberUserId]]);
  });

  it('mints a 15-minute token with exactly the portal scopes for a workspace admin', async () => {
    const res = await request(app)
      .post('/api/developer/token')
      .set('Cookie', adminCookie)
      .set('X-CSRF-Token', adminCsrf);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.access_token).toMatch(/^ship_at_/);
    expect(data.token_type).toBe('Bearer');
    expect(data.expires_in).toBe(900);
    expect(data.scope).toBe('apps:manage connections:manage audit:read');

    // The minted token works against the /api/v1 admin surface.
    const apps = await request(app).get('/api/v1/apps').set('Authorization', `Bearer ${data.access_token}`);
    expect(apps.status).toBe(200);
    expect(Array.isArray(apps.body.data)).toBe(true);

    // The DB row is scoped to the session's user + workspace with a short expiry.
    const row = await pool.query<{ scopes: string[]; expires_at: string; workspace_id: string }>(
      `SELECT scopes, expires_at, workspace_id FROM access_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUserId]
    );
    expect(row.rows[0]!.scopes).toEqual(['apps:manage', 'connections:manage', 'audit:read']);
    expect(row.rows[0]!.workspace_id).toBe(workspaceId);
    const ttlMs = new Date(row.rows[0]!.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(13 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('403s a member-role user at mint (workspace-admin gate)', async () => {
    const res = await request(app)
      .post('/api/developer/token')
      .set('Cookie', memberCookie)
      .set('X-CSRF-Token', memberCsrf);
    expect(res.status).toBe(403);
  });

  it('401s without a session', async () => {
    const res = await request(app).post('/api/developer/token');
    // conditionalCsrf runs before auth for cookie-less requests → CSRF 403 or auth 401;
    // either way the mint is refused for an anonymous caller.
    expect([401, 403]).toContain(res.status);
  });
});
