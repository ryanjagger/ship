/**
 * Unit tests for workspace-settings.ts. Mocked-pool style (mirrors the
 * pattern in api/src/services/fleetgraph/insight.test.ts lines 14-48):
 * `pool.query` is a `vi.fn()` driven with `mockResolvedValueOnce`. The point
 * is to assert SQL SHAPE + ARGUMENT ORDER, not to exercise real Postgres.
 * Real-DB coverage lives in U2/U3 concurrency tests (not in this unit).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock setup ─────────────────────────────────────────────────────────
// vi.hoisted() so the mock fn exists before vi.mock()'s factory captures it.
const { mockPoolQuery } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

import {
  getWorkspaceSettings,
  getFleetgraphSettings,
  setFleetgraphSweepEnabled,
} from './workspace-settings.js';

beforeEach(() => {
  mockPoolQuery.mockReset();
});

// ─── getWorkspaceSettings ───────────────────────────────────────────────

describe('getWorkspaceSettings', () => {
  it('returns {} for a fresh workspace with default settings', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: {} }],
    });

    const result = await getWorkspaceSettings('ws-1');

    expect(result).toEqual({});
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    expect(sql).toMatch(/SELECT settings FROM workspaces WHERE id = \$1/);
    expect(params).toEqual(['ws-1']);
  });

  it('returns {} for a non-existent workspace (rowCount=0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await getWorkspaceSettings('ws-missing');

    expect(result).toEqual({});
  });

  it('returns the full blob when settings has multiple keys', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: true }, foo: 'bar' } }],
    });

    const result = await getWorkspaceSettings('ws-1');

    expect(result).toEqual({
      fleetgraph: { sweep_enabled: true },
      foo: 'bar',
    });
  });

  it('treats a NULL settings column as {} (defensive)', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: null }],
    });

    const result = await getWorkspaceSettings('ws-1');

    expect(result).toEqual({});
  });
});

// ─── getFleetgraphSettings ──────────────────────────────────────────────

describe('getFleetgraphSettings', () => {
  it('returns { sweepEnabled: false } for a fresh workspace', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: {} }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false });
  });

  it('returns { sweepEnabled: true } when the key is set to true', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: true } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: true });
  });

  it('returns { sweepEnabled: false } when the key is explicitly false', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: false } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false });
  });

  it('returns { sweepEnabled: false } when fleetgraph namespace is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { notifications: { email: true } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false });
  });

  it('returns default { sweepEnabled: false } for a non-existent workspace', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await getFleetgraphSettings('ws-missing');

    expect(result).toEqual({ sweepEnabled: false });
  });

  it('coerces non-true truthy values (e.g. "true" string) to false', async () => {
    // Defensive: only the literal boolean `true` flips sweepEnabled.
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: 'true' } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false });
  });
});

// ─── setFleetgraphSweepEnabled ──────────────────────────────────────────

describe('setFleetgraphSweepEnabled', () => {
  it('issues a single-statement jsonb_set UPDATE with the deep path', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await setFleetgraphSweepEnabled('ws-1', true);

    expect(result).toEqual({ sweepEnabled: true });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    // SQL shape: single statement, jsonb_set on COALESCE'd settings, deep path,
    // $1::jsonb param, create_missing = true.
    expect(sql).toMatch(/UPDATE workspaces/);
    expect(sql).toMatch(/jsonb_set\(/);
    expect(sql).toMatch(/COALESCE\(settings,\s*'\{\}'::jsonb\)/);
    expect(sql).toMatch(/\{fleetgraph,sweep_enabled\}/);
    expect(sql).toMatch(/\$1::jsonb/);
    expect(sql).toMatch(/true\s*\)/); // create_missing
    expect(sql).toMatch(/WHERE id = \$2/);

    // Params: $1 is the JSON-encoded boolean literal 'true', $2 is the ws id.
    expect(params).toEqual(['true', 'ws-1']);
  });

  it('encodes false as the JSON literal "false"', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await setFleetgraphSweepEnabled('ws-1', false);

    expect(result).toEqual({ sweepEnabled: false });
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(params).toEqual(['false', 'ws-1']);
  });

  it('preserves unrelated top-level keys via the deep-path jsonb_set shape', async () => {
    // We cannot exercise actual jsonb_set semantics in a mocked test, but we
    // can assert the SQL shape guarantees preservation: jsonb_set only
    // touches the named path, and COALESCE keeps a NULL settings safe.
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await setFleetgraphSweepEnabled('ws-1', true);

    const [sql] = mockPoolQuery.mock.calls[0]!;
    // The path is the deep nested one, not a top-level replace.
    expect(sql).toMatch(/'\{fleetgraph,sweep_enabled\}'/);
    // No `settings = $1` pattern (that would clobber unrelated keys).
    expect(sql).not.toMatch(/SET settings = \$1\s/);
    // COALESCE handles the NULL-settings edge defensively.
    expect(sql).toMatch(/COALESCE\(settings,\s*'\{\}'::jsonb\)/);
  });

  it('is idempotent on double-call — both writes succeed without error', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const first = await setFleetgraphSweepEnabled('ws-1', true);
    const second = await setFleetgraphSweepEnabled('ws-1', true);

    expect(first).toEqual({ sweepEnabled: true });
    expect(second).toEqual({ sweepEnabled: true });
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('returns the default { sweepEnabled: <value> } when the workspace does not exist (UPDATE affects 0 rows)', async () => {
    // Chosen behavior: lenient — do not throw on missing workspace. The
    // UPDATE simply affects zero rows and the function returns the value
    // the caller asked to set. Auth/visibility gating in the calling
    // endpoint is responsible for the not-found signal.
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await setFleetgraphSweepEnabled('ws-missing', true);

    expect(result).toEqual({ sweepEnabled: true });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
