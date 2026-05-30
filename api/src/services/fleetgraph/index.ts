/**
 * FleetGraph public entry points (U7).
 *
 * Three callers drive the ONE compiled graph:
 *
 *   runPlanReview()   — proactive plan-review (U8 calls this from getReview's
 *                       shell). Runs scope→fetch→reason(structured)→output.
 *                       No chat, no interrupt. Returns a FleetPlanReview-shaped
 *                       result so it drops into the existing card/retro contract.
 *
 *   runChatTurn()     — on-demand chat (U9 calls this). Seeds from
 *                       {entityId, entityType, message, history, conversationDocId}.
 *                       Runs the graph with thread_id=conversationDocId. If it
 *                       PAUSES at the action node it returns { status:'paused',
 *                       proposal, threadId }; otherwise { status:'answer', answer }.
 *
 *   resumeChatTurn()  — resumes a paused turn with Command({ resume:{approved} })
 *                       on the same thread_id. approved:true executes the write;
 *                       approved:false abandons it and continues to an answer.
 *
 * ── SIDE-EFFECT ORDERING (resume re-run scope) ──────────────────────────────
 * The model call lives in the reason node (UPSTREAM of action). On resume,
 * @langchain/langgraph re-runs ONLY the interrupted action node, NOT upstream
 * completed nodes (their channel writes are checkpointed), so neither the model
 * call nor the fetch re-fires. The rate-limit token (U9) and conversation-doc
 * creation (U9/conversation.ts) sit OUTSIDE the graph and BEFORE the initial
 * invoke, so resume — which calls the compiled graph with a Command, never the
 * pre-graph code — cannot re-fire them either. This is proven in graph.test.ts.
 */

import crypto from 'crypto';
import { Command } from '@langchain/langgraph';
import { AIMessageChunk } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  FleetPlanReview,
  FleetHypothesisPiece,
  FleetRetroRecommendation,
  FleetProposedAction,
  FleetDedupReview,
  FleetDedupMatch,
  FleetIssueGroupingResult,
  FleetIssueGroup,
  DriftSignal,
  InsightVerdict,
} from '@ship/shared';
import { hasText } from '../fleet-checks.js';
import { pool as defaultPool } from '../../db/client.js';
import { ConversationDocCheckpointSaver } from './checkpointer.js';
import { RUBRIC, BY_WHEN_HINT } from './plan-review-config.js';
import { findSimilarIssues, fetchOpenIssuesForClustering } from '../issue-dedup.js';
import type { DedupReviewAi } from './dedup-config.js';
import type { RelatedGroupsAi } from './related-config.js';
import type { RetroRecAi } from './retro-config.js';
import { getCompiledGraph, compileGraph } from './graph.js';
import type { FleetContext, FleetEntityType } from './tools/read.js';
import type { WriteProposal } from './tools/write.js';
import type { FleetAnalysis } from './state.js';
import type { PlanReviewAi, DriftVerdictAi } from './nodes/reason.js';
import type { InterruptPayload, ResumeValue } from './nodes/action.js';

type CompiledGraph = ReturnType<typeof compileGraph>;

const LANGSMITH_ENV = process.env.ENVIRONMENT ?? 'development';

/**
 * Clear any persisted checkpoint for a conversation thread (U3 deleteThread).
 *
 * The U3 checkpointer is latest-tuple-only and keyed by thread_id (=
 * conversationId). A leftover checkpoint from a RESOLVED prior turn would make
 * the next `graph.invoke` on the same thread RESUME from that stale state
 * (replaying the prior proposal / dropping the new message at the scope node's
 * `messages.length === 0` guard) instead of running the new message cleanly.
 *
 * Each chat turn is a clean graph run: history (when threaded) is carried by the
 * transcript/`history` param, NOT by checkpoint-accumulated channels. So clearing
 * the checkpoint after a resolved turn — and before a fresh turn — never loses
 * intended history. A PAUSED turn intentionally leaves the checkpoint in place
 * (it is what `resume` needs). Best-effort: a missing/nonexistent thread is a
 * no-op (the UPDATE matches zero rows).
 */
