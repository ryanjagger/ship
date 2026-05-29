/**
 * Project drift detection — the threshold logic that turns raw per-project
 * aggregates into a `Drift | null`.
 *
 * Pure: no DB, no network, no clock. The caller passes `now` so results are
 * deterministic. SQL computes the raw aggregates (movement timestamp, plan-edit
 * recency, open/incomplete counts); this function owns only the thresholds and
 * the human-readable reasons. See
 * docs/plans/2026-05-27-001-feat-project-drift-detection-plan.md (U2).
 *
 * Drift is only computed for `active`/`planned` projects; everything else
 * returns null. Two distinct issue sets feed the signals: *open* (todo/in_progress)
 * gates idle, while *incomplete* (not done/cancelled) drives rising work.
 */

import type { Drift, DriftSignal } from '@ship/shared';

export const IDLE_DAYS = 7;
export const STALE_PLAN_DAYS = 21;
export const RISING_WORK_MIN_DELTA = 2;

const ELIGIBLE_STATUSES = new Set(['active', 'planned']);

export interface DriftInput {
  inferredStatus: string;
  /** GREATEST of issue state-change/creation timestamps over the project's issues. */
  lastMovementAt: Date | null;
  /** properties.plan text; null/empty means the project has no plan. */
  planText: string | null;
  /** COALESCE(MAX(document_history.created_at WHERE field='plan'), project.created_at). */
  planLastEditedAt: Date | null;
  /** Count of issues in state todo/in_progress (gates idle). */
  openNow: number;
  /** Count of issues not in state done/cancelled (now). */
  incompleteNow: number;
  /** Reconstructed count of issues incomplete as of 7 days ago. */
  incomplete7dAgo: number;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
}

/** Coerce a possibly-undefined/NaN count to a finite number, defaulting to 0. */
function count(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Coerce a possibly-undefined value to a Date or null. */
function asDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

export function computeProjectDrift(input: DriftInput, now: Date): Drift | null {
  if (!ELIGIBLE_STATUSES.has(input.inferredStatus)) {
    return null;
  }

  const lastMovementAt = asDate(input.lastMovementAt);
  const planLastEditedAt = asDate(input.planLastEditedAt);
  const openNow = count(input.openNow);
  const incompleteNow = count(input.incompleteNow);
  const incomplete7dAgo = count(input.incomplete7dAgo);
  const planText = typeof input.planText === 'string' ? input.planText : null;

  const signals: DriftSignal[] = [];

  // Idle: open work exists but nothing has moved in > IDLE_DAYS.
  if (openNow > 0 && lastMovementAt) {
    const idleDays = daysBetween(lastMovementAt, now);
    if (idleDays > IDLE_DAYS) {
      signals.push({ type: 'idle', reason: `idle ${Math.floor(idleDays)} days` });
    }
  }

  // Stale plan: no plan at all, or the plan hasn't been touched in > STALE_PLAN_DAYS.
  if (!planText || planText.trim() === '') {
    signals.push({ type: 'stale_plan', reason: 'no plan' });
  } else if (planLastEditedAt) {
    const planAgeDays = daysBetween(planLastEditedAt, now);
    if (planAgeDays > STALE_PLAN_DAYS) {
      signals.push({ type: 'stale_plan', reason: `plan stale ${Math.floor(planAgeDays)} days` });
    }
  }

  // Rising incomplete work: incomplete count grew by >= RISING_WORK_MIN_DELTA.
  const delta = incompleteNow - incomplete7dAgo;
  if (delta >= RISING_WORK_MIN_DELTA) {
    signals.push({ type: 'rising_incomplete_work', reason: `incomplete work +${delta} in 7d` });
  }

  return { isDrifting: signals.length > 0, signals };
}
