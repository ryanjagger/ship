import { useQuery, useMutation } from '@tanstack/react-query';
import type { FleetDedupCandidate, FleetDedupReview } from '@ship/shared';
import { apiGet, apiPost } from '@/lib/api';

/** Stage-1 candidate (pg_trgm), re-exported for component convenience. */
export type SimilarIssue = FleetDedupCandidate;

async function fetchSimilarIssues(title: string, excludeId?: string): Promise<SimilarIssue[]> {
  const params = new URLSearchParams({ title });
  if (excludeId) params.set('exclude', excludeId);
  const res = await apiGet(`/api/issues/similar?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch similar issues');
  const data = (await res.json()) as { candidates: SimilarIssue[] };
  return data.candidates;
}

/**
 * STAGE 1 — cheap pg_trgm title similarity (typeahead). Caller debounces `title`.
 * Disabled under 4 chars (the backend returns empty below that anyway).
 */
export function useSimilarIssues(title: string, excludeId?: string, enabled = true) {
  const trimmed = title.trim();
  return useQuery({
    queryKey: ['issues', 'similar', trimmed, excludeId ?? null],
    queryFn: () => fetchSimilarIssues(trimmed, excludeId),
    enabled: enabled && trimmed.length >= 4,
    staleTime: 1000 * 30,
  });
}

async function postDedupReview(title: string, excludeId: string): Promise<FleetDedupReview> {
  const res = await apiPost('/api/fleetgraph/dedup-review', { title, excludeId });
  if (!res.ok) throw new Error('Dedup review failed');
  return (await res.json()) as FleetDedupReview;
}

/**
 * STAGE 2 — on-demand, graph-backed duplicate verdict (FleetGraph `dedup` mode).
 * A mutation (not a query) because it's an explicit, rate-limited LLM call the
 * user triggers by clicking "Ask Fleet", not something that runs per keystroke.
 */
export function useDedupReview() {
  return useMutation<FleetDedupReview, Error, { title: string; excludeId: string }>({
    mutationFn: ({ title, excludeId }) => postDedupReview(title, excludeId),
  });
}
