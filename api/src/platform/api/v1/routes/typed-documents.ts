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
  validateBelongsTo,
  type TypedDocumentWriteResult,
} from '../../../../services/typed-documents-service.js';
import {
  createIssueCore,
  patchIssueCore,
  runIssueSideEffects,
  type CreateIssueInput,
  type UpdateIssueInput,
} from '../../../../services/issues-service.js';

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

// ── Issue write re-platforming ──────────────────────────────────────────────
// v1 issue writes go through the issues-service cores (the same single source
// of truth the internal route and the Fleet agent use) instead of the generic
// typed-document cores, which lack document_history rows, lifecycle timestamps
// (started_at/completed_at/...), estimate-for-sprint validation, and the
// incomplete-children 409 confirm flow. The cores publish the issue webhook
// events themselves, so the typed-document core (the other publisher) must NOT
// run for issues — exactly one publish per write.

function toCreateIssueInput(data: Record<string, unknown>): CreateIssueInput {
  return {
    title: data.title as string,
    state: data.state as CreateIssueInput['state'],
    priority: data.priority as CreateIssueInput['priority'],
    assignee_id: data.assignee_id as string | null | undefined,
    belongs_to: data.belongs_to as CreateIssueInput['belongs_to'],
    source: data.source as CreateIssueInput['source'],
    due_date: data.due_date as string | null | undefined,
    is_system_generated: data.is_system_generated as boolean | undefined,
    accountability_target_id: data.accountability_target_id as string | null | undefined,
    accountability_type: data.accountability_type as string | null | undefined,
    estimate: data.estimate as number | null | undefined,
    content: data.content,
    visibility: data.visibility as CreateIssueInput['visibility'],
  };
}

function toUpdateIssueInput(data: Record<string, unknown>): UpdateIssueInput {
  const input: UpdateIssueInput = {};
  if (typeof data.title === 'string') input.title = data.title;
  if (data.state !== undefined) input.state = data.state as UpdateIssueInput['state'];
  if (data.priority !== undefined) input.priority = data.priority as UpdateIssueInput['priority'];
  if (data.assignee_id !== undefined) input.assignee_id = data.assignee_id as string | null;
  if (data.belongs_to !== undefined) input.belongs_to = data.belongs_to as UpdateIssueInput['belongs_to'];
  if (data.estimate !== undefined) input.estimate = data.estimate as number | null;
  if (data.confirm_orphan_children !== undefined) input.confirm_orphan_children = data.confirm_orphan_children as boolean;
  if (data.due_date !== undefined) input.due_date = data.due_date as string | null;
  if (data.rejection_reason !== undefined) input.rejection_reason = data.rejection_reason as string | null;
  if (Object.prototype.hasOwnProperty.call(data, 'content')) input.content = data.content;
  if (data.visibility !== undefined) input.visibility = data.visibility as UpdateIssueInput['visibility'];
  return input;
}

function hasUpdateIssueFields(input: UpdateIssueInput): boolean {
  return Object.keys(input).some((key) => key !== 'confirm_orphan_children');
}

/** Map the issue core's in-band failure statuses onto the v1 error envelope. */
function sendIssueCoreFailure(res: Response, req: Request, outcome: { status: number; body: any }): void {
  if (outcome.status === 404) {
    sendApiError(res, req, 'not_found', 'Issue not found');
  } else if (outcome.status === 409) {
    sendApiError(res, req, 'conflict', outcome.body.message ?? 'Conflict', {
      details: {
        reason: outcome.body.error,
        incomplete_children: outcome.body.incomplete_children,
        confirm_action: outcome.body.confirm_action,
      },
    });
  } else {
    sendApiError(res, req, 'validation_failed', outcome.body.error ?? 'Invalid Issue');
  }
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

    const { limit, cursor, belongs_to, belongs_to_type, state, updated_before, updated_after, visibility } = parsed.data;
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

    if (belongs_to) {
      params.push(belongs_to);
      let assoc = `EXISTS (SELECT 1 FROM document_associations fda
        WHERE fda.document_id = d.id AND fda.related_id = $${params.length}`;
      if (belongs_to_type) {
        params.push(belongs_to_type);
        assoc += ` AND fda.relationship_type = $${params.length}::relationship_type`;
      }
      where += ` AND ${assoc})`;
    }
    if (state) {
      params.push(state);
      where += ` AND d.properties->>'state' = $${params.length}`;
    }
    if (updated_after) {
      params.push(updated_after);
      where += ` AND d.updated_at > $${params.length}::timestamptz`;
    }
    if (updated_before) {
      params.push(updated_before);
      where += ` AND d.updated_at < $${params.length}::timestamptz`;
    }
    if (visibility) {
      // Strictly workspace-visible: drops the caller's own private documents
      // so agent-built shared context never absorbs a viewer's private rows.
      where += ` AND d.visibility = 'workspace'`;
    }

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
      if (resource.documentType === 'issue') {
        const issueInput = toCreateIssueInput(parsed.data as Record<string, unknown>);
        const belongsToError = await validateBelongsTo(client, platform.workspaceId, issueInput.belongs_to);
        if (belongsToError) {
          sendApiError(res, req, 'validation_failed', belongsToError, { details: { reason: 'invalid_belongs_to' } });
          return;
        }
        const ctx = { workspaceId: platform.workspaceId, userId: platform.userId, isAdmin: false };
        const outcome = await createIssueCore(client, ctx, issueInput);
        await runIssueSideEffects(outcome.sideEffects);
        const row = await loadTypedDocument(pool, platform, resource, (outcome.body as { id: string }).id);
        if (!row) throw new Error('Created Issue could not be reloaded');
        res.status(201).json(resource.toResponse(row));
        return;
      }

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

    if (resource.documentType === 'issue') {
      const issueInput = toUpdateIssueInput(parsed.data as Record<string, unknown>);
      if (!hasUpdateIssueFields(issueInput)) {
        sendApiError(res, req, 'validation_failed', `No ${resource.name} fields to update`);
        return;
      }

      const client = await pool.connect();
      try {
        const belongsToError = await validateBelongsTo(client, platform.workspaceId, issueInput.belongs_to);
        if (belongsToError) {
          sendApiError(res, req, 'validation_failed', belongsToError, { details: { reason: 'invalid_belongs_to' } });
          return;
        }
        const ctx = { workspaceId: platform.workspaceId, userId: platform.userId, isAdmin: false };
        // actorSource → document_history.automated_by: provenance is the OAuth
        // client_id, so agent-driven edits are attributable in field history.
        const outcome = await patchIssueCore(client, ctx, id.data, issueInput, platform.clientId);
        if (outcome.status !== 200) {
          sendIssueCoreFailure(res, req, outcome);
          return;
        }
        await runIssueSideEffects(outcome.sideEffects);
        // skipVisibilityCheck: the core already authorized this user against
        // the PRE-image. A patch that sets visibility:'private' on another
        // user's issue would otherwise commit and then have this reload
        // filtered out — a 500 after a successful mutation.
        const row = await loadTypedDocument(pool, platform, resource, id.data, { skipVisibilityCheck: true });
        if (!row) throw new Error('Updated Issue could not be reloaded');
        res.json(resource.toResponse(row));
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[api/v1] PATCH /${resource.path}/:id error:`, error);
        sendApiError(res, req, 'server_error', `Failed to update ${resource.name}`);
      } finally {
        client.release();
      }
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
