/**
 * Fleet API client — how the Fleet agent reaches Ship DOMAIN data.
 *
 * Every Fleet domain read/write travels the public API (`/api/v1`) through
 * `@ryanjagger/ship-sdk` as the `client_ship_fleet_agent` OAuth app (migration
 * 062): scope-bounded, rate-limited (per-workspace system-app bucket), visible
 * in `public_api_audit_logs`, and constrained to exactly what a third-party
 * agent could do. The agent's capabilities ARE its app's scopes. Agent
 * MACHINERY (LLM calls, checkpoints, insight upserts, caches, locks) stays on
 * internal paths — see issue #95's boundary rule.
 *
 * Modeled on the Developer Portal's `web/src/lib/portal-client.ts`, with the
 * mint done in-process (`issueAccessToken`) instead of an HTTP exchange:
 * Fleet runs inside the API server, so there is no session to exchange and no
 * reason to loop a credential through HTTP. The REQUESTS go over HTTP
 * (loopback in production, an injected fetch in tests) so the bearer
 * middleware, scopes, rate limits, and audit trail all genuinely execute.
 *
 * TOKEN CACHE INVARIANT (PR #94 review, P1): the cache key is
 * `${userId}:${workspaceId}` and must NEVER widen. Chat turns mint for the
 * acting user; the sweep mints for the fleet@ship.system service user. A
 * shared or workspace-only entry would let one user's chat turn ride another
 * identity's token. Tokens stay valid until their 15-minute TTL regardless of
 * the originating session (validateAccessToken re-checks workspace membership
 * per request, so a removed member's token dies immediately) — keep the TTL
 * short and do not add refresh tokens.
 */

import { ShipClient, toShipSDKError } from '@ryanjagger/ship-sdk';
import { pool } from '../../db/client.js';
import { issueAccessToken } from '../../platform/oauth/tokens.js';

export const FLEET_AGENT_CLIENT_ID = 'client_ship_fleet_agent';

/** 15-minute tokens: the bound on how long a mint outlives its trigger. */
const TOKEN_TTL_MS = 15 * 60 * 1000;
/** Re-mint this long before expiry so in-flight calls don't race the TTL. */
const EXPIRY_MARGIN_MS = 60_000;

interface FleetApiClientConfig {
  /** Origin requests are sent to, e.g. `http://127.0.0.1:3000`. */
  baseUrl: string;
  /** Injected transport for tests (supertest adapter) — no socket needed. */
  fetch?: typeof fetch;
}

let config: FleetApiClientConfig | null = null;

/**
 * Wire the transport. Called once from `index.ts` after `server.listen` with
 * the loopback origin (`SHIP_SELF_URL` overrides for deployments where
 * loopback is wrong); tests call it with a supertest-backed `fetch`.
 */
export function configureFleetApiClient(opts: { baseUrl: string; fetch?: typeof fetch }): void {
  config = { baseUrl: opts.baseUrl, fetch: opts.fetch };
}

interface FleetAppRow {
  id: string;
  requested_scopes: string[];
}

// Memoized app lookup — the system app row is immutable at runtime.
let cachedApp: FleetAppRow | null = null;

async function getFleetApp(): Promise<FleetAppRow> {
  if (cachedApp) return cachedApp;
  const result = await pool.query<FleetAppRow>(
    'SELECT id, requested_scopes FROM oauth_apps WHERE client_id = $1',
    [FLEET_AGENT_CLIENT_ID]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`OAuth app ${FLEET_AGENT_CLIENT_ID} not found — run migration 062`);
  }
  cachedApp = row;
  return cachedApp;
}

export interface FleetClientContext {
  userId: string;
  workspaceId: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Keyed `${userId}:${workspaceId}` — see the module-doc invariant.
const tokenCache = new Map<string, CachedToken>();

async function mintToken(ctx: FleetClientContext, cacheKey: string): Promise<CachedToken> {
  const app = await getFleetApp();
  const issued = await issueAccessToken(
    { appId: app.id, userId: ctx.userId, workspaceId: ctx.workspaceId, scopes: app.requested_scopes },
    { ttlMs: TOKEN_TTL_MS }
  );
  const entry: CachedToken = {
    token: issued.accessToken,
    expiresAt: Date.now() + issued.expiresInSeconds * 1000,
  };
  tokenCache.set(cacheKey, entry);
  return entry;
}

function makeClient(token: string): ShipClient {
  if (!config) {
    throw new Error('Fleet API client not configured — call configureFleetApiClient() at startup');
  }
  return new ShipClient({ token, baseUrl: config.baseUrl, fetch: config.fetch });
}

/**
 * Run `fn` with an authenticated ShipClient for the acting user + workspace.
 * Mints when nothing is cached for THIS (user, workspace) or expiry is near;
 * retries exactly once with a fresh token on a 401 (expired/revoked). A 403 is
 * a real authorization answer (missing scope, lost membership) — a fresh token
 * would not change it, so it propagates.
 */
export async function withFleetClient<T>(
  ctx: FleetClientContext,
  fn: (client: ShipClient) => Promise<T>
): Promise<T> {
  if (!config) {
    throw new Error('Fleet API client not configured — call configureFleetApiClient() at startup');
  }
  const cacheKey = `${ctx.userId}:${ctx.workspaceId}`;
  const cached = tokenCache.get(cacheKey);
  const fresh =
    cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS ? cached : await mintToken(ctx, cacheKey);
  try {
    return await fn(makeClient(fresh.token));
  } catch (err) {
    const sdkErr = toShipSDKError(err);
    if (!(sdkErr.kind === 'auth' && sdkErr.status === 401)) throw err;
    const reminted = await mintToken(ctx, cacheKey);
    return fn(makeClient(reminted.token));
  }
}

/** Test-only: drop config, app memo, and every cached token. */
export function resetFleetApiClient(): void {
  config = null;
  cachedApp = null;
  tokenCache.clear();
}
