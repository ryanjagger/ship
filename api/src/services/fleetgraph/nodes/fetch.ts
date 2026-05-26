/**
 * FleetGraph parallel fetch node (U5).
 *
 * The graph's scope node seeds a FleetContext + the focal entity (id + type);
 * this node performs the PARALLEL, visibility-filtered fan-out and returns a
 * partial-state object that U7's reducer merges into the graph state.
 *
 * R3 (no redundant queries): this node delegates to `assembleEntityContext`,
 * which resolves the focal entity ONCE (authorizing visibility) and then fans
 * the dependent reads (associations / people / recent activity) out in parallel
 * reusing that single authorization — it never re-resolves the focal entity
 * per associated read.
 *
 * ------------------------------------------------------------------------
 * PARTIAL-STATE CONTRACT FOR U7 (the reducer this node feeds)
 * ------------------------------------------------------------------------
 * This node returns `FetchNodeOutput`:
 *
 *   {
 *     focal:          FocalEntity | null,        // null ⇒ entity not visible / denied
 *     associations:   AssociationsResult,        // { ancestors, issues, weeks }
 *     people:         PersonRef[],
 *     recentActivity: ActivityItem[],
 *     fetchDenied:    boolean,                    // true when focal was not visible
 *   }
 *
 * Reducer guidance for U7's state.ts:
 *  - `focal`, `associations`, `people`, `recentActivity`, `fetchDenied` are
 *    each LAST-WRITE-WINS (replace), not concat — a single fetch produces the
 *    complete consolidated snapshot, so the reducer should simply overwrite the
 *    prior value with the incoming one (defaulting to the existing value when a
 *    partial update omits a key).
 *  - If U7 chooses to fan the underlying tools out as SEPARATE graph nodes
 *    instead of this consolidated node, each tool's slice (`focal` /
 *    `associations` / `people` / `recentActivity`) is independent, so the
 *    merge is a per-key replace with no cross-key conflict. The consolidated
 *    node here is the R3-preferred path; the per-key independence is documented
 *    so the alternative still merges cleanly.
 *  - All content-derived strings in this output are ALREADY prompt-escaped by
 *    the read layer; the reasoning node may interpolate them into prompts
 *    without further escaping.
 */

import {
  assembleEntityContext,
  type FleetContext,
  type FleetEntityType,
  type EntityContext,
} from '../tools/read.js';

/** The slice of graph state this node produces. See contract above. */
export interface FetchNodeOutput extends EntityContext {
  /** True when the focal entity was not visible to the requester. */
  fetchDenied: boolean;
}

/** Minimal shape the scope node is expected to have seeded into state. */
export interface FetchNodeInput {
  ctx: FleetContext;
  entityId: string;
  entityType: FleetEntityType;
}

/**
 * The fetch node. Pure w.r.t. graph state: takes the seeded scope, returns the
 * partial-state slice. Performs the consolidated, parallel, visibility-filtered
 * fetch and never throws on a not-visible entity (returns a denied/empty slice
 * so the graph degrades to "I can't see that" rather than crashing).
 */
export async function fetchNode(input: FetchNodeInput): Promise<FetchNodeOutput> {
  const { ctx, entityId, entityType } = input;
  const context = await assembleEntityContext(entityId, entityType, ctx);
  return {
    ...context,
    fetchDenied: context.focal === null,
  };
}
