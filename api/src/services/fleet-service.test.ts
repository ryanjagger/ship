import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShipApiError } from '@ryanjagger/ship-sdk';

// Mock the DB pool (the properties.fleet cache WRITE stays internal), the AI
// provider, and the Fleet API client — gatherSignals reads travel /api/v1
// through withFleetClient (issue #95), so the tests drive a fake ShipClient.
vi.mock('../db/client.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./fleet-ai.js', () => ({
  isFleetAiAvailable: vi.fn(),
  checkFleetReviewRateLimit: vi.fn(() => true),
}));
// R13: BOTH AI compute paths are the graph. Mock the boundary so these tests
// stay keyless/deterministic and assert that runPlanReview / runRetroRecommendation
// ARE the paths (no direct evaluateStructured call from fleet-service anymore).
vi.mock('./fleetgraph/index.js', () => ({
  runPlanReview: vi.fn(),
  runRetroRecommendation: vi.fn(),
}));

const { mockDocumentsGet, mockIssuesIterate, mockSprintsIterate } = vi.hoisted(() => ({
  mockDocumentsGet: vi.fn(),
  mockIssuesIterate: vi.fn(),
  mockSprintsIterate: vi.fn(),
}));
vi.mock('./fleetgraph/api-client.js', () => ({
  withFleetClient: vi.fn(async (_ctx: unknown, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      documents: { get: mockDocumentsGet },
      issues: { iterate: mockIssuesIterate },
      sprints: { iterate: mockSprintsIterate },
    })
  ),
}));

import { pool } from '../db/client.js';
import { isFleetAiAvailable, checkFleetReviewRateLimit } from './fleet-ai.js';
import { runPlanReview, runRetroRecommendation } from './fleetgraph/index.js';
import { gatherSignals, getReview } from './fleet-service.js';

const mockQuery = vi.mocked(pool.query);
const mockAvailable = vi.mocked(isFleetAiAvailable);
const mockReviewLimit = vi.mocked(checkFleetReviewRateLimit);
const mockRunPlanReview = vi.mocked(runPlanReview);
const mockRunRetro = vi.mocked(runRetroRecommendation);

// A graph-produced FleetPlanReview (the R13 compute path) with `metCount` of the
// 4 pieces met. runPlanReview returns the already-mapped FleetPlanReview shape.
function graphPlanReview(metCount: number) {
  const ids = ['what_changes', 'by_how_much', 'for_whom', 'by_when'] as const;
  const pieces = ids.map((id, i) => ({ id, label: id, met: i < metCount, hint: 'h' }));
  return {
    planReview: {
      status: (pieces.every((p) => p.met) ? 'looks_testable' : 'needs_work') as 'looks_testable' | 'needs_work',
      pieces,
      suggested_rewrite: 'rewrite' as string | null,
      ai_available: true as const,
    },
    diagnosis: 'stuck because X',
    recommendedNextAction: 'do Y',
    available: true,
  };
}

// A graph-produced FleetRetroRecommendation (the retro-mode compute path).
// runRetroRecommendation returns the already-lifted, ai_available shape.
function retroRecResult() {
  return {
    recommendation: 'insufficient_evidence' as const,
    explanation: 'x',
    evidence_found: [] as string[],
    evidence_missing: ['No actual impact'],
    suggested_conclusion: null as string | null,
    diagnosis: 'evidence is thin' as string | null,
    recommended_next_action: 'record actual impact' as string | null,
    proposed_action: null as null | { kind: 'set_plan_validated'; plan_validated: boolean; summary: string },
    ai_available: true as const,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockReviewLimit.mockReturnValue(true); // within review budget by default
  // Default: the graph produces an available plan-review (4/4) and an available
  // retro recommendation. Individual getReview tests override per scenario.
  mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
  mockRunRetro.mockResolvedValue(retroRecResult());
});

// ---- helpers ----
const CTX = { workspaceId: 'w1', userId: 'u1', isAdmin: false };

function projRow(fleet: unknown) {
  return {
    id: 'p1',
    title: 'P',
    content: { type: 'doc', content: [] },
    properties: { plan: 'Reduce X by 20% by end of Q3', success_criteria: ['a'], fleet },
  };
}

function asyncIter<T>(items: T[]): AsyncGenerator<T, void, unknown> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

/**
 * Seed one gatherSignals pass on the fake ShipClient: the focal document GET
 * (404 when project is null), the workspace-visible issues, and the weeks.
 */
