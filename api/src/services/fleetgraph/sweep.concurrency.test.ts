/**
 * Concurrency integration tests for sweep.ts against REAL Postgres
 * (ship_test). Mirrors insight.concurrency.test.ts:
 *   - per-test cleanup of insight rows for our subject(s);
 *   - testRunId suffix so concurrent test runs don't collide on workspace
 *     names.
 *
 * These prove the load-bearing concurrency claims (advisory lock actually
 * serializes; refresh path actually bumps occurrence_count; persisted insight
 * is reachable via the visibility-scoped read path — guards the linkage
 * lesson from docs/solutions/logic-errors/fleet-chat-created-issue-not-
 * associated-with-project.md).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/client.js';
import {
  sweepWorkspaceDrift,
  SweepInProgressError,
} from './sweep.js';
import { listInsights } from './insight.js';

// ─── Fixtures ───────────────────────────────────────────────────────────

const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let workspaceId: string;
let emptyWorkspaceId: string;
let projectId: string;
let userId: string;

/**
 * Build a workspace with one `active` drifting project:
 *   - sprint allocation with assignee → inferred_status='active'
 *   - project has no plan → 'no plan' drift signal
 *   - issue is old (created_at long ago) → 'idle' drift signal
 */
async function seedDriftingProject(opts: { workspaceId: string }): Promise<string> {
  // Project (no plan text → triggers 'no plan' signal).
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties, created_at)
     VALUES ($1, 'project', $2, 'workspace', NULL, '{}'::jsonb, NOW() - INTERVAL '60 days')
     RETURNING id`,
    [opts.workspaceId, `Sweep Drifting Project ${testRunId}`]
  );
  const pid = proj.rows[0]!.id;

  // Sprint allocation (current sprint, has assignees → inferred_status='active').
  const sprint = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties)
     VALUES ($1, 'sprint', $2, 'workspace', NULL, $3::jsonb)
     RETURNING id`,
    [
      opts.workspaceId,
      `Sweep Sprint ${testRunId}`,
      JSON.stringify({
        sprint_number: 1, // sprint_start_date defaults to CURRENT_DATE
        project_id: pid,
        assignee_ids: ['00000000-0000-0000-0000-000000000001'],
      }),
    ]
  );
  const sid = sprint.rows[0]!.id;
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
    [sid, pid]
  );

  // Issue: open (state=in_progress, not done/cancelled), created long enough
  // ago that lastMovementAt > IDLE_DAYS so the 'idle' signal fires.
  const issue = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by, properties, created_at)
     VALUES ($1, 'issue', $2, 'workspace', NULL, $3::jsonb, NOW() - INTERVAL '30 days')
     RETURNING id`,
    [
      opts.workspaceId,
      `Sweep Issue ${testRunId}`,
      JSON.stringify({ state: 'in_progress' }),
    ]
  );
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
    [issue.rows[0]!.id, pid]
  );

  return pid;
}

beforeAll(async () => {
  // Two workspaces: one with a drifting project, one with nothing.
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`Sweep Concurrency ${testRunId}`]
  );
  workspaceId = ws.rows[0]!.id;

  const emptyWs = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`Sweep Empty ${testRunId}`]
  );
  emptyWorkspaceId = emptyWs.rows[0]!.id;

  // Member user for the visibility-scoped read assertion.
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'h', 'Sweep Member')
     RETURNING id`,
    [`sweep-${testRunId}@ship.local`]
  );
  userId = user.rows[0]!.id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
    [workspaceId, userId]
  );

  projectId = await seedDriftingProject({ workspaceId });
});

afterAll(async () => {
  // Best-effort cleanup — suite-level TRUNCATE handles the rest.
  await pool
    .query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [workspaceId, emptyWorkspaceId])
    .catch(() => {});
});

async function clearInsightsForWorkspace(ws: string): Promise<void> {
  await pool.query(
    `DELETE FROM documents WHERE document_type = 'insight' AND workspace_id = $1`,
    [ws]
  );
}

// ─── C1 — parallel sweeps: one wins, one throws SweepInProgressError ────

describe('C1: two parallel sweepWorkspaceDrift calls (no client) serialize via advisory lock', () => {
  it('exactly one completes; the other throws SweepInProgressError; one OPEN insight row', async () => {
    await clearInsightsForWorkspace(workspaceId);

    const settled = await Promise.allSettled([
      sweepWorkspaceDrift(workspaceId),
      sweepWorkspaceDrift(workspaceId),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      SweepInProgressError
    );

    // The winning sweep created exactly one open insight.
    const openRows = await pool.query(
      `SELECT id FROM documents
         WHERE document_type = 'insight'
           AND workspace_id = $1
           AND properties->'fleetgraph_insight'->>'state' = 'open'`,
      [workspaceId]
    );
    expect(openRows.rowCount).toBe(1);
  });
});

// ─── C2 — sequential calls: second observes refreshed:1, occurrence_count=2 ─

describe('C2: sequential sweeps refresh the existing OPEN row', () => {
  it('second sweep returns refreshed:1; row occurrence_count is 2', async () => {
    await clearInsightsForWorkspace(workspaceId);

    const r1 = await sweepWorkspaceDrift(workspaceId);
    expect(r1.scanned).toBeGreaterThanOrEqual(1);
    expect(r1.created).toBe(1);
    expect(r1.refreshed).toBe(0);

    const r2 = await sweepWorkspaceDrift(workspaceId);
    expect(r2.refreshed).toBe(1);
    expect(r2.created).toBe(0);

    const row = await pool.query<{ count_str: string }>(
      `SELECT properties->'fleetgraph_insight'->>'occurrence_count' AS count_str
         FROM documents
         WHERE document_type = 'insight'
           AND workspace_id = $1
           AND properties->'fleetgraph_insight'->>'state' = 'open'`,
      [workspaceId]
    );
    expect(row.rowCount).toBe(1);
    expect(parseInt(row.rows[0]!.count_str, 10)).toBe(2);
  });
});

// ─── C3 — persisted insight reachable via listInsights ─────────────────

describe('C3: post-sweep insight reachable via visibility-scoped listInsights', () => {
  it('listInsights for a workspace admin returns the swept insight', async () => {
    await clearInsightsForWorkspace(workspaceId);
    const r = await sweepWorkspaceDrift(workspaceId);
    expect(r.created).toBeGreaterThanOrEqual(1);

    // Admin read — bypasses the visibility filter via OR TRUE. Guards
    // the linkage lesson: the row exists AND it is reachable through the
    // visibility-scoped read path, not just by primary key.
    const insights = await listInsights({
      workspaceId,
      userId,
      isAdmin: true,
    });
    expect(insights.length).toBeGreaterThanOrEqual(1);

    const ours = insights.find((i) => i.subject_id === projectId);
    expect(ours).toBeDefined();
    expect(ours!.insight.kind).toBe('project_drift');
    expect(ours!.insight.state).toBe('open');
    expect(ours!.subject_document_type).toBe('project');
  });
});

// ─── C4 — empty workspace ─────────────────────────────────────────────

describe('C4: sweep against a workspace with no projects', () => {
  it('completes cleanly with scanned:0', async () => {
    const r = await sweepWorkspaceDrift(emptyWorkspaceId);
    expect(r).toEqual({
      workspaceId: emptyWorkspaceId,
      scanned: 0,
      created: 0,
      refreshed: 0,
      skipped: 0,
    });
  });
});
