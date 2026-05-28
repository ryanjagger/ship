import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import type { FleetInsight, InsightKind } from '@ship/shared';

// ── Types ──────────────────────────────────────────────────────────────

export type InsightListState = 'open' | 'resolved' | 'all';

export interface InsightListFilters {
  state?: InsightListState;
  kind?: InsightKind;
  limit?: number;
  offset?: number;
}

export interface InsightCountFilters {
  state?: InsightListState;
  kind?: InsightKind;
}

export interface ResolveInsightInput {
  id: string;
  reason?: string;
}

export interface ResolveInsightResult {
  priorState: string | null;
  didResolve: boolean;
}

// ── Query keys ─────────────────────────────────────────────────────────
// Hierarchical layout mirrors `projectKeys` so partial invalidation
// (e.g. `invalidateQueries({ queryKey: insightKeys.lists() })`) sweeps
// every filtered variant under it.

export const insightKeys = {
  all: ['insights'] as const,
  lists: () => [...insightKeys.all, 'list'] as const,
  list: (filters?: InsightListFilters) =>
    [...insightKeys.lists(), filters ?? {}] as const,
  counts: () => [...insightKeys.all, 'count'] as const,
  count: (filters?: InsightCountFilters) =>
    [...insightKeys.counts(), filters ?? {}] as const,
  details: () => [...insightKeys.all, 'detail'] as const,
  detail: (id: string) => [...insightKeys.details(), id] as const,
};

// ── HTTP helpers ───────────────────────────────────────────────────────

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.append(k, String(v));
  }
  const q = search.toString();
  return q ? `?${q}` : '';
}

async function fetchInsights(filters: InsightListFilters): Promise<FleetInsight[]> {
  const qs = buildQueryString({
    state: filters.state,
    kind: filters.kind,
    limit: filters.limit,
    offset: filters.offset,
  });
  const res = await apiGet(`/api/insights${qs}`);
  if (!res.ok) {
    const error = new Error('Failed to fetch insights') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  const body = (await res.json()) as { items: FleetInsight[] };
  return body.items;
}

async function fetchInsightCount(filters: InsightCountFilters): Promise<number> {
  const qs = buildQueryString({
    state: filters.state,
    kind: filters.kind,
  });
  const res = await apiGet(`/api/insights/count${qs}`);
  if (!res.ok) {
    const error = new Error('Failed to fetch insight count') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  const body = (await res.json()) as { count: number };
  return body.count;
}

async function fetchInsight(id: string): Promise<FleetInsight> {
  const res = await apiGet(`/api/insights/${id}`);
  if (!res.ok) {
    const error = new Error('Failed to fetch insight') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as FleetInsight;
}

async function resolveInsightApi(input: ResolveInsightInput): Promise<ResolveInsightResult> {
  const body = input.reason !== undefined ? { reason: input.reason } : {};
  const res = await apiPost(`/api/insights/${input.id}/resolve`, body);
  if (!res.ok) {
    const error = new Error('Failed to resolve insight') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as ResolveInsightResult;
}

// ── Hooks ──────────────────────────────────────────────────────────────

/**
 * List insights for the current workspace, scoped against subject visibility
 * on the server. Server returns items in a fixed order (ACT severity first,
 * then `last_seen_at` DESC); callers should NOT re-sort.
 */
export function useInsightsQuery(filters: InsightListFilters = {}) {
  return useQuery({
    queryKey: insightKeys.list(filters),
    queryFn: () => fetchInsights(filters),
    staleTime: 1000 * 60, // 1 minute — sweep cadence is hourly
  });
}

/**
 * Lightweight count for badges. Same visibility scope as `useInsightsQuery`.
 */
export function useInsightsCountQuery(filters: InsightCountFilters = {}) {
  return useQuery({
    queryKey: insightKeys.count(filters),
    queryFn: () => fetchInsightCount(filters),
    staleTime: 1000 * 60,
  });
}

export function useInsightQuery(id: string | undefined) {
  return useQuery({
    queryKey: insightKeys.detail(id ?? ''),
    queryFn: () => fetchInsight(id as string),
    enabled: !!id,
    staleTime: 1000 * 60,
  });
}

/**
 * Optimistic resolve. Flips state→'resolved' (and stamps `resolved_at`,
 * `resolved_reason`) on the matching item in EVERY cached list query under
 * `insightKeys.lists()`, plus the single-detail cache entry. Rolls back on
 * error. Invalidates lists + counts on settle so server truth wins.
 */
export function useResolveInsightMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    ResolveInsightResult,
    Error,
    ResolveInsightInput,
    {
      previousLists: Array<[readonly unknown[], FleetInsight[] | undefined]>;
      previousDetail: FleetInsight | undefined;
    }
  >({
    mutationFn: resolveInsightApi,
    onMutate: async ({ id, reason }) => {
      // Cancel anything in flight so it can't clobber our optimistic patch.
      await queryClient.cancelQueries({ queryKey: insightKeys.lists() });
      await queryClient.cancelQueries({ queryKey: insightKeys.detail(id) });

      // Snapshot every list cache entry — they are filter-keyed, so there
      // may be several (e.g. one for state=open, another for state=all).
      const previousLists = queryClient.getQueriesData<FleetInsight[]>({
        queryKey: insightKeys.lists(),
      });
      const previousDetail = queryClient.getQueryData<FleetInsight>(insightKeys.detail(id));

      const nowIso = new Date().toISOString();
      const patch = (item: FleetInsight): FleetInsight => ({
        ...item,
        insight: {
          ...item.insight,
          state: 'resolved',
          resolved_at: nowIso,
          resolved_reason: reason ?? null,
        },
      });

      // Patch every list cache entry's matching item.
      for (const [key, items] of previousLists) {
        if (!items) continue;
        queryClient.setQueryData<FleetInsight[]>(
          key as readonly unknown[],
          items.map((it) => (it.id === id ? patch(it) : it))
        );
      }

      // Patch the detail entry if present.
      if (previousDetail) {
        queryClient.setQueryData<FleetInsight>(insightKeys.detail(id), patch(previousDetail));
      }

      return { previousLists, previousDetail };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      for (const [key, items] of context.previousLists) {
        queryClient.setQueryData(key as readonly unknown[], items);
      }
      if (context.previousDetail) {
        queryClient.setQueryData(
          insightKeys.detail(context.previousDetail.id),
          context.previousDetail
        );
      }
    },
    onSettled: (_data, _err, { id }) => {
      // Match ALL list variants AND ALL count variants — different filter
      // combinations have different cache keys.
      queryClient.invalidateQueries({ queryKey: insightKeys.lists() });
      queryClient.invalidateQueries({ queryKey: insightKeys.counts() });
      queryClient.invalidateQueries({ queryKey: insightKeys.detail(id) });
    },
  });
}
