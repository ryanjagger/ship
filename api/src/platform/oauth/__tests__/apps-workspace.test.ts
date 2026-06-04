import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../db/client.js';
import { createOAuthApp, listOAuthAppsForWorkspace, findOAuthAppForWorkspace } from '../apps.js';

/**
 * Workspace-scoped app helpers backing the developer portal (PRD §8). Apps have
 * no workspace_id; "apps in the workspace" = apps owned by a member of that
 * workspace. These guards must never leak another workspace's apps.
 */
describe('OAuth apps · workspace scoping', () => {
  let wsA: string;
  let wsB: string;
  let userA: string;
  let userB: string;
  let appA: string;
  let appB: string;

  beforeAll(async () => {
    const a = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('WS A') RETURNING id`);
    wsA = a.rows[0]!.id;
    const b = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('WS B') RETURNING id`);
    wsB = b.rows[0]!.id;
    const ua = await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, 'A') RETURNING id`, [`a-${Date.now()}@ship.local`]);
    userA = ua.rows[0]!.id;
    const ub = await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1, 'B') RETURNING id`, [`b-${Date.now()}@ship.local`]);
    userB = ub.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [wsA, userA]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [wsB, userB]);
    appA = (await createOAuthApp({ name: 'App A', redirectUris: ['https://a.example/cb'], ownerUserId: userA, requestedScopes: ['documents:read'] })).app.id;
    appB = (await createOAuthApp({ name: 'App B', redirectUris: ['https://b.example/cb'], ownerUserId: userB, requestedScopes: ['documents:read'] })).app.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = ANY($1)', [[appA, appB]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[wsA, wsB]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userA, userB]]);
  });

  it('lists only apps owned by a member of the workspace', async () => {
    const listA = await listOAuthAppsForWorkspace(wsA);
    const ids = listA.map((a) => a.id);
    expect(ids).toContain(appA);
    expect(ids).not.toContain(appB);
  });

  it('finds an app for its workspace but not for another', async () => {
    expect(await findOAuthAppForWorkspace(appA, wsA)).not.toBeNull();
    expect(await findOAuthAppForWorkspace(appA, wsB)).toBeNull();
  });
});
