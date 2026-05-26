/**
 * Policy node (U7) — R4.
 *
 * Risk classification / routing. It keys off the PROPOSAL KIND (a write was
 * proposed), NOT the tool name and NOT model free-text:
 *
 *  - any pending write proposal  → 'action'  (human-in-the-loop confirmation)
 *  - no proposal (prose answer / structured insight) → 'output'
 *
 * The node itself is a pass-through (it makes no state change); the routing is a
 * conditional edge in graph.ts that calls `policyRoute(state)`. Keeping the
 * decision in a pure function makes the low-risk-vs-write classification directly
 * testable (R4) without driving the whole graph.
 */

import type { FleetGraphStateType } from '../state.js';

export type PolicyDestination = 'action' | 'output';

/**
 * Pure classifier: where should this run go after reasoning?
 *
 * M-03: this is wired DIRECTLY as the conditional edge after `reason` in
 * graph.ts (the former no-op `policy` pass-through node was removed). Keeping the
 * decision in a pure function makes the low-risk-vs-write classification (R4)
 * directly unit-testable without driving the whole graph.
 */
export function policyRoute(state: FleetGraphStateType): PolicyDestination {
  // A fully-resolved write proposal exists ⇒ it is a mutation ⇒ requires
  // explicit human confirmation via the action node's interrupt.
  if (state.proposal && state.proposal.kind) {
    return 'action';
  }
  // Everything else (a draft, an answer, a structured insight, a denied fetch)
  // is low-risk and goes straight to output.
  return 'output';
}
