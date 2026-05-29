import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FleetReviewContainer } from './FleetReviewContainer';
import { TooltipProvider } from '@/components/ui/Tooltip';
import type { FleetReviewResponse } from '@ship/shared';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const noPlanReview: FleetReviewResponse = {
  plan_review: { status: 'no_plan', pieces: [], suggested_rewrite: null, ai_available: false },
  retro_recommendation: {
    recommendation: 'insufficient_evidence',
    explanation: 'No plan yet.',
    evidence_found: [],
    evidence_missing: ['No plan'],
    suggested_conclusion: null,
    diagnosis: null,
    recommended_next_action: null,
    proposed_action: null,
    ai_available: false,
  },
  ai_available: false,
};

let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

describe('FleetReviewContainer', () => {
  it('details: renders no_plan state from the fleet endpoint', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/fleet/plan-review')) return jsonResponse(noPlanReview);
      return jsonResponse({});
    }) as typeof global.fetch;

    renderWithProviders(<FleetReviewContainer projectId="p1" variant="details" />);

    await waitFor(() => expect(screen.getByText('No Plan')).toBeInTheDocument());
    expect(screen.getByText(/Use \/plan to write the project plan/i)).toBeInTheDocument();
  });

  it('retro: renders the advisory recommendation and no human Validated/Invalidated control', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/fleet/plan-review')) return jsonResponse(noPlanReview);
      return jsonResponse({});
    }) as typeof global.fetch;

    renderWithProviders(<FleetReviewContainer projectId="p1" variant="retro" />);

    await waitFor(() => expect(screen.getByText('Insufficient evidence')).toBeInTheDocument());
    expect(screen.getByText('Fleet Recommendation')).toBeInTheDocument();
    expect(screen.queryByText('Validated')).toBeNull();
    expect(screen.queryByText('Invalidated')).toBeNull();
  });

  it('refresh control POSTs to the refresh endpoint', async () => {
    const calls: { url: string; method: string }[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/csrf-token')) return jsonResponse({ token: 't' });
      if (url.includes('/fleet/plan-review')) return jsonResponse(noPlanReview);
      return jsonResponse({});
    }) as typeof global.fetch;

    renderWithProviders(<FleetReviewContainer projectId="p1" variant="details" />);
    await waitFor(() => expect(screen.getByText('No Plan')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Fleet analysis' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.includes('/fleet/plan-review/refresh'))
      ).toBe(true)
    );
  });
});
