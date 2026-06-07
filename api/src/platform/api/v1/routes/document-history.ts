import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import { DocumentHistoryQuerySchema } from '../schemas/document-history.js';

/**
 * Public field-change history (`document_history` rows: state transitions,
 * assignments, plan edits, ...). Cross-document by design — `document_id`
 * repeats up to 100× so activity assembly is one query, not one call per
 * document. Requires `documents:read` (history spans document types, so the
 * broad read scope is the honest gate).
 *
 * Rows are only returned for documents the token's user can see (workspace
 * scope + v1 visibility posture). Unknown or invisible ids contribute no rows
 * — they are NOT a 404, so one bad id can't fail a 50-document activity fetch.
 */
export const documentHistoryRouter: RouterType = Router();

interface HistoryRow {
  id: number;
  document_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  automated_by: string | null;
  created_at: Date | string;
}

documentHistoryRouter.get(
  '/',
  bearerAuth,
  requireScope('documents:read'),
  async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform;
    if (!platform) {
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }

    const parsed = DocumentHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid query parameters', { details: parsed.error.flatten() });
      return;
    }

    const { document_id: documentIds, field, limit } = parsed.data;
    const params: unknown[] = [platform.workspaceId, platform.userId, documentIds];
    // Same read posture as every other v1 document read: archived and deleted
    // documents are not visible, so their history must not leak here either.
    let where = `d.workspace_id = $1
      AND d.archived_at IS NULL
      AND d.deleted_at IS NULL
      AND (d.visibility = 'workspace' OR d.created_by = $2)
      AND h.document_id = ANY($3::uuid[])`;
    if (field) {
      params.push(field);
      where += ` AND h.field = $${params.length}`;
    }
    params.push(limit);

    try {
      const result = await pool.query<HistoryRow>(
        `SELECT h.id, h.document_id, h.field, h.old_value, h.new_value, h.changed_by, h.automated_by, h.created_at
           FROM document_history h
           JOIN documents d ON d.id = h.document_id
          WHERE ${where}
          ORDER BY h.created_at DESC, h.id DESC
          LIMIT $${params.length}`,
        params
      );
      res.json({
        data: result.rows.map((row) => ({
          ...row,
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        })),
      });
    } catch (error) {
      console.error('[api/v1] GET /document-history error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list document history');
    }
  }
);
