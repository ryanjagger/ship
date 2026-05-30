import { useMemo } from 'react';
import type { FleetIssueGroupCandidate } from '@ship/shared';
import type { Issue } from '@/hooks/useIssuesQuery';
import { StatusBadge, PriorityBadge } from '@/components/IssuesList';
import { useRelatedIssueGroups } from '@/hooks/useRelatedIssueGroups';
import { cn } from '@/lib/cn';

/** The minimal row shape — satisfied by both `Issue` and `FleetIssueGroupCandidate`. */
interface RowItem {
  id: string;
  display_id: string;
  title: string;
  state: string;
  priority: string;
  assignee_name: string | null;
}

interface RelatedIssuesViewProps {
  /**
   * The already-filtered issue list (state tabs + program/project/sprint
   * dropdowns). Shown flat while grouping loads / when AI is unavailable, and —
   * when {@link applyFilter} is set — used to narrow the (globally-computed)
   * groups to just the issues currently in view.
   */
  issues: Issue[];
  /**
   * True when the user has an active filter. The grouping is always computed over
   * the whole open-issue set (so relationships are found globally); when a filter
   * is active we intersect the displayed groups with `issues` so the filter tabs
   * and dropdowns work here too. When false we show the full grouping untouched
   * (avoids hiding a grouped issue that a stale client list happens to omit).
   */
  applyFilter?: boolean;
  /** Navigate to an issue document. */
  onIssueClick: (id: string) => void;
}

function IssueRow({ item, onClick }: { item: RowItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-border/30 focus:outline-none focus:ring-1 focus:ring-accent/40"
    >
      <span className="w-12 shrink-0 font-mono text-xs text-muted">{item.display_id}</span>
      <span className="flex-1 truncate text-sm text-foreground">{item.title}</span>
      <StatusBadge state={item.state} />
      <PriorityBadge priority={item.priority} />
      {item.assignee_name && (
        <span className="hidden shrink-0 text-xs text-muted sm:inline">{item.assignee_name}</span>
      )}
    </button>
  );
}

/** A flat list of rows — the loading / degraded / unavailable fallback. */
function FlatList({
  items,
  onIssueClick,
  emptyLabel,
}: {
  items: RowItem[];
  onIssueClick: (id: string) => void;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="px-6 py-12 text-center text-sm text-muted">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-0.5 px-3 py-2">
      {items.map((item) => (
        <li key={item.id}>
          <IssueRow item={item} onClick={() => onIssueClick(item.id)} />
        </li>
      ))}
    </ul>
  );
}

