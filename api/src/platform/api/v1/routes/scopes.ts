import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { bearerAuth } from '../middleware/bearer.js';
import { authOnly } from '../middleware/require-scope.js';
import { scopeRegistry } from '../scopes/registry.js';

/**
 * The registered scope catalog. Auth-only (like `/me`): any valid token may
 * read it — app registration UIs need the full list to offer scope pickers,
 * and it contains nothing sensitive.
 */
export function createScopesRouter(): RouterType {
  const router: RouterType = Router();

  router.get('/', bearerAuth, authOnly(), (_req: Request, res: Response): void => {
    res.json({ data: scopeRegistry.list() });
  });

  return router;
}

export const scopesRouter = createScopesRouter();
