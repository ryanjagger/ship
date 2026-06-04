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

describe('SDK webhooks client', () => {
  it('lists subscriptions', async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [] });
    await client(fetchImpl).webhooks.list();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/api/v1/webhooks' });
  });

  it('creates a subscription and returns the one-time secret', async () => {
    const { calls, fetchImpl } = recordingFetch({ id: 'w1', secret: 'whsec_x', events: ['issue.created'] });
    const res = await client(fetchImpl).webhooks.create({ url: 'https://e.com/h', events: ['issue.created'] });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/api/v1/webhooks',
      body: { url: 'https://e.com/h', events: ['issue.created'] },
    });
    expect(res.secret).toBe('whsec_x');
  });

  it('gets / updates / deletes / rotates a subscription', async () => {
    const { calls, fetchImpl } = recordingFetch({ id: 'w1' });
    const c = client(fetchImpl);
    await c.webhooks.get('w1');
    await c.webhooks.update('w1', { active: false });
    await c.webhooks.delete('w1');
    await c.webhooks.rotateSecret('w1');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET https://api.test/api/v1/webhooks/w1',
      'PATCH https://api.test/api/v1/webhooks/w1',
      'DELETE https://api.test/api/v1/webhooks/w1',
      'POST https://api.test/api/v1/webhooks/w1/rotate-secret',
    ]);
    expect(calls[1]!.body).toEqual({ active: false });
  });

  it('lists deliveries with filters as query params', async () => {
    const { calls, fetchImpl } = recordingFetch({ data: [] });
    await client(fetchImpl).webhooks.deliveries.list({ subscription_id: 'w1', status: 'dead_lettered', event_type: 'issue.created', limit: 25 });
    expect(calls[0]!.method).toBe('GET');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/webhook-deliveries');
    expect(url.searchParams.get('subscription_id')).toBe('w1');
    expect(url.searchParams.get('status')).toBe('dead_lettered');
    expect(url.searchParams.get('event_type')).toBe('issue.created');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('gets a delivery and replays it', async () => {
    const { calls, fetchImpl } = recordingFetch({ delivery_id: 'd2', replay_of_delivery_id: 'd1' });
    const c = client(fetchImpl);
    await c.webhooks.deliveries.get('d1');
    const replay = await c.webhooks.deliveries.replay('d1');
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET https://api.test/api/v1/webhook-deliveries/d1',
      'POST https://api.test/api/v1/webhook-deliveries/d1/replay',
    ]);
    expect(replay).toEqual({ delivery_id: 'd2', replay_of_delivery_id: 'd1' });
  });
});
