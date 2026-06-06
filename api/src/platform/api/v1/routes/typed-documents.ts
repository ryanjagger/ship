import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { z } from 'zod';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../middleware/bearer.js';
import { requireAnyScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import {
  TYPED_DOCUMENT_RESOURCES,
  TypedDocumentListQuerySchema,
  type TypedDocumentRow,
  type TypedDocumentResource,
} from '../schemas/typed-document.js';
import {
  createTypedDocumentCore,
  patchTypedDocumentCore,
  deleteTypedDocumentCore,
  loadTypedDocument,
  selectTypedDocumentColumns,
  hasTypedDocumentUpdates,
  runTypedDocumentSideEffects,
  type TypedDocumentWriteResult,
} from '../../../../services/typed-documents-service.js';

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function readScopes(resource: TypedDocumentResource): string[] {
  return [resource.readScope, 'documents:read'];
}

function writeScopes(resource: TypedDocumentResource): string[] {
  return [resource.writeScope, 'documents:write'];
}

/** Map a core's in-band failure onto the v1 error envelope. */
function sendWriteFailure(res: Response, req: Request, outcome: Extract<TypedDocumentWriteResult, { ok: false }>): void {
  sendApiError(res, req, outcome.code, outcome.message, outcome.details ? { details: outcome.details } : undefined);
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
        `SELECT ${selectTypedDocumentColumns(resource, { cursor: true })} FROM documents d
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
      const row = await loadTypedDocument(pool, platform, resource, id.data);
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
      const outcome = await createTypedDocumentCore(client, platform, resource, input);
      if (!outcome.ok) {
        sendWriteFailure(res, req, outcome);
        return;
      }
      runTypedDocumentSideEffects(outcome.sideEffects);
      res.status(outcome.status).json(outcome.body);
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
    if (!hasTypedDocumentUpdates(data)) {
      sendApiError(res, req, 'validation_failed', `No ${resource.name} fields to update`);
      return;
    }

    const client = await pool.connect();
    try {
      const outcome = await patchTypedDocumentCore(client, platform, resource, id.data, data);
      if (!outcome.ok) {
        sendWriteFailure(res, req, outcome);
        return;
      }
      runTypedDocumentSideEffects(outcome.sideEffects);
      res.status(outcome.status).json(outcome.body);
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

    const client = await pool.connect();
    try {
      const outcome = await deleteTypedDocumentCore(client, platform, resource, id.data);
      if (!outcome.ok) {
        sendWriteFailure(res, req, outcome);
        return;
      }
      runTypedDocumentSideEffects(outcome.sideEffects);
      res.status(204).send();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[api/v1] DELETE /${resource.path}/:id error:`, error);
      sendApiError(res, req, 'server_error', `Failed to delete ${resource.name}`);
    } finally {
      client.release();
    }
  });

  return router;
}

export const typedDocumentRouters = TYPED_DOCUMENT_RESOURCES.map((resource) => ({
  path: resource.path,
  router: createTypedDocumentRouter(resource),
}));
