import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { z } from 'zod';
import { bearerAuth } from '../middleware/bearer.js';
import type { PlatformAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import {
  CreateWebhookSubscriptionSchema,
  UpdateWebhookSubscriptionSchema,
} from '../schemas/webhook.js';
import {
  createSubscription,
  listSubscriptions,
  getSubscription,
  updateSubscription,
  deleteSubscription,
  rotateSubscriptionSecret,
  type WebhookSubscription,
} from '../../../webhooks/subscriptions.js';
import { isKnownEventType, requiredReadScopes } from '../../../webhooks/registry.js';

/**
 * Webhook subscription management (PRD §Subscriptions API).
 *
 * Every route requires `webhooks:manage`. Subscribing to an event family ALSO
 * requires the matching read scope (PRD §Scope Requirements) — you can't receive
 * `issue.*` events without `issues:read`/`documents:read`. The raw signing secret
 * is returned only on create and rotate.
 */

/** Public subscription DTO. (Model already excludes the encrypted secret.) */
function toResponse(sub: WebhookSubscription) {
  return sub;
}

/**
 * Validate requested event types: every type must be known, and the token must
 * hold a read scope for each event's family. Returns an error message or null.
 */
function validateEvents(platform: PlatformAuth, events: string[]): { code: 'validation_failed' | 'forbidden'; message: string; details?: Record<string, unknown> } | null {
  const unknown = events.filter((e) => !isKnownEventType(e));
  if (unknown.length > 0) {
    return { code: 'validation_failed', message: `Unknown event type(s): ${unknown.join(', ')}`, details: { unknown_events: unknown } };
  }
  const granted = new Set(platform.grantedScopes);
  for (const event of events) {
    const accepted = requiredReadScopes(event);
    if (!accepted.some((scope) => granted.has(scope))) {
      return {
        code: 'forbidden',
        message: `Subscribing to "${event}" requires one of: ${accepted.join(', ')}.`,
        details: { event, required_read_scopes: accepted, granted_scopes: platform.grantedScopes },
      };
    }
  }
  return null;
}

export function createWebhooksRouter(): RouterType {
  const router: RouterType = Router();

  router.get('/', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    try {
      const subs = await listSubscriptions(platform.appId, platform.workspaceId);
      res.json({ data: subs.map(toResponse) });
    } catch (error) {
      console.error('[api/v1] GET /webhooks error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list webhook subscriptions');
    }
  });

  router.post('/', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const parsed = CreateWebhookSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid webhook subscription', { details: parsed.error.flatten() });
      return;
    }
    const eventError = validateEvents(platform, parsed.data.events);
    if (eventError) {
      sendApiError(res, req, eventError.code, eventError.message, { details: eventError.details });
      return;
    }
    try {
      const { subscription, secret } = await createSubscription({
        appId: platform.appId,
        workspaceId: platform.workspaceId,
        url: parsed.data.url,
        events: parsed.data.events,
        active: parsed.data.active,
      });
      res.status(201).json({ ...toResponse(subscription), secret });
    } catch (error) {
      console.error('[api/v1] POST /webhooks error:', error);
      sendApiError(res, req, 'server_error', 'Failed to create webhook subscription');
    }
  });

  router.get('/:id', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    try {
      const sub = await getSubscription(id.data, platform.appId, platform.workspaceId);
      if (!sub) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.json(toResponse(sub));
    } catch (error) {
      console.error('[api/v1] GET /webhooks/:id error:', error);
      sendApiError(res, req, 'server_error', 'Failed to load webhook subscription');
    }
  });

  router.patch('/:id', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    const parsed = UpdateWebhookSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid webhook subscription', { details: parsed.error.flatten() });
      return;
    }
    if (parsed.data.events) {
      const eventError = validateEvents(platform, parsed.data.events);
      if (eventError) {
        sendApiError(res, req, eventError.code, eventError.message, { details: eventError.details });
        return;
      }
    }
    try {
      const sub = await updateSubscription(id.data, platform.appId, platform.workspaceId, parsed.data);
      if (!sub) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.json(toResponse(sub));
    } catch (error) {
      console.error('[api/v1] PATCH /webhooks/:id error:', error);
      sendApiError(res, req, 'server_error', 'Failed to update webhook subscription');
    }
  });

  router.delete('/:id', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    try {
      const deleted = await deleteSubscription(id.data, platform.appId, platform.workspaceId);
      if (!deleted) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.status(204).send();
    } catch (error) {
      console.error('[api/v1] DELETE /webhooks/:id error:', error);
      sendApiError(res, req, 'server_error', 'Failed to delete webhook subscription');
    }
  });

  router.post('/:id/rotate-secret', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Webhook subscription not found');
      return;
    }
    try {
      const rotated = await rotateSubscriptionSecret(id.data, platform.appId, platform.workspaceId);
      if (!rotated) {
        sendApiError(res, req, 'not_found', 'Webhook subscription not found');
        return;
      }
      res.json({ ...toResponse(rotated.subscription), secret: rotated.secret });
    } catch (error) {
      console.error('[api/v1] POST /webhooks/:id/rotate-secret error:', error);
      sendApiError(res, req, 'server_error', 'Failed to rotate webhook secret');
    }
  });

  return router;
}

export const webhooksRouter = createWebhooksRouter();
