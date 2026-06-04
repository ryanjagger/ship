import { buildSignatureHeader } from './signing.js';
import { decryptSecret } from './crypto.js';
import { classifyStatus, nextAttemptAt } from './retry.js';
import {
  markDelivered,
  markDeadLettered,
  recordAttempt,
  scheduleRetry,
  type ClaimedDelivery,
} from './deliveries.js';

/**
 * Outbound webhook dispatch (PRD §Signing, §Retries, §Dead-Letter Queue).
 *
 * `deliverOne` signs and POSTs a single claimed delivery, records the attempt,
 * and transitions delivery state. It NEVER runs inside a transaction (the HTTP
 * call must not hold a DB connection open). It never throws — the caller drains
 * a batch and one bad endpoint must not abort the rest.
 */

const TIMEOUT_MS = 10_000;
const BODY_EXCERPT_LIMIT = 1000;

async function readBodyExcerpt(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > BODY_EXCERPT_LIMIT ? text.slice(0, BODY_EXCERPT_LIMIT) : text;
  } catch {
    return null;
  }
}

export async function deliverOne(claimed: ClaimedDelivery): Promise<void> {
  const attemptNumber = claimed.attempt_count + 1;

  // Subscription deactivated/removed between fan-out and delivery → permanent.
  if (!claimed.active) {
    await markDeadLettered(claimed.delivery_id, attemptNumber, null, null, 'subscription inactive');
    return;
  }

  let secret: string;
  try {
    secret = decryptSecret(claimed.encrypted_secret);
  } catch {
    await markDeadLettered(claimed.delivery_id, attemptNumber, null, null, 'signing secret could not be decrypted');
    return;
  }

  // Serialize ONCE: the bytes we sign must be byte-identical to the bytes we send.
  const rawBody = JSON.stringify(claimed.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildSignatureHeader(secret, timestamp, rawBody);

  const start = Date.now();
  let responseStatus: number | null = null;
  let bodyExcerpt: string | null = null;
  let error: string | null = null;
  let classification: ReturnType<typeof classifyStatus>;

  try {
    const res = await fetch(claimed.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ship-Signature': signature,
        'Ship-Event-Id': claimed.event_id,
        'Idempotency-Key': claimed.event_id,
        'User-Agent': 'Ship-Webhooks/1.0',
      },
      body: rawBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    responseStatus = res.status;
    bodyExcerpt = await readBodyExcerpt(res);
    classification = classifyStatus(res.status);
  } catch (err) {
    // Timeout (AbortError) or network failure — retryable.
    error = err instanceof Error ? err.message : 'delivery request failed';
    classification = 'retryable';
  }

  const durationMs = Date.now() - start;
  await recordAttempt({
    deliveryId: claimed.delivery_id,
    subscriptionId: claimed.subscription_id,
    eventId: claimed.event_id,
    attemptNumber,
    responseStatus,
    responseBodyExcerpt: bodyExcerpt,
    durationMs,
    error,
  });

  if (classification === 'success') {
    await markDelivered(claimed.delivery_id, attemptNumber, responseStatus!, bodyExcerpt);
    return;
  }
  if (classification === 'permanent') {
    await markDeadLettered(claimed.delivery_id, attemptNumber, responseStatus, bodyExcerpt, error ?? `permanent failure (${responseStatus})`);
    return;
  }
  // Retryable: schedule the next attempt, or dead-letter if exhausted.
  const next = nextAttemptAt(attemptNumber);
  if (next) {
    await scheduleRetry(claimed.delivery_id, attemptNumber, next, responseStatus, bodyExcerpt, error);
  } else {
    await markDeadLettered(claimed.delivery_id, attemptNumber, responseStatus, bodyExcerpt, error ?? 'retries exhausted');
  }
}
