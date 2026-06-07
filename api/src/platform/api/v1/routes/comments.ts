import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../middleware/bearer.js';
import { requireAnyScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import { postCommentCore } from '../../../../services/comments-service.js';
import { CreateCommentSchema } from '../schemas/comment.js';

/**
 * Public document comments (mounted under `/documents` → `/:id/comments`).
 *
 * Reads need `comments:read` (or broad `documents:read`); writes need
 * `comments:write` (or broad `documents:write`). The POST core is the same
 * `postCommentCore` the internal route and the Fleet agent use — single source
 * of truth, no privileged path.
 *
 * Visibility: unlike the internal route (workspace-scoped only), this public
 * surface 404s when the TARGET document is not visible to the token's user
 * (private + not the creator, archived, or deleted) — same read posture as
 * every other v1 document read. Comments on a document you cannot see must not
 * leak through this route.
 */
export const documentCommentsRouter: RouterType = Router();

function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

interface CommentRow {
  id: string;
  document_id: string;
  comment_id: string;
  parent_id: string | null;
  content: string;
  resolved_at: Date | string | null;
  author_id: string;
  author_name: string | null;
  author_email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toCommentDto(row: CommentRow) {
  return {
    id: row.id,
    document_id: row.document_id,
    comment_id: row.comment_id,
    parent_id: row.parent_id,
    content: row.content,
    resolved_at: iso(row.resolved_at),
    author: { id: row.author_id, name: row.author_name, email: row.author_email },
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

/** v1 read posture for the target document (visibility + tombstones). */
async function documentVisibleToUser(documentId: string, workspaceId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM documents
      WHERE id = $1 AND workspace_id = $2
        AND archived_at IS NULL AND deleted_at IS NULL
        AND (visibility = 'workspace' OR created_by = $3)`,
    [documentId, workspaceId, userId]
  );
  return result.rows.length > 0;
}

documentCommentsRouter.get(
  '/:id/comments',
  bearerAuth,
  requireAnyScope(['comments:read', 'documents:read']),
  async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Document not found');
      return;
    }

    try {
      if (!(await documentVisibleToUser(id.data, platform.workspaceId, platform.userId))) {
        sendApiError(res, req, 'not_found', 'Document not found');
        return;
      }

      const result = await pool.query<CommentRow>(
        `SELECT c.id, c.document_id, c.comment_id, c.parent_id, c.content, c.resolved_at,
                c.author_id, u.name AS author_name, u.email AS author_email,
                c.created_at, c.updated_at
           FROM comments c
           JOIN users u ON u.id = c.author_id
          WHERE c.document_id = $1 AND c.workspace_id = $2
          ORDER BY c.created_at ASC`,
        [id.data, platform.workspaceId]
      );
      res.json({ data: result.rows.map(toCommentDto) });
    } catch (error) {
      console.error('[api/v1] GET /documents/:id/comments error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list comments');
    }
  }
);

documentCommentsRouter.post(
  '/:id/comments',
  bearerAuth,
  requireAnyScope(['comments:write', 'documents:write']),
  async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Document not found');
      return;
    }

    const parsed = CreateCommentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid comment', { details: parsed.error.flatten() });
      return;
    }

    try {
      if (!(await documentVisibleToUser(id.data, platform.workspaceId, platform.userId))) {
        sendApiError(res, req, 'not_found', 'Document not found');
        return;
      }

      const ctx = { workspaceId: platform.workspaceId, userId: platform.userId, isAdmin: false };
      const outcome = await postCommentCore(pool, ctx, id.data, {
        comment_id: parsed.data.comment_id ?? randomUUID(),
        content: parsed.data.content,
        parent_id: parsed.data.parent_id,
      });
      if (outcome.status !== 201) {
        const message = (outcome.body as { error?: string }).error ?? 'Comment target not found';
        sendApiError(res, req, 'not_found', message);
        return;
      }
      const body = outcome.body as unknown as Record<string, unknown> & { resolved_at: Date | string | null; created_at: Date | string; updated_at: Date | string };
      res.status(201).json({
        ...body,
        resolved_at: iso(body.resolved_at),
        created_at: iso(body.created_at),
        updated_at: iso(body.updated_at),
      });
    } catch (error) {
      console.error('[api/v1] POST /documents/:id/comments error:', error);
      sendApiError(res, req, 'server_error', 'Failed to create comment');
    }
  }
);
