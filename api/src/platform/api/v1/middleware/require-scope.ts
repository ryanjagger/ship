import type { Request, Response, NextFunction } from 'express';
import { sendApiError } from '../errors.js';

/**
 * `require(scope)` middleware factory (PRD §5.4, §5.6). Must run AFTER
 * `bearerAuth` (which populates `req.platform`). On insufficient scope it
 * returns 403 with the missing scope NAMED in the body — never an opaque
 * "forbidden".
 */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const platform = req.platform;
    if (!platform) {
      // Defensive: a route mis-wired without bearerAuth ahead of requireScope.
      sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
      return;
    }
    if (!platform.grantedScopes.includes(scope)) {
      sendApiError(res, req, 'forbidden', `Insufficient scope: this action requires "${scope}".`, {
        details: { required_scope: scope, granted_scopes: platform.grantedScopes },
      });
      return;
    }
    next();
  };
}

/**
 * Auth-only marker (PRD §5.4): a valid token is required (enforced by
 * `bearerAuth`) but NO scope. Modeled explicitly so the §5.6 fitness test and
 * the OpenAPI generator treat "valid token, no scope" as a legitimate
 * declaration rather than a missing-scope failure. Runtime no-op.
 */
export function authOnly() {
  return (_req: Request, _res: Response, next: NextFunction): void => next();
}
