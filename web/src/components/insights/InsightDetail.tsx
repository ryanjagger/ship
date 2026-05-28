import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useResolveInsightMutation } from '@/hooks/useInsightsQuery';
import { formatAge } from './InsightCard';
import type { FleetInsight, DriftSignal, InsightSeverity } from '@ship/shared';

interface InsightDetailProps {
  insight: FleetInsight;
}

const KIND_LABELS: Record<string, string> = {
  project_drift: 'Project drift',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function SeverityPill({ severity }: { severity: InsightSeverity }) {
  const isAct = severity === 'act';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap border',
        isAct
          ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
          : 'bg-border/40 text-muted border-border'
      )}
    >
      {isAct ? 'Act' : 'FYI'}
    </span>
  );
}

function ResolvedPill() {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap bg-green-500/10 text-green-500 border border-green-500/20">
      Resolved
    </span>
  );
}

function extractSignals(insight: FleetInsight): DriftSignal[] {
  const ev = insight.insight.evidence;
  const raw = (ev as { signals?: unknown }).signals;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is DriftSignal =>
      typeof s === 'object' && s !== null && 'type' in s && 'reason' in s
  );
}

/**
 * Build a route to the subject document if we know how to navigate to it.
 * Today only `project` subjects have an obvious route; other subject types
 * fall through to the unified `/documents/:id` view.
 */
function subjectRoute(insight: FleetInsight): string {
  if (insight.subject_document_type === 'project') {
    return `/projects/${insight.subject_id}`;
  }
  return `/documents/${insight.subject_id}`;
}

export function InsightDetail({ insight }: InsightDetailProps) {
  const [reason, setReason] = useState('');
  const resolveMutation = useResolveInsightMutation();
  const isResolved = insight.insight.state === 'resolved';
  const signals = extractSignals(insight);
  const label = kindLabel(insight.insight.kind);

  const handleResolve = () => {
    if (resolveMutation.isPending || isResolved) return;
    const trimmed = reason.trim();
    resolveMutation.mutate({
      id: insight.id,
      reason: trimmed.length > 0 ? trimmed : undefined,
    });
  };

  return (
    <div
      className="flex flex-col gap-4 p-4 overflow-auto"
      data-testid="insight-detail"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-foreground m-0 truncate">
            {insight.title}
          </h2>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            <span>{label}</span>
            <span aria-hidden="true">·</span>
            <Link
              to={subjectRoute(insight)}
              className="text-accent-text hover:underline"
            >
              {insight.subject_title}
            </Link>
            {insight.insight.last_seen_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>last seen {formatAge(insight.insight.last_seen_at)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {isResolved ? <ResolvedPill /> : <SeverityPill severity={insight.insight.severity} />}
        </div>
      </div>

      {/* Summary */}
      {insight.insight.summary && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted m-0">
            Summary
          </h3>
          <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">
            {insight.insight.summary}
          </p>
        </section>
      )}

      {/* Recommended action */}
      {insight.insight.recommended_action && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted m-0">
            Recommended action
          </h3>
          <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">
            {insight.insight.recommended_action}
          </p>
        </section>
      )}

      {/* Signals */}
      {signals.length > 0 && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted m-0">
            Signals
          </h3>
          <ul className="mt-1 list-disc list-inside text-sm text-foreground space-y-0.5">
            {signals.map((s, i) => (
              <li key={`${s.type}-${i}`}>{s.reason}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Resolved metadata */}
      {isResolved && insight.insight.resolved_reason && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted m-0">
            Resolution note
          </h3>
          <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">
            {insight.insight.resolved_reason}
          </p>
        </section>
      )}

      {/* Resolve action */}
      {!isResolved && (
        <section className="border-t border-border pt-3 mt-1">
          <label
            htmlFor={`resolve-reason-${insight.id}`}
            className="block text-xs font-medium uppercase tracking-wider text-muted"
          >
            Resolution note (optional)
          </label>
          <textarea
            id={`resolve-reason-${insight.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Why are you resolving this?"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="mt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={handleResolve}
              disabled={resolveMutation.isPending}
              className={cn(
                'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors',
                'hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              {resolveMutation.isPending ? 'Resolving…' : 'Resolve'}
            </button>
            {resolveMutation.isError && (
              <span className="text-xs text-red-500" role="alert">
                Couldn't resolve — try again.
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
