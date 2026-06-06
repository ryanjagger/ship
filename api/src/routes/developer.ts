import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware, workspaceAdminMiddleware, assertAuthed, assertUserAuthed } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.js';
import {
  rotateClientSecret,
  deleteOAuthApp,
  listOAuthApps,
  findOAuthAppById,
  findOAuthAppByClientId,
} from '../platform/oauth/apps.js';
import { issueAccessToken } from '../platform/oauth/tokens.js';

/**
 * Developer portal backend remnant. The portal consumes the public API
 * (`/api/v1/apps`, `/connections`, `/audit`, `/scopes`) through the SDK like
 * any other client — those routes live in `api/src/platform/api/v1/`. What
 * remains here is what cannot be expressed through a workspace-scoped public
 * token:
 *
 *  1. POST /token — the first-party session→bearer exchange that bootstraps
 *     the portal's SDK access.
 *  2. The super-admin `scope=all` lens (list/rotate/delete across ALL
 *     workspaces), which backs /admin?tab=oauth-apps. App creation is not
 *     here: a created app is owned by the caller, so the portal always
 *     creates through the SDK and it shows up in both lenses.
 *
 * Session-authenticated + CSRF (mounted with conditionalCsrf in app.ts).
 */
const router: RouterType = Router();

const SECRET_WARNING = 'Save this secret now. It will not be shown again.';
const SYSTEM_CLIENT_PROTECTED = 'This is a platform-managed system client and cannot be modified or deleted.';
const PUBLIC_CLIENT_NO_SECRET = 'Public PKCE clients do not have a client secret to rotate.';

const ok = (res: Response, data: unknown, status: number = HTTP_STATUS.OK): void => {
  res.status(status).json({ success: true, data });
};
const fail = (res: Response, status: number, code: string, message: string, details?: unknown): void => {
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
};

const uuid = z.string().uuid();

// Every route is session-authed + workspace-admin (super-admins pass outright).
router.use(authMiddleware, workspaceAdminMiddleware);

// ── First-party token exchange ───────────────────────────────────────────────

/** The system client minted for (provisioned by migration 061). */
const PORTAL_CLIENT_ID = 'client_ship_developer_portal';
const PORTAL_SCOPES = ['apps:manage', 'connections:manage', 'audit:read'];
/** Matches the 15-minute session idle timeout: a minted token can't meaningfully outlive the session. */
const PORTAL_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Mint a short-lived public-API access token for the Developer Portal SPA. The
 * portal consumes /api/v1 through the SDK like any other client; this exchange
 * (session cookie → bearer token, no consent screen) is the only first-party
 * shortcut it gets. No refresh token — the session IS the refresh credential:
 * the SPA re-POSTs here when the token expires, and a dead session 401s.
 * Admin-ness is NOT encoded in the token; the /api/v1 admin routes re-check the
 * workspace role on every request.
 */
router.post('/token', async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;
  if (!assertAuthed(req, res)) return;
  try {
    const portalApp = await findOAuthAppByClientId(PORTAL_CLIENT_ID);
    if (!portalApp || !portalApp.is_system) {
      console.error(`[developer] portal client ${PORTAL_CLIENT_ID} is not provisioned (run migrations)`);
      fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Developer Portal client is not provisioned');
      return;
    }
    const issued = await issueAccessToken(
      { appId: portalApp.id, userId: req.userId, workspaceId: req.workspaceId, scopes: PORTAL_SCOPES },
      { ttlMs: PORTAL_TOKEN_TTL_MS }
    );
    ok(res, {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresInSeconds,
      scope: PORTAL_SCOPES.join(' '),
    });
  } catch (error) {
    console.error('[developer] token mint error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to mint portal token');
  }
});

// ── Super-admin all-apps lens ────────────────────────────────────────────────
// Cross-workspace by definition (lists/manages every registered app), so it
// cannot ride a workspace-scoped public token. Requires scope=all explicitly —
// workspace-scoped management lives on /api/v1/apps.

/** Require `?scope=all` + super-admin, or send the failure and return false. */
function assertAllLens(req: Request, res: Response): boolean {
  if (req.query.scope !== 'all') {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'This route requires scope=all; workspace apps are managed via /api/v1/apps');
    return false;
  }
  if (!req.isSuperAdmin) {
    fail(res, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN, 'Super-admin access required for all apps');
    return false;
  }
  return true;
}

/** Resolve an app by id for the all lens, or send a 400/404 and return null. */
async function loadAppForAllLens(req: Request, res: Response) {
  const id = uuid.safeParse(req.params.appId);
  if (!id.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app id');
    return null;
  }
  const app = await findOAuthAppById(id.data);
  if (!app) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'OAuth app not found');
    return null;
  }
  return app;
}

router.get('/apps', async (req: Request, res: Response): Promise<void> => {
  if (!assertAllLens(req, res)) return;
  try {
    ok(res, await listOAuthApps());
  } catch (error) {
    console.error('[developer] list all apps error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to list apps');
  }
});

router.post('/apps/:appId/rotate-secret', async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;
  if (!assertAllLens(req, res)) return;
  const app = await loadAppForAllLens(req, res);
  if (!app) return;
  if (app.is_system) {
    fail(res, HTTP_STATUS.CONFLICT, ERROR_CODES.FORBIDDEN, SYSTEM_CLIENT_PROTECTED);
    return;
  }
  if (app.client_type === 'public') {
    fail(res, HTTP_STATUS.CONFLICT, ERROR_CODES.FORBIDDEN, PUBLIC_CLIENT_NO_SECRET);
    return;
  }
  try {
    const rotated = await rotateClientSecret(app.id);
    if (!rotated) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'OAuth app not found');
      return;
    }
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_app.secret_rotated',
      resourceType: 'oauth_app',
      resourceId: rotated.app.id,
      details: { name: rotated.app.name, client_id: rotated.app.client_id, via: 'developer_portal_all_lens' },
      req,
    });
    ok(res, {
      id: rotated.app.id,
      client_id: rotated.app.client_id,
      ...(rotated.clientSecret ? { client_secret: rotated.clientSecret } : {}),
      name: rotated.app.name,
      client_type: rotated.app.client_type,
      warning: SECRET_WARNING,
    });
  } catch (error) {
    console.error('[developer] rotate secret error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to rotate client secret');
  }
});

router.delete('/apps/:appId', async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;
  if (!assertAllLens(req, res)) return;
  const app = await loadAppForAllLens(req, res);
  if (!app) return;
  if (app.is_system) {
    fail(res, HTTP_STATUS.CONFLICT, ERROR_CODES.FORBIDDEN, SYSTEM_CLIENT_PROTECTED);
    return;
  }
  try {
    const deleted = await deleteOAuthApp(app.id);
    if (!deleted) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'OAuth app not found');
      return;
    }
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_app.deleted',
      resourceType: 'oauth_app',
      resourceId: deleted.id,
      details: { name: deleted.name, via: 'developer_portal_all_lens' },
      req,
    });
    ok(res, { message: 'OAuth app deleted' });
  } catch (error) {
    console.error('[developer] delete app error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to delete app');
  }
});

export default router;
