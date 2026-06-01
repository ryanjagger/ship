import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { ShipClient, ShipApiError } from '@ship/sdk';
import { createApp } from '../../../../app.js';
import { pool } from '../../../../db/client.js';
import { createOAuthApp } from '../../../oauth/apps.js';
import { issueAccessToken } from '../../../oauth/tokens.js';

/**
 * Hard acceptance for the SDK (PRD §5.8): `new ShipClient({ token }).me()`
 * returns the typed authenticated user. Driven against a real HTTP server
 * (ephemeral port) so the SDK's actual fetch transport is exercised.
 */
describe('@ship/sdk · ShipClient against a live server', () => {
  let server: http.Server;
  let baseUrl: string;
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

    server = http.createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('me() returns the typed authenticated user', async () => {
    const client = new ShipClient({ token, baseUrl });
    const me = await client.me();
    expect(me.id).toBe(userId);
    expect(me.name).toBe('SDK Tester');
    expect(me.workspace).toMatchObject({ id: workspaceId, name: 'SDK Test WS', role: 'admin' });
  });

  it('throws ShipApiError (code, status, request_id) on an invalid token', async () => {
    const client = new ShipClient({ token: 'ship_at_not_a_real_token', baseUrl });
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
    const client = new ShipClient({ token, baseUrl });
    const created = await client.documents.create({ title: 'From SDK', document_type: 'wiki' });
    expect(created.title).toBe('From SDK');
    const page = await client.documents.list({ limit: 50 });
    expect(page.data.some((d) => d.id === created.id)).toBe(true);
    expect(page).toHaveProperty('next_cursor');
  });
});
