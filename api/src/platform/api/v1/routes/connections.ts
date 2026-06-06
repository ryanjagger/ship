import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { z } from 'zod';
import { bearerAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { requireWorkspaceAdmin } from '../middleware/workspace-admin.js';
import { sendApiError } from '../errors.js';
import { listWorkspaceConnections, revokeWorkspaceConnection } from '../../../oauth/connections.js';
import { logAuditEvent } from '../../../../services/audit.js';

/**
 * Connected apps (`connections:manage`): which (app, user) pairs hold live
 * access tokens in the token's workspace, and the kill switch for them. Note a
 * portal admin's own portal tokens appear here too — revoking them is just a
 * self-logout of the portal session; the next mint recovers.
 */

const guards = [bearerAuth, requireScope('connections:manage'), requireWorkspaceAdmin];

export function createConnectionsRouter(): RouterType {
  const router: RouterType = Router();

  router.get('/', ...guards, async (req: Request, res: Response): Promise<void> => {
    try {
      const connections = await listWorkspaceConnections(req.platform!.workspaceId);
      res.json({ data: connections });
    } catch (error) {
      console.error('[api/v1] GET /connections error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list connections');
    }
  });

  router.delete('/:appId/users/:userId', ...guards, async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const appId = z.string().uuid().safeParse(req.params.appId);
    const userId = z.string().uuid().safeParse(req.params.userId);
    if (!appId.success || !userId.success) {
      sendApiError(res, req, 'not_found', 'No active connection found to revoke');
      return;
    }
    try {
      const revoked = await revokeWorkspaceConnection(platform.workspaceId, appId.data, userId.data);
      if (revoked.revoked_count === 0) {
        sendApiError(res, req, 'not_found', 'No active connection found to revoke');
        return;
      }
      await logAuditEvent({
        workspaceId: platform.workspaceId,
        actorUserId: platform.userId,
        action: 'oauth_connection.revoked',
        resourceType: 'oauth_app',
        resourceId: appId.data,
        details: {
          client_id: revoked.client_id,
          app_name: revoked.app_name,
          revoked_user_id: userId.data,
          tokens_revoked: revoked.revoked_count,
          via: 'public_api',
        },
        req,
      });
      res.json({ tokens_revoked: revoked.revoked_count });
    } catch (error) {
      console.error('[api/v1] DELETE /connections/:appId/users/:userId error:', error);
      sendApiError(res, req, 'server_error', 'Failed to revoke connection');
    }
  });

  return router;
}

export const connectionsRouter = createConnectionsRouter();
