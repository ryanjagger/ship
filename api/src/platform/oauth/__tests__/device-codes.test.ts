import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../db/client.js';
import { createOAuthApp } from '../apps.js';
import {
  issueDeviceCode,
  findDeviceByUserCode,
  approveDeviceCode,
  denyDeviceCode,
  pollDeviceCode,
  normalizeUserCode,
  formatUserCode,
} from '../device-codes.js';

/**
 * Device-code model (RFC 8628). Proves issuance, the user-code normalization,
 * atomic approve/deny, and the poll state machine — including slow_down rate
 * limiting and single-use redemption.
 */
describe('OAuth device-codes model', () => {
  let workspaceId: string;
  let userId: string;
  let appId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Device Model WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Device Model Tester') RETURNING id`,
      [`device-model-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const created = await createOAuthApp({
      name: 'Device Model App',
      redirectUris: [],
      ownerUserId: userId,
      requestedScopes: ['documents:read', 'documents:write'],
    });
    appId = created.app.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  // Move the poll clock back so a well-behaved (interval-spaced) re-poll doesn't
  // trip the slow_down rate limiter.
  const ageLastPoll = (userCode: string) =>
    pool.query(`UPDATE oauth_device_codes SET last_polled_at = now() - interval '30 seconds' WHERE user_code = $1`, [
      normalizeUserCode(userCode),
    ]);

  it('formats and normalizes user codes symmetrically', () => {
    expect(formatUserCode('WXYZ2345')).toBe('WXYZ-2345');
    expect(normalizeUserCode('wxyz-2345')).toBe('WXYZ2345');
    expect(normalizeUserCode(' wx yz-23 45 ')).toBe('WXYZ2345');
  });

  it('issues a device code with a dashed user code and 5s interval', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    expect(issued.deviceCode.startsWith('device_')).toBe(true);
    expect(issued.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(issued.intervalSeconds).toBe(5);
    expect(issued.expiresInSeconds).toBe(600);
    const row = await findDeviceByUserCode(issued.userCode);
    expect(row?.status).toBe('pending');
  });

  it('poll → pending before approval, then slow_down on a too-fast re-poll', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    expect(await pollDeviceCode(issued.deviceCode, appId)).toEqual({ state: 'pending' });
    // Immediate second poll is faster than the interval.
    expect(await pollDeviceCode(issued.deviceCode, appId)).toEqual({ state: 'slow_down' });
  });

  it('approve binds user+workspace; poll → approved grant, then single-use', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    const approved = await approveDeviceCode({ userCode: issued.userCode, userId, workspaceId });
    expect(approved?.status).toBe('approved');

    const first = await pollDeviceCode(issued.deviceCode, appId);
    expect(first).toEqual({
      state: 'approved',
      grant: { appId, userId, workspaceId, scopes: ['documents:read'] },
    });

    // A second redemption (even well-spaced) fails — the device_code is spent.
    await ageLastPoll(issued.userCode);
    expect(await pollDeviceCode(issued.deviceCode, appId)).toEqual({ state: 'invalid' });
  });

  it('deny → poll returns denied', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    const denied = await denyDeviceCode(issued.userCode);
    expect(denied?.status).toBe('denied');
    expect(await pollDeviceCode(issued.deviceCode, appId)).toEqual({ state: 'denied' });
  });

  it('expired code → poll returns expired', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    await pool.query(
      `UPDATE oauth_device_codes SET expires_at = now() - interval '1 minute' WHERE user_code = $1`,
      [normalizeUserCode(issued.userCode)]
    );
    expect(await pollDeviceCode(issued.deviceCode, appId)).toEqual({ state: 'expired' });
  });

  it('unknown device_code → invalid', async () => {
    expect(await pollDeviceCode('device_nope', appId)).toEqual({ state: 'invalid' });
  });

  it('a mismatched client (appId) → invalid, WITHOUT consuming the code', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    await approveDeviceCode({ userCode: issued.userCode, userId, workspaceId });
    // Wrong app polls → invalid and the code is NOT burned.
    expect(await pollDeviceCode(issued.deviceCode, '00000000-0000-0000-0000-000000000000')).toEqual({ state: 'invalid' });
    // The legitimate client can still redeem it.
    await ageLastPoll(issued.userCode);
    const ok = await pollDeviceCode(issued.deviceCode, appId);
    expect(ok.state).toBe('approved');
  });

  it('approve is atomic: a denied code cannot later be approved', async () => {
    const issued = await issueDeviceCode({ appId, scopes: ['documents:read'] });
    await denyDeviceCode(issued.userCode);
    const approved = await approveDeviceCode({ userCode: issued.userCode, userId, workspaceId });
    expect(approved).toBeNull();
  });
});
