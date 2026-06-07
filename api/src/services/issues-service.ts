/**
 * Issues service (U6).
 *
 * The CORE mutation bodies for issue create + issue patch, extracted out of the
 * HTTP route handlers in `routes/issues.ts` into `FleetContext`-taking functions
 * that are the SINGLE SOURCE OF TRUTH for those mutations. Both the HTTP routes
 * and the FleetGraph write tools (`tools/write.ts`) call these — there is NO
 * separate privileged write path for the agent.
 *
 * Design constraints that keep the refactor behavior-preserving:
 *  - Each function takes an already-acquired pg client (so the CALLER owns the
 *    `pool.connect()` / `release()` lifecycle and the BEGIN/COMMIT boundary,
 *    exactly as the route did).
 *  - Each function returns a discriminated `ServiceResult` carrying the HTTP
 *    status + body the route used to send inline, so the route maps it straight
 *    onto `res` with zero behavior change (404, 400, 409, 201, 200 all preserved).
 *  - Side effects that the route ran OUTSIDE the transaction (broadcasts,
 *    post-commit accountability checks) are returned as a `sideEffects` payload
 *    for the caller to run after COMMIT — the route runs them; tools may ignore
 *    them. This keeps the transactional core pure.
 *  - `actorSource` is a parameter: the internal route passes its existing value
 *    (the issue PATCH route passes `data.claude_metadata?.updated_by`, i.e.
 *    undefined or 'claude'); the public v1 route passes the OAuth client_id
 *    (so Fleet-agent edits read `client_ship_fleet_agent`). This drives the
 *    `automated_by` provenance column in document_history.
 *
 * Authorization: the patch core re-runs the SAME visibility check the route ran
 * (`VISIBILITY_FILTER_SQL` scoped to the user's FleetContext) so an agent cannot
 * patch an issue the user cannot see — it 404s identically.
 */

import type { PoolClient } from 'pg';
import { pool } from '../db/client.js';
import { VISIBILITY_FILTER_SQL } from '../middleware/visibility.js';
import {
  logDocumentChange,
  getTimestampUpdates,
  getBelongsToAssociations,
  type BelongsToEntry,
} from '../utils/document-crud.js';
import { broadcastToUser } from '../collaboration/index.js';
import type { FleetContext } from './fleet-service.js';
import { eventBus } from '../platform/webhooks/event-bus.js';
import { buildEvents } from '../platform/webhooks/events.js';

export type { FleetContext };

// ---------------------------------------------------------------------------
// Result / side-effect shapes
// ---------------------------------------------------------------------------

/**
 * Discriminated result mirroring exactly what the route used to send inline.
 * `status` + `body` are passed straight to `res.status(status).json(body)`.
 *
 * `sideEffects` carries the post-commit, NON-transactional work (websocket
 * broadcasts) so the caller can run them after COMMIT. The transactional core
 * itself never broadcasts.
 */
export interface ServiceResult<T> {
  status: number;
  body: T;
  sideEffects?: SideEffect[];
}

export type SideEffect =
  | { kind: 'accountability_week_issues'; userId: string; targetId: string; ifFirstIssue: true }
  | { kind: 'accountability_issue_completed'; assigneeId: string; issueId: string; state: string }
  | { kind: 'webhooks_dispatch'; eventIds: string[] };

type ResourceDto = Record<string, unknown>;

/** Run the deferred (post-commit) side effects produced by a service call. */
export async function runIssueSideEffects(effects: SideEffect[] | undefined): Promise<void> {
  if (!effects?.length) return;
  for (const effect of effects) {
    if (effect.kind === 'accountability_week_issues') {
      const countResult = await pool.query(
        `SELECT COUNT(*) as count FROM document_associations
           WHERE related_id = $1 AND relationship_type = 'sprint'`,
        [effect.targetId]
      );
      if (parseInt(countResult.rows[0].count, 10) === 1) {
        broadcastToUser(effect.userId, 'accountability:updated', { type: 'week_issues', targetId: effect.targetId });
      }
    } else if (effect.kind === 'accountability_issue_completed') {
      broadcastToUser(effect.assigneeId, 'accountability:updated', { issueId: effect.issueId, state: effect.state });
    } else if (effect.kind === 'webhooks_dispatch') {
      eventBus.dispatchSoon(effect.eventIds);
    }
  }
}

