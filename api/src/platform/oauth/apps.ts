import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../../db/client.js';

/**
 * OAuth client-application model (PRD §5.2).
 *
 * Secret hashing uses bcrypt (cost 12, via the existing `bcryptjs` dep) because
 * a client_secret is verified exactly once — at token exchange — so a slow hash
 * is acceptable. The raw secret is high-entropy random, returned once at
 * creation and never stored or recoverable.
 */

// bcrypt cost factor, matching api/src/routes/auth.ts.
const BCRYPT_ROUNDS = 12;

export interface OAuthApp {
  id: string;
  client_id: string;
  name: string;
  redirect_uris: string[];
  owner_user_id: string | null;
  requested_scopes: string[];
  /** Whether this client may use the Device Authorization Grant (RFC 8628). */
  allow_device_flow: boolean;
  /**
   * Platform-managed first-party client (e.g. the `ship` CLI). System clients are
   * provisioned by migration, shown read-only in the admin UI, and cannot be
   * deleted or rotated. Admin-created apps are always false.
   */
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

type OAuthAppRow = OAuthApp & { client_secret_hash: string };

export function generateClientId(): string {
  return `client_${crypto.randomBytes(16).toString('hex')}`;
}

export function generateClientSecret(): string {
  // High-entropy random; the stored hash is about not persisting plaintext,
  // not brute-force resistance (the secret already has ample entropy).
  return `secret_${crypto.randomBytes(32).toString('base64url')}`;
}

export interface CreateOAuthAppInput {
  name: string;
  redirectUris: string[];
  ownerUserId: string | null;
  requestedScopes: string[];
  /** Allow this client to use the Device Authorization Grant. Defaults to false. */
  allowDeviceFlow?: boolean;
}

export interface CreatedOAuthApp {
  app: OAuthApp;
  /** Raw secret — surface to the caller exactly once, then forget. */
  clientSecret: string;
}

export async function createOAuthApp(input: CreateOAuthAppInput): Promise<CreatedOAuthApp> {
  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const secretHash = await bcrypt.hash(clientSecret, BCRYPT_ROUNDS);

  const result = await pool.query<OAuthApp>(
    `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow, is_system, created_at, updated_at`,
    [clientId, secretHash, input.name, input.redirectUris, input.ownerUserId, input.requestedScopes, input.allowDeviceFlow ?? false]
  );

  const app = result.rows[0];
  if (!app) throw new Error('oauth_apps INSERT did not return a row');
  return { app, clientSecret };
}

export async function findOAuthAppByClientId(clientId: string): Promise<OAuthAppRow | null> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT id, client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow, is_system, created_at, updated_at
     FROM oauth_apps WHERE client_id = $1`,
    [clientId]
  );
  return result.rows[0] ?? null;
}

/** Look up an app by its internal id (e.g. to display the name on /device). */
export async function findOAuthAppById(id: string): Promise<OAuthApp | null> {
  const result = await pool.query<OAuthApp>(
    `SELECT id, client_id, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow, is_system, created_at, updated_at
     FROM oauth_apps WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function verifyClientSecret(app: OAuthAppRow, secret: string): Promise<boolean> {
  return bcrypt.compare(secret, app.client_secret_hash);
}

/** A registered app as shown in the admin list — never includes the secret hash. */
export interface OAuthAppListItem extends OAuthApp {
  owner_email: string | null;
  owner_name: string | null;
}

/**
 * List every registered OAuth app for the admin UI. Joins the owner for display.
 * Never selects `client_secret_hash` — the secret is unrecoverable by design.
 */
export async function listOAuthApps(): Promise<OAuthAppListItem[]> {
  const result = await pool.query<OAuthAppListItem>(
    `SELECT a.id, a.client_id, a.name, a.redirect_uris, a.owner_user_id,
            a.requested_scopes, a.allow_device_flow, a.is_system, a.created_at, a.updated_at,
            u.email AS owner_email, u.name AS owner_name
     FROM oauth_apps a
     LEFT JOIN users u ON u.id = a.owner_user_id
     ORDER BY a.created_at DESC`
  );
  return result.rows;
}

/**
 * Mint a fresh client_secret for an existing app (same one-time-secret semantics
 * as creation). The old secret stops working immediately; `client_id` is
 * unchanged. Returns null when no app has that id. Already-issued access tokens
 * are unaffected — they're validated by token hash, not the client secret.
 *
 * System (platform-managed) clients are never rotated — the `AND is_system = false`
 * guard makes this a no-op (returns null) for them, independent of the route check.
 */
export async function rotateClientSecret(id: string): Promise<CreatedOAuthApp | null> {
  const clientSecret = generateClientSecret();
  const secretHash = await bcrypt.hash(clientSecret, BCRYPT_ROUNDS);

  const result = await pool.query<OAuthApp>(
    `UPDATE oauth_apps SET client_secret_hash = $1, updated_at = now() WHERE id = $2 AND is_system = false
     RETURNING id, client_id, name, redirect_uris, owner_user_id, requested_scopes, allow_device_flow, is_system, created_at, updated_at`,
    [secretHash, id]
  );

  const app = result.rows[0];
  if (!app) return null;
  return { app, clientSecret };
}

/**
 * Hard-delete an app. `access_tokens.app_id … ON DELETE CASCADE` (migration 050)
 * removes every token issued to it — this IS the revocation. Returns the deleted
 * row's id/name (for the audit detail), or null when no app had that id.
 *
 * System (platform-managed) clients cannot be deleted — the `AND is_system = false`
 * guard makes this a no-op (returns null) for them, independent of the route check.
 */
export async function deleteOAuthApp(id: string): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ id: string; name: string }>(
    `DELETE FROM oauth_apps WHERE id = $1 AND is_system = false RETURNING id, name`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** A registered redirect_uri must match exactly (no prefix/substring matching). */
export function isRegisteredRedirectUri(app: Pick<OAuthApp, 'redirect_uris'>, redirectUri: string): boolean {
  return app.redirect_uris.includes(redirectUri);
}
