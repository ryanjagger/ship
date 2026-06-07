/**
 * Fleet service-user lookup — the real `users` row behind system-authored
 * Fleet runs (the scheduled drift sweep, where no user session exists).
 *
 * Seeded by migration 062 (`fleet@ship.system`, NULL password_hash, no
 * workspace memberships). This replaces the old zero-UUID sentinel: minted
 * access tokens FK `users`, so the sweep needs a real row to mint against.
 */

import { pool } from '../../db/client.js';

export const FLEET_SERVICE_USER_EMAIL = 'fleet@ship.system' as const;

let cachedId: string | null = null;

/**
 * Resolve (and memoize) the Fleet service user's id. Throws if the row is
 * missing — that means migration 062 (or the e2e fixture mirror) didn't run,
 * which should fail loudly rather than mint tokens for a phantom user.
 */
export async function getFleetServiceUserId(): Promise<string> {
  if (cachedId) return cachedId;
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [FLEET_SERVICE_USER_EMAIL]
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(
      `Fleet service user ${FLEET_SERVICE_USER_EMAIL} not found — run migration 062`
    );
  }
  cachedId = id;
  return cachedId;
}

/** Test-only: clear the memoized id (fixtures recreate the user per database). */
export function resetFleetServiceUserCache(): void {
  cachedId = null;
}
