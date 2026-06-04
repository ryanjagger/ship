import type { PoolClient } from 'pg';
import { pool } from '../../../../db/client.js';

/**
 * Continuous-refill token-bucket rate limiter for the Platform API (PRD §6).
 *
 * Two buckets are checked per request — one per OAuth app, one per access token
 * — and the decision is the STRICTER of the two: the request is allowed only if
 * BOTH have capacity, and a token is consumed from both only when allowed (so a
 * denial by one bucket never drains the other). All refill + consume math runs
 * inside ONE transaction with the rows locked `FOR UPDATE`, so concurrent
 * requests serialize correctly.
 */

export interface RateLimitConfig {
  /** Per-OAuth-app budget (requests per window). */
  appLimit: number;
  /** Per-access-token budget (requests per window). */
  tokenLimit: number;
  /** Window length in seconds over which a bucket refills to its full limit. */
  windowSeconds: number;
}

export interface BucketState {
  key: string;
  limit: number;
  remaining: number;
  /** Epoch seconds when this bucket will next be full. */
  resetAtSec: number;
  /** Seconds until this bucket can accept one more request (0 if it can now). */
  retryAfterSec: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** The more-constraining bucket — drives the X-RateLimit-* response headers. */
  limiting: BucketState;
  app: BucketState;
  token: BucketState;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Resolve limits from env (with conservative defaults from PRD §6). */
export function rateLimitConfig(): RateLimitConfig {
  return {
    appLimit: envInt('PLATFORM_RATE_LIMIT_APP_PER_MIN', 600),
    tokenLimit: envInt('PLATFORM_RATE_LIMIT_TOKEN_PER_MIN', 120),
    windowSeconds: envInt('PLATFORM_RATE_LIMIT_WINDOW_SEC', 60),
  };
}

interface BucketRow {
  remaining: string | number;
  reset_at: Date;
  updated_at: Date;
  now: Date;
}

/**
 * Lock a bucket row (creating it full if absent), apply continuous refill up to
 * `now`, and return the refilled remaining + server clock. Does NOT consume yet
 * — consumption happens only after BOTH buckets are known to have capacity.
 */
async function refillBucket(
  client: PoolClient,
  key: string,
  limit: number,
  ratePerSec: number,
  nowExpr = 'now()'
): Promise<{ remaining: number; now: Date }> {
  // Upsert-then-lock: ensure the row exists, then read it FOR UPDATE.
  await client.query(
    `INSERT INTO public_api_rate_limit_buckets (bucket_key, bucket_limit, remaining, reset_at, updated_at)
     VALUES ($1, $2::integer, $2::numeric, ${nowExpr}, ${nowExpr})
     ON CONFLICT (bucket_key) DO NOTHING`,
    [key, limit]
  );
  const { rows } = await client.query<BucketRow>(
    `SELECT remaining, reset_at, updated_at, ${nowExpr} AS now
       FROM public_api_rate_limit_buckets
      WHERE bucket_key = $1
        FOR UPDATE`,
    [key]
  );
  const row = rows[0]!;
  const now = row.now;
  const elapsedSec = Math.max(0, (now.getTime() - row.updated_at.getTime()) / 1000);
  const current = typeof row.remaining === 'string' ? Number(row.remaining) : row.remaining;
  const refilled = Math.min(limit, current + elapsedSec * ratePerSec);
  return { remaining: refilled, now };
}

function bucketState(key: string, limit: number, remaining: number, now: Date, ratePerSec: number): BucketState {
  const deficit = Math.max(0, limit - remaining);
  const resetAtSec = Math.ceil(now.getTime() / 1000 + (ratePerSec > 0 ? deficit / ratePerSec : 0));
  const retryAfterSec = remaining >= 1 ? 0 : Math.ceil((1 - remaining) / ratePerSec);
  return { key, limit, remaining: Math.floor(remaining), resetAtSec, retryAfterSec };
}

async function persistBucket(
  client: PoolClient,
  key: string,
  limit: number,
  remaining: number,
  ratePerSec: number,
  nowExpr = 'now()'
): Promise<void> {
  const deficit = Math.max(0, limit - remaining);
  await client.query(
    `UPDATE public_api_rate_limit_buckets
        SET remaining = $2,
            bucket_limit = $3,
            updated_at = ${nowExpr},
            reset_at = ${nowExpr} + make_interval(secs => $4)
      WHERE bucket_key = $1`,
    [key, remaining, limit, ratePerSec > 0 ? deficit / ratePerSec : 0]
  );
}

/**
 * Refill + consume both buckets atomically and return the decision. When
 * allowed, one token is removed from each; when denied, neither is consumed.
 */
export async function consumeRateLimit(
  appId: string,
  tokenId: string,
  config: RateLimitConfig = rateLimitConfig()
): Promise<RateLimitDecision> {
  const appRate = config.appLimit / config.windowSeconds;
  const tokenRate = config.tokenLimit / config.windowSeconds;
  const appKey = `app:${appId}`;
  const tokenKey = `token:${tokenId}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock both rows in a stable key order to avoid deadlocks between concurrent
    // requests, then map the results back to app/token regardless of order.
    const appLocksFirst = appKey <= tokenKey;
    let appRefill: { remaining: number; now: Date };
    let tokenRefill: { remaining: number; now: Date };
    if (appLocksFirst) {
      appRefill = await refillBucket(client, appKey, config.appLimit, appRate);
      tokenRefill = await refillBucket(client, tokenKey, config.tokenLimit, tokenRate);
    } else {
      tokenRefill = await refillBucket(client, tokenKey, config.tokenLimit, tokenRate);
      appRefill = await refillBucket(client, appKey, config.appLimit, appRate);
    }

    const allowed = appRefill.remaining >= 1 && tokenRefill.remaining >= 1;

    const appRemaining = allowed ? appRefill.remaining - 1 : appRefill.remaining;
    const tokenRemaining = allowed ? tokenRefill.remaining - 1 : tokenRefill.remaining;

    await persistBucket(client, appKey, config.appLimit, appRemaining, appRate);
    await persistBucket(client, tokenKey, config.tokenLimit, tokenRemaining, tokenRate);
    await client.query('COMMIT');

    const app = bucketState(appKey, config.appLimit, appRemaining, appRefill.now, appRate);
    const token = bucketState(tokenKey, config.tokenLimit, tokenRemaining, tokenRefill.now, tokenRate);
    // The limiting bucket is whichever has fewer tokens left (drives headers +
    // Retry-After). On a tie, prefer the one that actually denied.
    const limiting = token.remaining <= app.remaining ? token : app;
    return { allowed, limiting, app, token };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
