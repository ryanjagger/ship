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
  type TypedDocumentRow,
  type TypedDocumentResource,
} from '../schemas/typed-document.js';

const SUMMARY_COLUMNS = `id, document_type, title, parent_id, ticket_number, visibility, properties, created_at, updated_at, created_by, archived_at, started_at, completed_at, cancelled_at, reopened_at, converted_from_id`;
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, content`;

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
    (input.properties !== undefined && Object.keys(input.properties).length > 0)
  );
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
): Promise<TypedDocumentRow> {
  const ticketNumber = resource.assignTicketNumber ? await nextTicketNumber(client, platform.workspaceId) : null;
  const result = await client.query<TypedDocumentRow>(
    `INSERT INTO documents (workspace_id, document_type, title, parent_id, properties, ticket_number, created_by, visibility, content)
     VALUES ($1, $2::document_type, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${DETAIL_COLUMNS}`,
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
  return result.rows[0]!;
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
    let where = `workspace_id = $1
      AND archived_at IS NULL
      AND deleted_at IS NULL
      AND (visibility = 'workspace' OR created_by = $2)
      AND document_type::text = $3`;

    if (cur) {
      params.push(cur.created_at, cur.id);
      where += ` AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    params.push(limit + 1);
    const limitIdx = params.length;

    try {
      const result = await pool.query<TypedDocumentRow>(
        `SELECT ${SUMMARY_COLUMNS}, created_at::text AS created_at_raw FROM documents
         WHERE ${where}
         ORDER BY created_at ASC, id ASC
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
      const result = await pool.query<TypedDocumentRow>(
        `SELECT ${DETAIL_COLUMNS} FROM documents
         WHERE id = $1
           AND workspace_id = $2
           AND archived_at IS NULL
           AND deleted_at IS NULL
           AND document_type::text = $3
           AND (visibility = 'workspace' OR created_by = $4)`,
        [id.data, platform.workspaceId, resource.documentType, platform.userId]
      );
      const row = result.rows[0];
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
      const row = await insertDocument(client, platform, resource, input);
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

      const result = await client.query<TypedDocumentRow>(
        `UPDATE documents SET ${updates.join(', ')}
         WHERE id = $${param} AND workspace_id = $${param + 1} AND document_type::text = $${param + 2}
         RETURNING ${DETAIL_COLUMNS}`,
        [...values, id.data, platform.workspaceId, resource.documentType]
      );
      await client.query('COMMIT');
      res.json(resource.toResponse(result.rows[0]!));
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
