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
const {
  mockClientQuery,
  mockRelease,
  mockPoolQuery,
  mockCreateOrRefresh,
  mockGetInsightByIdentity,
  mockGetFleetgraphSettings,
  mockGenerateDriftVerdict,
} = vi.hoisted(() => ({
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockPoolQuery: vi.fn(),
  mockCreateOrRefresh: vi.fn(),
  mockGetInsightByIdentity: vi.fn(),
  mockGetFleetgraphSettings: vi.fn(),
  mockGenerateDriftVerdict: vi.fn(),
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
  getInsightByIdentity: mockGetInsightByIdentity,
}));

vi.mock('../workspace-settings.js', () => ({
  getFleetgraphSettings: mockGetFleetgraphSettings,
}));

vi.mock('./verdictGenerator.js', () => ({
  generateDriftVerdict: mockGenerateDriftVerdict,
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
  mockGetInsightByIdentity.mockReset();
  mockGetFleetgraphSettings.mockReset();
  mockGenerateDriftVerdict.mockReset();

  // Default: LLM verdicts OFF (existing tests assume deterministic-only).
  mockGetFleetgraphSettings.mockResolvedValue({
    sweepEnabled: true,
    llmVerdictsEnabled: false,
  });
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
      suppressed: 0,
      degraded: false,
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
      suppressed: 0,
      degraded: false,
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

// ─── U4: LLM verdict routing ───────────────────────────────────────────

describe('sweepWorkspaceDrift — LLM verdicts disabled (default)', () => {
  it('every drifting project uses deterministic verdict; probe + generator NOT called', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: false,
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' }), projectRow({ id: 'p-2' })],
    });
    mockCreateOrRefresh
      .mockResolvedValueOnce(createResult({ didCreate: true }))
      .mockResolvedValueOnce(createResult({ didCreate: true }));

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.suppressed).toBe(0);
    expect(result.degraded).toBe(false);
    expect(mockGetInsightByIdentity).not.toHaveBeenCalled();
    expect(mockGenerateDriftVerdict).not.toHaveBeenCalled();

    // Both substrate calls carry verdict_source = 'deterministic' + sweep_run_id.
    expect(mockCreateOrRefresh).toHaveBeenCalledTimes(2);
    for (const call of mockCreateOrRefresh.mock.calls) {
      const evidence = call[0].evidence as Record<string, unknown>;
      expect(evidence.verdict_source).toBe('deterministic');
      expect(typeof evidence.sweep_run_id).toBe('string');
    }
  });
});

describe('sweepWorkspaceDrift — LLM verdicts enabled, no existing insight, SURFACE_ACT', () => {
  it('substrate dispatched with LLM verdict + verdict_source: llm', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    mockGetInsightByIdentity.mockResolvedValue(null);
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SURFACE_ACT', reasoning: 'AI says urgent' },
      degraded: false,
      source: 'llm',
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.created).toBe(1);
    expect(result.suppressed).toBe(0);
    expect(result.degraded).toBe(false);

    expect(mockGetInsightByIdentity).toHaveBeenCalledWith(
      'ws-1',
      'p-1',
      'project_drift'
    );
    expect(mockGenerateDriftVerdict).toHaveBeenCalledTimes(1);

    expect(mockCreateOrRefresh).toHaveBeenCalledTimes(1);
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    expect(args.verdict.decision).toBe('SURFACE_ACT');
    expect(args.verdict.reasoning).toBe('AI says urgent');
    const evidence = args.evidence as Record<string, unknown>;
    expect(evidence.verdict_source).toBe('llm');
  });
});

