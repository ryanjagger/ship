import { pool } from '../../db/client.js';

/**
 * Webhook delivery + attempt model (PRD §Delivery Log And Replay).
 *
 * `webhook_deliveries` holds current state per subscription/event; the cron tick
 * drains it. Claiming uses `FOR UPDATE SKIP LOCKED` in a short transaction plus a
 * lease bump (push `next_attempt_at` into the future) so the row reappears if the
 * process dies mid-delivery — never hold a transaction open across the HTTP send.
 */

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_lettered' | 'replayed';

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  status: DeliveryStatus;
  attempt_count: number;
  last_response_status: number | null;
  last_response_body_excerpt: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  dead_lettered_at: string | null;
  replay_of_delivery_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryAttempt {
  id: string;
  delivery_id: string;
  subscription_id: string;
  event_id: string;
  attempt_number: number;
  response_status: number | null;
  response_body_excerpt: string | null;
  duration_ms: number | null;
  error: string | null;
  sent_at: string;
}

/** Everything `deliverOne` needs, gathered in one query at claim time. */
export interface ClaimedDelivery {
  delivery_id: string;
  subscription_id: string;
  event_id: string;
  attempt_count: number;
  url: string;
  encrypted_secret: string;
  active: boolean;
  /** The stored envelope, re-serialized once at send time for byte-exact signing. */
  payload: unknown;
}

const DELIVERY_SELECT = `
  d.id, d.subscription_id, d.event_id, e.type AS event_type, d.status, d.attempt_count,
  d.last_response_status, d.last_response_body_excerpt, d.last_error,
  d.next_attempt_at, d.delivered_at, d.dead_lettered_at, d.replay_of_delivery_id,
  d.created_at, d.updated_at`;

/**
 * Atomically claim up to `limit` due deliveries: select pending+due rows with
 * `FOR UPDATE SKIP LOCKED`, then lease them by pushing `next_attempt_at` 60s out
 * so a concurrent tick or instance won't re-grab them. Returns the joined data
 * needed to deliver, outside any transaction.
 */
export async function claimDueDeliveries(limit: number): Promise<ClaimedDelivery[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<{ id: string }>(
      `SELECT id FROM webhook_deliveries
       WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
       ORDER BY next_attempt_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    const ids = due.rows.map((r) => r.id);
    if (ids.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const claimed = await client.query<ClaimedDelivery>(
      `UPDATE webhook_deliveries d
       SET next_attempt_at = now() + interval '60 seconds', last_attempt_at = now(), updated_at = now()
       FROM webhook_subscriptions s, webhook_events e
       WHERE d.id = ANY($1::uuid[]) AND s.id = d.subscription_id AND e.id = d.event_id
       RETURNING d.id AS delivery_id, d.subscription_id, d.event_id, d.attempt_count,
                 s.url, s.encrypted_secret, s.active, e.payload`,
      [ids]
    );
    await client.query('COMMIT');
    return claimed.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface RecordAttemptInput {
  deliveryId: string;
  subscriptionId: string;
  eventId: string;
  attemptNumber: number;
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  durationMs: number | null;
  error: string | null;
}

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_delivery_attempts
       (delivery_id, subscription_id, event_id, attempt_number, response_status, response_body_excerpt, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.deliveryId,
      input.subscriptionId,
      input.eventId,
      input.attemptNumber,
      input.responseStatus,
      input.responseBodyExcerpt,
      input.durationMs,
      input.error,
    ]
  );
}

export async function markDelivered(
  deliveryId: string,
  attemptCount: number,
  responseStatus: number,
  bodyExcerpt: string | null
): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries
     SET status = 'delivered', attempt_count = $2, next_attempt_at = NULL, delivered_at = now(),
         last_response_status = $3, last_response_body_excerpt = $4, last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [deliveryId, attemptCount, responseStatus, bodyExcerpt]
  );
}

export async function scheduleRetry(
  deliveryId: string,
  attemptCount: number,
  nextAttemptAt: Date,
  responseStatus: number | null,
  bodyExcerpt: string | null,
  error: string | null
): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries
     SET status = 'pending', attempt_count = $2, next_attempt_at = $3,
         last_response_status = $4, last_response_body_excerpt = $5, last_error = $6, updated_at = now()
     WHERE id = $1`,
    [deliveryId, attemptCount, nextAttemptAt, responseStatus, bodyExcerpt, error]
  );
}

