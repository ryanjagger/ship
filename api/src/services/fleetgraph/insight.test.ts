/**
 * Unit tests for insight.ts. Mocked-pool style (mirrors fleet-service.test.ts):
 * `pool.connect()` returns a fake client whose `query` we drive with
 * `mockResolvedValueOnce` calls in the order the production code issues them.
 * The point is to assert SQL SHAPE, ARGUMENT ORDER, and BRANCH SELECTION —
 * NOT to run real SQL. Real Postgres exercises live in insight.concurrency.test.ts (U6).
 *
 * Each branch of the decision matrix gets one test (T1–T9). T10–T14 cover
 * the transactional discipline (subject probe, rollback, statement_timeout
 * ordering). T15–T16 are invariant assertions on the return shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  InsightProperties,
  InsightSeverity,
  InsightVerdict,
} from '@ship/shared';

// ─── Mock setup ─────────────────────────────────────────────────────────
// `pool.connect()` returns a fake PoolClient. The same `query` mock is also
// reused for `pool.query` (used by getInsightInternal's post-write fetch).
// vi.hoisted() declares the mocks alongside the vi.mock() factory so the
// hoisting order is correct (vi.mock factories run before top-level code).
const { mockClientQuery, mockRelease, mockPoolQuery } = vi.hoisted(() => ({
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockPoolQuery: vi.fn(),
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

import { createOrRefreshInsight, type CreateOrRefreshInsightArgs } from './insight.js';

// ─── Helpers ────────────────────────────────────────────────────────────

const NOW = '2026-05-27T10:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockPoolQuery.mockReset();
});

function args(overrides: Partial<CreateOrRefreshInsightArgs> = {}): CreateOrRefreshInsightArgs {
  return {
    workspaceId: 'ws-1',
    subjectId: 'subj-1',
    subjectEntityType: 'project',
    kind: 'project_drift',
    severity: 'fyi',
    summary: 'Project X is drifting',
    recommendedAction: 'Review the plan',
    evidence: { signals: [{ type: 'idle', reason: 'idle 9 days' }] },
    verdict: { decision: 'SURFACE_FYI', reasoning: 'mild drift' } as InsightVerdict,
    inputHash: 'hash-v1',
    accountableOwnerId: null,
    ...overrides,
  };
}

function existingInsight(props: Partial<InsightProperties> = {}): InsightProperties {
  return {
    state: 'open',
    kind: 'project_drift',
    severity: 'fyi',
    subject_id: 'subj-1',
    subject_entity_type: 'project',
    summary: 'old summary',
    recommended_action: 'old action',
    evidence: { signals: [] },
    verdict: { decision: 'SURFACE_FYI', reasoning: 'old' },
    input_hash: 'hash-v1',
    accountable_owner_id: null,
    first_seen_at: '2026-05-20T00:00:00.000Z',
    last_seen_at: '2026-05-20T00:00:00.000Z',
    last_changed_at: '2026-05-20T00:00:00.000Z',
    occurrence_count: 1,
    resolved_at: null,
    resolved_reason: null,
    snoozed_until: null,
    dismissed_at: null,
    dismissed_by: null,
    ...props,
  };
}

/**
 * Build the canonical "create-branch" mock sequence. Order matches the
 * production code: BEGIN, SET LOCAL, pg_advisory_xact_lock, SELECT existing
 * (empty), SELECT subject FOR SHARE (hit), INSERT documents, INSERT
 * document_associations, COMMIT, then the post-write getInsightInternal
 * SELECT on `pool.query`.
 */
