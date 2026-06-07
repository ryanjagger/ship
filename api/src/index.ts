import { createServer } from 'http';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables (.env.local takes precedence)
config({ path: join(__dirname, '../.env.local') });
config({ path: join(__dirname, '../.env') });

async function main() {
  // Load secrets from SSM in production (before importing app)
  if (process.env.NODE_ENV === 'production') {
    const { loadProductionSecrets } = await import('./config/ssm.js');
    await loadProductionSecrets();
  }

  // Now import app after secrets are loaded
  const { createApp } = await import('./app.js');
  const { setupCollaboration } = await import('./collaboration/index.js');
  const { startScheduler } = await import('./scheduler/index.js');
  const { startWebhookScheduler } = await import('./platform/webhooks/scheduler.js');
  const { configureFleetApiClient } = await import('./services/fleetgraph/api-client.js');

  const PORT = process.env.PORT || 3000;
  const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

  const app = createApp(CORS_ORIGIN);
  const server = createServer(app);

  // DDoS protection: Set server-wide timeouts to prevent slow-read attacks (Slowloris)
  server.timeout = 60000; // 60 seconds max request duration
  server.keepAliveTimeout = 65000; // 65 seconds (slightly longer than timeout)
  server.headersTimeout = 66000; // 66 seconds (slightly longer than keepAlive)

  // Setup WebSocket collaboration server
  setupCollaboration(server);

  // Start server
  server.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);

    // Fleet agent → public API transport: loopback HTTP into this same server
    // (SHIP_SELF_URL overrides for deployments where loopback is wrong), so
    // scopes, rate limits, and the public audit trail genuinely execute on
    // every Fleet domain read/write.
    configureFleetApiClient({ baseUrl: process.env.SHIP_SELF_URL || `http://127.0.0.1:${PORT}` });
  });

  // Register the FleetGraph hourly sweep (gated by FLEETGRAPH_SWEEP_ENABLED;
  // returns silently when the env flag is not 'true').
  startScheduler();

  // Register the webhook delivery tick (gated by WEBHOOKS_DELIVERY_ENABLED;
  // returns silently when the env flag is not 'true').
  startWebhookScheduler();
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
