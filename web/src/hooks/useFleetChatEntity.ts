/**
 * useFleetChatEntity — derives the focal Fleet chat entity from the open document.
 *
 * Fleet chat is context-scoped: it answers about a Project or a Week. This hook
 * maps the currently-open document to a chat entity, or null when the current
 * view has nothing Fleet can talk about (the nav button greys in that case).
 *
 * Mapping mirrors the in-content launcher (UnifiedEditor): project→'project',
 * sprint→'week'. weekly_plan / weekly_retro are NOT mapped in this iteration
 * (deferred), so the button greys on those pages too.
 */

import { useCurrentDocument } from '@/contexts/CurrentDocumentContext';
import type { FleetChatEntity } from '@/contexts/FleetChatContext';

export function useFleetChatEntity(): FleetChatEntity | null {
  const { currentDocumentId, currentDocumentType } = useCurrentDocument();
  if (!currentDocumentId) return null;
  if (currentDocumentType === 'project') {
    return { entityId: currentDocumentId, entityType: 'project' };
  }
  if (currentDocumentType === 'sprint') {
    return { entityId: currentDocumentId, entityType: 'week' };
  }
  return null;
}