// Module-memoized checkpointer for clearConversationThread — constructed once over
// the shared pool and reused, rather than allocating a fresh saver per call.
let _clearCheckpointer: ConversationDocCheckpointSaver | null = null;
function getClearCheckpointer(): ConversationDocCheckpointSaver {
  if (!_clearCheckpointer) _clearCheckpointer = new ConversationDocCheckpointSaver(defaultPool);
  return _clearCheckpointer;
}

export async function clearConversationThread(conversationId: string): Promise<void> {
  await getClearCheckpointer().deleteThread(conversationId);
}

// RUBRIC labels/hints + BY_WHEN_HINT come from the canonical plan-review-config
// (C2) so the pieces shape is identical to the shipped plan-review.

// ── proactive ────────────────────────────────────────────────────────────────

export interface RunPlanReviewArgs {
  entityId: string;
  entityType?: FleetEntityType;
  ctx: FleetContext;
}

/**
 * The proactive result: a FleetPlanReview (the card sub-result) plus the
 * differentiating diagnosis / next-action (F1/F3). `available` is false when the
 * provider is unavailable or the model degraded — U8 maps that to "unavailable".
 */
export interface RunPlanReviewResult {
  planReview: FleetPlanReview;
  /** One-sentence "why is it stuck" diagnosis, when the model produced one. */
  diagnosis: string | null;
  /** Recommended next action, when the model produced one. */
  recommendedNextAction: string | null;
  /** True when the model contributed (vs. unavailable/degraded). */
  available: boolean;
}

export async function runPlanReview(
  args: RunPlanReviewArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<RunPlanReviewResult> {
  const entityType = args.entityType ?? 'project';
  // Proactive has no conversation thread and never pauses. Use a random UUID as
  // a transient thread_id: it is a valid uuid (the checkpointer casts the join
  // key to uuid) that matches NO documents row, so getTuple returns undefined
  // (fresh run) and put/UPDATE matches zero rows (no persistence). Single-shot.
  const config: RunnableConfig = {
    configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: '' },
    metadata: { environment: LANGSMITH_ENV },
  };

  const final = await graph.invoke(
    { mode: 'plan_review', entityId: args.entityId, entityType, ctx: args.ctx },
    config
  );

  const analysis = final.analysis as FleetAnalysis | null;
  const ai = (analysis?.planReview as PlanReviewAi | undefined) ?? undefined;

  // Build the FleetPlanReview from the structured AI output, mirroring the
  // shipped plan-review mapping exactly (so U8's card contract is unchanged).
  if (ai && analysis?.aiAvailable) {
    const metIds = new Set(ai.criteria.filter((c) => c.met).map((c) => c.id));
    const aiPieces: FleetHypothesisPiece[] = RUBRIC.map((r) => ({
      id: r.id,
      label: r.label,
      met: metIds.has(r.id),
      hint: r.hint,
    }));
    const focal = final.fetched?.focal ?? null;
    const byWhenMet = hasText(focal?.properties.targetDate ?? null);
    const pieces: FleetHypothesisPiece[] = [
      ...aiPieces,
      { id: 'by_when', label: 'By when', met: byWhenMet, hint: BY_WHEN_HINT },
    ];
    const planReview: FleetPlanReview = {
      status: pieces.every((p) => p.met) ? 'looks_testable' : 'needs_work',
      pieces,
      suggested_rewrite: ai.suggested_rewrite.trim() || null,
      ai_available: true,
    };
    return {
      planReview,
      diagnosis: ai.diagnosis.trim() || null,
      recommendedNextAction: ai.recommended_next_action.trim() || null,
      available: true,
    };
  }

  // No focal / no plan / model unavailable / degraded → unavailable plan review.
  const focal = final.fetched?.focal ?? null;
  const noPlan = !focal || !hasText(focal.properties.plan);
  const planReview: FleetPlanReview = {
    status: noPlan ? 'no_plan' : 'needs_work',
    pieces: [],
    suggested_rewrite: null,
    ai_available: false,
  };
  return { planReview, diagnosis: null, recommendedNextAction: null, available: false };
}

// ── retro recommendation (proactive, graph-backed advisory verdict) ──────────

