/**
 * Fleet API client tests — mint, cache, the `${userId}:${workspaceId}` cache
 * key invariant (PR #94 review), and the single 401 re-mint retry. Uses the
 * supertest fetch adapter, so SDK requests run through the real bearer
 * middleware / scopes / rate-limit / audit stack with no listening socket.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../app.js';
import { pool } from '../../db/client.js';
import { supertestFetch } from '../../test-utils/supertest-fetch.js';
import {
  configureFleetApiClient,
  withFleetClient,
  resetFleetApiClient,
  FLEET_AGENT_CLIENT_ID,
} from './api-client.js';

describe('fleetgraph api-client', () => {
  const app = createApp();
  let workspaceId: string;
  let userA: string;
  let userB: string;
  let fleetAppId: string;

  beforeAll(async () => {
    // The fixture-of-record is migration 062; tests recreate the row because
    // the suite TRUNCATEs users (cascading to oauth_apps) per file.
    const appRow = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, client_type, allow_device_flow, is_system)
       VALUES ($1, NULL, 'Fleet Agent', ARRAY[]::text[], NULL, ARRAY['projects:read', 'projects:write', 'issues:read', 'issues:write', 'sprints:read', 'programs:read', 'people:read', 'standups:read', 'comments:read', 'comments:write', 'documents:read'], 'public', false, true)
       RETURNING id`,
      [FLEET_AGENT_CLIENT_ID]
    );
    fleetAppId = appRow.rows[0]!.id;

    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Fleet Client WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Fleet User A') RETURNING id`,
      [`fleet-client-a-${Date.now()}@ship.local`]
    );
    userA = a.rows[0]!.id;
    const b = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Fleet User B') RETURNING id`,
      [`fleet-client-b-${Date.now()}@ship.local`]
    );
    userB = b.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [workspaceId, userA]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, userB]);
  });

  afterAll(async () => {
    resetFleetApiClient();
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [fleetAppId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userA, userB]]);
  });

  beforeEach(async () => {
    resetFleetApiClient();
    configureFleetApiClient({ baseUrl: '', fetch: supertestFetch(app) });
    // Each test counts mints from a clean slate.
    await pool.query('DELETE FROM access_tokens WHERE app_id = $1', [fleetAppId]);
  });

  async function tokenCount(userId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM access_tokens WHERE app_id = $1 AND user_id = $2 AND workspace_id = $3`,
      [fleetAppId, userId, workspaceId]
    );
    return Number(r.rows[0]!.n);
  }

  it('throws when not configured', async () => {
    resetFleetApiClient();
    await expect(withFleetClient({ userId: userA, workspaceId }, async () => null)).rejects.toThrow(/not configured/);
  });

  it('mints once and reuses the cached token across calls for the same (user, workspace)', async () => {
    const first = await withFleetClient({ userId: userA, workspaceId }, (client) => client.projects.list());
    expect(first.data).toEqual([]);
    const before = await tokenCount(userA);
    expect(before).toBe(1);

    await withFleetClient({ userId: userA, workspaceId }, (client) => client.issues.list());
    expect(await tokenCount(userA)).toBe(1); // no second mint

    const row = await pool.query<{ expires_at: string; scopes: string[] }>(
      `SELECT expires_at, scopes FROM access_tokens WHERE app_id = $1 AND user_id = $2`,
      [fleetAppId, userA]
    );
    // 15-minute TTL (±2min slack for clock skew in CI).
    const ttlMs = new Date(row.rows[0]!.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(13 * 60 * 1000);
    expect(ttlMs).toBeLessThan(16 * 60 * 1000);
    // Token scopes are exactly the app's registered scopes.
    expect(row.rows[0]!.scopes).toContain('issues:write');
    expect(row.rows[0]!.scopes).toContain('documents:read');
  });

  it('INVARIANT: two users in the same workspace get distinct tokens — the second call must not reuse the first token', async () => {
    await withFleetClient({ userId: userA, workspaceId }, (client) => client.projects.list());
    await withFleetClient({ userId: userB, workspaceId }, (client) => client.projects.list());

    // One mint per identity; B's call did NOT ride A's cached token.
    expect(await tokenCount(userA)).toBe(1);
    expect(await tokenCount(userB)).toBe(1);

    // And the requests authenticated as their own users (visibility check):
    // a private project of A's is visible through A's client only.
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'project', 'A Private Project', 'private', $2)`,
      [workspaceId, userA]
    );
    const asA = await withFleetClient({ userId: userA, workspaceId }, (client) => client.projects.list());
    const asB = await withFleetClient({ userId: userB, workspaceId }, (client) => client.projects.list());
    expect(asA.data.map((p) => p.title)).toContain('A Private Project');
    expect(asB.data.map((p) => p.title)).not.toContain('A Private Project');
  });

  it('re-mints exactly once on a 401 (revoked token) and succeeds', async () => {
    await withFleetClient({ userId: userA, workspaceId }, (client) => client.projects.list());
    // Revoke the cached token server-side — the next request 401s.
    await pool.query(`UPDATE access_tokens SET revoked_at = now() WHERE app_id = $1 AND user_id = $2`, [fleetAppId, userA]);

    const result = await withFleetClient({ userId: userA, workspaceId }, (client) => client.projects.list());
    expect(Array.isArray(result.data)).toBe(true);
    expect(await tokenCount(userA)).toBe(2); // original + the one retry mint
  });

  it('does NOT re-mint on a 403 (real authorization answer)', async () => {
    // people:write is not in the app's scopes → scope denial.
    await expect(
      withFleetClient({ userId: userA, workspaceId }, (client) => client.people.create({ name: 'Nope' }))
    ).rejects.toMatchObject({ status: 403 });
    expect(await tokenCount(userA)).toBe(1); // the initial mint only
  });
});
