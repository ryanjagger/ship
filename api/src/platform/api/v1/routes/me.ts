import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../middleware/bearer.js';
import { authOnly } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';

/**
 * GET /api/v1/me — auth-only (valid token, no scope; PRD §5.5a). Returns a flat
 * public user + current workspace, NOT the internal success/data envelope. Built
 * as a thin handler (does not proxy /api/auth/me) so the SDK's typed surface is
 * consistent with every other /api/v1 response.
 */
export const meRouter: RouterType = Router();

interface MeRow {
  id: string;
  name: string;
  email: string | null;
  workspace_id: string;
  workspace_name: string;
  role: string | null;
}

meRouter.get('/', bearerAuth, authOnly(), async (req: Request, res: Response): Promise<void> => {
  const platform = req.platform;
  if (!platform) {
    sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
    return;
  }

  try {
    const result = await pool.query<MeRow>(
      `SELECT u.id, u.name, u.email,
              w.id   AS workspace_id,
              w.name AS workspace_name,
              wm.role
         FROM users u
         JOIN workspaces w ON w.id = $2
         LEFT JOIN workspace_memberships wm ON wm.workspace_id = w.id AND wm.user_id = u.id
        WHERE u.id = $1`,
      [platform.userId, platform.workspaceId]
    );

    const row = result.rows[0];
    if (!row) {
      sendApiError(res, req, 'not_found', 'User or workspace not found');
      return;
    }

    res.json({
      id: row.id,
      name: row.name,
      ...(row.email ? { email: row.email } : {}),
      workspace: {
        id: row.workspace_id,
        name: row.workspace_name,
        role: row.role ?? 'member',
      },
    });
  } catch (error) {
    console.error('[api/v1] GET /me error:', error);
    sendApiError(res, req, 'server_error', 'Failed to load current user');
  }
});