export interface RunRetroRecommendationArgs {
  entityId: string;
  entityType?: FleetEntityType;
  ctx: FleetContext;
}

/**
 * Drive the compiled graph in `retro` mode and lift the advisory recommendation
 * into a `FleetRetroRecommendation` (the Project Retro panel contract). Mirrors
 * `runPlanReview`: a transient random thread_id (no conversation, never pauses),
 * single-shot, never throws — a degraded model yields an `ai_available: false`
 * result identical to `unavailableRetroRecommendation()` so `getReview`'s
 * persistence gate (`retroRec.ai_available`) is unchanged.
 *
 * Unlike the prior direct `evaluateStructured` call, the graph path emits a
 * named, nested LangSmith trace (scope → fetch → reason → ChatAnthropic) carrying
 * `feature: 'retro_recommendation'` + `projectId` metadata, so retro runs are
 * filterable instead of surfacing as anonymous root spans.
 */
export async function runRetroRecommendation(
  args: RunRetroRecommendationArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<FleetRetroRecommendation> {
  const entityType = args.entityType ?? 'project';
  const config: RunnableConfig = {
    configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: '' },
    metadata: { environment: LANGSMITH_ENV, projectId: args.entityId, feature: 'retro_recommendation' },
    runName: 'fleet.retro_recommendation',
  };

  const final = await graph.invoke(
    { mode: 'retro', entityId: args.entityId, entityType, ctx: args.ctx },
    config
  );

  const analysis = final.analysis as FleetAnalysis | null;
  const ai = (analysis?.retroReview as RetroRecAi | undefined) ?? undefined;

  if (ai && analysis?.aiAvailable) {
    return {
      recommendation: ai.recommendation,
      explanation: ai.explanation,
      evidence_found: ai.evidence_found,
      evidence_missing: ai.evidence_missing,
      suggested_conclusion: ai.suggested_conclusion.trim() || null,
      diagnosis: ai.diagnosis.trim() || null,
      recommended_next_action: ai.recommended_next_action.trim() || null,
      proposed_action: proposedActionFor(ai.recommendation),
      ai_available: true,
    };
  }

  // Model unavailable / degraded / focal not visible → unavailable retro rec
  // (shape matches fleet-service.ts's unavailableRetroRecommendation()).
  return {
    recommendation: 'insufficient_evidence',
    explanation: 'Fleet recommendation requires a configured AI provider.',
    evidence_found: [],
    evidence_missing: [],
    suggested_conclusion: null,
    diagnosis: null,
    recommended_next_action: null,
    proposed_action: null,
    ai_available: false,
  };
}

/**
 * Derive the confirmable outcome write from the advisory recommendation. Fleet
 * proposes; the user confirms via the Apply endpoint. `insufficient_evidence`
 * proposes nothing — there is no outcome to commit yet.
 */
function proposedActionFor(rec: RetroRecAi['recommendation']): FleetProposedAction | null {
  if (rec === 'validated_recommended') {
    return { kind: 'set_plan_validated', plan_validated: true, summary: 'Mark this plan validated and close the retro.' };
  }
  if (rec === 'invalidated_recommended') {
    return { kind: 'set_plan_validated', plan_validated: false, summary: 'Mark this plan invalidated and close the retro.' };
  }
  return null;
}

// ── dedup (on-demand, graph-backed duplicate verdict) ────────────────────────

export interface RunDedupReviewArgs {
  /** The in-progress issue title the author is typing. */
  draftTitle: string;
  /** The draft issue's id — excluded from candidates AND the graph entityId. */
  excludeId: string;
  ctx: FleetContext;
}

/**
 * Two-stage dedup verdict. Stage 1 retrieves pg_trgm candidates (cheap, no
 * model). Stage 2 runs the SAME compiled graph in `dedup` mode
 * (scope→fetch→reason(structured)→output) so the model judges which candidates
 * are TRUE duplicates and why. Short-circuits WITHOUT a model call when there
 * are no candidates. Like runPlanReview it uses a transient random thread_id
 * (no conversation, never pauses) and never throws — a degraded model yields a
 * verdict-less result (candidates only).
 */
