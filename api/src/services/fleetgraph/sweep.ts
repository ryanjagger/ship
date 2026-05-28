/**
 * FleetGraph drift sweep — workspace-scoped detector that turns project drift
 * (per `computeProjectDrift`) into persisted insights via the shipped
 * `createOrRefreshInsight` substrate. Single tick of work; no scheduling, no
 * env gates here (those land in U3 — the scheduler).
 *
 * See docs/plans/2026-05-28-001-feat-fleetgraph-insight-surfacing-plan.md (U2).
 *
 * ── LOCKING CONTRACT ──────────────────────────────────────────────────────
 * Two call shapes for `sweepWorkspaceDrift(workspaceId, opts?)`:
 *
 *   1. NO `opts.client`: this function acquires a pool client, opens a
 *      transaction, SET LOCAL statement_timeout = '30s', and probes a
 *      non-blocking `pg_try_advisory_xact_lock` keyed by `sweep:<workspace>`.
 *      If the lock is busy → ROLLBACK + release + throw
 *      `SweepInProgressError`. If acquired → run the per-project loop on
 *      that client; COMMIT (releases lock); release. Catch ensures rollback
 *      + release on any error.
 *
 *   2. WITH `opts.client`: the caller (the scheduler — U3) already holds
 *      the transaction AND the advisory lock for this workspace. This
 *      function skips the lock probe and BEGIN/COMMIT and just runs the
 *      per-project loop on the provided client.
 *
 * The string namespace `sweep:` is disjoint from `insight.ts`'s
 * `${workspaceId}:${subjectId}:${kind}` lock keys (UUIDs never start with
 * `sweep:`), so the two namespaces share the advisory-lock keyspace safely.
 *
 * ── JSON WRITE DISCIPLINE ─────────────────────────────────────────────────
 * This module does NOT INSERT/UPDATE directly into `documents` for insight
 * rows — it calls `createOrRefreshInsight`, which owns the deep-path
 * `jsonb_set` discipline + per-(subject, kind) advisory lock + partial unique
 * index. The sweep's only role is to build the arg bundle and dispatch.
 *
 * ── INSIGHT PAYLOAD POLICY ────────────────────────────────────────────────
 * Per the plan's "Insight payload construction for the sweep" decision:
 *   - subjectEntityType: 'project' (drift is the only v1 kind).
 *   - severity: 1 signal → 'fyi'; 2+ signals → 'act'.
 *   - summary: "Project drift: " + comma-joined signal reasons.
 *   - recommendedAction: fixed v1 template ("Review project status and
 *     update plan or close stale issues.").
 *   - verdict: system-authored { decision: 'SURFACE_ACT' | 'SURFACE_FYI',
 *     reasoning: <same as summary> } — distinct from LLM verdicts.
 *   - inputHash: SHA-1 of canonical JSON over {kind, signalTypes sorted,
 *     lastMovementAtDay, planLastEditedAtDay, openNow, incompleteNow,
 *     incomplete7dAgo} — day-rounded so a stable detection doesn't bump
 *     `last_changed_at` every tick.
 */

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';
import {
  driftIssueAggregates,
  driftPlanLastEditedAt,
} from '../drift/driftSql.js';
import { computeProjectDrift, type DriftInput } from '../drift/computeProjectDrift.js';
import {
  createOrRefreshInsight,
  type CreateOrRefreshInsightArgs,
} from './insight.js';
import type {
  Drift,
  InsightSeverity,
  InsightVerdict,
  InsightVerdictDecision,
} from '@ship/shared';

// ─── Public types ───────────────────────────────────────────────────────

/** Thrown by `sweepWorkspaceDrift` (no-client path) when another sweep
 *  holds the per-workspace advisory lock. The caller can map this to a
 *  retryable error (e.g. HTTP 409). */
export class SweepInProgressError extends Error {
  constructor(message = 'A sweep is already in progress for this workspace.') {
    super(message);
    this.name = 'SweepInProgressError';
  }
}

export interface SweepResult {
  workspaceId: string;
  /** Number of eligible projects examined (drift-eligible inferred_status). */
  scanned: number;
  /** Insights newly created (`didCreate=true` from the substrate). */
  created: number;
  /** Insights refreshed against an existing row (`didCreate=false && insight !== null`). */
  refreshed: number;
  /** Projects evaluated as non-drifting OR substrate returned `insight=null`
   *  (benign subject race — subject vanished between the SELECT and the
   *  upsert's `FOR SHARE` probe). */
  skipped: number;
}

// ─── Lock key derivation ────────────────────────────────────────────────

/** Single named helper so the scheduler and this service produce the SAME
 *  per-workspace lock key. Mirrors `insightLockKeyParams` in insight.ts. */
