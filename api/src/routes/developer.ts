import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware, workspaceAdminMiddleware, assertAuthed, assertUserAuthed } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.js';
import {
  createOAuthApp,
  rotateClientSecret,
  deleteOAuthApp,
  listOAuthApps,
  listOAuthAppsForWorkspace,
  findOAuthAppById,
  findOAuthAppForWorkspace,
} from '../platform/oauth/apps.js';
import { listWorkspaceConnections, revokeWorkspaceConnection } from '../platform/oauth/connections.js';
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
import { isKnownEventType, requiredReadScopes } from '../platform/webhooks/registry.js';
import { webhookTargetError } from '../platform/webhooks/target-url.js';
import { queryPublicApiAudit } from '../platform/api/v1/audit/service.js';

/**
 * Developer portal (PRD §8). Session-authenticated + CSRF (mounted with
 * conditionalCsrf in app.ts). Most routes are workspace-admin guarded and scoped
 * to the current workspace; the Apps tab also supports a super-admin `scope=all`
 * lens that replaces the old admin-dashboard OAuth Apps UI. These routes wrap
 * the same OAuth/webhook/audit services the public API uses; the
 * platform→internal import boundary is one-way (internal may call platform
 * services, not vice versa), so importing them here is allowed.
 */
const router: RouterType = Router();

const SECRET_WARNING = 'Save this secret now. It will not be shown again.';
const PUBLIC_CLIENT_WARNING = 'Public PKCE clients do not use a client_secret.';
const SYSTEM_CLIENT_PROTECTED = 'This is a platform-managed system client and cannot be modified or deleted.';
const PUBLIC_CLIENT_NO_SECRET = 'Public PKCE clients do not have a client secret to rotate.';

const ok = (res: Response, data: unknown, status: number = HTTP_STATUS.OK): void => {
  res.status(status).json({ success: true, data });
};
const fail = (res: Response, status: number, code: string, message: string, details?: unknown): void => {
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
};

const uuid = z.string().uuid();
type AppManagementScope = 'workspace' | 'all';

function parseAppManagementScope(raw: unknown): AppManagementScope | null {
  if (raw === undefined) return 'workspace';
  if (raw === 'workspace' || raw === 'all') return raw;
  return null;
}

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

/**
 * Resolve + authorize an app for the developer portal's Apps tab. The default
 * scope is workspace-local; super admins can opt into `scope=all` to manage any
 * non-system app from the same portal.
 */
async function loadAppForManagement(req: Request, res: Response, rawId: unknown) {
  const id = uuid.safeParse(rawId);
  if (!id.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app id');
    return null;
  }

  const scope = parseAppManagementScope(req.query.scope);
  if (!scope) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app scope');
    return null;
  }

  if (scope === 'all') {
    if (!req.isSuperAdmin) {
      fail(res, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN, 'Super-admin access required for all apps');
      return null;
    }
    const app = await findOAuthAppById(id.data);
    if (!app) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'OAuth app not found');
      return null;
    }
    return app;
  }

  if (!assertAuthed(req, res)) return null;
  return loadAppForWorkspace(res, id.data, req.workspaceId);
}

// Every route is session-authed + workspace-admin.
router.use(authMiddleware, workspaceAdminMiddleware);

// ── Apps ─────────────────────────────────────────────────────────────────────

router.get('/scopes', (_req: Request, res: Response): void => {
  ok(res, scopeRegistry.list());
});

router.get('/apps', async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;
  const scope = parseAppManagementScope(req.query.scope);
  if (!scope) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app scope');
    return;
  }
  try {
    if (scope === 'all') {
      if (!req.isSuperAdmin) {
        fail(res, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN, 'Super-admin access required for all apps');
        return;
      }
      ok(res, await listOAuthApps());
      return;
    }

    if (!assertAuthed(req, res)) return;
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
    // Preserve the legacy API contract for automation that omits client_type.
    // The UI explicitly sends "public" when using the browser PKCE default.
    client_type: z.enum(['public', 'confidential']).default('confidential'),
    allow_device_flow: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.allow_device_flow && data.redirect_uris.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['redirect_uris'], message: 'At least one redirect URI is required unless allow_device_flow is enabled' });
    }
  });

