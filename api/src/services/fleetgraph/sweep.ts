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
 *   1. NO `opts.client`: this function acquires a pool client and probes a
 *      non-blocking, SESSION-scoped `pg_try_advisory_lock` keyed by
 *      `sweep:<workspace>`. If the lock is busy → release + throw
 *      `SweepInProgressError`. If acquired → run the per-project loop on that
 *      client, then `pg_advisory_unlock` + release in `finally`.
 *
 *      Deliberately NO wrapping transaction: the per-project loop awaits LLM
 *      calls (runDriftReasoning) with no SQL in flight. Inside a transaction
 *      that idle would trip `idle_in_transaction_session_timeout`
 *      (db/client.ts, 15s); Postgres terminates the connection and the
 *      resulting unhandled pg 'error' event crashes the process. A session
 *      lock holds across the loop without an open transaction. The project
 *      SELECT runs in autocommit (rows buffered, no cursor) and every write
 *      goes through `createOrRefreshInsight`'s own short transaction, so
 *      dropping the outer transaction does not change write atomicity.
 *
 *   2. WITH `opts.client`: the caller (the scheduler — U3) already holds the
 *      session advisory lock for this workspace on the provided client. This
 *      function skips the lock probe and just runs the per-project loop on it.
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

import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';
import { computeProjectDrift, type DriftInput } from '../drift/computeProjectDrift.js';
import { gatherSweepRows } from './sweep-rows.js';
import {
  createOrRefreshInsight,
  getInsightByIdentity,
  type CreateOrRefreshInsightArgs,
} from './insight.js';
import { getFleetgraphSettings } from '../workspace-settings.js';
import { getFleetServiceUserId } from './service-user.js';
import { runDriftReasoning } from './index.js';
import type {
  Drift,
  DriftSignal,
  InsightSeverity,
  InsightVerdict,
  InsightVerdictDecision,
} from '@ship/shared';

// Service-principal identity for sweep-initiated Fleet runs lives in
// service-user.ts (`fleet@ship.system`, migration 062). It replaced the old
// zero-UUID sentinel: minted access tokens FK `users`, so system-authored
// runs need a real row. With `isAdmin: true`, VISIBILITY_FILTER_SQL
// short-circuits to TRUE (visibility.ts:65-80), giving the sweep the
// workspace-wide read access it needs without bespoke service-principal
// code in any node or tool.

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
  /** Projects where the LLM verdict returned SUPPRESS and the substrate was
   *  NOT called — the insight was judged not worth surfacing. SUPPRESS does
   *  NOT touch any existing open insight (conservative default per the plan). */
  suppressed: number;
  /** True iff at least one LLM call in this tick fell back to the
   *  deterministic verdict (provider unavailable, parse error, etc.). The
   *  "Sweep now" UI surfaces this as a soft warning. */
  degraded: boolean;
}

// ─── Lock key derivation ────────────────────────────────────────────────

/** Single named helper so the scheduler and this service produce the SAME
 *  per-workspace lock key. Mirrors `insightLockKeyParams` in insight.ts. */