export async function markDeadLettered(
  deliveryId: string,
  attemptCount: number,
  responseStatus: number | null,
  bodyExcerpt: string | null,
  error: string | null
): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries
     SET status = 'dead_lettered', attempt_count = $2, next_attempt_at = NULL, dead_lettered_at = now(),
         last_response_status = $3, last_response_body_excerpt = $4, last_error = $5, updated_at = now()
     WHERE id = $1`,
    [deliveryId, attemptCount, responseStatus, bodyExcerpt, error]
  );
}

export interface ListDeliveriesFilter {
  workspaceId: string;
  appId: string;
  subscriptionId?: string;
  eventType?: string;
  status?: DeliveryStatus;
  limit: number;
}

/** List deliveries for the caller's app+workspace, newest first, with filters. */
export async function listDeliveries(filter: ListDeliveriesFilter): Promise<WebhookDelivery[]> {
  const params: unknown[] = [filter.workspaceId, filter.appId];
  const conditions = ['s.workspace_id = $1', 's.app_id = $2'];
  if (filter.subscriptionId) {
    params.push(filter.subscriptionId);
    conditions.push(`d.subscription_id = $${params.length}`);
  }
  if (filter.eventType) {
    params.push(filter.eventType);
    conditions.push(`e.type = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`d.status = $${params.length}`);
  }
  params.push(filter.limit);
  const result = await pool.query<WebhookDelivery>(
    `SELECT ${DELIVERY_SELECT}
     FROM webhook_deliveries d
     JOIN webhook_subscriptions s ON s.id = d.subscription_id
     JOIN webhook_events e ON e.id = d.event_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY d.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

/** A single delivery scoped to the caller's app+workspace. */
export async function getDelivery(id: string, appId: string, workspaceId: string): Promise<WebhookDelivery | null> {
  const result = await pool.query<WebhookDelivery>(
    `SELECT ${DELIVERY_SELECT}
     FROM webhook_deliveries d
     JOIN webhook_subscriptions s ON s.id = d.subscription_id
     JOIN webhook_events e ON e.id = d.event_id
     WHERE d.id = $1 AND s.app_id = $2 AND s.workspace_id = $3`,
    [id, appId, workspaceId]
  );
  return result.rows[0] ?? null;
}

export async function listAttempts(deliveryId: string): Promise<WebhookDeliveryAttempt[]> {
  const result = await pool.query<WebhookDeliveryAttempt>(
    `SELECT id, delivery_id, subscription_id, event_id, attempt_number, response_status,
            response_body_excerpt, duration_ms, error, sent_at
     FROM webhook_delivery_attempts
     WHERE delivery_id = $1
     ORDER BY attempt_number ASC`,
    [deliveryId]
  );
  return result.rows;
}

/**
 * Replay a delivery: stamp the source `replayed` (audit) and spawn a NEW pending
 * delivery for the same subscription+event, linked via `replay_of_delivery_id`.
 * Reusing the same `event_id` means the envelope id + idempotency_key are
 * identical; the fresh signature timestamp falls out at send time. Returns the
 * new delivery id + the reused event id, or null if the source isn't in the
 * caller's app+workspace.
 */
export async function createReplay(
  sourceDeliveryId: string,
  appId: string,
  workspaceId: string
): Promise<{ deliveryId: string; eventId: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await client.query<{ subscription_id: string; event_id: string }>(
      `SELECT d.subscription_id, d.event_id
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.id = $1 AND s.app_id = $2 AND s.workspace_id = $3
       FOR UPDATE OF d`,
      [sourceDeliveryId, appId, workspaceId]
    );
    const row = source.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(`UPDATE webhook_deliveries SET status = 'replayed', updated_at = now() WHERE id = $1`, [
      sourceDeliveryId,
    ]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (subscription_id, event_id, status, attempt_count, next_attempt_at, replay_of_delivery_id)
       VALUES ($1, $2, 'pending', 0, now(), $3)
       RETURNING id`,
      [row.subscription_id, row.event_id, sourceDeliveryId]
    );
    await client.query('COMMIT');
    return { deliveryId: inserted.rows[0]!.id, eventId: row.event_id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
