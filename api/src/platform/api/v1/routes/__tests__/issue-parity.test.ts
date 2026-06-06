import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

/**
 * Issue write parity (issue #95 §2): /api/v1/issues POST/PATCH are
 * re-platformed onto the issues-service cores (the single source of truth the
 * internal route and the Fleet agent use). This suite is the GATE for that
 * blast radius: history rows, lifecycle timestamps, estimate-for-sprint
 * validation, the incomplete-children 409 confirm flow, client_id provenance,
 * and exactly-one webhook publish per write.
 */
describe('Platform API · issue write parity (issues-service cores)', () => {
  const app = createApp();
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let otherUserId: string;
  let appId: string;
  let clientId: string;
  let token: string;
  let otherWsToken: string;

  async function createIssueViaApi(body: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await request(app).post('/api/v1/issues').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Issue Parity WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const ws2 = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Issue Parity Other WS') RETURNING id`);
    otherWorkspaceId = ws2.rows[0]!.id;

    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Issue Parity Tester') RETURNING id`,
      [`issue-parity-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    const u2 = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Issue Parity Other') RETURNING id`,
      [`issue-parity-other-${Date.now()}@ship.local`]
    );
    otherUserId = u2.rows[0]!.id;

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, userId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, otherUserId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [otherWorkspaceId, userId]);

    const created = await createOAuthApp({
      name: 'Issue Parity App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['issues:read', 'issues:write', 'sprints:read'],
    });
    appId = created.app.id;
    clientId = created.app.client_id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:read', 'issues:write'] })).accessToken;
    otherWsToken = (await issueAccessToken({ appId, userId, workspaceId: otherWorkspaceId, scopes: ['issues:read', 'issues:write'] })).accessToken;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
  });

  it('POST keeps the v1 contract (estimate, content, DTO shape) and publishes exactly one created event', async () => {
    const body = await createIssueViaApi({
      title: 'Parity Create',
      state: 'todo',
      priority: 'high',
      estimate: 3,
      due_date: '2026-07-01',
      content: { type: 'doc', content: [] },
    });

    expect(body).not.toHaveProperty('document_type');
    expect(body).not.toHaveProperty('properties');
    expect(body).toMatchObject({ title: 'Parity Create', state: 'todo', priority: 'high', estimate: 3, due_date: '2026-07-01' });
    expect(body.display_id).toBe(`#${body.ticket_number}`);

    const doc = await pool.query(`SELECT content, visibility FROM documents WHERE id = $1`, [body.id]);
    expect(doc.rows[0]!.visibility).toBe('workspace');
    expect(doc.rows[0]!.content).toEqual({ type: 'doc', content: [] });

    // Exactly ONE issue.created event — the issues-service core publishes; the
    // generic typed-document core must not also run (double-publish check).
    const events = await pool.query(
      `SELECT type FROM webhook_events WHERE workspace_id = $1 AND type = 'issue.created' AND payload->'data'->'object'->>'id' = $2`,
      [workspaceId, body.id]
    );
    expect(events.rows.length).toBe(1);
  });

  it('PATCH writes document_history rows with client_id provenance and lifecycle timestamps', async () => {
    const issue = await createIssueViaApi({ title: 'Parity Lifecycle' });

    const patched = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'in_progress', priority: 'urgent' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ state: 'in_progress', priority: 'urgent' });
    expect(patched.body.started_at).toBeTruthy();

    const history = await pool.query(
      `SELECT field, old_value, new_value, changed_by, automated_by FROM document_history WHERE document_id = $1 ORDER BY field`,
      [issue.id]
    );
    expect(history.rows).toEqual([
      { field: 'priority', old_value: 'medium', new_value: 'urgent', changed_by: userId, automated_by: clientId },
      { field: 'state', old_value: 'backlog', new_value: 'in_progress', changed_by: userId, automated_by: clientId },
    ]);

    const done = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.completed_at).toBeTruthy();

    // Exactly one updated event per PATCH (plus its semantic events, which are
    // distinct types) — no double-publish.
    const events = await pool.query(
      `SELECT type, COUNT(*)::int AS n FROM webhook_events
        WHERE workspace_id = $1 AND payload->'data'->'object'->>'id' = $2 AND type = 'issue.updated'
        GROUP BY type`,
      [workspaceId, issue.id]
    );
    expect(events.rows).toEqual([{ type: 'issue.updated', n: 2 }]);
  });

  it('PATCH due_date and rejection_reason keep working and land in history', async () => {
    const issue = await createIssueViaApi({ title: 'Parity Due Date' });

    const patched = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ due_date: '2026-08-15', rejection_reason: 'needs spec' });
    expect(patched.status).toBe(200);
    expect(patched.body.due_date).toBe('2026-08-15');
    expect(patched.body.rejection_reason).toBe('needs spec');

    const history = await pool.query(
      `SELECT field FROM document_history WHERE document_id = $1 ORDER BY field`,
      [issue.id]
    );
    expect(history.rows.map((r: { field: string }) => r.field)).toEqual(['due_date', 'rejection_reason']);
  });

  it('PATCH enforces estimate-for-sprint validation (400 names the problem)', async () => {
    const sprint = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, visibility, created_by)
       VALUES ($1, 'sprint', 'Parity Sprint', '{"sprint_number": 1}', 'workspace', $2) RETURNING id`,
      [workspaceId, userId]
    );
    const issue = await createIssueViaApi({ title: 'Parity Sprint Assign' });

    const denied = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ belongs_to: [{ id: sprint.rows[0]!.id, type: 'sprint' }] });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('validation_failed');
    expect(denied.body.message).toMatch(/estimate/i);

    const allowed = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ estimate: 2, belongs_to: [{ id: sprint.rows[0]!.id, type: 'sprint' }] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.belongs_to).toEqual([expect.objectContaining({ id: sprint.rows[0]!.id, type: 'sprint' })]);
  });

  it('PATCH closing a parent with open children → 409 conflict; confirm_orphan_children → 200 and orphans them', async () => {
    const parent = await createIssueViaApi({ title: 'Parity Parent' });
    const child = await createIssueViaApi({ title: 'Parity Child', belongs_to: [{ id: parent.id, type: 'parent' }] });

    const conflict = await request(app)
      .patch(`/api/v1/issues/${parent.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'done' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('conflict');
    expect(conflict.body.details.reason).toBe('incomplete_children');
    expect(conflict.body.details.incomplete_children).toEqual([
      expect.objectContaining({ id: child.id, title: 'Parity Child' }),
    ]);
    expect(conflict.body.request_id).toEqual(expect.any(String));

    // The 409 must not have mutated anything.
    const unchanged = await pool.query(`SELECT properties->>'state' AS state FROM documents WHERE id = $1`, [parent.id]);
    expect(unchanged.rows[0]!.state).toBe('backlog');

    const confirmed = await request(app)
      .patch(`/api/v1/issues/${parent.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'done', confirm_orphan_children: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe('done');

    const associations = await pool.query(
      `SELECT 1 FROM document_associations WHERE document_id = $1 AND relationship_type = 'parent'`,
      [child.id]
    );
    expect(associations.rows.length).toBe(0);
  });

  it('PATCH 404s across workspaces and for invisible private issues', async () => {
    const issue = await createIssueViaApi({ title: 'Parity Cross WS' });

    const crossWs = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${otherWsToken}`)
      .send({ state: 'todo' });
    expect(crossWs.status).toBe(404);
    expect(crossWs.body.code).toBe('not_found');

    // A private issue created by another user is invisible to the token user.
    const privateIssue = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, properties, visibility, created_by, ticket_number)
       VALUES ($1, 'issue', 'Private Other', '{"state": "backlog"}', 'private', $2, 9999) RETURNING id`,
      [workspaceId, otherUserId]
    );
    const invisible = await request(app)
      .patch(`/api/v1/issues/${privateIssue.rows[0]!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'todo' });
    expect(invisible.status).toBe(404);
  });

  it('POST and PATCH still 400 on invalid belongs_to targets', async () => {
    const created = await request(app)
      .post('/api/v1/issues')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Bad Assoc', belongs_to: [{ id: '00000000-0000-0000-0000-000000000001', type: 'project' }] });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('validation_failed');
    expect(created.body.details.reason).toBe('invalid_belongs_to');

    const issue = await createIssueViaApi({ title: 'Bad Assoc Patch' });
    const patched = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ belongs_to: [{ id: '00000000-0000-0000-0000-000000000001', type: 'project' }] });
    expect(patched.status).toBe(400);
    expect(patched.body.details.reason).toBe('invalid_belongs_to');
  });

  it('PATCH with no updatable fields → validation_failed (confirm flag alone is not an update)', async () => {
    const issue = await createIssueViaApi({ title: 'Parity Empty Patch' });
    const empty = await request(app)
      .patch(`/api/v1/issues/${issue.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm_orphan_children: true });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('validation_failed');
  });
});
