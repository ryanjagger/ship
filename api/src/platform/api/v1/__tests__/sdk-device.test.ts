import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  requestDeviceAuthorization,
  pollDeviceToken,
  DeviceFlowError,
  ShipClient,
} from '@ryanjagger/ship-sdk';
import { createApp } from '../../../../app.js';
import { pool } from '../../../../db/client.js';
import { createOAuthApp } from '../../../oauth/apps.js';
import { approveDeviceCode, denyDeviceCode, normalizeUserCode } from '../../../oauth/device-codes.js';

/**
 * SDK device-flow helpers driven against the real app through an injected,
 * supertest-backed fetch (no real TCP server). Proves `requestDeviceAuthorization`
 * + `pollDeviceToken` complete the flow and yield a token usable by ShipClient.
 */
function makeAppFetch(app: Express): typeof fetch {
  const impl = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    const { pathname, search } = new URL(url);
    const path = pathname + search;
    const method = (init.method ?? 'GET').toUpperCase();
    let req = method === 'POST' ? request(app).post(path) : request(app).get(path);
    for (const [k, v] of Object.entries(init.headers ?? {})) req = req.set(k, v);
    const res = init.body !== undefined ? await req.send(JSON.parse(init.body)) : await req;
    const text = res.text && res.text.length > 0 ? res.text : res.body ? JSON.stringify(res.body) : '';
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => text };
  };
  return impl as unknown as typeof fetch;
}

describe('@ryanjagger/ship-sdk · device-flow helpers against the in-process app', () => {
  const app = createApp();
  const appFetch = makeAppFetch(app);
  const noSleep = () => Promise.resolve();
  const baseUrl = 'http://app.local';
  let workspaceId: string;
  let userId: string;
  let clientId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('SDK Device WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'SDK Device Tester') RETURNING id`,
      [`sdk-device-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const created = await createOAuthApp({
      name: 'SDK Device CLI',
      redirectUris: [],
      ownerUserId: userId,
      requestedScopes: ['documents:read', 'documents:write'],
      allowDeviceFlow: true,
    });
    clientId = created.app.client_id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE client_id = $1', [clientId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('requestDeviceAuthorization → approve → pollDeviceToken yields a working token', async () => {
    const auth = await requestDeviceAuthorization({ baseUrl, clientId, scope: 'documents:read', fetch: appFetch });
    expect(auth.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(auth.verification_uri_complete).toContain('/device?code=');

    // Approve out-of-band (the browser step), then poll.
    await approveDeviceCode({ userCode: auth.user_code, userId, workspaceId });

    const tokenRes = await pollDeviceToken({
      baseUrl,
      clientId,
      deviceCode: auth.device_code,
      fetch: appFetch,
      sleep: noSleep,
    });
    expect(tokenRes.token_type).toBe('Bearer');
    expect(tokenRes.access_token.startsWith('ship_at_')).toBe(true);

    // The token drives ShipClient.
    const client = new ShipClient({ token: tokenRes.access_token, baseUrl, fetch: appFetch });
    const me = await client.me();
    expect(me.id).toBe(userId);
  });

  it('pollDeviceToken throws DeviceFlowError(access_denied) when the user denies', async () => {
    const auth = await requestDeviceAuthorization({ baseUrl, clientId, fetch: appFetch });
    await denyDeviceCode(auth.user_code);
    await expect(
      pollDeviceToken({ baseUrl, clientId, deviceCode: auth.device_code, fetch: appFetch, sleep: noSleep })
    ).rejects.toMatchObject({ name: 'DeviceFlowError', error: 'access_denied' });
  });

  it('pollDeviceToken keeps waiting through authorization_pending, then succeeds', async () => {
    const auth = await requestDeviceAuthorization({ baseUrl, clientId, scope: 'documents:read', fetch: appFetch });
    // The sleep stub simulates a real interval passing (so the server doesn't
    // see a too-fast poll) by aging last_polled_at, and approves on the 2nd wait.
    let polls = 0;
    const simulateWait = async () => {
      polls += 1;
      await pool.query(
        `UPDATE oauth_device_codes SET last_polled_at = last_polled_at - interval '30 seconds' WHERE user_code = $1`,
        [normalizeUserCode(auth.user_code)]
      );
      if (polls === 2) await approveDeviceCode({ userCode: auth.user_code, userId, workspaceId });
    };
    const tokenRes = await pollDeviceToken({
      baseUrl,
      clientId,
      deviceCode: auth.device_code,
      fetch: appFetch,
      sleep: simulateWait,
    });
    expect(tokenRes.access_token.startsWith('ship_at_')).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(DeviceFlowError).toBeTruthy();
  });
});
