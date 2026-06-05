import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { createOAuthApp } from '../apps.js';
import { issueAuthorizationCode } from '../codes.js';
import { base64UrlSha256 } from '../pkce.js';

/**
 * Server-side proof of the Authorization Code + PKCE token exchange, including
 * the mandatory wrong-verifier negative (PRD §3 item 2). The full browser flow
 * (authorize → consent → token) is covered by the Playwright suite; here we
 * drive POST /api/oauth/token directly with a code issued out-of-band.
 */
describe('OAuth token exchange + PKCE', () => {
  const app = createApp();
  const redirectUri = 'https://grader.example.com/callback';
  let workspaceId: string;
  let userId: string;
  let clientId: string;
  let clientSecret: string;
  let appId: string;
  let publicClientId: string;
  let publicAppId: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('OAuth Token Test WS') RETURNING id`
    );
    workspaceId = ws.rows[0]!.id;

    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [`oauth-token-${Date.now()}@ship.local`, 'OAuth Tester']
    );
    userId = u.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [workspaceId, userId]
    );

    const created = await createOAuthApp({
      name: 'Token Test App',
      redirectUris: [redirectUri],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
    });
    clientId = created.app.client_id;
    clientSecret = created.clientSecret!;
    appId = created.app.id;

    const publicCreated = await createOAuthApp({
      name: 'Public Token Test App',
      redirectUris: [redirectUri],
      ownerUserId: userId,
      requestedScopes: ['documents:read'],
      clientType: 'public',
    });
    publicClientId = publicCreated.app.client_id;
    publicAppId = publicCreated.app.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE id = ANY($1)', [[appId, publicAppId]]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]); // cascades codes/tokens/memberships
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  async function freshCode(verifier: string, issuedAppId: string = appId): Promise<string> {
    return issueAuthorizationCode({
      appId: issuedAppId,
      userId,
      workspaceId,
      redirectUri,
      codeChallenge: base64UrlSha256(verifier),
      codeChallengeMethod: 'S256',
      scopes: ['documents:read'],
    });
  }

  it('exchanges a code with the correct verifier for a Bearer access token', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await freshCode(verifier);
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toMatch(/^ship_at_/);
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.scope).toBe('documents:read');
  });

  it('exchanges a public-client code with PKCE and no client_secret', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await freshCode(verifier, publicAppId);
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: publicClientId,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toMatch(/^ship_at_/);
    expect(res.body.scope).toBe('documents:read');
  });

  it('rejects client_secret on public-client token exchange', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await freshCode(verifier, publicAppId);
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: publicClientId,
      client_secret: 'secret_should_not_be_here',
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects a wrong code_verifier with 400 invalid_grant', async () => {
    const code = await freshCode(crypto.randomBytes(32).toString('base64url'));
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: 'definitely-not-the-right-verifier',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a bad client_secret with 401 invalid_client', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await freshCode(verifier);
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: 'secret_wrong',
      code_verifier: verifier,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects a missing client_secret for confidential clients', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await freshCode(verifier);
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects an unsupported grant_type with 400 unsupported_grant_type', async () => {
    const res = await request(app).post('/api/oauth/token').send({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('is single-use: a consumed code cannot be exchanged twice', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await freshCode(verifier);
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    };
    const first = await request(app).post('/api/oauth/token').send(body);
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/oauth/token').send(body);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });
});
