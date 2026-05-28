/**
 * LLM-backed verdict generator for FleetGraph drift insights.
 *
 * Given the drift signals that fired for one project plus the per-tick trace
 * metadata (workspaceId + sweepRunId), call `evaluateStructured` once and
 * return either the LLM verdict (`source: 'llm'`) or the caller-supplied
 * deterministic fallback (`source: 'deterministic'`). NEVER throws — the
 * sweep relies on a guaranteed VerdictOutput shape.
 *
 * Why a module instead of inlining in sweep.ts: keeps the prompt + Zod schema
 * + metadata threading testable in isolation against a mocked
 * `evaluateStructured`, and isolates future prompt iteration from the sweep
 * loop's transactional discipline.
 *
 * Pattern mirror: `nodes/reason.ts:288` (PROACTIVE branch) — same shape:
 * `evaluateStructured` → `isFleetAiError` discriminator → degrade-on-error.
 */

import { z } from 'zod';
import type { DriftSignal, InsightVerdict, InsightVerdictDecision } from '@ship/shared';
import { evaluateStructured, isFleetAiError } from '../fleet-ai.js';

// ─── Public types ───────────────────────────────────────────────────────

export interface VerdictInput {
  /** Project document title — included in the prompt for grounding. */
  projectTitle: string;
  /** Drift signals that fired for this project. Reasons are short, human-readable. */
  signals: DriftSignal[];
  /** Workspace ID — threaded to LangSmith metadata for per-workspace filtering. */
  workspaceId: string;
  /** Per-tick UUID generated once at the top of `sweepWorkspaceDrift`. */
  sweepRunId: string;
}

export interface VerdictOutput {
  /** The verdict to persist on the insight (LLM-generated or fallback). */
  verdict: InsightVerdict;
  /** True iff the LLM call failed and we fell back. Tick-level `degraded` is OR-ed from this. */
  degraded: boolean;
  /** Provenance flag for `evidence.verdict_source`. */
  source: 'llm' | 'deterministic';
}

// ─── Module-level prompt + schema constants ─────────────────────────────

const LLMVerdictSchema = z.object({
  decision: z.enum(['SURFACE_ACT', 'SURFACE_FYI', 'SUPPRESS']),
  reasoning: z.string().min(1).max(1000),
});

type LLMVerdict = z.infer<typeof LLMVerdictSchema>;

const SCHEMA_NAME = 'DriftVerdict';

const SYSTEM_PROMPT = `You are reviewing a drift detection for a Fleet project — Fleet is the workspace's project management surface. Given the drift signals that fired for one project, decide whether to surface this detection to workspace members.

Return one of:
- SURFACE_ACT — urgent attention needed; workspace members should act now.
- SURFACE_FYI — informational; worth knowing but not blocking.
- SUPPRESS — signals are noise, expected churn, or otherwise not worth surfacing.

Provide concise reasoning (one or two sentences) grounded in the signals.`;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Generate a verdict for a drifting project. NEVER throws — returns the
 * caller-supplied `deterministicFallback` on any LLM failure (unavailable,
 * parse error, or any neutral `FleetAiError` from `evaluateStructured`).
 *
 * Contract:
 * - Success path: `{ verdict: LLM-result, degraded: false, source: 'llm' }`.
 * - Fallback path: `{ verdict: deterministicFallback, degraded: true, source: 'deterministic' }`.
 * - No retries (matches the plan's "one try, fall back" decision).
 * - SUPPRESS is just a decision value — this function doesn't interpret it;
 *   the caller (sweep) decides what to do (skip `createOrRefreshInsight`).
 */
export async function generateDriftVerdict(
  input: VerdictInput,
  deterministicFallback: InsightVerdict
): Promise<VerdictOutput> {
  const userPayload = {
    projectTitle: input.projectTitle,
    signals: input.signals.map((s) => ({ type: s.type, reason: s.reason })),
  };

  const result = await evaluateStructured<LLMVerdict>({
    system: SYSTEM_PROMPT,
    user: JSON.stringify(userPayload),
    schema: LLMVerdictSchema,
    schemaName: SCHEMA_NAME,
    maxTokens: 200,
    metadata: {
      workspace_id: input.workspaceId,
      sweep_run_id: input.sweepRunId,
    },
  });

  if (isFleetAiError(result)) {
    return {
      verdict: deterministicFallback,
      degraded: true,
      source: 'deterministic',
    };
  }

  // The LLMVerdictSchema enum guarantees decision is one of the three valid
  // InsightVerdictDecision values; the cast just re-asserts the substrate's
  // shared type without re-validating.
  return {
    verdict: {
      decision: result.decision as InsightVerdictDecision,
      reasoning: result.reasoning,
    },
    degraded: false,
    source: 'llm',
  };
}

// Test-only: re-export the prompt + schema constants for invariant assertions
// (test files import these to assert "system is non-empty", "schema name pinned",
// etc., without re-declaring the strings inside the test). Marked __testing to
// signal the same convention as sweep.ts / insight.ts.
export const __testing = {
  SYSTEM_PROMPT,
  SCHEMA_NAME,
  LLMVerdictSchema,
};
