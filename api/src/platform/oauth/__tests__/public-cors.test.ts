import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { createOAuthApp } from '../apps.js';

describe('Public OAuth/API CORS', () => {
  const app = createApp('https://ship.example.com');
  const publicOrigin = 'http://localhost:5174';
  const confidentialOrigin = 'http://localhost:5175';
  let publicClientId: string;
  let confidentialClientId: string;

  beforeAll(async () => {
    const publicClient = await createOAuthApp({
      name: 'Public CORS Browser App',
      redirectUris: [`${publicOrigin}/callback`],
      ownerUserId: null,
      requestedScopes: ['issues:read'],
      clientType: 'public',
    });
    publicClientId = publicClient.app.client_id;

    const confidentialClient = await createOAuthApp({
      name: 'Confidential CORS App',
      redirectUris: [`${confidentialOrigin}/callback`],
      ownerUserId: null,
      requestedScopes: ['issues:read'],
      clientType: 'confidential',
    });
    confidentialClientId = confidentialClient.app.client_id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM oauth_apps WHERE client_id = ANY($1)', [[publicClientId, confidentialClientId]]);
  });

  function preflight(path: string, origin: string, method: string, headers: string) {
    return request(app)
      .options(path)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', headers);
  }

  it('allows token preflight from a registered public-client redirect origin', async () => {
    const res = await preflight('/api/oauth/token', publicOrigin, 'POST', 'content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(publicOrigin);
    expect(res.headers['access-control-allow-headers']).toContain('content-type');
  });

  it('allows Platform API bearer preflight from a registered public-client redirect origin', async () => {
    const res = await preflight('/api/v1/issues', publicOrigin, 'GET', 'authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(publicOrigin);
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('does not allow dynamic public CORS from confidential-client redirect origins', async () => {
    const res = await preflight('/api/oauth/token', confidentialOrigin, 'POST', 'content-type');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not open session/admin routes to public-client redirect origins', async () => {
    const res = await preflight('/api/admin/oauth-apps', publicOrigin, 'POST', 'content-type');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('continues to allow the configured Ship app origin for session/admin routes', async () => {
    const res = await preflight('/api/admin/oauth-apps', 'https://ship.example.com', 'POST', 'content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://ship.example.com');
  });
});
