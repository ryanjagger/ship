import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

/**
 * Public comments + document-history routes (issue #95 §2): scope denial names
 * the scope, target-document visibility 404s, cross-workspace 404s, and the
 * cross-document history query with visibility-filtered rows.
 */
describe('Platform API · comments + document history', () => {
  const app = createApp();
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let otherUserId: string;
  let appId: string;
  let token: string;
  let commentScopesToken: string;
  let noScopeToken: string;
  let otherWsToken: string;
  let projectId: string;
  let privateDocId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Comments WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const ws2 = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Comments Other WS') RETURNING id`);
    otherWorkspaceId = ws2.rows[0]!.id;

    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Comments Tester') RETURNING id`,
      [`comments-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    const u2 = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Comments Other') RETURNING id`,
      [`comments-other-${Date.now()}@ship.local`]
    );
    otherUserId = u2.rows[0]!.id;

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, userId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, otherUserId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [otherWorkspaceId, userId]);

    const created = await createOAuthApp({
      name: 'Comments Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['comments:read', 'comments:write', 'documents:read', 'documents:write', 'issues:read', 'issues:write'],
    });
    appId = created.app.id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['comments:read', 'comments:write', 'documents:read', 'issues:write', 'issues:read'] })).accessToken;
    commentScopesToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['comments:read', 'comments:write'] })).accessToken;
    noScopeToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:read'] })).accessToken;
    otherWsToken = (await issueAccessToken({ appId, userId, workspaceId: otherWorkspaceId, scopes: ['comments:read', 'comments:write', 'documents:read'] })).accessToken;

    const project = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'project', 'Commented Project', 'workspace', $2) RETURNING id`,
      [workspaceId, userId]
    );
    projectId = project.rows[0]!.id;

    const privateDoc = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'project', 'Private Other Project', 'private', $2) RETURNING id`,
      [workspaceId, otherUserId]
    );
    privateDocId = privateDoc.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
  });

  describe('comments', () => {
    it('403 names the required scopes on read and write', async () => {
      const read = await request(app)
        .get(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${noScopeToken}`);
      expect(read.status).toBe(403);
      expect(read.body.code).toBe('forbidden');
      expect(read.body.details.required_scopes).toEqual(['comments:read', 'documents:read']);

      const write = await request(app)
        .post(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${noScopeToken}`)
        .send({ content: 'nope' });
      expect(write.status).toBe(403);
      expect(write.body.details.required_scopes).toEqual(['comments:write', 'documents:write']);
    });

    it('posts and lists comments with the narrow comments scopes only', async () => {
      const created = await request(app)
        .post(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${commentScopesToken}`)
        .send({ content: 'First!' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        document_id: projectId,
        parent_id: null,
        content: 'First!',
        author: { id: userId, name: 'Comments Tester' },
      });
      expect(created.body.comment_id).toEqual(expect.any(String));

      const reply = await request(app)
        .post(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${commentScopesToken}`)
        .send({ content: 'A reply', parent_id: created.body.id, comment_id: created.body.comment_id });
      expect(reply.status).toBe(201);
      expect(reply.body.parent_id).toBe(created.body.id);

      const listed = await request(app)
        .get(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${commentScopesToken}`);
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((c: { content: string }) => c.content)).toEqual(['First!', 'A reply']);
    });

    it('404s on a reply to a parent from another document', async () => {
      const res = await request(app)
        .post(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'orphan reply', parent_id: randomUUID() });
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/parent comment/i);
    });

    it('404s when the target document is invisible (private, cross-workspace, or absent)', async () => {
      const privateRead = await request(app)
        .get(`/api/v1/documents/${privateDocId}/comments`)
        .set('Authorization', `Bearer ${token}`);
      expect(privateRead.status).toBe(404);

      const privateWrite = await request(app)
        .post(`/api/v1/documents/${privateDocId}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'should not land' });
      expect(privateWrite.status).toBe(404);

      const crossWs = await request(app)
        .get(`/api/v1/documents/${projectId}/comments`)
        .set('Authorization', `Bearer ${otherWsToken}`);
      expect(crossWs.status).toBe(404);

      const absent = await request(app)
        .get(`/api/v1/documents/${randomUUID()}/comments`)
        .set('Authorization', `Bearer ${token}`);
      expect(absent.status).toBe(404);
    });
  });

  describe('document history', () => {
    let issueA: string;
    let issueB: string;

    beforeAll(async () => {
      // Drive real history through the re-platformed v1 issue PATCH.
      const a = await request(app).post('/api/v1/issues').set('Authorization', `Bearer ${token}`).send({ title: 'History A' });
      issueA = a.body.id;
      const b = await request(app).post('/api/v1/issues').set('Authorization', `Bearer ${token}`).send({ title: 'History B' });
      issueB = b.body.id;
      await request(app).patch(`/api/v1/issues/${issueA}`).set('Authorization', `Bearer ${token}`).send({ state: 'in_progress' });
      await request(app).patch(`/api/v1/issues/${issueA}`).set('Authorization', `Bearer ${token}`).send({ priority: 'high' });
      await request(app).patch(`/api/v1/issues/${issueB}`).set('Authorization', `Bearer ${token}`).send({ state: 'todo' });
    });

    it('403 names documents:read', async () => {
      const res = await request(app)
        .get(`/api/v1/document-history?document_id=${issueA}`)
        .set('Authorization', `Bearer ${commentScopesToken}`);
      expect(res.status).toBe(403);
      expect(res.body.details.required_scope).toBe('documents:read');
    });

    it('returns history across repeated document_ids, newest first', async () => {
      const res = await request(app)
        .get(`/api/v1/document-history?document_id=${issueA}&document_id=${issueB}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const rows = res.body.data as Array<{ document_id: string; field: string; automated_by: string | null; created_at: string }>;
      expect(rows.length).toBe(3);
      expect(new Set(rows.map((r) => r.document_id))).toEqual(new Set([issueA, issueB]));
      const times = rows.map((r) => new Date(r.created_at).getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);
    });

    it('filters by field and respects limit', async () => {
      const res = await request(app)
        .get(`/api/v1/document-history?document_id=${issueA}&document_id=${issueB}&field=state`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((r: { field: string }) => r.field === 'state')).toBe(true);
      expect(res.body.data.length).toBe(2);

      const limited = await request(app)
        .get(`/api/v1/document-history?document_id=${issueA}&document_id=${issueB}&limit=1`)
        .set('Authorization', `Bearer ${token}`);
      expect(limited.body.data.length).toBe(1);
    });

    it('silently omits rows for invisible documents instead of failing the batch', async () => {
      // History on another user's private doc, written directly.
      await pool.query(
        `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by)
         VALUES ($1, 'state', 'backlog', 'todo', $2)`,
        [privateDocId, otherUserId]
      );
      const res = await request(app)
        .get(`/api/v1/document-history?document_id=${issueA}&document_id=${privateDocId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((r: { document_id: string }) => r.document_id === issueA)).toBe(true);
    });

    it('omits rows for ARCHIVED documents (same read posture as GET/list)', async () => {
      // Codex P2 regression: archived documents are hidden by every other v1
      // read; their history must not leak through this endpoint.
      const archived = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, archived_at)
         VALUES ($1, 'project', 'Archived Project', 'workspace', $2, now()) RETURNING id`,
        [workspaceId, userId]
      );
      await pool.query(
        `INSERT INTO document_history (document_id, field, old_value, new_value, changed_by)
         VALUES ($1, 'state', 'active', 'archived', $2)`,
        [archived.rows[0]!.id, userId]
      );
      const res = await request(app)
        .get(`/api/v1/document-history?document_id=${issueA}&document_id=${archived.rows[0]!.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((r: { document_id: string }) => r.document_id === issueA)).toBe(true);
    });

    it('rejects more than 100 document_ids', async () => {
      const ids = Array.from({ length: 101 }, () => `document_id=${randomUUID()}`).join('&');
      const res = await request(app)
        .get(`/api/v1/document-history?${ids}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });
});