function seedSignals(opts: {
  project: ReturnType<typeof projRow> | Record<string, unknown> | null;
  issues?: Array<{ state: string | null; title: string }>;
  weeks?: number;
}): void {
  if (!opts.project) {
    mockDocumentsGet.mockRejectedValueOnce(
      new ShipApiError(404, { code: 'not_found', message: 'Document not found', request_id: 'r' })
    );
  } else {
    mockDocumentsGet.mockResolvedValueOnce({ document_type: 'project', ...opts.project });
  }
  mockIssuesIterate.mockReturnValueOnce(asyncIter(opts.issues ?? []));
  mockSprintsIterate.mockReturnValueOnce(asyncIter(Array.from({ length: opts.weeks ?? 0 }, (_, i) => ({ id: `s${i}` }))));
}

function findUpdateCall() {
  return mockQuery.mock.calls.find((c) => String(c[0]).includes('jsonb_set'));
}

// NOTE: the standalone `buildPlanReview` / `composeFreshReview` / `buildRetroRecommendation`
// suites were removed with the functions themselves — both AI compute paths are now
// the FleetGraph graph (covered by graph.test.ts + the getReview caching tests below).
// Retro's R18 unavailable behavior is asserted via getReview; the JSONB-number monetary
// coercion regression moved to the read layer (read.test.ts).

describe('gatherSignals', () => {
  it('returns null when the project is not visible (v1 404)', async () => {
    seedSignals({ project: null });
    const result = await gatherSignals('p1', { workspaceId: 'w1', userId: 'u1', isAdmin: false });
    expect(result).toBeNull();
  });

  it('returns null when the id resolves to a non-project document', async () => {
    mockDocumentsGet.mockResolvedValueOnce({ document_type: 'issue', id: 'p1', title: 'Not a project', properties: {} });
    const result = await gatherSignals('p1', CTX);
    expect(result).toBeNull();
  });

  it('buckets issues by state and gathers at least-privilege (workspace-only) visibility', async () => {
    seedSignals({
      project: { id: 'p1', title: 'Proj', content: { type: 'doc', content: [] }, properties: { plan: 'x', success_criteria: ['a'] } },
      issues: [
        { state: 'done', title: 'I1' },
        { state: 'cancelled', title: 'I2' },
        { state: 'in_progress', title: 'I3' },
        { state: null, title: 'I4' },
      ],
      weeks: 2,
    });

    // Requester is an admin, but issue gathering must stay at member privilege.
    const result = await gatherSignals('p1', { workspaceId: 'w1', userId: 'u1', isAdmin: true });
    expect(result).not.toBeNull();
    expect(result!.issues.done).toEqual(['I1']);
    expect(result!.issues.cancelled).toEqual(['I2']);
    expect(result!.issues.active).toEqual(['I3', 'I4']);
    expect(result!.weeksCount).toBe(2);

    // The issues read is viewer-INDEPENDENT: explicitly workspace-visible only
    // (the v1 visibility filter excludes even the caller's own private issues),
    // so the shared per-project cache never absorbs private rows.
    expect(mockIssuesIterate).toHaveBeenCalledWith(
      expect.objectContaining({ belongs_to: 'p1', belongs_to_type: 'project', visibility: 'workspace' })
    );
    expect(mockSprintsIterate).toHaveBeenCalledWith(
      expect.objectContaining({ belongs_to: 'p1', belongs_to_type: 'project', visibility: 'workspace' })
    );
  });

  it('cache-hash inputs are transport-independent (stability across the v1 migration)', async () => {
    // The same underlying data must produce identical FleetSignals regardless
    // of transport, so planReviewHash/retroHash (computed over these fields)
    // keep serving the pre-migration cache entries.
    seedSignals({
      project: {
        id: 'p1',
        title: 'Proj',
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retro narrative.' }] }] },
        properties: {
          plan: 'Reduce X by 20%',
          success_criteria: ['a', 'b'],
          monetary_impact_expected: '10k',
          monetary_impact_actual: null,
          plan_validated: null,
          target_date: '2026-09-30',
        },
      },
      issues: [
        { state: 'done', title: 'I1' },
        { state: 'in_progress', title: 'I2' },
      ],
      weeks: 1,
    });
    const signals = await gatherSignals('p1', CTX);
    expect(signals).toEqual({
      projectId: 'p1',
      title: 'Proj',
      plan: 'Reduce X by 20%',
      successCriteria: ['a', 'b'],
      monetaryImpactExpected: '10k',
      monetaryImpactActual: null,
      planValidated: null,
      targetDate: '2026-09-30',
      retroText: 'Retro narrative.',
      issues: { done: ['I1'], cancelled: [], active: ['I2'] },
      weeksCount: 1,
      existingCache: null,
    });
  });
});

