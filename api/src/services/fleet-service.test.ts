import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DB pool and the AI provider so no real DB rows or model calls fire.
vi.mock('../db/client.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./fleet-ai.js', () => ({
  isFleetAiAvailable: vi.fn(),
  evaluateStructured: vi.fn(),
  checkFleetReviewRateLimit: vi.fn(() => true),
  isFleetAiError: (x: unknown) => typeof x === 'object' && x !== null && 'error' in x,
}));
// R13: the plan-review compute path is the graph. Mock the boundary so these
// tests stay keyless/deterministic and assert that runPlanReview IS the path.
vi.mock('./fleetgraph/index.js', () => ({ runPlanReview: vi.fn() }));

import { pool } from '../db/client.js';
import { isFleetAiAvailable, evaluateStructured, checkFleetReviewRateLimit } from './fleet-ai.js';
import { runPlanReview } from './fleetgraph/index.js';
import {
  gatherSignals,
  buildRetroRecommendation,
  getReview,
  type FleetSignals,
} from './fleet-service.js';

const mockQuery = vi.mocked(pool.query);
const mockAvailable = vi.mocked(isFleetAiAvailable);
const mockEvaluate = vi.mocked(evaluateStructured);
const mockReviewLimit = vi.mocked(checkFleetReviewRateLimit);
const mockRunPlanReview = vi.mocked(runPlanReview);

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

function signals(overrides: Partial<FleetSignals> = {}): FleetSignals {
  return {
    projectId: 'p1',
    title: 'Project',
    plan: 'Reduce activation time from 6 to 3 minutes by Q3',
    successCriteria: ['Median activation < 3 min'],
    monetaryImpactExpected: null,
    monetaryImpactActual: null,
    planValidated: null,
    targetDate: '2026-09-30T00:00:00.000Z', // by_when met by default
    retroText: '',
    issues: { done: [], cancelled: [], active: [] },
    weeksCount: 0,
    existingCache: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockReviewLimit.mockReturnValue(true); // within review budget by default
  // Default: the graph produces an available plan-review (4/4). Individual
  // getReview tests override per scenario.
  mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
});

// ---- helpers for getReview caching tests ----
const CTX = { workspaceId: 'w1', userId: 'u1', isAdmin: false };

function projRow(fleet: unknown) {
  return {
    id: 'p1',
    title: 'P',
    content: { type: 'doc', content: [] },
    properties: { plan: 'Reduce X by 20% by end of Q3', success_criteria: ['a'], fleet },
  };
}
function retroAiResult() {
  return {
    recommendation: 'insufficient_evidence' as const,
    explanation: 'x',
    evidence_found: [],
    evidence_missing: ['No actual impact'],
    suggested_conclusion: '',
  };
}
function findUpdateCall() {
  return mockQuery.mock.calls.find((c) => String(c[0]).includes('jsonb_set'));
}

// NOTE: the standalone `buildPlanReview` / `composeFreshReview` suites were
// removed with the functions themselves (C1) — the plan-review compute path is
// now the FleetGraph graph (covered by graph.test.ts + getReview caching tests).