// ---------------------------------------------------------------------------
// Input shapes (already validated by the caller's zod schema)
// ---------------------------------------------------------------------------

export interface BelongsToInput {
  id: string;
  type: 'program' | 'project' | 'sprint' | 'parent';
}

export interface CreateIssueInput {
  title: string;
  state?: 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  assignee_id?: string | null;
  belongs_to?: BelongsToInput[];
  source?: 'internal' | 'external' | 'action_items';
  due_date?: string | null;
  is_system_generated?: boolean;
  accountability_target_id?: string | null;
  accountability_type?: string | null;
  // Fields below exist so the public /api/v1/issues POST (re-platformed onto
  // this core for write parity) keeps its full contract. The internal route's
  // zod schema doesn't accept them, so internal behavior is unchanged.
  estimate?: number | null;
  content?: unknown;
  visibility?: 'private' | 'workspace';
}

export interface UpdateIssueInput {
  title?: string;
  state?: 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  assignee_id?: string | null;
  belongs_to?: BelongsToInput[];
  estimate?: number | null;
  confirm_orphan_children?: boolean;
  claude_metadata?: {
    updated_by: 'claude';
    [k: string]: unknown;
  };
  // Public-contract fields (see CreateIssueInput note): the v1 PATCH accepts
  // these today, so the re-platformed route must keep them working. The
  // internal route's zod schema doesn't accept them.
  due_date?: string | null;
  rejection_reason?: string | null;
  content?: unknown;
  visibility?: 'private' | 'workspace';
}

// Internal row helper (mirrors extractIssueFromRow in the route).
function extractIssueFromRow(row: any) {
  const props = row.properties || {};
  return {
    id: row.id,
    title: row.title,
    state: props.state || 'backlog',
    priority: props.priority || 'medium',
    assignee_id: props.assignee_id || null,
    estimate: props.estimate ?? null,
    source: props.source || 'internal',
    rejection_reason: props.rejection_reason || null,
    due_date: props.due_date || null,
    is_system_generated: props.is_system_generated || false,
    accountability_target_id: props.accountability_target_id || null,
    accountability_type: props.accountability_type || null,
    ticket_number: row.ticket_number,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    cancelled_at: row.cancelled_at || null,
    reopened_at: row.reopened_at || null,
    converted_from_id: row.converted_from_id || null,
    assignee_name: row.assignee_name,
    assignee_archived: row.assignee_archived || false,
    created_by_name: row.created_by_name,
  };
}

const ISSUE_WEBHOOK_RESOURCE = {
  eventResource: 'issue',
  semanticEvents: (before: ResourceDto, after: ResourceDto): string[] => {
    const events: string[] = [];
    if (before.assignee_id !== after.assignee_id) events.push('assigned');
    if (before.state !== after.state) events.push('status_changed');
    return events;
  },
};

async function getBelongsToAssociationsForClient(client: PoolClient, documentId: string): Promise<BelongsToEntry[]> {
  const result = await client.query(
    `SELECT da.related_id as id, da.relationship_type as type, d.title, d.properties->>'color' as color
       FROM document_associations da
       LEFT JOIN documents d ON d.id = da.related_id
      WHERE da.document_id = $1
        AND da.relationship_type IN ('program', 'project', 'sprint', 'parent')
      ORDER BY da.relationship_type, da.created_at`,
    [documentId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    ...(row.title ? { title: row.title } : {}),
    ...(row.color ? { color: row.color } : {}),
  }));
}

async function issueWebhookDto(client: PoolClient, row: any): Promise<ResourceDto> {
  const issue = extractIssueFromRow(row);
  const belongsTo = await getBelongsToAssociationsForClient(client, row.id);
  return {
    ...issue,
    display_id: `#${row.ticket_number}`,
    belongs_to: belongsTo,
  };
}

// ---------------------------------------------------------------------------
// CREATE issue core
// ---------------------------------------------------------------------------

/**
 * Core of `POST /api/issues`. The caller owns the client lifecycle and runs
 * `runIssueSideEffects(result.sideEffects)` after this returns (the route did
 * the broadcast inline; this defers it so the transactional core is pure).
 *
 * Always returns status 201 on success — there are no in-band validation
 * branches in the original create path beyond the zod parse the caller does.
 */
