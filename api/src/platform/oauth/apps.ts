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
    `INSERT INTO oauth_apps (client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, client_id, name, redirect_uris, owner_user_id, requested_scopes, created_at, updated_at`,
    [clientId, secretHash, input.name, input.redirectUris, input.ownerUserId, input.requestedScopes]
  );

  const app = result.rows[0];
  if (!app) throw new Error('oauth_apps INSERT did not return a row');
  return { app, clientSecret };
}

export async function findOAuthAppByClientId(clientId: string): Promise<OAuthAppRow | null> {
  const result = await pool.query<OAuthAppRow>(
    `SELECT id, client_id, client_secret_hash, name, redirect_uris, owner_user_id, requested_scopes, created_at, updated_at
     FROM oauth_apps WHERE client_id = $1`,
    [clientId]
  );
  return result.rows[0] ?? null;
}

export async function verifyClientSecret(app: OAuthAppRow, secret: string): Promise<boolean> {
  return bcrypt.compare(secret, app.client_secret_hash);
}

/** A registered redirect_uri must match exactly (no prefix/substring matching). */
export function isRegisteredRedirectUri(app: Pick<OAuthApp, 'redirect_uris'>, redirectUri: string): boolean {
  return app.redirect_uris.includes(redirectUri);
}
