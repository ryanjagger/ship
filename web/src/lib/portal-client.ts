import { ShipClient, toShipSDKError } from '@ryanjagger/ship-sdk';
import { api, apiBaseUrl } from '@/lib/api';

/**
 * The Developer Portal consumes the public API (/api/v1) through the SDK like
 * any other client. This module owns the token lifecycle: a short-lived access
 * token minted from the session via POST /api/developer/token (the only
 * first-party shortcut), cached per workspace, re-minted transparently shortly
 * before expiry or after an auth failure. There is no refresh token — the
 * session cookie IS the refresh credential, and a dead session lands in the
 * normal session-expired redirect inside api.ts's request().
 */

/** Re-mint this long before the server-side expiry so in-flight calls don't race it. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
  /**
   * `${userId}:${workspaceId}` — the USER is part of the key. The bearer token
   * authorizes its minted user regardless of the current cookie session, so a
   * workspace-only key would let a token minted by an admin be reused after a
   * same-tab logout/login by a different (possibly non-admin) user, or across
   * an impersonation switch. Keying by effective user forces a re-mint — and
   * the mint endpoint authorizes the CURRENT session — whenever identity
   * changes. Logout also clears the cache outright (useAuth → clearPortalToken).
   */
  cacheKey: string;
}

let cached: CachedToken | null = null;

async function mintToken(cacheKey: string): Promise<CachedToken> {
  const res = await api.developer.mintToken();
  if (!res.success || !res.data) {
    throw new Error(res.error?.message ?? 'Failed to authorize the developer portal');
  }
  cached = {
    token: res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
    cacheKey,
  };
  return cached;
}

/** Drop the cached token (called on logout); the next call re-mints. */
export function clearPortalToken(): void {
  cached = null;
}

/**
 * Run `fn` with an authenticated ShipClient for the given user + workspace.
 * Mints a token when none is cached, the user or workspace changed, or expiry
 * is near; retries exactly once with a fresh token when the SDK reports an
 * auth error (expired or revoked token). Non-auth SDK errors propagate to the
 * caller.
 */
export async function withPortalClient<T>(
  cacheKey: string,
  fn: (client: ShipClient) => Promise<T>
): Promise<T> {
  const fresh =
    cached && cached.cacheKey === cacheKey && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS
      ? cached
      : await mintToken(cacheKey);
  try {
    return await fn(new ShipClient({ token: fresh.token, baseUrl: apiBaseUrl }));
  } catch (err) {
    const sdkErr = toShipSDKError(err);
    // Re-mint only on a 401 (expired/revoked token). A 403 is a real
    // authorization answer (missing scope, not a workspace admin) — a fresh
    // token would not change it.
    if (!(sdkErr.kind === 'auth' && sdkErr.status === 401)) throw err;
    const reminted = await mintToken(cacheKey);
    return fn(new ShipClient({ token: reminted.token, baseUrl: apiBaseUrl }));
  }
}

/** Map any thrown SDK (or mint) error to a user-facing message for toasts/ErrorState. */
export function sdkErrorMessage(err: unknown, fallback: string): string {
  return toShipSDKError(err).message || fallback;
}
