/**
 * Unit tests for sweep.ts. Mocked-pool style (mirrors insight.test.ts):
 * `pool.connect()` returns a fake client whose `query` we drive with
 * `mockResolvedValueOnce` calls in the order the production code issues them.
 *
 * The substrate (`createOrRefreshInsight`) is mocked so we drive its
 * return value per test — we don't re-prove the substrate's SQL shape here,
 * only that the sweep dispatches correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock setup ─────────────────────────────────────────────────────────
const { mockClientQuery, mockRelease, mockPoolQuery, mockCreateOrRefresh } =
  vi.hoisted(() => ({
    mockClientQuery: vi.fn(),
    mockRelease: vi.fn(),
    mockPoolQuery: vi.fn(),
    mockCreateOrRefresh: vi.fn(),
  }));

vi.mock('../../db/client.js', () => ({
  pool: {
    connect: vi.fn(async () => ({
      query: mockClientQuery,
      release: mockRelease,
    })),
    query: mockPoolQuery,
  },
}));

vi.mock('./insight.js', () => ({
  createOrRefreshInsight: mockCreateOrRefresh,
}));

import {
  sweepWorkspaceDrift,
  sweepWorkspaceLockKeyParams,
  SweepInProgressError,
  __testing,
} from './sweep.js';

// ─── Fixtures ───────────────────────────────────────────────────────────

const NOW = '2026-05-28T10:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockPoolQuery.mockReset();
  mockCreateOrRefresh.mockReset();
});

function projectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Default: an `active` project with high idle days, no plan, no rising work
  // → two signals (idle + stale_plan/no plan) under computeProjectDrift.
  const longAgo = new Date('2026-04-01T00:00:00.000Z'); // ~57 days before NOW
  return {
    id: 'proj-1',
    inferred_status: 'active',
    plan: null,
    plan_last_edited_at: longAgo.toISOString(),
    last_movement_at: longAgo.toISOString(),
    open_now: 5,
    incomplete_now: 5,
    incomplete_7d_ago: 5,
    ...overrides,
  };
}

function healthyRow(id: string): Record<string, unknown> {
  // active project, recent activity, healthy plan, no rising work.
  return {
    id,
    inferred_status: 'active',
    plan: 'A real plan',
    plan_last_edited_at: NOW,
    last_movement_at: NOW,
    open_now: 3,
    incomplete_now: 3,
    incomplete_7d_ago: 3,
  };
}

function mockNoClientLockSequence(opts: { acquired: boolean; queryRows?: unknown[] }): void {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL statement_timeout
    .mockResolvedValueOnce({ rows: [{ locked: opts.acquired }], rowCount: 1 }); // pg_try_advisory_xact_lock

  if (!opts.acquired) {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    return;
  }

  // The per-project SELECT.
  mockClientQuery.mockResolvedValueOnce({
    rows: opts.queryRows ?? [],
    rowCount: (opts.queryRows ?? []).length,
  });
  // COMMIT
  mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

// Helper for the substrate result.
function createResult(opts: { didCreate: boolean; nullInsight?: boolean }): {
  insight: object | null;
  didCreate: boolean;
  didEscalate: boolean;
} {
  return {
    insight: opts.nullInsight ? null : { id: 'insight-x' },
    didCreate: opts.didCreate,
    didEscalate: false,
  };
}

// ─── Lock-key helper ────────────────────────────────────────────────────

describe('sweepWorkspaceLockKeyParams', () => {
  it('returns the namespaced key "sweep:<workspaceId>"', () => {
    expect(sweepWorkspaceLockKeyParams('ws-abc')).toBe('sweep:ws-abc');
  });

  it('disjoint from the insight lock-key namespace (UUIDs never start with "sweep:")', () => {
    // Defensive: confirm the prefix is what the plan says, since the
    // scheduler reuses this on the same advisory-lock keyspace as insight.ts.
    expect(sweepWorkspaceLockKeyParams('proj-1')).toMatch(/^sweep:/);
  });
});

// ─── Happy path / dispatch ──────────────────────────────────────────────

describe('sweepWorkspaceDrift — happy path (no client)', () => {
  it('3 projects (2 drift, 1 healthy) → scanned:3, created:2, refreshed:0, skipped:1', async () => {
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        projectRow({ id: 'p-drift-1' }),
        projectRow({
          id: 'p-drift-2',
          plan: 'has a plan',
          plan_last_edited_at: NOW, // plan NOT stale
          last_movement_at: '2026-04-01T00:00:00.000Z', // BUT idle
        }),
        healthyRow('p-healthy'),
      ],
    });
    mockCreateOrRefresh
      .mockResolvedValueOnce(createResult({ didCreate: true })) // p-drift-1
      .mockResolvedValueOnce(createResult({ didCreate: true })); // p-drift-2

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result).toEqual({
      workspaceId: 'ws-1',
      scanned: 3,
      created: 2,
      refreshed: 0,
      skipped: 1,
    });

    // Substrate called twice with the right shape
    expect(mockCreateOrRefresh).toHaveBeenCalledTimes(2);
    const firstCall = mockCreateOrRefresh.mock.calls[0]![0];
    expect(firstCall.subjectEntityType).toBe('project');
    expect(firstCall.kind).toBe('project_drift');
    expect(firstCall.subjectId).toBe('p-drift-1');
    expect(firstCall.workspaceId).toBe('ws-1');
    expect(firstCall.summary).toMatch(/^Project drift:/);
    expect(firstCall.recommendedAction).toBe(
      'Review project status and update plan or close stale issues.'
    );
    expect(typeof firstCall.inputHash).toBe('string');
    expect(firstCall.inputHash).toMatch(/^[a-f0-9]{40}$/);
    expect(firstCall.verdict.decision).toMatch(/^SURFACE_/);
  });

  it('BEGIN → SET LOCAL → pg_try_advisory_xact_lock → SELECT projects → COMMIT in order', async () => {
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [healthyRow('p-1')],
    });

    await sweepWorkspaceDrift('ws-1');

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/SET LOCAL statement_timeout = '30s'/);
    expect(calls[2]).toMatch(/pg_try_advisory_xact_lock\(hashtextextended/);
    // The lock-key parameter is `sweep:<workspaceId>`.
    const lockParams = mockClientQuery.mock.calls[2]![1] as unknown[];
    expect(lockParams[0]).toBe('sweep:ws-1');
    // Followed by the per-project SELECT.
    expect(calls[3]).toMatch(/FROM workspace_projects/);
    expect(calls[4]).toBe('COMMIT');

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ─── Refresh path ──────────────────────────────────────────────────────

describe('sweepWorkspaceDrift — refresh path', () => {
  it('substrate returns didCreate:false → refreshed++ (insight not null)', async () => {
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' }), projectRow({ id: 'p-2' })],
    });
    mockCreateOrRefresh
      .mockResolvedValueOnce(createResult({ didCreate: false }))
      .mockResolvedValueOnce(createResult({ didCreate: false }));

    const result = await sweepWorkspaceDrift('ws-1');
    expect(result.created).toBe(0);
    expect(result.refreshed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.scanned).toBe(2);
  });

  it('substrate returns didCreate:false AND insight:null (benign subject race) → skipped++', async () => {
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(
      createResult({ didCreate: false, nullInsight: true })
    );

    const result = await sweepWorkspaceDrift('ws-1');
    expect(result.created).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.scanned).toBe(1);
  });
});

// ─── Eligibility ───────────────────────────────────────────────────────

describe('sweepWorkspaceDrift — eligibility filter', () => {
  it('ineligible inferred_status (completed) is skipped before computeProjectDrift; not counted in scanned', async () => {
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        projectRow({ id: 'p-1', inferred_status: 'completed' }),
        projectRow({ id: 'p-2', inferred_status: 'backlog' }),
        projectRow({ id: 'p-3', inferred_status: 'archived' }),
        projectRow({ id: 'p-4' }), // active, drifting
      ],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    const result = await sweepWorkspaceDrift('ws-1');
    // Only the one `active` row counts toward scanned.
    expect(result.scanned).toBe(1);
    expect(result.created).toBe(1);
    expect(mockCreateOrRefresh).toHaveBeenCalledTimes(1);
    expect(mockCreateOrRefresh.mock.calls[0]![0].subjectId).toBe('p-4');
  });

  it('"planned" inferred_status is eligible (matches computeProjectDrift)', async () => {
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1', inferred_status: 'planned' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    const result = await sweepWorkspaceDrift('ws-1');
    expect(result.scanned).toBe(1);
    expect(result.created).toBe(1);
  });
});

// ─── Empty workspace ───────────────────────────────────────────────────

describe('sweepWorkspaceDrift — empty workspace', () => {
  it('no eligible projects → {scanned:0, created:0, refreshed:0, skipped:0}; no substrate calls', async () => {
    mockNoClientLockSequence({ acquired: true, queryRows: [] });

    const result = await sweepWorkspaceDrift('ws-1');
    expect(result).toEqual({
      workspaceId: 'ws-1',
      scanned: 0,
      created: 0,
      refreshed: 0,
      skipped: 0,
    });
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
  });
});

// ─── Severity mapping (via __testing.buildInsightArgs path → substrate args) ─

describe('sweepWorkspaceDrift — severity mapping', () => {
  it('single signal → severity=fyi, verdict.decision=SURFACE_FYI', async () => {
    // Healthy plan but high idle (1 signal: idle).
    const longAgo = '2026-04-01T00:00:00.000Z';
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        {
          id: 'p-1',
          inferred_status: 'active',
          plan: 'A real plan',
          plan_last_edited_at: NOW, // plan NOT stale
          last_movement_at: longAgo, // idle
          open_now: 5,
          incomplete_now: 5,
          incomplete_7d_ago: 5,
        },
      ],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    await sweepWorkspaceDrift('ws-1');
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    expect(args.severity).toBe('fyi');
    expect(args.verdict.decision).toBe('SURFACE_FYI');
  });

  it('two signals → severity=act, verdict.decision=SURFACE_ACT', async () => {
    // Idle + no plan = 2 signals.
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    await sweepWorkspaceDrift('ws-1');
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    expect(args.severity).toBe('act');
    expect(args.verdict.decision).toBe('SURFACE_ACT');
  });

  it('three signals → severity=act (everything >=2 maps to act)', async () => {
    // Idle + no plan + rising_incomplete_work = 3 signals.
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        projectRow({
          id: 'p-1',
          incomplete_now: 10,
          incomplete_7d_ago: 5, // delta = 5 ≥ 2
        }),
      ],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    await sweepWorkspaceDrift('ws-1');
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    expect(args.severity).toBe('act');
    expect(args.verdict.decision).toBe('SURFACE_ACT');
    // Evidence carries all three signals.
    expect((args.evidence as { signals: unknown[] }).signals).toHaveLength(3);
  });
});

// ─── inputHash stability ──────────────────────────────────────────────

describe('sweepWorkspaceDrift — inputHash stability', () => {
  const baseInput = {
    kind: 'project_drift',
    signalTypes: ['idle', 'stale_plan'],
    lastMovementAtDay: '2026-04-01',
    planLastEditedAtDay: '2026-04-01',
    openNow: 5,
    incompleteNow: 5,
    incomplete7dAgo: 5,
  };

  it('same inputs → identical hash', () => {
    const h1 = __testing.computeInputHash(baseInput);
    const h2 = __testing.computeInputHash({ ...baseInput });
    expect(h1).toBe(h2);
  });

  it('key order in input record does not change the hash (canonicalized)', () => {
    const reordered = {
      incomplete7dAgo: 5,
      incompleteNow: 5,
      openNow: 5,
      planLastEditedAtDay: '2026-04-01',
      lastMovementAtDay: '2026-04-01',
      signalTypes: ['idle', 'stale_plan'],
      kind: 'project_drift',
    };
    expect(__testing.computeInputHash(reordered)).toBe(
      __testing.computeInputHash(baseInput)
    );
  });

  it('shifting lastMovementAt by one day changes the hash (day-rounded)', () => {
    const h1 = __testing.computeInputHash(baseInput);
    const h2 = __testing.computeInputHash({
      ...baseInput,
      lastMovementAtDay: '2026-04-02',
    });
    expect(h1).not.toBe(h2);
  });

  it('shifting lastMovementAt by less than a day does NOT change the hash', () => {
    // Both timestamps round to the same day → same dayString → same hash.
    const ds1 = __testing.dayString(new Date('2026-04-01T08:00:00Z'));
    const ds2 = __testing.dayString(new Date('2026-04-01T22:30:00Z'));
    expect(ds1).toBe(ds2);
    expect(ds1).toBe('2026-04-01');

    const h1 = __testing.computeInputHash({ ...baseInput, lastMovementAtDay: ds1 });
    const h2 = __testing.computeInputHash({ ...baseInput, lastMovementAtDay: ds2 });
    expect(h1).toBe(h2);
  });

  it('signalTypes ordering does not affect the hash if pre-sorted (deterministic)', () => {
    // The sweep itself sorts signalTypes before hashing — assert that two
    // permutations of the same sorted set produce the same hash. (canonicalize
    // sorts object keys but NOT array order, by design — arrays are positional.
    // So we sort BEFORE hashing in the production code path. Here we just verify
    // canonicalize honors that pre-sort.)
    const h1 = __testing.computeInputHash({
      ...baseInput,
      signalTypes: ['idle', 'stale_plan'].sort(),
    });
    const h2 = __testing.computeInputHash({
      ...baseInput,
      signalTypes: ['stale_plan', 'idle'].sort(),
    });
    expect(h1).toBe(h2);
  });

  it('different signal set yields different hash', () => {
    const h1 = __testing.computeInputHash(baseInput);
    const h2 = __testing.computeInputHash({
      ...baseInput,
      signalTypes: ['idle', 'stale_plan', 'rising_incomplete_work'],
    });
    expect(h1).not.toBe(h2);
  });
});

// ─── Summary template ─────────────────────────────────────────────────

describe('sweepWorkspaceDrift — summary template', () => {
  it('summary reads "Project drift: " + comma-joined signal reasons', async () => {
    // 2 signals expected: "idle X days" + "no plan".
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    await sweepWorkspaceDrift('ws-1');
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    expect(args.summary).toMatch(/^Project drift: /);
    expect(args.summary).toMatch(/idle \d+ days/);
    expect(args.summary).toMatch(/no plan/);
    // Comma-joined: at least one ", " separator when ≥ 2 signals.
    expect(args.summary).toContain(', ');
    // Verdict reasoning mirrors summary.
    expect(args.verdict.reasoning).toBe(args.summary);
  });
});

// ─── Lock-busy path ───────────────────────────────────────────────────

describe('sweepWorkspaceDrift — lock-busy path (no client)', () => {
  it('pg_try_advisory_xact_lock=false → throws SweepInProgressError; ROLLBACK + release; no substrate calls', async () => {
    mockNoClientLockSequence({ acquired: false });

    await expect(sweepWorkspaceDrift('ws-1')).rejects.toBeInstanceOf(SweepInProgressError);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('mid-loop error → ROLLBACK + release; error rethrown', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL
      .mockResolvedValueOnce({ rows: [{ locked: true }], rowCount: 1 }) // lock acquired
      .mockRejectedValueOnce(new Error('SELECT exploded')) // project SELECT fails
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await expect(sweepWorkspaceDrift('ws-1')).rejects.toThrow(/SELECT exploded/);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ─── With-client path ─────────────────────────────────────────────────

describe('sweepWorkspaceDrift — with-client path', () => {
  it('does NOT issue BEGIN/SET LOCAL/lock probe/COMMIT — caller owns the tx', async () => {
    const externalQuery = vi.fn();
    externalQuery.mockResolvedValueOnce({
      rows: [healthyRow('p-1')],
      rowCount: 1,
    });

    const externalClient = { query: externalQuery, release: vi.fn() };

    await sweepWorkspaceDrift('ws-1', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: externalClient as any,
    });

    // Only the per-project SELECT is issued on the external client.
    expect(externalQuery).toHaveBeenCalledTimes(1);
    const sql = String(externalQuery.mock.calls[0]![0]);
    expect(sql).toMatch(/FROM workspace_projects/);

    // The internal pool client was NEVER acquired.
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('does not call pg_try_advisory_xact_lock on the external client', async () => {
    const externalQuery = vi.fn();
    externalQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const externalClient = { query: externalQuery, release: vi.fn() };

    await sweepWorkspaceDrift('ws-1', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: externalClient as any,
    });

    const sqlStatements = externalQuery.mock.calls.map((c) => String(c[0]));
    expect(sqlStatements.some((s) => /pg_try_advisory_xact_lock/.test(s))).toBe(false);
    expect(sqlStatements.some((s) => /BEGIN/.test(s))).toBe(false);
    expect(sqlStatements.some((s) => /COMMIT/.test(s))).toBe(false);
  });
});
