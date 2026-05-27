import { describe, it, expect } from 'vitest';
import {
  computeProjectDrift,
  IDLE_DAYS,
  STALE_PLAN_DAYS,
  RISING_WORK_MIN_DELTA,
  type DriftInput,
} from './computeProjectDrift.js';

const NOW = new Date('2026-05-27T12:00:00.000Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

// A baseline eligible, non-drifting project: recent movement, fresh plan, flat work.
function baseInput(overrides: Partial<DriftInput> = {}): DriftInput {
  return {
    inferredStatus: 'active',
    lastMovementAt: daysAgo(1),
    planText: 'A solid plan',
    planLastEditedAt: daysAgo(1),
    openNow: 3,
    incompleteNow: 3,
    incomplete7dAgo: 3,
    ...overrides,
  };
}

describe('computeProjectDrift — eligibility (R1)', () => {
  it('AE1: returns null for ineligible backlog project even with old movement and no plan', () => {
    const result = computeProjectDrift(
      baseInput({ inferredStatus: 'backlog', lastMovementAt: daysAgo(40), planText: null }),
      NOW
    );
    expect(result).toBeNull();
  });

  it('returns null for completed and archived projects', () => {
    expect(computeProjectDrift(baseInput({ inferredStatus: 'completed' }), NOW)).toBeNull();
    expect(computeProjectDrift(baseInput({ inferredStatus: 'archived' }), NOW)).toBeNull();
  });

  it('evaluates both active and planned projects', () => {
    expect(computeProjectDrift(baseInput({ inferredStatus: 'active' }), NOW)).not.toBeNull();
    expect(computeProjectDrift(baseInput({ inferredStatus: 'planned' }), NOW)).not.toBeNull();
  });
});

describe('computeProjectDrift — idle signal (R3)', () => {
  it('AE2: fires with day count when open issues exist and nothing moved in >7 days', () => {
    const result = computeProjectDrift(baseInput({ openNow: 4, lastMovementAt: daysAgo(9) }), NOW);
    expect(result?.isDrifting).toBe(true);
    expect(result?.signals).toContainEqual({ type: 'idle', reason: 'idle 9 days' });
  });

  it('AE3: does not fire when there are no open issues (all done)', () => {
    const result = computeProjectDrift(baseInput({ openNow: 0, lastMovementAt: daysAgo(30) }), NOW);
    expect(result?.signals.some((s) => s.type === 'idle')).toBe(false);
  });

  it('does not fire on triage/backlog/in_review-only projects (openNow=0, incompleteNow>0)', () => {
    const result = computeProjectDrift(
      baseInput({ openNow: 0, incompleteNow: 5, lastMovementAt: daysAgo(30) }),
      NOW
    );
    expect(result?.signals.some((s) => s.type === 'idle')).toBe(false);
  });

  it('boundary: fires above 7 days, not at exactly 7 or below', () => {
    expect(
      computeProjectDrift(baseInput({ lastMovementAt: daysAgo(8) }), NOW)?.signals.some(
        (s) => s.type === 'idle'
      )
    ).toBe(true);
    expect(
      computeProjectDrift(baseInput({ lastMovementAt: daysAgo(IDLE_DAYS) }), NOW)?.signals.some(
        (s) => s.type === 'idle'
      )
    ).toBe(false);
    expect(
      computeProjectDrift(baseInput({ lastMovementAt: daysAgo(6) }), NOW)?.signals.some(
        (s) => s.type === 'idle'
      )
    ).toBe(false);
  });

  it('does not fire when lastMovementAt is null (no issues)', () => {
    const result = computeProjectDrift(baseInput({ openNow: 0, lastMovementAt: null }), NOW);
    expect(result?.signals.some((s) => s.type === 'idle')).toBe(false);
  });
});

describe('computeProjectDrift — stale plan signal (R4)', () => {
  it('AE4: fires "plan stale N days" when plan last edited > 21 days ago', () => {
    const result = computeProjectDrift(baseInput({ planLastEditedAt: daysAgo(24) }), NOW);
    expect(result?.signals).toContainEqual({ type: 'stale_plan', reason: 'plan stale 24 days' });
  });

  it('AE4: fires "no plan" when plan text is empty', () => {
    const empty = computeProjectDrift(baseInput({ planText: '' }), NOW);
    expect(empty?.signals).toContainEqual({ type: 'stale_plan', reason: 'no plan' });
    const whitespace = computeProjectDrift(baseInput({ planText: '   ' }), NOW);
    expect(whitespace?.signals).toContainEqual({ type: 'stale_plan', reason: 'no plan' });
  });

  it('does not fire when plan is present and edited within 21 days', () => {
    const result = computeProjectDrift(baseInput({ planLastEditedAt: daysAgo(10) }), NOW);
    expect(result?.signals.some((s) => s.type === 'stale_plan')).toBe(false);
  });

  it('boundary: fires above 21 days, not at exactly 21', () => {
    expect(
      computeProjectDrift(baseInput({ planLastEditedAt: daysAgo(22) }), NOW)?.signals.some(
        (s) => s.type === 'stale_plan'
      )
    ).toBe(true);
    expect(
      computeProjectDrift(baseInput({ planLastEditedAt: daysAgo(STALE_PLAN_DAYS) }), NOW)?.signals.some(
        (s) => s.type === 'stale_plan'
      )
    ).toBe(false);
  });
});

describe('computeProjectDrift — rising incomplete work signal (R5)', () => {
  it('AE5: fires "+N in 7d" when incomplete count rose by >= 2', () => {
    const result = computeProjectDrift(baseInput({ incompleteNow: 5, incomplete7dAgo: 3 }), NOW);
    expect(result?.signals).toContainEqual({
      type: 'rising_incomplete_work',
      reason: 'incomplete work +2 in 7d',
    });
  });

  it('AE5: does not fire on a +1 increase', () => {
    const result = computeProjectDrift(baseInput({ incompleteNow: 4, incomplete7dAgo: 3 }), NOW);
    expect(result?.signals.some((s) => s.type === 'rising_incomplete_work')).toBe(false);
  });

  it('does not fire when work decreased or stayed flat', () => {
    expect(
      computeProjectDrift(baseInput({ incompleteNow: 2, incomplete7dAgo: 5 }), NOW)?.signals.some(
        (s) => s.type === 'rising_incomplete_work'
      )
    ).toBe(false);
  });

  it('reopened-issue approximation: an issue completed >7d ago then reopened is counted complete-then', () => {
    // Documents the known completed_at COALESCE limitation: the SQL 7d-ago count
    // treats such an issue as complete-then, so a reopen does not inflate the delta.
    // With incompleteNow=4 and incomplete7dAgo=4 (reopened issue excluded from "then"
    // would have made it 3 → +1), rising does NOT fire — the pure function trusts
    // the reconstructed counts it is given.
    const result = computeProjectDrift(baseInput({ incompleteNow: 4, incomplete7dAgo: 4 }), NOW);
    expect(result?.signals.some((s) => s.type === 'rising_incomplete_work')).toBe(false);
  });
});

describe('computeProjectDrift — composition and severity (R6)', () => {
  it('AE6: combines multiple signals in fixed order with isDrifting true', () => {
    const result = computeProjectDrift(
      baseInput({
        openNow: 2,
        lastMovementAt: daysAgo(10), // idle
        planLastEditedAt: daysAgo(30), // stale
        incompleteNow: 3,
        incomplete7dAgo: 3, // rising does NOT fire
      }),
      NOW
    );
    expect(result?.isDrifting).toBe(true);
    expect(result?.signals.map((s) => s.type)).toEqual(['idle', 'stale_plan']);
  });

  it('orders all three signals idle, stale_plan, rising_incomplete_work', () => {
    const result = computeProjectDrift(
      baseInput({
        openNow: 2,
        lastMovementAt: daysAgo(10),
        planText: '',
        incompleteNow: 6,
        incomplete7dAgo: 3,
      }),
      NOW
    );
    expect(result?.signals.map((s) => s.type)).toEqual([
      'idle',
      'stale_plan',
      'rising_incomplete_work',
    ]);
  });

  it('eligible project with no signals returns isDrifting false and empty signals (not null)', () => {
    const result = computeProjectDrift(baseInput(), NOW);
    expect(result).toEqual({ isDrifting: false, signals: [] });
  });
});

describe('computeProjectDrift — defensive on missing inputs', () => {
  it('treats undefined/NaN aggregates as absent without throwing', () => {
    const result = computeProjectDrift(
      {
        inferredStatus: 'active',
        lastMovementAt: undefined as unknown as Date | null,
        planText: undefined as unknown as string | null,
        planLastEditedAt: undefined as unknown as Date | null,
        openNow: NaN,
        incompleteNow: NaN,
        incomplete7dAgo: NaN,
      },
      NOW
    );
    // Missing planText is treated as "no plan"; counts as 0; dates as null.
    expect(result?.isDrifting).toBe(true);
    expect(result?.signals).toEqual([{ type: 'stale_plan', reason: 'no plan' }]);
  });

  it('exposes the threshold constants', () => {
    expect(IDLE_DAYS).toBe(7);
    expect(STALE_PLAN_DAYS).toBe(21);
    expect(RISING_WORK_MIN_DELTA).toBe(2);
  });
});
