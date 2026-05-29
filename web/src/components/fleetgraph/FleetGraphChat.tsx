/**
 * FleetGraphChat — the U10 right-side overlay drawer.
 *
 * A streaming chat scoped to the current Project/Week (NOT a global chatbot).
 * Renders the SSE transcript as an `aria-live` region, and a proposed write as
 * a STRUCTURED CARD (action + target + labeled fields) — never raw tool JSON.
 *
 * Drawer contract (plan): right-side overlay, focus-trap, scroll-lock,
 * Escape-to-close. When a confirm/decline card appears mid-stream, focus moves
 * to it. On open, prior turns + any pending proposal are re-fetched so a write
 * left pending across navigation is re-surfaced and remains confirmable.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  useFleetGraphChat,
  type FleetGraphEntityType,
  type WriteProposal,
} from '@/hooks/useFleetGraphChat';

interface FleetGraphChatProps {
  open: boolean;
  onClose: () => void;
  entityId: string;
  entityType: FleetGraphEntityType;
  /** Conversation to resume on open (re-surfaces history + pending proposal). */
  initialConversationId?: string | null;
  /**
   * Opening prompt auto-sent as the first turn on a fresh open. Used by the
   * drift badge's "Ask Fleet about this drift" hand-off. Ignored when resuming
   * (initialConversationId set). Only fires once per mount.
   */
  seedPrompt?: string;
}

// ── Structured proposal card field mapping (by kind) ─────────────────────────

const ACTION_VERB: Record<WriteProposal['kind'], string> = {
  create_issue: 'Create issue',
  patch_issue: 'Update issue',
  post_comment: 'Post comment',
};

interface Field {
  label: string;
  value: string;
}

/** Derive labeled fields from `proposal.kind` + `proposal.args`. */
function proposalFields(proposal: WriteProposal): Field[] {
  const args = proposal.args as Record<string, unknown>;
  const fields: Field[] = [];
  const push = (label: string, key: string) => {
    const v = args[key];
    if (v === undefined || v === null || v === '') return;
    fields.push({ label, value: String(v) });
  };
  switch (proposal.kind) {
    case 'create_issue':
      push('Title', 'title');
      push('State', 'state');
      push('Priority', 'priority');
      push('Assignee', 'assignee_id');
      break;
    case 'patch_issue':
      push('Title', 'title');
      push('State', 'state');
      push('Priority', 'priority');
      push('Assignee', 'assignee_id');
      break;
    case 'post_comment':
      push('Comment', 'content');
      break;
  }
  return fields;
}

function ProposalCard({
  proposal,
  onConfirm,
  onDecline,
  disabled,
}: {
  proposal: WriteProposal;
  onConfirm: () => void;
  onDecline: () => void;
  disabled?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const fields = proposalFields(proposal);
  const target = proposal.targetId;

  // Move focus to the card when it appears mid-stream (a11y requirement).
  // useLayoutEffect so focus lands before paint, avoiding a race with the
  // composer's focus-on-open effect.
  useLayoutEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label="Proposed change awaiting confirmation"
      tabIndex={-1}
      className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm outline-none"
    >
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-yellow-500/20 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-yellow-700">
          {ACTION_VERB[proposal.kind]}
        </span>
        {target && <span className="text-xs text-muted">on {target}</span>}
      </div>

      <p className="mt-2 text-foreground">{proposal.summary}</p>

      {fields.length > 0 && (
        <dl className="mt-3 space-y-1">
          {fields.map((f) => (
            <div key={f.label} className="flex gap-2 text-xs">
              <dt className="min-w-16 font-medium text-muted">{f.label}</dt>
              <dd className="flex-1 break-words text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={disabled}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-border/30 disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

export function FleetGraphChat({
  open,
  onClose,
  entityId,
  entityType,
  initialConversationId,
  seedPrompt,
}: FleetGraphChatProps) {
  const chat = useFleetGraphChat(entityId, entityType);
  const { messages, status, error, pendingProposal, send, resolveProposal, loadConversation, retry } = chat;
  const [input, setInput] = useState('');
  const drawerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  const busy = status === 'loading' || status === 'streaming';

  // On a fresh open with a seed prompt (and not resuming a conversation),
  // auto-send it once as the first turn. The drawer remounts per entity (key),
  // so seededRef resets for each new entity. Resume (initialConversationId)
  // takes precedence — a seeded turn would clobber the re-surfaced history.
  //
  // Deferred one macrotask (and cancelled on cleanup) so it fires AFTER React's
  // mount→cleanup→remount churn settles. Firing synchronously on mount races the
  // chat hook's unmount cleanup, which aborts the in-flight fetch and surfaces a
  // spurious "Could not reach Fleet chat" on the very first open (Strict Mode in
  // dev; any fast remount in prod). The clearTimeout makes a phantom cleanup
  // cancel the pending send rather than abort a live request.
  useEffect(() => {
    if (!open || !seedPrompt || initialConversationId || seededRef.current) return;
    const timer = setTimeout(() => {
      seededRef.current = true;
      void send(seedPrompt);
    }, 0);
    return () => clearTimeout(timer);
  }, [open, seedPrompt, initialConversationId, send]);

  // On open: load prior turns + any pending proposal (re-surface flow).
  useEffect(() => {
    if (open && initialConversationId) {
      void loadConversation(initialConversationId);
    }
  }, [open, initialConversationId, loadConversation]);

  // Escape to close + focus trap within the panel.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = drawerRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusable).filter((el) => !el.hasAttribute('disabled'));
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Keep the transcript scrolled to the newest content as tokens stream in.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pendingProposal]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const value = input;
      setInput('');
      void send(value);
    },
    [input, send]
  );

  if (!open) return null;

  const isEmpty = messages.length === 0 && !pendingProposal && status === 'idle';

  return (
    <div
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Fleet chat"
      className="flex h-72 flex-shrink-0 flex-col border-t border-border bg-background"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">Fleet chat</h2>
        <button
          type="button"
          aria-label="Close chat"
          onClick={onClose}
          className="text-muted hover:text-foreground"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      {/* Transcript — aria-live so streamed tokens are announced. */}
      <div
        aria-live="polite"
        aria-busy={busy}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
        {isEmpty && (
          <p className="text-sm text-muted">
            Ask about this {entityType === 'week' ? 'week' : entityType === 'issue' ? 'issue' : 'project'} — Fleet can read its
            context and propose changes for you to confirm.
          </p>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              data-role={m.role}
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                m.role === 'user'
                  ? 'bg-accent text-white'
                  : 'border border-border bg-border/20 text-foreground'
              )}
            >
              {m.content || (status === 'streaming' ? '…' : '')}
            </div>
          </div>
        ))}

        {pendingProposal && (
          <ProposalCard
            proposal={pendingProposal}
            onConfirm={() => void resolveProposal(true)}
            onDecline={() => void resolveProposal(false)}
            disabled={status === 'loading'}
          />
        )}

        {status === 'loading' && !pendingProposal && (
          <div className="flex items-center gap-2 text-xs text-muted" role="status">
            <svg className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Thinking…
          </div>
        )}

        {status === 'error' && error && (
          <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void retry()}
              className="mt-1 font-medium underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        <div ref={transcriptEndRef} />
      </div>

      {/* Composer — input disabled while a turn is in flight. */}
      <form onSubmit={handleSubmit} className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            disabled={busy}
            rows={2}
            placeholder="Ask Fleet…"
            aria-label="Message"
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
