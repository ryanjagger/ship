import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

/**
 * Typed-document list filters (issue #95 §2): belongs_to (+ belongs_to_type),
 * state, updated_before/after, and visibility=workspace. The visibility filter
 * is load-bearing — agent-built shared context must never absorb the acting
 * viewer's private rows.
 */
describe('Platform API · typed-document list filters', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let token: string;
  let projectId: string;
  let otherProjectId: string;
  let inProjectIssueId: string;
  let parentIssueId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Filters WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Filters Tester') RETURNING id`,
      [`filters-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, userId]);

    const created = await createOAuthApp({
      name: 'Filters Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['issues:read', 'issues:write', 'projects:read'],
    });
    appId = created.app.id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:read', 'issues:write', 'projects:read'] })).accessToken;

    const project = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'project', 'Filter Project', 'workspace', $2) RETURNING id`,
      [workspaceId, userId]
    );
    projectId = project.rows[0]!.id;
    const otherProject = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'project', 'Other Project', 'workspace', $2) RETURNING id`,
      [workspaceId, userId]
    );
    otherProjectId = otherProject.rows[0]!.id;

    // Issues: one in the project (todo), one parented to another issue (done),
    // one unassociated (backlog), one PRIVATE owned by the token user.
    const mkIssue = async (title: string, props: Record<string, unknown>, visibility = 'workspace', ticket = 0): Promise<string> => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, document_type, title, properties, visibility, created_by, ticket_number)
         VALUES ($1, 'issue', $2, $3, $4, $5, $6) RETURNING id`,
        [workspaceId, title, JSON.stringify(props), visibility, userId, ticket]
      );
      return r.rows[0]!.id;
    };
    inProjectIssueId = await mkIssue('In Project', { state: 'todo' }, 'workspace', 1);
    parentIssueId = await mkIssue('Parent Issue', { state: 'backlog' }, 'workspace', 2);
    const childIssueId = await mkIssue('Child Issue', { state: 'done' }, 'workspace', 3);
    await mkIssue('Unassociated', { state: 'backlog' }, 'workspace', 4);
    await mkIssue('My Private Issue', { state: 'todo' }, 'private', 5);

    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'project')`,
      [inProjectIssueId, projectId]
    );
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'parent')`,
      [childIssueId, parentIssueId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  async function listIssues(query: string): Promise<Array<{ title: string }>> {
    const res = await request(app).get(`/api/v1/issues?${query}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.data;
  }

  it('belongs_to returns only associated documents', async () => {
    const rows = await listIssues(`belongs_to=${projectId}`);
    expect(rows.map((r) => r.title)).toEqual(['In Project']);

    const none = await listIssues(`belongs_to=${otherProjectId}`);
    expect(none).toEqual([]);
  });

  it('belongs_to_type narrows the relationship', async () => {
    const asProject = await listIssues(`belongs_to=${parentIssueId}&belongs_to_type=parent`);
    expect(asProject.map((r) => r.title)).toEqual(['Child Issue']);

    const wrongType = await listIssues(`belongs_to=${parentIssueId}&belongs_to_type=project`);
    expect(wrongType).toEqual([]);
  });

  it('state filters on the issue state', async () => {
    const rows = await listIssues('state=done');
    expect(rows.map((r) => r.title)).toEqual(['Child Issue']);
  });

  it('updated_after / updated_before bound the window', async () => {
    const future = await listIssues(`updated_after=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    expect(future).toEqual([]);

    const past = await listIssues(`updated_before=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
    expect(past).toEqual([]);

    const all = await listIssues(`updated_after=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`);
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it('visibility=workspace excludes the caller\'s own private documents', async () => {
    const defaultRows = await listIssues('');
    expect(defaultRows.map((r) => r.title)).toContain('My Private Issue');

    const workspaceOnly = await listIssues('visibility=workspace');
    expect(workspaceOnly.map((r) => r.title)).not.toContain('My Private Issue');
    expect(workspaceOnly.length).toBe(defaultRows.length - 1);
  });

  it('rejects an invalid filter value', async () => {
    const res = await request(app).get('/api/v1/issues?state=bogus').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });
});
