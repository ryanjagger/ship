import { cn } from '@/lib/cn';
import type { FleetInsight, InsightSeverity, DriftSignal } from '@ship/shared';

interface InsightCardProps {
  insight: FleetInsight;
  selected: boolean;
  onSelect: (id: string) => void;
}

const KIND_LABELS: Record<string, string> = {
  project_drift: 'Project drift',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Human-readable "age" string from an ISO timestamp.
 * "just now", "5m ago", "2h ago", "3d ago".
 */
export function formatAge(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = Math.max(0, nowMs - then);
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Severity pill — mirrors the small-pill convention used by `DriftBadge`
 * and the "Incomplete" pill in `Projects.tsx`.
 * - `fyi`  → muted gray (informational, no action requested).
 * - `act`  → amber (action recommended).
 */
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

/**
 * Read the signals array off an insight's evidence blob. `evidence` is
 * detector-shaped (`Record<string, unknown>`) so we narrow defensively.
 */
function extractSignals(insight: FleetInsight): DriftSignal[] {
  const ev = insight.insight.evidence;
  const raw = (ev as { signals?: unknown }).signals;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is DriftSignal =>
      typeof s === 'object' && s !== null && 'type' in s && 'reason' in s
  );
}

export function InsightCard({ insight, selected, onSelect }: InsightCardProps) {
  const { kind, severity, last_seen_at } = insight.insight;
  const label = kindLabel(kind);
  const age = formatAge(last_seen_at);
  const signals = extractSignals(insight);
  const reasonsSummary = signals.map((s) => s.reason).join(', ');

  const ariaParts = [
    label,
    insight.title,
    severity === 'act' ? 'severity Act' : 'severity FYI',
    age ? `last seen ${age}` : '',
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={() => onSelect(insight.id)}
      aria-label={ariaParts.join(', ')}
      aria-pressed={selected}
      data-testid="insight-card"
      data-selected={selected ? 'true' : 'false'}
      className={cn(
        'w-full text-left rounded-md border px-3 py-2 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        selected
          ? 'border-l-2 border-l-accent bg-accent/10 text-foreground'
          : 'border-border bg-background text-foreground hover:bg-border/30'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{insight.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <span>{label}</span>
            {age && (
              <>
                <span aria-hidden="true">·</span>
                <span>{age}</span>
              </>
            )}
          </div>
          {reasonsSummary && (
            <div className="mt-1 truncate text-xs text-muted" title={reasonsSummary}>
              {reasonsSummary}
            </div>
          )}
        </div>
        <SeverityPill severity={severity} />
      </div>
    </button>
  );
}
