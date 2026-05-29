/**
 * FleetReviewContainer — connects the shared FleetAnalysisCard to the data hook.
 *
 * Self-contained: fetches by projectId via useFleetReview, so neither
 * ProjectDetailsTab nor ProjectRetro needs to thread Fleet props through.
 */

import { FleetAnalysisCard } from '@/components/fleet/FleetAnalysisCard';
import { useFleetReview, useRefreshFleetReview, useApplyFleetRetro } from '@/hooks/useFleetReview';

interface FleetReviewContainerProps {
  projectId: string;
  variant: 'details' | 'retro';
  /**
   * Called after the user applies the Fleet-recommended outcome. ProjectRetro
   * passes its retro re-fetch so its plan_validated control re-syncs (it manages
   * that state outside react-query).
   */
  onApplied?: () => void;
}

export function FleetReviewContainer({ projectId, variant, onApplied }: FleetReviewContainerProps) {
  const { data, isLoading, isError } = useFleetReview(projectId);
  const refresh = useRefreshFleetReview(projectId);
  const apply = useApplyFleetRetro(projectId);

  return (
    <FleetAnalysisCard
      variant={variant}
      review={data}
      isLoading={isLoading}
      isError={isError}
      isRefreshing={refresh.isPending}
      refreshError={refresh.isError}
      onRefresh={() => refresh.mutate()}
      isApplying={apply.isPending}
      applyError={apply.isError}
      onApplyOutcome={
        variant === 'retro'
          ? (planValidated) => apply.mutate(planValidated, { onSuccess: () => onApplied?.() })
          : undefined
      }
    />
  );
}
