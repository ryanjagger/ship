import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

/**
 * The `documents` resource (PRD §5.5) + live scope enforcement (§2, §6). Proves:
 *  - read token lists/gets documents (any user-facing type), excludes the
 *    backing-store types (conversation/insight),
 *  - read-only token → POST is 403 naming `documents:write`,
 *  - write token → POST succeeds,
 *  - the cursor envelope paginates over the stable (created_at,id) sort.
 */
describe('Platform API · documents resource', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let readToken: string;
  let writeToken: string;
  let wikiId: string;
  let conversationId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Docs Test WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Docs Tester') RETURNING id`,
      [`docs-test-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);

    const created = await createOAuthApp({
      name: 'Docs Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read', 'documents:write'],
    });
    appId = created.app.id;
    readToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read'] })).accessToken;
    writeToken = (
      await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read', 'documents:write'] })
    ).accessToken;

    // Seed: 3 user-facing docs (staggered created_at for deterministic order) +
    // 2 backing-store docs that must never surface publicly.
    const seed = async (type: string, title: string, offsetSeconds: number): Promise<string> => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, created_at)
         VALUES ($1, $2::document_type, $3, 'workspace', $4, now() + ($5 || ' seconds')::interval)
         RETURNING id`,
        [workspaceId, type, title, userId, String(offsetSeconds)]
      );
      return r.rows[0]!.id;
    };
    wikiId = await seed('wiki', 'Public Wiki One', 1);
    await seed('issue', 'Public Issue', 2);
    await seed('wiki', 'Public Wiki Two', 3);
    // A backing-store doc that must never surface publicly. (insight has a
    // properties-shape check constraint and is excluded by the same mechanism,
    // so conversation alone proves the exclusion.)
    conversationId = await seed('conversation', 'Hidden Conversation', 4);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]); // cascades docs/tokens/memberships
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('GET /documents returns user-facing docs and excludes conversation/insight', async () => {
    const res = await request(app).get('/api/v1/documents').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const types = (res.body.data as Array<{ document_type: string; document_type_id?: string }>).map((d) => d.document_type);
    expect(types).not.toContain('conversation');
    expect(types).not.toContain('insight');
    // Our 3 user-facing seeds are present; each row carries its document_type.
    expect(res.body.data.length).toBe(3);
    expect(new Set(types)).toEqual(new Set(['wiki', 'issue']));
    expect(res.body).toHaveProperty('next_cursor');
  });

  it('GET /documents/:id returns a document with content', async () => {
    const res = await request(app).get(`/api/v1/documents/${wikiId}`).set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(wikiId);
    expect(res.body.document_type).toBe('wiki');
    expect(res.body).toHaveProperty('content');
  });

  it('GET /documents/:id on a backing-store doc 404s (excluded)', async () => {
    const res = await request(app).get(`/api/v1/documents/${conversationId}`).set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('POST /documents with a read-only token → 403 naming documents:write', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${readToken}`)
      .send({ title: 'Should Fail', document_type: 'wiki' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.message).toContain('documents:write');
    expect(res.body.details?.required_scope).toBe('documents:write');
  });

  it('POST /documents with a write token → 201 created', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ title: 'Created Via API', document_type: 'wiki' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Created Via API');
    expect(res.body.document_type).toBe('wiki');
    expect(res.body).toHaveProperty('content');
  });

  it('POST /documents rejects a backing-store document_type (validation_failed)', async () => {
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ title: 'Sneaky', document_type: 'conversation' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('GET /documents/:id on an archived doc 404s (hidden like the list)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, archived_at)
       VALUES ($1, 'wiki', 'Archived Wiki', 'workspace', $2, now()) RETURNING id`,
      [workspaceId, userId]
    );
    const res = await request(app)
      .get(`/api/v1/documents/${r.rows[0]!.id}`)
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('paginates via the cursor envelope over a stable sort', async () => {
    const first = await request(app).get('/api/v1/documents?limit=2').set('Authorization', `Bearer ${writeToken}`);
    expect(first.status).toBe(200);
    expect(first.body.data.length).toBe(2);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await request(app)
      .get(`/api/v1/documents?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('Authorization', `Bearer ${writeToken}`);
    expect(second.status).toBe(200);
    // Pages are disjoint (stable keyset pagination).
    const firstIds = new Set((first.body.data as Array<{ id: string }>).map((d) => d.id));
    for (const row of second.body.data as Array<{ id: string }>) {
      expect(firstIds.has(row.id)).toBe(false);
    }
  });
});
