import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FleetAnalysisCard } from './FleetAnalysisCard';
import type { FleetReviewResponse, FleetPlanReview, FleetRetroRecommendation } from '@ship/shared';

// Radix Tooltip portals never open in jsdom without real pointer events.
// Render content inline so tooltip-content tests can assert visible text.
vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ content, children }: { content: React.ReactNode; children: React.ReactNode }) => (
    <div><span data-testid="tooltip-content">{content}</span>{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function planReview(o: Partial<FleetPlanReview> = {}): FleetPlanReview {
  return {
    status: 'needs_work',
    pieces: [
      { id: 'what_changes', label: 'What will change', met: true, hint: 'Name the outcome that will change.' },
      { id: 'by_how_much', label: 'By how much', met: false, hint: 'Add a target number (by how much).' },
      { id: 'for_whom', label: 'For whom', met: true, hint: 'Say who this is for.' },
      { id: 'by_when', label: 'By when', met: false, hint: 'Set a Target Date (by when).' },
    ],
    suggested_rewrite: null,
    ai_available: true,
    ...o,
  };
}
function retroRec(o: Partial<FleetRetroRecommendation> = {}): FleetRetroRecommendation {
  return {
    recommendation: 'insufficient_evidence',
    explanation: 'Not enough evidence yet.',
    evidence_found: ['2 completed issues'],
    evidence_missing: ['No actual impact recorded'],
    suggested_conclusion: null,
    diagnosis: null,
    recommended_next_action: null,
    proposed_action: null,
    ai_available: true,
    ...o,
  };
}
function review(o: { plan?: Partial<FleetPlanReview>; retro?: Partial<FleetRetroRecommendation>; ai_available?: boolean } = {}): FleetReviewResponse {
  return {
    plan_review: planReview(o.plan),
    retro_recommendation: retroRec(o.retro),
    ai_available: o.ai_available ?? true,
  };
}

function renderCard(ui: React.ReactElement) {
  return render(ui);
}

describe('FleetAnalysisCard — details variant', () => {
  it('no_plan → No Plan badge + /plan helper text', () => {
    renderCard(
      <FleetAnalysisCard
        variant="details"
        review={review({ plan: { status: 'no_plan', pieces: [], ai_available: false } })}
      />
    );
    expect(screen.getByText('No Plan')).toBeInTheDocument();
    expect(screen.getByText(/Use \/plan to write the project plan/i)).toBeInTheDocument();
  });

  it('needs_work → badge, missing pieces as hints, met pieces with ✓', () => {
    renderCard(<FleetAnalysisCard variant="details" review={review()} />);
    expect(screen.getByText('Needs Work')).toBeInTheDocument();
    expect(screen.getByText('Missing for a testable bet:')).toBeInTheDocument();
    expect(screen.getByText(/Add a target number/i)).toBeInTheDocument();
    expect(screen.getByText(/Set a Target Date/i)).toBeInTheDocument();
    expect(screen.getByText('What will change ✓')).toBeInTheDocument();
    // no numeric score anywhere
    expect(screen.queryByText(/\/\s*7/)).toBeNull();
  });

  it('looks_testable → badge, all pieces met', () => {
    renderCard(
      <FleetAnalysisCard
        variant="details"
        review={review({
          plan: {
            status: 'looks_testable',
            pieces: [
              { id: 'what_changes', label: 'What will change', met: true, hint: '' },
              { id: 'by_how_much', label: 'By how much', met: true, hint: '' },
              { id: 'for_whom', label: 'For whom', met: true, hint: '' },
              { id: 'by_when', label: 'By when', met: true, hint: '' },
            ],
          },
        })}
      />
    );
    expect(screen.getByText('Looks Testable')).toBeInTheDocument();
    expect(screen.getByText('By when ✓')).toBeInTheDocument();
    expect(screen.queryByText('Missing for a testable bet:')).toBeNull();
  });

  it('AI unavailable → shows the requires-a-provider note', () => {
    renderCard(
      <FleetAnalysisCard
        variant="details"
        review={review({ plan: { status: 'needs_work', ai_available: false } })}
      />
    );
    expect(screen.getByText(/Fleet plan-review requires an AI provider/i)).toBeInTheDocument();
  });

  it('suggested_rewrite renders when present', () => {
    renderCard(
      <FleetAnalysisCard variant="details" review={review({ plan: { suggested_rewrite: 'Cut activation to 3 min by Q3.' } })} />
    );
    expect(screen.getByText('Cut activation to 3 min by Q3.')).toBeInTheDocument();
  });

  it('shows a freshness label when computed_at is present', () => {
    const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    // onRefresh required — RefreshButton returns null without it.
    // Freshness is in the refresh button's Tooltip content (mocked inline above).
    renderCard(
      <FleetAnalysisCard variant="details" review={review({ plan: { computed_at: ts } })} onRefresh={vi.fn()} />
    );
    expect(screen.getByText(/Last analyzed 3h ago/i)).toBeInTheDocument();
  });
});

describe('FleetAnalysisCard — retro variant (R15: advisory only)', () => {
  it('renders the recommendation read-only — no Validated/Invalidated control', () => {
    renderCard(<FleetAnalysisCard variant="retro" review={review()} />);
    expect(screen.getByText('Fleet Recommendation')).toBeInTheDocument();
    expect(screen.getByText('Insufficient evidence')).toBeInTheDocument();
    expect(screen.getByText(/No actual impact recorded/)).toBeInTheDocument();
    // The card must NOT render the human decision control.
    expect(screen.queryByRole('button', { name: /validated/i })).toBeNull();
    expect(screen.queryByText('Validated')).toBeNull();
    expect(screen.queryByText('Invalidated')).toBeNull();
  });

  it('maps validated_recommended to advisory wording, not "Validated"', () => {
    renderCard(<FleetAnalysisCard variant="retro" review={review({ retro: { recommendation: 'validated_recommended' } })} />);
    expect(screen.getByText('Leans validated')).toBeInTheDocument();
    expect(screen.queryByText('Validated')).toBeNull();
  });

  it('no plan → shows the add-a-plan helper, NOT the provider message', () => {
    renderCard(
      <FleetAnalysisCard
        variant="retro"
        review={review({ plan: { status: 'no_plan', pieces: [], ai_available: false }, retro: { ai_available: false } })}
      />
    );
    expect(screen.getByText(/Fleet recommends a retro outcome once the project has a plan/i)).toBeInTheDocument();
    expect(screen.queryByText(/requires an AI provider/i)).toBeNull();
    expect(screen.queryByText('Recommended outcome')).toBeNull(); // advisory box suppressed
  });

  it('plan present but AI unavailable → still shows the provider message', () => {
    renderCard(
      <FleetAnalysisCard
        variant="retro"
        review={review({ plan: { status: 'needs_work' }, retro: { ai_available: false } })}
      />
    );
    expect(screen.getByText(/requires an AI provider/i)).toBeInTheDocument();
    expect(screen.queryByText(/once the project has a plan/i)).toBeNull();
  });

  it('renders the diagnosis and recommended next step when present', () => {
    renderCard(
      <FleetAnalysisCard
        variant="retro"
        review={review({ retro: { diagnosis: 'The actual impact was never recorded.', recommended_next_action: 'Record the actual impact, then close.' } })}
      />
    );
    expect(screen.getByText('The actual impact was never recorded.')).toBeInTheDocument();
    expect(screen.getByText('Recommended next step')).toBeInTheDocument();
    expect(screen.getByText('Record the actual impact, then close.')).toBeInTheDocument();
  });

  it('does not render the Apply control without a proposed_action', () => {
    renderCard(<FleetAnalysisCard variant="retro" review={review()} onApplyOutcome={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('Apply requires an explicit confirm, then calls onApplyOutcome with plan_validated', () => {
    const onApplyOutcome = vi.fn();
    renderCard(
      <FleetAnalysisCard
        variant="retro"
        review={review({
          retro: {
            recommendation: 'validated_recommended',
            proposed_action: { kind: 'set_plan_validated', plan_validated: true, summary: 'Mark this plan validated and close the retro.' },
          },
        })}
        onApplyOutcome={onApplyOutcome}
      />
    );
    // First click reveals the confirm step — it does NOT fire the write yet.
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApplyOutcome).not.toHaveBeenCalled();
    // Confirm fires the write with the proposed value.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onApplyOutcome).toHaveBeenCalledWith(true);
  });
});

describe('FleetAnalysisCard — states', () => {
  it('loading (no data) shows "Analyzing plan…"', () => {
    renderCard(<FleetAnalysisCard variant="details" isLoading review={null} />);
    expect(screen.getByText(/Analyzing plan/i)).toBeInTheDocument();
  });

  it('error (no data) shows a legible message and a retry affordance', () => {
    const onRefresh = vi.fn();
    renderCard(<FleetAnalysisCard variant="details" isError review={null} onRefresh={onRefresh} />);
    expect(screen.getByText(/Could not load Fleet analysis/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('refresh control triggers onRefresh and has an accessible label', () => {
    const onRefresh = vi.fn();
    renderCard(<FleetAnalysisCard variant="details" review={review()} onRefresh={onRefresh} />);
    const btn = screen.getByRole('button', { name: 'Refresh Fleet analysis' });
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
