import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { z } from 'zod';
import { bearerAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { requireWorkspaceAdmin } from '../middleware/workspace-admin.js';
import { sendApiError } from '../errors.js';
import { CreateOAuthAppSchema } from '../schemas/app.js';
import {
  CreateWebhookSubscriptionSchema,
  UpdateWebhookSubscriptionSchema,
  ListDeliveriesQuerySchema,
} from '../schemas/webhook.js';
import { scopeRegistry } from '../scopes/registry.js';
import {
  createOAuthApp,
  rotateClientSecret,
  deleteOAuthApp,
  listOAuthAppsForWorkspace,
  findOAuthAppForWorkspace,
  type OAuthApp,
} from '../../../oauth/apps.js';
import {
  createSubscription,
  listSubscriptions,
  updateSubscription,
  deleteSubscription,
  rotateSubscriptionSecret,
} from '../../../webhooks/subscriptions.js';
import {
  listDeliveries,
  getDelivery,
  listAttempts,
  createReplay,
} from '../../../webhooks/deliveries.js';
import { validateSubscriptionForApp } from '../../../webhooks/validate.js';
import { logAuditEvent } from '../../../../services/audit.js';

/**
 * Workspace OAuth-app administration (`apps:manage`) — the public surface behind
 * the Developer Portal's Apps / Webhooks / Delivery Log tabs. Unlike the
 * self-service `/webhooks` routes (which act on the CALLING app, resolved from
 * the bearer token), these act on a TARGET app named in the path, so they carry
 * an extra runtime gate: the token's user must be a workspace admin.
 *
 * One-time secret semantics match app registration everywhere: the raw
 * `client_secret` / webhook `secret` appears only in create/rotate responses.
 */

const SECRET_WARNING = 'Save this secret now. It will not be shown again.';
const PUBLIC_CLIENT_WARNING = 'Public PKCE clients do not use a client_secret.';

const guards = [bearerAuth, requireScope('apps:manage'), requireWorkspaceAdmin];

/** Resolve the target app within the token's workspace, or send a 404 and return null. */
async function loadTargetApp(req: Request, res: Response): Promise<OAuthApp | null> {
  const id = z.string().uuid().safeParse(req.params.appId);
  if (!id.success) {
    sendApiError(res, req, 'not_found', 'OAuth app not found in this workspace');
    return null;
  }
  const app = await findOAuthAppForWorkspace(id.data, req.platform!.workspaceId);
  if (!app) {
    sendApiError(res, req, 'not_found', 'OAuth app not found in this workspace');
    return null;
  }
  return app;
}

function toAppResponse(app: OAuthApp & { owner_email?: string | null; owner_name?: string | null }) {
  return {
    id: app.id,
    client_id: app.client_id,
    name: app.name,
    redirect_uris: app.redirect_uris,
    owner_user_id: app.owner_user_id,
    requested_scopes: app.requested_scopes,
    client_type: app.client_type,
    allow_device_flow: app.allow_device_flow,
    is_system: app.is_system,
    owner_email: app.owner_email ?? null,
    owner_name: app.owner_name ?? null,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

export function createAppsRouter(): RouterType {
  const router: RouterType = Router();

  // ── Apps ──────────────────────────────────────────────────────────────────

  router.get('/', ...guards, async (req: Request, res: Response): Promise<void> => {
    try {
      const apps = await listOAuthAppsForWorkspace(req.platform!.workspaceId);
      res.json({ data: apps.map(toAppResponse) });
    } catch (error) {
      console.error('[api/v1] GET /apps error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list apps');
    }
  });

  router.post('/', ...guards, async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const parsed = CreateOAuthAppSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid app registration', { details: parsed.error.flatten() });
      return;
    }
    const { unknown } = scopeRegistry.partition(parsed.data.requested_scopes);
    if (unknown.length > 0) {
      sendApiError(res, req, 'validation_failed', `Unknown scope(s): ${unknown.join(', ')}`, {
        details: { unknown_scopes: unknown, known_scopes: scopeRegistry.list().map((s) => s.scope) },
      });
      return;
    }
    try {
      const { app, clientSecret } = await createOAuthApp({
        name: parsed.data.name,
        redirectUris: parsed.data.redirect_uris,
        ownerUserId: platform.userId,
        requestedScopes: parsed.data.requested_scopes,
        clientType: parsed.data.client_type,
        allowDeviceFlow: parsed.data.allow_device_flow,
      });
      await logAuditEvent({
        workspaceId: platform.workspaceId,
        actorUserId: platform.userId,
        action: 'oauth_app.created',
        resourceType: 'oauth_app',
        resourceId: app.id,
        details: { name: app.name, client_id: app.client_id, scopes: app.requested_scopes, via: 'public_api' },
        req,
      });
      res.status(201).json({
        id: app.id,
        client_id: app.client_id,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        name: app.name,
        redirect_uris: app.redirect_uris,
        requested_scopes: app.requested_scopes,
        client_type: app.client_type,
        allow_device_flow: app.allow_device_flow,
        warning: clientSecret ? SECRET_WARNING : PUBLIC_CLIENT_WARNING,
      });
    } catch (error) {
      console.error('[api/v1] POST /apps error:', error);
      sendApiError(res, req, 'server_error', 'Failed to register app');
    }
  });

  router.post('/:appId/rotate-secret', ...guards, async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const app = await loadTargetApp(req, res);
    if (!app) return;
    if (app.is_system) {
      sendApiError(res, req, 'forbidden', 'This is a platform-managed system client and cannot be modified or deleted.', {
        details: { reason: 'system_client' },
      });
      return;
    }
    if (app.client_type === 'public') {
      sendApiError(res, req, 'validation_failed', 'Public PKCE clients do not have a client secret to rotate.', {
        details: { reason: 'public_client_no_secret' },
      });
      return;
    }
    try {
      const rotated = await rotateClientSecret(app.id);
      if (!rotated) {
        sendApiError(res, req, 'not_found', 'OAuth app not found in this workspace');
        return;
      }
      await logAuditEvent({
        workspaceId: platform.workspaceId,
        actorUserId: platform.userId,
        action: 'oauth_app.secret_rotated',
        resourceType: 'oauth_app',
        resourceId: rotated.app.id,
        details: { name: rotated.app.name, client_id: rotated.app.client_id, via: 'public_api' },
        req,
      });
      res.json({
        id: rotated.app.id,
        client_id: rotated.app.client_id,
        ...(rotated.clientSecret ? { client_secret: rotated.clientSecret } : {}),
        name: rotated.app.name,
        redirect_uris: rotated.app.redirect_uris,
        requested_scopes: rotated.app.requested_scopes,
        client_type: rotated.app.client_type,
        allow_device_flow: rotated.app.allow_device_flow,
        warning: SECRET_WARNING,
      });
    } catch (error) {
      console.error('[api/v1] POST /apps/:appId/rotate-secret error:', error);
      sendApiError(res, req, 'server_error', 'Failed to rotate client secret');
    }
  });

  router.delete('/:appId', ...guards, async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const app = await loadTargetApp(req, res);
    if (!app) return;
    if (app.is_system) {
      sendApiError(res, req, 'forbidden', 'This is a platform-managed system client and cannot be modified or deleted.', {
        details: { reason: 'system_client' },
      });
      return;
    }
    try {
      const deleted = await deleteOAuthApp(app.id);
      if (!deleted) {
        sendApiError(res, req, 'not_found', 'OAuth app not found in this workspace');
        return;
      }
      await logAuditEvent({
        workspaceId: platform.workspaceId,
        actorUserId: platform.userId,
        action: 'oauth_app.deleted',
        resourceType: 'oauth_app',
        resourceId: deleted.id,
        details: { name: deleted.name, via: 'public_api' },
        req,
      });
      res.status(204).send();
    } catch (error) {
      console.error('[api/v1] DELETE /apps/:appId error:', error);
      sendApiError(res, req, 'server_error', 'Failed to delete app');
    }
  });

  // ── Webhook subscriptions (per target app) ────────────────────────────────
  // Event-family read scopes are gated on the TARGET app's requested_scopes —
  // never the caller's token — because the app is the subscriber (validate.ts).

  router.get('/:appId/webhooks', ...guards, async (req: Request, res: Response): Promise<void> => {
    const app = await loadTargetApp(req, res);
    if (!app) return;
    try {
      const subs = await listSubscriptions(app.id, req.platform!.workspaceId);
      res.json({ data: subs });
    } catch (error) {
      console.error('[api/v1] GET /apps/:appId/webhooks error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list webhook subscriptions');
    }
  });

  router.post('/:appId/webhooks', ...guards, async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const parsed = CreateWebhookSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid webhook subscription', { details: parsed.error.flatten() });
      return;
    }
    const invalid = validateSubscriptionForApp(parsed.data.url, parsed.data.events, app.requested_scopes);
    if (invalid) {
      sendApiError(res, req, 'validation_failed', invalid);
      return;
    }
    try {
      const { subscription, secret } = await createSubscription({
        appId: app.id,
        workspaceId: platform.workspaceId,
        createdBy: platform.userId,
        url: parsed.data.url,
        events: parsed.data.events,
        active: parsed.data.active,
      });
      res.status(201).json({ ...subscription, secret });
    } catch (error) {
      console.error('[api/v1] POST /apps/:appId/webhooks error:', error);
      sendApiError(res, req, 'server_error', 'Failed to create webhook subscription');
    }
  });

  router.patch('/:appId/webhooks/:subscriptionId', ...guards, async (req: Request, res: Response): Promise<void> => {
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const subId = z.string().uuid().safeParse(req.params.subscriptionId);
    if (!subId.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    const parsed = UpdateWebhookSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid webhook subscription', { details: parsed.error.flatten() });
      return;
    }
    const invalid = validateSubscriptionForApp(parsed.data.url, parsed.data.events, app.requested_scopes);
    if (invalid) {
      sendApiError(res, req, 'validation_failed', invalid);
      return;
    }
    try {
      const updated = await updateSubscription(subId.data, app.id, req.platform!.workspaceId, parsed.data);
      if (!updated) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.json(updated);
    } catch (error) {
      console.error('[api/v1] PATCH /apps/:appId/webhooks/:subscriptionId error:', error);
      sendApiError(res, req, 'server_error', 'Failed to update webhook subscription');
    }
  });

  router.delete('/:appId/webhooks/:subscriptionId', ...guards, async (req: Request, res: Response): Promise<void> => {
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const subId = z.string().uuid().safeParse(req.params.subscriptionId);
    if (!subId.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    try {
      const deleted = await deleteSubscription(subId.data, app.id, req.platform!.workspaceId);
      if (!deleted) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error('[api/v1] DELETE /apps/:appId/webhooks/:subscriptionId error:', error);
      sendApiError(res, req, 'server_error', 'Failed to delete webhook subscription');
    }
  });

  router.post('/:appId/webhooks/:subscriptionId/rotate-secret', ...guards, async (req: Request, res: Response): Promise<void> => {
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const subId = z.string().uuid().safeParse(req.params.subscriptionId);
    if (!subId.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    try {
      const rotated = await rotateSubscriptionSecret(subId.data, app.id, req.platform!.workspaceId);
      if (!rotated) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.json({ ...rotated.subscription, secret: rotated.secret });
    } catch (error) {
      console.error('[api/v1] POST /apps/:appId/webhooks/:subscriptionId/rotate-secret error:', error);
      sendApiError(res, req, 'server_error', 'Failed to rotate webhook secret');
    }
  });

  // ── Delivery log + replay (per target app) ────────────────────────────────

  router.get('/:appId/deliveries', ...guards, async (req: Request, res: Response): Promise<void> => {
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const query = ListDeliveriesQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid query parameters', { details: query.error.flatten() });
      return;
    }
    try {
      const deliveries = await listDeliveries({
        workspaceId: req.platform!.workspaceId,
        appId: app.id,
        subscriptionId: query.data.subscription_id,
        eventType: query.data.event_type,
        status: query.data.status,
        limit: query.data.limit,
      });
      res.json({ data: deliveries });
    } catch (error) {
      console.error('[api/v1] GET /apps/:appId/deliveries error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list deliveries');
    }
  });

  router.get('/:appId/deliveries/:deliveryId', ...guards, async (req: Request, res: Response): Promise<void> => {
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const id = z.string().uuid().safeParse(req.params.deliveryId);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Delivery not found');
      return;
    }
    try {
      const delivery = await getDelivery(id.data, app.id, req.platform!.workspaceId);
      if (!delivery) {
        sendApiError(res, req, 'not_found', 'Delivery not found');
        return;
      }
      const attempts = await listAttempts(delivery.id);
      res.json({ ...delivery, attempts });
    } catch (error) {
      console.error('[api/v1] GET /apps/:appId/deliveries/:deliveryId error:', error);
      sendApiError(res, req, 'server_error', 'Failed to load delivery');
    }
  });

  router.post('/:appId/deliveries/:deliveryId/replay', ...guards, async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const app = await loadTargetApp(req, res);
    if (!app) return;
    const id = z.string().uuid().safeParse(req.params.deliveryId);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Delivery not found');
      return;
    }
    try {
      const replay = await createReplay(id.data, app.id, platform.workspaceId);
      if (!replay) {
        sendApiError(res, req, 'not_found', 'Delivery not found');
        return;
      }
      await logAuditEvent({
        workspaceId: platform.workspaceId,
        actorUserId: platform.userId,
        action: 'webhook_delivery.replayed',
        resourceType: 'webhook_delivery',
        resourceId: replay.deliveryId,
        details: { replay_of_delivery_id: id.data, event_id: replay.eventId, via: 'public_api' },
        req,
      });
      res.status(202).json({ delivery_id: replay.deliveryId, replay_of_delivery_id: id.data });
    } catch (error) {
      console.error('[api/v1] POST /apps/:appId/deliveries/:deliveryId/replay error:', error);
      sendApiError(res, req, 'server_error', 'Failed to replay delivery');
    }
  });

  return router;
}

export const appsRouter = createAppsRouter();
