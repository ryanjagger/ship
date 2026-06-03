import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { ShipClient, ShipApiError } from '@ryanjagger/ship-sdk';
import { createApp } from '../../../../app.js';
import { pool } from '../../../../db/client.js';
import { createOAuthApp } from '../../../oauth/apps.js';
import { issueAccessToken } from '../../../oauth/tokens.js';

/**
 * Hard acceptance for the SDK (PRD §5.8): `new ShipClient({ token }).me()`
 * returns the typed authenticated user, plus a documents round-trip.
 *
 * The SDK is driven against the real app through an injected, supertest-backed
 * fetch — exercising the SDK's actual transport without binding a real TCP
 * server/port (which would add a flaky resource to the shared test process).
 */

// Adapt the SDK's `fetch` to supertest so requests hit the in-process app.
function makeAppFetch(app: Express): typeof fetch {
  const impl = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    const { pathname, search } = new URL(url);
    const path = pathname + search;
    const method = (init.method ?? 'GET').toUpperCase();
    let req =
      method === 'POST'
        ? request(app).post(path)
        : method === 'PATCH'
          ? request(app).patch(path)
          : method === 'DELETE'
            ? request(app).delete(path)
            : request(app).get(path);
    for (const [k, v] of Object.entries(init.headers ?? {})) req = req.set(k, v);
    const res = init.body !== undefined ? await req.send(JSON.parse(init.body)) : await req;
    const text = res.text && res.text.length > 0 ? res.text : res.body ? JSON.stringify(res.body) : '';
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => text };
  };
  return impl as unknown as typeof fetch;
}

describe('@ryanjagger/ship-sdk · ShipClient against the in-process app', () => {
  const app = createApp();
  const appFetch = makeAppFetch(app);
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let token: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('SDK Test WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'SDK Tester') RETURNING id`,
      [`sdk-test-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const created = await createOAuthApp({
      name: 'SDK Test App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read', 'documents:write'],
    });
    appId = created.app.id;
    token = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['documents:read', 'documents:write'] }))
      .accessToken;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('me() returns the typed authenticated user', async () => {
    const client = new ShipClient({ token, baseUrl: 'http://app.local', fetch: appFetch });
    const me = await client.me();
    expect(me.id).toBe(userId);
    expect(me.name).toBe('SDK Tester');
    expect(me.workspace).toMatchObject({ id: workspaceId, name: 'SDK Test WS', role: 'admin' });
  });

  it('throws ShipApiError (code, status, request_id) on an invalid token', async () => {
    const client = new ShipClient({ token: 'ship_at_not_a_real_token', baseUrl: 'http://app.local', fetch: appFetch });
    await expect(client.me()).rejects.toBeInstanceOf(ShipApiError);
    try {
      await client.me();
      throw new Error('expected ShipApiError to be thrown');
    } catch (e) {
      const err = e as ShipApiError;
      expect(err.status).toBe(401);
      expect(err.code).toBe('unauthorized');
      expect(err.requestId).toBeTruthy();
    }
  });

  it('documents.create then documents.list round-trips through the SDK', async () => {
    const client = new ShipClient({ token, baseUrl: 'http://app.local', fetch: appFetch });
    const created = await client.documents.create({ title: 'From SDK', document_type: 'wiki' });
    expect(created.title).toBe('From SDK');
    const page = await client.documents.list({ limit: 50 });
    expect(page.data.some((d) => d.id === created.id)).toBe(true);
    expect(page).toHaveProperty('next_cursor');
  });

  it('typed resource clients use the typed public routes', async () => {
    const client = new ShipClient({ token, baseUrl: 'http://app.local', fetch: appFetch });
    const created = await client.issues.create({ title: 'Typed SDK Issue', state: 'todo', priority: 'high' });
    expect(created.state).toBe('todo');
    expect(created.priority).toBe('high');
    expect(created.display_id).toBe(`#${created.ticket_number}`);

    const updated = await client.issues.update(created.id, { title: 'Typed SDK Issue Updated' });
    expect(updated.title).toBe('Typed SDK Issue Updated');

    const page = await client.issues.list({ limit: 50 });
    expect(page.data.every((d) => d.state && 'display_id' in d)).toBe(true);
    await client.issues.delete(created.id);
  });
});
