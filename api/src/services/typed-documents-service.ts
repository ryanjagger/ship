/**
 * Typed-documents service.
 *
 * The CORE mutation bodies for the generic typed-document resources
 * (`/api/v1/issues`, `/api/v1/projects`, ...), extracted out of the HTTP route
 * handlers in `platform/api/v1/routes/typed-documents.ts` so that webhook
 * publishing happens in the domain layer — part of the write itself — never in
 * the route layer. Any future non-HTTP caller (agent tool, import job, MCP)
 * gets identical webhook events by calling these cores. Same convention as
 * `issues-service.ts`.
 *
 * Contract (matches issues-service):
 *  - Each core takes an already-acquired pg client; the CALLER owns the
 *    `pool.connect()` / `release()` lifecycle and ROLLBACK on throw.
 *  - Each core owns BEGIN/COMMIT. Divergence from issues-service: the in-band
 *    failure checks (belongs_to validation, patch before-row 404, delete
 *    zero-rows 404) run INSIDE the transaction — exactly as the route did —
 *    so on those branches the core issues ROLLBACK itself before returning
 *    `{ok: false}`. They cannot be hoisted pre-BEGIN: the DELETE's RETURNING
 *    clause IS the existence check, and `pg_advisory_xact_lock` (ticket
 *    numbering) requires an open transaction.
 *  - Webhook events are published via `eventBus.publish` inside the
 *    transaction (transactional outbox); HTTP dispatch is returned as a
 *    `webhooks_dispatch` side effect for the caller to run AFTER COMMIT via
 *    `runTypedDocumentSideEffects`.
 *  - Cores return a discriminated result rather than issues-service's raw
 *    `{status, body}`: v1 error bodies must be built by `sendApiError` (it
 *    stamps a per-request request_id the core has no access to), so failure
 *    branches carry `code`/`message`/`details` for the route to map.
 */

import type { PoolClient } from 'pg';
import {
  type DocumentUpdateInput,
  type DocumentWriteInput,
  type BelongsToInput,
  type ResourceDto,
  type TypedDocumentRow,
  type TypedDocumentResource,
} from '../platform/api/v1/schemas/typed-document.js';
import { eventBus } from '../platform/webhooks/event-bus.js';
import { buildEvents } from '../platform/webhooks/events.js';

// ---------------------------------------------------------------------------
// Context / result / side-effect shapes
// ---------------------------------------------------------------------------

/**
 * Minimal actor context for a typed-document mutation. `PlatformAuth` (the
 * bearer middleware type) satisfies this structurally, as does `FleetContext`.
 */
export interface TypedDocumentContext {
  workspaceId: string;
  userId: string;
}

export type TypedDocumentSideEffect = { kind: 'webhooks_dispatch'; eventIds: string[] };

export type TypedDocumentWriteResult =
  | { ok: true; status: number; body?: unknown; sideEffects?: TypedDocumentSideEffect[] }
  | { ok: false; code: 'validation_failed' | 'not_found'; message: string; details?: Record<string, unknown> };

export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Run the deferred (post-commit) side effects produced by a service call. */
export function runTypedDocumentSideEffects(effects: TypedDocumentSideEffect[] | undefined): void {
  for (const effect of effects ?? []) {
    if (effect.kind === 'webhooks_dispatch') {
      eventBus.dispatchSoon(effect.eventIds);
    }
  }
}

// ---------------------------------------------------------------------------
// Column selection / read helpers (shared with the GET route handlers)
// ---------------------------------------------------------------------------

const BASE_COLUMNS = `d.id, d.document_type, d.title, d.parent_id, d.ticket_number, d.visibility, d.properties, d.created_at, d.updated_at, d.created_by, d.archived_at, d.started_at, d.completed_at, d.cancelled_at, d.reopened_at, d.converted_from_id`;
const BELONGS_TO_TARGET_TYPES: Record<BelongsToInput['type'], string> = {
  program: 'program',
  project: 'project',
  sprint: 'sprint',
  parent: 'issue',
};

