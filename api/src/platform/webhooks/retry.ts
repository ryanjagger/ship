/**
 * Retry policy (PRD §Retries).
 *
 * Schedule: 1s, 4s, 16s, 1m, 5m, 30m — the initial attempt plus six retries. If
 * the sixth retry fails the delivery is dead-lettered. Each delay gets ±10%
 * jitter so a fleet of failing deliveries doesn't retry in lockstep.
 *
 * Classification: 2xx succeeds; 4xx is a permanent failure (no retry → DLQ);
 * 5xx, timeouts, and network errors are retryable.
 */

export const RETRY_SCHEDULE_MS = [1000, 4000, 16000, 60000, 300000, 1800000];

/** Number of attempts (initial + retries) before a delivery is dead-lettered. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/**
 * When to make the next attempt, given how many attempts have already been made.
 * After the initial attempt `attemptCount` is 1 → wait `RETRY_SCHEDULE_MS[0]`.
 * Returns null once the schedule is exhausted (caller dead-letters).
 */
export function nextAttemptAt(attemptCount: number, now: number = Date.now()): Date | null {
  const idx = attemptCount - 1;
  if (idx < 0 || idx >= RETRY_SCHEDULE_MS.length) return null;
  const base = RETRY_SCHEDULE_MS[idx]!;
  const jitter = base * (Math.random() * 0.2 - 0.1); // ±10%
  return new Date(now + base + jitter);
}

export type DeliveryClassification = 'success' | 'permanent' | 'retryable';

/** Classify an HTTP response status. Non-HTTP failures are retryable directly. */
export function classifyStatus(status: number): DeliveryClassification {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retryable';
}