export function sweepWorkspaceLockKeyParams(workspaceId: string): string {
  return `sweep:${workspaceId}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function sweepWorkspaceDrift(
  workspaceId: string,
  opts?: { client?: PoolClient }
): Promise<SweepResult> {
  if (opts?.client) {
    // With-client path: caller already holds the session advisory lock on this
    // client (no transaction — see the LOCKING CONTRACT header).
    return runSweepLoop(workspaceId, opts.client);
  }

  // No-client path: acquire our own client + non-blocking, session-scoped
  // advisory lock. NO wrapping transaction — see the LOCKING CONTRACT header
  // for why holding a transaction across the LLM loop crashes the process.
  const client = await pool.connect();
  // Named so we can detach it before returning the client to the pool —
  // PoolClients are reused, so an anonymous per-checkout listener would
  // accumulate across sweeps (stale workspaceId closures,
  // MaxListenersExceededWarning, memory growth). Defense in depth: a
  // checked-out client whose connection dies asynchronously (Postgres
  // failover, network blip, admin termination) emits an 'error' event that
  // crashes the process if unhandled. The pool-level handler only covers
  // clients idle *in the pool*, not checked-out ones. Log instead.
  const onClientError = (err: Error) => {
    console.error(`[sweep] client error ws=${workspaceId}:`, err);
  };
  client.on('error', onClientError);

  let locked = false;
  try {
    const lockRes = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [sweepWorkspaceLockKeyParams(workspaceId)]
    );
    locked = lockRes.rows[0]?.locked === true;
    if (!locked) {
      throw new SweepInProgressError();
    }

    return await runSweepLoop(workspaceId, client);
  } finally {
    let destroy = false;
    if (locked) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [sweepWorkspaceLockKeyParams(workspaceId)]
        );
      } catch (err) {
        // Unlock failed (likely the connection died). Discard the connection
        // so a leaked session lock can't ride a pooled connection into a later
        // sweep; the lock drops when the backend exits.
        console.error(`[sweep] advisory unlock failed ws=${workspaceId}:`, err);
        destroy = true;
      }
    }
    // Detach the checkout-scoped listener before returning the client to the
    // pool so it doesn't outlive this checkout and accumulate across sweeps.
    client.removeListener('error', onClientError);
    client.release(destroy);
  }
}

// ─── Per-project loop ───────────────────────────────────────────────────

/**
 * Per-project decide + dispatch. The DOMAIN reads (projects, issue
 * aggregates, plan-edit recency) come from `gatherSweepRows` — the public API
 * as the fleet@ship.system service user (issue #95); the v1 `inferred_status`
 * column computes the same archived > completed > active/planned > backlog
 * shape this loop's SQL used to inline. Only `active`/`planned` rows arrive
 * (computeProjectDrift's ELIGIBLE_STATUSES). The verdict routing and insight
 * dispatch below are agent machinery and stay internal.
 *
 * `_lockClient` only holds the per-workspace session advisory lock for the
 * duration of the loop (see the LOCKING CONTRACT header) — no queries run on
 * it here anymore.
 */
async function runSweepLoop(
  workspaceId: string,
  _lockClient: PoolClient
): Promise<SweepResult> {
  const now = new Date();
  const rows = await gatherSweepRows(workspaceId, now);
  // Per-tick UUID. Stamped into every insight's evidence + threaded into
  // every LLM call's LangSmith metadata so "all traces from this tick" is
  // queryable. Generated even when LLM verdicts are disabled (cheap and
  // gives a stable cross-ref for the deterministic-only path too).
  const sweepRunId = randomUUID();

  // Per-workspace LLM toggle. Read once; the value applies to every project
  // in this tick. Uses the global pool (not the held `client`) — it's a
  // single-row read on a different table, doesn't need the tx, and avoids
  // serializing all settings reads behind the sweep's advisory lock.
  const settings = await getFleetgraphSettings(workspaceId);
  const llmVerdictsEnabled = settings.llmVerdictsEnabled;

  let scanned = 0;
  let created = 0;
  let refreshed = 0;
  let skipped = 0;
  let suppressed = 0;
  let degraded = false;

  for (const row of rows) {
    // gatherSweepRows only returns drift-eligible (active/planned) projects.
    scanned++;

    const { lastMovementAt, planLastEditedAt, openNow, incompleteNow, incomplete7dAgo } = row;

    const driftInput: DriftInput = {
      inferredStatus: row.inferredStatus,
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

    // Build the deterministic-fallback verdict + inputHash + signals
    // evidence. When LLM verdicts are disabled OR fallback fires this is
    // the verdict we persist; either way it's also the `inputHash`
    // producer (the hash is detector-derived, not verdict-derived).
    const baseArgs = buildInsightArgs({
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

    const decision = await buildVerdictForProject({
      workspaceId,
      subjectId: row.id,
      projectTitle: row.title ?? '',
      signals: drift.signals,
      deterministicVerdict: baseArgs.verdict,
      computedInputHash: baseArgs.inputHash,
      llmVerdictsEnabled,
      sweepRunId,
    });

    if (decision.degraded) {
      degraded = true;
    }

    if (decision.suppressed) {
      suppressed++;
      // SUPPRESS: do NOT call createOrRefreshInsight; do NOT touch any
      // existing open row. The next tick will re-detect via computeProjectDrift
      // and re-prompt; if the drift truly clears the existing detector path
      // returns null and resolution falls out of computeProjectDrift's
      // ineligibility.
      // eslint-disable-next-line no-console
      console.debug(
        `[sweep] SUPPRESS for ws=${workspaceId} subject=${row.id} source=${decision.source}`
      );
      continue;
    }

    // Stamp source provenance + sweep_run_id into evidence so the UI can
    // surface "AI" vs "system" later (deferred) and so insights cross-ref
    // their generating tick.
    const evidence: Record<string, unknown> = {
      ...(baseArgs.evidence as Record<string, unknown>),
      verdict_source: decision.source,
      sweep_run_id: sweepRunId,
    };

    const args: CreateOrRefreshInsightArgs = {
      ...baseArgs,
      verdict: decision.verdict,
      evidence,
    };

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

  return {
    workspaceId,
    scanned,
    created,
    refreshed,
    skipped,
    suppressed,
    degraded,
  };
}

// ─── Verdict routing ────────────────────────────────────────────────────

interface VerdictDecisionInput {
  workspaceId: string;
  subjectId: string;
  projectTitle: string;
  signals: DriftSignal[];
  deterministicVerdict: InsightVerdict;
  computedInputHash: string;
  llmVerdictsEnabled: boolean;
  sweepRunId: string;
}

interface VerdictDecisionOutput {
  /** The verdict to persist (LLM-generated, or deterministic). */
  verdict: InsightVerdict;
  /** Provenance flag for evidence.verdict_source. */
  source: 'llm' | 'deterministic';
  /** True iff the LLM call fell back. Tick-level `degraded` ORs from this. */
  degraded: boolean;
  /** True iff the LLM verdict was SUPPRESS — caller skips substrate dispatch. */
  suppressed: boolean;
}

/**
 * Decide which verdict to use for one drifting project:
 *   1. LLM disabled → deterministic (no probe, no LLM call).
 *   2. LLM enabled, probe finds OPEN row with matching hash → deterministic
 *      (substrate's no-op refresh handles the write efficiently).
 *   3. LLM enabled, no probe hit → call `runDriftReasoning`. SUPPRESS short-
 *      circuits; otherwise return the LLM verdict (or deterministic fallback
 *      when the graph reports `{available: false}`).
 *
 * Never throws — `runDriftReasoning` guarantees a RunDriftReasoningResult
 * shape (never throws itself), and a probe SQL failure bubbles up to
 * runSweepLoop's catch via the caller.
 */
async function buildVerdictForProject(
  input: VerdictDecisionInput
): Promise<VerdictDecisionOutput> {
  if (!input.llmVerdictsEnabled) {
    return {
      verdict: input.deterministicVerdict,
      source: 'deterministic',
      degraded: false,
      suppressed: false,
    };
  }

  const existing = await getInsightByIdentity(
    input.workspaceId,
    input.subjectId,
    'project_drift'
  );

  if (
    existing &&
    existing.state === 'open' &&
    existing.inputHash === input.computedInputHash
  ) {
    // eslint-disable-next-line no-console
    console.debug(
      `[sweep] hash match for ws=${input.workspaceId} subject=${input.subjectId}; LLM skipped`
    );
    return {
      verdict: input.deterministicVerdict,
      source: 'deterministic',
      degraded: false,
      suppressed: false,
    };
  }

  const ctx = {
    workspaceId: input.workspaceId,
    userId: await getFleetServiceUserId(),
    isAdmin: true,
  };
  const result = await runDriftReasoning({
    entityId: input.subjectId,
    signals: input.signals,
    ctx,
    traceMetadata: {
      workspace_id: input.workspaceId,
      sweep_run_id: input.sweepRunId,
    },
  });

  if (result.available) {
    const suppressed = result.verdict.decision === 'SUPPRESS';
    return {
      verdict: result.verdict,
      source: 'llm',
      degraded: false,
      suppressed,
    };
  }

  // Graph unavailable / degraded → deterministic fallback.
  return {
    verdict: input.deterministicVerdict,
    source: 'deterministic',
    degraded: true,
    suppressed: false,
  };
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
  buildVerdictForProject,
  computeInputHash,
  dayString,
};
