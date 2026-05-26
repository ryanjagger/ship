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
import { pool as defaultPool } from '../../db/client.js';
import { ConversationDocCheckpointSaver } from './checkpointer.js';
import { RUBRIC, BY_WHEN_HINT } from './plan-review-config.js';
import { getCompiledGraph, compileGraph } from './graph.js';
import type { FleetContext, FleetEntityType } from './tools/read.js';
import type { WriteProposal } from './tools/write.js';
import type { FleetAnalysis } from './state.js';
import type { PlanReviewAi } from './nodes/reason.js';
import type { InterruptPayload, ResumeValue } from './nodes/action.js';

type CompiledGraph = ReturnType<typeof compileGraph>;

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
export async function clearConversationThread(conversationId: string): Promise<void> {
  const checkpointer = new ConversationDocCheckpointSaver(defaultPool);
  await checkpointer.deleteThread(conversationId);
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
  await clearConversationThread(args.conversationDocId);

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
      // payload is [messageChunk, metadata]; emit only non-empty string content.
      const [msg] = payload as [{ content?: unknown }, unknown];
      const text = typeof msg?.content === 'string' ? msg.content : '';
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
