/**
 * FleetGraph shared graph state (U7).
 *
 * One `Annotation`-based state object serves BOTH entry inputs:
 *   - proactive plan-review: { mode:'plan_review', entityId, entityType }
 *   - on-demand chat:        { mode:'chat', entityId, entityType, message, history }
 *
 * Annotation is used here (not zod) per the plan: zero zod coupling in graph
 * state — zod is reserved for tool/output schemas (U4/U6). LangGraph reducers
 * decide how each channel merges when a node returns a partial update.
 *
 * ── REDUCER CHOICES (and why) ───────────────────────────────────────────────
 *
 *  - `messages`: APPEND (concat). The chat tool-loop accumulates Human / AI /
 *    Tool messages across model turns. We use LangGraph's `messagesStateReducer`
 *    so message-id de-duplication / replacement works like MessagesAnnotation.
 *
 *  - `fetched`: REPLACE (last-write-wins). U5's fetch node returns a COMPLETE
 *    consolidated snapshot (`FetchNodeOutput`) — every key is a full picture, not
 *    an increment. Even if U7 later fanned the fetch out into per-slice nodes,
 *    each slice is independent (per-key replace, no cross-key conflict), so a
 *    whole-object replace is still correct. Documented in nodes/fetch.ts.
 *
 *  - `analysis`: REPLACE. The reasoning node emits at most one analysis object
 *    per run; a later node never partially updates it.
 *
 *  - `proposal`: REPLACE. At most one pending write proposal is in flight per
 *    turn (the U3 checkpointer is latest-tuple-only and U9 enforces one in-flight
 *    turn per conversation). The reasoning node sets it; policy reads it.
 *
 *  - Scalar scope channels (`mode`, `entityId`, `entityType`, `ctx`,
 *    `conversationDocId`, `answer`, `executed`, `degraded`): REPLACE — seeded
 *    once at scope and overwritten if a node revises them.
 */

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { FleetContext } from './tools/read.js';
import type { FleetEntityType } from './tools/read.js';
import type { FetchNodeOutput } from './nodes/fetch.js';
import type { WriteProposal, ExecuteResult } from './tools/write.js';
import type { FleetDedupCandidate, FleetIssueGroupCandidate, DriftSignal } from '@ship/shared';

export type FleetMode = 'plan_review' | 'chat' | 'dedup' | 'drift' | 'retro' | 'related';

/** The structured analysis the reasoning node produces (mode-shaped). */
export interface FleetAnalysis {
  /** Plain-text answer / insight (chat answer or proactive summary). */
  text: string;
  /**
   * For proactive plan_review: the structured plan-review payload the entry
   * point lifts into a FleetPlanReview-shaped result. Opaque to the graph.
   */
  planReview?: unknown;
  /**
   * For dedup: the structured duplicate verdict the entry point lifts into a
   * FleetDedupReview-shaped result. Opaque to the graph.
   */
  dedupReview?: unknown;
  /**
   * For drift: the structured drift verdict the entry point lifts into an
   * InsightVerdict-shaped result. Opaque to the graph; downcast at the
   * runDriftReasoning boundary.
   */
  driftReview?: unknown;
  /**
   * For retro: the structured retro recommendation the entry point lifts into a
   * FleetRetroRecommendation-shaped result. Opaque to the graph.
   */
  retroReview?: unknown;
  /**
   * For related: the structured theme-grouping the entry point lifts into a
   * FleetIssueGroupingResult-shaped result. Opaque to the graph.
   */
  relatedReview?: unknown;
  /** True when the model contributed (vs. a neutral-degraded path). */
  aiAvailable: boolean;
}

/**
 * Replace reducer factory: last write wins, defaulting to the existing value
 * when an update is omitted (LangGraph passes `undefined` for unchanged keys).
 */
function replace<T>(): (current: T, update: T | undefined) => T {
  return (current, update) => (update === undefined ? current : update);
}

export const FleetGraphState = Annotation.Root({
  // ── scope (seeded once from the entry input) ──
  mode: Annotation<FleetMode>({ reducer: replace<FleetMode>(), default: () => 'chat' }),
  entityId: Annotation<string>({ reducer: replace<string>(), default: () => '' }),
  entityType: Annotation<FleetEntityType>({ reducer: replace<FleetEntityType>(), default: () => 'project' }),
  ctx: Annotation<FleetContext | null>({ reducer: replace<FleetContext | null>(), default: () => null }),
  conversationDocId: Annotation<string | null>({ reducer: replace<string | null>(), default: () => null }),

  // ── chat input ──
  message: Annotation<string>({ reducer: replace<string>(), default: () => '' }),
  // The running message thread for the chat tool-loop (append/merge).
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),

  // ── dedup input (seeded once by the entry point) ──
  // The in-progress issue title the author is typing, and the stage-1 pg_trgm
  // candidates the reason node judges for true duplication. Both REPLACE.
  draftTitle: Annotation<string>({ reducer: replace<string>(), default: () => '' }),
  candidates: Annotation<FleetDedupCandidate[]>({ reducer: replace<FleetDedupCandidate[]>(), default: () => [] }),

  // ── related input (seeded once by the entry point) ──
  // The whole open-issue set to group by theme (fetched OUTSIDE the graph, like
  // dedup's candidates). The related reason branch judges this list directly and
  // does NOT depend on a focal entity. REPLACE.
  issueSet: Annotation<FleetIssueGroupCandidate[]>({ reducer: replace<FleetIssueGroupCandidate[]>(), default: () => [] }),

  // ── drift input (seeded once by the entry point) ──
  /**
   * The deterministic drift signals (idle / stale plan / rising incomplete work)
   * the sweep computed for the focal project. The drift reason branch serializes
   * them into the user prompt. REPLACE.
   */
  driftSignals: Annotation<DriftSignal[]>({ reducer: replace<DriftSignal[]>(), default: () => [] }),
  /**
   * Optional per-run trace metadata (mode-agnostic; today only drift threads it
   * through). The drift reason branch forwards it into `evaluateStructured`'s
   * `metadata` field so LangSmith spans are filterable by e.g. `workspace_id` +
   * `sweep_run_id`. REPLACE.
   */
  traceMetadata: Annotation<Record<string, string> | null>({
    reducer: replace<Record<string, string> | null>(),
    default: () => null,
  }),

  // ── fetched context (REPLACE — complete snapshot from U5) ──
  fetched: Annotation<FetchNodeOutput | null>({ reducer: replace<FetchNodeOutput | null>(), default: () => null }),

  // ── reasoning output ──
  analysis: Annotation<FleetAnalysis | null>({ reducer: replace<FleetAnalysis | null>(), default: () => null }),

  // ── proposed write (chat only; policy routes on this) ──
  proposal: Annotation<WriteProposal | null>({ reducer: replace<WriteProposal | null>(), default: () => null }),

  // ── terminal outputs ──
  answer: Annotation<string>({ reducer: replace<string>(), default: () => '' }),
  /** Set by the action node AFTER interrupt+execute (resume path). */
  executed: Annotation<ExecuteResult | null>({ reducer: replace<ExecuteResult | null>(), default: () => null }),
  /** True when the action node ran but the proposal was declined. */
  declined: Annotation<boolean>({ reducer: replace<boolean>(), default: () => false }),
  /** True when a model error / unavailability degraded the run to neutral. */
  degraded: Annotation<boolean>({ reducer: replace<boolean>(), default: () => false }),
});

/** The fully-typed graph state. */
export type FleetGraphStateType = typeof FleetGraphState.State;
/** A partial update a node may return. */
export type FleetGraphUpdate = Partial<FleetGraphStateType>;