router.post('/apps', async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;
  const scope = parseAppManagementScope(req.query.scope);
  if (!scope) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app scope');
    return;
  }
  if (scope === 'all') {
    if (!req.isSuperAdmin) {
      fail(res, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN, 'Super-admin access required for all apps');
      return;
    }
  } else if (!assertAuthed(req, res)) {
    return;
  }

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
      clientType: parsed.data.client_type,
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
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        name: app.name,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        client_type: app.client_type,
        allow_device_flow: app.allow_device_flow,
        warning: clientSecret ? SECRET_WARNING : PUBLIC_CLIENT_WARNING,
      },
      HTTP_STATUS.CREATED
    );
  } catch (error) {
    console.error('[developer] create app error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to register app');
  }
});

router.post('/apps/:appId/rotate-secret', async (req: Request, res: Response): Promise<void> => {
  if (!assertUserAuthed(req, res)) return;
  const app = await loadAppForManagement(req, res, req.params.appId);
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
      details: { name: rotated.app.name, client_id: rotated.app.client_id, via: 'developer_portal' },
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
  const app = await loadAppForManagement(req, res, req.params.appId);
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

// ── Connected apps (live access tokens) ──────────────────────────────────────

/**
 * Apps with live tokens in this workspace — the device/auth-code flows leave no
 * standing grant, so a "connection" is just one or more unexpired, unrevoked
 * access tokens (see platform/oauth/connections.ts). This is the answer to
 * "which apps did I authorize, and what can they read?"
 */
router.get('/connections', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  try {
    ok(res, await listWorkspaceConnections(req.workspaceId));
  } catch (error) {
    console.error('[developer] list connections error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to list connections');
  }
});

router.delete('/connections/:appId/users/:userId', async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return;
  const appId = uuid.safeParse(req.params.appId);
  const userId = uuid.safeParse(req.params.userId);
  if (!appId.success || !userId.success) {
    fail(res, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Invalid app or user id');
    return;
  }
  try {
    const revoked = await revokeWorkspaceConnection(req.workspaceId, appId.data, userId.data);
    if (revoked.revoked_count === 0) {
      fail(res, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'No active connection found to revoke');
      return;
    }
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId,
      action: 'oauth_connection.revoked',
      resourceType: 'oauth_app',
      resourceId: appId.data,
      details: {
        client_id: revoked.client_id,
        app_name: revoked.app_name,
        revoked_user_id: userId.data,
        tokens_revoked: revoked.revoked_count,
        via: 'developer_portal',
      },
      req,
    });
    ok(res, { message: 'Connection revoked', tokens_revoked: revoked.revoked_count });
  } catch (error) {
    console.error('[developer] revoke connection error:', error);
    fail(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, 'Failed to revoke connection');
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

/**
 * Validate URL + event types for a subscription. Mirrors the read-scope gate on
 * the public `/api/v1/webhooks` path (PRD §Scope Requirements): an app may only
 * subscribe to an event family it holds a read scope for. Here the app — not a
 * bearer token — is the subscriber, so we gate on the app's `requested_scopes`.
 * Without this, fan-out (`eventBus.publish` matches only workspace/active/events)
 * would deliver e.g. `issue.*` payloads to an app lacking `issues:read`.
 */
function validateSubscription(url: string | undefined, events: string[] | undefined, appScopes: string[]): string | null {
  if (url !== undefined) {
    const urlError = webhookTargetError(url);
    if (urlError) return `Invalid webhook url: ${urlError}`;
  }
  if (events !== undefined) {
    const unknownEvents = events.filter((e) => !isKnownEventType(e));
    if (unknownEvents.length > 0) return `Unknown event type(s): ${unknownEvents.join(', ')}`;
    const granted = new Set(appScopes);
    for (const event of events) {
      const accepted = requiredReadScopes(event);
      if (accepted.length > 0 && !accepted.some((scope) => granted.has(scope))) {
        return `Subscribing to "${event}" requires the app to hold one of: ${accepted.join(', ')}.`;
      }
    }
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
  const invalid = validateSubscription(parsed.data.url, parsed.data.events, app.requested_scopes);
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
  const invalid = validateSubscription(parsed.data.url, parsed.data.events, app.requested_scopes);
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
