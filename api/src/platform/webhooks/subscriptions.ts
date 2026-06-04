import { pool } from '../../db/client.js';
import { generateWebhookSecret, encryptSecret, secretFingerprint } from './crypto.js';

/**
 * Webhook subscription model (PRD §Subscriptions API).
 *
 * A subscription is per OAuth app + workspace + target URL + event set. The
 * signing secret is stored AES-256-GCM-encrypted with a one-way fingerprint;
 * the raw secret is returned to the caller exactly once, on create and rotate.
 */

export interface WebhookSubscription {
  id: string;
  app_id: string;
  workspace_id: string;
  url: string;
  events: string[];
  secret_fingerprint: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Row including the encrypted secret — only loaded internally for signing. */
export interface WebhookSubscriptionWithSecret extends WebhookSubscription {
  encrypted_secret: string;
}

const PUBLIC_COLUMNS = `id, app_id, workspace_id, url, events, secret_fingerprint, active, created_at, updated_at`;

export interface CreateSubscriptionInput {
  appId: string;
  workspaceId: string;
  url: string;
  events: string[];
  active?: boolean;
}

export interface CreatedSubscription {
  subscription: WebhookSubscription;
  /** Raw signing secret — surface to the caller exactly once, then forget. */
  secret: string;
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<CreatedSubscription> {
  const secret = generateWebhookSecret();
  const result = await pool.query<WebhookSubscription>(
    `INSERT INTO webhook_subscriptions (app_id, workspace_id, url, events, encrypted_secret, secret_fingerprint, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${PUBLIC_COLUMNS}`,
    [input.appId, input.workspaceId, input.url, input.events, encryptSecret(secret), secretFingerprint(secret), input.active ?? true]
  );
  const subscription = result.rows[0];
  if (!subscription) throw new Error('webhook_subscriptions INSERT did not return a row');
  return { subscription, secret };
}

/** List a workspace's subscriptions for the owning app (newest first). */
export async function listSubscriptions(appId: string, workspaceId: string): Promise<WebhookSubscription[]> {
  const result = await pool.query<WebhookSubscription>(
    `SELECT ${PUBLIC_COLUMNS} FROM webhook_subscriptions
     WHERE app_id = $1 AND workspace_id = $2
     ORDER BY created_at DESC`,
    [appId, workspaceId]
  );
  return result.rows;
}

export async function getSubscription(id: string, appId: string, workspaceId: string): Promise<WebhookSubscription | null> {
  const result = await pool.query<WebhookSubscription>(
    `SELECT ${PUBLIC_COLUMNS} FROM webhook_subscriptions
     WHERE id = $1 AND app_id = $2 AND workspace_id = $3`,
    [id, appId, workspaceId]
  );
  return result.rows[0] ?? null;
}

/** Load the encrypted secret for signing. Internal — never returned over the API. */
export async function getSubscriptionWithSecret(id: string): Promise<WebhookSubscriptionWithSecret | null> {
  const result = await pool.query<WebhookSubscriptionWithSecret>(
    `SELECT ${PUBLIC_COLUMNS}, encrypted_secret FROM webhook_subscriptions WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export interface UpdateSubscriptionInput {
  url?: string;
  events?: string[];
  active?: boolean;
}

export async function updateSubscription(
  id: string,
  appId: string,
  workspaceId: string,
  input: UpdateSubscriptionInput
): Promise<WebhookSubscription | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let param = 1;
  if (input.url !== undefined) {
    updates.push(`url = $${param++}`);
    values.push(input.url);
  }
  if (input.events !== undefined) {
    updates.push(`events = $${param++}`);
    values.push(input.events);
  }
  if (input.active !== undefined) {
    updates.push(`active = $${param++}`);
    values.push(input.active);
  }
  if (updates.length === 0) {
    return getSubscription(id, appId, workspaceId);
  }
  updates.push(`updated_at = now()`);
  const result = await pool.query<WebhookSubscription>(
    `UPDATE webhook_subscriptions SET ${updates.join(', ')}
     WHERE id = $${param} AND app_id = $${param + 1} AND workspace_id = $${param + 2}
     RETURNING ${PUBLIC_COLUMNS}`,
    [...values, id, appId, workspaceId]
  );
  return result.rows[0] ?? null;
}

export async function deleteSubscription(id: string, appId: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM webhook_subscriptions WHERE id = $1 AND app_id = $2 AND workspace_id = $3 RETURNING id`,
    [id, appId, workspaceId]
  );
  return result.rows.length > 0;
}

/** Mint a fresh signing secret (same one-time-secret semantics as create). */
export async function rotateSubscriptionSecret(
  id: string,
  appId: string,
  workspaceId: string
): Promise<CreatedSubscription | null> {
  const secret = generateWebhookSecret();
  const result = await pool.query<WebhookSubscription>(
    `UPDATE webhook_subscriptions
     SET encrypted_secret = $1, secret_fingerprint = $2, updated_at = now()
     WHERE id = $3 AND app_id = $4 AND workspace_id = $5
     RETURNING ${PUBLIC_COLUMNS}`,
    [encryptSecret(secret), secretFingerprint(secret), id, appId, workspaceId]
  );
  const subscription = result.rows[0];
  if (!subscription) return null;
  return { subscription, secret };
}
