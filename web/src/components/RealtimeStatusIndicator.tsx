import { useRealtimeEvents } from '@/hooks/useRealtimeEvents';

export function RealtimeStatusIndicator() {
  const { status } = useRealtimeEvents();

  if (status === 'connected' || status === 'disconnected' || status === 'connecting') {
    return null;
  }

  const message =
    status === 'rate-limited'
      ? 'Realtime updates limited — reconnecting with backoff.'
      : 'Realtime reconnecting…';

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-background/95 px-3 py-1 text-xs text-muted shadow-sm"
    >
      <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warning align-middle" aria-hidden="true" />
      {message}
    </div>
  );
}
