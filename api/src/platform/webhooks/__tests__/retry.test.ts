import { describe, it, expect } from 'vitest';
import { nextAttemptAt, classifyStatus, RETRY_SCHEDULE_MS, MAX_ATTEMPTS } from '../retry.js';

describe('retry policy', () => {
  it('follows the 1s/4s/16s/1m/5m/30m schedule (±10% jitter)', () => {
    const now = 1_000_000;
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_MS.length; attempt++) {
      const base = RETRY_SCHEDULE_MS[attempt - 1]!;
      const at = nextAttemptAt(attempt, now)!;
      const delay = at.getTime() - now;
      expect(delay).toBeGreaterThanOrEqual(base * 0.9 - 1);
      expect(delay).toBeLessThanOrEqual(base * 1.1 + 1);
    }
  });

  it('returns null once the schedule is exhausted (→ DLQ)', () => {
    expect(nextAttemptAt(MAX_ATTEMPTS)).toBeNull();
    expect(nextAttemptAt(RETRY_SCHEDULE_MS.length + 1)).toBeNull();
    expect(nextAttemptAt(0)).toBeNull();
  });

  it('classifies statuses: 2xx success, 4xx permanent, 5xx retryable', () => {
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(204)).toBe('success');
    expect(classifyStatus(400)).toBe('permanent');
    expect(classifyStatus(404)).toBe('permanent');
    expect(classifyStatus(429)).toBe('permanent');
    expect(classifyStatus(500)).toBe('retryable');
    expect(classifyStatus(503)).toBe('retryable');
  });
});