describe('sweepWorkspaceDrift — LLM verdicts enabled, SUPPRESS', () => {
  it('substrate NOT called; suppressed:1; no existing-row touched', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    mockGetInsightByIdentity.mockResolvedValue(null);
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SUPPRESS', reasoning: 'noise' },
      degraded: false,
      source: 'llm',
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.suppressed).toBe(1);
    expect(result.created).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(result.scanned).toBe(1);
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
  });

  it('SUPPRESS on a project with an existing OPEN insight does NOT touch the row', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    // Existing OPEN row with a DIFFERENT hash so probe doesn't short-circuit.
    mockGetInsightByIdentity.mockResolvedValue({
      id: 'existing-insight',
      state: 'open',
      inputHash: 'completely-different-hash',
    });
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SUPPRESS', reasoning: 'not worth it' },
      degraded: false,
      source: 'llm',
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.suppressed).toBe(1);
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
    // No resolveInsight import / call in sweep — the existing row remains
    // untouched simply by virtue of no write being issued.
  });

  it('multiple SUPPRESS in one tick accumulates correctly', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    mockGetInsightByIdentity.mockResolvedValue(null);
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SUPPRESS', reasoning: 'noise' },
      degraded: false,
      source: 'llm',
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        projectRow({ id: 'p-1' }),
        projectRow({ id: 'p-2' }),
        projectRow({ id: 'p-3' }),
      ],
    });

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.suppressed).toBe(3);
    expect(result.scanned).toBe(3);
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
  });
});

describe('sweepWorkspaceDrift — probe short-circuit', () => {
  it('existing OPEN insight with matching hash → generator NOT called; substrate called with deterministic', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });

    // Two-pass strategy: first sweep with probe=null lets the production
    // code compute its true inputHash; capture it from the createOrRefresh
    // call. Second sweep primes the probe with that hash so the short-circuit
    // fires.
    mockGetInsightByIdentity.mockResolvedValue(null);
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SURFACE_ACT', reasoning: 'first run' },
      degraded: false,
      source: 'llm',
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));
    await sweepWorkspaceDrift('ws-1');
    const computedHash = (
      mockCreateOrRefresh.mock.calls[0]![0] as { inputHash: string }
    ).inputHash;

    // Second sweep: probe returns existing OPEN with matching hash.
    mockClientQuery.mockReset();
    mockCreateOrRefresh.mockReset();
    mockGenerateDriftVerdict.mockReset();
    mockGetInsightByIdentity.mockReset();
    mockGetInsightByIdentity.mockResolvedValue({
      id: 'existing-row',
      state: 'open',
      inputHash: computedHash,
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: false }));

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.refreshed).toBe(1);
    expect(mockGenerateDriftVerdict).not.toHaveBeenCalled();
    expect(mockCreateOrRefresh).toHaveBeenCalledTimes(1);
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    const evidence = args.evidence as Record<string, unknown>;
    expect(evidence.verdict_source).toBe('deterministic');
  });

  it('existing OPEN insight with DIFFERENT hash → generator IS called', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    mockGetInsightByIdentity.mockResolvedValue({
      id: 'existing-row',
      state: 'open',
      inputHash: 'stale-hash-different-from-current',
    });
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SURFACE_FYI', reasoning: 'new signal' },
      degraded: false,
      source: 'llm',
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: false }));

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.refreshed).toBe(1);
    expect(mockGenerateDriftVerdict).toHaveBeenCalledTimes(1);
    const args = mockCreateOrRefresh.mock.calls[0]![0];
    expect(args.verdict.decision).toBe('SURFACE_FYI');
    expect((args.evidence as Record<string, unknown>).verdict_source).toBe('llm');
  });
});

describe('sweepWorkspaceDrift — LLM failure fallback', () => {
  it('generator returns degraded: true → substrate called with deterministic; result.degraded: true', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });
    mockGetInsightByIdentity.mockResolvedValue(null);
    // Mimic the generator's fallback path: it returns the deterministic
    // fallback verdict it was passed, with degraded: true + source: 'deterministic'.
    mockGenerateDriftVerdict.mockImplementation(async (_input: any, fallback: any) => ({
      verdict: fallback,
      degraded: true,
      source: 'deterministic',
    }));
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.degraded).toBe(true);
    expect(result.created).toBe(1);

    const args = mockCreateOrRefresh.mock.calls[0]![0];
    // Verdict reasoning comes from the deterministic builder ("Project drift: ...").
    expect(args.verdict.reasoning).toMatch(/^Project drift:/);
    const evidence = args.evidence as Record<string, unknown>;
    expect(evidence.verdict_source).toBe('deterministic');
  });
});

