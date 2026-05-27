/**
 * FleetChatContext — single source of truth for the Fleet chat panel.
 *
 * Multiple controls open Fleet chat: the in-content launcher on Project/Week
 * pages (U10) and the "Ask Fleet" icon-rail button (U3). Rather than each owning
 * its own <FleetGraphChat> instance — which on a Project page would mean TWO
 * panels with divergent conversation state — this provider holds the open state
 * and target entity. The panel itself is rendered by AppLayout so it sits in the
 * layout flow (bottom of the main content column, between both sidebars).
 *
 * Entity isolation: `useFleetGraphChat` keeps transcript/conversationId in
 * component-local state with no reset on entity change. A single always-mounted
 * panel would otherwise carry Project A's conversation into Project B. We force
 * a fresh mount per entity via `key`, and clear the entity on close.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { FleetGraphEntityType } from '@/hooks/useFleetGraphChat';

export interface FleetChatEntity {
  entityId: string;
  entityType: FleetGraphEntityType;
  /**
   * Optional opening prompt auto-sent as the first user turn on a fresh open
   * (e.g. "Ask Fleet about this drift"). Ignored when resuming a conversation.
   */
  seedPrompt?: string;
}

interface FleetChatContextValue {
  isOpen: boolean;
  entity: FleetChatEntity | null;
  /** Open the drawer scoped to `entity`. Replaces any currently-open entity. */
  open: (entity: FleetChatEntity) => void;
  /** Close the drawer and clear the entity (no argument-less re-open). */
  close: () => void;
}

const FleetChatContext = createContext<FleetChatContextValue | undefined>(undefined);

export function FleetChatProvider({ children }: { children: ReactNode }) {
  const [entity, setEntity] = useState<FleetChatEntity | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback((next: FleetChatEntity) => {
    setEntity(next);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setEntity(null);
  }, []);

  const value = useMemo<FleetChatContextValue>(
    () => ({ isOpen, entity, open, close }),
    [isOpen, entity, open, close]
  );

  return (
    <FleetChatContext.Provider value={value}>
      {children}
    </FleetChatContext.Provider>
  );
}

export function useFleetChat(): FleetChatContextValue {
  const ctx = useContext(FleetChatContext);
  if (!ctx) {
    throw new Error('useFleetChat must be used within a FleetChatProvider');
  }
  return ctx;
}
