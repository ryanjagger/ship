/**
 * SQL fragments for the per-project drift aggregates.
 *
 * The project list (grouped CTE) and the single-project endpoint (LATERAL join)
 * have different query topologies, but both must compute the SAME drift inputs.
 * Single-sourcing the aggregate expressions here keeps the two endpoints from
 * silently diverging. The thresholds themselves live in computeProjectDrift.ts;
 * this file only shapes the raw inputs. Counts are computed over a project's
 * associated, non-archived/deleted issues (the caller supplies that join).
 */

/**
 * The four issue-derived aggregate columns, given the issue table alias.
 * `NOW()` is the database clock; computeProjectDrift compares timestamps against
 * the JS clock for idle/stale, which is close enough (drift is a coarse signal).
 */
export function driftIssueAggregates(i: string): string {
  return `
    GREATEST(MAX(${i}.created_at), MAX(${i}.started_at), MAX(${i}.completed_at),
             MAX(${i}.cancelled_at), MAX(${i}.reopened_at)) AS last_movement_at,
    COUNT(*) FILTER (WHERE ${i}.properties->>'state' IN ('todo', 'in_progress')) AS open_now,
    COUNT(*) FILTER (WHERE COALESCE(${i}.properties->>'state', '') NOT IN ('done', 'cancelled')) AS incomplete_now,
    COUNT(*) FILTER (
      WHERE ${i}.created_at <= NOW() - INTERVAL '7 days'
        AND (${i}.completed_at IS NULL OR ${i}.completed_at > NOW() - INTERVAL '7 days')
        AND (${i}.cancelled_at IS NULL OR ${i}.cancelled_at > NOW() - INTERVAL '7 days')
    ) AS incomplete_7d_ago`;
}

/**
 * Scalar subquery for when the project's plan was last edited, given the project
 * alias. Falls back to the project's own created_at when no plan-edit history
 * row exists (a plan set at creation ages from creation, not "never edited").
 */
export function driftPlanLastEditedAt(d: string): string {
  return `COALESCE(
    (SELECT MAX(dh.created_at) FROM document_history dh
     WHERE dh.document_id = ${d}.id AND dh.field = 'plan'),
    ${d}.created_at
  )`;
}
