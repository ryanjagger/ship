import { test, expect } from './fixtures/isolated-env';

/**
 * End-to-end OAuth 2.0 Device Authorization Grant (RFC 8628) against the live
 * server. Drives login → register a public client → device/authorization →
 * the /device approval page → /api/oauth/token poll → Platform API access,
 * mirroring what `ship login` + `ship docs` do under the hood.
 *
 * The client is registered at runtime via the admin endpoint (dev@ship.local is
 * a super-admin), matching the oauth-pkce spec's approach.
 */

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

test.describe('OAuth 2.0 Device Authorization Grant', () => {
  test('approve at /device → poll token → Platform API access', async ({ page, baseURL }) => {
    // 1) Log in (the /device approval page requires a session).
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    // 2) Register a public client (read+write) via the admin endpoint.
    const csrf = (await (await page.request.get('/api/csrf-token')).json()).token as string;
    const regRes = await page.request.post('/api/admin/oauth-apps', {
      headers: { 'x-csrf-token': csrf },
      data: {
        name: 'E2E Device CLI',
        redirect_uris: [`${baseURL}/callback`],
        requested_scopes: ['documents:read', 'documents:write'],
        allow_device_flow: true,
      },
    });
    expect(regRes.status()).toBe(201);
    const clientId = ((await regRes.json()).data as { client_id: string }).client_id;

    // 3) Negative: a device_code polled before approval → authorization_pending.
    const pendingAuth = await page.request.post('/api/oauth/device/authorization', {
      data: { client_id: clientId, scope: 'documents:read' },
    });
    expect(pendingAuth.status()).toBe(200);
    const pendingCode = (await pendingAuth.json()).device_code as string;
    const pendingPoll = await page.request.post('/api/oauth/token', {
      data: { grant_type: DEVICE_GRANT, device_code: pendingCode, client_id: clientId },
    });
    expect(pendingPoll.status()).toBe(400);
    expect((await pendingPoll.json()).error).toBe('authorization_pending');

    // 4) Begin the real flow: request a device_code + user_code.
    const authRes = await page.request.post('/api/oauth/device/authorization', {
      data: { client_id: clientId, scope: 'documents:read documents:write' },
    });
    expect(authRes.status()).toBe(200);
    const auth = (await authRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    };
    expect(auth.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // 5) Approve at /device (arriving via verification_uri_complete ?code=).
    await page.goto(`/device?code=${encodeURIComponent(auth.user_code)}`);
    await expect(page.getByTestId('device-verify')).toBeVisible();
    await expect(page.getByTestId('device-app-name')).toContainText('E2E Device CLI');
    await expect(page.getByTestId('device-scopes')).toContainText('documents:read');
    await page.getByTestId('device-approve').click();
    await expect(page.getByTestId('device-success')).toBeVisible({ timeout: 10000 });

    // 6) Poll the token endpoint → access token.
    const tokenRes = await page.request.post('/api/oauth/token', {
      data: { grant_type: DEVICE_GRANT, device_code: auth.device_code, client_id: clientId },
    });
    expect(tokenRes.status()).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string; token_type: string; scope: string };
    expect(tokenBody.token_type).toBe('Bearer');
    const headers = { Authorization: `Bearer ${tokenBody.access_token}` };

    // 7) The token authenticates the Platform API (what `ship docs` uses).
    const meRes = await page.request.get('/api/v1/me', { headers });
    expect(meRes.status()).toBe(200);
    expect((await meRes.json()).workspace?.name).toBe('Test Workspace');

    const created = await page.request.post('/api/v1/documents', {
      headers,
      data: { title: 'Made by ship CLI', document_type: 'wiki' },
    });
    expect(created.status()).toBe(201);
    expect((await created.json()).title).toBe('Made by ship CLI');

    const listRes = await page.request.get('/api/v1/documents?limit=5', { headers });
    expect(listRes.status()).toBe(200);
    expect((await listRes.json()).data.length).toBeGreaterThan(0);
    // (device_code single-use is proven at the model/route level, where the poll
    //  interval can be aged; an immediate re-poll here would surface slow_down.)
  });

  test('deny at /device → poll returns access_denied', async ({ page, baseURL }) => {
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    const csrf = (await (await page.request.get('/api/csrf-token')).json()).token as string;
    const regRes = await page.request.post('/api/admin/oauth-apps', {
      headers: { 'x-csrf-token': csrf },
      data: {
        name: 'E2E Device Deny',
        redirect_uris: [`${baseURL}/callback`],
        requested_scopes: ['documents:read'],
        allow_device_flow: true,
      },
    });
    const clientId = ((await regRes.json()).data as { client_id: string }).client_id;

    const authRes = await page.request.post('/api/oauth/device/authorization', {
      data: { client_id: clientId, scope: 'documents:read' },
    });
    const auth = (await authRes.json()) as { device_code: string; user_code: string };

    await page.goto(`/device?code=${encodeURIComponent(auth.user_code)}`);
    await expect(page.getByTestId('device-verify')).toBeVisible();
    await page.getByTestId('device-deny').click();
    await expect(page.getByTestId('device-denied')).toBeVisible({ timeout: 10000 });

    const poll = await page.request.post('/api/oauth/token', {
      data: { grant_type: DEVICE_GRANT, device_code: auth.device_code, client_id: clientId },
    });
    expect(poll.status()).toBe(400);
    expect((await poll.json()).error).toBe('access_denied');
  });
});
