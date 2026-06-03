import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';
import { TYPED_DOCUMENT_RESOURCES } from '../../schemas/typed-document.js';

describe('Platform API · typed document-backed resources', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let typedToken: string;
  let broadReadToken: string;
  let issueOnlyToken: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Typed API Test WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Typed API Tester') RETURNING id`,
      [`typed-api-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);

    const requestedScopes = [
      'documents:read',
      'documents:write',
      ...TYPED_DOCUMENT_RESOURCES.flatMap((resource) => [resource.readScope, resource.writeScope]),
    ];
    const created = await createOAuthApp({
      name: 'Typed API Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes,
    });
    appId = created.app.id;
    typedToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: requestedScopes })).accessToken;
    broadReadToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] })).accessToken;
    issueOnlyToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:read'] })).accessToken;

    for (const [index, resource] of TYPED_DOCUMENT_RESOURCES.entries()) {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, created_at)
         VALUES ($1, $2::document_type, $3, 'workspace', $4, now() + ($5 || ' seconds')::interval)`,
        [workspaceId, resource.documentType, `${resource.name} Seed`, userId, String(index + 1)]
      );
    }
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'conversation', 'Hidden Conversation', 'workspace', $2)`,
      [workspaceId, userId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it.each(TYPED_DOCUMENT_RESOURCES)('GET /$path returns only $documentType rows', async (resource) => {
    const res = await request(app).get(`/api/v1/${resource.path}`).set('Authorization', `Bearer ${typedToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data as Array<Record<string, unknown>>) {
      expect(row).toHaveProperty('id');
      expect(row).not.toHaveProperty('document_type');
      expect(row).not.toHaveProperty('properties');
      if (resource.documentType === 'issue') {
        expect(row).toMatchObject({ state: 'backlog', priority: 'medium', source: 'internal' });
      } else if (resource.documentType === 'sprint') {
        expect(row).toMatchObject({ sprint_number: 1, status: 'planning' });
      } else if (resource.documentType === 'program') {
        expect(row).toHaveProperty('name');
      }
    }
  });

  it('accepts documents:read as a broad migration superscope', async () => {
    const res = await request(app).get('/api/v1/issues').set('Authorization', `Bearer ${broadReadToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((row: { state: string; display_id: string }) => row.state && 'display_id' in row)).toBe(true);
  });

  it('rejects an unrelated typed scope', async () => {
    const res = await request(app).get('/api/v1/projects').set('Authorization', `Bearer ${issueOnlyToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.details.required_scopes).toEqual(['projects:read', 'documents:read']);
  });

  it('creates, updates, gets, and deletes through the typed route', async () => {
    const created = await request(app)
      .post('/api/v1/wiki-pages')
      .set('Authorization', `Bearer ${typedToken}`)
      .send({ title: 'Typed Wiki', maintainer_id: userId });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('document_type');
    expect(created.body).toMatchObject({ title: 'Typed Wiki', maintainer_id: userId });

    const patched = await request(app)
      .patch(`/api/v1/wiki-pages/${created.body.id}`)
      .set('Authorization', `Bearer ${typedToken}`)
      .send({ title: 'Typed Wiki Updated', maintainer_id: null });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Typed Wiki Updated');
    expect(patched.body.maintainer_id).toBeNull();

    const fetched = await request(app)
      .get(`/api/v1/wiki-pages/${created.body.id}`)
      .set('Authorization', `Bearer ${typedToken}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);

    const deleted = await request(app)
      .delete(`/api/v1/wiki-pages/${created.body.id}`)
      .set('Authorization', `Bearer ${typedToken}`);
    expect(deleted.status).toBe(204);
  });

  it('creates issues with native fields and ticket numbering', async () => {
    const created = await request(app)
      .post('/api/v1/issues')
      .set('Authorization', `Bearer ${typedToken}`)
      .send({ title: 'Typed Native Issue', state: 'todo', priority: 'high' });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('document_type');
    expect(created.body).not.toHaveProperty('properties');
    expect(created.body).toMatchObject({ title: 'Typed Native Issue', state: 'todo', priority: 'high' });
    expect(created.body.ticket_number).toEqual(expect.any(Number));
    expect(created.body.display_id).toBe(`#${created.body.ticket_number}`);

    await request(app).delete(`/api/v1/issues/${created.body.id}`).set('Authorization', `Bearer ${typedToken}`);
  });

  it('does not expose internal conversation/insight routes', async () => {
    const res = await request(app).get('/api/v1/conversations').set('Authorization', `Bearer ${typedToken}`);
    expect(res.status).toBe(404);
  });
});
