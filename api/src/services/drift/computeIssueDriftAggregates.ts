/**
 * Pure re-implementation of the `driftIssueAggregates` SQL fragment
 * (driftSql.ts) over issue DTOs, for the sweep's public-API path (issue #95):
 * the sweep now lists a project's issues through `/api/v1` and computes the
 * same four aggregates in process. `computeIssueDriftAggregates.parity.test.ts`
 * proves the two implementations agree on the same rows — change BOTH or
 * neither.
 *
 * One deliberate divergence: the SQL fragment's 7-day window uses the DATABASE
 * clock (NOW()); this uses the caller's `now`. computeProjectDrift already
 * mixes the two clocks ("close enough — drift is a coarse signal").
 */

/** The issue fields the aggregates read (a subset of the v1 Issue DTO). */
export interface DriftIssueLike {
  state: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  reopened_at?: string | null;
}

export interface IssueDriftAggregates {
  /** Latest of created/started/completed/cancelled/reopened across all issues. */
  lastMovementAt: Date | null;
  /** Issues in an actively-worked state (todo / in_progress). */
  openNow: number;
  /** Issues not done and not cancelled (NULL state counts as incomplete). */
  incompleteNow: number;
  /** Issues that were already incomplete 7 days before `now`. */
  incomplete7dAgo: number;
}

function ts(value: string | null | undefined): number | null {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function computeIssueDriftAggregates(issues: DriftIssueLike[], now: Date): IssueDriftAggregates {
  const sevenDaysAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  let lastMovementMs: number | null = null;
  let openNow = 0;
  let incompleteNow = 0;
  let incomplete7dAgo = 0;

  for (const issue of issues) {
    for (const value of [issue.created_at, issue.started_at, issue.completed_at, issue.cancelled_at, issue.reopened_at]) {
      const ms = ts(value);
      if (ms != null && (lastMovementMs == null || ms > lastMovementMs)) lastMovementMs = ms;
    }

    if (issue.state === 'todo' || issue.state === 'in_progress') openNow++;

    const state = issue.state ?? '';
    if (state !== 'done' && state !== 'cancelled') incompleteNow++;

    const createdMs = ts(issue.created_at);
    const completedMs = ts(issue.completed_at);
    const cancelledMs = ts(issue.cancelled_at);
    if (
      createdMs != null &&
      createdMs <= sevenDaysAgoMs &&
      (completedMs == null || completedMs > sevenDaysAgoMs) &&
      (cancelledMs == null || cancelledMs > sevenDaysAgoMs)
    ) {
      incomplete7dAgo++;
    }
  }

  return {
    lastMovementAt: lastMovementMs == null ? null : new Date(lastMovementMs),
    openNow,
    incompleteNow,
    incomplete7dAgo,
  };
}
