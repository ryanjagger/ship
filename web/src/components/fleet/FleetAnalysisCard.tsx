/**
 * FleetAnalysisCard — the one shared presentational surface for Fleet.
 *
 * variant="details": compact plan-testability card (Project Details).
 * variant="retro":  advisory recommendation inset (Project Retro), styled
 *                    read-only so it can never be mistaken for the human
 *                    Validated/Invalidated control (R15).
 *
 * Purely presentational — all data + state arrive via props. The container
 * (ProjectDetailsTab / ProjectRetro) supplies them from useFleetReview.
 */

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui/Tooltip';
import type { FleetReviewResponse, FleetStatus, FleetRecommendation, FleetProposedAction } from '@ship/shared';

interface FleetAnalysisCardProps {
  variant: 'details' | 'retro';
  review?: FleetReviewResponse | null;
  isLoading?: boolean;
  isError?: boolean;
  isRefreshing?: boolean;
  /** True when the last refresh mutation failed (e.g. 429 rate limit). */
  refreshError?: boolean;
  onRefresh?: () => void;
  /** Retro only: apply the Fleet-recommended outcome (sets plan_validated). */
  onApplyOutcome?: (planValidated: boolean) => void;
  /** True while the apply mutation is in flight. */
  isApplying?: boolean;
  /** True when the last apply mutation failed. */
  applyError?: boolean;
}

const STATUS_LABELS: Record<FleetStatus, string> = {
  no_plan: 'No Plan',
  needs_work: 'Needs Work',
  looks_testable: 'Looks Testable',
};
const STATUS_CLASSES: Record<FleetStatus, string> = {
  no_plan: 'bg-border/60 text-muted',
  needs_work: 'bg-yellow-500/20 text-yellow-600 border border-yellow-500/50',
  looks_testable: 'bg-green-500/20 text-green-600 border border-green-500/50',
};
const RECOMMENDATION_LABELS: Record<FleetRecommendation, string> = {
  validated_recommended: 'Leans validated',
  invalidated_recommended: 'Leans invalidated',
  insufficient_evidence: 'Insufficient evidence',
};

const PLAN_HELPER_TEXT =
  'Use /plan to write the project plan as a testable bet: what will change, for whom, by how much, and by when.';
const RETRO_NO_PLAN_TEXT =
  'Fleet recommends a retro outcome once the project has a plan to evaluate. Add one with /plan, then revisit.';
const TESTABLE_BET_TEXT =
  'A good hypothesis is a testable bet: what will change, for whom, by how much, and by when.';

function formatRelative(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function RefreshButton({
  onRefresh,
  isRefreshing,
  freshness,
}: {
  onRefresh?: () => void;
  isRefreshing?: boolean;
  freshness?: string | null;
}) {
  if (!onRefresh) return null;
  if (isRefreshing) {
    return (
      <svg className="h-3.5 w-3.5 animate-spin text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Analyzing…" role="status">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    );
  }
  const tooltipContent = freshness ? `Last analyzed ${freshness} — click to refresh` : 'Refresh Fleet analysis';
  return (
    <Tooltip content={tooltipContent} side="top">
      <button
        type="button"
        aria-label="Refresh Fleet analysis"
        onClick={onRefresh}
        className="text-muted hover:text-foreground transition-colors"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </Tooltip>
  );
}

function CardShell({
  title,
  freshness,
  onRefresh,
  isRefreshing,
  refreshError,
  children,
}: {
  title: string;
  freshness?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  refreshError?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4 text-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted leading-tight">{title}</span>
        <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} freshness={freshness} />
      </div>
      {refreshError && (
        <p className="mb-2 text-xs text-yellow-600">Refresh failed — try again in a moment.</p>
      )}
      <div className={cn('transition-opacity', isRefreshing && 'opacity-40 pointer-events-none select-none')}>
        {children}
      </div>
    </div>
  );
}

export function FleetAnalysisCard({
  variant,
  review,
  isLoading = false,
  isError = false,
  isRefreshing = false,
  refreshError = false,
  onRefresh,
  onApplyOutcome,
  isApplying = false,
  applyError = false,
}: FleetAnalysisCardProps) {
  const title = variant === 'retro' ? 'Fleet Recommendation' : 'Fleet — Plan Review';

  // Loading (cache-miss / first GET can block on the model call).
  if (isLoading && !review) {
    return (
      <CardShell title={title}>
        <div className="flex items-center gap-2 text-muted">
          <svg className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Analyzing plan…
        </div>
      </CardShell>
    );
  }

  // Error — legible message + retry, distinct from the AI-not-configured note.
  if (isError && !review) {
    return (
      <CardShell title={title}>
        <p className="text-muted">Could not load Fleet analysis.</p>
        {onRefresh && (
          <button type="button" onClick={onRefresh} className="mt-2 text-xs font-medium text-accent-text hover:underline">
            Try again
          </button>
        )}
      </CardShell>
    );
  }

  if (!review) return null;

  return variant === 'retro' ? (
    <RetroPanel
      review={review}
      onRefresh={onRefresh}
      isRefreshing={isRefreshing}
      refreshError={refreshError}
      onApplyOutcome={onApplyOutcome}
      isApplying={isApplying}
      applyError={applyError}
    />
  ) : (
    <DetailsCard review={review} onRefresh={onRefresh} isRefreshing={isRefreshing} refreshError={refreshError} />
  );
}

