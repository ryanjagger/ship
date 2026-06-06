import { describe, it, expect } from 'vitest';
import { ShipClient } from '../index.js';

/** Records each call and returns a canned JSON body. */
function recordingFetch(body: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch) {
  return new ShipClient({ token: 'ship_at_test', baseUrl: 'https://api.test', fetch: fetchImpl });
}

describe('SDK developer-admin clients (scopes, apps, connections, audit)', () => {
  it('lists the scope catalog', async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [] });
    await client(fetchImpl).scopes.list();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v1/scopes' });
  });

  it('lists / creates / rotates / deletes apps', async () => {
    const { calls, fetchImpl } = recordingFetch({ id: 'a1', client_secret: 'secret_x', data: [] });
    const c = client(fetchImpl);
    await c.apps.list();
    const created = await c.apps.create({ name: 'My App', redirect_uris: ['https://e.com/cb'], requested_scopes: ['issues:read'] });
    await c.apps.rotateSecret('a1');
    await c.apps.delete('a1');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET https://api.test/api/v1/apps',
      'POST https://api.test/api/v1/apps',
      'POST https://api.test/api/v1/apps/a1/rotate-secret',
      'DELETE https://api.test/api/v1/apps/a1',
    ]);
    expect(calls[1]!.body).toEqual({ name: 'My App', redirect_uris: ['https://e.com/cb'], requested_scopes: ['issues:read'] });
    expect(created.client_secret).toBe('secret_x');
  });

  it("manages a target app's webhook subscriptions", async () => {
    const { calls, fetchImpl } = recordingFetch({ id: 'w1', secret: 'whsec_x' });
    const c = client(fetchImpl);
    await c.apps.webhooks.list('a1');
    await c.apps.webhooks.create('a1', { url: 'https://e.com/h', events: ['issue.created'] });
    await c.apps.webhooks.update('a1', 'w1', { active: false });
    await c.apps.webhooks.rotateSecret('a1', 'w1');
    await c.apps.webhooks.delete('a1', 'w1');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET https://api.test/api/v1/apps/a1/webhooks',
      'POST https://api.test/api/v1/apps/a1/webhooks',
      'PATCH https://api.test/api/v1/apps/a1/webhooks/w1',
      'POST https://api.test/api/v1/apps/a1/webhooks/w1/rotate-secret',
      'DELETE https://api.test/api/v1/apps/a1/webhooks/w1',
    ]);
    expect(calls[2]!.body).toEqual({ active: false });
  });

  it("walks a target app's delivery log with filters and replays", async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [], delivery_id: 'd2', replay_of_delivery_id: 'd1' });
    const c = client(fetchImpl);
    await c.apps.deliveries.list('a1', { subscription_id: 'w1', status: 'dead_lettered', limit: 25 });
    await c.apps.deliveries.get('a1', 'd1');
    const replay = await c.apps.deliveries.replay('a1', 'd1');
    const listUrl = new URL(calls[0]!.url);
    expect(listUrl.pathname).toBe('/api/v1/apps/a1/deliveries');
    expect(listUrl.searchParams.get('subscription_id')).toBe('w1');
    expect(listUrl.searchParams.get('status')).toBe('dead_lettered');
    expect(listUrl.searchParams.get('limit')).toBe('25');
    expect(calls[1]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v1/apps/a1/deliveries/d1' });
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'https://api.test/api/v1/apps/a1/deliveries/d1/replay' });
    expect(replay.delivery_id).toBe('d2');
  });

  it('lists and revokes connections', async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [], tokens_revoked: 2 });
    const c = client(fetchImpl);
    await c.connections.list();
    const revoked = await c.connections.revoke('a1', 'u1');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET https://api.test/api/v1/connections',
      'DELETE https://api.test/api/v1/connections/a1/users/u1',
    ]);
    expect(revoked.tokens_revoked).toBe(2);
  });

  it('queries the audit trail with filters incl. exclude_client_id', async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [], total: 0 });
    await client(fetchImpl).audit.list({
      status_class: 4,
      exclude_client_id: 'client_ship_developer_portal',
      limit: 100,
      offset: 50,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/audit');
    expect(url.searchParams.get('status_class')).toBe('4');
    expect(url.searchParams.get('exclude_client_id')).toBe('client_ship_developer_portal');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('50');
  });

  it('URL-encodes path segments', async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [] });
    await client(fetchImpl).apps.webhooks.list('a/1');
    expect(calls[0]!.url).toBe('https://api.test/api/v1/apps/a%2F1/webhooks');
  });
});
