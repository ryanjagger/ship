import { Tooltip } from '@/components/ui/Tooltip';

interface PropertyRowProps {
  label: string;
  tooltip?: string;
  highlighted?: boolean;
  children: React.ReactNode;
}

/**
 * PropertyRow - Standard property field layout for document sidebars
 *
 * Supports optional tooltip and field highlighting (e.g., for missing required fields).
 */
export function PropertyRow({ label, tooltip, highlighted, children }: PropertyRowProps) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <div className={`text-xs font-medium ${highlighted ? 'text-amber-500' : 'text-muted'}`}>
          {label}
          {highlighted && <span className="ml-1 text-amber-500">*</span>}
        </div>
        {tooltip && (
          <Tooltip content={tooltip} side="right" delayDuration={200}>
            <button
              type="button"
              className="text-muted/60 hover:text-muted transition-colors"
              aria-label={`More info about ${label}`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
              </svg>
            </button>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}
