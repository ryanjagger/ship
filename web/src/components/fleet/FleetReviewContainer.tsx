/**
 * FleetReviewContainer — connects the shared FleetAnalysisCard to the data hook.
 *
 * Self-contained: fetches by projectId via useFleetReview, so neither
 * ProjectDetailsTab nor ProjectRetro needs to thread Fleet props through.
 */

import { FleetAnalysisCard } from '@/components/fleet/FleetAnalysisCard';
import { useFleetReview, useRefreshFleetReview } from '@/hooks/useFleetReview';

interface FleetReviewContainerProps {
  projectId: string;
  variant: 'details' | 'retro';
}

export function FleetReviewContainer({ projectId, variant }: FleetReviewContainerProps) {
  const { data, isLoading, isError } = useFleetReview(projectId);
  const refresh = useRefreshFleetReview(projectId);

  return (
    <FleetAnalysisCard
      variant={variant}
      review={data}
      isLoading={isLoading}
      isError={isError}
      isRefreshing={refresh.isPending}
      refreshError={refresh.isError}
      onRefresh={() => refresh.mutate()}
    />
  );
}
