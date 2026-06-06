import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/client.js';

/**
 * Opaque OAuth tokens (PRD §5.3). Access and refresh tokens are SHA-256-hashed
 * at rest. Refresh tokens are issued only when the grant includes offline_access
 * and rotate on every use; reuse revokes the whole token family.
 */

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const OFFLINE_ACCESS_SCOPE = 'offline_access';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateOpaqueToken(prefix: string): { token: string; hash: string; tokenPrefix: string } {
  const token = `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
  return { token, hash: hashToken(token), tokenPrefix: token.substring(0, 16) };
}

function generateAccessToken(): { token: string; hash: string; tokenPrefix: string } {
  return generateOpaqueToken('ship_at');
}

function generateRefreshToken(): { token: string; hash: string; tokenPrefix: string } {
  return generateOpaqueToken('ship_rt');
}

interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface IssueAccessTokenInput {
  appId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
  refreshToken?: string;
  refreshTokenExpiresInSeconds?: number;
}

async function insertAccessToken(db: Queryable, input: IssueAccessTokenInput): Promise<string> {
  const { token, hash, tokenPrefix } = generateAccessToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  await db.query(
    `INSERT INTO access_tokens (token_hash, token_prefix, app_id, user_id, workspace_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hash, tokenPrefix, input.appId, input.userId, input.workspaceId, input.scopes, expiresAt]
  );
  return token;
}

async function insertRefreshToken(
  db: Queryable,
  input: IssueAccessTokenInput,
  familyId: string = crypto.randomUUID()
): Promise<{ id: string; token: string; expiresInSeconds: number }> {
  const { token, hash, tokenPrefix } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const result = await db.query<{ id: string }>(
    `INSERT INTO oauth_refresh_tokens (token_hash, token_prefix, family_id, app_id, user_id, workspace_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [hash, tokenPrefix, familyId, input.appId, input.userId, input.workspaceId, input.scopes, expiresAt]
  );
  const row = result.rows[0];
  if (!row) throw new Error('oauth_refresh_tokens INSERT did not return a row');
  return { id: row.id, token, expiresInSeconds: REFRESH_TOKEN_TTL_MS / 1000 };
}

export async function issueAccessToken(input: IssueAccessTokenInput): Promise<IssuedAccessToken> {
  const accessToken = await insertAccessToken(pool, input);
  const issued: IssuedAccessToken = { accessToken, expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000, scopes: input.scopes };

  if (input.scopes.includes(OFFLINE_ACCESS_SCOPE)) {
    const refresh = await insertRefreshToken(pool, input);
    issued.refreshToken = refresh.token;
    issued.refreshTokenExpiresInSeconds = refresh.expiresInSeconds;
  }

  return issued;
}

export interface ValidatedAccessToken {
  tokenId: string;
  appId: string;
  /** Denormalized for the audit trail (survives app deletion). */
  clientId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
}

export type AccessTokenLookup =
  | { ok: true; token: ValidatedAccessToken }
  | { ok: false; reason: 'invalid' | 'expired' | 'no_membership' };

interface AccessTokenRow {
  id: string;
  app_id: string;
  client_id: string;
  user_id: string;
  workspace_id: string;
  scopes: string[];
  expires_at: string;
  last_used_at: string | null;
  is_super_admin: boolean;
  has_membership: boolean;
}

// Throttle last_used_at writes to once per minute (same rationale as api_tokens).
const TOKEN_USE_REFRESH_THRESHOLD_MS = 60 * 1000;

/**
 * Validate a presented bearer token. Distinguishes a token that does not exist
 * (or was revoked) — `invalid` — from one that exists but has lapsed —
 * `expired` — so the Bearer middleware can surface a distinct discriminator on
 * the 401 (PRD §3 item 3, §5.4).
 *
 * Also re-checks workspace membership on every request (single LEFT JOIN, no
 * extra round-trip), mirroring the session auth path in middleware/auth.ts: a
 * token must not outlive the user's access to its workspace. Super-admins are
 * exempt (they may access without a membership row). -> `no_membership`.
 */
export async function validateAccessToken(token: string): Promise<AccessTokenLookup> {
  const result = await pool.query<AccessTokenRow>(
    `SELECT t.id, t.app_id, a.client_id, t.user_id, t.workspace_id, t.scopes, t.expires_at, t.last_used_at,
            u.is_super_admin,
            (m.user_id IS NOT NULL) AS has_membership
       FROM access_tokens t
       JOIN users u ON u.id = t.user_id
       JOIN oauth_apps a ON a.id = t.app_id
       LEFT JOIN workspace_memberships m
         ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hashToken(token)]
  );

  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'invalid' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (!row.is_super_admin && !row.has_membership) return { ok: false, reason: 'no_membership' };

  const lastUsedMs = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - lastUsedMs > TOKEN_USE_REFRESH_THRESHOLD_MS) {
    await pool.query('UPDATE access_tokens SET last_used_at = now() WHERE id = $1', [row.id]);
  }

  return {
    ok: true,
    token: {
      tokenId: row.id,
      appId: row.app_id,
      clientId: row.client_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes: row.scopes,
    },
  };
}

interface RefreshTokenRow {
  id: string;
  family_id: string;
  app_id: string;
  user_id: string;
  workspace_id: string;
  scopes: string[];
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  is_super_admin: boolean;
  has_membership: boolean;
}

export type RefreshAccessTokenLookup =
  | { ok: true; issued: IssuedAccessToken }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reused' | 'no_membership' };

async function revokeRefreshTokenFamily(client: PoolClient, familyId: string): Promise<void> {
  await client.query(
    `UPDATE oauth_refresh_tokens
       SET revoked_at = COALESCE(revoked_at, now())
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId]
  );
}

/**
 * Rotate a refresh token and mint a fresh access token. Reuse of an already-used
 * refresh token is treated as credential theft and revokes the whole family.
 */
export async function refreshAccessToken(refreshToken: string, appId: string): Promise<RefreshAccessTokenLookup> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<RefreshTokenRow>(
      `SELECT rt.id, rt.family_id, rt.app_id, rt.user_id, rt.workspace_id, rt.scopes, rt.expires_at,
              rt.used_at, rt.revoked_at,
              u.is_super_admin,
              (m.user_id IS NOT NULL) AS has_membership
         FROM oauth_refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         LEFT JOIN workspace_memberships m
           ON m.workspace_id = rt.workspace_id AND m.user_id = rt.user_id
        WHERE rt.token_hash = $1
        FOR UPDATE OF rt`,
      [hashToken(refreshToken)]
    );
    const row = result.rows[0];
    if (!row || row.app_id !== appId) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    if (row.used_at) {
      await revokeRefreshTokenFamily(client, row.family_id);
      await client.query('COMMIT');
      return { ok: false, reason: 'reused' };
    }
    if (row.revoked_at) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'revoked' };
    }
    if (new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'expired' };
    }
    if (!row.is_super_admin && !row.has_membership) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no_membership' };
    }

    const input: IssueAccessTokenInput = {
      appId: row.app_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes: row.scopes,
    };
    const newRefresh = await insertRefreshToken(client, input, row.family_id);
    await client.query(
      `UPDATE oauth_refresh_tokens
          SET used_at = now(), replaced_by_token_id = $2
        WHERE id = $1`,
      [row.id, newRefresh.id]
    );
    const accessToken = await insertAccessToken(client, input);
    await client.query('COMMIT');

    return {
      ok: true,
      issued: {
        accessToken,
        expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000,
        scopes: row.scopes,
        refreshToken: newRefresh.token,
        refreshTokenExpiresInSeconds: newRefresh.expiresInSeconds,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