describe('buildRetroRecommendation', () => {
  it('AI unavailable → unavailable: insufficient_evidence, NO evidence (R18)', async () => {
    mockAvailable.mockReturnValue(false);
    const result = await buildRetroRecommendation(
      signals({ monetaryImpactActual: null, issues: { done: [], cancelled: [], active: ['I1'] } })
    );
    expect(result.recommendation).toBe('insufficient_evidence');
    // R18: no deterministic baseline — empty evidence, requires a provider.
    expect(result.evidence_found).toHaveLength(0);
    expect(result.evidence_missing).toHaveLength(0);
    expect(result.ai_available).toBe(false);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('does not throw when monetary impact is a non-string (number from JSONB)', async () => {
    // Regression: buildRetroUserContent runs unconditionally (to size-check) and
    // esc() previously assumed a string; a JSONB-sourced number (monetary_impact_*)
    // made `.replace` throw, surfacing as a 500 on the retro path for real projects.
    mockAvailable.mockReturnValue(false);
    const result = await buildRetroRecommendation(
      signals({
        monetaryImpactExpected: 50000 as unknown as string,
        monetaryImpactActual: 30000 as unknown as string,
      })
    );
    expect(result.recommendation).toBe('insufficient_evidence');
    expect(result.ai_available).toBe(false);
  });

  it('strong evidence + AI available → validated_recommended', async () => {
    mockAvailable.mockReturnValue(true);
    mockEvaluate.mockResolvedValueOnce({
      recommendation: 'validated_recommended',
      explanation: 'Criteria met and impact recorded.',
      evidence_found: ['Activation < 3 min', 'Saved $50k/yr'],
      evidence_missing: [],
      suggested_conclusion: 'Validated: the bet held.',
    });
    const result = await buildRetroRecommendation(
      signals({ monetaryImpactActual: 'Saved $50k/yr', issues: { done: ['I1', 'I2'], cancelled: [], active: [] } })
    );
    expect(result.recommendation).toBe('validated_recommended');
    expect(result.ai_available).toBe(true);
  });

  it('recommendation is always one of the three enums', async () => {
    mockAvailable.mockReturnValue(false);
    const result = await buildRetroRecommendation(signals());
    expect(['validated_recommended', 'invalidated_recommended', 'insufficient_evidence']).toContain(
      result.recommendation
    );
  });
});

describe('gatherSignals', () => {
  it('returns null when the project is not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const result = await gatherSignals('p1', { workspaceId: 'w1', userId: 'u1', isAdmin: false });
    expect(result).toBeNull();
  });

  it('buckets issues by state and applies the least-privilege visibility filter', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'p1', title: 'Proj', content: { type: 'doc', content: [] }, properties: { plan: 'x', success_criteria: ['a'] } }],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { state: 'done', title: 'I1' },
          { state: 'cancelled', title: 'I2' },
          { state: 'in_progress', title: 'I3' },
          { state: null, title: 'I4' },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [{ n: 2 }] } as never);

    // Requester is an admin, but issue gathering must stay at member privilege.
    const result = await gatherSignals('p1', { workspaceId: 'w1', userId: 'u1', isAdmin: true });
    expect(result).not.toBeNull();
    expect(result!.issues.done).toEqual(['I1']);
    expect(result!.issues.cancelled).toEqual(['I2']);
    expect(result!.issues.active).toEqual(['I3', 'I4']);
    expect(result!.weeksCount).toBe(2);

    // Project query (admin) may include the admin bypass...
    const projectSql = String(mockQuery.mock.calls[0]![0]);
    expect(projectSql).toContain("visibility = 'workspace'");
    // ...but the issues query is viewer-INDEPENDENT: workspace-visible only,
    // with no admin bypass and no created_by personalization (shared cache).
    const issuesSql = String(mockQuery.mock.calls[1]![0]);
    expect(issuesSql).toContain("d.visibility = 'workspace'");
    expect(issuesSql).not.toContain('OR TRUE');
    expect(issuesSql).not.toContain('created_by');
  });
});

