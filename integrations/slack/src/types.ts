import type { ShipClient } from '@ryanjagger/ship-sdk';

export interface ShipWebhookEnvelope {
  id: string;
  type: 'issue.created' | 'issue.assigned' | string;
  created: number;
  workspace_id: string;
  actor_user_id: string | null;
  data: { object: Record<string, unknown> };
  previous_attributes?: Record<string, unknown>;
}

export interface ShipIssue {
  id: string;
  title?: string;
  display_id?: string;
  state?: string;
  priority?: string;
  assignee_id?: string | null;
  due_date?: string | null;
}

export interface SlackInstallation {
  teamId: string;
  enterpriseId: string | null;
  installation: Record<string, unknown>;
  botToken: string;
  botUserId: string | null;
  incomingChannelId: string | null;
  incomingChannelName: string | null;
  incomingWebhookUrl: string | null;
}

export interface ShipSlackConnection {
  id: string;
  slackTeamId: string;
  enterpriseId: string | null;
  shipWorkspaceId: string;
  shipUserId: string;
  shipAccessToken: string;
  shipRefreshToken: string | null;
  shipAccessExpiresAt: Date | null;
  shipScopes: string[];
  webhookSubscriptionId: string | null;
  webhookSecret: string | null;
  slackChannelId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SetupState {
  state: string;
  slackTeamId: string;
  enterpriseId: string | null;
  slackChannelId: string | null;
  expiresAt: Date;
}

export interface ShipOAuthState {
  state: string;
  setupState: string;
  slackTeamId: string;
  enterpriseId: string | null;
  codeVerifier: string;
  slackChannelId: string | null;
  expiresAt: Date;
}

export interface SlackIntegrationStore {
  ensureSchema?(): Promise<void>;
  boltInstallationStore(): {
    storeInstallation(installation: Record<string, unknown>): Promise<void>;
    fetchInstallation(query: Record<string, unknown>): Promise<Record<string, unknown>>;
    deleteInstallation(query: Record<string, unknown>): Promise<void>;
  };
  saveSlackInstallation(installation: Record<string, unknown>): Promise<SlackInstallation>;
  getSlackInstallation(teamId: string): Promise<SlackInstallation | null>;
  deleteSlackInstallation(teamId: string): Promise<void>;
  createSetupState(input: Omit<SetupState, 'state' | 'expiresAt'>): Promise<SetupState>;
  getSetupState(state: string): Promise<SetupState | null>;
  createShipOAuthState(input: Omit<ShipOAuthState, 'expiresAt'>): Promise<ShipOAuthState>;
  consumeShipOAuthState(state: string): Promise<ShipOAuthState | null>;
  upsertConnection(input: Omit<ShipSlackConnection, 'id' | 'createdAt' | 'updatedAt'>): Promise<ShipSlackConnection>;
  updateConnectionWebhook(connectionId: string, input: { webhookSubscriptionId: string; webhookSecret: string }): Promise<void>;
  getConnection(connectionId: string): Promise<ShipSlackConnection | null>;
  updateConnectionTokens(connectionId: string, input: {
    shipAccessToken: string;
    shipRefreshToken: string | null;
    shipAccessExpiresAt: Date | null;
    shipScopes: string[];
  }): Promise<void>;
  getCachedSlackUser(teamId: string, email: string): Promise<string | null>;
  cacheSlackUser(teamId: string, email: string, slackUserId: string): Promise<void>;
  hasProcessedEvent(connectionId: string, eventId: string): Promise<boolean>;
  recordProcessedEvent(connectionId: string, eventId: string): Promise<void>;
}

export interface SlackClientLike {
  users: {
    lookupByEmail(input: { email: string }): Promise<{ ok?: boolean; user?: { id?: string } }>;
  };
  conversations: {
    open(input: { users: string }): Promise<{ ok?: boolean; channel?: { id?: string } }>;
  };
  chat: {
    postMessage(input: { channel: string; text: string; blocks?: unknown[] }): Promise<unknown>;
  };
}

export type ShipClientFactory = (connection: ShipSlackConnection) => ShipClient;