function computedColumns(resource: TypedDocumentResource): string[] {
  if (resource.documentType === 'issue') {
    return [
      `(SELECT COALESCE(
          jsonb_agg(
            jsonb_strip_nulls(jsonb_build_object(
              'id', da.related_id,
              'type', da.relationship_type,
              'title', related.title,
              'color', related.properties->>'color'
            ))
            ORDER BY da.relationship_type, da.created_at
          ),
          '[]'::jsonb
        )
        FROM document_associations da
        LEFT JOIN documents related ON related.id = da.related_id AND related.workspace_id = d.workspace_id
        WHERE da.document_id = d.id
          AND da.relationship_type IN ('program', 'project', 'sprint', 'parent')) AS belongs_to`,
    ];
  }

  if (resource.documentType === 'program') {
    return [
      `(SELECT COUNT(*) FROM documents i
        JOIN document_associations da ON da.document_id = i.id AND da.related_id = d.id AND da.relationship_type = 'program'
        WHERE i.workspace_id = d.workspace_id AND i.document_type = 'issue' AND i.archived_at IS NULL AND i.deleted_at IS NULL) AS issue_count`,
      `(SELECT COUNT(*) FROM documents s
        JOIN document_associations da ON da.document_id = s.id AND da.related_id = d.id AND da.relationship_type = 'program'
        WHERE s.workspace_id = d.workspace_id AND s.document_type = 'sprint' AND s.archived_at IS NULL AND s.deleted_at IS NULL) AS sprint_count`,
    ];
  }

  if (resource.documentType === 'project') {
    return [
      `(SELECT COUNT(*) FROM documents i
        JOIN document_associations da ON da.document_id = i.id AND da.related_id = d.id AND da.relationship_type = 'project'
        WHERE i.workspace_id = d.workspace_id AND i.document_type = 'issue' AND i.archived_at IS NULL AND i.deleted_at IS NULL) AS issue_count`,
      `(SELECT COUNT(*) FROM documents s
        JOIN document_associations da ON da.document_id = s.id AND da.related_id = d.id AND da.relationship_type = 'project'
        WHERE s.workspace_id = d.workspace_id AND s.document_type = 'sprint' AND s.archived_at IS NULL AND s.deleted_at IS NULL) AS sprint_count`,
      `CASE
        WHEN d.archived_at IS NOT NULL THEN 'archived'
        WHEN d.properties->>'plan_validated' IS NOT NULL THEN 'completed'
        ELSE COALESCE((
          SELECT CASE MAX(
            CASE
              WHEN CURRENT_DATE BETWEEN
                (w.sprint_start_date + ((s.properties->>'sprint_number')::int - 1) * 7)
                AND (w.sprint_start_date + ((s.properties->>'sprint_number')::int - 1) * 7 + 6)
              THEN 3
              WHEN CURRENT_DATE < (w.sprint_start_date + ((s.properties->>'sprint_number')::int - 1) * 7)
              THEN 2
              ELSE 1
            END
          )
          WHEN 3 THEN 'active'
          WHEN 2 THEN 'planned'
          ELSE NULL
          END
          FROM documents s
          JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.workspace_id = d.workspace_id
            AND s.document_type = 'sprint'
            AND s.archived_at IS NULL
            AND s.deleted_at IS NULL
            AND s.properties->>'project_id' = d.id::text
            AND (s.properties->>'sprint_number') ~ '^[0-9]+$'
            AND jsonb_array_length(COALESCE(s.properties->'assignee_ids', '[]'::jsonb)) > 0
        ), 'backlog')
      END AS inferred_status`,
    ];
  }

  if (resource.documentType === 'sprint') {
    return [
      `(SELECT COUNT(*) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.workspace_id = d.workspace_id AND i.document_type = 'issue' AND i.archived_at IS NULL AND i.deleted_at IS NULL) AS issue_count`,
      `(SELECT COUNT(*) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.workspace_id = d.workspace_id AND i.document_type = 'issue' AND i.archived_at IS NULL AND i.deleted_at IS NULL AND i.properties->>'state' = 'done') AS completed_count`,
      `(SELECT COUNT(*) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.workspace_id = d.workspace_id AND i.document_type = 'issue' AND i.archived_at IS NULL AND i.deleted_at IS NULL AND i.properties->>'state' IN ('in_progress', 'in_review')) AS started_count`,
      `(SELECT COUNT(*) > 0 FROM documents pl
        WHERE pl.workspace_id = d.workspace_id AND pl.parent_id = d.id AND pl.document_type = 'weekly_plan' AND pl.archived_at IS NULL AND pl.deleted_at IS NULL) AS has_plan`,
      `(SELECT COUNT(*) > 0 FROM documents rt
        JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = d.id AND rda.relationship_type = 'sprint'
        WHERE rt.workspace_id = d.workspace_id AND rt.document_type = 'weekly_retro' AND rt.archived_at IS NULL AND rt.deleted_at IS NULL AND rt.properties->>'outcome' IS NOT NULL) AS has_retro`,
      `(SELECT rt.properties->>'outcome' FROM documents rt
        JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = d.id AND rda.relationship_type = 'sprint'
        WHERE rt.workspace_id = d.workspace_id AND rt.document_type = 'weekly_retro' AND rt.archived_at IS NULL AND rt.deleted_at IS NULL AND rt.properties->>'outcome' IS NOT NULL
        ORDER BY rt.created_at DESC LIMIT 1) AS retro_outcome`,
      `(SELECT rt.id FROM documents rt
        JOIN document_associations rda ON rda.document_id = rt.id AND rda.related_id = d.id AND rda.relationship_type = 'sprint'
        WHERE rt.workspace_id = d.workspace_id AND rt.document_type = 'weekly_retro' AND rt.archived_at IS NULL AND rt.deleted_at IS NULL AND rt.properties->>'outcome' IS NOT NULL
        ORDER BY rt.created_at DESC LIMIT 1) AS retro_id`,
    ];
  }

  return [];
}

