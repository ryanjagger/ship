import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FleetAnalysisCard } from './FleetAnalysisCard';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { FleetReviewResponse, FleetPlanReview, FleetRetroRecommendation } from '@ship/shared';

function planReview(o: Partial<FleetPlanReview> = {}): FleetPlanReview {
  return {
    status: 'needs_work',
    score: 3,
    findings: [{ id: 'timeframe', label: 'Timeframe', message: 'No timeframe named.' }],
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
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('FleetAnalysisCard — details variant', () => {
  it('no_plan → No Plan badge, /plan helper text, no numeric score', () => {
    renderCard(
      <FleetAnalysisCard
        variant="details"
        review={review({ plan: { status: 'no_plan', score: null, findings: [], ai_available: false } })}
      />
    );
    expect(screen.getByText('No Plan')).toBeInTheDocument();
    expect(screen.getByText(/Use \/plan to write the project plan/i)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('needs_work + score 3 → badge, 3/7, findings listed', () => {
    renderCard(<FleetAnalysisCard variant="details" review={review()} />);
    expect(screen.getByText('Needs Work')).toBeInTheDocument();
    expect(screen.getByText('3/7')).toBeInTheDocument();
    expect(screen.getByText('Timeframe:')).toBeInTheDocument();
  });

  it('looks_testable + score 6 → badge + 6/7', () => {
    renderCard(<FleetAnalysisCard variant="details" review={review({ plan: { status: 'looks_testable', score: 6 } })} />);
    expect(screen.getByText('Looks Testable')).toBeInTheDocument();
    expect(screen.getByText('6/7')).toBeInTheDocument();
  });

  it('AI unavailable → shows config note and "—" score', () => {
    renderCard(
      <FleetAnalysisCard
        variant="details"
        review={review({ plan: { status: 'needs_work', score: null, ai_available: false } })}
      />
    );
    expect(screen.getByText(/AI scoring not configured/i)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('suggested_rewrite renders when present', () => {
    renderCard(
      <FleetAnalysisCard variant="details" review={review({ plan: { suggested_rewrite: 'Cut activation to 3 min by Q3.' } })} />
    );
    expect(screen.getByText('Cut activation to 3 min by Q3.')).toBeInTheDocument();
  });

  it('shows a freshness label when computed_at is present', () => {
    const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    renderCard(<FleetAnalysisCard variant="details" review={review({ plan: { computed_at: ts } })} />);
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