describe('sweepWorkspaceDrift — mixed tick', () => {
  it('LLM-off project + LLM SURFACE_ACT + LLM fallback → degraded:true, two substrate calls', async () => {
    // The settings read is per-tick (not per-project). To get a "mixed"
    // tick we set LLM on, then drive the three projects through different
    // generator outcomes (SURFACE_ACT, SUPPRESS-style skip via separate
    // test) — but per the plan's intent, "LLM off" means workspace-level off.
    // Reinterpret as: LLM enabled, project A → LLM verdict, project B →
    // probe-hit deterministic (no LLM call), project C → LLM fallback.
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: true,
    });

    // We need the probe-hit case to short-circuit on project B. Strategy:
    // first sweep to discover B's deterministic hash, then second sweep
    // with the probe primed for B only.
    mockGetInsightByIdentity.mockResolvedValue(null);
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SURFACE_ACT', reasoning: 'discovery-only' },
      degraded: false,
      source: 'llm',
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-B' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));
    await sweepWorkspaceDrift('ws-1');
    const hashB = (mockCreateOrRefresh.mock.calls[0]![0] as { inputHash: string }).inputHash;

    // Real run: 3 projects.
    mockClientQuery.mockReset();
    mockCreateOrRefresh.mockReset();
    mockGenerateDriftVerdict.mockReset();
    mockGetInsightByIdentity.mockReset();
    mockGetInsightByIdentity.mockImplementation(async (_ws: string, subjectId: string) => {
      if (subjectId === 'p-B') {
        return { id: 'existing-B', state: 'open' as const, inputHash: hashB };
      }
      return null;
    });
    mockGenerateDriftVerdict
      .mockResolvedValueOnce({
        verdict: { decision: 'SURFACE_ACT', reasoning: 'real LLM' },
        degraded: false,
        source: 'llm',
      })
      .mockImplementationOnce(async (_input: any, fallback: any) => ({
        verdict: fallback,
        degraded: true,
        source: 'deterministic',
      }));
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        projectRow({ id: 'p-A' }), // LLM SURFACE_ACT
        projectRow({ id: 'p-B' }), // probe hit (no generator call)
        projectRow({ id: 'p-C' }), // LLM fallback
      ],
    });
    mockCreateOrRefresh
      .mockResolvedValueOnce(createResult({ didCreate: true })) // A
      .mockResolvedValueOnce(createResult({ didCreate: false })) // B refresh
      .mockResolvedValueOnce(createResult({ didCreate: true })); // C

    const result = await sweepWorkspaceDrift('ws-1');

    expect(result.degraded).toBe(true);
    expect(result.suppressed).toBe(0);
    expect(mockGenerateDriftVerdict).toHaveBeenCalledTimes(2); // A + C (B probe-hit)
    expect(mockCreateOrRefresh).toHaveBeenCalledTimes(3);
  });
});

describe('sweepWorkspaceDrift — sweep_run_id consistency', () => {
  it('same UUID stamped into every evidence blob within one tick', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: false,
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [
        projectRow({ id: 'p-1' }),
        projectRow({ id: 'p-2' }),
        projectRow({ id: 'p-3' }),
      ],
    });
    mockCreateOrRefresh
      .mockResolvedValueOnce(createResult({ didCreate: true }))
      .mockResolvedValueOnce(createResult({ didCreate: true }))
      .mockResolvedValueOnce(createResult({ didCreate: true }));

    await sweepWorkspaceDrift('ws-1');

    const ids = mockCreateOrRefresh.mock.calls.map(
      (c) => (c[0].evidence as Record<string, unknown>).sweep_run_id
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(typeof ids[0]).toBe('string');
    expect((ids[0] as string).length).toBeGreaterThan(0);
  });

  it('different ticks produce different sweep_run_ids', async () => {
    mockGetFleetgraphSettings.mockResolvedValue({
      sweepEnabled: true,
      llmVerdictsEnabled: false,
    });
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));
    await sweepWorkspaceDrift('ws-1');
    const id1 = (mockCreateOrRefresh.mock.calls[0]![0].evidence as Record<string, unknown>)
      .sweep_run_id;

    mockClientQuery.mockReset();
    mockCreateOrRefresh.mockReset();
    mockNoClientLockSequence({
      acquired: true,
      queryRows: [projectRow({ id: 'p-1' })],
    });
    mockCreateOrRefresh.mockResolvedValueOnce(createResult({ didCreate: true }));
    await sweepWorkspaceDrift('ws-1');
    const id2 = (mockCreateOrRefresh.mock.calls[0]![0].evidence as Record<string, unknown>)
      .sweep_run_id;

    expect(id1).not.toBe(id2);
  });
});

