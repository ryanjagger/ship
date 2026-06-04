import type { Request, Response } from 'express';
import { recordPublicApiRequest } from './service.js';

/**
 * Begin auditing a token-validated request (PRD §7). Called from `bearerAuth`
 * once `req.platform` is set; registers a one-shot `res.finish` listener so the
 * recorded status + latency reflect the ACTUAL response (including 403/429/4xx).
 *
 * The route TEMPLATE (`/api/v1/issues/:id`) is captured rather than the raw URL
 * so audit rows don't leak ids and group cleanly in the portal.
 */
export function beginAudit(req: Request, res: Response): void {
  const startedAt = Date.now();

  res.on('finish', () => {
    const platform = req.platform;
    // Route template = mount path + matched route path (e.g. /api/v1/issues + /:id).
    const routeTemplate = `${req.baseUrl}${req.route?.path && req.route.path !== '/' ? req.route.path : ''}` || req.path;

    void recordPublicApiRequest({
      clientId: platform?.clientId ?? null,
      appId: platform?.appId ?? null,
      tokenId: platform?.tokenId ?? null,
      userId: platform?.userId ?? null,
      workspaceId: platform?.workspaceId ?? null,
      method: req.method,
      route: routeTemplate,
      scope: platform?.matchedScope ?? null,
      status: res.statusCode,
      latencyMs: Date.now() - startedAt,
      requestId: req.platformRequestId ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  });
}
