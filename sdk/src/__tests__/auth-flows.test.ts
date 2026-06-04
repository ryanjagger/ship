import { describe, it, expect, vi } from 'vitest';
import { ShipClient, MemoryTokenStore, type AuthCodeRedirectAdapter } from '../index.js';

/** Routes OAuth calls by path; records every request for assertions. */
function oauthFetch(handlers: Record<string, (body: Record<string, unknown>) => { status: number; json: unknown }>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) return new Response('{}', { status: 404 });
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('ShipClient.deviceLogin', () => {
  it('requests a code, calls onUserCode, polls, stores the token, returns a client', async () => {
    let pollCount = 0;
    const { calls, fetchImpl } = oauthFetch({
      '/api/oauth/device/authorization': () => ({
        status: 200,
        json: {
          device_code: 'dev_1',
          user_code: 'WXYZ-2345',
          verification_uri: 'https://api.test/device',
          verification_uri_complete: 'https://api.test/device?code=WXYZ-2345',
          expires_in: 600,
          interval: 1,
        },
      }),
      '/api/oauth/token': () => {
        pollCount += 1;
        if (pollCount < 2) return { status: 400, json: { error: 'authorization_pending' } };
        return { status: 200, json: { access_token: 'ship_at_xyz', token_type: 'Bearer', expires_in: 3600, scope: 'documents:read' } };
      },
    });

    const store = new MemoryTokenStore();
    const onUserCode = vi.fn();
    const client = await ShipClient.deviceLogin({
      clientId: 'client_cli',
      baseUrl: 'https://api.test',
      scope: 'documents:read',
      fetch: fetchImpl,
      store,
      onUserCode,
      sleep: async () => {}, // don't actually wait between polls
    });

    expect(onUserCode).toHaveBeenCalledOnce();
    expect(onUserCode.mock.calls[0]![0]).toMatchObject({ user_code: 'WXYZ-2345' });
    expect(client).toBeInstanceOf(ShipClient);
    const stored = await store.get();
    expect(stored?.accessToken).toBe('ship_at_xyz');
    expect(stored?.scope).toBe('documents:read');
    // device authorization + 2 token polls
    expect(calls.filter((c) => c.path === '/api/oauth/token')).toHaveLength(2);
  });
});

describe('ShipClient.authorizationCodeFlow (custom adapter)', () => {
  it('builds a PKCE authorize URL, exchanges the code, and stores the token', async () => {
    const { calls, fetchImpl } = oauthFetch({
      '/api/oauth/token': (body) => {
        // Confidential exchange must carry client_secret + verifier.
        expect(body.grant_type).toBe('authorization_code');
        expect(body.client_secret).toBe('secret_123');
        expect(typeof body.code_verifier).toBe('string');
        return { status: 200, json: { access_token: 'ship_at_ac', token_type: 'Bearer', expires_in: 3600, scope: 'issues:read' } };
      },
    });

    let seenAuthUrl = '';
    const adapter: AuthCodeRedirectAdapter = {
      async authorize(authUrl) {
        seenAuthUrl = authUrl;
        const url = new URL(authUrl);
        // Echo state back as a real callback would.
        return { code: 'auth_code_1', state: url.searchParams.get('state') ?? undefined };
      },
    };

    const store = new MemoryTokenStore();
    const client = await ShipClient.authorizationCodeFlow({
      clientId: 'client_web',
      clientSecret: 'secret_123',
      redirectUri: 'http://127.0.0.1:8765/callback',
      baseUrl: 'https://api.test',
      scope: 'issues:read',
      fetch: fetchImpl,
      redirect: adapter,
      store,
    });

    const authUrl = new URL(seenAuthUrl);
    expect(authUrl.pathname).toBe('/api/oauth/authorize');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('scope')).toBe('issues:read');

    expect(client).toBeInstanceOf(ShipClient);
    expect((await store.get())?.accessToken).toBe('ship_at_ac');
    expect(calls.some((c) => c.path === '/api/oauth/token')).toBe(true);
  });

  it('rejects a mismatched state (CSRF guard)', async () => {
    const { fetchImpl } = oauthFetch({});
    const adapter: AuthCodeRedirectAdapter = {
      async authorize() {
        return { code: 'c', state: 'tampered-state' };
      },
    };
    await expect(
      ShipClient.authorizationCodeFlow({
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'http://127.0.0.1:9/cb',
        baseUrl: 'https://api.test',
        fetch: fetchImpl,
        redirect: adapter,
      })
    ).rejects.toThrow(/state mismatch/i);
  });
});