function mockCreateSequence(opts: { subjectFound: boolean; subjectTitle?: string }): void {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // advisory_xact_lock
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT existing → empty

  if (!opts.subjectFound) {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // subject FOR SHARE → miss
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    return;
  }

  const subjectTitle = opts.subjectTitle ?? 'Acme Migration';
  mockClientQuery
    .mockResolvedValueOnce({
      rows: [{ title: subjectTitle, document_type: 'project' }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 'insight-1',
          workspace_id: 'ws-1',
          title: `Project drift: ${subjectTitle}`,
          created_at: NOW,
        },
      ],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT associations
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

  // The post-write getInsightInternal pool.query fetch
  mockPoolQuery.mockResolvedValueOnce({
    rows: [
      {
        id: 'insight-1',
        workspace_id: 'ws-1',
        title: `Project drift: ${subjectTitle}`,
        created_at: NOW,
        ins: { /* not asserted on create — we return InsightProperties built in-process */ },
        s_id: 'subj-1',
        s_title: subjectTitle,
        s_type: 'project',
      },
    ],
    rowCount: 1,
  });
}

/**
 * Build the "refresh-branch" mock sequence. BEGIN, SET LOCAL,
 * advisory_xact_lock, SELECT existing (hit with given props), UPDATE
 * documents (one or two depending on branch), COMMIT, post-write SELECT.
 */
function mockRefreshSequence(opts: {
  existing: InsightProperties;
  insightId?: string;
}): void {
  const insightId = opts.insightId ?? 'insight-1';
  mockClientQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // advisory_xact_lock
    .mockResolvedValueOnce({
      rows: [{ id: insightId, ins: opts.existing }],
      rowCount: 1,
    }) // SELECT existing → hit
    .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

  // Post-write getInsightInternal fetch
  mockPoolQuery.mockResolvedValueOnce({
    rows: [
      {
        id: insightId,
        workspace_id: 'ws-1',
        title: 'Project drift: Acme Migration',
        created_at: '2026-05-20T00:00:00.000Z',
        ins: opts.existing, // best-effort; the real post-write read would reflect changes
        s_id: 'subj-1',
        s_title: 'Acme Migration',
        s_type: 'project',
      },
    ],
    rowCount: 1,
  });
}

// ─── Decision matrix tests (T1–T9) ──────────────────────────────────────

describe('createOrRefreshInsight — decision matrix', () => {
  // T1. First detection: empty SELECT → subject FOR SHARE hit → INSERT + association → COMMIT.
  it('T1: first detection inserts a fresh OPEN row + discusses association', async () => {
    mockCreateSequence({ subjectFound: true });
    const result = await createOrRefreshInsight(args());

    expect(result.didCreate).toBe(true);
    expect(result.didEscalate).toBe(false);
    expect(result.insight).not.toBeNull();

    // SQL sequence ordering
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/SET LOCAL statement_timeout = '5s'/);
    expect(calls[2]).toMatch(/pg_advisory_xact_lock\(hashtextextended/);
    expect(calls[3]).toMatch(/SELECT id, properties->'fleetgraph_insight'/);
    expect(calls[4]).toMatch(/FOR SHARE/);
    expect(calls[5]).toMatch(/INSERT INTO documents/);
    expect(calls[6]).toMatch(/INSERT INTO document_associations[\s\S]*'discusses'/);
    expect(calls[7]).toBe('COMMIT');

    // INSERT params: workspace_id, title, properties (JSON string)
    const insertParams = mockClientQuery.mock.calls[5]![1] as unknown[];
    expect(insertParams[0]).toBe('ws-1');
    expect(insertParams[1]).toBe('Project drift: Acme Migration');
    const props = JSON.parse(insertParams[2] as string);
    expect(props.fleetgraph_insight.state).toBe('open');
    expect(props.fleetgraph_insight.severity).toBe('fyi');
    expect(props.fleetgraph_insight.subject_id).toBe('subj-1');
    expect(props.fleetgraph_insight.input_hash).toBe('hash-v1');
    expect(props.fleetgraph_insight.occurrence_count).toBe(1);
    expect(props.fleetgraph_insight.first_seen_at).toBe(NOW);
    expect(props.fleetgraph_insight.last_seen_at).toBe(NOW);
    expect(props.fleetgraph_insight.last_changed_at).toBe(NOW);
    expect(props.fleetgraph_insight.snoozed_until).toBeNull(); // reserved
  });

  // T2. Re-detection same hash: bump last_seen_at + occurrence_count only.
  it('T2: same-hash re-detection bumps last_seen + count only', async () => {
    mockRefreshSequence({ existing: existingInsight({ input_hash: 'hash-v1' }) });
    const result = await createOrRefreshInsight(args({ inputHash: 'hash-v1' }));

    expect(result.didCreate).toBe(false);
    expect(result.didEscalate).toBe(false);

    const updateSql = String(mockClientQuery.mock.calls[4]![0]);
    expect(updateSql).toMatch(/last_seen_at/);
    expect(updateSql).toMatch(/occurrence_count/);
    // Critically: last_changed_at is NOT in the SQL for this branch
    expect(updateSql).not.toMatch(/last_changed_at/);
    expect(updateSql).not.toMatch(/severity/);
    expect(updateSql).not.toMatch(/summary/);
  });

  // T3. Re-detection different hash, same severity: full evidence refresh.
  it('T3: different-hash re-detection refreshes evidence + both timestamps', async () => {
    mockRefreshSequence({ existing: existingInsight({ input_hash: 'hash-v1' }) });
    const result = await createOrRefreshInsight(
      args({ inputHash: 'hash-v2', summary: 'new summary' })
    );

    expect(result.didCreate).toBe(false);
    expect(result.didEscalate).toBe(false);

    // The refresh branch UPDATEs the whole fleetgraph_insight key
    const updateSql = String(mockClientQuery.mock.calls[4]![0]);
    expect(updateSql).toMatch(/jsonb_set\(properties, '\{fleetgraph_insight\}'/);

    const newProps = JSON.parse(mockClientQuery.mock.calls[4]![1]![0]);
    expect(newProps.input_hash).toBe('hash-v2');
    expect(newProps.summary).toBe('new summary');
    expect(newProps.last_seen_at).toBe(NOW);
    expect(newProps.last_changed_at).toBe(NOW);
    expect(newProps.occurrence_count).toBe(2); // 1 → 2
    expect(newProps.state).toBe('open'); // unchanged
    expect(newProps.severity).toBe('fyi'); // unchanged
  });

  // T4. FYI→ACT escalation on open row: severity bumped, didEscalate=true.
  it('T4: FYI→ACT escalation sets didEscalate and severity=act', async () => {
    mockRefreshSequence({ existing: existingInsight({ severity: 'fyi', input_hash: 'hash-v1' }) });
    const result = await createOrRefreshInsight(args({ severity: 'act', inputHash: 'hash-v2' }));

    expect(result.didEscalate).toBe(true);
    const newProps = JSON.parse(mockClientQuery.mock.calls[4]![1]![0]);
    expect(newProps.severity).toBe('act');
    expect(newProps.state).toBe('open');
  });

  // T5. ACT→FYI de-escalation: silent, didEscalate=false.
  it('T5: ACT→FYI de-escalation is silent (didEscalate=false)', async () => {
    mockRefreshSequence({ existing: existingInsight({ severity: 'act', input_hash: 'hash-v1' }) });
    const result = await createOrRefreshInsight(args({ severity: 'fyi', inputHash: 'hash-v2' }));

    expect(result.didEscalate).toBe(false);
    const newProps = JSON.parse(mockClientQuery.mock.calls[4]![1]![0]);
    expect(newProps.severity).toBe('fyi');
  });

  // T6. Prior `resolved` row + new detection: existing SELECT excludes resolved
  //     → falls into no-row branch → fresh INSERT.
  it('T6: prior resolved row → fresh OPEN row inserted (append-only history)', async () => {
    // The SELECT filters resolved out by `state IN (open,snoozed,dismissed)`, so
    // a resolved row never surfaces. The fixture is the same as T1.
    mockCreateSequence({ subjectFound: true });
    const result = await createOrRefreshInsight(args());

    expect(result.didCreate).toBe(true);
    // Exactly one INSERT into documents
    const insertCount = mockClientQuery.mock.calls.filter((c) =>
      /INSERT INTO documents/.test(String(c[0]))
    ).length;
    expect(insertCount).toBe(1);
  });

  // T7. Prior `dismissed` + same-severity re-detection: silent refresh, state stays.
  it('T7: dismissed + same severity → silent refresh, state stays dismissed', async () => {
    mockRefreshSequence({
      existing: existingInsight({ state: 'dismissed', severity: 'fyi', input_hash: 'hash-v1' }),
    });
    const result = await createOrRefreshInsight(args({ severity: 'fyi', inputHash: 'hash-v2' }));

    expect(result.didEscalate).toBe(false);
    const newProps = JSON.parse(mockClientQuery.mock.calls[4]![1]![0]);
    expect(newProps.state).toBe('dismissed');
  });

  // T8. Prior `dismissed` FYI + FYI→ACT escalation: reopen to OPEN, didEscalate=true.
  it('T8: dismissed FYI → ACT detection flips state=open AND didEscalate=true', async () => {
    mockRefreshSequence({
      existing: existingInsight({ state: 'dismissed', severity: 'fyi', input_hash: 'hash-v1' }),
    });
    const result = await createOrRefreshInsight(args({ severity: 'act', inputHash: 'hash-v2' }));

    expect(result.didEscalate).toBe(true);
    const newProps = JSON.parse(mockClientQuery.mock.calls[4]![1]![0]);
    expect(newProps.state).toBe('open');
    expect(newProps.severity).toBe('act');
  });

  // T9. Snoozed: silent refresh, never escalate, state stays snoozed.
  it('T9: snoozed silently refreshes; didEscalate=false even on FYI→ACT', async () => {
    mockRefreshSequence({
      existing: existingInsight({ state: 'snoozed', severity: 'fyi', input_hash: 'hash-v1' }),
    });
    const result = await createOrRefreshInsight(args({ severity: 'act', inputHash: 'hash-v2' }));

    expect(result.didEscalate).toBe(false);
    const newProps = JSON.parse(mockClientQuery.mock.calls[4]![1]![0]);
    expect(newProps.state).toBe('snoozed'); // stays
    expect(newProps.severity).toBe('act'); // severity bumps; just no ping
  });
});

// ─── Transaction discipline (T10–T14) ───────────────────────────────────

describe('createOrRefreshInsight — transaction discipline', () => {
  // T10. Subject deleted between sweep decide-to-create and the create call:
  //      FOR SHARE returns empty → ROLLBACK, no INSERTs.
  it('T10: missing subject → ROLLBACK, return didCreate=false, no INSERT', async () => {
    mockCreateSequence({ subjectFound: false });
    const result = await createOrRefreshInsight(args());

    expect(result.didCreate).toBe(false);
    expect(result.insight).toBeNull();
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls).toContain('ROLLBACK');
    expect(calls.filter((s) => s.startsWith('INSERT INTO documents'))).toHaveLength(0);
  });

  // T11. document_associations INSERT rejected: ROLLBACK fires, COMMIT never called.
  it('T11: associations INSERT failure → ROLLBACK, no COMMIT', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // advisory_xact_lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT existing → empty
      .mockResolvedValueOnce({
        rows: [{ title: 'Acme', document_type: 'project' }],
        rowCount: 1,
      }) // subject FOR SHARE
      .mockResolvedValueOnce({
        rows: [{ id: 'insight-1', workspace_id: 'ws-1', title: 't', created_at: NOW }],
        rowCount: 1,
      }) // INSERT documents
      .mockRejectedValueOnce(new Error('FK violation on document_associations')) // INSERT associations FAILS
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await expect(createOrRefreshInsight(args())).rejects.toThrow(/FK violation/);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  // T12. Mid-transaction throw triggers ROLLBACK + release.
  it('T12: mid-transaction error → ROLLBACK + release fires; error rethrown', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET LOCAL
      .mockRejectedValueOnce(new Error('lock acquisition failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await expect(createOrRefreshInsight(args())).rejects.toThrow(/lock acquisition failed/);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    expect(calls).toContain('ROLLBACK');
  });

  // T13. SET LOCAL statement_timeout is set BEFORE the advisory lock.
  it('T13: statement_timeout is SET LOCAL before advisory lock', async () => {
    mockCreateSequence({ subjectFound: true });
    await createOrRefreshInsight(args());
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]).trim());
    const setLocalIdx = calls.findIndex((s) => /SET LOCAL statement_timeout/.test(s));
    const lockIdx = calls.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    expect(setLocalIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(setLocalIdx);
  });

  // T14. INSERT binds created_by as SQL NULL (not the string 'null').
  it('T14: created_by is bound as SQL NULL in the INSERT statement', async () => {
    mockCreateSequence({ subjectFound: true });
    await createOrRefreshInsight(args());
    const insertSql = String(mockClientQuery.mock.calls[5]![0]);
    expect(insertSql).toMatch(/created_by/);
    expect(insertSql).toMatch(/NULL/);
    // params: $1=workspace, $2=title, $3=properties — created_by is the
    // literal `NULL` in the SQL, NOT a $-parameter, so it's never bound.
    const insertParams = mockClientQuery.mock.calls[5]![1] as unknown[];
    expect(insertParams.length).toBe(3);
  });
});

// ─── Invariants (T15–T16) ───────────────────────────────────────────────

describe('createOrRefreshInsight — invariants', () => {
  // T15. didCreate is true exactly when a documents INSERT fires.
  it('T15: didCreate=true exactly when documents INSERT fires (create branch); false on refresh', async () => {
    mockCreateSequence({ subjectFound: true });
    const r1 = await createOrRefreshInsight(args());
    expect(r1.didCreate).toBe(true);
    expect(
      mockClientQuery.mock.calls.some((c) => /INSERT INTO documents/.test(String(c[0])))
    ).toBe(true);

    mockClientQuery.mockReset();
    mockPoolQuery.mockReset();
    mockRefreshSequence({ existing: existingInsight() });
    const r2 = await createOrRefreshInsight(args({ inputHash: 'hash-different' }));
    expect(r2.didCreate).toBe(false);
    expect(
      mockClientQuery.mock.calls.some((c) => /INSERT INTO documents/.test(String(c[0])))
    ).toBe(false);
  });

  // T16. didEscalate is true ONLY for FYI→ACT against open OR dismissed; never snoozed.
  it('T16: didEscalate fires only for FYI→ACT against open or dismissed', async () => {
    // open FYI → ACT: TRUE
    mockClientQuery.mockReset();
    mockPoolQuery.mockReset();
    mockRefreshSequence({
      existing: existingInsight({ state: 'open', severity: 'fyi', input_hash: 'h0' }),
    });
    let r = await createOrRefreshInsight(args({ severity: 'act' as InsightSeverity, inputHash: 'h1' }));
    expect(r.didEscalate).toBe(true);

    // dismissed FYI → ACT: TRUE
    mockClientQuery.mockReset();
    mockPoolQuery.mockReset();
    mockRefreshSequence({
      existing: existingInsight({ state: 'dismissed', severity: 'fyi', input_hash: 'h0' }),
    });
    r = await createOrRefreshInsight(args({ severity: 'act' as InsightSeverity, inputHash: 'h1' }));
    expect(r.didEscalate).toBe(true);

    // snoozed FYI → ACT: FALSE (snooze suppresses pings)
    mockClientQuery.mockReset();
    mockPoolQuery.mockReset();
    mockRefreshSequence({
      existing: existingInsight({ state: 'snoozed', severity: 'fyi', input_hash: 'h0' }),
    });
    r = await createOrRefreshInsight(args({ severity: 'act' as InsightSeverity, inputHash: 'h1' }));
    expect(r.didEscalate).toBe(false);

    // open ACT → FYI: FALSE (only fyi→act counts)
    mockClientQuery.mockReset();
    mockPoolQuery.mockReset();
    mockRefreshSequence({
      existing: existingInsight({ state: 'open', severity: 'act', input_hash: 'h0' }),
    });
    r = await createOrRefreshInsight(args({ severity: 'fyi', inputHash: 'h1' }));
    expect(r.didEscalate).toBe(false);
  });
});
