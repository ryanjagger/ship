export interface SlackIntegrationConfig {
  port: number;
  publicBaseUrl: string;
  shipBaseUrl: string;
  shipClientId: string;
  shipClientSecret?: string;
  shipRedirectUri: string;
  slackClientId: string;
  slackClientSecret: string;
  slackSigningSecret: string;
  slackStateSecret: string;
  databaseUrl: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SlackIntegrationConfig {
  const publicBaseUrl = required(env, 'PUBLIC_BASE_URL').replace(/\/$/, '');
  return {
    port: Number.parseInt(env.PORT ?? '3001', 10),
    publicBaseUrl,
    shipBaseUrl: required(env, 'SHIP_BASE_URL').replace(/\/$/, ''),
    shipClientId: required(env, 'SHIP_CLIENT_ID'),
    shipClientSecret: optional(env, 'SHIP_CLIENT_SECRET'),
    shipRedirectUri: optional(env, 'SHIP_REDIRECT_URI') ?? `${publicBaseUrl}/ship/oauth/callback`,
    slackClientId: required(env, 'SLACK_CLIENT_ID'),
    slackClientSecret: required(env, 'SLACK_CLIENT_SECRET'),
    slackSigningSecret: required(env, 'SLACK_SIGNING_SECRET'),
    slackStateSecret: required(env, 'SLACK_STATE_SECRET'),
    databaseUrl: required(env, 'DATABASE_URL'),
  };
}