export async function runDedupReview(
  args: RunDedupReviewArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<FleetDedupReview> {
  // Stage 1: cheap, visibility-scoped pg_trgm candidate retrieval.
  const candidates = await findSimilarIssues({
    ctx: args.ctx,
    title: args.draftTitle,
    excludeId: args.excludeId,
  });

  // Nothing similar ⇒ nothing to judge. Short-circuit before any model call.
  if (candidates.length === 0) {
    return { candidates: [], matches: [], summary: null, recommendation: null, ai_available: false };
  }

  // Stage 2: judge through the graph. Transient thread_id (no persistence).
  const config: RunnableConfig = {
    configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: '' },
    metadata: { environment: LANGSMITH_ENV },
  };
  const final = await graph.invoke(
    {
      mode: 'dedup',
      entityId: args.excludeId,
      entityType: 'issue',
      ctx: args.ctx,
      draftTitle: args.draftTitle,
      candidates,
    },
    config
  );

  const analysis = final.analysis as FleetAnalysis | null;
  const ai = (analysis?.dedupReview as DedupReviewAi | undefined) ?? undefined;

  // Model unavailable / degraded → return the candidates with no verdict so the
  // client can still show the (stage-1) possible-duplicate list.
  if (!ai || !analysis?.aiAvailable) {
    return { candidates, matches: [], summary: null, recommendation: null, ai_available: false };
  }

  // Map the model's 1-based candidate indexes back to candidates; drop any
  // out-of-range index defensively (a hallucinated index references nothing).
  const matches: FleetDedupMatch[] = ai.duplicates
    .map((d): FleetDedupMatch | null => {
      const candidate = candidates[d.index - 1];
      if (!candidate) return null;
      return { candidate, confidence: d.confidence, reason: d.reason };
    })
    .filter((m): m is FleetDedupMatch => m !== null);

  return {
    candidates,
    matches,
    summary: ai.summary.trim() || null,
    recommendation: ai.recommendation.trim() || null,
    ai_available: true,
  };
}

// ── related (on-demand, graph-backed theme grouping over the open-issue set) ──

export interface RunRelatedGroupsArgs {
  ctx: FleetContext;
  /** Recency cap on issues analyzed (defaults to fetchOpenIssuesForClustering's). */
  limit?: number;
}

/**
 * In-memory grouping cache (R: cost-bounding for the auto-on-view trigger).
 *
 * The "Related" view runs automatically when opened, so without a cache a fresh
 * page load would re-run a whole-workspace LLM call every time. We cache the
 * result keyed on the VISIBILITY-SCOPED issue-set fingerprint (workspace + a hash
 * of each issue's id:updated_at). Because the fingerprint is derived from the
 * fetched set, a user only ever hits a cache entry for the exact set they can
 * see — no cross-visibility leakage. Consistent with the other in-memory caches
 * in this service (fleet-ai rate limiters); table-free, per-process, TTL'd.
 */
const RELATED_CACHE_TTL_MS = 5 * 60 * 1000;
interface RelatedCacheEntry {
  result: FleetIssueGroupingResult;
  expiresAt: number;
}
const relatedCache = new Map<string, RelatedCacheEntry>();

/** Test-only: clear the in-memory grouping cache. */
export function __resetRelatedGroupsCacheForTests(): void {
  relatedCache.clear();
}

function relatedCacheKey(workspaceId: string, fingerprintSource: string): string {
  return `${workspaceId}:${crypto.createHash('sha1').update(fingerprintSource).digest('hex')}`;
}

/** A candidates-only result (no model contribution) — the flat-list fallback. */
function degradedGrouping(
  candidates: FleetIssueGroupingResult['candidates'],
  truncated: boolean
): FleetIssueGroupingResult {
  return {
    candidates,
    groups: [],
    ungroupedIds: candidates.map((c) => c.id),
    summary: null,
    ai_available: false,
    analyzed_count: candidates.length,
    truncated,
  };
}

