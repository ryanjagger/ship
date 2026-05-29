/**
 * FleetGraph scheduler — registers an in-process `node-cron` task that runs
 * `runFleetgraphSweepTick()` every 4 minutes. The tick iterates every workspace that
 * has `settings->fleetgraph->>'sweep_enabled'='true'` (and is not archived),
 * acquires a non-blocking per-workspace advisory lock, and dispatches to
 * `sweepWorkspaceDrift({ client })` so the sweep service inherits the lock
 * we just took rather than re-probing.
 *
 * ── REGISTRATION SITE ─────────────────────────────────────────────────────
 * `startScheduler()` is called from `api/src/index.ts` AFTER `server.listen`
 * — never from `createApp()`. This keeps unit tests that import the app from
 * spinning a real cron job. The scheduler holds a module-level task handle so
 * `stopScheduler()` (used by vitest `afterEach`) can cleanly stop the timer.
 *
 * ── ENV GATE ──────────────────────────────────────────────────────────────
 * `FLEETGRAPH_SWEEP_ENABLED` (default off) is checked once at registration
 * time. When unset/false, `startScheduler()` returns silently without
 * registering anything — no DB roundtrip, no cron timer in the event loop.
 * This is the ops kill switch; per-workspace gating is a separate JSONB
 * column read inside each tick.
 *
 * ── LOCK CONTRACT ─────────────────────────────────────────────────────────
 * Each per-workspace iteration opens its own transaction, sets a 30s local
 * statement_timeout, and probes `pg_try_advisory_xact_lock(hashtextextended(
 * sweepWorkspaceLockKeyParams(ws), 0))`. On miss (another instance holds the
 * lock) we ROLLBACK + log + skip. On hit we call `sweepWorkspaceDrift(ws,
 * { client })` — the with-client path that skips the lock probe — then
 * COMMIT to release the lock.
 *
 * ── NO-THROW POLICY ───────────────────────────────────────────────────────
 * `runFleetgraphSweepTick()` is the cron callback. It catches per-workspace
 * errors so one bad workspace does NOT abort the tick, and the outer function
 * itself never re-throws — an unhandled throw inside a `node-cron` callback
 * would surface as an unhandled rejection on the process. Errors are logged
 * with the workspace id.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { pool } from '../db/client.js';
import {
  sweepWorkspaceDrift,
  sweepWorkspaceLockKeyParams,
} from '../services/fleetgraph/sweep.js';

// ─── Module state ───────────────────────────────────────────────────────

let task: ScheduledTask | null = null;

/** Every 4 minutes. Exported so tests can assert the registered schedule. */
export const SWEEP_CRON_SCHEDULE = '*/4 * * * *';

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Register the every-4-minutes FleetGraph sweep with `node-cron`. Gated by
 * `FLEETGRAPH_SWEEP_ENABLED='true'` — when unset or any other value, returns
 * silently without registering. Safe to call multiple times: subsequent calls
 * while a task is already registered are no-ops (the existing task is kept).
 */
export function startScheduler(): void {
  if (process.env.FLEETGRAPH_SWEEP_ENABLED !== 'true') {
    return;
  }
  if (task) {
    // Already registered. Avoid stacking duplicate cron tasks.
    return;
  }
  task = cron.schedule(SWEEP_CRON_SCHEDULE, () => {
    runFleetgraphSweepTick().catch((err) => {
      // Defense in depth — runFleetgraphSweepTick already catches per-
      // workspace errors and never re-throws, but a bug above the loop
      // (e.g. the workspace SELECT itself failing) could still surface here.
      console.error('[scheduler] sweep tick failed:', err);
    });
  });
  console.log(`[scheduler] FleetGraph sweep registered at ${SWEEP_CRON_SCHEDULE}`);
}

/**
 * Stop the registered task (if any) and clear the module-level handle.
 * Idempotent — safe to call when no task is registered. Required by vitest
 * `afterEach` so the cron timer doesn't keep the test process alive past
 * suite end.
 */
export function stopScheduler(): void {
  task?.stop();
  task = null;
}

/**
 * Single sweep-tick body. Public for tests and for the future manual-trigger
 * plumbing (U4's `POST /api/insights/sweep` calls `sweepWorkspaceDrift`
 * directly rather than going through this function, but the contract is the
 * same).
 *
 * Never re-throws. Per-workspace errors are caught and logged so one
 * workspace's failure does NOT abort the rest of the tick. Errors above the
 * loop (the workspace SELECT itself) are caught at the callsite in
 * `startScheduler()`.
 */
export async function runFleetgraphSweepTick(): Promise<void> {
  let workspaceIds: string[];
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT id
         FROM workspaces
        WHERE archived_at IS NULL
          AND settings->'fleetgraph'->>'sweep_enabled' = 'true'`
    );
    workspaceIds = res.rows.map((r) => r.id);
  } catch (err) {
    console.error('[scheduler] failed to list enabled workspaces:', err);
    return;
  }

  for (const workspaceId of workspaceIds) {
    try {
      await tickOneWorkspace(workspaceId);
    } catch (err) {
      // Defense in depth — tickOneWorkspace catches its own per-workspace
      // failures, but if it ever throws (e.g. release() failure), we still
      // continue to the next workspace.
      console.error(`[scheduler] sweep ws=${workspaceId} unhandled:`, err);
    }
  }
}

/**
 * Alias of {@link runFleetgraphSweepTick}. The name conveys "one invocation,
 * no cron registration" — used by tests + (future) manual-trigger callers
 * that want the iteration semantics without the cron-schedule side effect.
 */
export async function runFleetgraphSweepTickOnce(): Promise<void> {
  return runFleetgraphSweepTick();
}

// ─── Per-workspace tick ─────────────────────────────────────────────────

async function tickOneWorkspace(workspaceId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");

    const lockRes = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
      [sweepWorkspaceLockKeyParams(workspaceId)]
    );
    const acquired = lockRes.rows[0]?.acquired === true;
    if (!acquired) {
      await client.query('ROLLBACK');
      console.log(`[scheduler] sweep skipped (lock held): ws=${workspaceId}`);
      return;
    }

    try {
      const result = await sweepWorkspaceDrift(workspaceId, { client });
      await client.query('COMMIT');
      console.log(
        `[scheduler] sweep ws=${workspaceId} scanned=${result.scanned} created=${result.created} refreshed=${result.refreshed} skipped=${result.skipped} suppressed=${result.suppressed} degraded=${result.degraded}`
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Swallow rollback errors — original error is what matters.
      }
      console.error(`[scheduler] sweep failed ws=${workspaceId}:`, err);
    }
  } catch (err) {
    // Failure before/around the lock probe (BEGIN, SET LOCAL, or the lock
    // query itself). Best-effort rollback and log; do not re-throw.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Swallow.
    }
    console.error(`[scheduler] sweep setup failed ws=${workspaceId}:`, err);
  } finally {
    client.release();
  }
}
