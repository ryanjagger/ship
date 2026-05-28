/**
 * Workspace settings service — typed read/write accessors over the
 * `workspaces.settings` JSONB column (migration 047).
 *
 * Design (see docs/plans/2026-05-28-001-feat-fleetgraph-insight-surfacing-plan.md
 * U1):
 *
 *   - Single JSONB column on `workspaces`; namespaced by feature
 *     (`fleetgraph.*`, future `notifications.*`, etc.).
 *
 *   - Writes are single-statement `jsonb_set(COALESCE(settings,'{}'::jsonb),
 *     '{path,...}', $val::jsonb, true)` — never read-modify-write of the
 *     whole blob. Mirrors the JSONB write discipline in
 *     api/src/services/fleetgraph/insight.ts (header lines 22-26 +
 *     createOrRefreshInsight refresh branch ~338-378).
 *
 *   - The COALESCE on read is defensive — the column is NOT NULL DEFAULT
 *     '{}'::jsonb, so a NULL should never appear. But if a future migration
 *     ever leaves NULLs in flight, jsonb_set on NULL returns NULL silently;
 *     COALESCE keeps the write idempotent against that edge.
 */

import { pool } from '../db/client.js';

/** Typed shape of the `fleetgraph` namespace within `workspaces.settings`. */
export interface FleetgraphSettings {
  sweepEnabled: boolean;
  llmVerdictsEnabled: boolean;
}

/**
 * Returns the full `settings` blob for the given workspace, or `{}` when no
 * row matches the id (callers narrow as needed). Does not throw on a missing
 * workspace — callers that need the not-found signal should query
 * `workspaces` directly.
 */
export async function getWorkspaceSettings(
  workspaceId: string
): Promise<Record<string, unknown>> {
  const result = await pool.query<{ settings: Record<string, unknown> | null }>(
    'SELECT settings FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  const row = result.rows[0];
  if (!row) {
    return {};
  }
  return row.settings ?? {};
}

/**
 * Returns the FleetGraph-namespaced subset of the workspace settings, typed.
 * Missing keys default to `{ sweepEnabled: false, llmVerdictsEnabled: false }`
 * — both features are opt-in. Both reads use a strict `=== true` check to
 * defend against stray non-boolean values accidentally enabling either flag.
 */
export async function getFleetgraphSettings(
  workspaceId: string
): Promise<FleetgraphSettings> {
  const settings = await getWorkspaceSettings(workspaceId);
  const fleetgraph = (
    settings as {
      fleetgraph?: { sweep_enabled?: unknown; llm_verdicts_enabled?: unknown };
    }
  ).fleetgraph;
  const sweepEnabled = fleetgraph?.sweep_enabled === true;
  const llmVerdictsEnabled = fleetgraph?.llm_verdicts_enabled === true;
  return { sweepEnabled, llmVerdictsEnabled };
}

/**
 * Sets `settings.fleetgraph.sweep_enabled` to the given boolean.
 *
 * Single-statement `jsonb_set` with `create_missing = true` so the
 * `fleetgraph` parent key is created on first write without a prior read.
 * Preserves any unrelated top-level keys (e.g. a future `notifications.*`
 * namespace) — `jsonb_set` only touches the specified path.
 *
 * Returns the resulting typed value. When no workspace row matches the id,
 * the UPDATE affects zero rows and the function returns the default
 * `{ sweepEnabled: false }` without throwing — mirrors the lenient shape of
 * `getFleetgraphSettings` for a non-existent workspace.
 */
export async function setFleetgraphSweepEnabled(
  workspaceId: string,
  enabled: boolean
): Promise<FleetgraphSettings> {
  await pool.query(
    `UPDATE workspaces
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{fleetgraph,sweep_enabled}',
              $1::jsonb,
              true
            )
      WHERE id = $2`,
    [JSON.stringify(enabled), workspaceId]
  );
  // Lean return: report the just-set value alongside a default-false for
  // the OTHER key. The PATCH route handler does a final `getFleetgraphSettings`
  // read to surface the truly-combined state when callers need both flags
  // (e.g. partial PATCH responses). Kept single-write to preserve the
  // single-round-trip discipline established by the surfacing plan U1.
  return { sweepEnabled: enabled, llmVerdictsEnabled: false };
}

/**
 * Sets `settings.fleetgraph.llm_verdicts_enabled` to the given boolean.
 *
 * Mirrors `setFleetgraphSweepEnabled` exactly — single-statement `jsonb_set`
 * with `create_missing = true`, COALESCE on a potentially-NULL settings
 * column, deep-path write that preserves any sibling key (notably
 * `sweep_enabled`) and any unrelated top-level namespaces.
 *
 * Returns the lean just-set view (matching `setFleetgraphSweepEnabled`).
 * The PATCH route handler is responsible for re-reading via
 * `getFleetgraphSettings` when it needs the truly-combined response.
 */
export async function setFleetgraphLlmVerdictsEnabled(
  workspaceId: string,
  enabled: boolean
): Promise<FleetgraphSettings> {
  await pool.query(
    `UPDATE workspaces
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{fleetgraph,llm_verdicts_enabled}',
              $1::jsonb,
              true
            )
      WHERE id = $2`,
    [JSON.stringify(enabled), workspaceId]
  );
  return { sweepEnabled: false, llmVerdictsEnabled: enabled };
}
