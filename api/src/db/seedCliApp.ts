#!/usr/bin/env tsx
/**
 * Idempotent seed for the first-party `ship` CLI's PUBLIC OAuth client.
 *
 * The CLI uses the Device Authorization Grant (RFC 8628), which authenticates a
 * public client by client_id + the device_code it holds — NO client_secret. The
 * stored secret hash is therefore a throwaway (never disclosed, never checked by
 * the device flow); it exists only to satisfy the NOT NULL column.
 *
 * Run with:  pnpm --filter @ship/api db:seed:cli
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { loadProductionSecrets } from '../config/ssm.js';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });

// Fixed, documented client_id so the CLI can default to it (override via env).
const CLI_CLIENT_ID = process.env.SHIP_CLI_CLIENT_ID ?? 'client_ship_cli';
const CLI_SCOPES = ['documents:read', 'documents:write'];

async function main(): Promise<void> {
  await loadProductionSecrets();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // Public client: the secret is unused by device flow. On conflict we leave
    // the existing hash untouched and only refresh the scopes.
    const throwawayHash = await bcrypt.hash(`unused_${crypto.randomBytes(16).toString('hex')}`, 12);
    await pool.query(
      `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow)
       VALUES ($1, $2, 'Ship CLI', ARRAY[]::text[], NULL, $3, true)
       ON CONFLICT (client_id) DO UPDATE SET
         requested_scopes  = EXCLUDED.requested_scopes,
         allow_device_flow = true,
         updated_at        = now()`,
      [CLI_CLIENT_ID, throwawayHash, CLI_SCOPES]
    );

    console.log('✅ Ship CLI client seeded');
    console.log(`   client_id : ${CLI_CLIENT_ID}`);
    console.log(`   scopes    : ${CLI_SCOPES.join(', ')}`);
    console.log(`   grant     : device flow (public client — no secret)`);
  } catch (error) {
    console.error('CLI seed failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
