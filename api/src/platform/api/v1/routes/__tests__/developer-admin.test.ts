import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';

process.env.WEBHOOK_SECRET_ENC_KEY ||= crypto.randomBytes(32).toString('hex');

import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

/**
 * Developer-platform admin surface (/api/v1/apps, /connections, /audit, /scopes)
 * — the routes the Developer Portal dogfoods through the SDK. Key invariants:
 * scope-denial 403 names the scope; a member-role user's token is 403 even WITH
 * the scope (workspace_admin_required); event-family gating uses the TARGET
 * app's scopes; system clients are protected; cross-workspace apps are 404.
 */
describe('Platform API · developer admin (apps, connections, audit, scopes)', () => {
  const app = createApp();
  const ADMIN_SCOPES = ['apps:manage', 'connections:manage', 'audit:read'];
  let workspaceId: string;
  let otherWorkspaceId: string;
  let adminUserId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let portalAppId: string; // the caller app (stands in for the Developer Portal client)
  let targetAppId: string; // a workspace app being managed
  let narrowAppId: string; // workspace app WITHOUT issues:read (event-gate target)
  let outsiderAppId: string; // app owned by a user in another workspace
  let systemAppId: string;
  let adminToken: string; // admin user, full admin scopes
  let memberToken: string; // member user, full admin scopes — must still 403
  let noScopeToken: string; // admin user, no admin scopes

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Dev Admin WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const ws2 = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Dev Admin Other WS') RETURNING id`);
    otherWorkspaceId = ws2.rows[0]!.id;

    const mkUser = async (label: string) => {
      const u = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
        [`dev-admin-${label}-${Date.now()}@ship.local`, `Dev Admin ${label}`]
      );
      return u.rows[0]!.id;
    };
    adminUserId = await mkUser('admin');
    memberUserId = await mkUser('member');
    outsiderUserId = await mkUser('outsider');
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, adminUserId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, memberUserId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [otherWorkspaceId, outsiderUserId]);

    portalAppId = (await createOAuthApp({
      name: 'Dev Admin Caller', redirectUris: ['https://portal.example.com/cb'], ownerUserId: adminUserId, requestedScopes: ADMIN_SCOPES,
    })).app.id;
    targetAppId = (await createOAuthApp({
      name: 'Dev Admin Target', redirectUris: ['https://target.example.com/cb'], ownerUserId: adminUserId, requestedScopes: ['issues:read', 'webhooks:manage'],
    })).app.id;
    narrowAppId = (await createOAuthApp({
      name: 'Dev Admin Narrow', redirectUris: ['https://narrow.example.com/cb'], ownerUserId: adminUserId, requestedScopes: ['people:read'],
    })).app.id;
    outsiderAppId = (await createOAuthApp({
      name: 'Dev Admin Outsider', redirectUris: ['https://outsider.example.com/cb'], ownerUserId: outsiderUserId, requestedScopes: ['issues:read'],
    })).app.id;

    const sys = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, client_type, is_system)
       VALUES ($1, NULL, 'Dev Admin System', '{}', NULL, '{}', 'public', true) RETURNING id`,
      [`client_devadmin_sys_${Date.now()}`]
    );
    systemAppId = sys.rows[0]!.id;

    adminToken = (await issueAccessToken({ appId: portalAppId, userId: adminUserId, workspaceId, scopes: ADMIN_SCOPES })).accessToken;
    memberToken = (await issueAccessToken({ appId: portalAppId, userId: memberUserId, workspaceId, scopes: ADMIN_SCOPES })).accessToken;
    noScopeToken = (await issueAccessToken({ appId: portalAppId, userId: adminUserId, workspaceId, scopes: ['issues:read'] })).accessToken;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = ANY($1)', [[portalAppId, targetAppId, narrowAppId, outsiderAppId, systemAppId]]);
    await pool.query('DELETE FROM public_api_audit_logs WHERE workspace_id = ANY($1)', [[workspaceId, otherWorkspaceId]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[workspaceId, otherWorkspaceId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminUserId, memberUserId, outsiderUserId]]);
  });

  // ── Authorization model ─────────────────────────────────────────────────

  it('403s without the scope, naming it', async () => {
    for (const [path, scope] of [
      ['/api/v1/apps', 'apps:manage'],
      ['/api/v1/connections', 'connections:manage'],
      ['/api/v1/audit', 'audit:read'],
    ] as const) {
      const res = await request(app).get(path).set(auth(noScopeToken));
      expect(res.status, path).toBe(403);
      expect(res.body.details.required_scope, path).toBe(scope);
    }
  });

  it('403s a member-role user even WITH the scope (workspace_admin_required)', async () => {
    for (const path of ['/api/v1/apps', '/api/v1/connections', '/api/v1/audit']) {
      const res = await request(app).get(path).set(auth(memberToken));
      expect(res.status, path).toBe(403);
      expect(res.body.details.reason, path).toBe('workspace_admin_required');
    }
  });

  it('GET /scopes is auth-only and includes the admin scopes', async () => {
    const res = await request(app).get('/api/v1/scopes').set(auth(noScopeToken));
    expect(res.status).toBe(200);
    const names = res.body.data.map((s: { scope: string }) => s.scope);
    expect(names).toContain('apps:manage');
    expect(names).toContain('documents:read');
  });

  // ── Apps ────────────────────────────────────────────────────────────────

  it('lists workspace apps (member-owned + system), not other workspaces', async () => {
    const res = await request(app).get('/api/v1/apps').set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(targetAppId);
    expect(ids).toContain(systemAppId);
    expect(ids).not.toContain(outsiderAppId);
    expect(res.body.data[0]).not.toHaveProperty('client_secret_hash');
  });

  it('creates a confidential app (secret once), rotates, deletes', async () => {
    const created = await request(app)
      .post('/api/v1/apps')
      .set(auth(adminToken))
      .send({ name: 'Lifecycle App', redirect_uris: ['https://lc.example.com/cb'], requested_scopes: ['issues:read'] });
    expect(created.status).toBe(201);
    expect(created.body.client_secret).toMatch(/^secret_/);
    expect(created.body.warning).toContain('not be shown again');
    const id = created.body.id as string;

    const rotated = await request(app).post(`/api/v1/apps/${id}/rotate-secret`).set(auth(adminToken));
    expect(rotated.status).toBe(200);
    expect(rotated.body.client_secret).toMatch(/^secret_/);
    expect(rotated.body.client_secret).not.toBe(created.body.client_secret);

    const deleted = await request(app).delete(`/api/v1/apps/${id}`).set(auth(adminToken));
    expect(deleted.status).toBe(204);
    const list = await request(app).get('/api/v1/apps').set(auth(adminToken));
    expect(list.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it('rejects unknown scopes at registration', async () => {
    const res = await request(app)
      .post('/api/v1/apps')
      .set(auth(adminToken))
      .send({ name: 'Bad Scopes', redirect_uris: ['https://x.example.com/cb'], requested_scopes: ['not:a:scope'] });
    expect(res.status).toBe(400);
    expect(res.body.details.unknown_scopes).toEqual(['not:a:scope']);
  });

  it('protects system clients from rotate/delete (403) and public clients from rotate (400)', async () => {
    const rot = await request(app).post(`/api/v1/apps/${systemAppId}/rotate-secret`).set(auth(adminToken));
    expect(rot.status).toBe(403);
    expect(rot.body.details.reason).toBe('system_client');
    const del = await request(app).delete(`/api/v1/apps/${systemAppId}`).set(auth(adminToken));
    expect(del.status).toBe(403);

    const pub = await request(app)
      .post('/api/v1/apps')
      .set(auth(adminToken))
      .send({ name: 'Public App', redirect_uris: ['https://pub.example.com/cb'], client_type: 'public' });
    expect(pub.status).toBe(201);
    expect(pub.body).not.toHaveProperty('client_secret');
    const pubRot = await request(app).post(`/api/v1/apps/${pub.body.id}/rotate-secret`).set(auth(adminToken));
    expect(pubRot.status).toBe(400);
    expect(pubRot.body.details.reason).toBe('public_client_no_secret');
    await request(app).delete(`/api/v1/apps/${pub.body.id}`).set(auth(adminToken));
  });

  it('404s an app from another workspace', async () => {
    const res = await request(app).get(`/api/v1/apps/${outsiderAppId}/webhooks`).set(auth(adminToken));
    expect(res.status).toBe(404);
    const del = await request(app).delete(`/api/v1/apps/${outsiderAppId}`).set(auth(adminToken));
    expect(del.status).toBe(404);
  });

  // ── Per-app webhooks (target-app scope gating) ──────────────────────────

  it('manages a target app\'s subscriptions; event families gate on the TARGET app\'s scopes', async () => {
    // The caller's token has NO issues:read — only the target app does. Must pass.
    const created = await request(app)
      .post(`/api/v1/apps/${targetAppId}/webhooks`)
      .set(auth(adminToken))
      .send({ url: 'https://hooks.example.com/t', events: ['issue.created'] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    const subId = created.body.id as string;

    // The narrow app (people:read only) must NOT be subscribable to issue.*.
    const gated = await request(app)
      .post(`/api/v1/apps/${narrowAppId}/webhooks`)
      .set(auth(adminToken))
      .send({ url: 'https://hooks.example.com/n', events: ['issue.created'] });
    expect(gated.status).toBe(400);
    expect(gated.body.message).toContain('requires the app to hold one of');

    // ...but person.* (people:read) is fine.
    const okNarrow = await request(app)
      .post(`/api/v1/apps/${narrowAppId}/webhooks`)
      .set(auth(adminToken))
      .send({ url: 'https://hooks.example.com/n', events: ['person.created'] });
    expect(okNarrow.status).toBe(201);

    const list = await request(app).get(`/api/v1/apps/${targetAppId}/webhooks`).set(auth(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.data.some((s: { id: string }) => s.id === subId)).toBe(true);
    expect(list.body.data[0]).not.toHaveProperty('secret');

    const patched = await request(app)
      .patch(`/api/v1/apps/${targetAppId}/webhooks/${subId}`)
      .set(auth(adminToken))
      .send({ active: false });
    expect(patched.status).toBe(200);
    expect(patched.body.active).toBe(false);

    const rotated = await request(app)
      .post(`/api/v1/apps/${targetAppId}/webhooks/${subId}/rotate-secret`)
      .set(auth(adminToken));
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(created.body.secret);

    const deleted = await request(app).delete(`/api/v1/apps/${targetAppId}/webhooks/${subId}`).set(auth(adminToken));
    expect(deleted.status).toBe(204);
    await request(app).delete(`/api/v1/apps/${narrowAppId}/webhooks/${okNarrow.body.id}`).set(auth(adminToken));
  });

  // ── Deliveries ──────────────────────────────────────────────────────────

  it('lists deliveries and replays one for a target app', async () => {
    const sub = await request(app)
      .post(`/api/v1/apps/${targetAppId}/webhooks`)
      .set(auth(adminToken))
      .send({ url: 'https://hooks.example.com/d', events: ['issue.created'] });
    const subId = sub.body.id as string;

    // Create an issue via the public API as a workspace user → fan-out.
    const writerToken = (await issueAccessToken({ appId: targetAppId, userId: adminUserId, workspaceId, scopes: ['issues:write', 'issues:read'] })).accessToken;
    const issue = await request(app).post('/api/v1/issues').set(auth(writerToken)).send({ title: 'Delivery Admin Issue' });
    expect(issue.status).toBe(201);

    const deliveries = await request(app)
      .get(`/api/v1/apps/${targetAppId}/deliveries`)
      .query({ subscription_id: subId, event_type: 'issue.created' })
      .set(auth(adminToken));
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.data.length).toBeGreaterThanOrEqual(1);
    const deliveryId = deliveries.body.data[0].id as string;

    const detail = await request(app).get(`/api/v1/apps/${targetAppId}/deliveries/${deliveryId}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body.attempts)).toBe(true);

    const replay = await request(app).post(`/api/v1/apps/${targetAppId}/deliveries/${deliveryId}/replay`).set(auth(adminToken));
    expect(replay.status).toBe(202);
    expect(replay.body.replay_of_delivery_id).toBe(deliveryId);
    expect(replay.body.delivery_id).not.toBe(deliveryId);

    await request(app).delete(`/api/v1/apps/${targetAppId}/webhooks/${subId}`).set(auth(adminToken));
  });

  // ── Connections ─────────────────────────────────────────────────────────

  it('lists and revokes connections', async () => {
    // Give the member a live token for the target app — a "connection".
    await issueAccessToken({ appId: targetAppId, userId: memberUserId, workspaceId, scopes: ['issues:read'] });

    const list = await request(app).get('/api/v1/connections').set(auth(adminToken));
    expect(list.status).toBe(200);
    const conn = list.body.data.find(
      (c: { app_id: string; user_id: string }) => c.app_id === targetAppId && c.user_id === memberUserId
    );
    expect(conn).toBeTruthy();
    expect(conn.active_token_count).toBeGreaterThanOrEqual(1);

    const revoked = await request(app)
      .delete(`/api/v1/connections/${targetAppId}/users/${memberUserId}`)
      .set(auth(adminToken));
    expect(revoked.status).toBe(200);
    expect(revoked.body.tokens_revoked).toBeGreaterThanOrEqual(1);

    // Idempotent: nothing left to revoke → 404.
    const again = await request(app)
      .delete(`/api/v1/connections/${targetAppId}/users/${memberUserId}`)
      .set(auth(adminToken));
    expect(again.status).toBe(404);
  });

  // ── Audit ───────────────────────────────────────────────────────────────

  it('queries the audit trail, workspace-scoped, with exclude_client_id', async () => {
    // The calls above were recorded on res.finish; make one more and query.
    await request(app).get('/api/v1/apps').set(auth(adminToken));
    // Audit writes happen on res.finish — give the event loop a beat.
    await new Promise((r) => setTimeout(r, 100));

    const res = await request(app).get('/api/v1/audit').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((row: { workspace_id: string }) => row.workspace_id === workspaceId)).toBe(true);

    // Excluding the caller's client hides its traffic.
    const callerClientId = res.body.data[0].client_id as string;
    const excluded = await request(app)
      .get('/api/v1/audit')
      .query({ exclude_client_id: callerClientId })
      .set(auth(adminToken));
    expect(excluded.status).toBe(200);
    expect(excluded.body.data.every((row: { client_id: string | null }) => row.client_id !== callerClientId)).toBe(true);

    // status_class filter validates.
    const bad = await request(app).get('/api/v1/audit').query({ status_class: 7 }).set(auth(adminToken));
    expect(bad.status).toBe(400);
  });
});
