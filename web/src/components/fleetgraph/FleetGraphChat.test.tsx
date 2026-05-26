import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FleetGraphChatLauncher } from './FleetGraphChatLauncher';
import { FleetGraphChat } from './FleetGraphChat';
import type { WriteProposal } from '@/hooks/useFleetGraphChat';

// ── SSE helpers ──────────────────────────────────────────────────────────────

function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A Response whose body is a ReadableStream emitting the given SSE chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sampleProposal: WriteProposal = {
  kind: 'create_issue',
  summary: 'Create issue: "Fix the login bug"',
  targetId: null,
  args: { title: 'Fix the login bug', state: 'todo', priority: 'high' },
  contentHash: 'abc123',
};

let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  // jsdom lacks scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** Default fetch mock: available, CSRF token, empty conversation; chat overridable. */
function mockFetch(handlers: {
  available?: boolean;
  chat?: () => Response;
  confirm?: () => Response;
  conversation?: () => Response;
}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, method, body });
    if (url.includes('/fleetgraph/availability')) {
      return jsonResponse({ available: handlers.available ?? true });
    }
    if (url.includes('/csrf-token')) return jsonResponse({ token: 't' });
    if (url.includes('/fleetgraph/chat/confirm')) {
      return handlers.confirm ? handlers.confirm() : jsonResponse({ status: 'answer', answer: 'Done.', conversationId: 'c1' });
    }
    if (url.includes('/fleetgraph/chat')) {
      return handlers.chat ? handlers.chat() : sseResponse([frame({ type: 'final', answer: 'Hello.', threadId: 'c1' })]);
    }
    if (url.includes('/fleetgraph/conversations/')) {
      return handlers.conversation ? handlers.conversation() : jsonResponse({ id: 'c1', entityId: 'e1', entityType: 'project', transcript: [], pendingProposal: null });
    }
    return jsonResponse({});
  }) as typeof global.fetch;
  return calls;
}

describe('FleetGraphChatLauncher (R10 + availability)', () => {
  it('renders the launcher when available and opens a seeded session', async () => {
    mockFetch({ available: true });
    renderWithProviders(<FleetGraphChatLauncher entityId="e1" entityType="project" />);

    const button = await screen.findByRole('button', { name: /ask fleet/i });
    fireEvent.click(button);

    expect(await screen.findByRole('dialog', { name: /fleet chat/i })).toBeInTheDocument();
    // Seeded for a project — empty-state copy reflects the entity type.
    expect(screen.getByText(/ask about this project/i)).toBeInTheDocument();
  });

  it('renders on a Week page with week-scoped copy', async () => {
    mockFetch({ available: true });
    renderWithProviders(<FleetGraphChatLauncher entityId="w1" entityType="week" />);
    fireEvent.click(await screen.findByRole('button', { name: /ask fleet/i }));
    expect(await screen.findByText(/ask about this week/i)).toBeInTheDocument();
  });

  it('is HIDDEN (not a dead disabled control) when unavailable', async () => {
    mockFetch({ available: false });
    const { container } = renderWithProviders(
      <FleetGraphChatLauncher entityId="e1" entityType="project" />
    );
    // Give the availability query a tick to settle, then assert nothing renders.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /ask fleet/i })).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FleetGraphChat streaming (R11)', () => {
  it('renders streamed tokens incrementally as they arrive', async () => {
    mockFetch({
      chat: () =>
        sseResponse([
          frame({ type: 'token', token: 'Hel' }),
          frame({ type: 'token', token: 'lo ' }),
          frame({ type: 'token', token: 'there' }),
          frame({ type: 'final', answer: 'Hello there', threadId: 'c1' }),
        ]),
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" />
    );

    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByText('hi')).toBeInTheDocument(); // user turn
    await waitFor(() => expect(screen.getByText('Hello there')).toBeInTheDocument());
  });

  it('aria-live transcript region + input disabled during a turn', async () => {
    let release: (() => void) | null = null;
    mockFetch({
      chat: () => {
        // A stream that stays open until released, to observe the in-flight state.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frame({ type: 'token', token: 'wait' })));
            release = () => {
              controller.enqueue(encoder.encode(frame({ type: 'final', answer: 'wait done', threadId: 'c1' })));
              controller.close();
            };
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" />
    );
    // The drawer is portaled into document.body.
    expect(document.body.querySelector('[aria-live="polite"]')).toBeTruthy();

    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(input).toBeDisabled());
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(input).not.toBeDisabled());
  });
});

describe('FleetGraphChat proposal card (R5)', () => {
  it('renders a paused proposal as a structured card (not raw JSON) and confirms', async () => {
    const calls = mockFetch({
      chat: () => sseResponse([frame({ type: 'paused', proposal: sampleProposal, threadId: 'c1' })]),
      confirm: () => jsonResponse({ status: 'answer', answer: 'Created.', conversationId: 'c1' }),
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" />
    );
    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: 'make an issue' } });
    fireEvent.submit(input.closest('form')!);

    // Structured card: action verb + labeled fields, not raw tool JSON.
    expect(await screen.findByText('Create issue')).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(screen.queryByText(/contentHash/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.includes('/chat/confirm') && (c.body as { approved: boolean }).approved === true)
      ).toBe(true)
    );
    await waitFor(() => expect(screen.getByText('Created.')).toBeInTheDocument());
  });

  it('focuses the card when it appears and declining posts approved=false', async () => {
    const calls = mockFetch({
      chat: () => sseResponse([frame({ type: 'paused', proposal: sampleProposal, threadId: 'c1' })]),
      confirm: () => jsonResponse({ status: 'answer', answer: 'Declined.', conversationId: 'c1' }),
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" />
    );
    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: 'make an issue' } });
    fireEvent.submit(input.closest('form')!);

    const card = await screen.findByRole('group', { name: /proposed change/i });
    await waitFor(() => expect(card).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/chat/confirm') && (c.body as { approved: boolean }).approved === false)
      ).toBe(true)
    );
    // Card is gone after declining.
    await waitFor(() => expect(screen.queryByRole('group', { name: /proposed change/i })).toBeNull());
  });
});

