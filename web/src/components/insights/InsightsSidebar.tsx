import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  useInsightsCountQuery,
  type InsightListState,
} from '@/hooks/useInsightsQuery';

const STATE_FILTERS: ReadonlyArray<{ value: InsightListState; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

function isValidState(s: string | null): s is InsightListState {
  return s === 'open' || s === 'resolved' || s === 'all';
}

export function readStateFromParams(params: URLSearchParams): InsightListState {
  const raw = params.get('state');
  return isValidState(raw) ? raw : 'open';
}

export function InsightsSidebar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeState = readStateFromParams(searchParams);

  // Single count query — driven by the active state filter — backs the
  // "N open" / "N resolved" / "N total" summary line. Kind is hardcoded to
  // project_drift today (the only detector); shown as a static chip.
  const countQuery = useInsightsCountQuery({ state: activeState });

  const setState = (next: InsightListState) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'open') {
      // Default — clear the URL param to keep the URL clean.
      params.delete('state');
    } else {
      params.set('state', next);
    }
    // Clear selection when filter changes — the previously-selected insight
    // may not be in the new list.
    params.delete('selected');
    setSearchParams(params, { replace: true });
  };

  const summary = (() => {
    const n = countQuery.data ?? 0;
    if (activeState === 'open') return `${n} open`;
    if (activeState === 'resolved') return `${n} resolved`;
    return `${n} total`;
  })();

  return (
    <div className="space-y-3 px-3 py-2" data-testid="insights-sidebar">
      {/* State filter chips */}
      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-muted mb-1.5">
          State
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by state">
          {STATE_FILTERS.map((f) => {
            const active = activeState === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setState(f.value)}
                aria-pressed={active}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  active
                    ? 'bg-accent/20 text-accent-text'
                    : 'bg-border/30 text-muted hover:bg-border/50 hover:text-foreground'
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Kind filter — project_drift is the only kind in v1 */}
      <div>
        <div className="text-xs font-medium uppercase tracking-wider text-muted mb-1.5">
          Kind
        </div>
        <div className="flex flex-wrap gap-1">
          <span
            className="rounded-full bg-border/30 px-2 py-0.5 text-xs font-medium text-muted"
            aria-label="Kind: Project drift (only kind)"
          >
            Project drift
          </span>
        </div>
      </div>

      {/* Count summary */}
      <div className="border-t border-border pt-2 text-xs text-muted" aria-live="polite">
        {countQuery.isLoading ? '…' : summary}
      </div>
    </div>
  );
}
