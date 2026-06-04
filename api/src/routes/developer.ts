import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware, workspaceAdminMiddleware, assertAuthed } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.js';
import {
  createOAuthApp,
  rotateClientSecret,
  deleteOAuthApp,
  listOAuthAppsForWorkspace,
  findOAuthAppForWorkspace,
} from '../platform/oauth/apps.js';
import { scopeRegistry } from '../platform/api/v1/scopes/registry.js';
import {
  createSubscription,
  listSubscriptions,
  getSubscription,
  updateSubscription,
  deleteSubscription,
  rotateSubscriptionSecret,
} from '../platform/webhooks/subscriptions.js';
import {
  listDeliveries,
  getDelivery,
  listAttempts,
  createReplay,
  type DeliveryStatus,
} from '../platform/webhooks/deliveries.js';
import { isKnownEventType } from '../platform/webhooks/registry.js';
import { webhookTargetError } from '../platform/webhooks/target-url.js';
import { queryPublicApiAudit } from '../platform/api/v1/audit/service.js';

/**
 * Workspace-scoped developer portal (PRD §8). Session-authenticated + CSRF
 * (mounted with conditionalCsrf in app.ts) + workspace-admin guarded — NOT the
 * public bearer/ApiError surface. Any workspace admin manages every OAuth app
 * owned by a member of their workspace (the v1 model). These routes wrap the
 * same OAuth/webhook/audit services the public API uses; the platform→internal
 * import boundary is one-way (internal may call platform services, not vice
 * versa), so importing them here is allowed.
 */
const router: RouterType = Router();

const SECRET_WARNING = 'Save this secret now. It will not be shown again.';
const SYSTEM_CLIENT_PROTECTED = 'This is a platform-managed system client and cannot be modified or deleted.';

const ok = (res: Response, data: unknown, status: number = HTTP_STATUS.OK): void => {
  res.status(status).json({ success: true, data });
};
const fail = (res: Response, status: number, code: string, message: string, details?: unknown): void => {
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
};

const uuid = z.string().uuid();

/** Resolve + authorize an app for the caller's workspace, or send a 404/400 and return null. */
async function loadAppForWorkspace(res: Response, rawId: unknown, workspaceId: string) {
  const id = uuid.safeParse(rawId);
  if (!id.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app id');
    return null;
  }
  const app = await findOAuthAppForWorkspace(id.data, workspaceId);
  if (!app) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'OAuth app not found in this workspace');
    return null;
  }
  return app;
}

// Every route is session-authed + workspace-admin.
router.use(authMiddleware, workspaceAdminMiddleware);

// ── Apps ─────────────────────────────────────────────────────────────────────

router.get('/scopes', (_req: Request, res: Response): void => {
  ok(res, scopeRegistry.list());
});

router.get('/apps', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  try {
    ok(res, await listOAuthAppsForWorkspace(req.workspaceId));
  } catch (error) {
    console.error('[developer] list apps error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to list apps');
  }
});

const createAppSchema = z
  .object({
    name: z.string().min(1).max(120),
    redirect_uris: z.array(z.string().url()).default([]),
    requested_scopes: z.array(z.string()).default([]),
    allow_device_flow: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.allow_device_flow && data.redirect_uris.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['redirect_uris'], message: 'At least one redirect URI is required unless allow_device_flow is enabled' });
    }
  });

router.post('/apps', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const parsed = createAppSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid request', parsed.error.flatten());
    return;
  }
  const { unknown } = scopeRegistry.partition(parsed.data.requested_scopes);
  if (unknown.length > 0) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, `Unknown scope(s): ${unknown.join(', ')}`, {
      known_scopes: scopeRegistry.list().map((s) => s.scope),
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
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_app.created',
      resourceType: 'oauth_app',
      resourceId: app.id,
      details: { name: app.name, client_id: app.client_id, scopes: app.requested_scopes, via: 'developer_portal' },
      req,
    });
    ok(
      res,
      {
        id: app.id,
        client_id: app.client_id,
        client_secret: clientSecret,
        name: app.name,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        allow_device_flow: app.allow_device_flow,
        warning: SECRET_WARNING,
      },
      HTTP_STATUS.CREATED
    );
  } catch (error) {
    console.error('[developer] create app error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to register app');
  }
});

