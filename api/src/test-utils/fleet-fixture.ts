/**
 * Test fixture for code paths that go through the Fleet API client
 * (`withFleetClient`): seeds the `client_ship_fleet_agent` system app (the
 * fixture-of-record is migration 062, but the suite's TRUNCATE cascades over
 * oauth_apps) and wires the client to an in-process Express app via the
 * supertest fetch adapter — no listening socket.
 */

import type { Express } from 'express';
import { pool } from '../db/client.js';
import { supertestFetch } from './supertest-fetch.js';
import { configureFleetApiClient, resetFleetApiClient, FLEET_AGENT_CLIENT_ID } from '../services/fleetgraph/api-client.js';

/** Mirror of the migration-062 oauth_apps insert. Idempotent. */
export async function seedFleetAgentApp(): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, client_type, allow_device_flow, is_system)
     VALUES ($1, NULL, 'Fleet Agent', ARRAY[]::text[], NULL, ARRAY['projects:read', 'projects:write', 'issues:read', 'issues:write', 'sprints:read', 'programs:read', 'people:read', 'standups:read', 'comments:read', 'comments:write', 'documents:read'], 'public', false, true)
     ON CONFLICT (client_id) DO NOTHING`,
    [FLEET_AGENT_CLIENT_ID]
  );
}

/** Seed the app row and point the Fleet client at the given in-process app. */
export async function setupFleetClientForTests(app: Express): Promise<void> {
  await seedFleetAgentApp();
  resetFleetApiClient();
  configureFleetApiClient({ baseUrl: '', fetch: supertestFetch(app) });
}

export { resetFleetApiClient };
