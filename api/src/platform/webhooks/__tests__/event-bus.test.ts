import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';

process.env.WEBHOOK_SECRET_ENC_KEY ||= crypto.randomBytes(32).toString('hex');

import { pool } from '../../../db/client.js';
import { eventBus } from '../event-bus.js';
import type { ShipWebhookEvent } from '../events.js';

/**
 * Fan-out must mirror the read path's visibility rule (PR #68 review, P1): a
 * private document is delivered only to subscriptions owned by its creator; a
 * workspace document goes to all matching subscriptions.
 */
describe('event bus fan-out · visibility', () => {
  let workspaceId: string;
  let userA: string;
  let userB: string;
  let appId: string;
  let subA: string;
  let subB: string;

  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('EventBus Vis WS') RETURNING id`);
    workspaceId = ws.rows[0]!.id;
    const ua = await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1,'A') RETURNING id`, [`eb-a-${Date.now()}@ship.local`]);
    userA = ua.rows[0]!.id;
    const ub = await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ($1,'B') RETURNING id`, [`eb-b-${Date.now()}@ship.local`]);
    userB = ub.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, requested_scopes) VALUES ($1,'x','EB App', ARRAY['webhooks:manage']) RETURNING id`,
      [`client_eb_${Date.now()}`]
    );
    appId = a.rows[0]!.id;
    const mkSub = async (owner: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO webhook_subscriptions (app_id, workspace_id, created_by, url, events, encrypted_secret, secret_fingerprint, active)
           VALUES ($1,$2,$3,'https://example.com/h',ARRAY['issue.created'],'enc','sha256:x',true) RETURNING id`,
          [appId, workspaceId, owner]
        )
      ).rows[0]!.id;
    subA = await mkSub(userA);
    subB = await mkSub(userB);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM webhook_subscriptions WHERE app_id = $1', [appId]);
    await pool.query('DELETE FROM oauth_apps WHERE id = $1', [appId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userA, userB]]);
  });

  function event(): ShipWebhookEvent {
    const id = `evt_${crypto.randomBytes(8).toString('hex')}`;
    return {
      id,
      type: 'issue.created',
      api_version: '2026-06-03',
      created: 1_780_500_000,
      workspace_id: workspaceId,
      actor_user_id: userA,
      idempotency_key: id,
      data: { object: { id: 'i1' } },
    };
  }

  async function publish(ev: ShipWebhookEvent, scope: { visibility: string; ownerId: string | null }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await eventBus.publish(client, [ev], scope);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  async function deliveredSubs(eventId: string): Promise<string[]> {
    const r = await pool.query<{ subscription_id: string }>(
      `SELECT subscription_id FROM webhook_deliveries WHERE event_id = $1`,
      [eventId]
    );
    return r.rows.map((row) => row.subscription_id).sort();
  }

  it('delivers a workspace document to all matching subscriptions', async () => {
    const ev = event();
    await publish(ev, { visibility: 'workspace', ownerId: userA });
    expect(await deliveredSubs(ev.id)).toEqual([subA, subB].sort());
  });

  it('delivers a private document only to the creator-owned subscription', async () => {
    const ev = event();
    await publish(ev, { visibility: 'private', ownerId: userA });
    expect(await deliveredSubs(ev.id)).toEqual([subA]);
  });

  it('delivers a private document with no owner to nobody', async () => {
    const ev = event();
    await publish(ev, { visibility: 'private', ownerId: null });
    expect(await deliveredSubs(ev.id)).toEqual([]);
  });
});