/** A small banner above the grouped content (Fleet branding + status text). */
function FleetBanner({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'muted' }) {
  return (
    <div
      className={cn(
        'mx-3 mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
        tone === 'info'
          ? 'border-accent/20 bg-accent/5 text-accent-text'
          : 'border-border bg-border/20 text-muted'
      )}
    >
      <span aria-hidden="true">✦</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * The Issues page "Related" view. On open it auto-runs the FleetGraph `related`
 * mode (via {@link useRelatedIssueGroups}) to theme-group the workspace's open
 * issues, then renders each group (label + reason + member rows) plus an
 * "Ungrouped" bucket. While grouping loads — or if the model is unavailable /
 * errors — it falls back to the flat issue list so the user always sees issues.
 */
export function RelatedIssuesView({ issues, applyFilter = false, onIssueClick }: RelatedIssuesViewProps) {
  // Only ever mounted when the Related view is active, so enable unconditionally.
  const { data, isLoading, isError } = useRelatedIssueGroups(true);

  // id → candidate, for resolving group members.
  const candidateById = useMemo(() => {
    const m = new Map<string, FleetIssueGroupCandidate>();
    data?.candidates.forEach((c) => m.set(c.id, c));
    return m;
  }, [data]);

  // The ids currently in view (after the state tabs + project/program/sprint
  // filters). Only used to narrow the grouping when a filter is active.
  const visibleIds = useMemo(() => new Set(issues.map((i) => i.id)), [issues]);
  const isVisible = (id: string) => !applyFilter || visibleIds.has(id);

  // Resolve groups + the ungrouped bucket from the model output: filter to the
  // visible set, dissolve any group left with <2 members (its survivors fall to
  // Ungrouped), and de-dupe so a given issue is never rendered twice — defensive
  // even though the server already guarantees one group per issue.
  const { groups, ungrouped } = useMemo(() => {
    if (!data) return { groups: [], ungrouped: [] as FleetIssueGroupCandidate[] };
    const seen = new Set<string>();
    const built: { label: string; reason: string; members: FleetIssueGroupCandidate[] }[] = [];
    for (const g of data.groups) {
      const members: FleetIssueGroupCandidate[] = [];
      for (const id of g.memberIds) {
        if (!isVisible(id) || seen.has(id)) continue;
        const c = candidateById.get(id);
        if (!c) continue;
        members.push(c);
        seen.add(id);
      }
      if (members.length >= 2) {
        built.push({ label: g.label, reason: g.reason, members });
      } else {
        // Dissolved (fell below 2 after filtering) — release so it shows ungrouped.
        members.forEach((c) => seen.delete(c.id));
      }
    }
    const ung = data.candidates.filter((c) => isVisible(c.id) && !seen.has(c.id));
    return { groups: built, ungrouped: ung };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, candidateById, visibleIds, applyFilter]);

  // ── Loading: show the flat list with a "grouping…" banner. ──
  if (isLoading) {
    return (
      <div>
        <FleetBanner>Fleet is grouping related issues…</FleetBanner>
        <FlatList items={issues} onIssueClick={onIssueClick} emptyLabel="No issues to group." />
      </div>
    );
  }

  // ── Error or model degraded: fall back to the (filtered) flat list with a notice. ──
  if (isError || !data || !data.ai_available) {
    return (
      <div>
        <FleetBanner tone="muted">
          Fleet grouping is unavailable right now — showing all issues.
        </FleetBanner>
        <FlatList items={issues} onIssueClick={onIssueClick} emptyLabel="No issues to group." />
      </div>
    );
  }

  const truncatedNote = data.truncated ? (
    <p className="px-6 pb-4 pt-1 text-center text-xs text-muted">
      Grouped the {data.analyzed_count} most recently updated open issues. Older issues were not
      analyzed.
    </p>
  ) : null;

  // ── No surviving groups: the model saw no clusters, or the filter removed them. ──
  if (groups.length === 0) {
    const emptyLabel = applyFilter
      ? 'No open issues match this filter.'
      : 'No issues to group.';
    return (
      <div>
        <FleetBanner tone="muted">
          {data.summary || 'Fleet found no clearly related groups among these issues.'}
        </FleetBanner>
        <FlatList items={ungrouped} onIssueClick={onIssueClick} emptyLabel={emptyLabel} />
        {truncatedNote}
      </div>
    );
  }

  // ── Grouped result. ──
  return (
    <div className="pb-4">
      {data.summary && <FleetBanner>{data.summary}</FleetBanner>}

      <div className="space-y-5 px-3 py-3">
        {groups.map((group, gi) => (
          <section key={`${group.label}-${gi}`} aria-label={group.label}>
            <div className="px-3 pb-1">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="text-accent-text" aria-hidden="true">
                  ✦
                </span>
                {group.label}
                <span className="rounded-full bg-border/40 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                  {group.members.length}
                </span>
              </h3>
              {group.reason && <p className="mt-0.5 text-xs text-muted">{group.reason}</p>}
            </div>
            <ul className="space-y-0.5">
              {group.members.map((item) => (
                <li key={item.id}>
                  <IssueRow item={item} onClick={() => onIssueClick(item.id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}

        {ungrouped.length > 0 && (
          <section aria-label="Ungrouped issues">
            <div className="px-3 pb-1">
              <h3 className="text-sm font-semibold text-muted">Ungrouped</h3>
              <p className="mt-0.5 text-xs text-muted">
                Issues Fleet didn’t place in a theme group.
              </p>
            </div>
            <ul className="space-y-0.5">
              {ungrouped.map((item) => (
                <li key={item.id}>
                  <IssueRow item={item} onClick={() => onIssueClick(item.id)} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {truncatedNote}
    </div>
  );
}
