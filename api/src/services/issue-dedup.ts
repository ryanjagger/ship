/**
 * Issue dedup-on-create — stage-1 candidate retrieval.
 *
 * `findSimilarIssues` is the CHEAP, deterministic half of the two-stage dedup
 * feature: a `pg_trgm` similarity search over open-issue titles, scoped to the
 * requesting user's visibility. It feeds BOTH surfaces:
 *
 *   - GET /api/issues/similar  — the per-keystroke typeahead hint (no model).
 *   - runDedupReview (FleetGraph `dedup` mode) — the candidate set the model
 *     reasons over to produce a true-duplicate verdict (stage 2).
 *
 * Keeping retrieval here (one query, one visibility filter) means the typeahead
 * and the graph judge over the EXACT same candidates — the verdict can never
 * reference an issue the hint didn't surface, or vice versa.
 */

import { pool } from '../db/client.js';
import { VISIBILITY_FILTER_SQL } from '../middleware/visibility.js';
import type { FleetContext } from './fleet-service.js';
import type { FleetDedupCandidate } from '@ship/shared';

export interface FindSimilarIssuesArgs {
  ctx: FleetContext;
  /** The (in-progress) issue title to match against. */
  title: string;
  /** Issue id to exclude — the one being edited. */
  excludeId?: string | null;
  /** Max candidates (default 5). */
  limit?: number;
}

/**
 * Find open issues whose titles are similar to `title`, ranked by `pg_trgm`
 * similarity. Scoped to the workspace + the user's visibility, excluding the
 * issue being edited and any closed (done/cancelled) or archived/deleted work —
 * those are not dedup targets. Returns [] for titles shorter than 4 chars (too
 * short for meaningful trigram matches).
 *
 * The `title % $3` predicate uses pg_trgm's default 0.3 similarity threshold and
 * is served by the GIN trigram index (migration 038); `similarity()` drives the
 * ranking and the surfaced score. Each candidate is enriched with its parent
 * project title so the stage-2 judge can weight same-project matches.
 */
export async function findSimilarIssues(
  args: FindSimilarIssuesArgs
): Promise<FleetDedupCandidate[]> {
  const { ctx, excludeId = null } = args;
  const title = args.title.trim();
  const limit = args.limit ?? 5;

  if (title.length < 4) return [];

  const result = await pool.query(
    `SELECT d.id, d.title, d.ticket_number,
            d.properties->>'state' as state,
            d.properties->>'priority' as priority,
            u.name as assignee_name,
            -- Scalar subquery (not a JOIN): an issue can have multiple 'project'
            -- associations, and a JOIN would emit one row per association,
            -- duplicating the issue in the results. Pick a single project title.
            (SELECT proj.title
               FROM document_associations proj_da
               JOIN documents proj
                 ON proj.id = proj_da.related_id AND proj.document_type = 'project'
              WHERE proj_da.document_id = d.id
                AND proj_da.relationship_type = 'project'
              ORDER BY proj.created_at
              LIMIT 1) as project_title,
            d.updated_at,
            similarity(d.title, $3::text) as score
       FROM documents d
       LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.archived_at IS NULL
        AND d.deleted_at IS NULL
        AND COALESCE(d.properties->>'state', 'backlog') NOT IN ('done', 'cancelled')
        AND ($4::uuid IS NULL OR d.id <> $4::uuid)
        AND ${VISIBILITY_FILTER_SQL('d', '$2', ctx.isAdmin)}
        AND d.title % $3::text
      ORDER BY score DESC, d.updated_at DESC
      LIMIT $5`,
    [ctx.workspaceId, ctx.userId, title, excludeId, limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ticket_number: row.ticket_number,
    display_id: `#${row.ticket_number}`,
    state: row.state || 'backlog',
    priority: row.priority || 'medium',
    assignee_name: row.assignee_name || null,
    project_title: row.project_title || null,
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    score: Number(row.score),
  }));
}
