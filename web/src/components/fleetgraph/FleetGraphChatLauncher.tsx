/**
 * FleetGraphChatLauncher — the U10 in-page open control.
 *
 * A keyboard-operable button mounted in the Project/Week properties area that
 * opens the shared {@link FleetGraphChat} drawer (owned by FleetChatProvider),
 * seeded with the page's entity context. NOT a route-agnostic global chatbot.
 *
 * It no longer renders its own drawer — the nav "Ask Fleet" button and this
 * launcher both drive the single provider-owned drawer, so there is never more
 * than one chat instance with divergent conversation state.
 *
 * Availability (R18): when no AI provider is configured the control is HIDDEN
 * entirely (renders nothing) — never a dead disabled button. (The nav button
 * greys instead; the in-page control declutters by disappearing.)
 */

import { useFleetChat } from '@/contexts/FleetChatContext';
import {
  useFleetGraphAvailability,
  type FleetGraphEntityType,
} from '@/hooks/useFleetGraphChat';

interface FleetGraphChatLauncherProps {
  entityId: string;
  entityType: FleetGraphEntityType;
}

export function FleetGraphChatLauncher({ entityId, entityType }: FleetGraphChatLauncherProps) {
  const { data: available } = useFleetGraphAvailability();
  const { open } = useFleetChat();

  // Hidden when unavailable (don't render a dead control). `undefined` (still
  // loading) also stays hidden until we know the feature is present.
  if (available !== true) return null;

  return (
    <button
      type="button"
      onClick={() => open({ entityId, entityType })}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-border/30"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
      Ask Fleet
    </button>
  );
}
