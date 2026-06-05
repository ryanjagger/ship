import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from './crypto.js';
import type {
  SetupState,
  ShipOAuthState,
  ShipSlackConnection,
  SlackInstallation,
  SlackIntegrationStore,
} from './types.js';

const SETUP_TTL_MS = 10 * 60 * 1000;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function installationTeamId(installation: Record<string, unknown>): string {
  const team = installation.team as Record<string, unknown> | undefined;
  const teamId = str(team?.id) ?? str(installation.teamId);
  if (!teamId) throw new Error('Slack installation is missing team.id');
  return teamId;
}

function installationEnterpriseId(installation: Record<string, unknown>): string | null {
  const enterprise = installation.enterprise as Record<string, unknown> | undefined;
  return str(enterprise?.id) ?? str(installation.enterpriseId);
}

function installationBotToken(installation: Record<string, unknown>): string {
  const bot = installation.bot as Record<string, unknown> | undefined;
  const token = str(bot?.token);
  if (!token) throw new Error('Slack installation is missing bot.token');
  return token;
}

function installationBotUserId(installation: Record<string, unknown>): string | null {
  const bot = installation.bot as Record<string, unknown> | undefined;
  return str(bot?.userId) ?? str(bot?.user_id);
}

function incomingChannel(installation: Record<string, unknown>): { id: string | null; name: string | null } {
  const incoming = installation.incomingWebhook as Record<string, unknown> | undefined;
  return {
    id: str(incoming?.channelId) ?? str(incoming?.channel_id),
    name: str(incoming?.channelName) ?? str(incoming?.channel_name),
  };
}

