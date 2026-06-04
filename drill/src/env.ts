/**
 * Ship server harness for the drill.
 *
 * Yields a freshly-migrated, freshly-seeded Ship API spawned from the built
 * `api/dist/index.js`, with webhook delivery enabled and private targets allowed
 * (so a 127.0.0.1 listener passes the SSRF guard). Postgres comes from either:
 *   - process.env.DATABASE_URL (CI reuses the postgres:16 service container), or
 *   - a throwaway @testcontainers/postgresql container (local dev, no DB needed).
 *
 * Migrations (053/056) seed the `client_ship_cli` OAuth app; `db:seed` seeds the
 * dev@ship.local super-admin who approves the device code. Mirrors the spawn/env
 * shape of e2e/fixtures/isolated-env.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import getPort from 'get-port';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { AdminCreds } from './auto-approve.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Fixed 32-byte test key (64 hex). Only used by the ephemeral drill server.
const TEST_WEBHOOK_ENC_KEY = '0'.repeat(64);

export const ADMIN_CREDS: AdminCreds = { email: 'dev@ship.local', password: 'admin123' };

export interface ShipServer {
  apiUrl: string;
  adminCreds: AdminCreds;
}

interface ResolvedDb {
  url: string;
  stop: () => Promise<void>;
}

async function resolveDatabase(log: (m: string) => void): Promise<ResolvedDb> {
  if (process.env.DATABASE_URL) {
    log(`Using DATABASE_URL from environment`);
    return { url: process.env.DATABASE_URL, stop: async () => undefined };
  }
  log(`No DATABASE_URL — starting a throwaway Postgres container...`);
  const container = await new PostgreSqlContainer('postgres:16').start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop().catch(() => undefined);
    },
  };
}

async function runPnpm(args: string[], databaseUrl: string, log: (m: string) => void): Promise<void> {
  log(`pnpm ${args.join(' ')}`);
  await execFileAsync('pnpm', args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      DOTENV_CONFIG_PATH: '/dev/null', // don't let api/.env.local override DATABASE_URL
    },
    maxBuffer: 1024 * 1024 * 32,
  });
}

async function waitForHealth(apiUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/health`);
      if (res.ok) return;
      lastErr = new Error(`health ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`);
}

/**
 * Spin up Ship, run `fn`, and tear everything down — even on failure.
 */
export async function withShipServer<T>(fn: (server: ShipServer) => Promise<T>): Promise<T> {
  const debug = process.env.DRILL_DEBUG === '1';
  const log = (m: string): void => console.error(`  [env] ${m}`);

  const apiDist = path.join(PROJECT_ROOT, 'api', 'dist', 'index.js');
  if (!existsSync(apiDist)) {
    throw new Error(
      `Built API not found at ${apiDist}.\n` +
        `  Build it first: pnpm run build:shared && pnpm --filter @ship/api build`,
    );
  }

  const db = await resolveDatabase(log);
  let api: ChildProcess | undefined;

  try {
    await runPnpm(['--filter', '@ship/api', 'db:migrate'], db.url, log);
    await runPnpm(['--filter', '@ship/api', 'db:seed'], db.url, log);

    const port = await getPort();
    const apiUrl = `http://127.0.0.1:${port}`;
    log(`Spawning API on ${apiUrl}...`);

    api = spawn('node', ['dist/index.js'], {
      cwd: path.join(PROJECT_ROOT, 'api'),
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: db.url,
        NODE_ENV: 'test',
        CORS_ORIGIN: '*',
        DOTENV_CONFIG_PATH: '/dev/null',
        SESSION_SECRET: process.env.SESSION_SECRET ?? 'ttfe-drill-session-secret',
        WEBHOOKS_DELIVERY_ENABLED: 'true',
        WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
        WEBHOOK_SECRET_ENC_KEY: process.env.WEBHOOK_SECRET_ENC_KEY ?? TEST_WEBHOOK_ENC_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    api.stdout?.on('data', (d: Buffer) => {
      if (debug) console.error(`  [api] ${d.toString().trim()}`);
    });
    api.stderr?.on('data', (d: Buffer) => {
      console.error(`  [api:err] ${d.toString().trim()}`);
    });

    await waitForHealth(apiUrl, 30_000);
    log(`API healthy.`);

    return await fn({ apiUrl, adminCreds: ADMIN_CREDS });
  } finally {
    if (api && !api.killed) {
      api.kill('SIGTERM');
    }
    await db.stop();
  }
}
