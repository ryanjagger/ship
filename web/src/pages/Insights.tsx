import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInsightsQuery } from '@/hooks/useInsightsQuery';
import { InsightCard } from '@/components/insights/InsightCard';
import { InsightDetail } from '@/components/insights/InsightDetail';
import { readStateFromParams } from '@/components/insights/InsightsSidebar';
import type { FleetInsight } from '@ship/shared';

export function InsightsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = readStateFromParams(searchParams);
  const selectedId = searchParams.get('selected') ?? undefined;

  const { data: items, isLoading, isError, refetch } = useInsightsQuery({ state });

  // IMPORTANT: do NOT client-sort. The server returns the canonical order
  // (ACT severity first, then last_seen_at DESC).
  const insights: FleetInsight[] = items ?? [];

  const selected = useMemo(
    () => insights.find((i) => i.id === selectedId),
    [insights, selectedId]
  );

  const handleSelect = (id: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('selected', id);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left column — list */}
      <div
        className="flex w-96 flex-col border-r border-border overflow-hidden"
        data-testid="insights-list-column"
      >
        <div className="flex h-10 items-center border-b border-border px-3">
          <h1 className="text-sm font-medium text-foreground m-0">Insights</h1>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-1.5">
          {isLoading ? (
            <div className="px-2 py-4 text-sm text-muted">Loading insights…</div>
          ) : isError ? (
            <div className="px-2 py-4 text-sm" role="alert">
              <div className="text-foreground">Couldn't load insights</div>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-1 text-accent-text hover:underline"
              >
                Retry
              </button>
            </div>
          ) : insights.length === 0 ? (
            <EmptyState state={state} />
          ) : (
            insights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                selected={insight.id === selectedId}
                onSelect={handleSelect}
              />
            ))
          )}
        </div>
      </div>

      {/* Right column — detail */}
      <div className="flex-1 overflow-hidden">
        {selected ? (
          <InsightDetail insight={selected} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted">
            <div>Select an insight to view details.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ state }: { state: string }) {
  const headline =
    state === 'resolved'
      ? 'No resolved insights yet.'
      : state === 'all'
        ? 'No insights yet.'
        : 'No open insights.';
  return (
    <div className="px-3 py-4 text-sm text-muted" data-testid="insights-empty-state">
      <div>{headline}</div>
      <div className="mt-1">
        Insights surface from the FleetGraph sweep.{' '}
        <Link to="/settings/fleetgraph" className="text-accent-text hover:underline">
          Configure FleetGraph
        </Link>{' '}
        to enable per-workspace sweeps.
      </div>
    </div>
  );
}
