import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { signWebhookPayload } from '@ryanjagger/ship-sdk';
import type { ShipClient } from '@ryanjagger/ship-sdk';
import { createShipWebhookRouter } from './webhooks.js';
import { InMemorySlackIntegrationStore } from './memory-store.js';
import type { SlackClientLike } from './types.js';

class FakeSlack implements SlackClientLike {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  users = {
    lookupByEmail: vi.fn(async () => ({ ok: true, user: { id: 'U123' } })),
  };
  conversations = {
    open: vi.fn(async () => ({ ok: true, channel: { id: 'D123' } })),
  };
  chat = {
    postMessage: vi.fn(async (input: { channel: string; text: string; blocks?: unknown[] }) => {
      this.posts.push(input);
      return { ok: true };
    }),
  };
}

async function fixture() {
  const store = new InMemorySlackIntegrationStore();
  await store.saveSlackInstallation({
    team: { id: 'T123' },
    bot: { token: 'xoxb-test', userId: 'B123' },
    incomingWebhook: { channelId: 'C123' },
  });
  const connection = await store.upsertConnection({
    slackTeamId: 'T123',
    enterpriseId: null,
    shipWorkspaceId: 'ws_1',
    shipUserId: 'user_1',
    shipAccessToken: 'ship_at_old',
    shipRefreshToken: 'ship_rt_old',
    shipAccessExpiresAt: new Date(Date.now() + 3600_000),
    shipScopes: ['issues:read', 'people:read', 'webhooks:manage', 'offline_access'],
    webhookSubscriptionId: 'sub_1',
    webhookSecret: 'whsec_test',
    slackChannelId: 'C123',
  });
  const slack = new FakeSlack();
  const ship = { people: { get: vi.fn(async () => ({ id: 'person_1', email: 'assignee@example.com' })) } };
  const app = express();
  app.use(
    createShipWebhookRouter(
      { shipBaseUrl: 'https://ship.test', shipClientId: 'client_slack', shipClientSecret: 'secret_slack' },
      store,
      {
        createSlackClient: () => slack,
        createShipClient: () => ship as unknown as ShipClient,
      }
    )
  );
  return { app, connection, slack };
}

function rawEvent(id = 'evt_1'): string {
  return JSON.stringify({
    id,
    type: 'issue.created',
    created: Math.floor(Date.now() / 1000),
    workspace_id: 'ws_1',
    actor_user_id: 'user_1',
    data: { object: { id: 'issue_1', title: 'Webhook issue', display_id: '#7' } },
  });
}

function signature(secret: string, raw: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${signWebhookPayload(secret, timestamp, raw)}`;
}

describe('Ship webhook receiver', () => {
  it('accepts a valid signed webhook and dedupes replayed events', async () => {
    const { app, connection, slack } = await fixture();
    const raw = rawEvent();
    const header = signature(connection.webhookSecret!, raw);

    const first = await request(app)
      .post(`/ship/webhooks/${connection.id}`)
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', header)
      .send(raw);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('processed');

    const replay = await request(app)
      .post(`/ship/webhooks/${connection.id}`)
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', header)
      .send(raw);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('duplicate');
    expect(slack.posts).toHaveLength(1);
  });

  it('rejects tampered and stale signatures', async () => {
    const { app, connection } = await fixture();
    const raw = rawEvent('evt_tamper');
    const tampered = raw.replace('Webhook issue', 'Tampered issue');

    const bad = await request(app)
      .post(`/ship/webhooks/${connection.id}`)
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', signature(connection.webhookSecret!, raw))
      .send(tampered);
    expect(bad.status).toBe(401);

    const oldTs = Math.floor(Date.now() / 1000) - 301;
    const stale = await request(app)
      .post(`/ship/webhooks/${connection.id}`)
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', signature(connection.webhookSecret!, raw, oldTs))
      .send(raw);
    expect(stale.status).toBe(401);
  });

  it('returns 404 for an unknown connection and 400 for malformed signed JSON', async () => {
    const { app, connection } = await fixture();
    const raw = rawEvent('evt_missing');
    const missing = await request(app)
      .post('/ship/webhooks/nope')
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', signature(connection.webhookSecret!, raw))
      .send(raw);
    expect(missing.status).toBe(404);

    const malformed = '{"id":"evt_bad","type":"issue.created"';
    const badPayload = await request(app)
      .post(`/ship/webhooks/${connection.id}`)
      .set('Content-Type', 'application/json')
      .set('Ship-Signature', signature(connection.webhookSecret!, malformed))
      .send(malformed);
    expect(badPayload.status).toBe(400);
  });
});