// ─── U4: buildVerdictForProject (__testing helper) ─────────────────────

describe('__testing.buildVerdictForProject', () => {
  const deterministicVerdict = {
    decision: 'SURFACE_ACT' as const,
    reasoning: 'fallback reasoning',
  };

  it('llmVerdictsEnabled=false → deterministic, no probe, no generator', async () => {
    const out = await __testing.buildVerdictForProject({
      workspaceId: 'ws-1',
      subjectId: 'p-1',
      projectTitle: 'P',
      signals: [],
      deterministicVerdict,
      computedInputHash: 'hash-1',
      llmVerdictsEnabled: false,
      sweepRunId: 'run-1',
    });
    expect(out.source).toBe('deterministic');
    expect(out.degraded).toBe(false);
    expect(out.suppressed).toBe(false);
    expect(mockGetInsightByIdentity).not.toHaveBeenCalled();
    expect(mockGenerateDriftVerdict).not.toHaveBeenCalled();
  });

  it('probe matches → deterministic, no generator', async () => {
    mockGetInsightByIdentity.mockResolvedValue({
      id: 'x',
      state: 'open',
      inputHash: 'hash-1',
    });
    const out = await __testing.buildVerdictForProject({
      workspaceId: 'ws-1',
      subjectId: 'p-1',
      projectTitle: 'P',
      signals: [],
      deterministicVerdict,
      computedInputHash: 'hash-1',
      llmVerdictsEnabled: true,
      sweepRunId: 'run-1',
    });
    expect(out.source).toBe('deterministic');
    expect(mockGenerateDriftVerdict).not.toHaveBeenCalled();
  });

  it('probe hash mismatch → generator called', async () => {
    mockGetInsightByIdentity.mockResolvedValue({
      id: 'x',
      state: 'open',
      inputHash: 'different-hash',
    });
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SURFACE_FYI', reasoning: 'from LLM' },
      degraded: false,
      source: 'llm',
    });
    const out = await __testing.buildVerdictForProject({
      workspaceId: 'ws-1',
      subjectId: 'p-1',
      projectTitle: 'P',
      signals: [],
      deterministicVerdict,
      computedInputHash: 'hash-1',
      llmVerdictsEnabled: true,
      sweepRunId: 'run-1',
    });
    expect(out.source).toBe('llm');
    expect(out.suppressed).toBe(false);
    expect(mockGenerateDriftVerdict).toHaveBeenCalledTimes(1);
  });

  it('generator returns SUPPRESS → suppressed:true', async () => {
    mockGetInsightByIdentity.mockResolvedValue(null);
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SUPPRESS', reasoning: 'noise' },
      degraded: false,
      source: 'llm',
    });
    const out = await __testing.buildVerdictForProject({
      workspaceId: 'ws-1',
      subjectId: 'p-1',
      projectTitle: 'P',
      signals: [],
      deterministicVerdict,
      computedInputHash: 'hash-1',
      llmVerdictsEnabled: true,
      sweepRunId: 'run-1',
    });
    expect(out.suppressed).toBe(true);
    expect(out.verdict.decision).toBe('SUPPRESS');
  });

  it('probe returns resolved (non-open) row → generator IS called', async () => {
    mockGetInsightByIdentity.mockResolvedValue({
      id: 'x',
      state: 'resolved',
      inputHash: 'hash-1', // even though matching, state is not open
    });
    mockGenerateDriftVerdict.mockResolvedValue({
      verdict: { decision: 'SURFACE_ACT', reasoning: 're-detected' },
      degraded: false,
      source: 'llm',
    });
    const out = await __testing.buildVerdictForProject({
      workspaceId: 'ws-1',
      subjectId: 'p-1',
      projectTitle: 'P',
      signals: [],
      deterministicVerdict,
      computedInputHash: 'hash-1',
      llmVerdictsEnabled: true,
      sweepRunId: 'run-1',
    });
    expect(out.source).toBe('llm');
    expect(mockGenerateDriftVerdict).toHaveBeenCalledTimes(1);
  });
});
