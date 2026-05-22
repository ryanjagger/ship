import { useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import { cn } from '@/lib/cn';

const STORAGE_KEY = 'dashboard-view';
export type DashboardView = 'my-work' | 'overview';

export function DashboardSidebar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentView = (searchParams.get('view') as DashboardView) || 'my-work';

  // On mount, restore saved view preference if no view param is set
  useEffect(() => {
    if (!searchParams.get('view')) {
      const savedView = localStorage.getItem(STORAGE_KEY) as DashboardView | null;
      if (savedView && savedView !== 'my-work') {
        setSearchParams({ view: savedView }, { replace: true });
      }
    }
  }, []);

  const setView = (view: DashboardView) => {
    localStorage.setItem(STORAGE_KEY, view);
    setSearchParams(view === 'my-work' ? {} : { view }, { replace: true });
  };

  const isMyWork = currentView === 'my-work' && !searchParams.has('view');

  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      <button
        onClick={() => setView('my-work')}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          isMyWork
            ? 'bg-accent/10 text-accent-text font-medium'
            : 'text-muted hover:bg-border/30 hover:text-foreground'
        )}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        My Work
      </button>

      <button
        onClick={() => setView('overview')}
        className={cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors mt-1',
          currentView === 'overview'
            ? 'bg-accent/10 text-accent-text font-medium'
            : 'text-muted hover:bg-border/30 hover:text-foreground'
        )}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 16a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zM14 13a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6z" />
        </svg>
        Overview
      </button>
    </div>
  );
}
