/**
 * useFleetGraphChat — client glue for the U10 in-page chat surface.
 *
 * Three concerns, one hook (seeded with the page's entity context):
 *   1. availability    — GET /api/fleetgraph/availability (hide the launcher
 *                        when no provider is configured; never a dead control).
 *   2. SSE chat turn   — POST /api/fleetgraph/chat consumed via fetch +
 *                        ReadableStream (NOT EventSource — must send the CSRF
 *                        header). Tokens append incrementally; `final`/`paused`
 *                        are terminal. threadId (== conversationId) is captured
 *                        and reused for subsequent turns.
 *   3. confirm/decline — POST /api/fleetgraph/chat/confirm to resume a paused
 *                        write, plus a conversation GET to re-surface a pending
 *                        proposal after navigation.
 *
 * The SSE consumer follows the U9 contract: `text/event-stream` frames shaped
 * `event: <type>\ndata: <json>\n\n`. We parse on the data line.
 */

import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, apiBaseUrl, ensureCsrfToken } from '@/lib/api';

// ── Backend contract types (U9) — kept local; no shared package export. ──────

export type FleetGraphEntityType = 'project' | 'week';

export type WriteProposalKind = 'create_issue' | 'patch_issue' | 'post_comment';

export interface WriteProposal {
  kind: WriteProposalKind;
  summary: string;
  targetId: string | null;
  args: Record<string, unknown>;
  contentHash: string;
}

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ConversationResponse {
  id: string;
  entityId: string;
  entityType: FleetGraphEntityType;
  transcript: TranscriptTurn[];
  pendingProposal: WriteProposal | null;
}

/** SSE frame payloads. */
type ChatStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'final'; answer: string; threadId: string; executed?: unknown }
  | { type: 'paused'; proposal: WriteProposal; threadId: string };

// ── UI message model ─────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Explicit, distinct states (plan: empty / loading / streaming / error). */
export type ChatStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface UseFleetGraphChatResult {
  messages: ChatMessage[];
  status: ChatStatus;
  /** Non-fatal stream error message (retryable); null when clear. */
  error: string | null;
  /** A write awaiting confirmation, or null. Rendered as a structured card. */
  pendingProposal: WriteProposal | null;
  conversationId: string | null;
  /** Send a user message; opens or continues the conversation. */
  send: (message: string) => Promise<void>;
  /** Confirm (approved=true) or decline (false) the pending proposal. */
  resolveProposal: (approved: boolean) => Promise<void>;
  /** Re-fetch the conversation (history + pending proposal) by id. */
  loadConversation: (id: string) => Promise<void>;
  /** Retry after an error/aborted stream (re-sends the last user message). */
  retry: () => Promise<void>;
}

export const fleetGraphKeys = {
  availability: ['fleetgraph', 'availability'] as const,
};

/** Lightweight provider probe — the launcher hides itself when unavailable. */
export function useFleetGraphAvailability() {
  return useQuery({
    queryKey: fleetGraphKeys.availability,
    queryFn: async (): Promise<boolean> => {
      const res = await apiGet('/api/fleetgraph/availability');
      if (!res.ok) return false;
      const data = (await res.json()) as { available?: boolean };
      return data.available === true;
    },
    staleTime: 1000 * 60 * 5,
  });
}

/** Split an SSE buffer into complete `\n\n`-delimited frames + a remainder. */
function parseFrames(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const events: ChatStreamEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    if (!part.trim()) continue;
    // Each frame has `event: <type>` + `data: <json>` lines; parse the data line.
    const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice('data:'.length).trim()) as ChatStreamEvent);
    } catch {
      // Ignore malformed frame; the stream continues.
    }
  }
  return { events, rest };
}

