import crypto from 'crypto';
import { pool } from '../../db/client.js';

/**
 * Device Authorization Grant codes (RFC 8628). The `device_code` is the bearer
 * secret the CLI polls with, so it is SHA-256-hashed at rest (same treatment as
 * authorization codes). The `user_code` is the short value the human types at
 * /device; it is stored normalized (no dash, uppercase) and displayed formatted.
 *
 * Mirrors `codes.ts`: short TTL, single-use enforced atomically at redemption.
 */

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;

// Unambiguous alphabet — excludes 0/O, 1/I/L, U — to survive being read aloud
// and re-typed. 30 symbols × 8 chars ≈ 39 bits, paired with a 10-minute TTL,
// session-gated approval, and the global rate limiter.
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const USER_CODE_LENGTH = 8;

const ROW_COLUMNS = `id, app_id, user_code, scopes, status, user_id, workspace_id, interval_seconds, last_polled_at, expires_at, consumed_at`;

function hashDeviceCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Random user-code chars with rejection sampling (no modulo bias). */
function randomUserCode(): string {
  const max = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
  const out: string[] = [];
  while (out.length < USER_CODE_LENGTH) {
    for (const b of crypto.randomBytes(USER_CODE_LENGTH * 2)) {
      if (out.length >= USER_CODE_LENGTH) break;
      if (b < max) out.push(USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]!);
    }
  }
  return out.join('');
}

/** Insert the dash for display, e.g. `WXYZ2345` → `WXYZ-2345`. */
export function formatUserCode(stored: string): string {
  return stored.length === USER_CODE_LENGTH ? `${stored.slice(0, 4)}-${stored.slice(4)}` : stored;
}

/** Normalize user input back to the stored form (uppercase, alphanumerics only). */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface IssueDeviceCodeInput {
  appId: string;
  scopes: string[];
}

export interface IssuedDeviceCode {
  /** Raw device_code — returned once to the client, then only its hash persists. */
  deviceCode: string;
  /** Formatted user_code (XXXX-XXXX) for display + verification_uri_complete. */
  userCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export async function issueDeviceCode(input: IssueDeviceCodeInput): Promise<IssuedDeviceCode> {
  const deviceCode = `device_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS);

  // Retry only on the astronomically-rare user_code collision (UNIQUE).
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = randomUserCode();
    try {
      await pool.query(
        `INSERT INTO oauth_device_codes (device_code_hash, user_code, app_id, scopes, interval_seconds, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [hashDeviceCode(deviceCode), stored, input.appId, input.scopes, DEFAULT_INTERVAL_SECONDS, expiresAt]
      );
      return {
        deviceCode,
        userCode: formatUserCode(stored),
        expiresInSeconds: DEVICE_CODE_TTL_MS / 1000,
        intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      };
    } catch (err) {
      if (attempt === 2 || !isUniqueViolation(err)) throw err;
    }
  }
  // Unreachable: the loop returns or throws.
  throw new Error('Failed to issue a unique device code');
}

export interface DeviceCodeRow {
  id: string;
  app_id: string;
  user_code: string;
  scopes: string[];
  status: 'pending' | 'approved' | 'denied';
  user_id: string | null;
  workspace_id: string | null;
  interval_seconds: number;
  last_polled_at: string | null;
  expires_at: string;
  consumed_at: string | null;
}

/** Look up a device code by the user-entered code (for the /device approval UI). */
export async function findDeviceByUserCode(userCode: string): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `SELECT ${ROW_COLUMNS} FROM oauth_device_codes WHERE user_code = $1`,
    [normalizeUserCode(userCode)]
  );
  return result.rows[0] ?? null;
}

export interface ApproveDeviceCodeInput {
  userCode: string;
  userId: string;
  workspaceId: string;
}

/**
 * Approve a pending code, binding the eventual token to the approver's user +
 * current workspace. Atomic: only flips a still-pending, unexpired row.
 */
export async function approveDeviceCode(input: ApproveDeviceCodeInput): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `UPDATE oauth_device_codes
        SET status = 'approved', user_id = $2, workspace_id = $3, approved_at = now()
      WHERE user_code = $1 AND status = 'pending' AND expires_at > now()
      RETURNING ${ROW_COLUMNS}`,
    [normalizeUserCode(input.userCode), input.userId, input.workspaceId]
  );
  return result.rows[0] ?? null;
}

export async function denyDeviceCode(userCode: string): Promise<DeviceCodeRow | null> {
  const result = await pool.query<DeviceCodeRow>(
    `UPDATE oauth_device_codes
        SET status = 'denied'
      WHERE user_code = $1 AND status = 'pending' AND expires_at > now()
      RETURNING ${ROW_COLUMNS}`,
    [normalizeUserCode(userCode)]
  );
  return result.rows[0] ?? null;
}

export interface DeviceGrant {
  appId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
}

export type DevicePollResult =
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'invalid' }
  | { state: 'approved'; grant: DeviceGrant };

/**
 * Poll a device_code at the token endpoint. Enforces the minimum interval
 * (slow_down) and redeems an approved code exactly once (RFC 8628 §3.5).
 *
 * `expectedAppId` is the app of the client presenting the code; a mismatch
 * returns `invalid` WITHOUT consuming, so a wrong client_id can't burn a code
 * that legitimately belongs to another client.
 */
export async function pollDeviceCode(deviceCode: string, expectedAppId: string): Promise<DevicePollResult> {
  const found = await pool.query<DeviceCodeRow>(
    `SELECT ${ROW_COLUMNS} FROM oauth_device_codes WHERE device_code_hash = $1`,
    [hashDeviceCode(deviceCode)]
  );
  const row = found.rows[0];
  if (!row || row.app_id !== expectedAppId) return { state: 'invalid' };
  if (new Date(row.expires_at) < new Date()) return { state: 'expired' };

  // Rate the client to its interval. Stamp last_polled_at every poll; if it came
  // back faster than the interval, bump the interval and answer slow_down.
  const lastMs = row.last_polled_at ? new Date(row.last_polled_at).getTime() : 0;
  if (lastMs > 0 && Date.now() - lastMs < row.interval_seconds * 1000) {
    await pool.query(
      `UPDATE oauth_device_codes SET last_polled_at = now(), interval_seconds = interval_seconds + $2 WHERE id = $1`,
      [row.id, SLOW_DOWN_INCREMENT_SECONDS]
    );
    return { state: 'slow_down' };
  }
  await pool.query(`UPDATE oauth_device_codes SET last_polled_at = now() WHERE id = $1`, [row.id]);

  if (row.status === 'denied') return { state: 'denied' };
  if (row.status === 'pending') return { state: 'pending' };

  // Approved: redeem atomically so a second poll can't mint a second token.
  const consumed = await pool.query<DeviceCodeRow>(
    `UPDATE oauth_device_codes SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING ${ROW_COLUMNS}`,
    [row.id]
  );
  const granted = consumed.rows[0];
  if (!granted || !granted.user_id || !granted.workspace_id) {
    // Already redeemed (or missing its binding) → the device_code is spent.
    return { state: 'invalid' };
  }
  return {
    state: 'approved',
    grant: { appId: granted.app_id, userId: granted.user_id, workspaceId: granted.workspace_id, scopes: granted.scopes },
  };
}
