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
  workspaceKey: string;
}

let cached: CachedToken | null = null;

async function mintToken(workspaceKey: string): Promise<CachedToken> {
  const res = await api.developer.mintToken();
  if (!res.success || !res.data) {
    throw new Error(res.error?.message ?? 'Failed to authorize the developer portal');
  }
  cached = {
    token: res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
    workspaceKey,
  };
  return cached;
}

/** Drop the cached token (e.g. on logout); the next call re-mints. */
export function clearPortalToken(): void {
  cached = null;
}

/**
 * Run `fn` with an authenticated ShipClient for the given workspace. Mints a
 * token when none is cached, the workspace changed, or expiry is near; retries
 * exactly once with a fresh token when the SDK reports an auth error (expired
 * or revoked token). Non-auth SDK errors propagate to the caller.
 */
export async function withPortalClient<T>(
  workspaceKey: string,
  fn: (client: ShipClient) => Promise<T>
): Promise<T> {
  const fresh =
    cached && cached.workspaceKey === workspaceKey && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS
      ? cached
      : await mintToken(workspaceKey);
  try {
    return await fn(new ShipClient({ token: fresh.token, baseUrl: apiBaseUrl }));
  } catch (err) {
    const sdkErr = toShipSDKError(err);
    // Re-mint only on a 401 (expired/revoked token). A 403 is a real
    // authorization answer (missing scope, not a workspace admin) — a fresh
    // token would not change it.
    if (!(sdkErr.kind === 'auth' && sdkErr.status === 401)) throw err;
    const reminted = await mintToken(workspaceKey);
    return fn(new ShipClient({ token: reminted.token, baseUrl: apiBaseUrl }));
  }
}

/** Map any thrown SDK (or mint) error to a user-facing message for toasts/ErrorState. */
export function sdkErrorMessage(err: unknown, fallback: string): string {
  return toShipSDKError(err).message || fallback;
}
