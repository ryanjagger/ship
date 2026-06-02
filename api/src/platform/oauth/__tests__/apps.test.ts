import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../../../db/client.js';
import {
  createOAuthApp,
  findOAuthAppByClientId,
  verifyClientSecret,
  isRegisteredRedirectUri,
  listOAuthApps,
  rotateClientSecret,
  deleteOAuthApp,
} from '../apps.js';

describe('OAuth app model (PRD §5.2)', () => {
  const createdClientIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];

  afterAll(async () => {
    for (const clientId of createdClientIds) {
      await pool.query('DELETE FROM oauth_apps WHERE client_id = $1', [clientId]);
    }
    for (const id of createdWorkspaceIds) {
      await pool.query('DELETE FROM workspaces WHERE id = $1', [id]);
    }
    for (const id of createdUserIds) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  it('creates an app, returns the raw secret once, and stores only the bcrypt hash', async () => {
    const { app, clientSecret } = await createOAuthApp({
      name: 'Test Grader App',
      redirectUris: ['https://grader.example.com/callback'],
      ownerUserId: null,
      requestedScopes: ['documents:read'],
    });
    createdClientIds.push(app.client_id);

    expect(app.client_id).toMatch(/^client_[0-9a-f]{32}$/);
    expect(clientSecret).toMatch(/^secret_/);
    expect(app.requested_scopes).toEqual(['documents:read']);

    // The stored row holds a bcrypt hash, never the raw secret.
    const row = await findOAuthAppByClientId(app.client_id);
    expect(row).not.toBeNull();
    expect(row!.client_secret_hash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
    expect(row!.client_secret_hash).not.toBe(clientSecret);
  });

  it('verifies the correct secret and rejects a wrong one', async () => {
    const { app, clientSecret } = await createOAuthApp({
      name: 'Secret Verify App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: null,
      requestedScopes: [],
    });
    createdClientIds.push(app.client_id);

    const row = await findOAuthAppByClientId(app.client_id);
    expect(await verifyClientSecret(row!, clientSecret)).toBe(true);
    expect(await verifyClientSecret(row!, 'secret_wrong')).toBe(false);
  });

  it('matches redirect URIs exactly (no prefix/substring matching)', () => {
    const app = { redirect_uris: ['https://app.example.com/callback'] };
    expect(isRegisteredRedirectUri(app, 'https://app.example.com/callback')).toBe(true);
    expect(isRegisteredRedirectUri(app, 'https://app.example.com/callback/evil')).toBe(false);
    expect(isRegisteredRedirectUri(app, 'https://evil.com/callback')).toBe(false);
  });

  it('lists registered apps without ever leaking the secret hash', async () => {
    const { app } = await createOAuthApp({
      name: 'Listed App',
      redirectUris: ['https://listed.example.com/cb'],
      ownerUserId: null,
      requestedScopes: ['documents:read'],
    });
    createdClientIds.push(app.client_id);

    const apps = await listOAuthApps();
    const found = apps.find((a) => a.id === app.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Listed App');
    // The list DTO carries display fields but never the secret hash.
    expect(found).not.toHaveProperty('client_secret_hash');
    expect(found).toHaveProperty('owner_email');
    expect(found!.owner_email).toBeNull(); // ownerUserId was null
  });

  it('rotates the client secret: the old one stops verifying, the new one verifies', async () => {
    const { app, clientSecret: original } = await createOAuthApp({
      name: 'Rotate App',
      redirectUris: ['https://rotate.example.com/cb'],
      ownerUserId: null,
      requestedScopes: [],
    });
    createdClientIds.push(app.client_id);

    const rotated = await rotateClientSecret(app.id);
    expect(rotated).not.toBeNull();
    expect(rotated!.clientSecret).not.toBe(original);
    expect(rotated!.app.client_id).toBe(app.client_id); // client_id is stable

    const row = await findOAuthAppByClientId(app.client_id);
    expect(await verifyClientSecret(row!, original)).toBe(false);
    expect(await verifyClientSecret(row!, rotated!.clientSecret)).toBe(true);
  });

  it('rotateClientSecret returns null for an unknown app id', async () => {
    const missing = await rotateClientSecret('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });

  it('deleting an app removes the row and cascade-deletes its access tokens', async () => {
    // Real workspace + user so we can insert an access_token referencing the app.
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('OAuth Delete WS') RETURNING id`
    );
    const workspaceId = ws.rows[0]!.id;
    createdWorkspaceIds.push(workspaceId);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'OAuth Delete Tester') RETURNING id`,
      [`oauth-delete-${Date.now()}@ship.local`]
    );
    const userId = u.rows[0]!.id;
    createdUserIds.push(userId);

    const { app } = await createOAuthApp({
      name: 'Delete App',
      redirectUris: ['https://delete.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
    });
    createdClientIds.push(app.client_id);

    const tokenHash = `delete_test_hash_${Date.now()}`;
    await pool.query(
      `INSERT INTO access_tokens (token_hash, token_prefix, app_id, user_id, workspace_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour')`,
      [tokenHash, 'ship_at_xxx', app.id, userId, workspaceId, ['documents:read']]
    );

    const deleted = await deleteOAuthApp(app.id);
    expect(deleted).toEqual({ id: app.id, name: 'Delete App' });

    // The app row is gone …
    expect(await findOAuthAppByClientId(app.client_id)).toBeNull();
    // … and so is its access token (ON DELETE CASCADE = instant revocation).
    const tokens = await pool.query('SELECT id FROM access_tokens WHERE token_hash = $1', [tokenHash]);
    expect(tokens.rows).toHaveLength(0);
  });

  it('deleteOAuthApp returns null for an unknown app id', async () => {
    const missing = await deleteOAuthApp('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });
});
