/**
 * Action node (U7) — R5, the human-in-the-loop write.
 *
 * ── THE CRITICAL HITL FOOTGUN (and how this node defuses it) ────────────────
 *
 * On `interrupt(proposal)`, LangGraph pauses the graph and surfaces the payload
 * to the caller. On resume via `Command({ resume })`, LangGraph RE-RUNS THIS
 * NODE FROM THE TOP — `interrupt()` then RETURNS the resume value instead of
 * pausing again. Therefore:
 *
 *   1. The mutation (`executeProposal`) is called STRICTLY AFTER the
 *      `interrupt()` line. On the initial run, control never reaches it (the node
 *      suspends at interrupt). It runs only on the resume pass.
 *
 *   2. Any work BEFORE `interrupt()` runs TWICE (initial + resume) and so must be
 *      idempotent / side-effect-free. Here the only pre-interrupt work is reading
 *      `state.proposal` — pure. The model call, the fetch, the conversation-doc
 *      creation, and the rate-limit token all live UPSTREAM or OUTSIDE the graph
 *      (reason node / index.ts / U9), and resume does NOT re-run upstream nodes,
 *      so none of them double-fire.
 *
 * ── PARITY INVARIANT (security) ─────────────────────────────────────────────
 *
 * `interrupt()` serializes the COMPLETE, fully-resolved WriteProposal. On resume
 * we execute ONLY that confirmed proposal object — we NEVER re-derive args from
 * the model or graph state. `executeProposal` (U6) additionally recomputes the
 * contentHash over {kind,args} and throws on drift. So a model that "changes its
 * mind" between pause and resume cannot alter the executed write: the resumed
 * payload is the one that was surfaced and hashed.
 *
 * The resume value shape is `{ approved: boolean }`. approved:false abandons the
 * write and the graph continues to output with a declined answer.
 */

import { interrupt } from '@langchain/langgraph';
import { executeProposal, type WriteProposal, type ExecuteResult } from '../tools/write.js';
import type { FleetContext } from '../tools/read.js';
import type { FleetGraphStateType, FleetGraphUpdate } from '../state.js';

/** The payload surfaced to the caller while paused. */
export interface InterruptPayload {
  type: 'confirm_write';
  proposal: WriteProposal;
}

/** The value the caller sends back on resume. */
export interface ResumeValue {
  approved: boolean;
}

export interface ActionNodeDeps {
  /**
   * Test seam: an injected executor so the interrupt→resume loop can be tested
   * deterministically without driving real DB mutations. Defaults to the real
   * `executeProposal` from U6 (user-scoped, audited, transactional).
   */
  execute?: (ctx: FleetContext, proposal: WriteProposal) => Promise<ExecuteResult>;
}

export function makeActionNode(deps: ActionNodeDeps = {}) {
  const execute = deps.execute ?? executeProposal;

  return async function actionNode(state: FleetGraphStateType): Promise<FleetGraphUpdate> {
    const proposal = state.proposal;
    if (!proposal) {
      // Should never happen (policy only routes here with a proposal); degrade.
      return { answer: 'Nothing to confirm.' };
    }

    // ── PAUSE. Everything above this line is pure + idempotent. ──
    // On the initial pass this throws GraphInterrupt and the node suspends.
    // On resume this RETURNS the caller-provided resume value.
    const resume = interrupt<InterruptPayload, ResumeValue>({
      type: 'confirm_write',
      proposal,
    });

    // ── EVERYTHING BELOW runs ONLY on the resume pass. ──
    if (!resume?.approved) {
      return {
        declined: true,
        answer: 'Okay, I have not made that change.',
      };
    }

    // Execute EXACTLY the confirmed proposal (parity + contentHash backstop).
    const result = await execute(state.ctx!, proposal);
    const answer = result.mutated
      ? `Done — ${describe(proposal)} (id: ${result.resourceId ?? 'n/a'}).`
      : `That change was rejected (status ${result.status}); I did not have permission or the target was not found.`;

    return {
      executed: result,
      answer,
    };
  };
}

function describe(p: WriteProposal): string {
  switch (p.kind) {
    case 'create_issue':
      return 'created the issue';
    case 'patch_issue':
      return 'updated the issue';
    case 'post_comment':
      return 'posted the comment';
    default:
      return 'applied the change';
  }
}
