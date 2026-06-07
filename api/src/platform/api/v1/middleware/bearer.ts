import type { Request, Response, NextFunction } from 'express';
import { validateAccessToken } from '../../../oauth/tokens.js';
import { sendApiError } from '../errors.js';
import { applyRateLimit } from '../rate-limit/middleware.js';
import { beginAudit } from '../audit/middleware.js';

/**
 * Bearer-token authentication for the Platform API (PRD §5.4). Validates an
 * opaque access token and attaches `{ app, user, workspace, grantedScopes }` to
 * the request. Apply per-route (composed with `requireScope`/`authOnly`) rather
 * than router-wide, so that unmatched paths still fall through to the 404
 * handler instead of returning 401.
 *
 * Distinguishes the three 401 cases via `details.reason`:
 *   - missing_token  — no/empty Authorization: Bearer header
 *   - invalid_token  — token not found or revoked
 *   - token_expired  — token found but past its expiry (the "distinct code")
 */
export interface PlatformAuth {
  appId: string;
  /** OAuth app client_id, denormalized for the audit trail. */
  clientId: string;
  userId: string;
  workspaceId: string;
  grantedScopes: string[];
  tokenId: string;
  /** True for platform-managed system clients — drives the workspace-keyed
   *  rate-limit bucket (see rate-limit/service.ts). */
  isSystemApp: boolean;
  /** The scope actually matched by requireScope/requireAnyScope (for audit). */
  matchedScope?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platform?: PlatformAuth;
    }
  }
}

export async function bearerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    sendApiError(res, req, 'unauthorized', 'Missing bearer token', { details: { reason: 'missing_token' } });
    return;
  }

  try {
    const result = await validateAccessToken(token);
    if (!result.ok) {
      if (result.reason === 'expired') {
        sendApiError(res, req, 'unauthorized', 'Access token has expired', { details: { reason: 'token_expired' } });
      } else if (result.reason === 'no_membership') {
        // Token is valid but the user lost access to its workspace — 403, not
        // 401 (mirrors the session auth path's "workspace access revoked").
        sendApiError(res, req, 'forbidden', 'Access to this workspace has been revoked', {
          details: { reason: 'workspace_access_revoked' },
        });
      } else {
        sendApiError(res, req, 'unauthorized', 'Invalid access token', { details: { reason: 'invalid_token' } });
      }
      return;
    }

    req.platform = {
      appId: result.token.appId,
      clientId: result.token.clientId,
      userId: result.token.userId,
      workspaceId: result.token.workspaceId,
      grantedScopes: result.token.scopes,
      tokenId: result.token.tokenId,
      isSystemApp: result.token.isSystemApp,
    };

    // Record the request to the public audit trail on res.finish (PRD §7). Hooked
    // here, after token validation, so it covers every token-validated outcome —
    // success, 403 scope denials, validation errors, and 429s alike.
    beginAudit(req, res);

    // Enforce per-app + per-token rate limits now that app_id/token_id are
    // known (PRD §6). On a 429 the limiter has already sent the response.
    if (!(await applyRateLimit(req, res))) return;

    next();
  } catch (error) {
    console.error('[api/v1] bearer auth error:', error);
    sendApiError(res, req, 'server_error', 'Authentication failed');
  }
}
