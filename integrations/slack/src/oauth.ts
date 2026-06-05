import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { ShipClient } from '@ryanjagger/ship-sdk';
import type { SlackIntegrationConfig } from './config.js';
import type { SlackIntegrationStore } from './types.js';

const SHIP_SCOPES = 'issues:read people:read webhooks:manage offline_access';

function base64UrlSha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function randomVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function randomState(): string {
  return `state_${crypto.randomBytes(24).toString('base64url')}`;
}

function html(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body>`;
}

async function exchangeCode(config: SlackIntegrationConfig, code: string, verifier: string) {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.shipRedirectUri,
    client_id: config.shipClientId,
    code_verifier: verifier,
  };
  if (config.shipClientSecret) body.client_secret = config.shipClientSecret;

  const res = await fetch(`${config.shipBaseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const error = typeof json.error === 'string' ? json.error : 'token_exchange_failed';
    throw new Error(`Ship token exchange failed: ${error}`);
  }
  return json as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token?: string;
  };
}

export function createShipOAuthRouter(config: SlackIntegrationConfig, store: SlackIntegrationStore): RouterType {
  const router: RouterType = Router();

  router.get('/ship/install', async (req: Request, res: Response): Promise<void> => {
    const setupState = typeof req.query.setup === 'string' ? req.query.setup : '';
    const setup = setupState ? await store.getSetupState(setupState) : null;
    if (!setup) {
      res.status(400).send(html('Slack setup expired', 'Start again from /slack/install.'));
      return;
    }

    const verifier = randomVerifier();
    const state = randomState();
    await store.createShipOAuthState({
      state,
      setupState: setup.state,
      slackTeamId: setup.slackTeamId,
      enterpriseId: setup.enterpriseId,
      codeVerifier: verifier,
      slackChannelId: setup.slackChannelId,
    });

    const authUrl = new URL('/api/oauth/authorize', config.shipBaseUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config.shipClientId);
    authUrl.searchParams.set('redirect_uri', config.shipRedirectUri);
    authUrl.searchParams.set('scope', SHIP_SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', base64UrlSha256(verifier));
    authUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(authUrl.toString());
  });

  router.get('/ship/oauth/callback', async (req: Request, res: Response): Promise<void> => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      res.status(400).send(html('Ship authorization failed', 'Missing code or state.'));
      return;
    }

    const oauthState = await store.consumeShipOAuthState(state);
    if (!oauthState) {
      res.status(400).send(html('Ship authorization expired', 'Start again from /slack/install.'));
      return;
    }

    try {
      const token = await exchangeCode(config, code, oauthState.codeVerifier);
      const client = new ShipClient({ token: token.access_token, baseUrl: config.shipBaseUrl });
      const me = await client.me();
      const connection = await store.upsertConnection({
        slackTeamId: oauthState.slackTeamId,
        enterpriseId: oauthState.enterpriseId,
        shipWorkspaceId: me.workspace.id,
        shipUserId: me.id,
        shipAccessToken: token.access_token,
        shipRefreshToken: token.refresh_token ?? null,
        shipAccessExpiresAt: new Date(Date.now() + token.expires_in * 1000),
        shipScopes: token.scope.split(/\s+/).filter(Boolean),
        webhookSubscriptionId: null,
        webhookSecret: null,
        slackChannelId: oauthState.slackChannelId,
      });

      const webhook = await client.webhooks.create({
        url: `${config.publicBaseUrl}/ship/webhooks/${connection.id}`,
        events: ['issue.created', 'issue.assigned'],
      });
      await store.updateConnectionWebhook(connection.id, {
        webhookSubscriptionId: webhook.id,
        webhookSecret: webhook.secret,
      });

      res.send(html('Slack integration connected', `Ship workspace ${me.workspace.name} is now connected to Slack.`));
    } catch (error) {
      console.error('[slack-integration] Ship OAuth callback failed:', error);
      res.status(500).send(html('Slack integration failed', 'Ship authorization succeeded, but setup could not be completed.'));
    }
  });

  return router;
}

export async function createSlackSetupRedirect(
  store: SlackIntegrationStore,
  input: { slackTeamId: string; enterpriseId: string | null; slackChannelId: string | null },
): Promise<string> {
  const setup = await store.createSetupState(input);
  return `/ship/install?setup=${encodeURIComponent(setup.state)}`;
}
