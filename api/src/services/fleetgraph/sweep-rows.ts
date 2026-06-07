/**
 * Sweep row gathering — the drift sweep's DOMAIN reads, through the public
 * API (issue #95). One mint per workspace tick for the `fleet@ship.system`
 * service user, then:
 *
 *   projects.iterate()                        → eligibility (inferred_status)
 *   issues.list({belongs_to, visibility})     → per-project drift aggregates
 *   documentHistory.list({field: 'plan'})     → plan_last_edited_at
 *
 * The service user holds no workspace memberships and v1 reads have no admin
 * bypass, so the sweep sees WORKSPACE-VISIBLE documents only — private
 * projects/issues drop out of drift detection (privacy-positive, intentional).
 *
 * Split from sweep.ts so the dispatch loop (locks, verdict routing, insight
 * upserts — agent machinery that stays internal) is testable against fixture
 * rows while this module owns the transport. The aggregate math is
 * `computeIssueDriftAggregates`, parity-tested against the SQL fragment the
 * project-list endpoints still use.
 */

import type { ShipClient, ShipIssue } from '@ryanjagger/ship-sdk';
import { withFleetClient } from './api-client.js';
import { getFleetServiceUserId } from './service-user.js';
import { computeIssueDriftAggregates } from '../drift/computeIssueDriftAggregates.js';

/** One drift-ELIGIBLE project (inferred_status active/planned) + its aggregates. */
export interface SweepProjectRow {
  id: string;
  title: string | null;
  inferredStatus: string;
  plan: string | null;
  planLastEditedAt: Date | null;
  lastMovementAt: Date | null;
  openNow: number;
  incompleteNow: number;
  incomplete7dAgo: number;
}

async function listProjectIssues(client: ShipClient, projectId: string): Promise<ShipIssue[]> {
  const issues: ShipIssue[] = [];
  for await (const issue of client.issues.iterate({ belongs_to: projectId, belongs_to_type: 'project', visibility: 'workspace', limit: 100 })) {
    issues.push(issue);
  }
  return issues;
}

/**
 * Gather the workspace's drift-eligible projects with their issue aggregates
 * and plan-edit recency. Ineligible projects (backlog/completed; archived
 * never appear in v1 lists) are filtered HERE, so the N+2 per-project calls
 * (issues + plan history) only run for projects the sweep will actually
 * evaluate.
 */
export async function gatherSweepRows(workspaceId: string, now: Date): Promise<SweepProjectRow[]> {
  const serviceUserId = await getFleetServiceUserId();

  return withFleetClient({ userId: serviceUserId, workspaceId }, async (client) => {
    const rows: SweepProjectRow[] = [];

    for await (const project of client.projects.iterate({ visibility: 'workspace', limit: 100 })) {
      if (project.inferred_status !== 'active' && project.inferred_status !== 'planned') continue;

      const issues = await listProjectIssues(client, project.id);
      const aggregates = computeIssueDriftAggregates(issues, now);

      // Newest 'plan' field edit; a plan set at creation ages from creation
      // (same COALESCE fallback as the driftPlanLastEditedAt SQL fragment).
      const history = await client.documentHistory.list({ document_id: [project.id], field: 'plan', limit: 1 });
      const planEditedIso = history.data[0]?.created_at ?? project.created_at;

      rows.push({
        id: project.id,
        title: project.title,
        inferredStatus: project.inferred_status,
        plan: project.plan,
        planLastEditedAt: planEditedIso ? new Date(planEditedIso) : null,
        lastMovementAt: aggregates.lastMovementAt,
        openNow: aggregates.openNow,
        incompleteNow: aggregates.incompleteNow,
        incomplete7dAgo: aggregates.incomplete7dAgo,
      });
    }

    return rows;
  });
}
