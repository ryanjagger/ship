import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface SortOption {
  value: string;
  label: string;
}

export interface UseListFiltersOptions {
  /** Available sort options */
  sortOptions: SortOption[];
  /** Default sort value */
  defaultSort?: string;
  /** URL param name for filter state (optional - if provided, syncs to URL) */
  filterUrlParam?: string;
  /** localStorage key for view mode persistence (optional) - use base key like 'documents' */
  storageKey?: string;
  /** Default view mode if nothing in localStorage */
  defaultViewMode?: ViewMode;
}

export type ViewMode = 'list' | 'kanban' | 'tree' | 'related';

export interface UseListFiltersReturn {
  /** Current sort value */
  sortBy: string;
  /** Set sort value */
  setSortBy: (value: string) => void;
  /** Current view mode */
  viewMode: ViewMode;
  /** Set view mode */
  setViewMode: (mode: ViewMode) => void;
  /** Current filter value (from URL if filterUrlParam provided) */
  filter: string;
  /** Set filter value (updates URL if filterUrlParam provided) */
  setFilter: (value: string) => void;
  /** Sort options for dropdown */
  sortOptions: SortOption[];
}

/**
 * Hook for managing list filter state (sort, view mode, URL-synced filters).
 * Used by list views to provide consistent filtering/sorting UX.
 */
export function useListFilters({
  sortOptions,
  defaultSort,
  filterUrlParam,
  storageKey,
  defaultViewMode = 'list',
}: UseListFiltersOptions): UseListFiltersReturn {
  const [searchParams, setSearchParams] = useSearchParams();

  // Compute full storage key for view mode
  const viewModeStorageKey = storageKey ? `${storageKey}-view-mode` : undefined;

  // Sort state
  const [sortBy, setSortBy] = useState<string>(defaultSort ?? sortOptions[0]?.value ?? 'updated');

  // View mode state (with localStorage persistence if key provided)
  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    if (viewModeStorageKey) {
      try {
        const stored = localStorage.getItem(viewModeStorageKey);
        if (stored && ['list', 'kanban', 'tree', 'related'].includes(stored)) {
          return stored as ViewMode;
        }
      } catch {
        // Ignore
      }
    }
    return defaultViewMode;
  });

  // Set view mode with persistence
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    if (viewModeStorageKey) {
      localStorage.setItem(viewModeStorageKey, mode);
    }
  }, [viewModeStorageKey]);

  // Filter from URL (if param provided)
  const filter = useMemo(() => {
    if (!filterUrlParam) return '';
    return searchParams.get(filterUrlParam) ?? '';
  }, [filterUrlParam, searchParams]);

  // Set filter (updates URL if param provided)
  const setFilter = useCallback((value: string) => {
    if (!filterUrlParam) return;
    setSearchParams((prev) => {
      if (value) {
        prev.set(filterUrlParam, value);
      } else {
        prev.delete(filterUrlParam);
      }
      return prev;
    });
  }, [filterUrlParam, setSearchParams]);

  return {
    sortBy,
    setSortBy,
    viewMode,
    setViewMode,
    filter,
    setFilter,
    sortOptions,
  };
}
