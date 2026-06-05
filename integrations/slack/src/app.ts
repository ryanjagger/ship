import { App, ExpressReceiver } from '@slack/bolt';
import type { ExpressReceiverOptions } from '@slack/bolt';
import type { SlackIntegrationConfig } from './config.js';
import { createSlackSetupRedirect } from './oauth.js';
import { createShipOAuthRouter } from './oauth.js';
import { createShipWebhookRouter } from './webhooks.js';
import type { SlackIntegrationStore } from './types.js';

function valueAt(path: string, object: Record<string, unknown>): string | null {
  let current: unknown = object;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : null;
}

export function createSlackIntegrationApp(config: SlackIntegrationConfig, store: SlackIntegrationStore): App {
  const receiver = new ExpressReceiver({
    signingSecret: config.slackSigningSecret,
    clientId: config.slackClientId,
    clientSecret: config.slackClientSecret,
    stateSecret: config.slackStateSecret,
    scopes: ['chat:write', 'incoming-webhook', 'users:read.email', 'im:write'],
    installationStore: store.boltInstallationStore() as unknown as ExpressReceiverOptions['installationStore'],
    installerOptions: {
      installPath: '/slack/install',
      redirectUriPath: '/slack/oauth_redirect',
      callbackOptions: {
        successAsync: async (installation, _options, _req, res) => {
          try {
            const record = installation as unknown as Record<string, unknown>;
            const teamId = valueAt('team.id', record);
            if (!teamId) throw new Error('Slack OAuth callback did not include team.id');
            const redirect = await createSlackSetupRedirect(store, {
              slackTeamId: teamId,
              enterpriseId: valueAt('enterprise.id', record),
              slackChannelId: valueAt('incomingWebhook.channelId', record),
            });
            res.writeHead(302, { Location: redirect });
            res.end();
          } catch (error) {
            console.error('[slack-integration] Slack OAuth success callback failed:', error);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end();
          }
        },
      },
    },
  });

  receiver.router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'ship-slack-integration' });
  });
  receiver.router.use(createShipOAuthRouter(config, store));
  receiver.router.use(createShipWebhookRouter(config, store));

  return new App({ receiver });
}
