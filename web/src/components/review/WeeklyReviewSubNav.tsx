import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/cn';
import type { WeeklyReviewActionsState } from '@/hooks/useWeeklyReviewActions';

const OPM_RATINGS = [
  { value: 5, label: 'Outstanding', color: 'text-green-500' },
  { value: 4, label: 'Exceeds Expectations', color: 'text-blue-500' },
  { value: 3, label: 'Fully Successful', color: 'text-muted' },
  { value: 2, label: 'Minimally Satisfactory', color: 'text-orange-500' },
  { value: 1, label: 'Unacceptable', color: 'text-red-500' },
] as const;

type Decision = 'approve' | 'request_changes';

interface WeeklyReviewSubNavProps {
  reviewState: WeeklyReviewActionsState;
}

export function WeeklyReviewSubNav({ reviewState }: WeeklyReviewSubNavProps) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision>('approve');
  const [commentInput, setCommentInput] = useState('');
  const [feedbackInput, setFeedbackInput] = useState('');
  const [ratingInput, setRatingInput] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setDecision('approve');
    setCommentInput(reviewState.approvalComment ?? '');
    setFeedbackInput('');
    setRatingInput(reviewState.currentRating ?? null);
  }, [open, reviewState.approvalComment, reviewState.currentRating]);

  if (!reviewState.isReviewMode) {
    return null;
  }

  const approveLabel = useMemo(() => {
    if (reviewState.isRetro) {
      return reviewState.approvalState === 'approved'
        ? 'Update Approval'
        : reviewState.approvalState === 'changed_since_approved'
          ? 'Re-approve & Rate'
          : 'Rate & Approve';
    }

    return reviewState.approvalState === 'approved'
      ? 'Update Approval'
      : reviewState.approvalState === 'changed_since_approved'
        ? 'Re-approve Plan'
        : 'Approve Plan';
  }, [reviewState.approvalState, reviewState.isRetro]);

  const approveDisabled =
    !reviewState.effectiveSprintId ||
    reviewState.approving ||
    (reviewState.isRetro && !ratingInput);

  const requestDisabled =
    !reviewState.effectiveSprintId ||
    reviewState.approving ||
    !feedbackInput.trim();

  const submitDisabled = decision === 'approve' ? approveDisabled : requestDisabled;

  async function handleSubmit() {
    if (decision === 'approve') {
      const approved = reviewState.isRetro
        ? await reviewState.approveRetro(ratingInput || 0, commentInput)
        : await reviewState.approvePlan(commentInput);
      if (approved) setOpen(false);
      return;
    }

    const requested = await reviewState.requestChanges(feedbackInput);
    if (requested) setOpen(false);
  }

  return (
    <div className="flex w-full items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {reviewState.queueActive ? (
          <>
            <span className="rounded bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent-text">
              {reviewState.queueIndex + 1} of {reviewState.queueLength}
            </span>
            <button
              onClick={reviewState.skip}
              className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-foreground hover:bg-border/50 transition-colors"
            >
              Skip
            </button>
            <button
              onClick={reviewState.exit}
              className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-foreground hover:bg-border/50 transition-colors"
            >
              Exit Review
            </button>
          </>
        ) : (
          <span className="text-xs text-muted">Review mode</span>
        )}
      </div>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            disabled={!reviewState.effectiveSprintId}
            className={cn(
              'rounded bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors',
              reviewState.effectiveSprintId
                ? 'hover:bg-accent/90'
                : 'cursor-not-allowed bg-border/50 text-muted'
            )}
          >
            Submit Review
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-[101] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background shadow-xl focus:outline-none"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !submitDisabled) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <Dialog.Title className="text-lg font-semibold text-foreground">Submit Review</Dialog.Title>
              <Dialog.Close className="rounded p-1 text-muted hover:bg-border hover:text-foreground" aria-label="Close">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Dialog.Close>
            </div>

            <div className="space-y-4 px-5 py-4">
              {reviewState.isRetro && (
                <div>
                  <label className="mb-2 block text-xs font-medium text-muted">Performance Rating</label>
                  <div className="grid grid-cols-5 gap-2">
                    {OPM_RATINGS.map((rating) => (
                      <button
                        key={rating.value}
                        type="button"
                        title={rating.label}
                        onClick={() => setRatingInput(rating.value)}
                        className={cn(
                          'rounded border border-border py-2 text-xs transition-colors',
                          ratingInput === rating.value
                            ? 'bg-accent/20 ring-1 ring-accent'
                            : 'bg-border/20 hover:bg-border/40'
                        )}
                      >
                        <span className={cn('text-sm font-bold', rating.color)}>{rating.value}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-muted">Approval Note (optional)</label>
                <textarea
                  value={commentInput}
                  onChange={(e) => setCommentInput(e.target.value)}
                  placeholder="Add context for this decision..."
                  rows={3}
                  className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted resize-none focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted">Decision</label>
                <div className="space-y-2">
                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded border px-3 py-2',
                      decision === 'approve' ? 'border-green-500/40 bg-green-500/10' : 'border-border'
                    )}
                  >
                    <input
                      type="radio"
                      checked={decision === 'approve'}
                      onChange={() => setDecision('approve')}
                      className="mt-1"
                    />
                    <span className="text-sm text-foreground">Approve</span>
                  </label>

                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded border px-3 py-2',
                      decision === 'request_changes' ? 'border-orange-500/40 bg-orange-500/10' : 'border-border'
                    )}
                  >
                    <input
                      type="radio"
                      checked={decision === 'request_changes'}
                      onChange={() => setDecision('request_changes')}
                      className="mt-1"
                    />
                    <span className="text-sm text-foreground">Request Changes</span>
                  </label>
                </div>
              </div>

              {decision === 'request_changes' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted">What needs to change?</label>
                  <textarea
                    value={feedbackInput}
                    onChange={(e) => setFeedbackInput(e.target.value)}
                    placeholder="Explain what needs to be revised..."
                    rows={3}
                    className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted resize-none focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <Dialog.Close asChild>
                <button className="rounded px-3 py-2 text-sm text-muted hover:bg-border/50 hover:text-foreground transition-colors">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                onClick={handleSubmit}
                disabled={submitDisabled}
                className={cn(
                  'rounded px-3 py-2 text-sm font-medium text-white',
                  decision === 'approve'
                    ? (submitDisabled ? 'bg-border/40 text-muted cursor-not-allowed' : 'bg-green-600 hover:bg-green-500')
                    : (submitDisabled ? 'bg-border/40 text-muted cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-500')
                )}
                title="⌘ Enter"
              >
                {reviewState.approving
                  ? 'Submitting...'
                  : decision === 'approve'
                    ? approveLabel
                    : 'Request Changes'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
