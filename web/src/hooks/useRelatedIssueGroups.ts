import { useQuery } from '@tanstack/react-query';
import type { FleetIssueGroupingResult } from '@ship/shared';
import { apiGet } from '@/lib/api';

async function fetchRelatedGroups(): Promise<FleetIssueGroupingResult> {
  const res = await apiGet('/api/fleetgraph/related-groups');
  if (!res.ok) throw new Error('Failed to group related issues');
  return (await res.json()) as FleetIssueGroupingResult;
}

export const relatedIssueGroupsKey = ['fleetgraph', 'related-groups'] as const;

/**
 * The Issues page "Related" view: theme-group the workspace's open issues via the
 * FleetGraph `related` mode.
 *
 * A query (not a mutation) so it runs AUTOMATICALLY when the view opens, and is
 * cached — a generous `staleTime` (matching the server-side cache TTL) means
 * toggling away and back does not re-run the expensive whole-workspace LLM call.
 * `enabled` should gate on the Related view being active AND Fleet being
 * available, so it never fires otherwise. No retry: a failed grouping is an
 * expensive call, and the view degrades to a flat list rather than hammering it.
 */
export function useRelatedIssueGroups(enabled: boolean) {
  return useQuery({
    queryKey: relatedIssueGroupsKey,
    queryFn: fetchRelatedGroups,
    enabled,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    retry: false,
  });
}
