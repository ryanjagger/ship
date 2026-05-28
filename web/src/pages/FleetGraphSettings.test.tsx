import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { insightKeys } from '@/hooks/useInsightsQuery';
import { FleetGraphSettingsPage } from './FleetGraphSettings';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspace: vi.fn(),
}));

const mockedApiGet = vi.mocked(apiGet);
const mockedApiPatch = vi.mocked(apiPatch);
const mockedApiPost = vi.mocked(apiPost);
const mockedUseWorkspace = vi.mocked(useWorkspace);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RenderOpts {
  isAdmin: boolean;
}

function setupWorkspace({ isAdmin }: RenderOpts) {
  mockedUseWorkspace.mockReturnValue({
    currentWorkspace: {
      id: 'ws-1',
      name: 'Test WS',
      archivedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    workspaces: [],
    isWorkspaceAdmin: isAdmin,
    setCurrentWorkspace: vi.fn(),
    setWorkspaces: vi.fn(),
    switchWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
  } as ReturnType<typeof useWorkspace>);
}

function renderWithProviders(opts: RenderOpts) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  setupWorkspace(opts);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FleetGraphSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...utils, queryClient };
}

describe('FleetGraphSettingsPage', () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
    mockedApiPatch.mockReset();
    mockedApiPost.mockReset();
    mockedUseWorkspace.mockReset();
  });

  it('admin sees both toggles and the Sweep now button', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: false })
    );

    renderWithProviders({ isAdmin: true });

    expect(
      await screen.findByLabelText(/Enable scheduled sweep/i)
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Enable AI verdicts/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Sweep now/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/managed by workspace admins/i)
    ).not.toBeInTheDocument();
  });

  it('non-admin sees the read-only banner and neither toggle', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: true })
    );

    renderWithProviders({ isAdmin: false });

    expect(
      await screen.findByText(/managed by workspace admins/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Enable scheduled sweep/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Enable AI verdicts/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Sweep now/i })
    ).not.toBeInTheDocument();
    // PATCH/POST must NOT be invoked on initial render for non-admins.
    expect(mockedApiPatch).not.toHaveBeenCalled();
    expect(mockedApiPost).not.toHaveBeenCalled();
  });

  it('toggling sweep ON optimistically flips the checkbox and PATCH success keeps it on', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: false })
    );
    mockedApiPatch.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: false })
    );

    renderWithProviders({ isAdmin: true });

    const checkbox = (await screen.findByLabelText(
      /Enable scheduled sweep/i
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    // Optimistic update flips the cache after onMutate's cancelQueries
    // microtask resolves — wait one tick before asserting.
    await waitFor(() => expect(checkbox.checked).toBe(true));

    await waitFor(() => {
      expect(mockedApiPatch).toHaveBeenCalledWith(
        '/api/workspaces/settings/fleetgraph',
        { sweepEnabled: true }
      );
    });

    // After success, server truth wins (still on).
    expect(checkbox.checked).toBe(true);
  });

  it('PATCH failure rolls the sweep toggle back and surfaces an inline error', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: false })
    );
    mockedApiPatch.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
        500
      )
    );

    renderWithProviders({ isAdmin: true });

    const checkbox = (await screen.findByLabelText(
      /Enable scheduled sweep/i
    )) as HTMLInputElement;

    fireEvent.click(checkbox);

    // Final state after error settles: rolled back to false + inline error.
    await waitFor(() => {
      expect(checkbox.checked).toBe(false);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/boom/i);
  });

  it('toggling LLM verdicts ON optimistically flips and PATCHes only llmVerdictsEnabled', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: false })
    );
    mockedApiPatch.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: true })
    );

    renderWithProviders({ isAdmin: true });

    const checkbox = (await screen.findByLabelText(
      /Enable AI verdicts/i
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    // Optimistic flip is async — wait for it to land.
    await waitFor(() => expect(checkbox.checked).toBe(true));

    await waitFor(() => {
      expect(mockedApiPatch).toHaveBeenCalledWith(
        '/api/workspaces/settings/fleetgraph',
        { llmVerdictsEnabled: true }
      );
    });

    // Server-truth response — still on.
    expect(checkbox.checked).toBe(true);
  });

  it('LLM toggle PATCH failure rolls back and surfaces an inline error', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: false })
    );
    mockedApiPatch.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'INTERNAL_ERROR', message: 'kapow' } },
        500
      )
    );

    renderWithProviders({ isAdmin: true });

    const checkbox = (await screen.findByLabelText(
      /Enable AI verdicts/i
    )) as HTMLInputElement;

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(checkbox.checked).toBe(false);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/kapow/i);
  });

  it('toggling sweep does not disturb cached llmVerdictsEnabled', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: false, llmVerdictsEnabled: true })
    );
    mockedApiPatch.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: true })
    );

    renderWithProviders({ isAdmin: true });

    const sweep = (await screen.findByLabelText(
      /Enable scheduled sweep/i
    )) as HTMLInputElement;
    const llm = screen.getByLabelText(/Enable AI verdicts/i) as HTMLInputElement;

    // Initial state from GET: sweep off, LLM on.
    expect(sweep.checked).toBe(false);
    expect(llm.checked).toBe(true);

    fireEvent.click(sweep);

    // Optimistic: sweep flipped on, LLM stays on (independent keys).
    await waitFor(() => expect(sweep.checked).toBe(true));
    expect(llm.checked).toBe(true);

    await waitFor(() => {
      expect(mockedApiPatch).toHaveBeenCalledWith(
        '/api/workspaces/settings/fleetgraph',
        { sweepEnabled: true }
      );
    });

    // Final server truth: both on.
    expect(sweep.checked).toBe(true);
    expect(llm.checked).toBe(true);
  });

  it('toggling LLM does not disturb cached sweepEnabled', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: false })
    );
    mockedApiPatch.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: true })
    );

    renderWithProviders({ isAdmin: true });

    const sweep = (await screen.findByLabelText(
      /Enable scheduled sweep/i
    )) as HTMLInputElement;
    const llm = screen.getByLabelText(/Enable AI verdicts/i) as HTMLInputElement;

    // Initial state from GET: sweep on, LLM off.
    expect(sweep.checked).toBe(true);
    expect(llm.checked).toBe(false);

    fireEvent.click(llm);

    // Optimistic: LLM flipped on, sweep stays on.
    await waitFor(() => expect(llm.checked).toBe(true));
    expect(sweep.checked).toBe(true);

    await waitFor(() => {
      expect(mockedApiPatch).toHaveBeenCalledWith(
        '/api/workspaces/settings/fleetgraph',
        { llmVerdictsEnabled: true }
      );
    });

    expect(sweep.checked).toBe(true);
    expect(llm.checked).toBe(true);
  });

  it('Sweep now success shows the delta line including suppressed and invalidates lists + counts', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: false })
    );
    mockedApiPost.mockResolvedValueOnce(
      jsonResponse({
        workspaceId: 'ws-1',
        scanned: 12,
        created: 2,
        refreshed: 1,
        skipped: 8,
        suppressed: 1,
        degraded: false,
      })
    );

    const { queryClient } = renderWithProviders({ isAdmin: true });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const button = await screen.findByRole('button', { name: /Sweep now/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockedApiPost).toHaveBeenCalledWith('/api/insights/sweep');
    });

    expect(
      await screen.findByText(
        /Last manual sweep: 12 scanned, 2 created, 1 refreshed, 1 suppressed, 8 skipped/i
      )
    ).toBeInTheDocument();

    // No degraded warning when degraded is false.
    expect(
      screen.queryByText(/AI fell back to deterministic verdicts/i)
    ).not.toBeInTheDocument();

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey
    );
    expect(invalidatedKeys).toContainEqual(insightKeys.lists());
    expect(invalidatedKeys).toContainEqual(insightKeys.counts());
  });

  it('Sweep now success with degraded: true renders the AI-fallback warning', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: true })
    );
    mockedApiPost.mockResolvedValueOnce(
      jsonResponse({
        workspaceId: 'ws-1',
        scanned: 5,
        created: 2,
        refreshed: 0,
        skipped: 1,
        suppressed: 2,
        degraded: true,
      })
    );

    renderWithProviders({ isAdmin: true });

    const button = await screen.findByRole('button', { name: /Sweep now/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockedApiPost).toHaveBeenCalledWith('/api/insights/sweep');
    });

    expect(
      await screen.findByText(
        /Last manual sweep: 5 scanned, 2 created, 0 refreshed, 2 suppressed, 1 skipped/i
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /AI fell back to deterministic verdicts for some projects this run\. \(Check LangSmith for details\.\)/i
      )
    ).toBeInTheDocument();
  });

  it('Sweep now success with degraded: false omits the warning', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: true })
    );
    mockedApiPost.mockResolvedValueOnce(
      jsonResponse({
        workspaceId: 'ws-1',
        scanned: 3,
        created: 0,
        refreshed: 0,
        skipped: 3,
        suppressed: 0,
        degraded: false,
      })
    );

    renderWithProviders({ isAdmin: true });

    const button = await screen.findByRole('button', { name: /Sweep now/i });
    fireEvent.click(button);

    await screen.findByText(/Last manual sweep:/i);

    expect(
      screen.queryByText(/AI fell back to deterministic verdicts/i)
    ).not.toBeInTheDocument();
  });

  it('Sweep now 409 shows the "already running" message', async () => {
    mockedApiGet.mockResolvedValueOnce(
      jsonResponse({ sweepEnabled: true, llmVerdictsEnabled: false })
    );
    mockedApiPost.mockResolvedValueOnce(
      jsonResponse({ error: 'sweep_in_progress' }, 409)
    );

    renderWithProviders({ isAdmin: true });

    const button = await screen.findByRole('button', { name: /Sweep now/i });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(
      await screen.findByText(
        /A sweep is already running — try again in a moment\./i
      )
    ).toBeInTheDocument();
    // Delta line should NOT appear.
    expect(
      screen.queryByText(/Last manual sweep:/i)
    ).not.toBeInTheDocument();
  });
});
