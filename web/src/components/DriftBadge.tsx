import { cn } from '@/lib/cn';
import type { Drift } from '@ship/shared';

interface DriftBadgeProps {
  drift: Drift | null;
  className?: string;
}

/**
 * Display-only badge for project drift. Renders nothing when the project is
 * ineligible (`drift === null`) or not drifting. The fired reasons are exposed
 * via `aria-label` (and `title` as a sighted-hover convenience) on a
 * non-interactive span — no focus stop, since there is no action. Severity is
 * the number of fired signals; styling is uniform across severities for now
 * (per-severity color is deferred).
 */
export function DriftBadge({ drift, className }: DriftBadgeProps) {
  if (!drift || !drift.isDrifting) return null;

  const reasons = drift.signals.map((s) => s.reason);
  const label = `Drifting: ${reasons.join(', ')}`;

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap',
        'bg-amber-500/10 text-amber-500 border border-amber-500/20',
        className
      )}
    >
      <span aria-hidden="true">⚠</span>
      Drifting · {drift.signals.length}
    </span>
  );
}
