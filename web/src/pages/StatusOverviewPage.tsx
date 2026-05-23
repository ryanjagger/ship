import { useState } from 'react';
import { StatusOverviewHeatmap } from '@/components/StatusOverviewHeatmap';

export function StatusOverviewPage() {
  const [showArchived, setShowArchived] = useState(false);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex h-10 items-center justify-between border-b border-border px-4">
        <h1 className="text-sm font-medium text-foreground">Status Overview</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border text-accent-text focus:ring-accent/50"
            />
            <span className="text-xs text-muted">Show archived</span>
          </label>
        </div>
      </header>

      {/* Content */}
      <StatusOverviewHeatmap showArchived={showArchived} />
    </div>
  );
}

export default StatusOverviewPage;