/**
 * Group the workspace's open issues by theme. Stage 1 fetches the
 * visibility-scoped open-issue set (cheap, no model). Stage 2 runs the SAME
 * compiled graph in `related` mode so the model clusters them. Short-circuits
 * WITHOUT a model call when there are fewer than two issues. Like runDedupReview
 * it uses a transient random thread_id (no conversation, never pauses) and never
 * throws — a degraded model yields a candidates-only result the client renders
 * as a flat list. Results are cached per visibility-scoped issue-set fingerprint.
 */
export async function runRelatedGroups(
  args: RunRelatedGroupsArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<FleetIssueGroupingResult> {
  // Stage 1: cheap, visibility-scoped open-issue retrieval (with truncated body).
  const { candidates, truncated } = await fetchOpenIssuesForClustering({
    ctx: args.ctx,
    limit: args.limit,
  });

  // Fewer than two issues ⇒ nothing to group. Short-circuit before any model call.
  if (candidates.length < 2) {
    return degradedGrouping(candidates, truncated);
  }

  // Cache by the visibility-scoped issue-set fingerprint. A re-open within the
  // TTL returns the cached grouping with no model call.
  const fingerprint = candidates
    .map((c) => `${c.id}:${c.updated_at}`)
    .sort()
    .join('|');
  const key = relatedCacheKey(args.ctx.workspaceId, fingerprint);
  const now = Date.now();
  const cached = relatedCache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.result;
  }

  // Stage 2: group through the graph. Transient thread_id (no persistence). A
  // random-uuid entityId means the focal fetch finds nothing (reasonRelated runs
  // before the focal guard, so the denied focal is irrelevant). Wrapped so any
  // throw degrades to the flat-list fallback rather than failing the request.
  const config: RunnableConfig = {
    configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: '' },
    metadata: { environment: LANGSMITH_ENV, feature: 'issue_grouping' },
    runName: 'fleet.related_groups',
  };

  let final: Record<string, unknown>;
  try {
    final = (await graph.invoke(
      {
        mode: 'related',
        entityId: crypto.randomUUID(),
        entityType: 'issue',
        ctx: args.ctx,
        issueSet: candidates,
      },
      config
    )) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `[fleetgraph] runRelatedGroups failed (workspace=${args.ctx.workspaceId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return degradedGrouping(candidates, truncated);
  }

  const analysis = final.analysis as FleetAnalysis | null;
  const ai = (analysis?.relatedReview as RelatedGroupsAi | undefined) ?? undefined;

  // Model unavailable / degraded → candidates only (the client shows a flat list).
  if (!ai || analysis?.aiAvailable !== true) {
    return degradedGrouping(candidates, truncated);
  }

  // Map each group's 1-based indexes back to issue ids. Defensive: drop
  // out-of-range (hallucinated) indexes, dedupe within a group, enforce the
  // ≥2-members invariant, and let each issue belong to AT MOST ONE group (the
  // first group that claims it wins).
  const claimed = new Set<string>();
  const groups: FleetIssueGroup[] = [];
  for (const g of ai.groups) {
    const memberIds: string[] = [];
    for (const idx of g.member_indexes) {
      const cand = candidates[idx - 1];
      if (!cand) continue; // out-of-range / hallucinated index
      if (claimed.has(cand.id) || memberIds.includes(cand.id)) continue;
      memberIds.push(cand.id);
    }
    if (memberIds.length < 2) continue; // never surface a singleton group
    memberIds.forEach((id) => claimed.add(id));
    groups.push({
      label: g.label.trim() || 'Related issues',
      memberIds,
      reason: g.reason.trim(),
    });
  }

  const ungroupedIds = candidates.filter((c) => !claimed.has(c.id)).map((c) => c.id);

  const result: FleetIssueGroupingResult = {
    candidates,
    groups,
    ungroupedIds,
    summary: ai.summary.trim() || null,
    ai_available: true,
    analyzed_count: candidates.length,
    truncated,
  };

  relatedCache.set(key, { result, expiresAt: now + RELATED_CACHE_TTL_MS });
  return result;
}

// ── drift (proactive, sweep-triggered drift verdict) ─────────────────────────

/**
 * Single wall-clock timeout (ms) around the entire `graph.invoke` for drift.
 * Exported so tests can override via {@link setDriftGraphTimeoutMsForTests}.
 * Drift is hourly cron — generous wall-clock, no per-node budgets.
 */
export const DRIFT_GRAPH_TIMEOUT_MS = 60_000;

let driftGraphTimeoutMs: number = DRIFT_GRAPH_TIMEOUT_MS;

/**
 * Test-only seam. Lets graph.test.ts shrink the wall-clock to assert the
 * timeout path in finite time without mutating the exported constant.
 */
export function setDriftGraphTimeoutMsForTests(ms: number): void {
  driftGraphTimeoutMs = ms;
}

/**
 * Thrown internally by `runDriftReasoning` when the wall-clock fires before
 * `graph.invoke` resolves. Caller does not see it — it is caught and mapped to
 * `{available: false}` like every other failure. Exported so tests can
 * discriminate timeout from generic throws.
 *
 * CAVEAT: Promise.race does not cancel the in-flight LLM call — it just stops
 * awaiting. The graph (and its model SDK call) continues executing in the
 * background until completion or failure. Connection-pool resources release on
 * completion. If observed in practice, follow-up adds AbortController wiring.
 */
export class DriftGraphTimeoutError extends Error {
  constructor() {
    super('Drift graph run exceeded timeout');
    this.name = 'DriftGraphTimeoutError';
  }
}

export interface RunDriftReasoningArgs {
  entityId: string;
  signals: DriftSignal[];
  ctx: FleetContext;
  /**
   * Trace metadata forwarded to BOTH `RunnableConfig.metadata` (LangChain
   * auto-trace root) and the drift reason branch's `evaluateStructured.metadata`
   * (per-SDK-call wrapped span). Caller (sweep) sets exactly
   * `{workspace_id, sweep_run_id}` — both UUIDs.
   */
  traceMetadata?: Record<string, string>;
}

export type RunDriftReasoningResult =
  | { available: true; verdict: InsightVerdict }
  | { available: false };

/**
 * Drive the compiled graph end-to-end for a single drifting project and lift
 * the model's `{decision, reasoning}` verdict.
 *
 * Contract:
 *   - Never throws. Any error (timeout, graph throw, missing verdict, degraded
 *     analysis) returns `{available: false}`; sweep applies its deterministic
 *     fallback.
 *   - Service-principal expected: `args.ctx.userId` is the sentinel SYSTEM_USER_ID
 *     and `args.ctx.isAdmin: true`, giving workspace-wide read access via
 *     VISIBILITY_FILTER_SQL's existing admin short-circuit. `args.ctx.workspaceId`
 *     scopes the run to one workspace.
 *   - Timeout caveat: `Promise.race` does NOT cancel an in-flight LLM call. The
 *     graph continues in the background after we stop awaiting it; the pool
 *     connection releases on completion. See {@link DriftGraphTimeoutError}.
 */
export async function runDriftReasoning(
  args: RunDriftReasoningArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<RunDriftReasoningResult> {
  const runConfig: RunnableConfig = {
    configurable: { thread_id: crypto.randomUUID(), checkpoint_ns: '' },
    metadata: { environment: LANGSMITH_ENV, ...(args.traceMetadata ?? {}) },
  };

  const initialState = {
    mode: 'drift' as const,
    entityId: args.entityId,
    entityType: 'project' as const,
    ctx: args.ctx,
    driftSignals: args.signals,
    traceMetadata: args.traceMetadata ?? null,
  };

  let timerId: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => reject(new DriftGraphTimeoutError()), driftGraphTimeoutMs);
    });
    const final = (await Promise.race([
      graph.invoke(initialState, runConfig),
      timeoutPromise,
    ])) as Record<string, unknown>;
    if (timerId) clearTimeout(timerId);

    const analysis = final.analysis as FleetAnalysis | null;
    const dr = analysis?.driftReview as DriftVerdictAi | undefined;
    if (!dr || final.degraded === true || analysis?.aiAvailable !== true) {
      return { available: false };
    }
    return {
      available: true,
      verdict: { decision: dr.decision, reasoning: dr.reasoning },
    };
  } catch (err) {
    if (timerId) clearTimeout(timerId);
    const errName = err instanceof Error ? err.name : 'Unknown';
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(
      `[fleetgraph] runDriftReasoning failed (workspace=${args.ctx.workspaceId}): ${errName}: ${errMessage}`
    );
    return { available: false };
  }
}

// ── chat ───────────────────────────────────────────────────────────────────

export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunChatTurnArgs {
  conversationDocId: string;
  entityId: string;
  entityType: FleetEntityType;
  message: string;
  ctx: FleetContext;
  /** Prior transcript (U9 supplies; threaded into the message channel). */
  history?: ChatHistoryEntry[];
}

export type ChatTurnResult =
  | { status: 'answer'; answer: string; threadId: string; executed?: unknown }
  | { status: 'paused'; proposal: WriteProposal; threadId: string };

function chatConfig(conversationDocId: string): RunnableConfig {
  return {
    configurable: { thread_id: conversationDocId, checkpoint_ns: '' },
    metadata: { environment: LANGSMITH_ENV },
  };
}

interface InterruptEntry {
  value: InterruptPayload;
}

function interpretResult(
  threadId: string,
  final: Record<string, unknown>
): ChatTurnResult {
  // A paused run surfaces the interrupt(s) on the invoke RESULT under the
  // `__interrupt__` key (verified against @langchain/langgraph 1.x). This is the
  // canonical, checkpointer-agnostic signal — preferred over re-reading state.
  const interrupts = final.__interrupt__ as InterruptEntry[] | undefined;
  if (interrupts && interrupts.length > 0) {
    const payload = interrupts[0]!.value;
    return { status: 'paused', proposal: payload.proposal, threadId };
  }
  return {
    status: 'answer',
    answer: (final.answer as string) ?? '',
    threadId,
    executed: final.executed,
  };
}

/**
 * Run one chat turn. Returns an answer, or pauses with a proposal awaiting
 * confirmation. U9 streams the turn (this returns the resolved final/interrupt
 * shape; U9 wraps `graph.stream` for token streaming — the same compiled graph
 * + config). The thread_id IS the conversation doc id (the checkpointer join key).
 */
export async function runChatTurn(
  args: RunChatTurnArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<ChatTurnResult> {
  const config = chatConfig(args.conversationDocId);
  const final = await graph.invoke(
    {
      mode: 'chat',
      entityId: args.entityId,
      entityType: args.entityType,
      ctx: args.ctx,
      conversationDocId: args.conversationDocId,
      message: args.message,
    },
    config
  );
  return interpretResult(args.conversationDocId, final as Record<string, unknown>);
}

// ── streaming (U9) ───────────────────────────────────────────────────────────

/**
 * A streamed chat event. U9's SSE route serializes these as SSE frames; U10
 * parses them client-side:
 *   - `token`: an incremental chunk of the assistant's prose answer.
 *   - `final`: the turn resolved with an answer (terminal).
 *   - `paused`: the graph paused awaiting confirmation; carries the proposal
 *     (terminal — the client surfaces a confirm/decline UI and calls the
 *     confirm endpoint, which resumes on the same thread_id).
 */
export type ChatStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'final'; answer: string; threadId: string; executed?: unknown }
  | { type: 'paused'; proposal: WriteProposal; threadId: string };

export interface StreamChatTurnArgs extends RunChatTurnArgs {
  /** Abort signal wired to the client connection close (U9 route). */
  signal?: AbortSignal;
}

/**
 * Stream one chat turn token-by-token. Reuses the SAME compiled graph instance as
 * runChatTurn (default `getCompiledGraph()`) so the U3 checkpointer + thread_id
 * config are shared — there is exactly ONE compiled graph in the process. We
 * stream with `streamMode: ['messages','values']`:
 *   - `messages` chunks carry per-token model output (the chat prose answer).
 *   - `values` chunks carry full state; the final one bears `__interrupt__` (when
 *     paused) or the finalized `answer`.
 *
 * The terminal event is derived from the LAST `values` payload (the canonical,
 * checkpointer-agnostic signal, matching runChatTurn's `__interrupt__` detection)
 * rather than from token accumulation, so a tool-call turn (no prose tokens) that
 * pauses still yields the proposal. `config.signal` carries the abort signal so a
 * client disconnect aborts the run.
 */
export async function* streamChatTurn(
  args: StreamChatTurnArgs,
  graph: CompiledGraph = getCompiledGraph()
): AsyncGenerator<ChatStreamEvent> {
  const config: RunnableConfig = {
    ...chatConfig(args.conversationDocId),
    signal: args.signal,
  };

  // Clear any stale checkpoint left by a RESOLVED prior turn before this fresh
  // run, so the new message runs cleanly instead of resuming stale graph state.
  // (A PAUSED prior turn is gated upstream by the route's isPending 409, so we
  // never reach here with a legitimately pending checkpoint to preserve.)
  // Best-effort, matching the other three clearConversationThread sites: a DB
  // blip here must not fail the whole turn after the user message was already
  // persisted + the rate-limit token billed.
  await clearConversationThread(args.conversationDocId).catch((err) =>
    console.warn(
      '[fleetgraph] start-of-turn clear failed (non-fatal):',
      err instanceof Error ? err.message : err
    )
  );

  let lastValues: Record<string, unknown> | undefined;

  const stream = await graph.stream(
    {
      mode: 'chat',
      entityId: args.entityId,
      entityType: args.entityType,
      ctx: args.ctx,
      conversationDocId: args.conversationDocId,
      message: args.message,
    },
    { ...config, streamMode: ['messages', 'values'] }
  );

  for await (const chunk of stream) {
    // With multiple stream modes, each chunk is [mode, payload].
    const [mode, payload] = chunk as [string, unknown];
    if (mode === 'messages') {
      // payload is [messageChunk, metadata]; only AI message chunks carry prose
      // tokens. HumanMessage (added by the scope node) is also streamed here and
      // must be skipped — otherwise the user's question echoes into the assistant
      // bubble before the real response arrives.
      const [msg] = payload as [unknown, unknown];
      if (!(msg instanceof AIMessageChunk)) continue;
      const text = typeof (msg as AIMessageChunk).content === 'string' ? (msg as AIMessageChunk).content as string : '';
      if (text) yield { type: 'token', token: text };
    } else if (mode === 'values') {
      lastValues = payload as Record<string, unknown>;
    }
  }

  const result = interpretResult(args.conversationDocId, lastValues ?? {});
  if (result.status === 'paused') {
    // PAUSED: keep the checkpoint — `resume` needs it.
    yield { type: 'paused', proposal: result.proposal, threadId: result.threadId };
  } else {
    // RESOLVED with a terminal answer: clear the checkpoint so a SECOND turn on
    // this conversation runs fresh and never resumes this turn's stale state.
    // Best-effort: a clear failure must not fail the answer the client already
    // received, so we swallow it (the start-of-turn clear is the backstop).
    await clearConversationThread(args.conversationDocId).catch(() => {});
    yield {
      type: 'final',
      answer: result.answer,
      threadId: result.threadId,
      executed: result.executed,
    };
  }
}

export interface ResumeChatTurnArgs {
  conversationDocId: string;
  approved: boolean;
}

/**
 * Resume a paused chat turn. Sends Command({ resume:{approved} }) on the same
 * thread_id. approved:true executes the confirmed write (exactly the surfaced
 * proposal); approved:false abandons it. Returns the resolved answer.
 */
export async function resumeChatTurn(
  args: ResumeChatTurnArgs,
  graph: CompiledGraph = getCompiledGraph()
): Promise<ChatTurnResult> {
  const config = chatConfig(args.conversationDocId);
  const resume: ResumeValue = { approved: args.approved };
  const final = await graph.invoke(new Command({ resume }), config);
  const result = interpretResult(args.conversationDocId, final as Record<string, unknown>);
  // A resumed turn ALWAYS resolves (confirm executes; decline abandons) — there
  // is no second interrupt. Clear the checkpoint so the conversation is clean for
  // the next turn (and a double-confirm cannot re-enter a stale paused state).
  // Best-effort: a clear failure must not fail the already-committed write.
  if (result.status !== 'paused') {
    await clearConversationThread(args.conversationDocId).catch(() => {});
  }
  return result;
}

export { getCompiledGraph, compileGraph } from './graph.js';
