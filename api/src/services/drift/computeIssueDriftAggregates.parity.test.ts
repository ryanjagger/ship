import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/client.js';
import { driftIssueAggregates } from './driftSql.js';
import { computeIssueDriftAggregates, type DriftIssueLike } from './computeIssueDriftAggregates.js';

/**
 * Parity gate (issue #95 step 8): the pure aggregate function the sweep now
 * runs over v1 issue DTOs must agree with the `driftIssueAggregates` SQL
 * fragment the project-list endpoints still use. Seeds a spread of issue
 * shapes (states × lifecycle timestamps × ages straddling the 7-day window)
 * and compares both implementations on the SAME rows.
 */
describe('computeIssueDriftAggregates ↔ driftIssueAggregates SQL parity', () => {
  let workspaceId: string;
  let projectId: string;

  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const daysAgo = (n: number): string => new Date(now.getTime() - n * DAY).toISOString();

  // States × timestamps chosen to exercise every aggregate branch:
  // open vs incomplete vs closed, NULL state, movement on each lifecycle
  // column, and created/completed/cancelled on both sides of the 7-day line.
  const ISSUES: Array<{ state: string | null; created: string; started?: string; completed?: string; cancelled?: string; reopened?: string }> = [
    { state: 'todo', created: daysAgo(20) },
    { state: 'in_progress', created: daysAgo(10), started: daysAgo(2) },
    { state: 'backlog', created: daysAgo(9) },
    { state: 'triage', created: daysAgo(3) }, // younger than 7d → not in 7d-ago
    { state: null, created: daysAgo(15) }, // NULL state counts incomplete
    { state: 'done', created: daysAgo(30), started: daysAgo(25), completed: daysAgo(1) }, // completed inside the window → still counted 7d-ago
    { state: 'done', created: daysAgo(30), completed: daysAgo(8) }, // completed before the window → not counted
    { state: 'cancelled', created: daysAgo(12), cancelled: daysAgo(6) }, // cancelled inside the window → counted
    { state: 'cancelled', created: daysAgo(12), cancelled: daysAgo(9) }, // cancelled before the window → not counted
    { state: 'in_review', created: daysAgo(40), reopened: daysAgo(0.5) }, // reopened is movement
  ];

  beforeAll(async () => {
    workspaceId = (await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Drift Parity WS') RETURNING id`)).rows[0]!.id;
    projectId = (
      await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, document_type, title, visibility) VALUES ($1, 'project', 'Parity P', 'workspace') RETURNING id`,
        [workspaceId]
      )
    ).rows[0]!.id;

    for (const issue of ISSUES) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO documents (workspace_id, document_type, title, properties, visibility, created_at, started_at, completed_at, cancelled_at, reopened_at)
         VALUES ($1, 'issue', 'I', $2, 'workspace', $3, $4, $5, $6, $7) RETURNING id`,
        [
          workspaceId,
          JSON.stringify(issue.state == null ? {} : { state: issue.state }),
          issue.created,
          issue.started ?? null,
          issue.completed ?? null,
          issue.cancelled ?? null,
          issue.reopened ?? null,
        ]
      );
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'project')`,
        [r.rows[0]!.id, projectId]
      );
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  it('both implementations produce identical aggregates over the same issues', async () => {
    const sqlResult = await pool.query<{
      last_movement_at: Date | null;
      open_now: string;
      incomplete_now: string;
      incomplete_7d_ago: string;
    }>(
      `SELECT ${driftIssueAggregates('i')}
         FROM document_associations da
         JOIN documents i ON i.id = da.document_id AND i.document_type = 'issue'
        WHERE da.related_id = $1 AND da.relationship_type = 'project'`,
      [projectId]
    );
    const sql = sqlResult.rows[0]!;

    const dtoRows: DriftIssueLike[] = ISSUES.map((issue) => ({
      state: issue.state,
      created_at: issue.created,
      started_at: issue.started ?? null,
      completed_at: issue.completed ?? null,
      cancelled_at: issue.cancelled ?? null,
      reopened_at: issue.reopened ?? null,
    }));
    const pure = computeIssueDriftAggregates(dtoRows, now);

    expect(pure.lastMovementAt?.toISOString()).toBe(sql.last_movement_at?.toISOString());
    expect(pure.openNow).toBe(Number(sql.open_now));
    expect(pure.incompleteNow).toBe(Number(sql.incomplete_now));
    expect(pure.incomplete7dAgo).toBe(Number(sql.incomplete_7d_ago));

    // Anchor the expected values so a bug in BOTH implementations can't slip
    // through as "parity".
    expect(pure).toEqual({
      lastMovementAt: expect.any(Date),
      openNow: 2, // todo + in_progress
      incompleteNow: 6, // todo, in_progress, backlog, triage, NULL, in_review
      incomplete7dAgo: 7, // all created ≥7d ago minus the early-completed/cancelled pair
    });
  });

  it('returns nulls/zeros for an empty issue set', () => {
    expect(computeIssueDriftAggregates([], now)).toEqual({
      lastMovementAt: null,
      openNow: 0,
      incompleteNow: 0,
      incomplete7dAgo: 0,
    });
  });
});
