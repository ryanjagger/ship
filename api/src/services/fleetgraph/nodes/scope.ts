/**
 * Scope node (U7) — R2.
 *
 * The graph's entry node. The entry points (index.ts) seed the raw scope into
 * state (mode, entityId, entityType, ctx, message/history for chat). This node
 * is intentionally THIN: it validates the seeded FleetContext is present and
 * normalizes the chat message into the running `messages` thread.
 *
 * It does NOT fetch, call the model, create the conversation doc, or consume the
 * rate-limit token. Those side effects all sit OUTSIDE the graph (index.ts /
 * U9), precisely so that a resume — which re-runs only the interrupted node —
 * cannot re-fire them. Scope is pure-by-design and idempotent: re-running it
 * produces the same state with no external effect.
 */

import { HumanMessage } from '@langchain/core/messages';
import type { FleetGraphStateType, FleetGraphUpdate } from '../state.js';

export function scopeNode(state: FleetGraphStateType): FleetGraphUpdate {
  if (!state.ctx) {
    throw new Error('scopeNode: FleetContext (ctx) must be seeded by the entry point');
  }
  if (!state.entityId) {
    throw new Error('scopeNode: entityId must be seeded by the entry point');
  }

  // For chat, seed the user's message into the message thread once (only when a
  // message is present and the thread has no entries yet — guards re-run).
  if (state.mode === 'chat' && state.message && state.messages.length === 0) {
    return { messages: [new HumanMessage(state.message)] };
  }
  return {};
}
