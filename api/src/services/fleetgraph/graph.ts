/**
 * Graph assembly (U7) — R1.
 *
 * ── SHAPE (one compiled graph, two entry inputs) ────────────────────────────
 *
 *   START
 *     │
 *     ▼
 *   scope          (validate seeded ctx; seed chat message into messages)
 *     │
 *     ▼
 *   fetch          (U5 consolidated parallel, visibility-filtered snapshot)
 *     │
 *     ▼
 *   reason         (two-tier: proactive→fleet-ai structured; chat→bound chat model)
 *     │
 *     ▼
 *   policy         (pass-through; conditional edge classifies)
 *     │
 *     ├── policyRoute=='output' ──▶ output ──▶ END
 *     └── policyRoute=='action' ──▶ action
 *                                     │  interrupt(proposal) → pause
 *                                     │  (resume re-runs action from top;
 *                                     │   executeProposal AFTER interrupt)
 *                                     ▼
 *                                   END
 *
 * Both modes share scope + fetch wholesale. The reason node BRANCHES INTERNALLY
 * by mode (proactive emits a structured insight; chat may emit a tool call). The
 * policy node routes by proposal presence, so the action node is reachable only
 * in chat with a proposed write. (Decision resolved per plan "Deferred to
 * Implementation": shared scope+fetch; reason/policy/output branch by mode.)
 *
 * ── COMPILE + POOL ──────────────────────────────────────────────────────────
 *
 * The graph is compiled with the U3 `ConversationDocCheckpointSaver`, which takes
 * the pg pool by CONSTRUCTOR injection. We import `pool` from `../../db/client.js`
 * at module load — that module initializes the pool eagerly on import — and pass
 * the already-live pool into the saver. So a module-load compile never captures
 * an unconnected pool. (index.ts imports this module, importing db/client first.)
 */

import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { pool as defaultPool } from '../../db/client.js';
import { ConversationDocCheckpointSaver } from './checkpointer.js';
import { FleetGraphState } from './state.js';
import { scopeNode } from './nodes/scope.js';
import { fetchNode } from './nodes/fetch.js';
import { makeReasonNode, type ReasonNodeDeps } from './nodes/reason.js';
import { policyRoute } from './nodes/policy.js';
import { makeActionNode, type ActionNodeDeps } from './nodes/action.js';
import type { FleetGraphStateType, FleetGraphUpdate } from './state.js';

/** The output node: finalizes `answer` from the analysis when not already set. */
function outputNode(state: FleetGraphStateType): FleetGraphUpdate {
  if (state.answer) return {};
  if (state.analysis) return { answer: state.analysis.text };
  return { answer: '' };
}

/** The fetch node adapter: reads the seeded scope and returns the snapshot slice. */
async function fetchNodeAdapter(state: FleetGraphStateType): Promise<FleetGraphUpdate> {
  const fetched = await fetchNode({
    ctx: state.ctx!,
    entityId: state.entityId,
    entityType: state.entityType,
  });
  return { fetched };
}

export interface BuildGraphDeps {
  /** Reasoning-node deps (model override / availability override) — test seam. */
  reason?: ReasonNodeDeps;
  /** Action-node deps (executor override) — test seam. */
  action?: ActionNodeDeps;
}

/**
 * Build (uncompiled) the shared StateGraph with injectable node deps. Kept
 * separate from compilation so tests can compile with a fresh checkpointer
 * bound to the shared pool + a scripted model.
 */
export function buildGraph(deps: BuildGraphDeps = {}) {
  const reasonNode = makeReasonNode(deps.reason);
  const actionNode = makeActionNode(deps.action);

  // M-03: the former `policy` node was a pure pass-through; the classification is
  // entirely in `policyRoute` (a pure function). We attach the conditional edge
  // DIRECTLY after `reason` and drop the no-op node. `policyRoute` stays exported
  // and unit-tested in policy.ts.
  return new StateGraph(FleetGraphState)
    .addNode('scope', scopeNode)
    .addNode('fetch', fetchNodeAdapter)
    .addNode('reason', reasonNode)
    .addNode('action', actionNode)
    .addNode('output', outputNode)
    .addEdge(START, 'scope')
    .addEdge('scope', 'fetch')
    .addEdge('fetch', 'reason')
    .addConditionalEdges('reason', policyRoute, { action: 'action', output: 'output' })
    .addEdge('action', END)
    .addEdge('output', END);
}

export interface CompileGraphOptions extends BuildGraphDeps {
  /** Override the checkpointer (tests pass one bound to the shared pool). */
  checkpointer?: BaseCheckpointSaver;
}

/**
 * Compile the graph with the U3 checkpointer. Pass `checkpointer` to inject one
 * (tests); otherwise a `ConversationDocCheckpointSaver` is built over the
 * already-initialized shared pool.
 */
export function compileGraph(options: CompileGraphOptions = {}) {
  const checkpointer =
    options.checkpointer ?? new ConversationDocCheckpointSaver(defaultPool);
  return buildGraph(options).compile({ checkpointer });
}

/**
 * The process-wide compiled graph for production use, built ONCE over the shared
 * pool + the real (env-resolved) model seam. Lazily compiled on first access so
 * a fresh checkpointer is constructed only after the pool is live.
 */
let _compiled: ReturnType<typeof compileGraph> | null = null;
export function getCompiledGraph(): ReturnType<typeof compileGraph> {
  if (!_compiled) _compiled = compileGraph();
  return _compiled;
}

/** Test-only: drop the cached compiled graph. */
export function __resetCompiledGraphForTests(): void {
  _compiled = null;
}
