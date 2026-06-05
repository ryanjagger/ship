import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ShipClient } from '@ryanjagger/ship-sdk';
import { dispatchShipWebhook } from './dispatch.js';
import { InMemorySlackIntegrationStore } from './memory-store.js';
import type { ShipSlackConnection, ShipWebhookEnvelope, SlackClientLike } from './types.js';

type IncomingPost = { url: string; text: string; blocks: unknown[] };

class FakeSlack implements SlackClientLike {
  posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  lookupResult: { ok?: boolean; user?: { id?: string } } = { ok: true, user: { id: 'U123' } };

  users = {
    lookupByEmail: vi.fn(async (_input: { email: string }) => this.lookupResult),
  };
  conversations = {
    open: vi.fn(async (_input: { users: string }) => ({ ok: true, channel: { id: 'D123' } })),
  };
  chat = {
    postMessage: vi.fn(async (input: { channel: string; text: string; blocks?: unknown[] }) => {
      this.posts.push(input);
      return { ok: true };
    }),
  };
}

function event(type: 'issue.created' | 'issue.assigned', id = 'evt_1'): ShipWebhookEnvelope {
  return {
    id,
    type,
    created: Math.floor(Date.now() / 1000),
    workspace_id: 'ws_1',
    actor_user_id: 'user_1',
    data: {
      object: {
        id: 'issue_1',
        title: 'Fix Slack notifications',
        display_id: '#42',
        state: 'todo',
        priority: 'high',
        assignee_id: 'person_1',
      },
    },
  };
}

async function fixture(overrides: Partial<ShipSlackConnection> = {}) {
  const store = new InMemorySlackIntegrationStore();
  await store.saveSlackInstallation({
    team: { id: 'T123' },
    bot: { token: 'xoxb-test', userId: 'B123' },
    incomingWebhook: { channelId: 'C123', channelName: 'ship', url: 'https://hooks.slack.test/services/ship' },
  });
  const connection = await store.upsertConnection({
    slackTeamId: 'T123',
    enterpriseId: null,
    shipWorkspaceId: 'ws_1',
    shipUserId: 'user_1',
    shipAccessToken: 'ship_at_old',
    shipRefreshToken: 'ship_rt_old',
    shipAccessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    shipScopes: ['issues:read', 'people:read', 'webhooks:manage', 'offline_access'],
    webhookSubscriptionId: 'sub_1',
    webhookSecret: 'whsec_test',
    slackChannelId: 'C123',
    ...overrides,
  });
  const slack = new FakeSlack();
  const incomingPosts: IncomingPost[] = [];
  const postIncomingWebhook = vi.fn(async (url: string, message: { text: string; blocks: unknown[] }) => {
    incomingPosts.push({ url, text: message.text, blocks: message.blocks });
  });
  return { store, connection, slack, incomingPosts, postIncomingWebhook };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatchShipWebhook', () => {
  it('posts issue.created to the configured channel and dedupes replays', async () => {
    const { store, connection, slack, incomingPosts, postIncomingWebhook } = await fixture();
    const deps = {
      config: { shipBaseUrl: 'https://ship.test', shipClientId: 'client_slack', shipClientSecret: 'secret_slack' },
      store,
      createSlackClient: () => slack,
      postIncomingWebhook,
    };

    await expect(dispatchShipWebhook(connection, event('issue.created'), deps)).resolves.toBe('processed');
    await expect(dispatchShipWebhook(connection, event('issue.created'), deps)).resolves.toBe('duplicate');

    expect(slack.posts).toHaveLength(0);
    expect(incomingPosts).toHaveLength(1);
    expect(incomingPosts[0]!.url).toBe('https://hooks.slack.test/services/ship');
    expect(incomingPosts[0]!.text).toContain('New Ship issue');
  });

  it('posts issue.assigned as a DM to the assignee resolved by email', async () => {
    const { store, connection, slack, postIncomingWebhook } = await fixture();
    const ship = { people: { get: vi.fn(async () => ({ id: 'person_1', email: 'assignee@example.com' })) } };

    await dispatchShipWebhook(connection, event('issue.assigned'), {
      config: { shipBaseUrl: 'https://ship.test', shipClientId: 'client_slack', shipClientSecret: 'secret_slack' },
      store,
      createSlackClient: () => slack,
      createShipClient: () => ship as unknown as ShipClient,
      postIncomingWebhook,
    });

    expect(ship.people.get).toHaveBeenCalledWith('person_1');
    expect(slack.users.lookupByEmail).toHaveBeenCalledWith({ email: 'assignee@example.com' });
    expect(slack.conversations.open).toHaveBeenCalledWith({ users: 'U123' });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.channel).toBe('D123');
    expect(postIncomingWebhook).not.toHaveBeenCalled();
  });

  it('falls back to the configured incoming webhook when assignee DM lookup fails', async () => {
    const { store, connection, slack, incomingPosts, postIncomingWebhook } = await fixture();
    slack.lookupResult = { ok: false };
    const ship = { people: { get: vi.fn(async () => ({ id: 'person_1', email: 'missing@example.com' })) } };

    await dispatchShipWebhook(connection, event('issue.assigned'), {
      config: { shipBaseUrl: 'https://ship.test', shipClientId: 'client_slack', shipClientSecret: 'secret_slack' },
      store,
      createSlackClient: () => slack,
      createShipClient: () => ship as unknown as ShipClient,
      postIncomingWebhook,
    });

    expect(slack.posts).toHaveLength(0);
    expect(incomingPosts).toHaveLength(1);
    expect(incomingPosts[0]!.text).toContain('Ship issue assigned');
  });

  it('refreshes the Ship token before resolving an assignee with an expired access token', async () => {
    const { store, connection, slack, postIncomingWebhook } = await fixture({ shipAccessExpiresAt: new Date(Date.now() - 1000) });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: 'ship_at_new',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'issues:read people:read webhooks:manage offline_access',
          refresh_token: 'ship_rt_new',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const ship = { people: { get: vi.fn(async () => ({ id: 'person_1', email: 'assignee@example.com' })) } };
    const seenTokens: string[] = [];

    await dispatchShipWebhook(connection, event('issue.assigned'), {
      config: { shipBaseUrl: 'https://ship.test', shipClientId: 'client_slack', shipClientSecret: 'secret_slack' },
      store,
      createSlackClient: () => slack,
      createShipClient: (current) => {
        seenTokens.push(current.shipAccessToken);
        return ship as unknown as ShipClient;
      },
      postIncomingWebhook,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(seenTokens).toEqual(['ship_at_new']);
    const updated = await store.getConnection(connection.id);
    expect(updated?.shipAccessToken).toBe('ship_at_new');
    expect(updated?.shipRefreshToken).toBe('ship_rt_new');
  });
});
