import { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { z } from 'zod';
import { bearerAuth } from '../middleware/bearer.js';
import { requireScope } from '../middleware/require-scope.js';
import { sendApiError } from '../errors.js';
import { ListDeliveriesQuerySchema } from '../schemas/webhook.js';
import { listDeliveries, getDelivery, listAttempts, createReplay } from '../../../webhooks/deliveries.js';
import { eventBus } from '../../../webhooks/event-bus.js';

/**
 * Webhook delivery log + manual replay (PRD §Delivery Log And Replay).
 *
 * Read-only delivery/attempt history plus a replay action, all gated by
 * `webhooks:manage` and scoped to the caller's app+workspace. Replay re-sends
 * the original event (same id + idempotency_key) as a new linked delivery.
 */
export function createWebhookDeliveriesRouter(): RouterType {
  const router: RouterType = Router();

  router.get('/', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const parsed = ListDeliveriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendApiError(res, req, 'validation_failed', 'Invalid query parameters', { details: parsed.error.flatten() });
      return;
    }
    try {
      const deliveries = await listDeliveries({
        workspaceId: platform.workspaceId,
        appId: platform.appId,
        subscriptionId: parsed.data.subscription_id,
        eventType: parsed.data.event_type,
        status: parsed.data.status,
        limit: parsed.data.limit,
      });
      res.json({ data: deliveries });
    } catch (error) {
      console.error('[api/v1] GET /webhook-deliveries error:', error);
      sendApiError(res, req, 'server_error', 'Failed to list webhook deliveries');
    }
  });

  router.get('/:id', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Webhook delivery not found');
      return;
    }
    try {
      const delivery = await getDelivery(id.data, platform.appId, platform.workspaceId);
      if (!delivery) {
        sendApiError(res, req, 'not_found', 'Webhook delivery not found');
        return;
      }
      const attempts = await listAttempts(delivery.id);
      res.json({ ...delivery, attempts });
    } catch (error) {
      console.error('[api/v1] GET /webhook-deliveries/:id error:', error);
      sendApiError(res, req, 'server_error', 'Failed to load webhook delivery');
    }
  });

  router.post('/:id/replay', bearerAuth, requireScope('webhooks:manage'), async (req: Request, res: Response): Promise<void> => {
    const platform = req.platform!;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      sendApiError(res, req, 'not_found', 'Webhook delivery not found');
      return;
    }
    try {
      const replay = await createReplay(id.data, platform.appId, platform.workspaceId);
      if (!replay) {
        sendApiError(res, req, 'not_found', 'Webhook delivery not found');
        return;
      }
      // Trigger immediate delivery; the cron tick is the durable backstop.
      eventBus.dispatchSoon([replay.eventId]);
      res.status(202).json({ delivery_id: replay.deliveryId, replay_of_delivery_id: id.data });
    } catch (error) {
      console.error('[api/v1] POST /webhook-deliveries/:id/replay error:', error);
      sendApiError(res, req, 'server_error', 'Failed to replay webhook delivery');
    }
  });

  return router;
}

export const webhookDeliveriesRouter = createWebhookDeliveriesRouter();
