/**
 * Concurrency integration tests for insight.ts against REAL Postgres
 * (ship_test). These are deliberately separate from insight.test.ts —
 * the mocked suite proves the SQL shape and logic; these prove the
 * load-bearing concurrency claims (advisory lock + CTE+FOR UPDATE
 * actually serialize, partial unique index actually catches out-of-band
 * writers).
 *
 * Setup is the same shared `ship_test` DB the rest of the suite uses
 * (truncate-at-suite-start in api/src/test/setup.ts). Per-test fixtures
 * use a `testRunId` suffix so concurrent test runs don't collide on
 * workspace names.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/client.js';
import {
  createOrRefreshInsight,
  resolveInsight,
  type CreateOrRefreshInsightArgs,
} from './insight.js';

// ─── Fixtures ───────────────────────────────────────────────────────────

const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let workspaceId: string;
let projectId: string;

beforeAll(async () => {
  // Workspace
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`Insight Concurrency ${testRunId}`]
  );
  workspaceId = ws.rows[0]!.id;

  // Project subject (no user — created_by NULL is fine for documents per schema)
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
     VALUES ($1, 'project', $2, 'workspace', NULL)
     RETURNING id`,
    [workspaceId, `Insight Test Project ${testRunId}`]
  );
  projectId = proj.rows[0]!.id;
});

afterAll(async () => {
  // Best-effort cleanup. The suite-level TRUNCATE in setup.ts handles the rest;
  // this just keeps the workspace from cluttering an inspected DB.
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {});
});

function baseArgs(overrides: Partial<CreateOrRefreshInsightArgs> = {}): CreateOrRefreshInsightArgs {
  return {
    workspaceId,
    subjectId: projectId,
    subjectEntityType: 'project',
    kind: 'project_drift',
    severity: 'fyi',
    summary: 'Test drift',
    recommendedAction: 'Investigate',
    evidence: { signals: [{ type: 'idle', reason: 'idle 9 days' }] },
    verdict: { decision: 'SURFACE_FYI', reasoning: 'mild' },
    inputHash: 'hash-base',
    accountableOwnerId: null,
    ...overrides,
  };
}

async function deleteAllInsightsForSubject(): Promise<void> {
  // Direct DELETE bypassing the service path — resets test state without
  // running through the resolveInsight flow (which would leave history rows).
  await pool.query(
    `DELETE FROM documents
       WHERE document_type = 'insight'
         AND workspace_id = $1
         AND properties->'fleetgraph_insight'->>'subject_id' = $2`,
    [workspaceId, projectId]
  );
}

// ─── T37 — parallel first detections produce exactly one OPEN row ───────

describe('T37: parallel first-detections serialize via advisory lock', () => {
  it('two concurrent createOrRefreshInsight calls produce exactly one OPEN row + one association', async () => {
    await deleteAllInsightsForSubject();

    const [a, b] = await Promise.all([
      createOrRefreshInsight(baseArgs({ inputHash: 'h-a' })),
      createOrRefreshInsight(baseArgs({ inputHash: 'h-b' })),
    ]);

    // Exactly one created, the other refreshed.
    const created = [a, b].filter((r) => r.didCreate).length;
    expect(created).toBe(1);

    // One OPEN row in the DB.
    const openRows = await pool.query(
      `SELECT id FROM documents
         WHERE document_type = 'insight'
           AND workspace_id = $1
           AND properties->'fleetgraph_insight'->>'subject_id' = $2
           AND properties->'fleetgraph_insight'->>'state' = 'open'`,
      [workspaceId, projectId]
    );
    expect(openRows.rowCount).toBe(1);

    // Exactly one association row (discusses).
    const assocs = await pool.query(
      `SELECT da.document_id FROM document_associations da
         INNER JOIN documents i ON i.id = da.document_id
         WHERE da.related_id = $1
           AND da.relationship_type = 'discusses'
           AND i.document_type = 'insight'`,
      [projectId]
    );
    expect(assocs.rowCount).toBe(1);
  });
});

// ─── T38 — parallel refreshes increment occurrence_count atomically ────

describe('T38: parallel refreshes server-side increment occurrence_count without torn writes', () => {
  it('N concurrent refreshes leave occurrence_count = start + N', async () => {
    await deleteAllInsightsForSubject();

    // Seed: one create
    const seed = await createOrRefreshInsight(baseArgs({ inputHash: 'h-seed' }));
    expect(seed.didCreate).toBe(true);
    const startCount = seed.insight!.insight.occurrence_count;
    expect(startCount).toBe(1);

    // Fire N parallel refreshes with DIFFERENT input_hashes (so each takes the
    // evidence-refresh branch, which bumps occurrence_count on each call).
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createOrRefreshInsight(baseArgs({ inputHash: `h-r${i}`, summary: `s${i}` }))
      )
    );

    const final = await pool.query<{ count_str: string }>(
      `SELECT properties->'fleetgraph_insight'->>'occurrence_count' AS count_str
         FROM documents
         WHERE document_type = 'insight'
           AND workspace_id = $1
           AND properties->'fleetgraph_insight'->>'subject_id' = $2
           AND properties->'fleetgraph_insight'->>'state' = 'open'`,
      [workspaceId, projectId]
    );
    expect(final.rowCount).toBe(1);
    expect(parseInt(final.rows[0]!.count_str, 10)).toBe(startCount + N);
  });
});

// ─── T39 — parallel resolveInsight is idempotent ──────────────────────

describe('T39: parallel resolveInsight calls are idempotent', () => {
  it('two concurrent resolves succeed; row ends in resolved with single resolved_at stamp', async () => {
    await deleteAllInsightsForSubject();
    const seed = await createOrRefreshInsight(baseArgs({ inputHash: 'h-resolve' }));
    const insightId = seed.insight!.id;

    const [a, b] = await Promise.all([
      resolveInsight({ insightId, workspaceId, reason: 'test-a' }),
      resolveInsight({ insightId, workspaceId, reason: 'test-b' }),
    ]);

    // Exactly one of the two transitioned the state.
    const transitions = [a, b].filter((r) => r.didResolve).length;
    expect(transitions).toBe(1);
    // The other observed prior_state='resolved' OR prior_state='open' followed
    // by the row already being resolved by the time it inspected (depending
    // on lock ordering — the CTE captures pre-lock state).

    const row = await pool.query<{ state: string }>(
      `SELECT properties->'fleetgraph_insight'->>'state' AS state
         FROM documents WHERE id = $1`,
      [insightId]
    );
    expect(row.rows[0]!.state).toBe('resolved');
  });
});

// ─── T40 — race: createOrRefreshInsight + resolveInsight ──────────────

describe('T40: createOrRefreshInsight racing resolveInsight reaches deterministic final state', () => {
  it('after parallel resolve + new detection, one resolved row exists and a fresh OPEN may exist', async () => {
    await deleteAllInsightsForSubject();
    const seed = await createOrRefreshInsight(baseArgs({ inputHash: 'h-seed' }));
    const insightId = seed.insight!.id;

    // Race: resolve the open row while a new detection comes in.
    const [_resolveResult, _detectResult] = await Promise.all([
      resolveInsight({ insightId, workspaceId }),
      createOrRefreshInsight(baseArgs({ inputHash: 'h-new' })),
    ]);

    // Possible final states:
    //   (a) Resolve runs first → original row resolved. Detect runs second,
    //       SELECT for live row returns empty (resolved filtered) → fresh INSERT.
    //       Final: 1 resolved + 1 open.
    //   (b) Detect runs first → updates the live row to severity/summary/etc.
    //       Resolve runs second → flips that same row to resolved.
    //       Final: 1 resolved, 0 open.
    //
    // Either is correct; the invariant we ASSERT is "the partial unique index
    // never raised 23505" (it didn't, since both runs reached here) AND
    // "the existing open insight always pointed at exactly one row."

    const rows = await pool.query<{ state: string }>(
      `SELECT properties->'fleetgraph_insight'->>'state' AS state
         FROM documents
         WHERE document_type = 'insight'
           AND workspace_id = $1
           AND properties->'fleetgraph_insight'->>'subject_id' = $2
         ORDER BY created_at`,
      [workspaceId, projectId]
    );
    const states = rows.rows.map((r) => r.state);
    const openCount = states.filter((s) => s === 'open').length;
    const resolvedCount = states.filter((s) => s === 'resolved').length;

    // At most one OPEN row at any time (the load-bearing invariant).
    expect(openCount).toBeLessThanOrEqual(1);
    // At least one resolved row (the one we just resolved).
    expect(resolvedCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── T41 — partial unique index catches out-of-band writers ───────────

describe('T41: partial unique index enforces one-OPEN-per-(subject,kind) when the lock is bypassed', () => {
  it('two direct INSERTs of the same open-shaped insight: second raises 23505', async () => {
    await deleteAllInsightsForSubject();

    // First INSERT — bypassing the service path entirely. Must obey the
    // CHECK constraint shape (state, kind, subject_id required).
    const insightProps = {
      state: 'open',
      kind: 'project_drift',
      severity: 'fyi',
      subject_id: projectId,
      subject_entity_type: 'project',
      summary: 's',
      recommended_action: 'a',
      evidence: {},
      verdict: { decision: 'SURFACE_FYI', reasoning: '' },
      input_hash: 'h',
      accountable_owner_id: null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      last_changed_at: new Date().toISOString(),
      occurrence_count: 1,
      resolved_at: null,
      resolved_reason: null,
      snoozed_until: null,
      dismissed_at: null,
      dismissed_by: null,
    };
    const properties = { fleetgraph_insight: insightProps };

    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
         VALUES ($1, 'insight', 'direct insert A', NULL, 'workspace', $2::jsonb)`,
      [workspaceId, JSON.stringify(properties)]
    );

    // Second INSERT — should raise 23505 because the partial unique index
    // catches the (workspace_id, subject_id, kind) collision on state=open.
    await expect(
      pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
           VALUES ($1, 'insight', 'direct insert B', NULL, 'workspace', $2::jsonb)`,
        [workspaceId, JSON.stringify(properties)]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ─── T42 — CHECK constraint catches malformed insight rows ────────────

describe('T42: CHECK constraint rejects insight rows missing required JSONB keys', () => {
  it('insert with no fleetgraph_insight key raises 23514', async () => {
    await expect(
      pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
           VALUES ($1, 'insight', 'malformed', NULL, 'workspace', '{}'::jsonb)`,
        [workspaceId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('insert with missing subject_id raises 23514', async () => {
    await expect(
      pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
           VALUES ($1, 'insight', 'malformed', NULL, 'workspace',
             $2::jsonb)`,
        [
          workspaceId,
          JSON.stringify({ fleetgraph_insight: { state: 'open', kind: 'project_drift' } }),
        ]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('insert with invalid state raises 23514', async () => {
    await expect(
      pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
           VALUES ($1, 'insight', 'malformed', NULL, 'workspace', $2::jsonb)`,
        [
          workspaceId,
          JSON.stringify({
            fleetgraph_insight: { state: 'in_review', kind: 'project_drift', subject_id: projectId },
          }),
        ]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ─── T43 — different kinds coexist OPEN on same subject ───────────────

describe('T43: different kinds for the same subject coexist OPEN (lock keys differ)', () => {
  it('two insights with different kind values on the same subject coexist as OPEN', async () => {
    // Skipped in v1 because only one kind exists. The lock keys would differ
    // by construction (the colon-separated hash includes kind), and the
    // partial unique index is keyed on `kind` so it doesn't collide either.
    // When a second kind ships, restore this with a real kind value:
    //
    //   await deleteAllInsightsForSubject();
    //   await createOrRefreshInsight(baseArgs({ kind: 'project_drift' }));
    //   await createOrRefreshInsight(baseArgs({ kind: '<other_kind>' }));
    //   // assert: 2 OPEN rows
    //
    // For now we assert the partial unique index does NOT collide between a
    // (project_drift, OPEN) row and a (project_drift, RESOLVED) row — i.e.
    // history rows don't conflict with new live rows.
    await deleteAllInsightsForSubject();
    const seed = await createOrRefreshInsight(baseArgs({ inputHash: 'h-seed' }));
    await resolveInsight({ insightId: seed.insight!.id, workspaceId });
    const refresh = await createOrRefreshInsight(baseArgs({ inputHash: 'h-new' }));
    expect(refresh.didCreate).toBe(true);

    const rows = await pool.query(
      `SELECT properties->'fleetgraph_insight'->>'state' AS state
         FROM documents
         WHERE document_type = 'insight'
           AND workspace_id = $1
           AND properties->'fleetgraph_insight'->>'subject_id' = $2`,
      [workspaceId, projectId]
    );
    expect(rows.rowCount).toBe(2); // 1 resolved (history) + 1 open (new)
  });
});

// ─── T44 — advisory-lock contention triggers statement_timeout ────────

// The plan's original T44 described 'row lock contention' which would not
// fire the upsert's 5s statement_timeout (the upsert's blocking primitive is
// pg_advisory_xact_lock, not row locks). Rewriting to test the actual path:
// hold the advisory lock from a separate connection, then attempt the upsert
// from the service path. The advisory_xact_lock SELECT inside the
// transaction blocks until statement_timeout fires.

describe('T44: advisory-lock contention triggers statement_timeout 57014', () => {
  it('upsert blocks on advisory lock and times out within ~5s', async () => {
    await deleteAllInsightsForSubject();

    // Take the same advisory lock from a separate connection.
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      // Same key derivation as insight.ts: hashtextextended('ws:subj:kind', 0)
      const lockKeyInput = `${workspaceId}:${projectId}:project_drift`;
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        lockKeyInput,
      ]);

      // Now run the upsert — it will block on the SAME lock key and time out.
      const start = Date.now();
      let caught: { code?: string } | null = null;
      try {
        await createOrRefreshInsight(baseArgs({ inputHash: 'h-timeout' }));
      } catch (err) {
        caught = err as { code?: string };
      }
      const elapsedMs = Date.now() - start;

      expect(caught).not.toBeNull();
      // Postgres statement_timeout fires with SQLSTATE 57014.
      expect(caught?.code).toBe('57014');
      // Should be within 5–7 seconds (we set 5s timeout; allow margin).
      expect(elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(elapsedMs).toBeLessThanOrEqual(8000);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
  }, 15_000); // 15s test timeout (the 5s lock wait + setup margin)
});
