import type { Request, Response, NextFunction } from 'express';
import { pool } from '../../../../db/client.js';
import { sendApiError } from '../errors.js';

/**
 * Workspace-admin gate for the developer-platform admin surface
 * (`/api/v1/apps`, `/api/v1/connections`, `/api/v1/audit`). Must run AFTER
 * `bearerAuth` (which populates `req.platform`).
 *
 * Scopes alone must NOT grant admin powers: `apps:manage` on a token says what
 * the CLIENT may do, not what the USER may do. A member-role user holding such
 * a token still gets 403, and a demoted admin's live token stops working
 * immediately — the role is re-checked on every request, mirroring how
 * `validateAccessToken` re-checks membership.
 */
export async function requireWorkspaceAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const platform = req.platform;
  if (!platform) {
    // Defensive: a route mis-wired without bearerAuth ahead of this gate.
    sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
    return;
  }

  try {
    const result = await pool.query<{ role: string | null; is_super_admin: boolean }>(
      `SELECT m.role, u.is_super_admin
         FROM users u
         LEFT JOIN workspace_memberships m
           ON m.workspace_id = $1 AND m.user_id = u.id
        WHERE u.id = $2`,
      [platform.workspaceId, platform.userId]
    );
    const row = result.rows[0];
    if (!row || (!row.is_super_admin && row.role !== 'admin')) {
      sendApiError(res, req, 'forbidden', 'This action requires a workspace admin.', {
        details: { reason: 'workspace_admin_required' },
      });
      return;
    }
    next();
  } catch (error) {
    console.error('[api/v1] workspace admin check error:', error);
    sendApiError(res, req, 'server_error', 'Authorization check failed');
  }
}
