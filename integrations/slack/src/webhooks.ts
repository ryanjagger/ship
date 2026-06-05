import express, { Router } from 'express';
import type { Request, Response, Router as RouterType } from 'express';
import { verifyWebhook } from '@ryanjagger/ship-sdk';
import { dispatchShipWebhook, type DispatchDependencies } from './dispatch.js';
import type { SlackIntegrationConfig } from './config.js';
import type { ShipWebhookEnvelope, SlackIntegrationStore } from './types.js';

function rawBody(req: Request): string | null {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return null;
}

function parseEnvelope(raw: string): ShipWebhookEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ShipWebhookEnvelope>;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') return null;
    if (!parsed.data || typeof parsed.data !== 'object' || !('object' in parsed.data)) return null;
    return parsed as ShipWebhookEnvelope;
  } catch {
    return null;
  }
}

export function createShipWebhookRouter(
  config: Pick<SlackIntegrationConfig, 'shipBaseUrl' | 'shipClientId' | 'shipClientSecret'>,
  store: SlackIntegrationStore,
  overrides: Partial<DispatchDependencies> = {}
): RouterType {
  const router: RouterType = Router();

  router.post('/ship/webhooks/:connectionId', express.raw({ type: 'application/json' }), async (req: Request, res: Response): Promise<void> => {
    const connectionId = req.params.connectionId;
    if (typeof connectionId !== 'string' || connectionId.length === 0) {
      res.status(404).json({ error: 'connection_not_found' });
      return;
    }
    const connection = await store.getConnection(connectionId);
    if (!connection?.webhookSecret) {
      res.status(404).json({ error: 'connection_not_found' });
      return;
    }

    const body = rawBody(req);
    if (!body || !verifyWebhook(req.headers, body, connection.webhookSecret)) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const event = parseEnvelope(body);
    if (!event) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    try {
      const status = await dispatchShipWebhook(connection, event, { config, store, ...overrides });
      res.json({ ok: true, status });
    } catch (error) {
      console.error('[slack-integration] webhook dispatch failed:', error);
      res.status(500).json({ error: 'dispatch_failed' });
    }
  });

  return router;
}
