import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../../../db/client.js';
import {
  createOAuthApp,
  findOAuthAppByClientId,
  verifyClientSecret,
  isRegisteredRedirectUri,
} from '../apps.js';

describe('OAuth app model (PRD §5.2)', () => {
  const createdClientIds: string[] = [];

  afterAll(async () => {
    for (const clientId of createdClientIds) {
      await pool.query('DELETE FROM oauth_apps WHERE client_id = $1', [clientId]);
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
});
