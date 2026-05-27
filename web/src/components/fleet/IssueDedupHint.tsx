import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FleetDedupMatch } from '@ship/shared';
import { cn } from '@/lib/cn';
import { useSimilarIssues, useDedupReview } from '@/hooks/useSimilarIssues';
import { useFleetGraphAvailability } from '@/hooks/useFleetGraphChat';

/** Debounce a rapidly-changing value (e.g. a title being typed). */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

interface IssueDedupHintProps {
  /** Live title text from the editor's title input. */
  title: string;
  /** The issue being edited — excluded from its own similarity results. */
  excludeId: string;
}

const CONFIDENCE_CLASS: Record<FleetDedupMatch['confidence'], string> = {
  high: 'bg-red-500/15 text-red-600',
  medium: 'bg-amber-500/15 text-amber-600',
  low: 'bg-muted/20 text-muted',
};

/**
 * Fleet dedup-on-create. Two stages:
 *
 *  1. As the title is typed, a cheap pg_trgm pass surfaces existing open issues
 *     with similar titles (instant, per-keystroke).
 *  2. On demand ("Ask Fleet"), the FleetGraph `dedup` mode reasons over those
 *     candidates and returns a verdict — which are TRUE duplicates, why, and what
 *     to do — rendered inline against the candidate list.
 *
 * Renders nothing when Fleet is unavailable, the title is too short, there are no
 * candidates, or the user dismisses it.
 */
export function IssueDedupHint({ title, excludeId }: IssueDedupHintProps) {
  const { data: fleetAvailable } = useFleetGraphAvailability();
  const debouncedTitle = useDebouncedValue(title, 350);
  const { data: candidates } = useSimilarIssues(
    debouncedTitle,
    excludeId,
    fleetAvailable === true
  );
  const dedup = useDedupReview();
  const [dismissed, setDismissed] = useState(false);
  // The title the current verdict was computed for — used to detect staleness.
  const [reviewedTitle, setReviewedTitle] = useState<string | null>(null);

  // A new query (title changed) is a fresh signal — undo a prior dismissal.
  useEffect(() => {
    setDismissed(false);
  }, [debouncedTitle]);

  // Drop a stale verdict once the title moves on from what it judged.
  useEffect(() => {
    if (reviewedTitle !== null && debouncedTitle !== reviewedTitle) {
      dedup.reset();
      setReviewedTitle(null);
    }
  }, [debouncedTitle, reviewedTitle, dedup]);

  const verdict = reviewedTitle === debouncedTitle ? dedup.data : undefined;

  // candidate id → the model's match (confidence + reason), when judged.
  const matchById = useMemo(() => {
    const m = new Map<string, FleetDedupMatch>();
    verdict?.matches.forEach((match) => m.set(match.candidate.id, match));
    return m;
  }, [verdict]);

  if (fleetAvailable !== true) return null;
  if (dismissed) return null;
  if (!candidates || candidates.length === 0) return null;

  const runReview = () => {
    setReviewedTitle(debouncedTitle);
    dedup.mutate({ title: debouncedTitle, excludeId });
  };

  return (
    <div
      role="status"
      aria-label={`Fleet found ${candidates.length} similar open ${
        candidates.length === 1 ? 'issue' : 'issues'
      }`}
      className="mb-6 ml-8 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-600">
          <span aria-hidden="true">✦</span>
          Fleet · possible duplicate{candidates.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-[11px] text-muted hover:text-foreground focus:outline-none"
          aria-label="Dismiss duplicate suggestions"
        >
          Dismiss
        </button>
      </div>

      <ul className="mt-1.5 space-y-1">
        {candidates.map((c) => {
          const match = matchById.get(c.id);
          return (
            <li key={c.id}>
              <Link
                to={`/documents/${c.id}`}
                className={cn(
                  'flex items-center gap-2 rounded px-1.5 py-1 -mx-1.5',
                  'hover:bg-amber-500/10 focus:outline-none focus:ring-1 focus:ring-amber-500/40'
                )}
              >
                <span className="shrink-0 font-mono text-xs text-muted">{c.display_id}</span>
                <span className="truncate text-foreground">{c.title}</span>
                {match ? (
                  <span
                    className={cn(
                      'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize',
                      CONFIDENCE_CLASS[match.confidence]
                    )}
                  >
                    {match.confidence} dup
                  </span>
                ) : (
                  <span className="ml-auto shrink-0 text-[11px] capitalize text-muted">
                    {c.state.replace(/_/g, ' ')}
                  </span>
                )}
              </Link>
              {match && (
                <p className="ml-[3.25rem] mt-0.5 text-[12px] text-muted">{match.reason}</p>
              )}
            </li>
          );
        })}
      </ul>

      {/* Stage 2 — the graph-backed verdict */}
      <div className="mt-2 border-t border-amber-500/15 pt-2">
        {!verdict && !dedup.isPending && (
          <button
            type="button"
            onClick={runReview}
            className="flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 focus:outline-none"
          >
            <span aria-hidden="true">✦</span>
            Ask Fleet if these are duplicates
          </button>
        )}

        {dedup.isPending && (
          <p className="text-[12px] text-muted">Fleet is checking these for duplicates…</p>
        )}

        {dedup.isError && reviewedTitle === debouncedTitle && (
          <p className="text-[12px] text-red-600">
            Fleet couldn’t check right now.{' '}
            <button type="button" onClick={runReview} className="underline focus:outline-none">
              Retry
            </button>
          </p>
        )}

        {verdict && (
          <div className="space-y-1">
            {verdict.summary && <p className="text-[12px] text-foreground">{verdict.summary}</p>}
            {verdict.recommendation && (
              <p className="text-[12px] font-medium text-amber-700">→ {verdict.recommendation}</p>
            )}
            {!verdict.ai_available && (
              <p className="text-[12px] text-muted">Fleet’s reasoning is unavailable right now.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