export function selectTypedDocumentColumns(
  resource: TypedDocumentResource,
  opts: { detail?: boolean; cursor?: boolean } = {}
): string {
  return [
    BASE_COLUMNS,
    opts.detail ? 'd.content' : null,
    ...computedColumns(resource),
    opts.cursor ? 'd.created_at::text AS created_at_raw' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export async function loadTypedDocument(
  db: Queryable,
  ctx: TypedDocumentContext,
  resource: TypedDocumentResource,
  id: string
): Promise<TypedDocumentRow | null> {
  const result = await db.query<TypedDocumentRow>(
    `SELECT ${selectTypedDocumentColumns(resource, { detail: true })} FROM documents d
     WHERE d.id = $1
       AND d.workspace_id = $2
       AND d.archived_at IS NULL
       AND d.deleted_at IS NULL
       AND d.document_type::text = $3
       AND (d.visibility = 'workspace' OR d.created_by = $4)`,
    [id, ctx.workspaceId, resource.documentType, ctx.userId]
  );
  return result.rows[0] ?? null;
}

export function hasTypedDocumentUpdates(input: DocumentUpdateInput): boolean {
  return (
    input.title !== undefined ||
    input.parent_id !== undefined ||
    input.visibility !== undefined ||
    input.content !== undefined ||
    input.belongs_to !== undefined ||
    (input.properties !== undefined && Object.keys(input.properties).length > 0)
  );
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

async function validateBelongsTo(
  client: PoolClient,
  workspaceId: string,
  associations: BelongsToInput[] | undefined
): Promise<string | null> {
  if (!associations?.length) return null;

  const ids = [...new Set(associations.map((assoc) => assoc.id))];
  const result = await client.query<{ id: string; document_type: string }>(
    `SELECT id, document_type::text
       FROM documents
       WHERE workspace_id = $1
         AND id = ANY($2::uuid[])
         AND archived_at IS NULL
         AND deleted_at IS NULL`,
    [workspaceId, ids]
  );
  const byId = new Map(result.rows.map((row) => [row.id, row.document_type]));

  for (const assoc of associations) {
    const actualType = byId.get(assoc.id);
    const expectedType = BELONGS_TO_TARGET_TYPES[assoc.type];
    if (!actualType) return `belongs_to target ${assoc.id} was not found`;
    if (actualType !== expectedType) {
      return `belongs_to target ${assoc.id} must be a ${expectedType} document for relationship type ${assoc.type}`;
    }
  }

  return null;
}

async function insertBelongsTo(client: PoolClient, documentId: string, associations: BelongsToInput[]): Promise<void> {
  if (associations.length === 0) return;
  await client.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
       SELECT $1::uuid, unnest($2::uuid[]), unnest($3::text[])::relationship_type
       ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
    [documentId, associations.map((assoc) => assoc.id), associations.map((assoc) => assoc.type)]
  );
}

async function syncBelongsTo(client: PoolClient, documentId: string, associations: BelongsToInput[]): Promise<void> {
  await client.query(
    `DELETE FROM document_associations
       WHERE document_id = $1
         AND relationship_type IN ('program', 'project', 'sprint', 'parent')`,
    [documentId]
  );
  await insertBelongsTo(client, documentId, associations);
}

async function nextTicketNumber(client: PoolClient, workspaceId: string): Promise<number> {
  const workspaceIdHex = workspaceId.replace(/-/g, '').substring(0, 15);
  const lockKey = parseInt(workspaceIdHex, 16);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

  const ticket = await client.query<{ next_number: number }>(
    `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
       FROM documents
       WHERE workspace_id = $1 AND document_type = 'issue'`,
    [workspaceId]
  );
  return ticket.rows[0]!.next_number;
}

async function insertDocument(
  client: PoolClient,
  ctx: TypedDocumentContext,
  resource: TypedDocumentResource,
  input: DocumentWriteInput
): Promise<string> {
  const ticketNumber = resource.assignTicketNumber ? await nextTicketNumber(client, ctx.workspaceId) : null;
  const result = await client.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, parent_id, properties, ticket_number, created_by, visibility, content)
     VALUES ($1, $2::document_type, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      ctx.workspaceId,
      resource.documentType,
      input.title,
      input.parent_id ?? null,
      JSON.stringify(input.properties ?? {}),
      ticketNumber,
      ctx.userId,
      input.visibility ?? 'workspace',
      input.content != null ? JSON.stringify(input.content) : null,
    ]
  );
  const id = result.rows[0]!.id;
  if (resource.documentType === 'issue') {
    await insertBelongsTo(client, id, input.belongs_to ?? []);
  }
  return id;
}

