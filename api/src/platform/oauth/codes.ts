import crypto from 'crypto';
import { pool } from '../../db/client.js';

/**
 * Authorization codes (PRD §5.3). Raw code is SHA-256-hashed at rest. Codes are
 * short-lived (10 min) and single-use — single-use is enforced atomically at
 * exchange by `consumeAuthorizationCode`.
 */

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export interface IssueAuthorizationCodeInput {
  appId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
}

export async function issueAuthorizationCode(input: IssueAuthorizationCodeInput): Promise<string> {
  const code = `code_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);
  await pool.query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, app_id, user_id, workspace_id, redirect_uri, code_challenge, code_challenge_method, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      hashCode(code),
      input.appId,
      input.userId,
      input.workspaceId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.scopes,
      expiresAt,
    ]
  );
  return code;
}

export interface AuthorizationCodeRow {
  id: string;
  app_id: string;
  user_id: string;
  workspace_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string[];
  expires_at: string;
  consumed_at: string | null;
}

/** Look up a code for validation, WITHOUT consuming it (so a bad PKCE verifier doesn't burn the code). */
export async function findAuthorizationCode(code: string): Promise<AuthorizationCodeRow | null> {
  const result = await pool.query<AuthorizationCodeRow>(
    `SELECT id, app_id, user_id, workspace_id, redirect_uri, code_challenge, code_challenge_method, scopes, expires_at, consumed_at
     FROM oauth_authorization_codes WHERE code_hash = $1`,
    [hashCode(code)]
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically mark a code consumed. Returns the row only if it was still valid
 * (unconsumed AND unexpired) at the moment of the UPDATE — guaranteeing
 * single-use even under concurrent exchanges. Returns null otherwise.
 */
export async function consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRow | null> {
  const result = await pool.query<AuthorizationCodeRow>(
    `UPDATE oauth_authorization_codes
        SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, app_id, user_id, workspace_id, redirect_uri, code_challenge, code_challenge_method, scopes, expires_at, consumed_at`,
    [hashCode(code)]
  );
  return result.rows[0] ?? null;
}
