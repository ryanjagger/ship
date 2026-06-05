import type { PoolClient } from 'pg';
import type { ShipWebhookEvent } from './events.js';

/**
 * Event bus (PRD §Event Bus).
 *
 * `publish` is the transactional-outbox write: it persists each event AND fans
 * out a `webhook_deliveries` row per matching active subscription, all on the
 * SAME transaction client as the document write. So events and the document
 * change commit atomically — none is lost on a crash, none emitted for a
 * rolled-back write. It returns the created event ids.
 *
 * `dispatchSoon` is a fire-and-forget, never-throwing latency optimization the
 * caller invokes AFTER commit; the durable cron tick is the source of truth, so
 * dispatchSoon failing only delays delivery to the next tick. The in-process
 * implementation ships now; a queue-backed one is a drop-in replacement later.
 */
/**
 * Visibility of the document the events describe, so fan-out can mirror the read
 * path: a `private` document is delivered only to subscriptions owned by its
 * creator; a `workspace` document goes to all matching subscriptions.
 */
export interface PublishScope {
  visibility: string;
  ownerId: string | null;
}

export interface IEventBus {
  publish(client: PoolClient, events: ShipWebhookEvent[], scope: PublishScope): Promise<string[]>;
  dispatchSoon(eventIds: string[]): void;
}

/** Set by the delivery scheduler to wire real post-commit delivery. */
type DispatchHook = (eventIds: string[]) => void;
let dispatchHook: DispatchHook | null = null;

/** Enable (or, with null, disable) immediate post-commit delivery triggering. */
export function registerDispatchHook(hook: DispatchHook | null): void {
  dispatchHook = hook;
}

class InProcessEventBus implements IEventBus {
  async publish(client: PoolClient, events: ShipWebhookEvent[], scope: PublishScope): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) {
      await client.query(
        `INSERT INTO webhook_events (id, workspace_id, actor_user_id, type, api_version, payload, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          event.id,
          event.workspace_id,
          event.actor_user_id,
          event.type,
          event.api_version,
          JSON.stringify(event),
          event.idempotency_key,
        ]
      );
      // Fan out one delivery per active matching subscription, but mirror the
      // read path's visibility rule: a private document is only delivered to
      // subscriptions owned by its creator. (A NULL-owner subscription therefore
      // never receives private-document events — see migration 055.)
      await client.query(
        `INSERT INTO webhook_deliveries (subscription_id, event_id, status, next_attempt_at)
         SELECT id, $1, 'pending', now()
         FROM webhook_subscriptions
         WHERE workspace_id = $2 AND active = true AND events @> ARRAY[$3]::text[]
           AND ($4 = 'workspace' OR ($5::uuid IS NOT NULL AND created_by = $5::uuid))`,
        [event.id, event.workspace_id, event.type, scope.visibility, scope.ownerId]
      );
      ids.push(event.id);
    }
    return ids;
  }

  dispatchSoon(eventIds: string[]): void {
    if (eventIds.length === 0 || !dispatchHook) return;
    try {
      dispatchHook(eventIds);
    } catch {
      // Never let a dispatch error escape into the request path — the tick will
      // pick up any pending delivery regardless.
    }
  }
}

export const eventBus: IEventBus = new InProcessEventBus();
