import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { bearerAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { requireWorkspaceAdmin } from '../middleware/workspace-admin.js';
import { sendApiError } from '../errors.js';
import { AuditQuerySchema } from '../schemas/audit.js';
import { queryPublicApiAudit } from '../audit/service.js';

/**
 * Public-API audit trail (`audit:read`): every authenticated /api/v1 request in
 * the token's workspace. Recording is unconditional (bearer middleware), so the
 * Developer Portal's own calls land here too — its UI passes
 * `exclude_client_id=client_ship_developer_portal` by default to keep the view
 * from being a feedback loop of itself.
 */

const guards = [bearerAuth, requireScope('audit:read'), requireWorkspaceAdmin];

export function createAuditRouter(): RouterType {
  const router: RouterType = Router();

  router.get('/', ...guards, async (req: Request, res: Response): Promise<void> => {
    const query = AuditQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid query parameters', { details: query.error.flatten() });
      return;
    }
    try {
      const result = await queryPublicApiAudit({
        workspaceId: req.platform!.workspaceId,
        appId: query.data.app_id,
        userId: query.data.user_id,
        route: query.data.route,
        statusClass: query.data.status_class,
        from: query.data.from,
        to: query.data.to,
        excludeClientId: query.data.exclude_client_id,
        limit: query.data.limit,
        offset: query.data.offset,
      });
      res.json(result);
    } catch (error) {
      console.error('[api/v1] GET /audit error:', error);
      sendApiError(res, req, 'server_error', 'Failed to query audit log');
    }
  });

  return router;
}

export const auditRouter = createAuditRouter();
