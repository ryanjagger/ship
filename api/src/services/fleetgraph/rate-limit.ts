/**
 * U9 — per-user chat cost guard (R19).
 *
 * Mirrors the in-memory token-bucket limiter in `services/fleet-ai.ts`
 * (`checkFleetRefreshRateLimit` / `checkFleetReviewRateLimit`). One token is
 * consumed per chat TURN, BEFORE graph entry — so a `Command` resume (which never
 * calls this code) cannot re-bill, per the U7 side-effect-ordering contract.
 *
 * RESIDUAL RISK (documented, accepted for this iteration): this limiter is
 * IN-MEMORY and PER-PROCESS. It resets on process restart and is not shared
 * across instances. That is acceptable for the single-instance Elastic Beanstalk
 * deployment today. The durable upgrade is a Postgres-backed counter on the
 * user's person document (a `properties.fleetgraph_chat_budget` blob with a
 * window reset), which survives restarts and works across instances — deferred
 * until multi-instance scaling makes the per-process window a real abuse vector.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const chatLimits = new Map<string, Bucket>();

/** Max chat turns per user per hour. Tunable; matches the refresh-limit shape. */
const CHAT_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function takeToken(userId: string, limit: number): boolean {
  const now = Date.now();
  const entry = chatLimits.get(userId);
  if (!entry || now >= entry.resetAt) {
    chatLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of chatLimits) {
    if (now >= entry.resetAt) chatLimits.delete(key);
  }
}, 10 * 60 * 1000);
// Don't keep the process (or the test runner) alive for this timer.
cleanup.unref?.();

/** Returns false when the user has exceeded the per-user chat-turn budget. */
export function checkFleetChatRateLimit(userId: string): boolean {
  return takeToken(userId, CHAT_RATE_LIMIT);
}

/** Test-only: clear the rate-limit buckets. */
export function __resetFleetChatRateLimitForTests(): void {
  chatLimits.clear();
}