router.post('/apps/:appId/rotate-secret', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  if (app.is_system) {
    fail(res, HTTP_STATUS.CONFLICT, ERROR_CODES.FORBIDDEN, SYSTEM_CLIENT_PROTECTED);
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
      details: { name: rotated.app.name, client_id: rotated.app.client_id, via: 'developer_portal' },
      req,
    });
    ok(res, { id: rotated.app.id, client_id: rotated.app.client_id, client_secret: rotated.clientSecret, name: rotated.app.name, warning: SECRET_WARNING });
  } catch (error) {
    console.error('[developer] rotate secret error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to rotate client secret');
  }
});

router.delete('/apps/:appId', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
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
      details: { name: deleted.name, via: 'developer_portal' },
      req,
    });
    ok(res, { message: 'OAuth app deleted' });
  } catch (error) {
    console.error('[developer] delete app error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to delete app');
  }
});

// ── Webhook subscriptions (per app) ──────────────────────────────────────────

const subscriptionInputSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  active: z.boolean().optional(),
});
const subscriptionPatchSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

/** Validate URL + known event types (delivery fan-out itself is visibility-aware). */
function validateSubscription(url: string | undefined, events: string[] | undefined): string | null {
  if (url !== undefined) {
    const urlError = webhookTargetError(url);
    if (urlError) return `Invalid webhook url: ${urlError}`;
  }
  if (events !== undefined) {
    const unknownEvents = events.filter((e) => !isKnownEventType(e));
    if (unknownEvents.length > 0) return `Unknown event type(s): ${unknownEvents.join(', ')}`;
  }
  return null;
}

router.get('/apps/:appId/webhooks', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  try {
    ok(res, await listSubscriptions(app.id, req.workspaceId));
  } catch (error) {
    console.error('[developer] list subscriptions error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to list subscriptions');
  }
});

router.post('/apps/:appId/webhooks', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const parsed = subscriptionInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid subscription', parsed.error.flatten());
    return;
  }
  const invalid = validateSubscription(parsed.data.url, parsed.data.events);
  if (invalid) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, invalid);
    return;
  }
  try {
    const { subscription, secret } = await createSubscription({
      appId: app.id,
      workspaceId: req.workspaceId,
      createdBy: req.userId,
      url: parsed.data.url,
      events: parsed.data.events,
      active: parsed.data.active,
    });
    ok(res, { ...subscription, secret, warning: SECRET_WARNING }, HTTP_STATUS.CREATED);
  } catch (error) {
    console.error('[developer] create subscription error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to create subscription');
  }
});

router.patch('/apps/:appId/webhooks/:subscriptionId', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const subId = uuid.safeParse(req.params.subscriptionId);
  if (!subId.success) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Subscription not found');
    return;
  }
  const parsed = subscriptionPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid subscription', parsed.error.flatten());
    return;
  }
  const invalid = validateSubscription(parsed.data.url, parsed.data.events);
  if (invalid) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, invalid);
    return;
  }
  try {
    const updated = await updateSubscription(subId.data, app.id, req.workspaceId, parsed.data);
    if (!updated) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Subscription not found');
      return;
    }
    ok(res, updated);
  } catch (error) {
    console.error('[developer] update subscription error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to update subscription');
  }
});

router.delete('/apps/:appId/webhooks/:subscriptionId', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const subId = uuid.safeParse(req.params.subscriptionId);
  if (!subId.success) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Subscription not found');
    return;
  }
  try {
    const deleted = await deleteSubscription(subId.data, app.id, req.workspaceId);
    if (!deleted) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Subscription not found');
      return;
    }
    ok(res, { message: 'Subscription deleted' });
  } catch (error) {
    console.error('[developer] delete subscription error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to delete subscription');
  }
});

