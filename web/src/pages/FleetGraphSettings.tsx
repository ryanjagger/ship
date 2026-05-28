import { useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { insightKeys } from '@/hooks/useInsightsQuery';

// ── Types ──────────────────────────────────────────────────────────────

interface FleetgraphSettings {
  sweepEnabled: boolean;
}

interface SweepResult {
  workspaceId: string;
  scanned: number;
  created: number;
  refreshed: number;
  skipped: number;
}

// ── Query keys ─────────────────────────────────────────────────────────

const fleetgraphSettingsKey = ['workspace-settings', 'fleetgraph'] as const;

// ── HTTP ───────────────────────────────────────────────────────────────

async function fetchFleetgraphSettings(): Promise<FleetgraphSettings> {
  const res = await apiGet('/api/workspaces/settings/fleetgraph');
  if (!res.ok) {
    const error = new Error('Failed to load Fleet settings') as Error & {
      status: number;
    };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as FleetgraphSettings;
}

async function updateFleetgraphSettings(
  body: { sweepEnabled: boolean }
): Promise<FleetgraphSettings> {
  const res = await apiPatch('/api/workspaces/settings/fleetgraph', body);
  if (!res.ok) {
    // Try to surface server message; tolerate non-JSON 500s gracefully.
    let message = 'Failed to update Fleet settings';
    try {
      const data = (await res.json()) as
        | { error?: { message?: string } }
        | { error?: string };
      if (typeof (data as any)?.error?.message === 'string') {
        message = (data as any).error.message;
      } else if (typeof (data as any)?.error === 'string') {
        message = (data as any).error;
      }
    } catch {
      // ignore JSON parse errors
    }
    const error = new Error(message) as Error & { status: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as FleetgraphSettings;
}

async function sweepNow(): Promise<SweepResult> {
  const res = await apiPost('/api/insights/sweep');
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore
    }
    const message =
      res.status === 409 && body.error === 'sweep_in_progress'
        ? 'A sweep is already running — try again in a moment.'
        : body.message ?? body.error ?? 'Failed to start sweep';
    const error = new Error(message) as Error & { status: number; code?: string };
    error.status = res.status;
    if (body.error) error.code = body.error;
    throw error;
  }
  return (await res.json()) as SweepResult;
}

// ── Inlined hooks ──────────────────────────────────────────────────────
// These live in the page file per the scope-guardian recommendation —
// nothing else in the app reads/writes this surface yet, so a separate
// hooks module would be premature.

function useFleetgraphSettingsQuery() {
  return useQuery({
    queryKey: fleetgraphSettingsKey,
    queryFn: fetchFleetgraphSettings,
    staleTime: 1000 * 60,
  });
}

function useUpdateFleetgraphSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    FleetgraphSettings,
    Error,
    { sweepEnabled: boolean },
    { previous: FleetgraphSettings | undefined }
  >({
    mutationFn: updateFleetgraphSettings,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: fleetgraphSettingsKey });
      const previous =
        queryClient.getQueryData<FleetgraphSettings>(fleetgraphSettingsKey);

      // Optimistic flip — UI updates immediately.
      queryClient.setQueryData<FleetgraphSettings>(fleetgraphSettingsKey, {
        sweepEnabled: vars.sweepEnabled,
      });

      return { previous };
    },
    onError: (_err, _vars, context) => {
      // Rollback on failure.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(fleetgraphSettingsKey, context.previous);
      } else {
        queryClient.removeQueries({ queryKey: fleetgraphSettingsKey });
      }
    },
    onSuccess: (data) => {
      // Server is the source of truth.
      queryClient.setQueryData<FleetgraphSettings>(fleetgraphSettingsKey, data);
    },
  });
}

function useSweepNowMutation() {
  const queryClient = useQueryClient();

  return useMutation<SweepResult, Error & { status?: number; code?: string }>({
    mutationFn: sweepNow,
    onSuccess: () => {
      // Sweep may have produced new insights — invalidate every cached
      // list AND count variant so the Insights mode + rail badge refresh.
      queryClient.invalidateQueries({ queryKey: insightKeys.lists() });
      queryClient.invalidateQueries({ queryKey: insightKeys.counts() });
    },
  });
}

// ── Page ───────────────────────────────────────────────────────────────

export function FleetGraphSettingsPage() {
  const { currentWorkspace, isWorkspaceAdmin } = useWorkspace();

  // Hooks must be called unconditionally; the non-admin branch just doesn't
  // render the controls that would fire mutations.
  const settingsQuery = useFleetgraphSettingsQuery();
  const updateMutation = useUpdateFleetgraphSettingsMutation();
  const sweepMutation = useSweepNowMutation();

  const [lastSweep, setLastSweep] = useState<SweepResult | null>(null);

  if (!currentWorkspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted">No workspace selected</div>
      </div>
    );
  }

  const sweepEnabled = settingsQuery.data?.sweepEnabled ?? false;

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isWorkspaceAdmin) return;
    updateMutation.mutate({ sweepEnabled: e.target.checked });
  };

  const handleSweepNow = () => {
    if (!isWorkspaceAdmin) return;
    setLastSweep(null);
    sweepMutation.mutate(undefined, {
      onSuccess: (result) => {
        setLastSweep(result);
      },
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <h1 className="text-lg font-semibold text-foreground">Fleet</h1>
      </header>

      <main className="flex-1 overflow-auto p-6 pb-20">
        <div className="max-w-2xl space-y-4">
          <section className="rounded-lg border border-border bg-background p-5 space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">
                Drift sweep
              </h2>
              <p className="text-sm text-muted">
                Periodic drift detection across projects; produces insights
                you can review in the Insights mode.
              </p>
            </div>

            {settingsQuery.isLoading ? (
              <div className="text-sm text-muted">Loading settings…</div>
            ) : settingsQuery.isError ? (
              <div className="text-sm text-red-500" role="alert">
                Couldn't load settings.
              </div>
            ) : isWorkspaceAdmin ? (
              <>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sweepEnabled}
                    onChange={handleToggle}
                    disabled={updateMutation.isPending}
                    aria-label="Enable scheduled sweep"
                    className="h-4 w-4 rounded border-border text-accent-text focus:ring-accent/50"
                  />
                  <span className="text-sm text-foreground">
                    Enable scheduled sweep
                  </span>
                </label>

                {updateMutation.isError && (
                  <div className="text-sm text-red-500" role="alert">
                    {updateMutation.error?.message ??
                      'Failed to update setting.'}
                  </div>
                )}

                <div className="pt-2 border-t border-border space-y-2">
                  <button
                    type="button"
                    onClick={handleSweepNow}
                    disabled={sweepMutation.isPending}
                    className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {sweepMutation.isPending ? 'Sweeping…' : 'Sweep now'}
                  </button>

                  {sweepMutation.isError && (
                    <div className="text-sm text-red-500" role="alert">
                      {sweepMutation.error?.message ??
                        'Failed to start sweep.'}
                    </div>
                  )}

                  {lastSweep && !sweepMutation.isError && (
                    <div className="text-sm text-muted" role="status">
                      Last manual sweep: {lastSweep.scanned} scanned,{' '}
                      {lastSweep.created} created, {lastSweep.refreshed}{' '}
                      refreshed, {lastSweep.skipped} skipped
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div
                className="text-sm text-muted border-l-2 border-border pl-3"
                role="note"
              >
                Sweep settings are managed by workspace admins.
                {settingsQuery.data && (
                  <span className="ml-1">
                    Scheduled sweep is currently{' '}
                    <span className="text-foreground">
                      {sweepEnabled ? 'on' : 'off'}
                    </span>
                    .
                  </span>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
