/**
 * Unit tests for scheduler/index.ts. Mocked-pool style (mirrors
 * fleetgraph/insight.test.ts): `pool.query` is mocked to return the workspace
 * list, `pool.connect()` returns a fake client whose `query` we drive with
 * `mockResolvedValueOnce` calls in the order the production code issues them.
 *
 * `node-cron` is mocked so `cron.schedule` is observable without actually
 * registering a real timer in the test process.
 *
 * `sweepWorkspaceDrift` is mocked so the tick tests don't try to do real
 * work — we just assert which workspaces it was called with and how the
 * scheduler reacts to its return values / throws.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock setup ─────────────────────────────────────────────────────────

const {
  mockPoolQuery,
  mockClientQuery,
  mockRelease,
  mockPoolConnect,
  mockCronSchedule,
  mockTaskStop,
  mockSweepWorkspaceDrift,
  mockSweepWorkspaceLockKeyParams,
} = vi.hoisted(() => {
  const mockTaskStop = vi.fn();
  // Explicit signature so the .mock.calls tuple is typed [string, fn, ...].
  const mockCronSchedule = vi.fn<
    (expression: string, callback: () => void, options?: unknown) => { stop: () => void }
  >(() => ({ stop: mockTaskStop }));
  return {
    mockPoolQuery: vi.fn(),
    mockClientQuery: vi.fn(),
    mockRelease: vi.fn(),
    mockPoolConnect: vi.fn(),
    mockCronSchedule,
    mockTaskStop,
    mockSweepWorkspaceDrift: vi.fn(),
    mockSweepWorkspaceLockKeyParams: vi.fn(
      (workspaceId: string) => `sweep:${workspaceId}`
    ),
  };
});

vi.mock('../db/client.js', () => ({
  pool: {
    query: mockPoolQuery,
    connect: mockPoolConnect,
  },
}));

vi.mock('../services/fleetgraph/sweep.js', () => ({
  sweepWorkspaceDrift: mockSweepWorkspaceDrift,
  sweepWorkspaceLockKeyParams: mockSweepWorkspaceLockKeyParams,
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: mockCronSchedule,
  },
  schedule: mockCronSchedule,
}));

import {
  startScheduler,
  stopScheduler,
  runFleetgraphSweepTick,
  runFleetgraphSweepTickOnce,
  SWEEP_CRON_SCHEDULE,
} from './index.js';

// ─── Helpers ────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockPoolConnect.mockReset();
  mockCronSchedule.mockReset();
  mockTaskStop.mockReset();
  mockSweepWorkspaceDrift.mockReset();
  mockCronSchedule.mockImplementation(() => ({ stop: mockTaskStop }));
  mockSweepWorkspaceLockKeyParams.mockImplementation(
    (workspaceId: string) => `sweep:${workspaceId}`
  );
  mockPoolConnect.mockImplementation(async () => ({
    query: mockClientQuery,
    release: mockRelease,
  }));
  // Silence the console noise emitted by the no-throw policy.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopScheduler();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/**
 * Build a per-workspace tick mock sequence on `mockClientQuery`. Order
 * matches `tickOneWorkspace`: BEGIN, SET LOCAL, pg_try_advisory_xact_lock,
 * then either ROLLBACK (lock miss) or COMMIT (lock hit). The
 * `sweepWorkspaceDrift` mock fires on the lock-hit branch and is not
 * sequenced via mockClientQuery.
 */
function mockTickWorkspaceQueries(opts: { acquired: boolean }): void {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL
    .mockResolvedValueOnce({
      rows: [{ acquired: opts.acquired }],
      rowCount: 1,
    }); // pg_try_advisory_xact_lock

  if (opts.acquired) {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
  } else {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
  }
}

// ─── startScheduler / stopScheduler ─────────────────────────────────────