export function useFleetGraphChat(
  entityId: string,
  entityType: FleetGraphEntityType
): UseFleetGraphChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] = useState<WriteProposal | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const lastMessageRef = useRef<string | null>(null);

  const setConversation = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      const res = await apiGet(`/api/fleetgraph/conversations/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as ConversationResponse;
      setConversation(data.id);
      setMessages(data.transcript.map((t) => ({ role: t.role, content: t.content })));
      setPendingProposal(data.pendingProposal);
      setStatus('idle');
      setError(null);
    },
    [setConversation]
  );

  /** Consume the SSE ReadableStream, updating the trailing assistant message. */
  const consumeStream = useCallback(
    async (res: Response) => {
      setStatus('streaming');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let sawTerminal = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseFrames(buffer);
          buffer = rest;
          for (const event of events) {
            if (event.type === 'token') {
              assistantText += event.token;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: 'assistant', content: assistantText };
                return next;
              });
            } else if (event.type === 'final') {
              sawTerminal = true;
              setConversation(event.threadId);
              const finalText = event.answer || assistantText;
              setMessages((prev) => {
                const next = [...prev];
                if (finalText) next[next.length - 1] = { role: 'assistant', content: finalText };
                else next.pop(); // Drop the empty assistant slot.
                return next;
              });
              setStatus('idle');
            } else if (event.type === 'paused') {
              sawTerminal = true;
              setConversation(event.threadId);
              // No prose answer on pause — drop the empty slot; the structured
              // proposal card stands in for the assistant turn.
              setMessages((prev) => {
                const next = [...prev];
                if (!assistantText) next.pop();
                return next;
              });
              setPendingProposal(event.proposal);
              setStatus('idle');
            }
          }
        }
      } catch {
        setStatus('error');
        setError('The response was interrupted. You can retry.');
        return;
      }
      if (!sawTerminal) {
        setStatus('error');
        setError('The response ended unexpectedly. You can retry.');
      }
    },
    [setConversation]
  );

  /** POST a turn and stream it. `appendUser` controls re-adding the user line. */
  const runTurn = useCallback(
    async (message: string, appendUser: boolean) => {
      lastMessageRef.current = message;
      setError(null);
      setStatus('loading');
      setMessages((prev) => [
        ...prev,
        ...(appendUser ? [{ role: 'user' as const, content: message }] : []),
        { role: 'assistant' as const, content: '' },
      ]);

      const token = await ensureCsrfToken();
      const body: Record<string, unknown> = { message, entityId, entityType };
      if (conversationIdRef.current) body.conversationId = conversationIdRef.current;

      let res: Response;
      try {
        res = await fetch(`${apiBaseUrl}/api/fleetgraph/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          credentials: 'include',
          body: JSON.stringify(body),
        });
      } catch {
        setMessages((prev) => prev.slice(0, -1)); // Drop the empty assistant slot.
        setStatus('error');
        setError('Could not reach Fleet chat. Try again.');
        return;
      }

      if (!res.ok || !res.body) {
        setMessages((prev) => prev.slice(0, -1));
        setStatus('error');
        setError(
          res.status === 429
            ? 'Too many messages — try again in a moment.'
            : res.status === 409
              ? 'A proposed change is awaiting your confirmation.'
              : 'Fleet chat is unavailable right now. Try again.'
        );
        return;
      }

      await consumeStream(res);
    },
    [consumeStream, entityId, entityType]
  );

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || status === 'loading' || status === 'streaming') return;
      await runTurn(trimmed, true);
    },
    [runTurn, status]
  );

  const retry = useCallback(async () => {
    if (status === 'loading' || status === 'streaming') return;
    const last = lastMessageRef.current;
    if (!last) return;
    // The failed user turn is already in `messages`; re-run without re-adding it.
    await runTurn(last, false);
  }, [runTurn, status]);

  const resolveProposal = useCallback(
    async (approved: boolean) => {
      const id = conversationIdRef.current;
      if (!id || !pendingProposal) return;
      // Optimistically clear the card; the proposal is either applied or declined.
      const proposal = pendingProposal;
      setPendingProposal(null);
      setStatus('loading');
      try {
        const res = await apiPost('/api/fleetgraph/chat/confirm', {
          conversationId: id,
          approved,
        });
        if (!res.ok) {
          setPendingProposal(proposal); // Restore — still confirmable.
          setStatus('error');
          setError('Could not complete that action. Try again.');
          return;
        }
        const data = (await res.json()) as { status: string; answer?: string };
        if (data.answer) {
          setMessages((prev) => [...prev, { role: 'assistant', content: data.answer! }]);
        }
        setStatus('idle');
        setError(null);
      } catch {
        setPendingProposal(proposal);
        setStatus('error');
        setError('Could not complete that action. Try again.');
      }
    },
    [pendingProposal]
  );

  return {
    messages,
    status,
    error,
    pendingProposal,
    conversationId,
    send,
    resolveProposal,
    loadConversation,
    retry,
  };
}
