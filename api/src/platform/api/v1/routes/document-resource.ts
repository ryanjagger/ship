import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { HIDDEN_DOCUMENT_TYPES } from '@ship/shared';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import {
  ListDocumentsQuerySchema,
  ListTypedQuerySchema,
  CreateDocumentSchema,
  CreateTypedDocumentSchema,
} from '../schemas/document.js';

/**
 * Shared engine for every document-backed resource (PRD §5.5). `documents` is
 * the SUPERSET resource — it returns any user-facing document_type and lets the
 * caller choose the type on create. The typed resources (`/issues`, `/sprints`,
 * `/wiki`) are literal specializations of this same engine, pinned to one
 * `document_type` and gated by the narrower `{type}:read|write` scopes. Building
 * them from one factory is why "documents is the superset" is true structurally,
 * not just by comment: there is exactly one query path and one projection.
 *
 * Backing-store types (`conversation`, `insight`) are excluded everywhere via
 * the shared HIDDEN_DOCUMENT_TYPES constant, so the public filter can't drift.
 */

const HIDDEN = [...HIDDEN_DOCUMENT_TYPES];

// Public column projection — never leaks internal columns (yjs_state, etc.).
const SUMMARY_COLUMNS = `id, document_type, title, parent_id, ticket_number, visibility, properties, created_at, updated_at, created_by`;
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, content`;

interface DocRow {
  id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
  ticket_number: number | null;
  visibility: string;
  properties: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string | null;
  content?: unknown;
  // Full-precision (microsecond) created_at for the keyset cursor. node-pg
  // parses timestamptz to a millisecond JS Date, which would truncate the
  // cursor and make the boundary row re-appear on the next page; the ::text
  // form preserves microseconds and casts back exactly.
  created_at_raw?: string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function toSummary(row: DocRow) {
  return {
    id: row.id,
    document_type: row.document_type,
    title: row.title,
    parent_id: row.parent_id,
    ticket_number: row.ticket_number,
    visibility: row.visibility,
    properties: row.properties ?? {},
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: row.created_by,
  };
}

function toDetail(row: DocRow) {
  return { ...toSummary(row), content: row.content ?? null };
}

export interface DocumentResourceConfig {
  /**
   * null  → the superset `documents` resource (any user-facing type, caller
   *         chooses the type on create, `?type=` filter allowed).
   * string → a typed resource pinned to exactly this `document_type`.
   */
  pinnedType: string | null;
  readScope: string;
  writeScope: string;
  /** Human label for not-found messages, e.g. "Issue not found". */
  notFoundLabel?: string;
}

/**
 * Build the Express router for one document-backed resource. The pinned-type
 * variants and the superset variant differ only in their type predicate and
 * create body — everything else (visibility scoping, soft-delete filtering,
 * keyset pagination, projection) is identical by construction.
 */
export function createDocumentResourceRouter(config: DocumentResourceConfig): RouterType {
  const { pinnedType, readScope, writeScope } = config;
  const notFound = config.notFoundLabel ?? 'Document not found';
  const router: RouterType = Router();

  // GET / — list (requires the read scope).
  router.get('/', bearerAuth, requireScope(readScope), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    // The superset resource accepts an optional `?type=` filter; typed
    // resources have their type fixed by the route, so they only accept paging.
    const parsed = (pinnedType ? ListTypedQuerySchema : ListDocumentsQuerySchema).safeParse(req.query);
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid query parameters', { details: parsed.error.flatten() });
      return;
    }
    const { limit, cursor } = parsed.data;
    const typeFilter = pinnedType ?? ('type' in parsed.data ? parsed.data.type : undefined);

    let cur = null;
    if (cursor) {
      cur = decodeCursor(cursor);
      if (!cur) {
        sendApiError(res, req, 'validation_failed', 'Invalid cursor');
        return;
      }
    }

    // params: $1 workspace, $2 user, $3 hidden types
    const params: unknown[] = [platform.workspaceId, platform.userId, HIDDEN];
    let where = `workspace_id = $1
        AND archived_at IS NULL
        AND deleted_at IS NULL
        AND (visibility = 'workspace' OR created_by = $2)
        AND document_type::text <> ALL($3::text[])`;

    if (typeFilter) {
      params.push(typeFilter);
      where += ` AND document_type::text = $${params.length}`;
    }
    if (cur) {
      // Keyset: rows strictly after the cursor in the stable (created_at, id) order.
      params.push(cur.created_at, cur.id);
      where += ` AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    params.push(limit + 1); // fetch one extra to detect a next page
    const limitIdx = params.length;

    try {
      const result = await pool.query<DocRow>(
        `SELECT ${SUMMARY_COLUMNS}, created_at::text AS created_at_raw FROM documents
          WHERE ${where}
          ORDER BY created_at ASC, id ASC
          LIMIT $${limitIdx}`,
        params
      );

      const rows = result.rows;
      let nextCursor: string | null = null;
      let pageRows = rows;
      if (rows.length > limit) {
        pageRows = rows.slice(0, limit);
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = encodeCursor({ created_at: last.created_at_raw ?? iso(last.created_at), id: last.id });
      }

      res.json({ data: pageRows.map(toSummary), next_cursor: nextCursor });
    } catch (error) {
      console.error('[api/v1] GET list error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list documents');
    }
  });

  // GET /:id — fetch one (requires the read scope).
  router.get('/:id', bearerAuth, requireScope(readScope), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', notFound);
      return;
    }

    // A typed resource only resolves rows of its own type; everything else 404s
    // (so /issues/:wikiId is not found, not a leak). The superset resource
    // excludes only the backing-store types.
    const params: unknown[] = [id.data, platform.workspaceId, platform.userId];
    let typePredicate: string;
    if (pinnedType) {
      params.push(pinnedType);
      typePredicate = `document_type::text = $${params.length}`;
    } else {
      params.push(HIDDEN);
      typePredicate = `document_type::text <> ALL($${params.length}::text[])`;
    }

    try {
      const result = await pool.query<DocRow>(
        `SELECT ${DETAIL_COLUMNS} FROM documents
          WHERE id = $1
            AND workspace_id = $2
            AND archived_at IS NULL
            AND deleted_at IS NULL
            AND (visibility = 'workspace' OR created_by = $3)
            AND ${typePredicate}`,
        params
      );

      const row = result.rows[0];
      if (!row) {
        sendApiError(res, req, 'not_found', notFound);
        return;
      }
      res.json(toDetail(row));
    } catch (error) {
      console.error('[api/v1] GET :id error:', error);
      sendApiError(res, req, 'server_error', 'Failed to load document');
    }
  });

  // POST / — create (requires the write scope).
  router.post('/', bearerAuth, requireScope(writeScope), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    // Typed resources pin the type (the body has no document_type); the superset
    // resource takes it from the validated body (default 'wiki').
    let documentType: string;
    let title: string;
    let parentId: string | null | undefined;
    let properties: Record<string, unknown> | undefined;
    let visibility: 'private' | 'workspace' | undefined;
    let content: unknown;

    if (pinnedType) {
      const parsed = CreateTypedDocumentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendApiError(res, req, 'validation_failed', 'Invalid document', { details: parsed.error.flatten() });
        return;
      }
      documentType = pinnedType;
      ({ title, parent_id: parentId, properties, visibility, content } = parsed.data);
    } else {
      const parsed = CreateDocumentSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendApiError(res, req, 'validation_failed', 'Invalid document', { details: parsed.error.flatten() });
        return;
      }
      ({ title, document_type: documentType, parent_id: parentId, properties, visibility, content } = parsed.data);
    }

    try {
      const result = await pool.query<DocRow>(
        `INSERT INTO documents (workspace_id, document_type, title, parent_id, properties, created_by, visibility, content)
         VALUES ($1, $2::document_type, $3, $4, $5, $6, $7, $8)
         RETURNING ${DETAIL_COLUMNS}`,
        [
          platform.workspaceId,
          documentType,
          title,
          parentId ?? null,
          JSON.stringify(properties ?? {}),
          platform.userId,
          visibility ?? 'workspace',
          content != null ? JSON.stringify(content) : null,
        ]
      );

      const row = result.rows[0];
      if (!row) {
        sendApiError(res, req, 'server_error', 'Document was not created');
        return;
      }
      res.status(201).json(toDetail(row));
    } catch (error) {
      console.error('[api/v1] POST error:', error);
      sendApiError(res, req, 'server_error', 'Failed to create document');
    }
  });

  return router;
}