router.post('/apps/:appId/webhooks/:subscriptionId/rotate-secret', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const subId = uuid.safeParse(req.params.subscriptionId);
  if (!subId.success) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Subscription not found');
    return;
  }
  try {
    const rotated = await rotateSubscriptionSecret(subId.data, app.id, req.workspaceId);
    if (!rotated) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Subscription not found');
      return;
    }
    ok(res, { ...rotated.subscription, secret: rotated.secret, warning: SECRET_WARNING });
  } catch (error) {
    console.error('[developer] rotate subscription secret error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to rotate signing secret');
  }
});

// ── Delivery log + replay (per app) ──────────────────────────────────────────

const DELIVERY_STATUSES: ReadonlySet<string> = new Set(['pending', 'delivered', 'failed', 'dead_lettered', 'replayed']);

router.get('/apps/:appId/deliveries', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
  const status = statusRaw && DELIVERY_STATUSES.has(statusRaw) ? (statusRaw as DeliveryStatus) : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  try {
    const deliveries = await listDeliveries({
      workspaceId: req.workspaceId,
      appId: app.id,
      subscriptionId: typeof req.query.subscription_id === 'string' ? req.query.subscription_id : undefined,
      eventType: typeof req.query.event_type === 'string' ? req.query.event_type : undefined,
      status,
      limit,
    });
    ok(res, deliveries);
  } catch (error) {
    console.error('[developer] list deliveries error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to list deliveries');
  }
});

router.get('/apps/:appId/deliveries/:deliveryId', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const id = uuid.safeParse(req.params.deliveryId);
  if (!id.success) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Delivery not found');
    return;
  }
  try {
    const delivery = await getDelivery(id.data, app.id, req.workspaceId);
    if (!delivery) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Delivery not found');
      return;
    }
    const attempts = await listAttempts(delivery.id);
    ok(res, { ...delivery, attempts });
  } catch (error) {
    console.error('[developer] get delivery error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to load delivery');
  }
});

router.post('/apps/:appId/deliveries/:deliveryId/replay', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const app = await loadAppForWorkspace(res, req.params.appId, req.workspaceId);
  if (!app) return;
  const id = uuid.safeParse(req.params.deliveryId);
  if (!id.success) {
    fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Delivery not found');
    return;
  }
  try {
    const replay = await createReplay(id.data, app.id, req.workspaceId);
    if (!replay) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Delivery not found');
      return;
    }
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'webhook_delivery.replayed',
      resourceType: 'webhook_delivery',
      resourceId: replay.deliveryId,
      details: { replay_of_delivery_id: id.data, event_id: replay.eventId, via: 'developer_portal' },
      req,
    });
    ok(res, { delivery_id: replay.deliveryId, replay_of_delivery_id: id.data }, 202);
  } catch (error) {
    console.error('[developer] replay delivery error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to replay delivery');
  }
});

// ── Public API audit ─────────────────────────────────────────────────────────

router.get('/audit', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const statusClassRaw = Number(req.query.status_class);
  const statusClass = [2, 3, 4, 5].includes(statusClassRaw) ? (statusClassRaw as 2 | 3 | 4 | 5) : undefined;
  try {
    const result = await queryPublicApiAudit({
      workspaceId: req.workspaceId,
      appId: typeof req.query.app_id === 'string' ? req.query.app_id : undefined,
      userId: typeof req.query.user_id === 'string' ? req.query.user_id : undefined,
      route: typeof req.query.route === 'string' ? req.query.route : undefined,
      statusClass,
      from: typeof req.query.from === 'string' ? new Date(req.query.from) : undefined,
      to: typeof req.query.to === 'string' ? new Date(req.query.to) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    ok(res, result);
  } catch (error) {
    console.error('[developer] audit query error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to query audit log');
  }
});

export default router;