describe('getReview caching', () => {
  it('returns null when project not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    expect(await getReview('p1', CTX)).toBeNull();
  });

  it('over the review budget on a cache-miss GET → no graph/model call, unavailable result', async () => {
    mockAvailable.mockReturnValue(true);
    mockReviewLimit.mockReturnValue(false); // over budget
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(null)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never);
    const r = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled(); // plan-review graph not invoked
    expect(mockEvaluate).not.toHaveBeenCalled(); // retro not invoked either
    expect(r!.ai_available).toBe(false);
    expect(r!.plan_review.pieces).toHaveLength(0); // R18: no deterministic pieces
    expect(findUpdateCall()).toBeFalsy();
  });

  it('no plan → no_plan review without invoking the graph/model (issue 1)', async () => {
    mockAvailable.mockReturnValue(true); // provider configured…
    mockQuery
      // project row with NO plan in properties
      .mockResolvedValueOnce({ rows: [{ id: 'p1', title: 'P', content: { type: 'doc', content: [] }, properties: {} }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never) // issues
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never); // weeks
    const r = await getReview('p1', CTX);
    // …yet the graph/model is NOT invoked because there is nothing to review.
    expect(mockRunPlanReview).not.toHaveBeenCalled();
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(r!.plan_review.status).toBe('no_plan');
    expect(r!.plan_review.pieces).toHaveLength(0);
    expect(r!.plan_review.ai_available).toBe(false);
  });

  it('AE6/R13: unchanged plan → graph + retro evaluated once across two calls', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4)); // plan via graph
    mockEvaluate.mockResolvedValueOnce(retroAiResult()); // retro via evaluateStructured
    // Call 1: no cache → 3 reads + 1 update
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(null)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const r1 = await getReview('p1', CTX);
    expect(mockRunPlanReview).toHaveBeenCalledTimes(1); // R13: plan-review via graph
    expect(mockEvaluate).toHaveBeenCalledTimes(1); // retro via evaluateStructured
    expect(r1!.plan_review.ai_available).toBe(true);

    const update = findUpdateCall();
    expect(update).toBeTruthy();
    const sql = String(update![0]);
    expect(sql).toContain('jsonb_set');
    expect(sql).toContain("'{fleet}'");
    expect(sql).not.toMatch(/SET properties = \$1\b/); // not a whole-properties overwrite
    const blob = JSON.parse(String((update![1] as unknown[])[0]));

    // Call 2: cache present (same plan) → no graph/model call, no update
    mockEvaluate.mockClear();
    mockRunPlanReview.mockClear();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(blob)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never);

    const r2 = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled();
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(r2!.plan_review.ai_available).toBe(true);
    expect(findUpdateCall()).toBeFalsy();
  });

  it('only an issue change re-runs retro, serves plan from cache', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockEvaluate.mockResolvedValueOnce(retroAiResult());
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(null)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const r1 = await getReview('p1', CTX);
    const blob = JSON.parse(String((findUpdateCall()![1] as unknown[])[0]));
    expect(r1).toBeTruthy();

    // Call 2: same plan, a new completed issue → retro hash misses only.
    mockEvaluate.mockReset();
    mockRunPlanReview.mockClear();
    mockQuery.mockReset();
    mockEvaluate.mockResolvedValueOnce(retroAiResult());
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(blob)] } as never)
      .mockResolvedValueOnce({ rows: [{ state: 'done', title: 'NewIssue' }] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const r2 = await getReview('p1', CTX);
    expect(mockRunPlanReview).not.toHaveBeenCalled(); // plan served from cache
    expect(mockEvaluate).toHaveBeenCalledTimes(1); // retro only
    expect(r2!.plan_review.ai_available).toBe(true); // plan served from cache
    expect(findUpdateCall()).toBeTruthy();
  });

  it('force:true re-runs AI even on a hash match', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockEvaluate.mockResolvedValueOnce(retroAiResult());
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(null)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await getReview('p1', CTX);
    const blob = JSON.parse(String((findUpdateCall()![1] as unknown[])[0]));

    mockEvaluate.mockReset();
    mockRunPlanReview.mockClear();
    mockQuery.mockReset();
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockEvaluate.mockResolvedValueOnce(retroAiResult());
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(blob)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    await getReview('p1', CTX, { force: true });
    expect(mockRunPlanReview).toHaveBeenCalledTimes(1); // plan re-run via graph despite cache
    expect(mockEvaluate).toHaveBeenCalledTimes(1); // retro re-run despite cache
  });

  it('cache write payload is key-scoped — never includes sibling props like plan_validated (U5)', async () => {
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(4));
    mockEvaluate.mockResolvedValueOnce(retroAiResult());
    const withValidated = projRow(null);
    withValidated.properties = { ...withValidated.properties, plan_validated: true } as typeof withValidated.properties;
    mockQuery
      .mockResolvedValueOnce({ rows: [withValidated] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

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

  it('AI unavailable (R18) → unavailable result, no graph/model call, no cache write', async () => {
    mockAvailable.mockReturnValue(false);
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(null)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never);

    const r = await getReview('p1', CTX);
    expect(r!.plan_review.ai_available).toBe(false);
    expect(r!.plan_review.pieces).toHaveLength(0); // R18: no deterministic pieces
    expect(r!.ai_available).toBe(false);
    expect(mockRunPlanReview).not.toHaveBeenCalled(); // gated out: no provider
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(findUpdateCall()).toBeFalsy();
  });

  it('forced refresh while AI is down clears the stale cached AI entries', async () => {
    // 1) populate the cache with AI entries
    mockAvailable.mockReturnValue(true);
    mockRunPlanReview.mockResolvedValue(graphPlanReview(3));
    mockEvaluate.mockResolvedValueOnce(retroAiResult());
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(null)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await getReview('p1', CTX);
    const blob = JSON.parse(String((findUpdateCall()![1] as unknown[])[0]));
    expect(blob.plan_review).toBeTruthy();

    // 2) force-refresh with AI now unavailable → stale entries must be cleared
    mockQuery.mockReset();
    mockEvaluate.mockReset();
    mockAvailable.mockReturnValue(false);
    mockQuery
      .mockResolvedValueOnce({ rows: [projRow(blob)] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ n: 0 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const r2 = await getReview('p1', CTX, { force: true });
    const update = findUpdateCall();
    expect(update).toBeTruthy(); // write happened to clear stale
    const newBlob = JSON.parse(String((update![1] as unknown[])[0]));
    expect(newBlob.plan_review).toBeUndefined();
    expect(newBlob.retro_recommendation).toBeUndefined();
    expect(r2!.plan_review.ai_available).toBe(false);
  });
});
