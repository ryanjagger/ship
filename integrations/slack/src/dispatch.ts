import { ShipClient, refreshAccessToken } from '@ryanjagger/ship-sdk';
import { WebClient } from '@slack/web-api';
import type { SlackIntegrationConfig } from './config.js';
import type {
  ShipIssue,
  ShipSlackConnection,
  ShipWebhookEnvelope,
  SlackClientLike,
  SlackIntegrationStore,
} from './types.js';

const REFRESH_SKEW_MS = 60 * 1000;

export interface DispatchDependencies {
  config: Pick<SlackIntegrationConfig, 'shipBaseUrl' | 'shipClientId' | 'shipClientSecret'>;
  store: SlackIntegrationStore;
  createSlackClient?: (botToken: string) => SlackClientLike;
  createShipClient?: (connection: ShipSlackConnection) => ShipClient;
  now?: () => Date;
}

function issueFromEvent(event: ShipWebhookEnvelope): ShipIssue {
  const object = event.data.object;
  return {
    id: String(object.id ?? ''),
    title: typeof object.title === 'string' ? object.title : undefined,
    display_id: typeof object.display_id === 'string' ? object.display_id : undefined,
    state: typeof object.state === 'string' ? object.state : undefined,
    priority: typeof object.priority === 'string' ? object.priority : undefined,
    assignee_id: typeof object.assignee_id === 'string' ? object.assignee_id : object.assignee_id === null ? null : undefined,
    due_date: typeof object.due_date === 'string' ? object.due_date : null,
  };
}

function issueLabel(issue: ShipIssue): string {
  const prefix = issue.display_id ? `${issue.display_id} ` : '';
  return `${prefix}${issue.title ?? issue.id}`;
}

function issueBlocks(kind: 'created' | 'assigned', issue: ShipIssue, assigneeEmail?: string): unknown[] {
  const headline = kind === 'created' ? 'New Ship issue' : 'Ship issue assigned';
  const fields = [
    issue.state ? `*State:*\n${issue.state}` : null,
    issue.priority ? `*Priority:*\n${issue.priority}` : null,
    issue.due_date ? `*Due:*\n${issue.due_date}` : null,
    assigneeEmail ? `*Assignee:*\n${assigneeEmail}` : null,
  ].filter((field): field is string => Boolean(field));

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${headline}*\n${issueLabel(issue)}` },
    },
    ...(fields.length > 0 ? [{ type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) }] : []),
  ];
}

function defaultSlackClient(botToken: string): SlackClientLike {
  const client = new WebClient(botToken);
  return client as unknown as SlackClientLike;
}

async function shipClientForConnection(connection: ShipSlackConnection, deps: DispatchDependencies): Promise<ShipClient> {
  const now = deps.now?.() ?? new Date();
  let current = connection;
  if (
    connection.shipRefreshToken &&
    connection.shipAccessExpiresAt &&
    connection.shipAccessExpiresAt.getTime() <= now.getTime() + REFRESH_SKEW_MS
  ) {
    const refreshed = await refreshAccessToken({
      clientId: deps.config.shipClientId,
      clientSecret: deps.config.shipClientSecret,
      refreshToken: connection.shipRefreshToken,
      baseUrl: deps.config.shipBaseUrl,
    });
    const nextConnection = {
      shipAccessToken: refreshed.access_token,
      shipRefreshToken: refreshed.refresh_token ?? connection.shipRefreshToken,
      shipAccessExpiresAt: new Date(now.getTime() + refreshed.expires_in * 1000),
      shipScopes: refreshed.scope.split(/\s+/).filter(Boolean),
    };
    await deps.store.updateConnectionTokens(connection.id, nextConnection);
    current = { ...connection, ...nextConnection };
  }

  return deps.createShipClient?.(current) ?? new ShipClient({ token: current.shipAccessToken, baseUrl: deps.config.shipBaseUrl });
}

async function resolveSlackUserForAssignee(
  connection: ShipSlackConnection,
  slack: SlackClientLike,
  issue: ShipIssue,
  deps: DispatchDependencies
): Promise<{ slackUserId: string; email: string } | null> {
  if (!issue.assignee_id) return null;
  const ship = await shipClientForConnection(connection, deps);
  const person = await ship.people.get(issue.assignee_id);
  const email = typeof person.email === 'string' ? person.email : null;
  if (!email) return null;

  const cached = await deps.store.getCachedSlackUser(connection.slackTeamId, email);
  if (cached) return { slackUserId: cached, email };

  const lookup = await slack.users.lookupByEmail({ email });
  const slackUserId = lookup.user?.id;
  if (!slackUserId) return null;
  await deps.store.cacheSlackUser(connection.slackTeamId, email, slackUserId);
  return { slackUserId, email };
}

async function postToChannel(slack: SlackClientLike, channel: string, kind: 'created' | 'assigned', issue: ShipIssue, assigneeEmail?: string): Promise<void> {
  await slack.chat.postMessage({
    channel,
    text: `${kind === 'created' ? 'New Ship issue' : 'Ship issue assigned'}: ${issueLabel(issue)}`,
    blocks: issueBlocks(kind, issue, assigneeEmail),
  });
}

export async function dispatchShipWebhook(
  connection: ShipSlackConnection,
  event: ShipWebhookEnvelope,
  deps: DispatchDependencies
): Promise<'processed' | 'duplicate' | 'ignored'> {
  if (await deps.store.hasProcessedEvent(connection.id, event.id)) return 'duplicate';
  if (event.type !== 'issue.created' && event.type !== 'issue.assigned') return 'ignored';

  const installation = await deps.store.getSlackInstallation(connection.slackTeamId);
  if (!installation) throw new Error(`No Slack installation for team ${connection.slackTeamId}`);
  const channel = connection.slackChannelId ?? installation.incomingChannelId;
  if (!channel) throw new Error('Slack installation did not provide a channel');

  const slack = deps.createSlackClient?.(installation.botToken) ?? defaultSlackClient(installation.botToken);
  const issue = issueFromEvent(event);

  if (event.type === 'issue.created') {
    await postToChannel(slack, channel, 'created', issue);
  } else {
    try {
      const assignee = await resolveSlackUserForAssignee(connection, slack, issue, deps);
      if (!assignee) throw new Error('Assignee could not be resolved to a Slack user');
      const dm = await slack.conversations.open({ users: assignee.slackUserId });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) throw new Error('Slack DM channel could not be opened');
      await postToChannel(slack, dmChannel, 'assigned', issue, assignee.email);
    } catch (error) {
      console.warn('[slack-integration] falling back to channel for issue.assigned:', error);
      await postToChannel(slack, channel, 'assigned', issue);
    }
  }

  await deps.store.recordProcessedEvent(connection.id, event.id);
  return 'processed';
}
