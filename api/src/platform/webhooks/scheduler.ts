/**
 * Webhook delivery scheduler (PRD §Retries, §Dead-Letter Queue).
 *
 * Mirrors api/src/scheduler/index.ts: an env-gated in-process `node-cron` task,
 * started from index.ts AFTER `server.listen` (never `createApp`), with a
 * module-level handle so vitest can stop it. The tick drains due deliveries.
 *
 * ── SUB-MINUTE BACKOFF ────────────────────────────────────────────────────
 * The retry schedule starts at 1s/4s/16s — finer than cron. So the FIRST
 * attempt is inline: after a write commits, `eventBus.dispatchSoon` triggers a
 * tick immediately. The 30-second cron is the durable backstop that also covers
 * the later 4s/16s/1m/5m/30m retries (worst-case ~30s late, fine for webhooks)
 * and any delivery a crash left pending.
 *
 * ── CLAIM CONTRACT ────────────────────────────────────────────────────────
 * `claimDueDeliveries` claims rows in a SHORT `FOR UPDATE SKIP LOCKED`
 * transaction + lease bump, then `deliverOne` runs the HTTP send OUTSIDE any
 * transaction — never hold a connection open across `fetch` (the
 * idle-in-transaction lesson from the FleetGraph scheduler).
 *
 * ── NO-THROW POLICY ───────────────────────────────────────────────────────
 * `runWebhookDeliveryTick` catches per-delivery errors so one bad endpoint
 * doesn't abort the batch, and never re-throws.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { claimDueDeliveries } from './deliveries.js';
import { deliverOne } from './dispatcher.js';
import { registerDispatchHook } from './event-bus.js';

let task: ScheduledTask | null = null;
let tickInFlight = false;
let rerunRequested = false;

/** Every 30 seconds (6-field cron — node-cron supports second granularity). */
export const WEBHOOK_TICK_SCHEDULE = '*/30 * * * * *';
const BATCH_SIZE = 50;

export function startWebhookScheduler(): void {
  if (process.env.WEBHOOKS_DELIVERY_ENABLED !== 'true') return;
  if (task) return;
  // Wire post-commit immediate delivery (sub-second first attempt).
  registerDispatchHook(() => {
    void runWebhookDeliveryTick();
  });
  task = cron.schedule(WEBHOOK_TICK_SCHEDULE, () => {
    runWebhookDeliveryTick().catch((err) => console.error('[webhooks] delivery tick failed:', err));
  });
  console.log(`[webhooks] delivery scheduler registered at ${WEBHOOK_TICK_SCHEDULE}`);
}

export function stopWebhookScheduler(): void {
  task?.stop();
  task = null;
  registerDispatchHook(null);
}

/**
 * Drain all due deliveries. Coalesces overlapping triggers within this process
 * (a trigger arriving mid-run sets `rerunRequested` so the loop sweeps again);
 * `FOR UPDATE SKIP LOCKED` guards against other instances. Never throws.
 */
export async function runWebhookDeliveryTick(): Promise<void> {
  if (tickInFlight) {
    rerunRequested = true;
    return;
  }
  tickInFlight = true;
  try {
    do {
      rerunRequested = false;
      let claimed = await claimDueDeliveries(BATCH_SIZE);
      while (claimed.length > 0) {
        for (const delivery of claimed) {
          try {
            await deliverOne(delivery);
          } catch (err) {
            console.error(`[webhooks] deliver ${delivery.delivery_id} failed:`, err);
          }
        }
        if (claimed.length < BATCH_SIZE) break;
        claimed = await claimDueDeliveries(BATCH_SIZE);
      }
    } while (rerunRequested);
  } catch (err) {
    console.error('[webhooks] delivery tick error:', err);
  } finally {
    tickInFlight = false;
  }
}
