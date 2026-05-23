import * as Popover from '@radix-ui/react-popover';
import { Combobox, ComboboxOption } from '@/components/ui/Combobox';
import { ColumnDefinition } from '@/hooks/useColumnVisibility';
import { ViewMode } from '@/hooks/useListFilters';
import { cn } from '@/lib/cn';

export interface DocumentListToolbarProps {
  /** Sort options for the dropdown */
  sortOptions: ComboboxOption[];
  /** Current sort value */
  sortBy: string;
  /** Sort change handler */
  onSortChange: (value: string) => void;

  /** View mode options to show. If only one, hides toggle. */
  viewModes?: ViewMode[];
  /** Current view mode */
  viewMode?: ViewMode;
  /** View mode change handler */
  onViewModeChange?: (mode: ViewMode) => void;

  /** All columns for the column picker */
  allColumns?: ColumnDefinition[];
  /** Currently visible columns */
  visibleColumns?: Set<string>;
  /** Column toggle handler */
  onToggleColumn?: (key: string) => void;
  /** Number of hidden columns (for badge) */
  hiddenCount?: number;

  /** Whether to show column picker (only in list view) */
  showColumnPicker?: boolean;

  /** Additional filter dropdowns (rendered before sort) */
  filterContent?: React.ReactNode;

  /** Create button config */
  createButton?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

/**
 * Reusable toolbar for document list views.
 * Provides sort dropdown, view toggle, column picker, and create button.
 */
export function DocumentListToolbar({
  sortOptions,
  sortBy,
  onSortChange,
  viewModes = ['list'],
  viewMode = 'list',
  onViewModeChange,
  allColumns,
  visibleColumns,
  onToggleColumn,
  hiddenCount = 0,
  showColumnPicker = true,
  filterContent,
  createButton,
}: DocumentListToolbarProps) {
  const showViewToggle = viewModes.length > 1 && onViewModeChange;
  const showColumns = showColumnPicker && allColumns && visibleColumns && onToggleColumn && viewMode === 'list';

  return (
    <div className="flex items-center gap-3 flex-shrink-0">
      {/* Additional filter content (e.g., program filter) */}
      {filterContent}

      {/* Sort dropdown */}
      <div className="w-32 flex-shrink-0">
        <Combobox
          options={sortOptions}
          value={sortBy}
          onChange={(v) => onSortChange(v || sortOptions[0]?.value || 'updated')}
          placeholder="Sort by"
          aria-label="Sort by"
          id="list-sort"
          allowClear={false}
        />
      </div>

      {/* View toggle */}
      {showViewToggle && (
        <div className="flex rounded-md border border-border flex-shrink-0" role="group" aria-label="View mode">
          {viewModes.includes('list') && (
            <button
              onClick={() => onViewModeChange('list')}
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
              className={cn(
                'px-3 py-1 text-sm transition-colors',
                viewMode === 'list' ? 'bg-border text-foreground' : 'text-muted hover:text-foreground'
              )}
            >
              <ListIcon aria-hidden="true" />
            </button>
          )}
          {viewModes.includes('tree') && (
            <button
              onClick={() => onViewModeChange('tree')}
              aria-label="Tree view"
              aria-pressed={viewMode === 'tree'}
              className={cn(
                'px-3 py-1 text-sm transition-colors',
                viewMode === 'tree' ? 'bg-border text-foreground' : 'text-muted hover:text-foreground'
              )}
            >
              <TreeIcon aria-hidden="true" />
            </button>
          )}
          {viewModes.includes('kanban') && (
            <button
              onClick={() => onViewModeChange('kanban')}
              aria-label="Kanban view"
              aria-pressed={viewMode === 'kanban'}
              className={cn(
                'px-3 py-1 text-sm transition-colors',
                viewMode === 'kanban' ? 'bg-border text-foreground' : 'text-muted hover:text-foreground'
              )}
            >
              <KanbanIcon aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* Column visibility picker */}
      {showColumns && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              className="relative rounded-md border border-border p-1.5 text-muted hover:bg-border/30 hover:text-foreground transition-colors flex-shrink-0"
              aria-label="Customize columns"
            >
              <ColumnsIcon className="h-4 w-4" />
              {hiddenCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white">
                  {hiddenCount}
                </span>
              )}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="z-50 w-48 rounded-md border border-border bg-background p-2 shadow-lg"
              sideOffset={4}
              align="end"
            >
              <div className="text-xs font-medium text-muted mb-2">Show columns</div>
              {allColumns.map((col) => (
                <label
                  key={col.key}
                  className={cn(
                    'flex items-center gap-2 rounded px-2 py-1.5 text-sm',
                    col.hideable ? 'cursor-pointer hover:bg-border/30' : 'cursor-not-allowed opacity-50'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={visibleColumns.has(col.key)}
                    onChange={() => col.hideable && onToggleColumn(col.key)}
                    disabled={!col.hideable}
                    className="h-4 w-4 rounded border-border text-accent-text focus:ring-accent"
                  />
                  <span>{col.label}</span>
                </label>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}

      {/* Create button */}
      {createButton && (
        <button
          onClick={createButton.onClick}
          disabled={createButton.disabled}
          className={cn(
            'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors flex-shrink-0 whitespace-nowrap',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {createButton.label}
        </button>
      )}
    </div>
  );
}

// Icons

function ListIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 6h4m-4 6h4m-4 6h4m4-12h10m-10 6h10m-10 6h10" />
    </svg>
  );
}

function KanbanIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
    </svg>
  );
}

function ColumnsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 4h6M9 20h6M4 9h4M4 15h4M16 9h4M16 15h4M12 4v16" />
    </svg>
  );
}
