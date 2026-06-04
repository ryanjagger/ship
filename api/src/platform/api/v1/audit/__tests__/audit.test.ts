import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';
import { queryPublicApiAudit } from '../service.js';

/**
 * Public API audit trail (PRD §7): a row is written on res.finish for every
 * token-validated request — success, validation failure, scope/auth failure
 * after token validation, and 429 — with accurate status + latency + matched
 * scope, and no secrets.
 */
describe('Platform API · audit trail', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let clientId: string;
  let token: string;

  // Wait for the deferred res.finish audit writes to land.
  async function settle(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Audit WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Audit Tester') RETURNING id`,
      [`audit-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const created = await createOAuthApp({
      name: 'Audit App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read'], // intentionally NOT issues:* so a 403 is reachable
    });
    appId = created.app.id;
    clientId = created.app.client_id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] })).accessToken;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM public_api_audit_logs WHERE workspace_id = $1', [workspaceId]);
    await pool.query(`DELETE FROM public_api_rate_limit_buckets WHERE bucket_key = $1`, [`app:${appId}`]);
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('records a successful request with status, matched scope, route template, and client_id', async () => {
    await request(app).get('/api/v1/documents').set('Authorization', `Bearer ${token}`);
    await settle();
    const { data } = await queryPublicApiAudit({ workspaceId, route: '/api/v1/documents' });
    const row = data[0];
    expect(row, 'an audit row should exist for GET /api/v1/documents').toBeDefined();
    expect(row!.status).toBe(200);
    expect(row!.method).toBe('GET');
    expect(row!.scope).toBe('documents:read');
    expect(row!.client_id).toBe(clientId);
    expect(row!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row!.request_id).toBeTruthy();
    // No secret/token material leaked into the row.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('records a 403 scope denial (auth failure after token validation)', async () => {
    // documents:read does NOT satisfy webhooks:manage (no broad superscope), so
    // this is a real post-token-validation 403.
    await request(app).get('/api/v1/webhooks').set('Authorization', `Bearer ${token}`);
    await settle();
    const { data } = await queryPublicApiAudit({ workspaceId, statusClass: 4 });
    const forbidden = data.find((r) => r.status === 403 && r.route === '/api/v1/webhooks');
    expect(forbidden, 'a 403 audit row should exist for GET /api/v1/webhooks').toBeDefined();
  });

  it('filters by status class and scopes strictly to the workspace', async () => {
    const { data, total } = await queryPublicApiAudit({ workspaceId, statusClass: 2 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(data.every((r) => r.status >= 200 && r.status < 300)).toBe(true);
    expect(data.every((r) => r.workspace_id === workspaceId)).toBe(true);
  });
});
