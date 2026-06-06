import 'dotenv/config';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createSlackIntegrationApp } from './app.js';
import { PgSlackIntegrationStore } from './storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new PgSlackIntegrationStore(pool);
  await store.ensureSchema();

  const app = createSlackIntegrationApp(config, store);
  await app.start(config.port);
  console.log(`Ship Slack integration running on http://localhost:${config.port}`);
}

main().catch((error) => {
  console.error('Failed to start Ship Slack integration:', error);
  process.exit(1);
});

export { createSlackIntegrationApp } from './app.js';
export { createShipWebhookRouter } from './webhooks.js';
export { dispatchShipWebhook } from './dispatch.js';
export { PgSlackIntegrationStore } from './storage.js';
export { InMemorySlackIntegrationStore } from './memory-store.js';
export type * from './types.js';
