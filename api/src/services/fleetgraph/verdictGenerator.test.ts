/**
 * Unit tests for verdictGenerator.ts. Mocks `evaluateStructured` from
 * `../fleet-ai.js` so no real provider/network is involved; the tests assert:
 *   - decision pass-through for all three valid LLM decisions (SURFACE_ACT,
 *     SURFACE_FYI, SUPPRESS),
 *   - fallback shape on both FleetAiError variants (`ai_unavailable`,
 *     `ai_parse_error`),
 *   - the prompt SHAPE (system non-empty, user contains title + each signal
 *     reason, schemaName pinned, metadata threaded) without pinning exact
 *     prompt words (those will iterate against real traces).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DriftSignal, InsightVerdict } from '@ship/shared';

// ─── Mock setup ─────────────────────────────────────────────────────────
// vi.hoisted ensures `evaluateStructuredMock` exists before vi.mock's factory
// captures it. `isFleetAiError` is a plain runtime discriminator over the
// `{error: ...}` shape — re-implement here so the mock module is self-contained
// and the production code's check matches structural equality on test fixtures.
const { evaluateStructuredMock } = vi.hoisted(() => ({
  evaluateStructuredMock: vi.fn(),
}));

vi.mock('../fleet-ai.js', () => ({
  evaluateStructured: evaluateStructuredMock,
  isFleetAiError: (x: unknown): boolean =>
    typeof x === 'object' && x !== null && 'error' in (x as Record<string, unknown>),
}));

import { generateDriftVerdict, __testing } from './verdictGenerator.js';

// ─── Test fixtures ──────────────────────────────────────────────────────

const SIGNALS: DriftSignal[] = [
  { type: 'idle', reason: 'idle 14 days' },
  { type: 'stale_plan', reason: 'plan stale 30 days' },
];

const DETERMINISTIC_FALLBACK: InsightVerdict = {
  decision: 'SURFACE_FYI',
  reasoning: 'Project drift: idle 14 days, plan stale 30 days',
};

function buildInput(overrides: Partial<Parameters<typeof generateDriftVerdict>[0]> = {}) {
  return {
    projectTitle: 'Re-platform billing',
    signals: SIGNALS,
    workspaceId: 'ws-test-1',
    sweepRunId: 'run-uuid-abc',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('generateDriftVerdict — happy path', () => {
  it('SURFACE_ACT: returns LLM verdict, degraded=false, source=llm', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SURFACE_ACT',
      reasoning: 'idle for two weeks',
    });

    const out = await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    expect(out).toEqual({
      verdict: { decision: 'SURFACE_ACT', reasoning: 'idle for two weeks' },
      degraded: false,
      source: 'llm',
    });
  });

  it('SURFACE_FYI: decision pass-through with source=llm', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SURFACE_FYI',
      reasoning: 'minor — worth flagging but not urgent',
    });

    const out = await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    expect(out.verdict).toEqual({
      decision: 'SURFACE_FYI',
      reasoning: 'minor — worth flagging but not urgent',
    });
    expect(out.source).toBe('llm');
    expect(out.degraded).toBe(false);
  });

  it('SUPPRESS: flows through unchanged with source=llm (caller decides what to do)', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SUPPRESS',
      reasoning: 'expected churn during planning week',
    });

    const out = await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    expect(out).toEqual({
      verdict: { decision: 'SUPPRESS', reasoning: 'expected churn during planning week' },
      degraded: false,
      source: 'llm',
    });
  });
});

describe('generateDriftVerdict — fallback on FleetAiError', () => {
  it('ai_unavailable: returns deterministic fallback, degraded=true, source=deterministic', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({ error: 'ai_unavailable' });

    const out = await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    expect(out).toEqual({
      verdict: DETERMINISTIC_FALLBACK,
      degraded: true,
      source: 'deterministic',
    });
    // The fallback object is the SAME object the caller passed (no clone). The
    // sweep loop owns the deterministic verdict's identity; we just thread it.
    expect(out.verdict).toBe(DETERMINISTIC_FALLBACK);
  });

  it('ai_parse_error: returns deterministic fallback with the same shape', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({ error: 'ai_parse_error' });

    const out = await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    expect(out).toEqual({
      verdict: DETERMINISTIC_FALLBACK,
      degraded: true,
      source: 'deterministic',
    });
  });
});

describe('generateDriftVerdict — prompt shape', () => {
  it('passes a non-empty system, schemaName=DriftVerdict, maxTokens, and metadata to evaluateStructured', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SURFACE_ACT',
      reasoning: 'urgent',
    });

    await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    expect(evaluateStructuredMock).toHaveBeenCalledTimes(1);
    const call = evaluateStructuredMock.mock.calls[0]![0];

    // System is non-empty (not pinning exact words — that iterates).
    expect(typeof call.system).toBe('string');
    expect(call.system.length).toBeGreaterThan(0);
    expect(call.system).toBe(__testing.SYSTEM_PROMPT);

    // Schema name is pinned (consumers / LangSmith filter on this).
    expect(call.schemaName).toBe('DriftVerdict');

    // Max tokens is bounded for a concise JSON reply.
    expect(call.maxTokens).toBe(200);

    // Metadata threaded through for LangSmith trace filterability.
    expect(call.metadata).toEqual({
      workspace_id: 'ws-test-1',
      sweep_run_id: 'run-uuid-abc',
    });

    // Schema is the module-level Zod object (identity, not equality).
    expect(call.schema).toBe(__testing.LLMVerdictSchema);
  });

  it('user message contains the project title and every signal reason', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SURFACE_FYI',
      reasoning: 'noted',
    });

    await generateDriftVerdict(buildInput(), DETERMINISTIC_FALLBACK);

    const call = evaluateStructuredMock.mock.calls[0]![0];
    expect(typeof call.user).toBe('string');
    // The user content is a JSON-serialized payload — string-search the title
    // and each reason rather than pinning the exact serialization format.
    expect(call.user).toContain('Re-platform billing');
    for (const s of SIGNALS) {
      expect(call.user).toContain(s.reason);
    }
    // Parse the JSON to assert the structured shape — guards against silent
    // serialization drift.
    const parsed = JSON.parse(call.user);
    expect(parsed.projectTitle).toBe('Re-platform billing');
    expect(parsed.signals).toEqual([
      { type: 'idle', reason: 'idle 14 days' },
      { type: 'stale_plan', reason: 'plan stale 30 days' },
    ]);
  });
});

describe('generateDriftVerdict — edge cases', () => {
  it('empty signals array: still calls the LLM with a well-formed payload (no special branch)', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SUPPRESS',
      reasoning: 'no signals fired',
    });

    const out = await generateDriftVerdict(
      buildInput({ signals: [] }),
      DETERMINISTIC_FALLBACK
    );

    expect(evaluateStructuredMock).toHaveBeenCalledTimes(1);
    const call = evaluateStructuredMock.mock.calls[0]![0];
    const parsed = JSON.parse(call.user);
    expect(parsed.signals).toEqual([]);
    expect(parsed.projectTitle).toBe('Re-platform billing');

    // Result still flows through cleanly.
    expect(out.source).toBe('llm');
    expect(out.verdict.decision).toBe('SUPPRESS');
  });

  it('different workspace/sweepRunId values are reflected in metadata per call', async () => {
    evaluateStructuredMock.mockResolvedValueOnce({
      decision: 'SURFACE_ACT',
      reasoning: 'r',
    });

    await generateDriftVerdict(
      buildInput({ workspaceId: 'ws-other', sweepRunId: 'run-2' }),
      DETERMINISTIC_FALLBACK
    );

    const call = evaluateStructuredMock.mock.calls[0]![0];
    expect(call.metadata).toEqual({
      workspace_id: 'ws-other',
      sweep_run_id: 'run-2',
    });
  });
});
