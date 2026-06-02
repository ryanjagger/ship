import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

/**
 * Typed resources (PRD §1, §4): `/api/v1/issues`, `/sprints`, `/wiki`. Proves
 * the properties that make them more than an alias for `/documents`:
 *  - each resource is PINNED to one document_type (list + by-id are isolated),
 *  - the narrow `{type}:read|write` scopes gate them,
 *  - the privilege hierarchy is LIVE: a `documents:*` token reaches them, but a
 *    typed token does NOT reach the superset `/documents` (one-way),
 *  - POST forces the pinned type (you can't create a wiki via `/issues`).
 */
describe('Platform API · typed resources (issues/sprints/wiki)', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let issuesReadToken: string;
  let issuesWriteToken: string;
  let docsReadToken: string;
  let docsWriteToken: string;
  let issueId: string;
  let wikiId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Typed Test WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Typed Tester') RETURNING id`,
      [`typed-test-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);

    const created = await createOAuthApp({
      name: 'Typed Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read', 'documents:write', 'issues:read', 'issues:write'],
    });
    appId = created.app.id;
    issuesReadToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:read'] })).accessToken;
    issuesWriteToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:write'] })).accessToken;
    docsReadToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] })).accessToken;
    docsWriteToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:write'] })).accessToken;

    const seed = async (type: string, title: string): Promise<string> => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
         VALUES ($1, $2::document_type, $3, 'workspace', $4) RETURNING id`,
        [workspaceId, type, title, userId]
      );
      return r.rows[0]!.id;
    };
    issueId = await seed('issue', 'Seed Issue');
    wikiId = await seed('wiki', 'Seed Wiki');
    await seed('sprint', 'Seed Sprint');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]); // cascades docs/tokens/memberships
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('GET /issues returns ONLY issues (type-pinned)', async () => {
    const res = await request(app).get('/api/v1/issues').set('Authorization', `Bearer ${issuesReadToken}`);
    expect(res.status).toBe(200);
    const types = (res.body.data as Array<{ document_type: string }>).map((d) => d.document_type);
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set(['issue']));
    expect(res.body).toHaveProperty('next_cursor');
  });

  it('GET /issues/:id resolves an issue but 404s a wiki id (type isolation)', async () => {
    const ok = await request(app).get(`/api/v1/issues/${issueId}`).set('Authorization', `Bearer ${issuesReadToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.document_type).toBe('issue');

    const miss = await request(app).get(`/api/v1/issues/${wikiId}`).set('Authorization', `Bearer ${issuesReadToken}`);
    expect(miss.status).toBe(404);
    expect(miss.body.code).toBe('not_found');
    expect(miss.body.message).toContain('Issue');
  });

  it('a documents:read token reaches /issues via the scope hierarchy', async () => {
    const res = await request(app).get('/api/v1/issues').set('Authorization', `Bearer ${docsReadToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('the hierarchy is one-way: an issues:read token is denied /documents (403 naming documents:read)', async () => {
    const res = await request(app).get('/api/v1/documents').set('Authorization', `Bearer ${issuesReadToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.details?.required_scope).toBe('documents:read');
  });

  it('POST /issues with issues:read → 403 naming issues:write', async () => {
    const res = await request(app)
      .post('/api/v1/issues')
      .set('Authorization', `Bearer ${issuesReadToken}`)
      .send({ title: 'No write scope' });
    expect(res.status).toBe(403);
    expect(res.body.details?.required_scope).toBe('issues:write');
  });

  it('POST /issues with issues:write → 201, type forced to issue (ignores body document_type)', async () => {
    const res = await request(app)
      .post('/api/v1/issues')
      .set('Authorization', `Bearer ${issuesWriteToken}`)
      .send({ title: 'Made via /issues', document_type: 'wiki' });
    expect(res.status).toBe(201);
    expect(res.body.document_type).toBe('issue');
    expect(res.body.title).toBe('Made via /issues');
  });

  it('POST /issues with documents:write → 201 (write hierarchy is live)', async () => {
    const res = await request(app)
      .post('/api/v1/issues')
      .set('Authorization', `Bearer ${docsWriteToken}`)
      .send({ title: 'Made by superset token' });
    expect(res.status).toBe(201);
    expect(res.body.document_type).toBe('issue');
  });

  it('GET /wiki returns only wiki pages and a documents:read token reaches it', async () => {
    const res = await request(app).get('/api/v1/wiki').set('Authorization', `Bearer ${docsReadToken}`);
    expect(res.status).toBe(200);
    const types = (res.body.data as Array<{ document_type: string }>).map((d) => d.document_type);
    expect(new Set(types)).toEqual(new Set(['wiki']));
  });
});
