import crypto from 'crypto';
import { pool } from '../../db/client.js';

/**
 * Opaque OAuth access tokens (PRD §5.3). SHA-256-hashed at rest, mirroring the
 * existing api_tokens implementation. Validation runs on every Platform API
 * request, so a fast digest (not bcrypt) is the correct tradeoff.
 */

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateAccessToken(): { token: string; hash: string; prefix: string } {
  const token = `ship_at_${crypto.randomBytes(32).toString('hex')}`;
  return { token, hash: hashToken(token), prefix: token.substring(0, 16) };
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
}

export async function issueAccessToken(input: IssueAccessTokenInput): Promise<IssuedAccessToken> {
  const { token, hash, prefix } = generateAccessToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  await pool.query(
    `INSERT INTO access_tokens (token_hash, token_prefix, app_id, user_id, workspace_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [hash, prefix, input.appId, input.userId, input.workspaceId, input.scopes, expiresAt]
  );
  return { accessToken: token, expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000, scopes: input.scopes };
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
 * exempt (they may access without a membership row). → `no_membership`.
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