function setupExpiresAt(): Date {
  return new Date(Date.now() + SETUP_TTL_MS);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class PgSlackIntegrationStore implements SlackIntegrationStore {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS slack_installations (
        team_id TEXT PRIMARY KEY,
        enterprise_id TEXT,
        installation_enc TEXT NOT NULL,
        bot_token_enc TEXT NOT NULL,
        bot_user_id TEXT,
        incoming_channel_id TEXT,
        incoming_channel_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS slack_setup_states (
        state TEXT PRIMARY KEY,
        slack_team_id TEXT NOT NULL,
        enterprise_id TEXT,
        slack_channel_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS slack_ship_oauth_states (
        state TEXT PRIMARY KEY,
        setup_state TEXT NOT NULL,
        slack_team_id TEXT NOT NULL,
        enterprise_id TEXT,
        code_verifier TEXT NOT NULL,
        slack_channel_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS slack_ship_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slack_team_id TEXT NOT NULL REFERENCES slack_installations(team_id) ON DELETE CASCADE,
        enterprise_id TEXT,
        ship_workspace_id TEXT NOT NULL,
        ship_user_id TEXT NOT NULL,
        ship_access_token_enc TEXT NOT NULL,
        ship_refresh_token_enc TEXT,
        ship_access_expires_at TIMESTAMPTZ,
        ship_scopes TEXT[] NOT NULL DEFAULT '{}',
        webhook_subscription_id TEXT,
        webhook_secret_enc TEXT,
        slack_channel_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (slack_team_id, ship_workspace_id)
      );

      CREATE TABLE IF NOT EXISTS slack_user_cache (
        team_id TEXT NOT NULL,
        email TEXT NOT NULL,
        slack_user_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, email)
      );

      CREATE TABLE IF NOT EXISTS slack_processed_events (
        connection_id UUID NOT NULL REFERENCES slack_ship_connections(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (connection_id, event_id)
      );
    `);
    await this.pool.query(`ALTER TABLE slack_ship_oauth_states ADD COLUMN IF NOT EXISTS enterprise_id TEXT`);
  }

  boltInstallationStore() {
    return {
      storeInstallation: (installation: Record<string, unknown>) => this.saveSlackInstallation(installation).then(() => undefined),
      fetchInstallation: async (query: Record<string, unknown>) => {
        const teamId = str(query.teamId) ?? str(query.team_id);
        if (!teamId) throw new Error('Slack installation query is missing teamId');
        const installation = await this.getSlackInstallation(teamId);
        if (!installation) throw new Error(`No Slack installation for team ${teamId}`);
        return installation.installation;
      },
      deleteInstallation: async (query: Record<string, unknown>) => {
        const teamId = str(query.teamId) ?? str(query.team_id);
        if (teamId) await this.deleteSlackInstallation(teamId);
      },
    };
  }

  async saveSlackInstallation(installation: Record<string, unknown>): Promise<SlackInstallation> {
    const teamId = installationTeamId(installation);
    const enterpriseId = installationEnterpriseId(installation);
    const botToken = installationBotToken(installation);
    const botUserId = installationBotUserId(installation);
    const channel = incomingChannel(installation);
    await this.pool.query(
      `INSERT INTO slack_installations
         (team_id, enterprise_id, installation_enc, bot_token_enc, bot_user_id, incoming_channel_id, incoming_channel_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (team_id) DO UPDATE SET
         enterprise_id = EXCLUDED.enterprise_id,
         installation_enc = EXCLUDED.installation_enc,
         bot_token_enc = EXCLUDED.bot_token_enc,
         bot_user_id = EXCLUDED.bot_user_id,
         incoming_channel_id = EXCLUDED.incoming_channel_id,
         incoming_channel_name = EXCLUDED.incoming_channel_name,
         updated_at = now()`,
      [
        teamId,
        enterpriseId,
        encryptSecret(JSON.stringify(installation)),
        encryptSecret(botToken),
        botUserId,
        channel.id,
        channel.name,
      ]
    );
    return {
      teamId,
      enterpriseId,
      installation,
      botToken,
      botUserId,
      incomingChannelId: channel.id,
      incomingChannelName: channel.name,
    };
  }

  async getSlackInstallation(teamId: string): Promise<SlackInstallation | null> {
    const result = await this.pool.query<{
      team_id: string;
      enterprise_id: string | null;
      installation_enc: string;
      bot_token_enc: string;
      bot_user_id: string | null;
      incoming_channel_id: string | null;
      incoming_channel_name: string | null;
    }>(
      `SELECT team_id, enterprise_id, installation_enc, bot_token_enc, bot_user_id, incoming_channel_id, incoming_channel_name
         FROM slack_installations
        WHERE team_id = $1`,
      [teamId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      teamId: row.team_id,
      enterpriseId: row.enterprise_id,
      installation: JSON.parse(decryptSecret(row.installation_enc)) as Record<string, unknown>,
      botToken: decryptSecret(row.bot_token_enc),
      botUserId: row.bot_user_id,
      incomingChannelId: row.incoming_channel_id,
      incomingChannelName: row.incoming_channel_name,
    };
  }

  async deleteSlackInstallation(teamId: string): Promise<void> {
    await this.pool.query(`DELETE FROM slack_installations WHERE team_id = $1`, [teamId]);
  }

  async createSetupState(input: Omit<SetupState, 'state' | 'expiresAt'>): Promise<SetupState> {
    const state = cryptoRandomState();
    const expiresAt = setupExpiresAt();
    await this.pool.query(
      `INSERT INTO slack_setup_states (state, slack_team_id, enterprise_id, slack_channel_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [state, input.slackTeamId, input.enterpriseId, input.slackChannelId, expiresAt]
    );
    return { state, expiresAt, ...input };
  }

  async getSetupState(state: string): Promise<SetupState | null> {
    const result = await this.pool.query<{
      state: string;
      slack_team_id: string;
      enterprise_id: string | null;
      slack_channel_id: string | null;
      expires_at: string;
    }>(
      `SELECT state, slack_team_id, enterprise_id, slack_channel_id, expires_at
         FROM slack_setup_states
        WHERE state = $1 AND used_at IS NULL AND expires_at > now()`,
      [state]
    );
    const row = result.rows[0];
    return row
      ? {
          state: row.state,
          slackTeamId: row.slack_team_id,
          enterpriseId: row.enterprise_id,
          slackChannelId: row.slack_channel_id,
          expiresAt: new Date(row.expires_at),
        }
      : null;
  }

  async createShipOAuthState(input: Omit<ShipOAuthState, 'expiresAt'>): Promise<ShipOAuthState> {
    const expiresAt = setupExpiresAt();
    await this.pool.query(
      `INSERT INTO slack_ship_oauth_states (state, setup_state, slack_team_id, enterprise_id, code_verifier, slack_channel_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.state, input.setupState, input.slackTeamId, input.enterpriseId, input.codeVerifier, input.slackChannelId, expiresAt]
    );
    return { ...input, expiresAt };
  }

  async consumeShipOAuthState(state: string): Promise<ShipOAuthState | null> {
    const result = await this.pool.query<{
      state: string;
      setup_state: string;
      slack_team_id: string;
      enterprise_id: string | null;
      code_verifier: string;
      slack_channel_id: string | null;
      expires_at: string;
    }>(
      `UPDATE slack_ship_oauth_states
          SET used_at = now()
        WHERE state = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING state, setup_state, slack_team_id, enterprise_id, code_verifier, slack_channel_id, expires_at`,
      [state]
    );
    const row = result.rows[0];
    return row
      ? {
          state: row.state,
          setupState: row.setup_state,
          slackTeamId: row.slack_team_id,
          enterpriseId: row.enterprise_id,
          codeVerifier: row.code_verifier,
          slackChannelId: row.slack_channel_id,
          expiresAt: new Date(row.expires_at),
        }
      : null;
  }

  async upsertConnection(input: Omit<ShipSlackConnection, 'id' | 'createdAt' | 'updatedAt'>): Promise<ShipSlackConnection> {
    const result = await this.pool.query<{ id: string; created_at: string; updated_at: string }>(
      `INSERT INTO slack_ship_connections
         (slack_team_id, enterprise_id, ship_workspace_id, ship_user_id, ship_access_token_enc,
          ship_refresh_token_enc, ship_access_expires_at, ship_scopes, webhook_subscription_id,
          webhook_secret_enc, slack_channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (slack_team_id, ship_workspace_id) DO UPDATE SET
         enterprise_id = EXCLUDED.enterprise_id,
         ship_user_id = EXCLUDED.ship_user_id,
         ship_access_token_enc = EXCLUDED.ship_access_token_enc,
         ship_refresh_token_enc = EXCLUDED.ship_refresh_token_enc,
         ship_access_expires_at = EXCLUDED.ship_access_expires_at,
         ship_scopes = EXCLUDED.ship_scopes,
         webhook_subscription_id = EXCLUDED.webhook_subscription_id,
         webhook_secret_enc = EXCLUDED.webhook_secret_enc,
         slack_channel_id = EXCLUDED.slack_channel_id,
         updated_at = now()
       RETURNING id, created_at, updated_at`,
      [
        input.slackTeamId,
        input.enterpriseId,
        input.shipWorkspaceId,
        input.shipUserId,
        encryptSecret(input.shipAccessToken),
        input.shipRefreshToken ? encryptSecret(input.shipRefreshToken) : null,
        input.shipAccessExpiresAt,
        input.shipScopes,
        input.webhookSubscriptionId,
        input.webhookSecret ? encryptSecret(input.webhookSecret) : null,
        input.slackChannelId,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('slack_ship_connections UPSERT did not return a row');
    return {
      ...input,
      id: row.id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async updateConnectionWebhook(connectionId: string, input: { webhookSubscriptionId: string; webhookSecret: string }): Promise<void> {
    await this.pool.query(
      `UPDATE slack_ship_connections
          SET webhook_subscription_id = $2, webhook_secret_enc = $3, updated_at = now()
        WHERE id = $1`,
      [connectionId, input.webhookSubscriptionId, encryptSecret(input.webhookSecret)]
    );
  }

  async getConnection(connectionId: string): Promise<ShipSlackConnection | null> {
    const result = await this.pool.query<{
      id: string;
      slack_team_id: string;
      enterprise_id: string | null;
      ship_workspace_id: string;
      ship_user_id: string;
      ship_access_token_enc: string;
      ship_refresh_token_enc: string | null;
      ship_access_expires_at: string | null;
      ship_scopes: string[];
      webhook_subscription_id: string | null;
      webhook_secret_enc: string | null;
      slack_channel_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, slack_team_id, enterprise_id, ship_workspace_id, ship_user_id, ship_access_token_enc,
              ship_refresh_token_enc, ship_access_expires_at, ship_scopes, webhook_subscription_id,
              webhook_secret_enc, slack_channel_id, created_at, updated_at
         FROM slack_ship_connections
        WHERE id = $1`,
      [connectionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      slackTeamId: row.slack_team_id,
      enterpriseId: row.enterprise_id,
      shipWorkspaceId: row.ship_workspace_id,
      shipUserId: row.ship_user_id,
      shipAccessToken: decryptSecret(row.ship_access_token_enc),
      shipRefreshToken: row.ship_refresh_token_enc ? decryptSecret(row.ship_refresh_token_enc) : null,
      shipAccessExpiresAt: row.ship_access_expires_at ? new Date(row.ship_access_expires_at) : null,
      shipScopes: row.ship_scopes,
      webhookSubscriptionId: row.webhook_subscription_id,
      webhookSecret: row.webhook_secret_enc ? decryptSecret(row.webhook_secret_enc) : null,
      slackChannelId: row.slack_channel_id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async updateConnectionTokens(connectionId: string, input: {
    shipAccessToken: string;
    shipRefreshToken: string | null;
    shipAccessExpiresAt: Date | null;
    shipScopes: string[];
  }): Promise<void> {
    await this.pool.query(
      `UPDATE slack_ship_connections
          SET ship_access_token_enc = $2,
              ship_refresh_token_enc = $3,
              ship_access_expires_at = $4,
              ship_scopes = $5,
              updated_at = now()
        WHERE id = $1`,
      [
        connectionId,
        encryptSecret(input.shipAccessToken),
        input.shipRefreshToken ? encryptSecret(input.shipRefreshToken) : null,
        input.shipAccessExpiresAt,
        input.shipScopes,
      ]
    );
  }

  async getCachedSlackUser(teamId: string, email: string): Promise<string | null> {
    const result = await this.pool.query<{ slack_user_id: string }>(
      `SELECT slack_user_id FROM slack_user_cache WHERE team_id = $1 AND email = $2`,
      [teamId, normalizeEmail(email)]
    );
    return result.rows[0]?.slack_user_id ?? null;
  }

  async cacheSlackUser(teamId: string, email: string, slackUserId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO slack_user_cache (team_id, email, slack_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, email) DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id, updated_at = now()`,
      [teamId, normalizeEmail(email), slackUserId]
    );
  }

  async hasProcessedEvent(connectionId: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query<{ event_id: string }>(
      `SELECT event_id FROM slack_processed_events WHERE connection_id = $1 AND event_id = $2`,
      [connectionId, eventId]
    );
    return result.rows.length > 0;
  }

  async recordProcessedEvent(connectionId: string, eventId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO slack_processed_events (connection_id, event_id)
       VALUES ($1, $2)
       ON CONFLICT (connection_id, event_id) DO NOTHING`,
      [connectionId, eventId]
    );
  }
}

function cryptoRandomState(): string {
  return `state_${randomBytes(24).toString('base64url')}`;
}
