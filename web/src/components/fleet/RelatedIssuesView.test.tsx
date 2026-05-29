import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { FleetIssueGroupingResult, FleetIssueGroupCandidate } from '@ship/shared';
import type { Issue } from '@/hooks/useIssuesQuery';

// Stub the heavy IssuesList module — RelatedIssuesView only needs the two badges.
vi.mock('@/components/IssuesList', () => ({
  StatusBadge: ({ state }: { state: string }) => <span>{state}</span>,
  PriorityBadge: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

// Control the grouping query per-test.
const { useRelatedIssueGroups } = vi.hoisted(() => ({ useRelatedIssueGroups: vi.fn() }));
vi.mock('@/hooks/useRelatedIssueGroups', () => ({
  useRelatedIssueGroups,
  relatedIssueGroupsKey: ['fleetgraph', 'related-groups'],
}));

import { RelatedIssuesView } from './RelatedIssuesView';

function candidate(o: Partial<FleetIssueGroupCandidate> & { id: string }): FleetIssueGroupCandidate {
  return {
    title: 'Issue',
    ticket_number: 1,
    display_id: '#1',
    state: 'todo',
    priority: 'medium',
    assignee_name: null,
    project_title: null,
    updated_at: '2026-05-01T00:00:00Z',
    body: null,
    ...o,
  };
}

const flatIssues = [
  { id: 'flat1', display_id: '#99', title: 'Flat fallback issue', state: 'todo', priority: 'high', assignee_name: null },
] as unknown as Issue[];

function mockQuery(state: {
  data?: FleetIssueGroupingResult;
  isLoading?: boolean;
  isError?: boolean;
}) {
  useRelatedIssueGroups.mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
  });
}

describe('RelatedIssuesView', () => {
  it('shows a grouping banner and the flat list while loading', () => {
    mockQuery({ isLoading: true });
    render(<RelatedIssuesView issues={flatIssues} onIssueClick={vi.fn()} />);
    expect(screen.getByText(/grouping related issues/i)).toBeInTheDocument();
    // The user still sees their issues (flat) while the model runs.
    expect(screen.getByText('Flat fallback issue')).toBeInTheDocument();
  });

  it('renders theme groups, reasons, and an Ungrouped bucket', () => {
    mockQuery({
      data: {
        candidates: [
          candidate({ id: 'a', display_id: '#1', title: 'Login 500' }),
          candidate({ id: 'b', display_id: '#2', title: 'Login redirect loop' }),
          candidate({ id: 'c', display_id: '#3', title: 'Lone issue' }),
        ],
        groups: [{ label: 'Login reliability', memberIds: ['a', 'b'], reason: 'Both are about the login flow.' }],
        ungroupedIds: ['c'],
        summary: 'Grouped two login issues.',
        ai_available: true,
        analyzed_count: 3,
        truncated: false,
      },
    });
    render(<RelatedIssuesView issues={[]} onIssueClick={vi.fn()} />);

    expect(screen.getByText('Login reliability')).toBeInTheDocument();
    expect(screen.getByText('Both are about the login flow.')).toBeInTheDocument();
    expect(screen.getByText('Login 500')).toBeInTheDocument();
    expect(screen.getByText('Login redirect loop')).toBeInTheDocument();
    // The one-off lands in the Ungrouped bucket.
    expect(screen.getByText('Ungrouped')).toBeInTheDocument();
    expect(screen.getByText('Lone issue')).toBeInTheDocument();
  });

  it('navigates on row click', () => {
    const onIssueClick = vi.fn();
    mockQuery({
      data: {
        candidates: [
          candidate({ id: 'a', title: 'Alpha' }),
          candidate({ id: 'b', title: 'Beta' }),
        ],
        groups: [{ label: 'Pair', memberIds: ['a', 'b'], reason: 'Related.' }],
        ungroupedIds: [],
        summary: null,
        ai_available: true,
        analyzed_count: 2,
        truncated: false,
      },
    });
    render(<RelatedIssuesView issues={[]} onIssueClick={onIssueClick} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onIssueClick).toHaveBeenCalledWith('a');
  });

  it('falls back to the (filtered) flat list with a notice when the model is unavailable', () => {
    mockQuery({
      data: {
        candidates: [candidate({ id: 'a', title: 'Solo issue' })],
        groups: [],
        ungroupedIds: ['a'],
        summary: null,
        ai_available: false,
        analyzed_count: 1,
        truncated: false,
      },
    });
    render(<RelatedIssuesView issues={flatIssues} onIssueClick={vi.fn()} />);
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
    // Degraded → shows the user's (filtered) issue list, not the raw candidates.
    expect(screen.getByText('Flat fallback issue')).toBeInTheDocument();
  });

  it('falls back to the flat list on query error', () => {
    mockQuery({ isError: true });
    render(<RelatedIssuesView issues={flatIssues} onIssueClick={vi.fn()} />);
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('Flat fallback issue')).toBeInTheDocument();
  });

  // ── filter integration (the active state/project filters narrow the grouping) ──

  const groupedData: FleetIssueGroupingResult = {
    candidates: [
      candidate({ id: 'a', title: 'Alpha' }),
      candidate({ id: 'b', title: 'Beta' }),
      candidate({ id: 'c', title: 'Gamma' }),
    ],
    groups: [{ label: 'AB theme', memberIds: ['a', 'b'], reason: 'Related A/B.' }],
    ungroupedIds: ['c'],
    summary: null,
    ai_available: true,
    analyzed_count: 3,
    truncated: false,
  };

  const asIssues = (ids: string[]) => ids.map((id) => ({ id })) as unknown as Issue[];

  it('keeps a group when all its members are in the active filter', () => {
    mockQuery({ data: groupedData });
    render(<RelatedIssuesView issues={asIssues(['a', 'b'])} applyFilter onIssueClick={vi.fn()} />);
    expect(screen.getByText('AB theme')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // 'c' is filtered out of view entirely.
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
  });

  it('dissolves a group that drops below two members after filtering', () => {
    mockQuery({ data: groupedData });
    // Only 'a' is in view → the AB group has one visible member → dissolved.
    render(<RelatedIssuesView issues={asIssues(['a'])} applyFilter onIssueClick={vi.fn()} />);
    expect(screen.queryByText('AB theme')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('renders an issue only once even if the model lists it in two groups', () => {
    mockQuery({
      data: {
        candidates: [
          candidate({ id: 'a', title: 'Alpha' }),
          candidate({ id: 'b', title: 'Beta' }),
          candidate({ id: 'c', title: 'Gamma' }),
        ],
        // 'a' appears in BOTH groups (defensive: server prevents this, UI must too).
        groups: [
          { label: 'G1', memberIds: ['a', 'b'], reason: 'one' },
          { label: 'G2', memberIds: ['a', 'c'], reason: 'two' },
        ],
        ungroupedIds: [],
        summary: null,
        ai_available: true,
        analyzed_count: 3,
        truncated: false,
      },
    });
    render(<RelatedIssuesView issues={[]} onIssueClick={vi.fn()} />);
    // 'a' is claimed by G1; G2 keeps only 'c' → singleton → dissolves to Ungrouped.
    expect(screen.getAllByText('Alpha')).toHaveLength(1);
    expect(screen.queryByText('G2')).not.toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });
});
