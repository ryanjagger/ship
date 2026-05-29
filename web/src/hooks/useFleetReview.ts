import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { projectKeys } from '@/hooks/useProjectsQuery';
import type { FleetReviewResponse } from '@ship/shared';

async function fetchFleetReview(projectId: string): Promise<FleetReviewResponse> {
  const res = await apiGet(`/api/projects/${projectId}/fleet/plan-review`);
  if (!res.ok) {
    const error = new Error('Failed to load Fleet review') as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** Lazy plan review + retro recommendation for a project (cached server-side). */
export function useFleetReview(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? projectKeys.fleet(projectId) : ['fleet-disabled'],
    queryFn: () => fetchFleetReview(projectId!),
    enabled: !!projectId,
    staleTime: 1000 * 60 * 5,
  });
}

/** Force a fresh AI evaluation, then refresh the cached review. */
export function useRefreshFleetReview(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<FleetReviewResponse> => {
      const res = await apiPost(`/api/projects/${projectId}/fleet/plan-review/refresh`);
      if (!res.ok) {
        const error = new Error('Failed to refresh Fleet review') as Error & { status: number };
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (projectId) queryClient.setQueryData(projectKeys.fleet(projectId), data);
    },
    onSettled: () => {
      if (!projectId) return;
      // The analysis is cached on the project document, so refresh both.
      queryClient.invalidateQueries({ queryKey: projectKeys.fleet(projectId) });
      queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/**
 * Apply the Fleet-recommended retro outcome (sets plan_validated under the
 * user's own permissions, audited as agent-initiated). This is the explicit
 * human confirmation of Fleet's advisory recommendation — Fleet only proposes.
 */
export function useApplyFleetRetro(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (planValidated: boolean): Promise<void> => {
      const res = await apiPost(`/api/projects/${projectId}/fleet/retro/apply`, {
        plan_validated: planValidated,
      });
      if (!res.ok) {
        const error = new Error('Failed to apply Fleet recommendation') as Error & { status: number };
        error.status = res.status;
        throw error;
      }
    },
    onSettled: () => {
      if (!projectId) return;
      // The outcome lives on the project document; refresh the review + detail.
      queryClient.invalidateQueries({ queryKey: projectKeys.fleet(projectId) });
      queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}