export async function createIssueCore(
  client: PoolClient,
  ctx: FleetContext,
  input: CreateIssueInput
): Promise<ServiceResult<any>> {
  const title = input.title;
  const state = input.state ?? 'backlog';
  const priority = input.priority ?? 'medium';
  const assignee_id = input.assignee_id ?? null;
  const belongs_to = input.belongs_to ?? [];
  const source = input.source ?? 'internal';
  const due_date = input.due_date ?? null;
  const is_system_generated = input.is_system_generated ?? false;
  const accountability_target_id = input.accountability_target_id ?? null;
  const accountability_type = input.accountability_type ?? null;

  await client.query('BEGIN');

  // Advisory lock to serialize ticket number generation per workspace.
  const workspaceIdHex = ctx.workspaceId.replace(/-/g, '').substring(0, 15);
  const lockKey = parseInt(workspaceIdHex, 16);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

  const ticketResult = await client.query(
    `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
       FROM documents
       WHERE workspace_id = $1 AND document_type = 'issue'`,
    [ctx.workspaceId]
  );
  const ticketNumber = ticketResult.rows[0].next_number;

  const properties = {
    state: state || 'backlog',
    priority: priority || 'medium',
    source: source || 'internal',
    assignee_id: assignee_id || null,
    rejection_reason: null,
    due_date: due_date || null,
    is_system_generated: is_system_generated || false,
    accountability_target_id: accountability_target_id || null,
    accountability_type: accountability_type || null,
    // Only present when the caller (the public v1 route) sent it, so
    // internal-created issues keep their exact pre-existing property set.
    ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
  };

  const result = await client.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by, content, visibility)
       VALUES ($1, 'issue', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
    [
      ctx.workspaceId,
      title,
      JSON.stringify(properties),
      ticketNumber,
      ctx.userId,
      input.content != null ? JSON.stringify(input.content) : null,
      input.visibility ?? 'workspace',
    ]
  );

  const newIssueId = result.rows[0].id;

  if (belongs_to.length > 0) {
    await client.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
         SELECT $1::uuid, unnest($2::uuid[]), unnest($3::text[])::relationship_type
         ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
      [newIssueId, belongs_to.map((a) => a.id), belongs_to.map((a) => a.type)]
    );
  }

  const afterDto = await issueWebhookDto(client, result.rows[0]);
  const eventIds = await eventBus.publish(
    client,
    buildEvents(ISSUE_WEBHOOK_RESOURCE, { workspaceId: ctx.workspaceId, actorUserId: ctx.userId }, { kind: 'created', after: afterDto }),
    { visibility: result.rows[0].visibility, ownerId: result.rows[0].created_by }
  );

  await client.query('COMMIT');

  // Deferred (post-commit) side effects: first-issue-in-sprint celebration.
  const sideEffects: SideEffect[] = belongs_to
    .filter((bt) => bt.type === 'sprint')
    .map((bt) => ({ kind: 'accountability_week_issues' as const, userId: ctx.userId, targetId: bt.id, ifFirstIssue: true as const }));
  if (eventIds.length > 0) {
    sideEffects.push({ kind: 'webhooks_dispatch', eventIds });
  }

  const belongsToResult = await getBelongsToAssociations(newIssueId);
  const issue = extractIssueFromRow(result.rows[0]);

  return {
    status: 201,
    body: { ...issue, display_id: `#${ticketNumber}`, belongs_to: belongsToResult },
    sideEffects,
  };
}

// ---------------------------------------------------------------------------
// PATCH issue core
// ---------------------------------------------------------------------------

/**
 * Core of `PATCH /api/issues/:id`. Mirrors the route's in-band branches:
 *  - 404 when the issue is not visible to the user (same VISIBILITY_FILTER_SQL).
 *  - 400 when assigning to a sprint without an estimate.
 *  - 409 incomplete_children when closing a parent with open children and the
 *    caller did not confirm orphaning.
 *  - 400 when there is nothing to update.
 *  - 200 with the updated issue otherwise.
 *
 * `actorSource` becomes `automated_by` in document_history. The internal route
 * passes `input.claude_metadata?.updated_by`; the v1 route passes the OAuth
 * client_id (Fleet-agent edits read `client_ship_fleet_agent`).
 *
 * NOTE: the caller must NOT have opened a transaction before calling — this
 * function does its read-then-validate work on the client and then opens the
 * transaction (BEGIN ... COMMIT) itself, exactly as the route did. On any
 * thrown error the CALLER is responsible for ROLLBACK (matches the route's
 * try/catch).
 */
