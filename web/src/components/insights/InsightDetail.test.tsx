import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FleetInsight } from '@ship/shared';
import { apiPost } from '@/lib/api';
import { InsightDetail } from './InsightDetail';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

const mockedApiPost = vi.mocked(apiPost);

function buildInsight(overrides: Partial<FleetInsight> = {}): FleetInsight {
  const iso = '2026-05-28T10:00:00Z';
  return {
    id: 'ins-1',
    workspace_id: 'ws-1',
    title: 'Project drift: Onboarding revamp',
    created_at: iso,
    subject_id: 'proj-1',
    subject_title: 'Onboarding revamp',
    subject_document_type: 'project',
    insight: {
      state: 'open',
      kind: 'project_drift',
      severity: 'act',
      subject_id: 'proj-1',
      subject_entity_type: 'project',
      summary: 'Project drift detected.',
      recommended_action: 'Review plan with team.',
      evidence: {
        signals: [
          { type: 'idle', reason: 'idle 9 days' },
          { type: 'stale_plan', reason: 'plan stale 24 days' },
        ],
      },
      verdict: { decision: 'SURFACE_ACT', reasoning: 'two signals fired' },
      input_hash: 'hash-1',
      accountable_owner_id: null,
      first_seen_at: iso,
      last_seen_at: iso,
      last_changed_at: iso,
      occurrence_count: 1,
      resolved_at: null,
      resolved_reason: null,
      snoozed_until: null,
      dismissed_at: null,
      dismissed_by: null,
    },
    ...overrides,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('InsightDetail', () => {
  beforeEach(() => {
    mockedApiPost.mockReset();
  });

  it('renders all signals from evidence.signals', () => {
    renderWithProviders(<InsightDetail insight={buildInsight()} />);
    expect(screen.getByText('idle 9 days')).toBeInTheDocument();
    expect(screen.getByText('plan stale 24 days')).toBeInTheDocument();
  });

  it('renders summary, recommended action, and subject link', () => {
    renderWithProviders(<InsightDetail insight={buildInsight()} />);
    expect(screen.getByText('Project drift detected.')).toBeInTheDocument();
    expect(screen.getByText('Review plan with team.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Onboarding revamp/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1');
  });

  it('shows the Resolve button when state is open', () => {
    renderWithProviders(<InsightDetail insight={buildInsight()} />);
    expect(screen.getByRole('button', { name: /Resolve/i })).toBeInTheDocument();
  });

  it('hides the Resolve button and shows a Resolved pill when state is resolved', () => {
    const resolved = buildInsight();
    resolved.insight = {
      ...resolved.insight,
      state: 'resolved',
      resolved_at: '2026-05-28T11:00:00Z',
      resolved_reason: 'Plan refreshed.',
    };
    renderWithProviders(<InsightDetail insight={resolved} />);

    expect(screen.queryByRole('button', { name: /Resolve/i })).not.toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    // Resolution note shows up when present.
    expect(screen.getByText('Plan refreshed.')).toBeInTheDocument();
  });

  it('clicking Resolve calls the mutation with { reason } when textarea is filled', async () => {
    mockedApiPost.mockResolvedValueOnce(
      new Response(JSON.stringify({ priorState: 'open', didResolve: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    renderWithProviders(<InsightDetail insight={buildInsight()} />);

    const textarea = screen.getByLabelText(/Resolution note/i);
    fireEvent.change(textarea, { target: { value: 'Replanned with PM.' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve/i }));

    await waitFor(() => {
      expect(mockedApiPost).toHaveBeenCalledTimes(1);
    });
    expect(mockedApiPost).toHaveBeenCalledWith(
      '/api/insights/ins-1/resolve',
      { reason: 'Replanned with PM.' }
    );
  });

  it('clicking Resolve with empty textarea posts an empty body (no reason)', async () => {
    mockedApiPost.mockResolvedValueOnce(
      new Response(JSON.stringify({ priorState: 'open', didResolve: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    renderWithProviders(<InsightDetail insight={buildInsight()} />);

    fireEvent.click(screen.getByRole('button', { name: /Resolve/i }));

    await waitFor(() => {
      expect(mockedApiPost).toHaveBeenCalledTimes(1);
    });
    expect(mockedApiPost).toHaveBeenCalledWith('/api/insights/ins-1/resolve', {});
  });
});
