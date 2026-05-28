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
  setFleetgraphLlmVerdictsEnabled,
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
  it('returns both flags false for a fresh workspace', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: {} }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
  });

  it('returns { sweepEnabled: true } when the key is set to true', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: true } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: true, llmVerdictsEnabled: false });
  });

  it('returns { sweepEnabled: false } when the key is explicitly false', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: false } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
  });

  it('returns both flags false when fleetgraph namespace is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { notifications: { email: true } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
  });

  it('returns default flags for a non-existent workspace', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await getFleetgraphSettings('ws-missing');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
  });

  it('coerces non-true truthy values (e.g. "true" string) to false', async () => {
    // Defensive: only the literal boolean `true` flips sweepEnabled.
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: 'true' } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
  });

  it('returns both flags true when both keys are set to true', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          settings: {
            fleetgraph: { sweep_enabled: true, llm_verdicts_enabled: true },
          },
        },
      ],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: true, llmVerdictsEnabled: true });
  });

  it('returns llmVerdictsEnabled: false when only sweep_enabled is set', async () => {
    // Independent keys: the missing one must default to false even when the
    // sibling is true.
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { sweep_enabled: true } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: true, llmVerdictsEnabled: false });
  });

  it('returns llmVerdictsEnabled: true when only llm_verdicts_enabled is set', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { llm_verdicts_enabled: true } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: true });
  });

  it('coerces a non-true value on llm_verdicts_enabled (string "true") to false', async () => {
    // Strict `=== true`: stored string "true" returns false. Mirrors the
    // sweep_enabled defensive read.
    mockPoolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ settings: { fleetgraph: { llm_verdicts_enabled: 'true' } } }],
    });

    const result = await getFleetgraphSettings('ws-1');

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
  });
});

// ─── setFleetgraphSweepEnabled ──────────────────────────────────────────

describe('setFleetgraphSweepEnabled', () => {
  it('issues a single-statement jsonb_set UPDATE with the deep path', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await setFleetgraphSweepEnabled('ws-1', true);

    // Lean return: just-set key reflects the new value; sibling key surfaces
    // as default-false from this writer's perspective. The PATCH route
    // re-reads to surface the truly-combined state.
    expect(result).toEqual({ sweepEnabled: true, llmVerdictsEnabled: false });
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

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
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

    expect(first).toEqual({ sweepEnabled: true, llmVerdictsEnabled: false });
    expect(second).toEqual({ sweepEnabled: true, llmVerdictsEnabled: false });
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('returns the lean typed value when the workspace does not exist (UPDATE affects 0 rows)', async () => {
    // Chosen behavior: lenient — do not throw on missing workspace. The
    // UPDATE simply affects zero rows and the function returns the value
    // the caller asked to set. Auth/visibility gating in the calling
    // endpoint is responsible for the not-found signal.
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await setFleetgraphSweepEnabled('ws-missing', true);

    expect(result).toEqual({ sweepEnabled: true, llmVerdictsEnabled: false });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

// ─── setFleetgraphLlmVerdictsEnabled ────────────────────────────────────

describe('setFleetgraphLlmVerdictsEnabled', () => {
  it('issues a single-statement jsonb_set UPDATE with the deep path', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await setFleetgraphLlmVerdictsEnabled('ws-1', true);

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: true });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockPoolQuery.mock.calls[0]!;
    // SQL shape mirrors setFleetgraphSweepEnabled exactly, only the path
    // changes. Single statement, jsonb_set, COALESCE, $1::jsonb,
    // create_missing = true, WHERE id = $2.
    expect(sql).toMatch(/UPDATE workspaces/);
    expect(sql).toMatch(/jsonb_set\(/);
    expect(sql).toMatch(/COALESCE\(settings,\s*'\{\}'::jsonb\)/);
    expect(sql).toMatch(/\{fleetgraph,llm_verdicts_enabled\}/);
    expect(sql).toMatch(/\$1::jsonb/);
    expect(sql).toMatch(/true\s*\)/); // create_missing
    expect(sql).toMatch(/WHERE id = \$2/);

    expect(params).toEqual(['true', 'ws-1']);
  });

  it('encodes false as the JSON literal "false"', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await setFleetgraphLlmVerdictsEnabled('ws-1', false);

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: false });
    const [, params] = mockPoolQuery.mock.calls[0]!;
    expect(params).toEqual(['false', 'ws-1']);
  });

  it('preserves the OTHER key (sweep_enabled) via the deep-path jsonb_set shape', async () => {
    // The deep-path jsonb_set with create_missing only touches the named
    // path. SQL-shape assertion guarantees sibling keys (e.g. an already-set
    // sweep_enabled) are NOT clobbered by this write. Real Postgres
    // semantics are covered by the U6 concurrency tests.
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await setFleetgraphLlmVerdictsEnabled('ws-1', true);

    const [sql] = mockPoolQuery.mock.calls[0]!;
    // The path is the deep nested LLM key, not a parent-level replace
    // (which would clobber sweep_enabled).
    expect(sql).toMatch(/'\{fleetgraph,llm_verdicts_enabled\}'/);
    // No path of the form `{fleetgraph}` alone (that would replace the
    // whole namespace and drop the sibling).
    expect(sql).not.toMatch(/'\{fleetgraph\}'/);
    // No `settings = $1` pattern.
    expect(sql).not.toMatch(/SET settings = \$1\s/);
    // COALESCE handles the NULL-settings edge defensively.
    expect(sql).toMatch(/COALESCE\(settings,\s*'\{\}'::jsonb\)/);
  });

  it('returns the lean typed value when the workspace does not exist (UPDATE affects 0 rows)', async () => {
    // Lenient — mirrors setFleetgraphSweepEnabled's zero-row behavior.
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await setFleetgraphLlmVerdictsEnabled('ws-missing', true);

    expect(result).toEqual({ sweepEnabled: false, llmVerdictsEnabled: true });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
