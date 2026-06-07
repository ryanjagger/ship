import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';

process.env.WEBHOOK_SECRET_ENC_KEY ||= crypto.randomBytes(32).toString('hex');

import { createApp } from '../../../../../app.js';
import { pool } from '../../../../../db/client.js';
import { createOAuthApp } from '../../../../oauth/apps.js';
import { issueAccessToken } from '../../../../oauth/tokens.js';

describe('Platform API · webhook subscriptions + deliveries', () => {
  const app = createApp();
  let workspaceId: string;
  let userId: string;
  let appId: string;
  let manageToken: string; // webhooks:manage + issues:read + issues:write
  let noManageToken: string; // issues:read only
  let manageOnlyToken: string; // webhooks:manage only (no read scopes)

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Webhook Routes WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'Webhook Routes Tester') RETURNING id`,
      [`webhook-routes-${Date.now()}@ship.local`]
    );
    userId = u.rows[0]!.id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      workspaceId,
      userId,
    ]);
    const scopes = ['webhooks:manage', 'issues:read', 'issues:write', 'people:read'];
    const created = await createOAuthApp({
      name: 'Webhook Routes App',
      redirectUris: ['https://app.example.com/cb'],
      ownerUserId: userId,
      requestedScopes: scopes,
    });
    appId = created.app.id;
    manageToken = (await issueAccessToken({ appId, userId, workspaceId, scopes })).accessToken;
    noManageToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['issues:read'] })).accessToken;
    manageOnlyToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['webhooks:manage'] })).accessToken;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM webhook_subscriptions WHERE app_id = $1', [appId]);
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('requires webhooks:manage to manage subscriptions', async () => {
    const res = await request(app).get('/api/v1/webhooks').set(auth(noManageToken));
    expect(res.status).toBe(403);
    expect(res.body.details.required_scope).toBe('webhooks:manage');
  });

  it('rejects subscribing to an event family without its read scope', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(manageOnlyToken))
      .send({ url: 'https://example.com/h', events: ['issue.created'] });
    expect(res.status).toBe(403);
    expect(res.body.details.required_read_scopes).toEqual(['issues:read', 'documents:read']);
  });

  it('rejects person.* with documents:read (people:read required, no broad fallback)', async () => {
    const docToken = (await issueAccessToken({ appId, userId, workspaceId, scopes: ['webhooks:manage', 'documents:read'] })).accessToken;
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(docToken))
      .send({ url: 'https://example.com/h', events: ['person.created'] });
    expect(res.status).toBe(403);
    expect(res.body.details.required_read_scopes).toEqual(['people:read']);
  });

  it('rejects SSRF / private-network webhook targets', async () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://127.0.0.1:9000/hook', // loopback
      'http://10.0.0.5/hook', // RFC 1918
      'http://localhost/hook', // loopback name
      'ftp://example.com/hook', // bad scheme
    ];
    for (const url of blocked) {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set(auth(manageToken))
        .send({ url, events: ['issue.created'] });
      expect(res.status, `expected ${url} to be rejected`).toBe(400);
      expect(res.body.details.reason).toBe('invalid_url');
    }
    // A public https target is accepted.
    const ok = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(manageToken))
      .send({ url: 'https://hooks.example.com/ship', events: ['issue.created'] });
    expect(ok.status).toBe(201);
    await request(app).delete(`/api/v1/webhooks/${ok.body.id}`).set(auth(manageToken));
  });

  it('rejects unknown event types', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(manageToken))
      .send({ url: 'https://example.com/h', events: ['document.created'] });
    expect(res.status).toBe(400);
    expect(res.body.details.unknown_events).toEqual(['document.created']);
  });

  it('creates, lists, gets, updates, rotates, and deletes a subscription', async () => {
    const created = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(manageToken))
      .send({ url: 'https://example.com/hook', events: ['issue.created', 'issue.status_changed'] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.secret_fingerprint).toMatch(/^sha256:/);
    const id = created.body.id as string;
    const fingerprint = created.body.secret_fingerprint as string;

    const list = await request(app).get('/api/v1/webhooks').set(auth(manageToken));
    expect(list.status).toBe(200);
    expect(list.body.data.some((s: { id: string }) => s.id === id)).toBe(true);
    // List never leaks the secret.
    expect(list.body.data[0]).not.toHaveProperty('secret');

    const got = await request(app).get(`/api/v1/webhooks/${id}`).set(auth(manageToken));
    expect(got.status).toBe(200);
    expect(got.body).not.toHaveProperty('secret');

    const patched = await request(app)
      .patch(`/api/v1/webhooks/${id}`)
      .set(auth(manageToken))
      .send({ active: false, events: ['issue.created'] });
    expect(patched.status).toBe(200);
    expect(patched.body.active).toBe(false);
    expect(patched.body.events).toEqual(['issue.created']);

    const rotated = await request(app).post(`/api/v1/webhooks/${id}/rotate-secret`).set(auth(manageToken));
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret_fingerprint).not.toBe(fingerprint);

    const deleted = await request(app).delete(`/api/v1/webhooks/${id}`).set(auth(manageToken));
    expect(deleted.status).toBe(204);
    const gone = await request(app).get(`/api/v1/webhooks/${id}`).set(auth(manageToken));
    expect(gone.status).toBe(404);
  });

  it('records deliveries and replays preserve the idempotency key', async () => {
    // Subscribe, then create an issue → a delivery is fanned out.
    const sub = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(manageToken))
      .send({ url: 'https://example.com/hook', events: ['issue.created'] });
    const subId = sub.body.id as string;

    const issue = await request(app).post('/api/v1/issues').set(auth(manageToken)).send({ title: 'Delivery Issue' });
    expect(issue.status).toBe(201);

    const deliveries = await request(app)
      .get('/api/v1/webhook-deliveries')
      .query({ subscription_id: subId, event_type: 'issue.created' })
      .set(auth(manageToken));
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.data.length).toBeGreaterThanOrEqual(1);
    const deliveryId = deliveries.body.data[0].id as string;
    const eventId = deliveries.body.data[0].event_id as string;

    const detail = await request(app).get(`/api/v1/webhook-deliveries/${deliveryId}`).set(auth(manageToken));
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body.attempts)).toBe(true);

    const replay = await request(app).post(`/api/v1/webhook-deliveries/${deliveryId}/replay`).set(auth(manageToken));
    expect(replay.status).toBe(202);
    expect(replay.body.replay_of_delivery_id).toBe(deliveryId);
    expect(replay.body.delivery_id).not.toBe(deliveryId);

    // The replay reuses the original event → same id == idempotency_key.
    const event = await pool.query<{ payload: { id: string; idempotency_key: string } }>(
      `SELECT payload FROM webhook_events WHERE id = $1`,
      [eventId]
    );
    expect(event.rows[0]!.payload.idempotency_key).toBe(event.rows[0]!.payload.id);

    // Source stamped 'replayed'; new row links back and is pending.
    const rows = await pool.query<{ status: string; replay_of_delivery_id: string | null }>(
      `SELECT status, replay_of_delivery_id FROM webhook_deliveries WHERE event_id = $1 ORDER BY created_at`,
      [eventId]
    );
    expect(rows.rows.find((r) => r.replay_of_delivery_id === deliveryId)?.status).toBe('pending');
    expect(rows.rows.find((r) => r.replay_of_delivery_id === null)?.status).toBe('replayed');
  });

  it('replaying a delivered delivery keeps the source delivered', async () => {
    const sub = await request(app)
      .post('/api/v1/webhooks')
      .set(auth(manageToken))
      .send({ url: 'https://example.com/hook', events: ['issue.created'] });
    const subId = sub.body.id as string;

    const issue = await request(app).post('/api/v1/issues').set(auth(manageToken)).send({ title: 'Delivered Issue' });
    expect(issue.status).toBe(201);

    const deliveries = await request(app)
      .get('/api/v1/webhook-deliveries')
      .query({ subscription_id: subId, event_type: 'issue.created' })
      .set(auth(manageToken));
    const deliveryId = deliveries.body.data[0].id as string;
    const eventId = deliveries.body.data[0].event_id as string;

    // Simulate a successful dispatch (the scheduler is disabled in tests).
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', attempt_count = 1, next_attempt_at = NULL,
           last_response_status = 200, delivered_at = now()
       WHERE id = $1`,
      [deliveryId]
    );

    const replay = await request(app).post(`/api/v1/webhook-deliveries/${deliveryId}/replay`).set(auth(manageToken));
    expect(replay.status).toBe(202);
    expect(replay.body.replay_of_delivery_id).toBe(deliveryId);
    expect(replay.body.delivery_id).not.toBe(deliveryId);

    // Source keeps its 'delivered' audit record; the new linked row is pending
    // and reuses the same event (→ same idempotency key).
    const source = await pool.query<{ status: string }>(`SELECT status FROM webhook_deliveries WHERE id = $1`, [
      deliveryId,
    ]);
    expect(source.rows[0]!.status).toBe('delivered');
    const replayRow = await pool.query<{ status: string; event_id: string }>(
      `SELECT status, event_id FROM webhook_deliveries WHERE replay_of_delivery_id = $1`,
      [deliveryId]
    );
    expect(replayRow.rows[0]!.status).toBe('pending');
    expect(replayRow.rows[0]!.event_id).toBe(eventId);
  });
});