function buildUpdate(input: DocumentUpdateInput): { updates: string[]; values: unknown[]; nextParam: number } {
  const updates: string[] = [];
  const values: unknown[] = [];
  let param = 1;
  if (input.title !== undefined) {
    updates.push(`title = $${param++}`);
    values.push(input.title);
  }
  if (input.parent_id !== undefined) {
    updates.push(`parent_id = $${param++}`);
    values.push(input.parent_id);
  }
  if (input.properties !== undefined && Object.keys(input.properties).length > 0) {
    updates.push(`properties = COALESCE(properties, '{}'::jsonb) || $${param++}::jsonb`);
    values.push(JSON.stringify(input.properties));
  }
  if (input.visibility !== undefined) {
    updates.push(`visibility = $${param++}`);
    values.push(input.visibility);
  }
  if (input.content !== undefined) {
    updates.push(`content = $${param++}`);
    values.push(JSON.stringify(input.content));
    updates.push(`yjs_state = NULL`);
  }
  updates.push(`updated_at = now()`);
  return { updates, values, nextParam: param };
}

/** Webhook actor context for a mutation. */
function eventActor(ctx: TypedDocumentContext) {
  return { workspaceId: ctx.workspaceId, actorUserId: ctx.userId };
}

// ---------------------------------------------------------------------------
// CREATE core
// ---------------------------------------------------------------------------

/**
 * Core of `POST /api/v1/{resource}`. Publishes the `created` event in the
 * same transaction as the insert; the caller runs
 * `runTypedDocumentSideEffects(result.sideEffects)` after this returns.
 */
export async function createTypedDocumentCore(
  client: PoolClient,
  ctx: TypedDocumentContext,
  resource: TypedDocumentResource,
  input: DocumentWriteInput
): Promise<TypedDocumentWriteResult> {
  await client.query('BEGIN');
  const belongsToError = await validateBelongsTo(client, ctx.workspaceId, input.belongs_to);
  if (belongsToError) {
    await client.query('ROLLBACK');
    return { ok: false, code: 'validation_failed', message: belongsToError, details: { reason: 'invalid_belongs_to' } };
  }
  const documentId = await insertDocument(client, ctx, resource, input);
  const row = await loadTypedDocument(client, ctx, resource, documentId);
  if (!row) {
    throw new Error(`Created ${resource.name} could not be reloaded`);
  }
  const afterDto = resource.toResponse(row) as ResourceDto;
  const eventIds = await eventBus.publish(
    client,
    buildEvents(resource, eventActor(ctx), { kind: 'created', after: afterDto }),
    { visibility: row.visibility, ownerId: row.created_by }
  );
  await client.query('COMMIT');
  return { ok: true, status: 201, body: afterDto, sideEffects: [{ kind: 'webhooks_dispatch', eventIds }] };
}