describe('FleetGraphChat re-surface + history', () => {
  it('re-surfaces a pending proposal fetched from the conversation on open', async () => {
    mockFetch({
      conversation: () =>
        jsonResponse({
          id: 'c1',
          entityId: 'e1',
          entityType: 'project',
          transcript: [
            { role: 'user', content: 'make an issue', at: '2026-01-01T00:00:00Z' },
          ],
          pendingProposal: sampleProposal,
        }),
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" initialConversationId="c1" />
    );

    // Prior turn renders, and the pending proposal is re-surfaced + confirmable.
    expect(await screen.findByText('make an issue')).toBeInTheDocument();
    expect(await screen.findByText('Create issue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument();
  });

  it('renders prior turns with agent/user distinguished', async () => {
    mockFetch({
      conversation: () =>
        jsonResponse({
          id: 'c1',
          entityId: 'e1',
          entityType: 'project',
          transcript: [
            { role: 'user', content: 'a question', at: '2026-01-01T00:00:00Z' },
            { role: 'assistant', content: 'an answer', at: '2026-01-01T00:01:00Z' },
          ],
          pendingProposal: null,
        }),
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" initialConversationId="c1" />
    );

    const user = await screen.findByText('a question');
    const agent = await screen.findByText('an answer');
    expect(user.closest('[data-role]')).toHaveAttribute('data-role', 'user');
    expect(agent.closest('[data-role]')).toHaveAttribute('data-role', 'assistant');
  });
});

describe('FleetGraphChat error/retry', () => {
  it('surfaces a non-fatal error on a failed turn and allows retry', async () => {
    let attempt = 0;
    mockFetch({
      chat: () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse({ error: 'rate limited' }, 429);
        return sseResponse([frame({ type: 'final', answer: 'Recovered.', threadId: 'c1' })]);
      },
    });

    renderWithProviders(
      <FleetGraphChat open onClose={() => {}} entityId="e1" entityType="project" />
    );
    const input = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByText(/too many messages/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText('Recovered.')).toBeInTheDocument());
  });

  it('Escape closes the drawer', async () => {
    mockFetch({});
    const onClose = vi.fn();
    renderWithProviders(
      <FleetGraphChat open onClose={onClose} entityId="e1" entityType="project" />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