function DetailsCard({
  review,
  onRefresh,
  isRefreshing,
  refreshError,
}: {
  review: FleetReviewResponse;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  refreshError?: boolean;
}) {
  const pr = review.plan_review;
  const missing = pr.pieces.filter((p) => !p.met);
  const met = pr.pieces.filter((p) => p.met);
  return (
    <CardShell title="Fleet — Plan Review" freshness={formatRelative(pr.computed_at)} onRefresh={onRefresh} isRefreshing={isRefreshing} refreshError={refreshError}>
      <span className={cn('inline-block rounded-md px-2 py-1 text-xs font-medium', STATUS_CLASSES[pr.status])}>
        {STATUS_LABELS[pr.status]}
      </span>

      {pr.status === 'no_plan' && <p className="mt-3 text-xs text-muted">{PLAN_HELPER_TEXT}</p>}

      {missing.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted">Missing for a testable bet:</div>
          <ul className="mt-1 space-y-1">
            {missing.map((p) => (
              <li key={p.id} className="text-xs text-foreground">• {p.hint}</li>
            ))}
          </ul>
        </div>
      )}

      {met.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {met.map((p) => (
            <span key={p.id} className="text-xs text-green-600">{p.label} ✓</span>
          ))}
        </div>
      )}

      {pr.suggested_rewrite && (
        <div className="mt-3 rounded-md bg-border/30 px-3 py-2">
          <div className="text-xs font-medium text-muted">Suggested rewrite</div>
          <p className="mt-1 text-xs text-foreground">{pr.suggested_rewrite}</p>
        </div>
      )}

      {pr.status !== 'no_plan' && (
        <p className="mt-3 text-xs text-muted">{TESTABLE_BET_TEXT}</p>
      )}

      {!pr.ai_available && pr.status !== 'no_plan' && (
        <p className="mt-1 text-xs text-muted">Fleet plan-review requires an AI provider — contact your admin.</p>
      )}
    </CardShell>
  );
}

function RetroPanel({
  review,
  onRefresh,
  isRefreshing,
  refreshError,
  onApplyOutcome,
  isApplying,
  applyError,
}: {
  review: FleetReviewResponse;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  refreshError?: boolean;
  onApplyOutcome?: (planValidated: boolean) => void;
  isApplying?: boolean;
  applyError?: boolean;
}) {
  const rec = review.retro_recommendation;
  // A retro recommendation needs a plan to evaluate. When the project has none,
  // getReview returns it unavailable — surface the real reason instead of
  // wrongly blaming the AI provider (the plan-review card already shows "No Plan").
  const noPlan = review.plan_review.status === 'no_plan';
  return (
    <CardShell title="Fleet Recommendation" freshness={formatRelative(rec.computed_at)} onRefresh={onRefresh} isRefreshing={isRefreshing} refreshError={refreshError}>
      {noPlan ? (
        <p className="text-xs text-muted">{RETRO_NO_PLAN_TEXT}</p>
      ) : (
        <>
      {/* Advisory, read-only — deliberately not the green/red human control. */}
      <div className="rounded-md border border-border bg-border/20 px-3 py-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Recommended outcome</div>
        <div className="mt-1 text-sm font-semibold text-foreground">{RECOMMENDATION_LABELS[rec.recommendation]}</div>
        {rec.explanation && <p className="mt-1 text-xs text-muted">{rec.explanation}</p>}
        {rec.diagnosis && <p className="mt-2 text-xs italic text-muted">{rec.diagnosis}</p>}
      </div>

      {rec.recommended_next_action && (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted">Recommended next step</div>
          <p className="mt-1 text-xs text-foreground">{rec.recommended_next_action}</p>
        </div>
      )}

      {rec.proposed_action && onApplyOutcome && (
        <ProposedActionControl
          action={rec.proposed_action}
          onApply={onApplyOutcome}
          isApplying={isApplying}
          applyError={applyError}
        />
      )}

      {rec.evidence_found.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted">Evidence found</div>
          <ul className="mt-1 space-y-1">
            {rec.evidence_found.map((e) => (
              <li key={e} className="text-xs text-foreground">• {e}</li>
            ))}
          </ul>
        </div>
      )}

      {rec.evidence_missing.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-muted">Evidence missing</div>
          <ul className="mt-1 space-y-1">
            {rec.evidence_missing.map((e) => (
              <li key={e} className="text-xs text-foreground">• {e}</li>
            ))}
          </ul>
        </div>
      )}

      {rec.suggested_conclusion && (
        <div className="mt-3 rounded-md bg-border/30 px-3 py-2">
          <div className="text-xs font-medium text-muted">Suggested conclusion</div>
          <p className="mt-1 text-xs text-foreground">{rec.suggested_conclusion}</p>
        </div>
      )}

      {!rec.ai_available && (
        <p className="mt-3 text-xs text-muted">Fleet recommendation requires an AI provider — contact your admin.</p>
      )}
        </>
      )}
    </CardShell>
  );
}

/**
 * The confirmable "apply the recommended outcome" control. Fleet only proposes;
 * the user explicitly confirms before plan_validated is written. A two-step
 * confirm guards the state change (R15: this is distinct from, and routes
 * through, the human outcome control). The transient confirm toggle is local UI
 * state; the recommendation + apply handler still arrive via props.
 */
function ProposedActionControl({
  action,
  onApply,
  isApplying,
  applyError,
}: {
  action: FleetProposedAction;
  onApply: (planValidated: boolean) => void;
  isApplying?: boolean;
  applyError?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-3 rounded-md border border-dashed border-border px-3 py-2">
      <div className="text-xs font-medium text-muted">Suggested action</div>
      <p className="mt-1 text-xs text-foreground">{action.summary}</p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={isApplying}
          className="mt-2 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Apply
        </button>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onApply(action.plan_validated)}
            disabled={isApplying}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {isApplying ? 'Applying…' : 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isApplying}
            className="text-xs text-muted hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
      {applyError && <p className="mt-2 text-xs text-yellow-600">Couldn’t apply — try again in a moment.</p>}
    </div>
  );
}
