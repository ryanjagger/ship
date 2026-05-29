/**
 * Projects service — shared, route-equivalent project mutation cores.
 *
 * Mirrors `issues-service.ts`: the route-inline mutation logic is extracted into
 * a core that returns the HTTP status + body the route used to send, so the
 * route maps it straight onto `res` with zero behavior change, AND a second
 * caller (the FleetGraph `patch_project` write executor) can reuse the SAME
 * load-then-write logic under the requesting user's permissions.
 *
 * `patchProjectRetroCore` is the single source of truth for "write a project
 * retro outcome" (plan_validated / monetary_impact_actual / success_criteria /
 * next_steps / optional content), used by both POST /api/projects/:id/retro and
 * the Fleet retro Apply action.
 */

import type { Pool, PoolClient } from 'pg';
import { VISIBILITY_FILTER_SQL } from '../middleware/visibility.js';
import { logDocumentChange } from '../utils/document-crud.js';
import type { SqlParam } from '@ship/shared';
import type { FleetContext } from './fleet-service.js';

/** Pool or a pooled client — both expose `.query`. */
type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Fields a retro write may set. All optional — only provided fields change. */
export interface ProjectRetroInput {
  plan_validated?: boolean | null;
  monetary_impact_actual?: string | null;
  success_criteria?: string[] | null;
  next_steps?: string | null;
  /** Optional TipTap narrative content; when present it is also audit-logged. */
  content?: Record<string, unknown>;
}

/** The route-equivalent status + body the caller maps onto the response. */
export interface ProjectRetroResult {
  status: number;
  body: unknown;
}

interface RetroRow {
  id: string;
  title?: string;
  content?: unknown;
  properties: Record<string, unknown> | null;
}

/**
 * Write a project's retro outcome under the requesting user's permissions.
 *
 * Visibility-checked load (same filter the route used) → key-preserving
 * properties merge (only provided fields change) → UPDATE (+ optional content)
 * → audit the narrative content when supplied → re-query and return the 201 body
 * the route shipped. A non-visible project returns 404 (no mutation), exactly as
 * the user would be denied directly. Broadcast/celebration is a UI concern left
 * to the caller (the route broadcasts; the Fleet apply relies on a client refetch).
 */
export async function patchProjectRetroCore(
  db: Queryable,
  ctx: FleetContext,
  projectId: string,
  input: ProjectRetroInput
): Promise<ProjectRetroResult> {
  const existing = await db.query<RetroRow>(
    `SELECT id, properties FROM documents
       WHERE id = $1 AND workspace_id = $2 AND document_type = 'project'
         AND ${VISIBILITY_FILTER_SQL('documents', '$3', '$4')}`,
    [projectId, ctx.workspaceId, ctx.userId, ctx.isAdmin]
  );
  const row = existing.rows[0];
  if (!row) return { status: 404, body: { error: 'Project not found' } };

  const currentProps = row.properties ?? {};
  const { plan_validated, monetary_impact_actual, success_criteria, next_steps, content } = input;

  // Key-preserving merge: only the supplied fields change; everything else
  // (plan, target_date, the fleet cache, etc.) is carried through untouched.
  const newProps: Record<string, unknown> = {
    ...currentProps,
    plan_validated: plan_validated ?? currentProps.plan_validated,
    monetary_impact_actual: monetary_impact_actual ?? currentProps.monetary_impact_actual,
    success_criteria: success_criteria ?? currentProps.success_criteria,
    next_steps: next_steps ?? currentProps.next_steps,
  };

  const updates: string[] = ['properties = $1', 'updated_at = now()'];
  const values: SqlParam[] = [JSON.stringify(newProps)];
  if (content) {
    updates.push('content = $2');
    values.push(JSON.stringify(content));
  }
  await db.query(
    `UPDATE documents SET ${updates.join(', ')}
       WHERE id = $${values.length + 1} AND workspace_id = $${values.length + 2} AND document_type = 'project'`,
    [...values, projectId, ctx.workspaceId]
  );

  // Log initial retro content to document_history for approval workflow tracking.
  if (content) {
    await logDocumentChange(projectId, 'retro_content', null, JSON.stringify(content), ctx.userId);
  }

  const result = await db.query<RetroRow>(
    `SELECT id, title, content, properties FROM documents WHERE id = $1`,
    [projectId]
  );
  const updatedRow = result.rows[0];
  if (!updatedRow) return { status: 500, body: { error: 'Project disappeared during update' } };
  const updatedProps = updatedRow.properties ?? {};
  return {
    status: 201,
    body: {
      is_draft: false,
      plan_validated: updatedProps.plan_validated,
      monetary_impact_expected: updatedProps.monetary_impact_expected || null,
      monetary_impact_actual: updatedProps.monetary_impact_actual || null,
      success_criteria: updatedProps.success_criteria || [],
      next_steps: updatedProps.next_steps || null,
      content: updatedRow.content || {},
    },
  };
}