describe('startScheduler', () => {
  it('does NOT register cron when FLEETGRAPH_SWEEP_ENABLED is unset', () => {
    vi.stubEnv('FLEETGRAPH_SWEEP_ENABLED', '');
    startScheduler();
    expect(mockCronSchedule).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("does NOT register cron when FLEETGRAPH_SWEEP_ENABLED is 'false'", () => {
    vi.stubEnv('FLEETGRAPH_SWEEP_ENABLED', 'false');
    startScheduler();
    expect(mockCronSchedule).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("registers cron with SWEEP_CRON_SCHEDULE when env is 'true'", () => {
    vi.stubEnv('FLEETGRAPH_SWEEP_ENABLED', 'true');
    startScheduler();
    expect(mockCronSchedule).toHaveBeenCalledTimes(1);
    expect(mockCronSchedule.mock.calls[0]?.[0]).toBe(SWEEP_CRON_SCHEDULE);
    // Sanity — the every-4-minutes expression.
    expect(SWEEP_CRON_SCHEDULE).toBe('*/4 * * * *');
    // Second arg is the callback function.
    expect(typeof mockCronSchedule.mock.calls[0]?.[1]).toBe('function');
  });

  it('is idempotent: a second start while running does not double-register', () => {
    vi.stubEnv('FLEETGRAPH_SWEEP_ENABLED', 'true');
    startScheduler();
    startScheduler();
    expect(mockCronSchedule).toHaveBeenCalledTimes(1);
  });
});

describe('stopScheduler', () => {
  it('stops the registered task after startScheduler()', () => {
    vi.stubEnv('FLEETGRAPH_SWEEP_ENABLED', 'true');
    startScheduler();
    stopScheduler();
    expect(mockTaskStop).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when called without an active task', () => {
    // No startScheduler() — nothing registered.
    expect(() => stopScheduler()).not.toThrow();
    expect(mockTaskStop).not.toHaveBeenCalled();
  });

  it('is idempotent when called twice', () => {
    vi.stubEnv('FLEETGRAPH_SWEEP_ENABLED', 'true');
    startScheduler();
    stopScheduler();
    stopScheduler();
    expect(mockTaskStop).toHaveBeenCalledTimes(1);
  });
});

// ─── runFleetgraphSweepTick ─────────────────────────────────────────────

describe('runFleetgraphSweepTick', () => {
  it('runs one SELECT and no lock attempts when no workspaces have the toggle on', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await runFleetgraphSweepTick();

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockPoolQuery.mock.calls[0] ?? [];
    expect(typeof sql).toBe('string');
    expect(sql as string).toContain('FROM workspaces');
    expect(sql as string).toContain("sweep_enabled");
    expect(mockPoolConnect).not.toHaveBeenCalled();
    expect(mockSweepWorkspaceDrift).not.toHaveBeenCalled();
  });

  it('calls sweepWorkspaceDrift({client}) for each workspace when locks are acquired', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }],
      rowCount: 3,
    });
    mockTickWorkspaceQueries({ acquired: true });
    mockTickWorkspaceQueries({ acquired: true });
    mockTickWorkspaceQueries({ acquired: true });
    mockSweepWorkspaceDrift.mockResolvedValue({
      workspaceId: 'ws-x',
      scanned: 0,
      created: 0,
      refreshed: 0,
      skipped: 0,
    });

    await runFleetgraphSweepTick();

    expect(mockSweepWorkspaceDrift).toHaveBeenCalledTimes(3);
    const workspaceIdsCalled = mockSweepWorkspaceDrift.mock.calls.map(
      (c) => c[0] as string
    );
    expect(workspaceIdsCalled).toEqual(['ws-1', 'ws-2', 'ws-3']);
    // Each call should receive { client } (the with-client path).
    for (const call of mockSweepWorkspaceDrift.mock.calls) {
      const opts = call[1] as { client: unknown };
      expect(opts).toBeDefined();
      expect(opts.client).toBeDefined();
    }
    // Three connect/release pairs.
    expect(mockPoolConnect).toHaveBeenCalledTimes(3);
    expect(mockRelease).toHaveBeenCalledTimes(3);
  });

  it('skips workspaces whose advisory lock is busy and still runs the others', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }],
      rowCount: 3,
    });
    // ws-1 acquires, ws-2 busy, ws-3 acquires
    mockTickWorkspaceQueries({ acquired: true });
    mockTickWorkspaceQueries({ acquired: false });
    mockTickWorkspaceQueries({ acquired: true });
    mockSweepWorkspaceDrift.mockResolvedValue({
      workspaceId: 'ws-x',
      scanned: 0,
      created: 0,
      refreshed: 0,
      skipped: 0,
    });

    await runFleetgraphSweepTick();

    const calledIds = mockSweepWorkspaceDrift.mock.calls.map(
      (c) => c[0] as string
    );
    expect(calledIds).toEqual(['ws-1', 'ws-3']);
    expect(mockSweepWorkspaceDrift).not.toHaveBeenCalledWith(
      'ws-2',
      expect.anything()
    );
    expect(mockRelease).toHaveBeenCalledTimes(3);
  });

  it('continues processing other workspaces when sweepWorkspaceDrift throws for one', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }],
      rowCount: 3,
    });
    mockTickWorkspaceQueries({ acquired: true });
    mockTickWorkspaceQueries({ acquired: true });
    mockTickWorkspaceQueries({ acquired: true });
    mockSweepWorkspaceDrift
      .mockResolvedValueOnce({
        workspaceId: 'ws-1',
        scanned: 1,
        created: 0,
        refreshed: 0,
        skipped: 1,
      })
      .mockRejectedValueOnce(new Error('boom ws-2'))
      .mockResolvedValueOnce({
        workspaceId: 'ws-3',
        scanned: 0,
        created: 0,
        refreshed: 0,
        skipped: 0,
      });

    // Must not re-throw.
    await expect(runFleetgraphSweepTick()).resolves.toBeUndefined();

    expect(mockSweepWorkspaceDrift).toHaveBeenCalledTimes(3);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls;
    // At least one of the error logs mentions ws-2.
    const hasWs2Log = errorCalls.some((args) =>
      args.some(
        (a) => typeof a === 'string' && a.includes('ws-2')
      )
    );
    expect(hasWs2Log).toBe(true);
    // All three workspaces got connect+release pairs.
    expect(mockRelease).toHaveBeenCalledTimes(3);
  });

  it('does not re-throw when the workspace SELECT itself fails', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(runFleetgraphSweepTick()).resolves.toBeUndefined();
    expect(mockPoolConnect).not.toHaveBeenCalled();
    expect(mockSweepWorkspaceDrift).not.toHaveBeenCalled();
  });
});

describe('runFleetgraphSweepTickOnce', () => {
  it('is an alias for runFleetgraphSweepTick', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(runFleetgraphSweepTickOnce()).resolves.toBeUndefined();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
