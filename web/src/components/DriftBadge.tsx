import { cn } from '@/lib/cn';
import type { Drift } from '@ship/shared';

interface DriftBadgeProps {
  drift: Drift | null;
  /**
   * When provided, the badge becomes an interactive button that hands the
   * project's drift off to Fleet ("Ask Fleet about this drift"). When omitted,
   * the badge is a non-interactive status span.
   */
  onAskFleet?: () => void;
  className?: string;
}

/**
 * Build the opening prompt for the "Ask Fleet about this drift" hand-off from a
 * drifting project's reasons. Detection is deterministic (the badge); this prompt
 * routes the flagged project to FleetGraph for root-cause reasoning.
 */
export function buildDriftPrompt(drift: Drift): string {
  const reasons = drift.signals.map((s) => s.reason).join(', ');
  return `This project is flagged as drifting (${reasons}). What's the likely root cause, and what should I do about it?`;
}

/**
 * Drift badge for a project. Renders nothing when the project is ineligible
 * (`drift === null`) or not drifting. Severity is the number of fired signals;
 * styling is uniform across severities for now (per-severity color is deferred).
 *
 * Two modes:
 *  - Non-interactive (no `onAskFleet`): a status span; reasons exposed via
 *    `aria-label` for screen readers, no focus stop.
 *  - Interactive (`onAskFleet`): a focusable button that opens Fleet chat seeded
 *    with the drift question — keyboard/focus restored, since there is now an action.
 */
export function DriftBadge({ drift, onAskFleet, className }: DriftBadgeProps) {
  if (!drift || !drift.isDrifting) return null;

  const reasons = drift.signals.map((s) => s.reason);
  const summary = `Drifting: ${reasons.join(', ')}`;
  const sharedClasses = cn(
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap',
    'bg-amber-500/10 text-amber-500 border border-amber-500/20',
    className
  );

  if (onAskFleet) {
    return (
      <button
        type="button"
        aria-label={`${summary}. Ask Fleet about this drift.`}
        title={`${summary} — ask Fleet`}
        onClick={(e) => {
          // Stop row/card click handlers (e.g. list-row navigation) from firing.
          e.stopPropagation();
          onAskFleet();
        }}
        className={cn(sharedClasses, 'cursor-pointer hover:bg-amber-500/20 focus:outline-none focus:ring-1 focus:ring-amber-500/50')}
      >
        <span aria-hidden="true">⚠</span>
        Drifting · {drift.signals.length}
      </button>
    );
  }

  return (
    <span role="status" aria-label={summary} title={summary} className={sharedClasses}>
      <span aria-hidden="true">⚠</span>
      Drifting · {drift.signals.length}
    </span>
  );
}
