/**
 * FleetGraph public entry points (U7).
 *
 * Three callers drive the ONE compiled graph:
 *
 *   runPlanReview()   — proactive plan-review (U8 calls this from getReview's
 *                       shell). Runs scope→fetch→reason(structured)→policy→output.
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
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  FleetPlanReview,
  FleetHypothesisPiece,
} from '@ship/shared';
import { hasText } from '../fleet-checks.js';
import { getCompiledGraph, compileGraph } from './graph.js';
import type { FleetContext, FleetEntityType } from './tools/read.js';
import type { WriteProposal } from './tools/write.js';
import type { FleetAnalysis } from './state.js';
import type { PlanReviewAi } from './nodes/reason.js';
import type { InterruptPayload, ResumeValue } from './nodes/action.js';

type CompiledGraph = ReturnType<typeof compileGraph>;

// The RUBRIC labels/hints, mirrored from fleet-service.ts so the pieces shape is
// identical to the shipped plan-review.
const RUBRIC: { id: FleetHypothesisPiece['id']; label: string; hint: string }[] = [
  { id: 'what_changes', label: 'What will change', hint: 'Name the outcome that will change.' },
  { id: 'by_how_much', label: 'By how much', hint: 'Add a target number (by how much).' },
  { id: 'for_whom', label: 'For whom', hint: 'Say who this is for (user, segment, or system).' },
];
const BY_WHEN_HINT = 'Set a Target Date (by when).';

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
  };

  const final = await graph.invoke(
    { mode: 'plan_review', entityId: args.entityId, entityType, ctx: args.ctx },
    config
  );

  const analysis = final.analysis as FleetAnalysis | null;
  const ai = (analysis?.planReview as PlanReviewAi | undefined) ?? undefined;

  // Build the FleetPlanReview from the structured AI output, mirroring the
  // shipped buildPlanReview mapping exactly (so U8's card contract is unchanged).
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
  return { configurable: { thread_id: conversationDocId, checkpoint_ns: '' } };
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
  return interpretResult(args.conversationDocId, final as Record<string, unknown>);
}

export { getCompiledGraph, compileGraph } from './graph.js';