describe('getReview caching', () => {
  it('returns null when project not visible', async () => {
    seedSignals({ project: null });
    expect(await getReview('p1', CTX)).toBeNull();
  });

  it('over the review budget on a cache-miss GET → no graph call, unavailable result', async () => {
    mockAvailable.mockReturnValue(true);
    mockReviewLimit.mockReturnValue(false); // over budget
    seedSignals({ project: projRow(null) });
    const r = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled(); // plan-review graph not invoked
    expect(mockRunRetro).not.toHaveBeenCalled(); // retro graph not invoked either
    expect(r!.ai_available).toBe(false);
    expect(r!.plan_review.pieces).toHaveLength(0); // R18: no deterministic pieces
    expect(findUpdateCall()).toBeFalsy();
  });

  it('no plan → no_plan review without invoking the graph (issue 1)', async () => {
    mockAvailable.mockReturnValue(true); // provider configured…
    seedSignals({
      project: { id: 'p1', title: 'P', content: { type: 'doc', content: [] }, properties: {} },
    });
    const r = await getReview('p1', CTX);
    // …yet the graph is NOT invoked because there is nothing to review.
    expect(mockRunPlanReview).not.toHaveBeenCalled();
    expect(mockRunRetro).not.toHaveBeenCalled();
    expect(r!.plan_review.status).toBe('no_plan');
    expect(r!.plan_review.pieces).toHaveLength(0);
    expect(r!.plan_review.ai_available).toBe(false);
  });

  it('no plan but a STALE cached review → no_plan, cache not served (issue 1 cache-hit path)', async () => {
    // Regression: a project with no plan that carries a stale plan_review cache
    // (e.g. computed before the no-plan guard existed) must NOT serve that cached
    // review — the no-plan check runs before the cache lookup.
    mockAvailable.mockReturnValue(true);
    const staleFleet = {
      plan_review: {
        hash: 'staleHash',
        computed_at: '2026-01-01T00:00:00.000Z',
        result: {
          status: 'needs_work',
          pieces: [{ id: 'what_changes', label: 'What will change', met: true, hint: 'h' }],
          suggested_rewrite: 'a stale AI rewrite',
          ai_available: true,
        },
      },
    };
    seedSignals({
      project: { id: 'p1', title: 'P', content: { type: 'doc', content: [] }, properties: { fleet: staleFleet } },
    });
    const r = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled();
    expect(r!.plan_review.status).toBe('no_plan');
    expect(r!.plan_review.ai_available).toBe(false);
    expect(r!.plan_review.pieces).toHaveLength(0); // NOT the stale piece
    expect(r!.plan_review.suggested_rewrite).toBeNull(); // NOT the stale rewrite
  });

  it('AE6/R13: unchanged plan → plan + retro graph evaluated once across two calls', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4)); // plan via graph
    mockRunRetro.mockResolvedValue(retroRecResult()); // retro via graph
    // Call 1: no cache → signal reads + 1 update
    seedSignals({ project: projRow(null) });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write

    const r1 = await getReview('p1', CTX);
    expect(mockRunPlanReview).toHaveBeenCalledTimes(1); // R13: plan-review via graph
    expect(mockRunRetro).toHaveBeenCalledTimes(1); // retro via graph
    expect(r1!.plan_review.ai_available).toBe(true);

    const update = findUpdateCall();
    expect(update).toBeTruthy();
    const sql = String(update![0]);
    expect(sql).toContain('jsonb_set');
    expect(sql).toContain("'{fleet}'");
    expect(sql).not.toMatch(/SET properties = \$1\b/); // not a whole-properties overwrite
    const blob = JSON.parse(String((update![1] as unknown[])[0]));

    // Call 2: cache present (same plan) → no graph call, no update
    mockRunRetro.mockClear();
    mockRunPlanReview.mockClear();
    mockQuery.mockReset();
    seedSignals({ project: projRow(blob) });

    const r2 = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled();
    expect(mockRunRetro).not.toHaveBeenCalled();
    expect(r2!.plan_review.ai_available).toBe(true);
    expect(findUpdateCall()).toBeFalsy();
  });

  it('only an issue change re-runs retro, serves plan from cache', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockRunRetro.mockResolvedValue(retroRecResult());
    seedSignals({ project: projRow(null) });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write
    const r1 = await getReview('p1', CTX);
    const blob = JSON.parse(String((findUpdateCall()![1] as unknown[])[0]));
    expect(r1).toBeTruthy();

    // Call 2: same plan, a new completed issue → retro hash misses only.
    mockRunRetro.mockClear();
    mockRunPlanReview.mockClear();
    mockQuery.mockReset();
    mockRunRetro.mockResolvedValue(retroRecResult());
    seedSignals({ project: projRow(blob), issues: [{ state: 'done', title: 'NewIssue' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write

    const r2 = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled(); // plan served from cache
    expect(mockRunRetro).toHaveBeenCalledTimes(1); // retro only
    expect(r2!.plan_review.ai_available).toBe(true); // plan served from cache
    expect(findUpdateCall()).toBeTruthy();
  });

  it('force:true re-runs AI even on a hash match', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockRunRetro.mockResolvedValue(retroRecResult());
    seedSignals({ project: projRow(null) });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write
    await getReview('p1', CTX);
    const blob = JSON.parse(String((findUpdateCall()![1] as unknown[])[0]));

    mockRunRetro.mockClear();
    mockRunPlanReview.mockClear();
    mockQuery.mockReset();
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockRunRetro.mockResolvedValue(retroRecResult());
    seedSignals({ project: projRow(blob) });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write

    await getReview('p1', CTX, { force: true });
    expect(mockRunPlanReview).toHaveBeenCalledTimes(1); // plan re-run via graph despite cache
    expect(mockRunRetro).toHaveBeenCalledTimes(1); // retro re-run despite cache
  });

  it('cache write payload is key-scoped — never includes sibling props like plan_validated (U5)', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockRunRetro.mockResolvedValue(retroRecResult());
    const withValidated = projRow(null);
    withValidated.properties = { ...withValidated.properties, plan_validated: true } as typeof withValidated.properties;
    seedSignals({ project: withValidated });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write

    await getReview('p1', CTX);
    const update = findUpdateCall();
    expect(update).toBeTruthy();
    expect(String(update![0])).toContain("'{fleet}'"); // targets only the fleet key
    const blob = JSON.parse(String((update![1] as unknown[])[0]));
    expect(Object.keys(blob).sort()).toEqual(['plan_review', 'retro_recommendation']);
    expect(blob).not.toHaveProperty('plan_validated');
    expect(blob).not.toHaveProperty('plan');
    expect(blob).not.toHaveProperty('success_criteria');
  });

  it('AI unavailable (R18) → unavailable result, no graph call, no cache write', async () => {
    mockAvailable.mockReturnValue(false);
    seedSignals({ project: projRow(null) });

    const r = await getReview('p1', CTX);
    expect(r!.plan_review.ai_available).toBe(false);
    expect(r!.plan_review.pieces).toHaveLength(0); // R18: no deterministic pieces
    expect(r!.retro_recommendation.ai_available).toBe(false);
    expect(r!.ai_available).toBe(false);
    expect(mockRunPlanReview).not.toHaveBeenCalled(); // gated out: no provider
    expect(mockRunRetro).not.toHaveBeenCalled();
    expect(findUpdateCall()).toBeFalsy();
  });

  it('forced refresh while AI is down clears the stale cached AI entries', async () => {
    // 1) populate the cache with AI entries
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(3));
    mockRunRetro.mockResolvedValue(retroRecResult());
    seedSignals({ project: projRow(null) });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write
    await getReview('p1', CTX);
    const blob = JSON.parse(String((findUpdateCall()![1] as unknown[])[0]));
    expect(blob.plan_review).toBeTruthy();

    // 2) force-refresh with AI now unavailable → stale entries must be cleared
    mockQuery.mockReset();
    mockAvailable.mockReturnValue(false);
    seedSignals({ project: projRow(blob) });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // cache write

    const r2 = await getReview('p1', CTX, { force: true });
    const update = findUpdateCall();
    expect(update).toBeTruthy(); // write happened to clear stale
    const newBlob = JSON.parse(String((update![1] as unknown[])[0]));
    expect(newBlob.plan_review).toBeUndefined();
    expect(newBlob.retro_recommendation).toBeUndefined();
    expect(r2!.plan_review.ai_available).toBe(false);
  });
});
