import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';

process.env.WEBHOOK_SECRET_ENC_KEY ||= crypto.randomBytes(32).toString('hex');

import { pool } from '../../../db/client.js';
import { encryptSecret } from '../crypto.js';
import { verifySignature } from '../signing.js';
import { deliverOne } from '../dispatcher.js';
import { MAX_ATTEMPTS } from '../retry.js';
import type { ClaimedDelivery } from '../deliveries.js';

describe('webhook dispatcher · deliverOne', () => {
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let subscriptionId: string;
  const secret = 'whsec_dispatcher_test_secret';

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Dispatch WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Dispatch Tester') RETURNING id`,
      [`dispatch-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, requested_scopes)
       VALUES ($1, 'x', 'Dispatch App', ARRAY['webhooks:manage']) RETURNING id`,
      [`client_dispatch_${Date.now()}`]
    );
    appId = a.rows[0]!.id;
    const sub = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions (app_id, workspace_id, url, events, encrypted_secret, secret_fingerprint, active)
       VALUES ($1, $2, 'https://example.com/hook', ARRAY['issue.created'], $3, 'sha256:x', true) RETURNING id`,
      [appId, workspaceId, encryptSecret(secret)]
    );
    subscriptionId = sub.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM webhook_subscriptions WHERE app_id = $1', [appId]);
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Create a fresh event + delivery and return a ClaimedDelivery for it. */
  async function makeDelivery(attemptCount = 0): Promise<ClaimedDelivery> {
    const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
    const payload = { id: eventId, type: 'issue.created', data: { object: { id: 'i1' } } };
    await pool.query(
      `INSERT INTO webhook_events (id, workspace_id, actor_user_id, type, api_version, payload, idempotency_key)
       VALUES ($1, $2, $3, 'issue.created', '2026-06-03', $4, $1)`,
      [eventId, workspaceId, userId, JSON.stringify(payload)]
    );
    const d = await pool.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (subscription_id, event_id, status, attempt_count, next_attempt_at)
       VALUES ($1, $2, 'pending', $3, now()) RETURNING id`,
      [subscriptionId, eventId, attemptCount]
    );
    return {
      delivery_id: d.rows[0]!.id,
      subscription_id: subscriptionId,
      event_id: eventId,
      attempt_count: attemptCount,
      url: 'https://example.com/hook',
      encrypted_secret: encryptSecret(secret),
      active: true,
      payload,
    };
  }

  async function deliveryState(id: string) {
    const r = await pool.query(`SELECT status, attempt_count, next_attempt_at, last_response_status FROM webhook_deliveries WHERE id = $1`, [id]);
    return r.rows[0] as { status: string; attempt_count: number; next_attempt_at: string | null; last_response_status: number | null };
  }

  it('delivers on 2xx, signs a verifiable body, and records an attempt', async () => {
    let captured: { body: string; signature: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        captured = { body: init.body as string, signature: headers['Ship-Signature']! };
        return new Response('ok', { status: 200 });
      })
    );

    const delivery = await makeDelivery();
    await deliverOne(delivery);

    const state = await deliveryState(delivery.delivery_id);
    expect(state.status).toBe('delivered');
    expect(state.attempt_count).toBe(1);
    expect(state.next_attempt_at).toBeNull();
    // The exact body that was sent verifies against the signature header.
    expect(verifySignature({ header: captured!.signature, rawBody: captured!.body, secret })).toBe(true);

    const attempts = await pool.query(`SELECT * FROM webhook_delivery_attempts WHERE delivery_id = $1`, [delivery.delivery_id]);
    expect(attempts.rowCount).toBe(1);
    expect(attempts.rows[0]).toMatchObject({ attempt_number: 1, response_status: 200 });
  });

  it('schedules a retry on 5xx (stays pending with a future next_attempt_at)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const delivery = await makeDelivery();
    await deliverOne(delivery);
    const state = await deliveryState(delivery.delivery_id);
    expect(state.status).toBe('pending');
    expect(state.attempt_count).toBe(1);
    expect(new Date(state.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    expect(state.last_response_status).toBe(503);
  });

  it('schedules a retry on timeout/network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }));
    const delivery = await makeDelivery();
    await deliverOne(delivery);
    const state = await deliveryState(delivery.delivery_id);
    expect(state.status).toBe('pending');
    expect(state.attempt_count).toBe(1);
    const attempts = await pool.query(`SELECT error FROM webhook_delivery_attempts WHERE delivery_id = $1`, [delivery.delivery_id]);
    expect((attempts.rows[0] as { error: string }).error).toBeTruthy();
  });

  it('dead-letters on 4xx (permanent, no retry)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 400 })));
    const delivery = await makeDelivery();
    await deliverOne(delivery);
    const state = await deliveryState(delivery.delivery_id);
    expect(state.status).toBe('dead_lettered');
    expect(state.next_attempt_at).toBeNull();
  });

  it('dead-letters when retries are exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    // attempt_count one below max → this attempt is the final retry.
    const delivery = await makeDelivery(MAX_ATTEMPTS - 1);
    await deliverOne(delivery);
    const state = await deliveryState(delivery.delivery_id);
    expect(state.status).toBe('dead_lettered');
    expect(state.attempt_count).toBe(MAX_ATTEMPTS);
  });
});
