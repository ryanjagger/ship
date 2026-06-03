import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../middleware/bearer.js';
import type { PlatformAuth } from '../middleware/bearer.js';
import { requireAnyScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import {
  TYPED_DOCUMENT_RESOURCES,
  TypedDocumentListQuerySchema,
  type DocumentUpdateInput,
  type DocumentWriteInput,
  type BelongsToInput,
  type TypedDocumentRow,
  type TypedDocumentResource,
} from '../schemas/typed-document.js';

interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

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

function selectColumns(resource: TypedDocumentResource, opts: { detail?: boolean; cursor?: boolean } = {}): string {
  return [
    BASE_COLUMNS,
    opts.detail ? 'd.content' : null,
    ...computedColumns(resource),
    opts.cursor ? 'd.created_at::text AS created_at_raw' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function readScopes(resource: TypedDocumentResource): string[] {
  return [resource.readScope, 'documents:read'];
}

function writeScopes(resource: TypedDocumentResource): string[] {
  return [resource.writeScope, 'documents:write'];
}

function hasUpdates(input: DocumentUpdateInput): boolean {
  return (
    input.title !== undefined ||
    input.parent_id !== undefined ||
    input.visibility !== undefined ||
    input.content !== undefined ||
    input.belongs_to !== undefined ||
    (input.properties !== undefined && Object.keys(input.properties).length > 0)
  );
}

async function loadDocument(
  db: Queryable,
  platform: PlatformAuth,
  resource: TypedDocumentResource,
  id: string
): Promise<TypedDocumentRow | null> {
  const result = await db.query<TypedDocumentRow>(
    `SELECT ${selectColumns(resource, { detail: true })} FROM documents d
     WHERE d.id = $1
       AND d.workspace_id = $2
       AND d.archived_at IS NULL
       AND d.deleted_at IS NULL
       AND d.document_type::text = $3
       AND (d.visibility = 'workspace' OR d.created_by = $4)`,
    [id, platform.workspaceId, resource.documentType, platform.userId]
  );
  return result.rows[0] ?? null;
}

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
  platform: PlatformAuth,
  resource: TypedDocumentResource,
  input: DocumentWriteInput
): Promise<string> {
  const ticketNumber = resource.assignTicketNumber ? await nextTicketNumber(client, platform.workspaceId) : null;
  const result = await client.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, parent_id, properties, ticket_number, created_by, visibility, content)
     VALUES ($1, $2::document_type, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      platform.workspaceId,
      resource.documentType,
      input.title,
      input.parent_id ?? null,
      JSON.stringify(input.properties ?? {}),
      ticketNumber,
      platform.userId,
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

function createTypedDocumentRouter(resource: TypedDocumentResource): RouterType {
  const router: RouterType = Router();

  router.get('/', bearerAuth, requireAnyScope(readScopes(resource)), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const parsed = TypedDocumentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid query parameters', { details: parsed.error.flatten() });
      return;
    }

    const { limit, cursor } = parsed.data;
    let cur = null;
    if (cursor) {
      cur = decodeCursor(cursor);
      if (!cur) {
        sendApiError(res, req, 'validation_failed', 'Invalid cursor');
        return;
      }
    }

    const params: unknown[] = [platform.workspaceId, platform.userId, resource.documentType];
    let where = `d.workspace_id = $1
      AND d.archived_at IS NULL
      AND d.deleted_at IS NULL
      AND (d.visibility = 'workspace' OR d.created_by = $2)
      AND d.document_type::text = $3`;

    if (cur) {
      params.push(cur.created_at, cur.id);
      where += ` AND (d.created_at, d.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    params.push(limit + 1);
    const limitIdx = params.length;

    try {
      const result = await pool.query<TypedDocumentRow>(
        `SELECT ${selectColumns(resource, { cursor: true })} FROM documents d
         WHERE ${where}
         ORDER BY d.created_at ASC, d.id ASC
         LIMIT $${limitIdx}`,
        params
      );

      let rows = result.rows;
      let nextCursor: string | null = null;
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        const last = rows[rows.length - 1]!;
        nextCursor = encodeCursor({ created_at: last.created_at_raw ?? iso(last.created_at), id: last.id });
      }

      res.json({ data: rows.map(resource.toResponse), next_cursor: nextCursor });
    } catch (error) {
      console.error(`[api/v1] GET /${resource.path} error:`, error);
      sendApiError(res, req, 'server_error', `Failed to list ${resource.path}`);
    }
  });

  router.get('/:id', bearerAuth, requireAnyScope(readScopes(resource)), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', `${resource.name} not found`);
      return;
    }

    try {
      const row = await loadDocument(pool, platform, resource, id.data);
      if (!row) {
        sendApiError(res, req, 'not_found', `${resource.name} not found`);
        return;
      }
      res.json(resource.toResponse(row));
    } catch (error) {
      console.error(`[api/v1] GET /${resource.path}/:id error:`, error);
      sendApiError(res, req, 'server_error', `Failed to load ${resource.path}`);
    }
  });

  router.post('/', bearerAuth, requireAnyScope(writeScopes(resource)), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const parsed = resource.createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', `Invalid ${resource.name}`, { details: parsed.error.flatten() });
      return;
    }

    const client = await pool.connect();
    try {
      const input = resource.toCreate(parsed.data);
      await client.query('BEGIN');
      const belongsToError = await validateBelongsTo(client, platform.workspaceId, input.belongs_to);
      if (belongsToError) {
        await client.query('ROLLBACK');
        sendApiError(res, req, 'validation_failed', belongsToError, { details: { reason: 'invalid_belongs_to' } });
        return;
      }
      const documentId = await insertDocument(client, platform, resource, input);
      const row = await loadDocument(client, platform, resource, documentId);
      if (!row) {
        throw new Error(`Created ${resource.name} could not be reloaded`);
      }
      await client.query('COMMIT');
      res.status(201).json(resource.toResponse(row));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[api/v1] POST /${resource.path} error:`, error);
      sendApiError(res, req, 'server_error', `Failed to create ${resource.name}`);
    } finally {
      client.release();
    }
  });

  router.patch('/:id', bearerAuth, requireAnyScope(writeScopes(resource)), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', `${resource.name} not found`);
      return;
    }

    const parsed = resource.updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', `Invalid ${resource.name}`, { details: parsed.error.flatten() });
      return;
    }

    const data = resource.toUpdate(parsed.data);
    if (!hasUpdates(data)) {
      sendApiError(res, req, 'validation_failed', `No ${resource.name} fields to update`);
      return;
    }
    const { updates, values, nextParam: param } = buildUpdate(data);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM documents
         WHERE id = $1
           AND workspace_id = $2
           AND document_type::text = $3
           AND archived_at IS NULL
           AND deleted_at IS NULL
           AND (visibility = 'workspace' OR created_by = $4)`,
        [id.data, platform.workspaceId, resource.documentType, platform.userId]
      );
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        sendApiError(res, req, 'not_found', `${resource.name} not found`);
        return;
      }

      const belongsToError = await validateBelongsTo(client, platform.workspaceId, data.belongs_to);
      if (belongsToError) {
        await client.query('ROLLBACK');
        sendApiError(res, req, 'validation_failed', belongsToError, { details: { reason: 'invalid_belongs_to' } });
        return;
      }

      await client.query<{ id: string }>(
        `UPDATE documents SET ${updates.join(', ')}
         WHERE id = $${param} AND workspace_id = $${param + 1} AND document_type::text = $${param + 2}
         RETURNING id`,
        [...values, id.data, platform.workspaceId, resource.documentType]
      );
      if (resource.documentType === 'issue' && data.belongs_to !== undefined) {
        await syncBelongsTo(client, id.data, data.belongs_to);
      }
      const row = await loadDocument(client, platform, resource, id.data);
      if (!row) {
        throw new Error(`Updated ${resource.name} could not be reloaded`);
      }
      await client.query('COMMIT');
      res.json(resource.toResponse(row));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[api/v1] PATCH /${resource.path}/:id error:`, error);
      sendApiError(res, req, 'server_error', `Failed to update ${resource.name}`);
    } finally {
      client.release();
    }
  });

  router.delete('/:id', bearerAuth, requireAnyScope(writeScopes(resource)), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', `${resource.name} not found`);
      return;
    }

    try {
      const result = await pool.query<{ id: string }>(
        `DELETE FROM documents
         WHERE id = $1
           AND workspace_id = $2
           AND document_type::text = $3
           AND (visibility = 'workspace' OR created_by = $4)
         RETURNING id`,
        [id.data, platform.workspaceId, resource.documentType, platform.userId]
      );
      if (!result.rows[0]) {
        sendApiError(res, req, 'not_found', `${resource.name} not found`);
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error(`[api/v1] DELETE /${resource.path}/:id error:`, error);
      sendApiError(res, req, 'server_error', `Failed to delete ${resource.name}`);
    }
  });

  return router;
}

export const typedDocumentRouters = TYPED_DOCUMENT_RESOURCES.map((resource) => ({
  path: resource.path,
  router: createTypedDocumentRouter(resource),
}));
