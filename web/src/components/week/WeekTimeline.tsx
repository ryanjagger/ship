import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { cn } from '@/lib/cn';
import { sprintStatusColors } from '@/lib/statusColors';
import { formatDate } from '@/lib/date-utils';
import type { Sprint } from '@/hooks/useWeeksQuery';

// Re-export Sprint type for consumers
export type { Sprint } from '@/hooks/useWeeksQuery';

// Week window represents a 1-week period (may or may not have a week document)
export interface WeekWindow {
  sprint_number: number;
  start_date: Date;
  end_date: Date;
  status: 'active' | 'upcoming' | 'completed';
  sprint: Sprint | null; // null if no week document exists for this window
}

// Compute sprint dates from sprint number (1-week sprints)
export function computeSprintDates(sprintNumber: number, workspaceStartDate: Date): { start: Date; end: Date } {
  const start = new Date(workspaceStartDate);
  start.setDate(start.getDate() + (sprintNumber - 1) * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// Compute sprint status from dates
export function computeSprintStatus(sprintNumber: number, workspaceStartDate: Date): 'active' | 'upcoming' | 'completed' {
  const { start, end } = computeSprintDates(sprintNumber, workspaceStartDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (today < start) return 'upcoming';
  if (today > end) return 'completed';
  return 'active';
}

// Get current sprint number (1-week sprints)
export function getCurrentSprintNumber(workspaceStartDate: Date): number {
  const today = new Date();
  const daysSinceStart = Math.floor((today.getTime() - workspaceStartDate.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.floor(daysSinceStart / 7) + 1);
}

// Generate week windows for display
export function generateWeekWindows(
  sprints: Sprint[],
  workspaceStartDate: Date,
  rangeStart: number,
  rangeEnd: number
): WeekWindow[] {
  const sprintMap = new Map(sprints.map(s => [s.sprint_number, s]));
  const windows: WeekWindow[] = [];

  for (let num = rangeStart; num <= rangeEnd; num++) {
    const { start, end } = computeSprintDates(num, workspaceStartDate);
    const status = computeSprintStatus(num, workspaceStartDate);
    windows.push({
      sprint_number: num,
      start_date: start,
      end_date: end,
      status,
      sprint: sprintMap.get(num) || null,
    });
  }

  return windows;
}

// Format "Week of Jan 27" from a date
function formatWeekName(startDate: Date): string {
  const formatted = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Week of ${formatted}`;
}

// Get plan status color and tooltip based on sprint status and whether plan exists
function getPlanStatus(hasPlan: boolean, status: 'active' | 'upcoming' | 'completed'): { color: string; tooltip: string } {
  if (hasPlan) {
    return { color: 'text-green-500', tooltip: 'Plan exists' };
  }
  if (status === 'upcoming') {
    return { color: 'text-yellow-500', tooltip: 'Plan needed before week starts' };
  }
  // active or completed without plan
  return { color: 'text-red-500', tooltip: 'Missing plan - week already started' };
}

// Get retro status color and tooltip based on sprint status and days since end
function getRetroStatus(hasRetro: boolean, status: 'active' | 'upcoming' | 'completed', endDate: Date): { color: string; tooltip: string } {
  if (hasRetro) {
    return { color: 'text-green-500', tooltip: 'Retro exists' };
  }
  if (status === 'upcoming' || status === 'active') {
    return { color: 'text-muted', tooltip: 'Retro not yet due' };
  }
  // completed without retro - check how long ago
  const daysSinceEnd = Math.floor((Date.now() - endDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceEnd >= 14) {
    return { color: 'text-red-500', tooltip: `Retro overdue (${daysSinceEnd} days since week ended)` };
  }
  return { color: 'text-yellow-500', tooltip: `Retro needed (${daysSinceEnd} days since week ended)` };
}

// Individual week window card
interface WeekWindowCardProps {
  window: WeekWindow;
  isCurrentWindow: boolean;
  isSelected: boolean;
  onSelectSprint: (sprintNumber: number) => void;
  onOpenSprint: (id: string) => void;
}

function WeekWindowCard({
  window,
  isCurrentWindow,
  isSelected,
  onSelectSprint,
  onOpenSprint,
}: WeekWindowCardProps) {
  const { sprint, status, sprint_number, start_date, end_date } = window;

  if (sprint) {
    // Filled window - sprint exists
    const progress = sprint.issue_count > 0
      ? Math.round((sprint.completed_count / sprint.issue_count) * 100)
      : 0;

    // Get plan and retro status
    const planStatus = getPlanStatus(sprint.has_plan ?? false, status);
    const retroStatus = getRetroStatus(sprint.has_retro ?? false, status, end_date);

    return (
      <button
        onClick={() => onSelectSprint(sprint_number)}
        onDoubleClick={() => onOpenSprint(sprint.id)}
        data-active={status === 'active'}
        data-selected={isSelected}
        className={cn(
          'flex-shrink-0 w-40 rounded-lg border p-3 text-left transition-colors hover:bg-border/30',
          isSelected ? 'border-accent border-2 bg-accent/10' : status === 'active' ? 'border-accent/50 border' : 'border-border',
          status === 'completed' && !isSelected && 'opacity-60'
        )}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium text-foreground text-sm">
            {formatWeekName(start_date)}
            {isCurrentWindow && <span className="text-accent-text ml-1">(Current)</span>}
          </span>
          <div className="flex items-center gap-1">
            {sprint.is_complete === false && (
              <span className="text-xs text-orange-500" title="Incomplete - missing required fields">●</span>
            )}
          </div>
        </div>
        {sprint.owner && (
          <div className="text-xs text-muted mb-2 truncate">{sprint.owner.name}</div>
        )}
        <div className="text-xs text-muted mb-2">
          {formatDate(start_date.toISOString())} - {formatDate(end_date.toISOString())}
        </div>
        {status === 'completed' ? (
          <div className="text-xs text-muted">
            {sprint.completed_count}/{sprint.issue_count} ✓
            {(sprint.total_estimate_hours ?? 0) > 0 && ` · ${sprint.total_estimate_hours}h`}
          </div>
        ) : (
          <>
            <div className="text-xs text-muted mb-1">
              {sprint.completed_count}/{sprint.issue_count} done
              {(sprint.total_estimate_hours ?? 0) > 0 && ` · ${sprint.total_estimate_hours}h`}
            </div>
            <div className="h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className={cn(
            'rounded px-1.5 py-0.5 whitespace-nowrap',
            status === 'active' ? 'bg-accent/20 text-accent-text' : sprintStatusColors[status]
          )}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </span>
          <div className="flex items-center gap-1.5">
            <span className={cn(planStatus.color)} title={planStatus.tooltip}>
              {sprint.has_plan ? '✓' : '○'} Plan
            </span>
            <span className={cn(retroStatus.color)} title={retroStatus.tooltip}>
              {sprint.has_retro ? '✓' : '○'} Retro
            </span>
          </div>
        </div>
      </button>
    );
  }

  // Empty window - no sprint document, just informational display
  return (
    <div
      data-active={isCurrentWindow}
      className={cn(
        'flex-shrink-0 w-40 rounded-lg border border-dashed p-3 text-left',
        'border-border/50',
        isCurrentWindow && 'border-accent/30'
      )}
    >
      <div className="font-medium text-muted text-sm mb-1">
        {formatWeekName(start_date)}
        {isCurrentWindow && <span className="text-accent-text ml-1">(Current)</span>}
      </div>
      <div className="text-xs text-muted mb-2">
        {formatDate(start_date.toISOString())} - {formatDate(end_date.toISOString())}
      </div>
      <div className="text-xs text-muted">No issues</div>
      <div className="mt-2 text-xs">
        <span className={cn(
          'rounded px-1.5 py-0.5 whitespace-nowrap',
          sprintStatusColors[status]
        )}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
      </div>
    </div>
  );
}

export interface WeekTimelineProps {
  sprints: Sprint[];
  workspaceSprintStartDate: Date;
  selectedSprintId?: string;
  onSelectSprint?: (sprintNumber: number, sprint: Sprint | null) => void;
  onOpenSprint?: (id: string) => void;
}

/**
 * WeekTimeline - Horizontal infinite scroll week selector
 *
 * Displays weeks in a horizontal timeline with:
 * - Month headers
 * - "Today" marker
 * - Week window cards with progress and plan/retro status
 * - Infinite scroll to load more windows
 * - Click to select, double-click to open
 */
export function WeekTimeline({
  sprints,
  workspaceSprintStartDate,
  selectedSprintId,
  onSelectSprint,
  onOpenSprint,
}: WeekTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentSprintNumber = getCurrentSprintNumber(workspaceSprintStartDate);
  const [rangeStart, setRangeStart] = useState(() => Math.max(1, currentSprintNumber - 13)); // ~quarter back
  const [rangeEnd, setRangeEnd] = useState(() => currentSprintNumber + 13); // ~quarter forward
  const [hasInitialized, setHasInitialized] = useState(false);

  // Find selected sprint number from ID
  const selectedSprintNumber = useMemo(() => {
    if (!selectedSprintId) return currentSprintNumber;
    const sprint = sprints.find(s => s.id === selectedSprintId);
    return sprint?.sprint_number ?? currentSprintNumber;
  }, [selectedSprintId, sprints, currentSprintNumber]);

  // Generate windows for current range
  const windows = useMemo(() => {
    return generateWeekWindows(sprints, workspaceSprintStartDate, rangeStart, rangeEnd);
  }, [sprints, workspaceSprintStartDate, rangeStart, rangeEnd]);

  // Center on current sprint on mount
  useEffect(() => {
    if (scrollRef.current && !hasInitialized) {
      const activeCard = scrollRef.current.querySelector('[data-active="true"]') as HTMLElement;
      if (activeCard) {
        // Manual centering calculation - scrollIntoView doesn't work well for first/last elements
        const container = scrollRef.current;
        const cardRect = activeCard.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const cardCenterInContainer = cardRect.left - containerRect.left + cardRect.width / 2;
        const targetOffset = cardCenterInContainer - container.clientWidth / 2;
        container.scrollLeft = container.scrollLeft + targetOffset;
        setHasInitialized(true);
      }
    }
  }, [hasInitialized, windows]);

  // Handle scroll to load more windows
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const scrollRight = scrollWidth - scrollLeft - clientWidth;

    // Load more on the left when within 200px of left edge
    if (scrollLeft < 200 && rangeStart > 1) {
      const prevScrollWidth = scrollWidth;
      const newStart = Math.max(1, rangeStart - 13);
      setRangeStart(newStart);
      // Maintain scroll position after prepending
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          const newScrollWidth = scrollRef.current.scrollWidth;
          scrollRef.current.scrollLeft = scrollLeft + (newScrollWidth - prevScrollWidth);
        }
      });
    }

    // Load more on the right when within 200px of right edge
    if (scrollRight < 200) {
      setRangeEnd(prev => prev + 13);
    }
  }, [rangeStart]);

  // Attach scroll listener
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Group windows by month
  const monthGroups = useMemo(() => {
    const groups: { month: string; year: number; windows: typeof windows }[] = [];
    let currentGroup: { month: string; year: number; windows: typeof windows } | null = null;

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    windows.forEach((window) => {
      const monthName = monthNames[window.start_date.getMonth()];
      const year = window.start_date.getFullYear();

      if (!currentGroup || currentGroup.month !== monthName || currentGroup.year !== year) {
        currentGroup = { month: monthName, year, windows: [] };
        groups.push(currentGroup);
      }
      currentGroup.windows.push(window);
    });

    return groups;
  }, [windows]);

  // Calculate "Today" marker position
  const todayMarkerPosition = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find which window today falls within
    const windowIndex = windows.findIndex(w => {
      const windowStart = new Date(w.start_date);
      windowStart.setHours(0, 0, 0, 0);
      const windowEnd = new Date(w.end_date);
      windowEnd.setHours(23, 59, 59, 999);
      return today >= windowStart && today <= windowEnd;
    });

    if (windowIndex === -1) return null; // Today is not visible in current range

    const window = windows[windowIndex];
    const windowStart = new Date(window.start_date);
    windowStart.setHours(0, 0, 0, 0);

    // Days into this window (0-6 for 1-week sprints)
    const daysIntoWindow = Math.floor((today.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24));

    // Card width = 160px, gap = 12px
    const cardWidth = 160;
    const gap = 12;

    // Position = (cards before * (width + gap)) + (days / 7 * width)
    const position = (windowIndex * (cardWidth + gap)) + (daysIntoWindow / 7) * cardWidth;

    return position;
  }, [windows]);

  const handleSelectSprint = useCallback((sprintNumber: number) => {
    const window = windows.find(w => w.sprint_number === sprintNumber);
    onSelectSprint?.(sprintNumber, window?.sprint ?? null);
  }, [windows, onSelectSprint]);

  const handleOpenSprint = useCallback((id: string) => {
    onOpenSprint?.(id);
  }, [onOpenSprint]);

  return (
    <div
      ref={scrollRef}
      className="overflow-x-auto scrollbar-hide"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      {/* Wrapper with padding to allow centering first/last cards */}
      <div style={{ paddingLeft: 'calc(50% - 80px)', paddingRight: 'calc(50% - 80px)' }}>
        {/* Month headers row */}
        <div className="flex gap-3 mb-2">
          {monthGroups.map((group, idx) => (
            <div
              key={`${group.month}-${group.year}-${idx}`}
              className="flex-shrink-0"
              style={{ width: `calc(${group.windows.length} * 160px + ${(group.windows.length - 1) * 12}px)` }}
            >
              <div className="text-xs font-medium text-muted uppercase tracking-wide px-1">
                {group.month} {group.year !== new Date().getFullYear() ? group.year : ''}
              </div>
            </div>
          ))}
        </div>
        {/* Sprint cards row with connecting line */}
        <div className="relative py-2">
          {/* Connecting line - runs horizontally through all cards */}
          <div
            className="absolute left-0 right-0 h-0.5 bg-border pointer-events-none"
            style={{ top: '50%', transform: 'translateY(-50%)' }}
          />
          {/* Today marker */}
          {todayMarkerPosition !== null && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none z-10"
              style={{ left: todayMarkerPosition }}
            >
              <div className="relative h-full">
                {/* Vertical line */}
                <div className="absolute top-0 bottom-0 w-0.5 bg-accent" />
                {/* Today label */}
                <div className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap">
                  <span className="text-xs font-medium text-accent-text bg-background px-1 rounded">
                    Today
                  </span>
                </div>
              </div>
            </div>
          )}
          {/* Week cards */}
          <div className="relative flex gap-3">
            {windows.map((window) => (
              <WeekWindowCard
                key={window.sprint_number}
                window={window}
                isCurrentWindow={window.sprint_number === currentSprintNumber}
                isSelected={window.sprint_number === selectedSprintNumber}
                onSelectSprint={handleSelectSprint}
                onOpenSprint={handleOpenSprint}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
