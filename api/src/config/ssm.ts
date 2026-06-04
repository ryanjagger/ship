/**
 * SSM Parameter Store - Application Configuration
 *
 * This file loads application configuration from AWS SSM Parameter Store.
 *
 * Secrets Storage:
 * ─────────────────
 * SSM Parameter Store (/ship/{env}/):
 *   - DATABASE_URL, SESSION_SECRET, CORS_ORIGIN
 *   - Application config that changes per environment
 *   - CAIA OAuth credentials (CAIA_ISSUER_URL, CAIA_CLIENT_ID, etc.)
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Lazy-initialized client to avoid keeping Node.js alive during import tests
let _client: SSMClient | null = null;

function getClient(): SSMClient {
  if (!_client) {
    _client = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return _client;
}

export async function getSSMSecret(name: string): Promise<string> {
  const command = new GetParameterCommand({
    Name: name,
    WithDecryption: true,
  });

  const response = await getClient().send(command);
  if (!response.Parameter?.Value) {
    throw new Error(`SSM parameter ${name} not found`);
  }
  return response.Parameter.Value;
}

/**
 * Fetch an optional SSM parameter. Returns undefined (never throws) when the
 * parameter is absent or unreadable, so optional config does not block startup.
 *
 * A genuinely-absent parameter (ParameterNotFound) is expected and silent. Any
 * other failure (IAM denial, network, throttling) still fails open, but logs a
 * warning — otherwise a misconfigured prod role silently disables the optional
 * feature with no signal for an operator diagnosing missing behavior.
 */
export async function getSSMSecretOptional(name: string): Promise<string | undefined> {
  try {
    const response = await getClient().send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return response.Parameter?.Value || undefined;
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    if (errName !== 'ParameterNotFound' && errName !== 'ParameterVersionNotFound') {
      console.warn(`[ssm] optional parameter ${name} could not be read (${errName ?? 'unknown error'}); continuing without it`);
    }
    return undefined;
  }
}

export async function loadProductionSecrets(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return; // Use .env files for local dev
  }

  const environment = process.env.ENVIRONMENT || 'prod';
  const basePath = `/ship/${environment}`;

  console.log(`Loading secrets from SSM path: ${basePath}`);

  const [databaseUrl, sessionSecret, corsOrigin, cdnDomain, appBaseUrl] = await Promise.all([
    getSSMSecret(`${basePath}/DATABASE_URL`),
    getSSMSecret(`${basePath}/SESSION_SECRET`),
    getSSMSecret(`${basePath}/CORS_ORIGIN`),
    getSSMSecret(`${basePath}/CDN_DOMAIN`),
    getSSMSecret(`${basePath}/APP_BASE_URL`),
  ]);

  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.CORS_ORIGIN = corsOrigin;
  process.env.CDN_DOMAIN = cdnDomain;
  process.env.APP_BASE_URL = appBaseUrl;

  // Optional: LangSmith API key for Fleet observability. Tracing is opt-in
  // (gated by the LANGSMITH_TRACING EB setting), so a missing key must NOT
  // block startup — load best-effort. Runs before app.js import, so the key is
  // present before any FleetGraph invoke when configured.
  const langsmithApiKey = await getSSMSecretOptional(`${basePath}/LANGSMITH_API_KEY`);
  if (langsmithApiKey) {
    process.env.LANGSMITH_API_KEY = langsmithApiKey;
    console.log('LANGSMITH_API_KEY loaded from SSM (Fleet tracing enabled if LANGSMITH_TRACING=true)');
  }

  // Optional: AES-256-GCM key for encrypting webhook signing secrets. Required
  // only when webhooks are in use (WEBHOOKS_DELIVERY_ENABLED=true and apps create
  // subscriptions), so a missing key must NOT block startup — load best-effort.
  // Runs before app.js import, so the key is present before any encrypt/decrypt.
  const webhookEncKey = await getSSMSecretOptional(`${basePath}/WEBHOOK_SECRET_ENC_KEY`);
  if (webhookEncKey) {
    process.env.WEBHOOK_SECRET_ENC_KEY = webhookEncKey;
    console.log('WEBHOOK_SECRET_ENC_KEY loaded from SSM (webhook signing-secret encryption enabled)');
  }

  console.log('Secrets loaded from SSM Parameter Store');
  console.log(`CORS_ORIGIN: ${corsOrigin}`);
  console.log(`CDN_DOMAIN: ${cdnDomain}`);
  console.log(`APP_BASE_URL: ${appBaseUrl}`);
}
