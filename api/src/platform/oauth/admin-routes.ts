import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, superAdminMiddleware, assertUserAuthed } from '../../middleware/auth.js';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { createOAuthApp, listOAuthApps, rotateClientSecret, deleteOAuthApp, findOAuthAppById } from './apps.js';
import { scopeRegistry } from '../api/v1/scopes/registry.js';
// Audit lives in services/ (not routes/), so importing it from the platform layer
// does not trip the no-cross-import ESLint boundary.
import { logAuditEvent } from '../../services/audit.js';

const SECRET_WARNING = 'Save this client_secret now. It will not be shown again.';
const PUBLIC_CLIENT_WARNING = 'Public PKCE clients do not use a client_secret.';
const SYSTEM_CLIENT_PROTECTED =
  'This is a platform-managed system client and cannot be modified or deleted.';
const PUBLIC_CLIENT_NO_SECRET = 'Public PKCE clients do not have a client secret to rotate.';

/**
 * Admin-only OAuth app registration API (PRD §5.2). This remains for direct
 * internal automation and protocol tests; the UI now lives in the Developer
 * Portal's super-admin all-apps lens. It sits behind Ship's session auth + CSRF
 * + super-admin guard and uses the internal `{ success, data }` envelope, NOT
 * the public ApiError contract.
 */
const router: RouterType = Router();

const createAppSchema = z
  .object({
    name: z.string().min(1).max(120),
    // Optional here, but required-unless-device-flow via the refine below: a
    // confidential Auth Code + PKCE client needs a redirect leg; a device-flow
    // client (RFC 8628) has none, so an empty list is legitimate for it.
    redirect_uris: z.array(z.string().url()).default([]),
    requested_scopes: z.array(z.string()).default([]),
    // Preserve the legacy API contract for automation that omits client_type.
    // The UI explicitly sends "public" when using the browser PKCE default.
    client_type: z.enum(['public', 'confidential']).default('confidential'),
    // Opt this client into the Device Authorization Grant. Defaults OFF — device
    // flow has no client_secret check, so it must be explicitly enabled.
    allow_device_flow: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.allow_device_flow && data.redirect_uris.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['redirect_uris'],
        message: 'At least one redirect URI is required unless allow_device_flow is enabled',
      });
    }
  });

const appIdSchema = z.string().uuid();

// POST /api/admin/oauth-apps — register a client; returns the raw secret once.
router.post('/', authMiddleware, superAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;

  const parsed = createAppSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid request', details: parsed.error.flatten() },
    });
    return;
  }

  const { unknown } = scopeRegistry.partition(parsed.data.requested_scopes);
  if (unknown.length > 0) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: `Unknown scope(s): ${unknown.join(', ')}`,
        details: { known_scopes: scopeRegistry.list().map((s) => s.scope) },
      },
    });
    return;
  }

  try {
    const { app, clientSecret } = await createOAuthApp({
      name: parsed.data.name,
      redirectUris: parsed.data.redirect_uris,
      ownerUserId: req.userId,
      requestedScopes: parsed.data.requested_scopes,
      clientType: parsed.data.client_type,
      allowDeviceFlow: parsed.data.allow_device_flow,
    });

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_app.created',
      resourceType: 'oauth_app',
      resourceId: app.id,
      details: { name: app.name, client_id: app.client_id, scopes: app.requested_scopes },
      req,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        id: app.id,
        client_id: app.client_id,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        name: app.name,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        client_type: app.client_type,
        allow_device_flow: app.allow_device_flow,
        warning: clientSecret ? SECRET_WARNING : PUBLIC_CLIENT_WARNING,
      },
    });
  } catch (error) {
    console.error('Create OAuth app error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to register OAuth app' },
    });
  }
});

// GET /api/admin/oauth-apps — list every registered client (never the secret).
router.get('/', authMiddleware, superAdminMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const apps = await listOAuthApps();
    res.json({ success: true, data: apps });
  } catch (error) {
    console.error('List OAuth apps error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to list OAuth apps' },
    });
  }
});

// GET /api/admin/oauth-apps/scopes — the scope registry, so the create form's
// checkboxes stay in sync with what registration validates against.
router.get('/scopes', authMiddleware, superAdminMiddleware, (_req: Request, res: Response): void => {
  res.json({ success: true, data: scopeRegistry.list() });
});

// POST /api/admin/oauth-apps/:id/rotate-secret — mint a new secret, shown once.
router.post('/:id/rotate-secret', authMiddleware, superAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;

  const idParse = appIdSchema.safeParse(req.params.id);
  if (!idParse.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid app id' },
    });
    return;
  }

  try {
    const existing = await findOAuthAppById(idParse.data);
    if (!existing) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
      });
      return;
    }
    if (existing.is_system) {
      res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: { code: ERROR_CODES.FORBIDDEN, message: SYSTEM_CLIENT_PROTECTED },
      });
      return;
    }
    if (existing.client_type === 'public') {
      res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: { code: ERROR_CODES.FORBIDDEN, message: PUBLIC_CLIENT_NO_SECRET },
      });
      return;
    }

    const rotated = await rotateClientSecret(idParse.data);
    if (!rotated) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
      });
      return;
    }

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_app.secret_rotated',
      resourceType: 'oauth_app',
      resourceId: rotated.app.id,
      details: { name: rotated.app.name, client_id: rotated.app.client_id },
      req,
    });

    res.json({
      success: true,
      data: {
        id: rotated.app.id,
        client_id: rotated.app.client_id,
        ...(rotated.clientSecret ? { client_secret: rotated.clientSecret } : {}),
        name: rotated.app.name,
        client_type: rotated.app.client_type,
        warning: SECRET_WARNING,
      },
    });
  } catch (error) {
    console.error('Rotate OAuth app secret error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to rotate client secret' },
    });
  }
});

// DELETE /api/admin/oauth-apps/:id — hard delete; cascades to issued tokens
// (instant revocation, per the access_tokens ON DELETE CASCADE).
router.delete('/:id', authMiddleware, superAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;

  const idParse = appIdSchema.safeParse(req.params.id);
  if (!idParse.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid app id' },
    });
    return;
  }

  try {
    const existing = await findOAuthAppById(idParse.data);
    if (!existing) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
      });
      return;
    }
    if (existing.is_system) {
      res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: { code: ERROR_CODES.FORBIDDEN, message: SYSTEM_CLIENT_PROTECTED },
      });
      return;
    }

    const deleted = await deleteOAuthApp(idParse.data);
    if (!deleted) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'OAuth app not found' },
      });
      return;
    }

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_app.deleted',
      resourceType: 'oauth_app',
      resourceId: deleted.id,
      details: { name: deleted.name },
      req,
    });

    res.json({ success: true, data: { message: 'OAuth app deleted' } });
  } catch (error) {
    console.error('Delete OAuth app error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to delete OAuth app' },
    });
  }
});

export default router;
