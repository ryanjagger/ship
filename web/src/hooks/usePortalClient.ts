import { useCallback } from 'react';
import type { ShipClient } from '@ryanjagger/ship-sdk';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { withPortalClient } from '@/lib/portal-client';

/**
 * SDK access for the Developer Portal, bound to the current USER + workspace.
 * The returned `withClient` mints/caches a short-lived public-API token behind
 * the scenes (see lib/portal-client.ts); switching workspaces, logging in as a
 * different user, or an impersonation change invalidates the cache because the
 * key changes — the bearer token authorizes its minted user, so it must never
 * outlive the identity it was minted for.
 *
 *   const withClient = usePortalClient();
 *   const apps = await withClient((c) => c.apps.list());
 */
export function usePortalClient() {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const cacheKey = `${user?.id ?? 'anon'}:${currentWorkspace?.id ?? 'session'}`;
  return useCallback(
    <T,>(fn: (client: ShipClient) => Promise<T>): Promise<T> => withPortalClient(cacheKey, fn),
    [cacheKey]
  );
}
