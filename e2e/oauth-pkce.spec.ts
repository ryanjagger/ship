import { test, expect } from './fixtures/isolated-env';
import crypto from 'crypto';

/**
 * End-to-end OAuth 2.0 Authorization Code + PKCE against the live server
 * (PRD §2, §3). Drives login → /api/oauth/authorize → React consent → approve →
 * /api/oauth/token, then exercises the Platform API with the issued token,
 * including the mandatory negatives (wrong verifier, scope-denied POST, no token).
 *
 * The app is registered at runtime via the admin endpoint (dev@ship.local is a
 * super-admin) so its redirect_uri matches this worker's dynamic origin.
 */

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test.describe('OAuth 2.0 Authorization Code + PKCE', () => {
  test('full flow: consent → token → scoped API access', async ({ page, baseURL }) => {
    const redirectUri = `${baseURL}/callback`;
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(8));

    // 1) Log in (establishes the session the consent screen requires).
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    // 2) Register a READ-ONLY public PKCE OAuth app via the admin endpoint.
    const csrf = (await (await page.request.get('/api/csrf-token')).json()).token as string;
    const regRes = await page.request.post('/api/admin/oauth-apps', {
      headers: { 'x-csrf-token': csrf },
      data: {
        name: 'E2E Read-Only App',
        redirect_uris: [redirectUri],
        requested_scopes: ['documents:read'],
        client_type: 'public',
      },
    });
    expect(regRes.status()).toBe(201);
    const reg = (await regRes.json()).data as { client_id: string; client_secret?: string; client_type: string };
    expect(reg.client_id).toBeTruthy();
    expect(reg.client_type).toBe('public');
    expect(reg.client_secret).toBeUndefined();

    // 3) Authorization request → redirected to the React consent screen.
    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      scope: 'documents:read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    await page.goto(`/api/oauth/authorize?${authorizeQuery.toString()}`);
    await expect(page).toHaveURL(/\/oauth\/consent/);
    await expect(page.getByTestId('oauth-consent')).toBeVisible();
    await expect(page.getByTestId('oauth-app-name')).toContainText('E2E Read-Only App');
    await expect(page.getByTestId('oauth-scopes')).toContainText('documents:read');

    // 4) Approve. The SPA redirects the browser to the (same-origin) redirect_uri
    //    with ?code=&state=; capture the code from the resulting URL. (Reading the
    //    decision response body races with that navigation, which discards it.)
    await page.getByTestId('oauth-approve').click();
    await page.waitForURL(/\/callback\?/, { timeout: 10000 });
    const cb = new URL(page.url());
    expect(cb.origin + cb.pathname).toBe(redirectUri);
    expect(cb.searchParams.get('state')).toBe(state);
    const code = cb.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 5) Negative: wrong code_verifier → 400 invalid_grant (code not consumed).
    const wrong = await page.request.post('/api/oauth/token', {
      data: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: reg.client_id,
        code_verifier: 'totally-wrong-verifier',
      },
    });
    expect(wrong.status()).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_grant');

    // 6) Correct exchange → access token.
    const tokenRes = await page.request.post('/api/oauth/token', {
      data: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: reg.client_id,
        code_verifier: verifier,
      },
    });
    expect(tokenRes.status()).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string; token_type: string; scope: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.scope).toBe('documents:read');
    const auth = { Authorization: `Bearer ${tokenBody.access_token}` };

    // 7) /api/v1/me (auth-only) → flat typed user + workspace.
    const meRes = await page.request.get('/api/v1/me', { headers: auth });
    expect(meRes.status()).toBe(200);
    const me = await meRes.json();
    expect(me).not.toHaveProperty('success');
    expect(me.workspace?.name).toBe('Test Workspace');

    // 8) documents:read → list returns the seeded user-facing docs, no hidden types.
    const listRes = await page.request.get('/api/v1/documents?limit=5', { headers: auth });
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list.data)).toBe(true);
    expect(list.data.length).toBeGreaterThan(0);
    for (const doc of list.data as Array<{ document_type: string }>) {
      expect(['conversation', 'insight']).not.toContain(doc.document_type);
    }
    expect(list).toHaveProperty('next_cursor');

    // 9) POST is scope-denied → 403 naming documents:write (part of the demo).
    const writeRes = await page.request.post('/api/v1/documents', {
      headers: auth,
      data: { title: 'Should 403', document_type: 'wiki' },
    });
    expect(writeRes.status()).toBe(403);
    const writeErr = await writeRes.json();
    expect(writeErr.code).toBe('forbidden');
    expect(writeErr.message).toContain('documents:write');
    expect(writeErr.request_id).toBeTruthy();
  });

  test('Platform API rejects missing and invalid tokens with ApiError 401', async ({ page }) => {
    const noToken = await page.request.get('/api/v1/me');
    expect(noToken.status()).toBe(401);
    const noBody = await noToken.json();
    expect(noBody.code).toBe('unauthorized');
    expect(noBody.details?.reason).toBe('missing_token');
    expect(noBody.request_id).toBeTruthy();

    const badToken = await page.request.get('/api/v1/me', {
      headers: { Authorization: 'Bearer ship_at_not_real' },
    });
    expect(badToken.status()).toBe(401);
    expect((await badToken.json()).details?.reason).toBe('invalid_token');
  });
});
