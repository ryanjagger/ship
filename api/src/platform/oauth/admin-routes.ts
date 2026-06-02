import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, superAdminMiddleware, assertUserAuthed } from '../../middleware/auth.js';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { createOAuthApp } from './apps.js';
import { scopeRegistry } from '../api/v1/scopes/registry.js';

/**
 * Admin-only OAuth app registration (PRD §5.2). This is internal tooling — it
 * lives behind Ship's session auth + CSRF + super-admin guard and uses the
 * internal `{ success, data }` envelope, NOT the public ApiError contract. A
 * self-service developer portal is out of scope for the gate.
 */
const router: RouterType = Router();

const createAppSchema = z.object({
  name: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().url()).min(1),
  requested_scopes: z.array(z.string()).default([]),
  // Opt this client into the Device Authorization Grant. Defaults OFF — device
  // flow has no client_secret check, so it must be explicitly enabled.
  allow_device_flow: z.boolean().default(false),
});

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
      allowDeviceFlow: parsed.data.allow_device_flow,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        id: app.id,
        client_id: app.client_id,
        client_secret: clientSecret, // shown once, never recoverable
        name: app.name,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        allow_device_flow: app.allow_device_flow,
        warning: 'Save this client_secret now. It will not be shown again.',
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

export default router;
