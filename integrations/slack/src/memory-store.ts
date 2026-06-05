import { randomBytes } from 'node:crypto';
import type {
  SetupState,
  ShipOAuthState,
  ShipSlackConnection,
  SlackInstallation,
  SlackIntegrationStore,
} from './types.js';

function state(): string {
  return `state_${randomBytes(16).toString('base64url')}`;
}

function expiresAt(): Date {
  return new Date(Date.now() + 10 * 60 * 1000);
}

function teamIdFromInstallation(installation: Record<string, unknown>): string {
  const team = installation.team as Record<string, unknown> | undefined;
  const teamId = team?.id;
  if (typeof teamId !== 'string') throw new Error('Slack installation is missing team.id');
  return teamId;
}

function botTokenFromInstallation(installation: Record<string, unknown>): string {
  const bot = installation.bot as Record<string, unknown> | undefined;
  const token = bot?.token;
  if (typeof token !== 'string') throw new Error('Slack installation is missing bot.token');
  return token;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class InMemorySlackIntegrationStore implements SlackIntegrationStore {
  readonly installations = new Map<string, SlackInstallation>();
  readonly setupStates = new Map<string, SetupState>();
  readonly oauthStates = new Map<string, ShipOAuthState>();
  readonly connections = new Map<string, ShipSlackConnection>();
  readonly userCache = new Map<string, string>();
  readonly processed = new Set<string>();

  boltInstallationStore() {
    return {
      storeInstallation: (installation: Record<string, unknown>) => this.saveSlackInstallation(installation).then(() => undefined),
      fetchInstallation: async (query: Record<string, unknown>) => {
        const teamId = query.teamId;
        if (typeof teamId !== 'string') throw new Error('teamId is required');
        const installation = this.installations.get(teamId);
        if (!installation) throw new Error(`No Slack installation for team ${teamId}`);
        return installation.installation;
      },
      deleteInstallation: async (query: Record<string, unknown>) => {
        if (typeof query.teamId === 'string') await this.deleteSlackInstallation(query.teamId);
      },
    };
  }

  async saveSlackInstallation(installation: Record<string, unknown>): Promise<SlackInstallation> {
    const teamId = teamIdFromInstallation(installation);
    const enterprise = installation.enterprise as Record<string, unknown> | undefined;
    const incoming = installation.incomingWebhook as Record<string, unknown> | undefined;
    const bot = installation.bot as Record<string, unknown> | undefined;
    const record: SlackInstallation = {
      teamId,
      enterpriseId: typeof enterprise?.id === 'string' ? enterprise.id : null,
      installation,
      botToken: botTokenFromInstallation(installation),
      botUserId: str(bot?.userId) ?? str(bot?.user_id),
      incomingChannelId: str(incoming?.channelId) ?? str(incoming?.channel_id),
      incomingChannelName: str(incoming?.channelName) ?? str(incoming?.channel_name),
      incomingWebhookUrl: str(incoming?.url),
    };
    this.installations.set(teamId, record);
    return record;
  }

  async getSlackInstallation(teamId: string): Promise<SlackInstallation | null> {
    return this.installations.get(teamId) ?? null;
  }

  async deleteSlackInstallation(teamId: string): Promise<void> {
    this.installations.delete(teamId);
  }

  async createSetupState(input: Omit<SetupState, 'state' | 'expiresAt'>): Promise<SetupState> {
    const record = { ...input, state: state(), expiresAt: expiresAt() };
    this.setupStates.set(record.state, record);
    return record;
  }

  async getSetupState(setupState: string): Promise<SetupState | null> {
    return this.setupStates.get(setupState) ?? null;
  }

  async createShipOAuthState(input: Omit<ShipOAuthState, 'expiresAt'>): Promise<ShipOAuthState> {
    const record = { ...input, expiresAt: expiresAt() };
    this.oauthStates.set(record.state, record);
    return record;
  }

  async consumeShipOAuthState(oauthState: string): Promise<ShipOAuthState | null> {
    const record = this.oauthStates.get(oauthState) ?? null;
    this.oauthStates.delete(oauthState);
    return record;
  }

  async upsertConnection(input: Omit<ShipSlackConnection, 'id' | 'createdAt' | 'updatedAt'>): Promise<ShipSlackConnection> {
    const existing = [...this.connections.values()].find(
      (connection) => connection.slackTeamId === input.slackTeamId && connection.shipWorkspaceId === input.shipWorkspaceId
    );
    const record: ShipSlackConnection = {
      ...input,
      id: existing?.id ?? randomBytes(16).toString('hex'),
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.connections.set(record.id, record);
    return record;
  }

  async updateConnectionWebhook(connectionId: string, input: { webhookSubscriptionId: string; webhookSecret: string }): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.set(connectionId, {
      ...connection,
      webhookSubscriptionId: input.webhookSubscriptionId,
      webhookSecret: input.webhookSecret,
      updatedAt: new Date(),
    });
  }

  async getConnection(connectionId: string): Promise<ShipSlackConnection | null> {
    return this.connections.get(connectionId) ?? null;
  }

  async updateConnectionTokens(connectionId: string, input: {
    shipAccessToken: string;
    shipRefreshToken: string | null;
    shipAccessExpiresAt: Date | null;
    shipScopes: string[];
  }): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.set(connectionId, { ...connection, ...input, updatedAt: new Date() });
  }

  async getCachedSlackUser(teamId: string, email: string): Promise<string | null> {
    return this.userCache.get(`${teamId}:${email.toLowerCase()}`) ?? null;
  }

  async cacheSlackUser(teamId: string, email: string, slackUserId: string): Promise<void> {
    this.userCache.set(`${teamId}:${email.toLowerCase()}`, slackUserId);
  }

  async hasProcessedEvent(connectionId: string, eventId: string): Promise<boolean> {
    return this.processed.has(`${connectionId}:${eventId}`);
  }

  async recordProcessedEvent(connectionId: string, eventId: string): Promise<void> {
    this.processed.add(`${connectionId}:${eventId}`);
  }
}
