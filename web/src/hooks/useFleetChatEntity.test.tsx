import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useFleetChatEntity } from './useFleetChatEntity';
import { CurrentDocumentProvider, useCurrentDocument } from '@/contexts/CurrentDocumentContext';

/** Expose the document setter alongside the derived entity. */
function useHarness() {
  const { setCurrentDocument } = useCurrentDocument();
  const entity = useFleetChatEntity();
  return { setCurrentDocument, entity };
}

function renderHarness() {
  return renderHook(() => useHarness(), { wrapper: CurrentDocumentProvider });
}

describe('useFleetChatEntity', () => {
  it('returns null when no document is open', () => {
    const { result } = renderHarness();
    expect(result.current.entity).toBeNull();
  });

  it('maps a project document to a project entity', () => {
    const { result } = renderHarness();
    act(() => result.current.setCurrentDocument('p1', 'project'));
    expect(result.current.entity).toEqual({ entityId: 'p1', entityType: 'project' });
  });

  it('maps a sprint document to a week entity', () => {
    const { result } = renderHarness();
    act(() => result.current.setCurrentDocument('s1', 'sprint'));
    expect(result.current.entity).toEqual({ entityId: 's1', entityType: 'week' });
  });

  it('maps an issue document to an issue entity', () => {
    const { result } = renderHarness();
    act(() => result.current.setCurrentDocument('i1', 'issue'));
    expect(result.current.entity).toEqual({ entityId: 'i1', entityType: 'issue' });
  });

  it.each(['wiki', 'program', 'weekly_plan', 'weekly_retro', 'person'] as const)(
    'returns null for %s documents',
    (type) => {
      const { result } = renderHarness();
      act(() => result.current.setCurrentDocument('d1', type));
      expect(result.current.entity).toBeNull();
    }
  );
});