// ---------------------------------------------------------------------------
// PATCH core
// ---------------------------------------------------------------------------

/**
 * Core of `PATCH /api/v1/{resource}/:id`. The pre-update row is loaded inside
 * the transaction (it doubles as the existence/visibility check) and mapped
 * through `toResponse` to compute `previous_attributes` and detect semantic
 * transitions generically. The caller checks `hasTypedDocumentUpdates` BEFORE
 * acquiring a client.
 */
export async function patchTypedDocumentCore(
  client: PoolClient,
  ctx: TypedDocumentContext,
  resource: TypedDocumentResource,
  id: string,
  input: DocumentUpdateInput
): Promise<TypedDocumentWriteResult> {
  const { updates, values, nextParam: param } = buildUpdate(input);

  await client.query('BEGIN');
  const beforeRow = await loadTypedDocument(client, ctx, resource, id);
  if (!beforeRow) {
    await client.query('ROLLBACK');
    return { ok: false, code: 'not_found', message: `${resource.name} not found` };
  }

  const belongsToError = await validateBelongsTo(client, ctx.workspaceId, input.belongs_to);
  if (belongsToError) {
    await client.query('ROLLBACK');
    return { ok: false, code: 'validation_failed', message: belongsToError, details: { reason: 'invalid_belongs_to' } };
  }

  await client.query<{ id: string }>(
    `UPDATE documents SET ${updates.join(', ')}
     WHERE id = $${param} AND workspace_id = $${param + 1} AND document_type::text = $${param + 2}
     RETURNING id`,
    [...values, id, ctx.workspaceId, resource.documentType]
  );
  if (resource.documentType === 'issue' && input.belongs_to !== undefined) {
    await syncBelongsTo(client, id, input.belongs_to);
  }
  const row = await loadTypedDocument(client, ctx, resource, id);
  if (!row) {
    throw new Error(`Updated ${resource.name} could not be reloaded`);
  }
  const beforeDto = resource.toResponse(beforeRow) as ResourceDto;
  const afterDto = resource.toResponse(row) as ResourceDto;
  const eventIds = await eventBus.publish(
    client,
    buildEvents(resource, eventActor(ctx), { kind: 'updated', before: beforeDto, after: afterDto }),
    { visibility: row.visibility, ownerId: row.created_by }
  );
  await client.query('COMMIT');
  return { ok: true, status: 200, body: afterDto, sideEffects: [{ kind: 'webhooks_dispatch', eventIds }] };
}

// ---------------------------------------------------------------------------
// DELETE core
// ---------------------------------------------------------------------------

/**
 * Core of `DELETE /api/v1/{resource}/:id`. Wrapped in a transaction (unlike a
 * bare DELETE) so the tombstone event + its fanned-out deliveries commit
 * atomically with the document removal. The `DELETE ... RETURNING` statement
 * is the existence/visibility check.
 */
export async function deleteTypedDocumentCore(
  client: PoolClient,
  ctx: TypedDocumentContext,
  resource: TypedDocumentResource,
  id: string
): Promise<TypedDocumentWriteResult> {
  await client.query('BEGIN');
  const result = await client.query<{ id: string; visibility: string; created_by: string | null }>(
    `DELETE FROM documents
     WHERE id = $1
       AND workspace_id = $2
       AND document_type::text = $3
       AND (visibility = 'workspace' OR created_by = $4)
     RETURNING id, visibility, created_by`,
    [id, ctx.workspaceId, resource.documentType, ctx.userId]
  );
  const deleted = result.rows[0];
  if (!deleted) {
    await client.query('ROLLBACK');
    return { ok: false, code: 'not_found', message: `${resource.name} not found` };
  }
  const eventIds = await eventBus.publish(
    client,
    buildEvents(resource, eventActor(ctx), { kind: 'deleted', id }),
    { visibility: deleted.visibility, ownerId: deleted.created_by }
  );
  await client.query('COMMIT');
  return { ok: true, status: 204, sideEffects: [{ kind: 'webhooks_dispatch', eventIds }] };
}