export function sweepWorkspaceLockKeyParams(workspaceId: string): string {
  return `sweep:${workspaceId}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

interface SweepRow {
  id: string;
  inferred_status: string;
  plan: string | null;
  plan_last_edited_at: string | Date | null;
  last_movement_at: string | Date | null;
  open_now: string | number | null;
  incomplete_now: string | number | null;
  incomplete_7d_ago: string | number | null;
}

export async function sweepWorkspaceDrift(
  workspaceId: string,
  opts?: { client?: PoolClient }
): Promise<SweepResult> {
  if (opts?.client) {
    // With-client path: caller already holds tx + advisory lock.
    return runSweepLoop(workspaceId, opts.client);
  }

  // No-client path: acquire our own client + non-blocking advisory lock.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");

    const lockRes = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
      [sweepWorkspaceLockKeyParams(workspaceId)]
    );
    const acquired = lockRes.rows[0]?.locked === true;
    if (!acquired) {
      await client.query('ROLLBACK');
      throw new SweepInProgressError();
    }

    const result = await runSweepLoop(workspaceId, client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Swallow rollback errors — original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── Per-project loop ───────────────────────────────────────────────────

/**
 * Per-project aggregate pull + decide + dispatch. Single SELECT per
 * workspace, mirroring the projects.ts list CTE shape but scoped to one
 * workspace and joined directly (no visibility filter — the sweep is a
 * service-level worker that operates on the full workspace).
 *
 * The `inferred_status` shape matches projects.ts: archived > completed
 * (plan_validated set) > active (current sprint allocation) > planned
 * (future allocation) > backlog. Only `active`/`planned` are drift-eligible
 * (see computeProjectDrift's ELIGIBLE_STATUSES).
 */
async function runSweepLoop(
  workspaceId: string,
  client: PoolClient
): Promise<SweepResult> {
  const sql = `
    WITH workspace_projects AS (
      SELECT d.id, d.created_at, d.archived_at, d.properties
        FROM documents d
       WHERE d.workspace_id = $1
         AND d.document_type = 'project'
         AND d.archived_at IS NULL
         AND d.deleted_at IS NULL
    ),
    sprint_status AS (
      SELECT (s.properties->>'project_id')::uuid AS project_id,
             CASE MAX(
               CASE
                 WHEN CURRENT_DATE BETWEEN
                   (w.sprint_start_date + ((s.properties->>'sprint_number')::int - 1) * 7)
                   AND (w.sprint_start_date + ((s.properties->>'sprint_number')::int - 1) * 7 + 6)
                 THEN 3
                 WHEN CURRENT_DATE < (w.sprint_start_date + ((s.properties->>'sprint_number')::int - 1) * 7)
                 THEN 2
                 ELSE 1
               END
             )
             WHEN 3 THEN 'active'
             WHEN 2 THEN 'planned'
             ELSE NULL
             END AS allocation_status
        FROM documents s
        JOIN workspaces w ON w.id = s.workspace_id
        JOIN workspace_projects vp ON vp.id = (s.properties->>'project_id')::uuid
       WHERE s.document_type = 'sprint'
         AND s.workspace_id = $1
         AND jsonb_array_length(COALESCE(s.properties->'assignee_ids', '[]'::jsonb)) > 0
       GROUP BY (s.properties->>'project_id')::uuid
    ),
    issue_drift AS (
      SELECT da.related_id AS project_id,
             ${driftIssueAggregates('i')}
        FROM document_associations da
        JOIN documents i ON i.id = da.document_id
                        AND i.document_type = 'issue'
                        AND i.archived_at IS NULL AND i.deleted_at IS NULL
        JOIN workspace_projects vp ON vp.id = da.related_id
       WHERE da.relationship_type = 'project'
       GROUP BY da.related_id
    )
    SELECT d.id,
           CASE
             WHEN d.archived_at IS NOT NULL THEN 'archived'
             WHEN d.properties->>'plan_validated' IS NOT NULL THEN 'completed'
             ELSE COALESCE(ss.allocation_status, 'backlog')
           END AS inferred_status,
           d.properties->>'plan' AS plan,
           ${driftPlanLastEditedAt('d')} AS plan_last_edited_at,
           id_cte.last_movement_at,
           COALESCE(id_cte.open_now, 0) AS open_now,
           COALESCE(id_cte.incomplete_now, 0) AS incomplete_now,
           COALESCE(id_cte.incomplete_7d_ago, 0) AS incomplete_7d_ago
      FROM workspace_projects d
      LEFT JOIN sprint_status ss ON ss.project_id = d.id
      LEFT JOIN issue_drift id_cte ON id_cte.project_id = d.id
  `;

  const res = await client.query<SweepRow>(sql, [workspaceId]);

  const now = new Date();
  let scanned = 0;
  let created = 0;
  let refreshed = 0;
  let skipped = 0;

  for (const row of res.rows) {
    const inferredStatus = row.inferred_status;
    // Eligibility filter (mirrors computeProjectDrift's ELIGIBLE_STATUSES).
    // Ineligible projects don't count toward `scanned`.
    if (inferredStatus !== 'active' && inferredStatus !== 'planned') {
      continue;
    }
    scanned++;

    const lastMovementAt = row.last_movement_at ? new Date(row.last_movement_at) : null;
    const planLastEditedAt = row.plan_last_edited_at
      ? new Date(row.plan_last_edited_at)
      : null;
    const openNow = Number(row.open_now ?? 0);
    const incompleteNow = Number(row.incomplete_now ?? 0);
    const incomplete7dAgo = Number(row.incomplete_7d_ago ?? 0);

    const driftInput: DriftInput = {
      inferredStatus,
      lastMovementAt,
      planText: row.plan,
      planLastEditedAt,
      openNow,
      incompleteNow,
      incomplete7dAgo,
    };

    const drift = computeProjectDrift(driftInput, now);
    if (!drift || !drift.isDrifting) {
      skipped++;
      continue;
    }

    const args = buildInsightArgs({
      workspaceId,
      subjectId: row.id,
      drift,
      lastMovementAt,
      planLastEditedAt,
      openNow,
      incompleteNow,
      incomplete7dAgo,
      now,
    });

    const result = await createOrRefreshInsight(args);
    if (result.didCreate) {
      created++;
    } else if (result.insight !== null) {
      refreshed++;
    } else {
      // Benign subject race — subject vanished between SELECT and FOR SHARE.
      skipped++;
    }
  }

  return { workspaceId, scanned, created, refreshed, skipped };
}

// ─── Insight payload construction ───────────────────────────────────────

interface BuildInsightArgsInput {
  workspaceId: string;
  subjectId: string;
  drift: Drift;
  lastMovementAt: Date | null;
  planLastEditedAt: Date | null;
  openNow: number;
  incompleteNow: number;
  incomplete7dAgo: number;
  now: Date;
}

/** Internal — exposed via re-export below for tests. */
function buildInsightArgs(input: BuildInsightArgsInput): CreateOrRefreshInsightArgs {
  const signals = input.drift.signals;
  const severity: InsightSeverity = signals.length >= 2 ? 'act' : 'fyi';
  const decision: InsightVerdictDecision =
    severity === 'act' ? 'SURFACE_ACT' : 'SURFACE_FYI';

  const summary = 'Project drift: ' + signals.map((s) => s.reason).join(', ');
  const recommendedAction =
    'Review project status and update plan or close stale issues.';

  const verdict: InsightVerdict = {
    decision,
    reasoning: summary,
  };

  const evidence: Record<string, unknown> = {
    signals,
    computed_at: input.now.toISOString(),
    last_movement_at: input.lastMovementAt ? input.lastMovementAt.toISOString() : null,
    plan_last_edited_at: input.planLastEditedAt
      ? input.planLastEditedAt.toISOString()
      : null,
    open_now: input.openNow,
    incomplete_now: input.incompleteNow,
    incomplete_7d_ago: input.incomplete7dAgo,
    model: 'system/computeProjectDrift',
  };

  const inputHash = computeInputHash({
    kind: 'project_drift',
    signalTypes: signals.map((s) => s.type).sort(),
    lastMovementAtDay: dayString(input.lastMovementAt),
    planLastEditedAtDay: dayString(input.planLastEditedAt),
    openNow: input.openNow,
    incompleteNow: input.incompleteNow,
    incomplete7dAgo: input.incomplete7dAgo,
  });

  return {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    subjectEntityType: 'project',
    kind: 'project_drift',
    severity,
    summary,
    recommendedAction,
    evidence,
    verdict,
    inputHash,
    accountableOwnerId: null,
  };
}

/** YYYY-MM-DD day-rounding so a stable detection doesn't bump
 *  `last_changed_at` every tick. */
function dayString(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Stable SHA-1 of canonical JSON over the input record. Keys are sorted to
 *  guarantee bytewise determinism — JSON.stringify alone does NOT sort keys.
 *  Mirrors the discipline `insight.ts` follows when building the upsert key. */
function computeInputHash(input: Record<string, unknown>): string {
  const canonical = canonicalize(input);
  return createHash('sha1').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
    '}'
  );
}

// ─── Internals exported for tests only ──────────────────────────────────
// These are NOT part of the public API — they are exposed so the mocked-pool
// tests can drive the pure pieces (hash stability, severity mapping)
// without needing to thread a full mock pool through every assertion.

export const __testing = {
  buildInsightArgs,
  computeInputHash,
  dayString,
};