export async function patchIssueCore(
  client: PoolClient,
  ctx: FleetContext,
  id: string,
  input: UpdateIssueInput,
  actorSource?: string
): Promise<ServiceResult<any>> {
  // Visibility-checked load (uses the user's FleetContext — same as the route).
  const existing = await client.query(
    `SELECT *
       FROM documents
       WHERE id = $1 AND workspace_id = $2 AND document_type = 'issue'
         AND ${VISIBILITY_FILTER_SQL('documents', '$3', '$4')}`,
    [id, ctx.workspaceId, ctx.userId, ctx.isAdmin]
  );

  if (existing.rows.length === 0) {
    return { status: 404, body: { error: 'Issue not found' } };
  }

  const existingIssue = existing.rows[0];
  const currentProps = existingIssue.properties || {};
  const beforeDto = await issueWebhookDto(client, existingIssue);
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const data = input;

  // Validate: estimate required when assigning to a sprint via belongs_to.
  if (data.belongs_to) {
    const hasSprintAssociation = data.belongs_to.some((bt) => bt.type === 'sprint');
    if (hasSprintAssociation) {
      const effectiveEstimate = data.estimate !== undefined ? data.estimate : currentProps.estimate;
      if (!effectiveEstimate) {
        return { status: 400, body: { error: 'Estimate is required before assigning to a week' } };
      }
    }
  }

  // Check for incomplete children when closing parent.
  const isClosingIssue = data.state && (data.state === 'done' || data.state === 'cancelled');
  const wasNotClosed = currentProps.state !== 'done' && currentProps.state !== 'cancelled';

  if (isClosingIssue && wasNotClosed) {
    const childrenResult = await client.query(
      `SELECT d.id, d.title, d.ticket_number, d.properties->>'state' as state
         FROM documents d
         JOIN document_associations da ON da.document_id = d.id
         WHERE da.related_id = $1
           AND da.relationship_type = 'parent'
           AND d.workspace_id = $2
           AND d.document_type = 'issue'`,
      [id, ctx.workspaceId]
    );

    const incompleteChildren = childrenResult.rows.filter(
      (child) => child.state !== 'done' && child.state !== 'cancelled'
    );

    if (incompleteChildren.length > 0 && !data.confirm_orphan_children) {
      return {
        status: 409,
        body: {
          error: 'incomplete_children',
          message: `This issue has ${incompleteChildren.length} incomplete sub-issue(s). Closing it will remove their parent association.`,
          incomplete_children: incompleteChildren.map((child) => ({
            id: child.id,
            title: child.title,
            ticket_number: child.ticket_number,
            state: child.state,
          })),
          confirm_action: 'Set confirm_orphan_children: true to proceed',
        },
      };
    }

    if (incompleteChildren.length > 0 && data.confirm_orphan_children) {
      await client.query(
        `DELETE FROM document_associations
           WHERE related_id = $1
             AND relationship_type = 'parent'`,
        [id]
      );
    }
  }

  // Track changes for history.
  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

  if (data.title !== undefined && data.title !== existingIssue.title) {
    updates.push(`title = $${paramIndex++}`);
    values.push(data.title);
    changes.push({ field: 'title', oldValue: existingIssue.title, newValue: data.title });
  }

  const newProps = { ...currentProps };
  let propsChanged = false;

  if (data.state !== undefined && data.state !== currentProps.state) {
    changes.push({ field: 'state', oldValue: currentProps.state || null, newValue: data.state });
    newProps.state = data.state;
    propsChanged = true;

    const timestampUpdates = getTimestampUpdates(currentProps.state || null, data.state);
    for (const [col, expr] of Object.entries(timestampUpdates)) {
      updates.push(`${col} = ${expr}`);
    }
  }
  if (data.priority !== undefined && data.priority !== currentProps.priority) {
    changes.push({ field: 'priority', oldValue: currentProps.priority || null, newValue: data.priority });
    newProps.priority = data.priority;
    propsChanged = true;
  }
  if (data.assignee_id !== undefined && data.assignee_id !== currentProps.assignee_id) {
    changes.push({ field: 'assignee_id', oldValue: currentProps.assignee_id || null, newValue: data.assignee_id });
    newProps.assignee_id = data.assignee_id;
    propsChanged = true;
  }
  if (data.estimate !== undefined && data.estimate !== currentProps.estimate) {
    changes.push({ field: 'estimate', oldValue: currentProps.estimate?.toString() || null, newValue: data.estimate?.toString() || null });
    newProps.estimate = data.estimate;
    propsChanged = true;
  }
  if (data.due_date !== undefined && data.due_date !== (currentProps.due_date ?? null)) {
    changes.push({ field: 'due_date', oldValue: currentProps.due_date || null, newValue: data.due_date });
    newProps.due_date = data.due_date;
    propsChanged = true;
  }
  if (data.rejection_reason !== undefined && data.rejection_reason !== (currentProps.rejection_reason ?? null)) {
    changes.push({ field: 'rejection_reason', oldValue: currentProps.rejection_reason || null, newValue: data.rejection_reason });
    newProps.rejection_reason = data.rejection_reason;
    propsChanged = true;
  }
  // Column (not property) updates from the public contract. No history rows —
  // matches the generic typed-document core these fields migrated from.
  if (data.content !== undefined) {
    updates.push(`content = $${paramIndex++}`);
    values.push(JSON.stringify(data.content));
    updates.push(`yjs_state = NULL`);
  }
  if (data.visibility !== undefined && data.visibility !== existingIssue.visibility) {
    updates.push(`visibility = $${paramIndex++}`);
    values.push(data.visibility);
  }

  if (data.claude_metadata) {
    newProps.claude_metadata = {
      ...data.claude_metadata,
      updated_at: new Date().toISOString(),
    };
    propsChanged = true;
  }

  let propsValueIndex = -1;
  if (propsChanged) {
    updates.push(`properties = $${paramIndex++}`);
    propsValueIndex = values.length;
    values.push(JSON.stringify(newProps));
  }

  // belongs_to association updates.
  let belongsToChanged = false;
  let oldBelongsTo: BelongsToEntry[] = [];
  let newBelongsTo: BelongsToEntry[] = [];

  if (data.belongs_to !== undefined) {
    oldBelongsTo = await getBelongsToAssociations(id);
    newBelongsTo = data.belongs_to;

    const oldIds = oldBelongsTo.map((bt) => `${bt.type}:${bt.id}`).sort().join(',');
    const newIds = newBelongsTo.map((bt) => `${bt.type}:${bt.id}`).sort().join(',');

    if (oldIds !== newIds) {
      belongsToChanged = true;

      const oldSprintAssoc = oldBelongsTo.find((bt) => bt.type === 'sprint');
      const newSprintAssoc = newBelongsTo.find((bt) => bt.type === 'sprint');

      if (oldSprintAssoc && newSprintAssoc && oldSprintAssoc.id !== newSprintAssoc.id && currentProps.state !== 'done') {
        const oldSprintResult = await client.query(
          `SELECT properties->>'sprint_number' as sprint_number, w.sprint_start_date
             FROM documents d
             JOIN workspaces w ON d.workspace_id = w.id
             WHERE d.id = $1 AND d.document_type = 'sprint'`,
          [oldSprintAssoc.id]
        );

        if (oldSprintResult.rows[0]) {
          const sprintNumber = parseInt(oldSprintResult.rows[0].sprint_number, 10);
          const rawStartDate = oldSprintResult.rows[0].sprint_start_date;
          const sprintDuration = 7;

          let startDate: Date;
          if (rawStartDate instanceof Date) {
            startDate = new Date(Date.UTC(rawStartDate.getFullYear(), rawStartDate.getMonth(), rawStartDate.getDate()));
          } else if (typeof rawStartDate === 'string') {
            startDate = new Date(rawStartDate + 'T00:00:00Z');
          } else {
            startDate = new Date();
          }

          const sprintEndDate = new Date(startDate);
          sprintEndDate.setUTCDate(sprintEndDate.getUTCDate() + (sprintNumber * sprintDuration) - 1);

          if (new Date() > sprintEndDate) {
            newProps.carryover_from_sprint_id = oldSprintAssoc.id;
            propsChanged = true;
          }
        }
      } else if (oldSprintAssoc && !newSprintAssoc) {
        delete newProps.carryover_from_sprint_id;
        propsChanged = true;
      }

      changes.push({
        field: 'belongs_to',
        oldValue: JSON.stringify(oldBelongsTo.map((bt) => ({ id: bt.id, type: bt.type }))),
        newValue: JSON.stringify(newBelongsTo.map((bt) => ({ id: bt.id, type: bt.type }))),
      });
    }
  }

  // Re-check if properties changed (carryover may have been updated).
  if (propsChanged && propsValueIndex === -1) {
    updates.push(`properties = $${paramIndex++}`);
    propsValueIndex = values.length;
    values.push(JSON.stringify(newProps));
  } else if (propsChanged && propsValueIndex >= 0) {
    values[propsValueIndex] = JSON.stringify(newProps);
  }

  if (updates.length === 0 && !belongsToChanged) {
    return { status: 400, body: { error: 'No fields to update' } };
  }

  await client.query('BEGIN');

  const automatedBy = actorSource;
  for (const change of changes) {
    await logDocumentChange(id, change.field, change.oldValue, change.newValue, ctx.userId, automatedBy, client);
  }

  if (updates.length > 0) {
    updates.push(`updated_at = now()`);
    await client.query(
      `UPDATE documents SET ${updates.join(', ')} WHERE id = $${paramIndex} AND workspace_id = $${paramIndex + 1}`,
      [...values, id, ctx.workspaceId]
    );
  }

  if (belongsToChanged) {
    await client.query(`DELETE FROM document_associations WHERE document_id = $1`, [id]);
    if (newBelongsTo.length > 0) {
      await client.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
           SELECT $1::uuid, unnest($2::uuid[]), unnest($3::text[])::relationship_type
           ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
        [id, newBelongsTo.map((a) => a.id), newBelongsTo.map((a) => a.type)]
      );
    }
  }

  const result = await client.query(`SELECT * FROM documents WHERE id = $1 AND workspace_id = $2`, [id, ctx.workspaceId]);
  const row = result.rows[0];
  const afterDto = await issueWebhookDto(client, row);
  const eventIds = await eventBus.publish(
    client,
    buildEvents(ISSUE_WEBHOOK_RESOURCE, { workspaceId: ctx.workspaceId, actorUserId: ctx.userId }, { kind: 'updated', before: beforeDto, after: afterDto }),
    { visibility: row.visibility, ownerId: row.created_by }
  );

  await client.query('COMMIT');

  // Deferred post-commit side effects.
  const sideEffects: SideEffect[] = [];
  if (belongsToChanged) {
    const oldSprintIds = oldBelongsTo.filter((bt) => bt.type === 'sprint').map((bt) => bt.id);
    const newSprintIds = newBelongsTo.filter((bt) => bt.type === 'sprint').map((bt) => bt.id);
    const addedSprintIds = newSprintIds.filter((sprintId) => !oldSprintIds.includes(sprintId));
    for (const sprintId of addedSprintIds) {
      sideEffects.push({ kind: 'accountability_week_issues', userId: ctx.userId, targetId: sprintId, ifFirstIssue: true });
    }
  }

  const issue = extractIssueFromRow(row);
  const belongsTo = await getBelongsToAssociations(id);
  if (eventIds.length > 0) {
    sideEffects.push({ kind: 'webhooks_dispatch', eventIds });
  }

  if (isClosingIssue && wasNotClosed) {
    const props = row.properties || {};
    if (props.source === 'action_items') {
      const assigneeId = props.assignee_id || ctx.userId;
      sideEffects.push({ kind: 'accountability_issue_completed', assigneeId, issueId: id, state: data.state as string });
    }
  }

  return {
    status: 200,
    body: { ...issue, display_id: `#${row.ticket_number}`, belongs_to: belongsTo },
    sideEffects,
  };
}
