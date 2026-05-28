import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { FleetInsight } from '@ship/shared';
import { InsightCard } from './InsightCard';

function buildInsight(overrides: Partial<FleetInsight> = {}): FleetInsight {
  // last_seen_at ~2 hours in the past (relative to real now) so age renders
  // as "2h ago"/similar — a hardcoded date can land in the future relative
  // to the test run clock and make formatAge fall back to "just now".
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  return {
    id: 'ins-1',
    workspace_id: 'ws-1',
    title: 'Project drift: Onboarding revamp',
    created_at: twoHoursAgo,
    subject_id: 'proj-1',
    subject_title: 'Onboarding revamp',
    subject_document_type: 'project',
    insight: {
      state: 'open',
      kind: 'project_drift',
      severity: 'act',
      subject_id: 'proj-1',
      subject_entity_type: 'project',
      summary: 'Project shows signs of drift.',
      recommended_action: 'Review plan.',
      evidence: {
        signals: [
          { type: 'idle', reason: 'idle 9 days' },
          { type: 'stale_plan', reason: 'plan stale 24 days' },
        ],
      },
      verdict: { decision: 'SURFACE_ACT', reasoning: 'two signals fired' },
      input_hash: 'hash-1',
      accountable_owner_id: null,
      first_seen_at: twoHoursAgo,
      last_seen_at: twoHoursAgo,
      last_changed_at: twoHoursAgo,
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

describe('InsightCard', () => {
  it('renders subject title, kind label, severity pill, and age', () => {
    const insight = buildInsight();
    render(<InsightCard insight={insight} selected={false} onSelect={() => {}} />);

    expect(screen.getByText(/Project drift: Onboarding revamp/i)).toBeInTheDocument();
    expect(screen.getByText('Project drift')).toBeInTheDocument();
    expect(screen.getByText('Act')).toBeInTheDocument();
    // The card prints last_seen_at as a relative age string.
    expect(screen.getByText(/ago/i)).toBeInTheDocument();
  });

  it('aria-label contains kind, subject, severity, and age', () => {
    const insight = buildInsight();
    render(<InsightCard insight={insight} selected={false} onSelect={() => {}} />);

    const card = screen.getByRole('button', { name: /Project drift/i });
    const label = card.getAttribute('aria-label') ?? '';
    expect(label).toContain('Project drift');
    expect(label).toContain('Onboarding revamp');
    expect(label).toContain('severity Act');
    expect(label).toMatch(/last seen .* ago/);
  });

  it('renders FYI severity for fyi insights', () => {
    const insight = buildInsight({
      insight: {
        ...buildInsight().insight,
        severity: 'fyi',
      },
    });
    render(<InsightCard insight={insight} selected={false} onSelect={() => {}} />);
    expect(screen.getByText('FYI')).toBeInTheDocument();
  });

  it('selected=true applies visual highlight (selection marker)', () => {
    const insight = buildInsight();
    const { rerender } = render(
      <InsightCard insight={insight} selected={false} onSelect={() => {}} />
    );
    const card = screen.getByTestId('insight-card');
    expect(card).toHaveAttribute('data-selected', 'false');
    expect(card).toHaveAttribute('aria-pressed', 'false');

    rerender(<InsightCard insight={insight} selected={true} onSelect={() => {}} />);
    const selectedCard = screen.getByTestId('insight-card');
    expect(selectedCard).toHaveAttribute('data-selected', 'true');
    expect(selectedCard).toHaveAttribute('aria-pressed', 'true');
  });

  it('click invokes onSelect with the insight id', () => {
    const onSelect = vi.fn();
    const insight = buildInsight();
    render(<InsightCard insight={insight} selected={false} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('insight-card'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('ins-1');
  });
});
