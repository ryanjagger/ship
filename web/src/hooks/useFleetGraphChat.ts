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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiBaseUrl, ensureCsrfToken } from '@/lib/api';

// ── Backend contract types (U9) — kept local; no shared package export. ──────

export type FleetGraphEntityType = 'project' | 'week' | 'issue';

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
  const queryClient = useQueryClient();

  // ── Lifecycle / concurrency guards ─────────────────────────────────────────
  // `mountedRef` gates every post-await setState so nothing writes to a
  // torn-down fiber (the hook lives in the always-mounted launcher; closing the
  // drawer / navigating away unmounts mid-stream). `abortRef` holds the current
  // turn's controller so we can abort the live fetch on unmount or a new turn.
  // `isRunningRef` is a synchronous double-submit guard (React `status` hasn't
  // committed between submit and setStatus('loading')).
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const isRunningRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const setConversation = useCallback((id: string | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      const res = await apiGet(`/api/fleetgraph/conversations/${id}`);
      if (!mountedRef.current) return;
      if (!res.ok) {
        // Surface the failure instead of silently dropping a server-side
        // pending proposal and leaving the user in a blank idle state.
        setError('Could not load the prior conversation.');
        setStatus('error');
        return;
      }
      const data = (await res.json()) as ConversationResponse;
      if (!mountedRef.current) return;
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
      if (mountedRef.current) setStatus('streaming');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let sawTerminal = false;
      try {
        for (;;) {
          // Bail if the component unmounted (drawer closed / navigated away):
          // cancel the reader so the connection closes and stop updating state.
          if (!mountedRef.current) {
            await reader.cancel().catch(() => {});
            return;
          }
          const { value, done } = await reader.read();
          if (done) break;
          if (!mountedRef.current) {
            await reader.cancel().catch(() => {});
            return;
          }
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
        // An abort (unmount / new turn) lands here too — don't write to a
        // torn-down fiber.
        if (!mountedRef.current) return;
        // Remove the partial assistant bubble so the retry path doesn't render
        // two assistant bubbles for one turn (FR-08).
        if (assistantText) setMessages((prev) => prev.slice(0, -1));
        setStatus('error');
        setError('The response was interrupted. You can retry.');
        return;
      }
      if (!mountedRef.current) return;
      if (!sawTerminal) {
        if (assistantText) setMessages((prev) => prev.slice(0, -1));
        setStatus('error');
        setError('The response ended unexpectedly. You can retry.');
      }
    },
    [setConversation]
  );

  /** POST a turn and stream it. `appendUser` controls re-adding the user line. */
  const runTurn = useCallback(
    async (message: string, appendUser: boolean) => {
      // Synchronous double-submit guard: React `status` hasn't committed yet
      // between submit and setStatus('loading'), so a rapid double-tap could
      // co-fire two turns. This ref flips immediately.
      if (isRunningRef.current) return;
      isRunningRef.current = true;

      // Abort any prior in-flight turn and start a fresh controller; pass its
      // signal to fetch so closing the drawer / a new turn closes the request.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        lastMessageRef.current = message;
        setError(null);
        setStatus('loading');
        setMessages((prev) => [
          ...prev,
          ...(appendUser ? [{ role: 'user' as const, content: message }] : []),
          { role: 'assistant' as const, content: '' },
        ]);

        const token = await ensureCsrfToken();
        if (!mountedRef.current) return;
        const body: Record<string, unknown> = { message, entityId, entityType };
        if (conversationIdRef.current) body.conversationId = conversationIdRef.current;

        let res: Response;
        try {
          res = await fetch(`${apiBaseUrl}/api/fleetgraph/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            credentials: 'include',
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch {
          if (!mountedRef.current) return;
          setMessages((prev) => prev.slice(0, -1)); // Drop the empty assistant slot.
          setStatus('error');
          setError('Could not reach Fleet chat. Try again.');
          return;
        }

        if (!mountedRef.current) return;
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
      } finally {
        isRunningRef.current = false;
      }
    },
    [consumeStream, entityId, entityType]
  );

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || isRunningRef.current) return;
      await runTurn(trimmed, true);
    },
    [runTurn]
  );

  const retry = useCallback(async () => {
    if (isRunningRef.current) return;
    const last = lastMessageRef.current;
    if (!last) return;
    // The failed user turn is already in `messages`; re-run without re-adding it.
    await runTurn(last, false);
  }, [runTurn]);

  const resolveProposal = useCallback(
    async (approved: boolean) => {
      const id = conversationIdRef.current;
      if (!id || !pendingProposal) return;
      // Synchronous double-resolve guard (same ref a turn uses): a double-tap
      // Confirm — or Confirm-then-Decline in the same tick — must not co-fire two
      // POST /chat/confirm. The ref flips before any await; the second tap returns
      // early. A turn and a confirm shouldn't normally overlap, so sharing the ref
      // is safe and keeps the guard consistent.
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      // Optimistically clear the card; the proposal is either applied or declined.
      const proposal = pendingProposal;
      setPendingProposal(null);
      setStatus('loading');
      try {
        const res = await apiPost('/api/fleetgraph/chat/confirm', {
          conversationId: id,
          approved,
        });
        if (!mountedRef.current) return;
        if (res.status === 409) {
          // The proposal was already resolved server-side (e.g. a prior tap
          // landed, or it expired). Restoring the card would just 409 again on
          // the next tap (retry loop). Settle to idle without restoring — and
          // without setting `error`, which renders a misleading Retry control.
          setPendingProposal(null);
          setStatus('idle');
          setError(null);
          return;
        }
        if (!res.ok) {
          setPendingProposal(proposal); // Restore — still confirmable.
          setStatus('error');
          setError('Could not complete that action. Try again.');
          return;
        }
        const data = (await res.json()) as {
          status?: string;
          answer?: string;
          proposal?: WriteProposal;
        };
        if (!mountedRef.current) return;
        if (data.status === 'paused' && data.proposal) {
          // Defensive: the confirm resolved into another paused write. Re-surface
          // the card rather than going idle with nothing to act on.
          setPendingProposal(data.proposal);
          setStatus('idle');
          setError(null);
          return;
        }
        if (data.answer) {
          setMessages((prev) => [...prev, { role: 'assistant', content: data.answer! }]);
        }
        // An approved write committed server-side (issue created/patched, comment
        // posted) but the rest of the app's TanStack caches don't know — without
        // this, the project's Issues tab keeps showing its stale (pre-write) list
        // until a hard refresh. Invalidate the surfaces an agent write can change:
        // project subtree (issues/detail/fleet/counts), the global issues list,
        // and the targeted document's comments.
        if (approved) {
          queryClient.invalidateQueries({ queryKey: ['projects'] });
          queryClient.invalidateQueries({ queryKey: ['issues'] });
          if (proposal.kind === 'post_comment' && proposal.targetId) {
            queryClient.invalidateQueries({ queryKey: ['comments', proposal.targetId] });
          }
        }
        setStatus('idle');
        setError(null);
      } catch {
        if (!mountedRef.current) return;
        setPendingProposal(proposal);
        setStatus('error');
        setError('Could not complete that action. Try again.');
      } finally {
        isRunningRef.current = false;
      }
    },
    [pendingProposal, queryClient]
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
