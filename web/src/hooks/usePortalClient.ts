import { useCallback } from 'react';
import type { ShipClient } from '@ryanjagger/ship-sdk';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { withPortalClient } from '@/lib/portal-client';

/**
 * SDK access for the Developer Portal, bound to the current workspace. The
 * returned `withClient` mints/caches a short-lived public-API token behind the
 * scenes (see lib/portal-client.ts); switching workspaces invalidates the
 * cache because the key changes.
 *
 *   const withClient = usePortalClient();
 *   const apps = await withClient((c) => c.apps.list());
 */
export function usePortalClient() {
  const { currentWorkspace } = useWorkspace();
  const workspaceKey = currentWorkspace?.id ?? 'session';
  return useCallback(
    <T,>(fn: (client: ShipClient) => Promise<T>): Promise<T> => withPortalClient(workspaceKey, fn),
    [workspaceKey]
  );
}
