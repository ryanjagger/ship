import { useState, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { api, type OAuthAppListScope } from '@/lib/api';
import type {
  ShipOAuthApp,
  CreatedOAuthApp,
  ShipScope,
  ShipConnection,
  ShipWebhookSubscription,
  CreatedWebhookSubscription,
  ShipWebhookDelivery,
  ShipWebhookDeliveryDetail,
  PublicApiAuditEntry,
} from '@ryanjagger/ship-sdk';
import { usePortalClient } from '@/hooks/usePortalClient';
import { sdkErrorMessage } from '@/lib/portal-client';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';

const TH = 'px-4 py-3 text-left text-sm font-medium text-muted';
const TD = 'px-4 py-3 text-sm';
const INPUT =
  'w-full px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent';

/** One-time secret copy (the public API returns secrets only on create/rotate). */
const SECRET_WARNING = 'Save this secret now. It will not be shown again.';
/** The portal's own system client — its API traffic is hidden from the audit tab by default. */
const PORTAL_CLIENT_ID = 'client_ship_developer_portal';

/** What the secret-reveal modal needs; satisfied by both SDK and legacy lens responses. */
interface RevealedAppSecret {
  name: string;
  client_id: string;
  client_secret?: string;
  warning: string;
}

type TabKey = 'apps' | 'connections' | 'webhooks' | 'deliveries' | 'audit';
const VALID_TABS: TabKey[] = ['apps', 'connections', 'webhooks', 'deliveries', 'audit'];

/**
 * Developer portal (PRD §8). Self-service management of OAuth apps, webhook
 * subscriptions, the delivery log (with replay), and the public API audit
 * trail. Most views are workspace-scoped; super admins can use the Apps tab's
 * all-apps lens for global OAuth client management.
 */
export function DeveloperPortalPage() {
  const { isSuperAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as TabKey | null;
  const tab: TabKey = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'apps';
  const appScope: OAuthAppListScope = isSuperAdmin && searchParams.get('scope') === 'all' ? 'all' : 'workspace';

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'apps', label: 'Apps' },
    { key: 'connections', label: 'Connections' },
    { key: 'webhooks', label: 'Webhooks' },
    { key: 'deliveries', label: 'Delivery log' },
    { key: 'audit', label: 'API audit' },
  ];

  const updateQuery = useCallback((updates: { tab?: TabKey; scope?: OAuthAppListScope }) => {
    const next = new URLSearchParams(searchParams);
    if (updates.tab) next.set('tab', updates.tab);
    if (updates.scope) next.set('scope', updates.scope);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!isSuperAdmin && searchParams.get('scope') === 'all') {
      const next = new URLSearchParams(searchParams);
      next.set('scope', 'workspace');
      setSearchParams(next, { replace: true });
    }
  }, [isSuperAdmin, searchParams, setSearchParams]);

  return (
    <div className="flex flex-col h-full overflow-auto" data-testid="developer-portal">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold text-foreground m-0">Developer</h1>
        <p className="mt-1 text-sm text-muted">
          Manage OAuth apps, webhooks, and observe your workspace's public API usage.
        </p>
      </header>

      <div className="flex gap-1 border-b border-border px-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            data-testid={`dev-tab-${t.key}`}
            onClick={() => updateQuery({ tab: t.key })}
            className={cn(
              'px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors',
              tab === t.key ? 'border-accent text-foreground' : 'border-transparent text-muted hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-6">
        {tab === 'apps' && (
          <AppsTab
            appScope={appScope}
            isSuperAdmin={isSuperAdmin}
            onScopeChange={(scope) => updateQuery({ scope, tab: 'apps' })}
          />
        )}
        {tab === 'connections' && <ConnectionsTab />}
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'deliveries' && <DeliveriesTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}

// ── Apps ─────────────────────────────────────────────────────────────────────

interface CreateAppInput {
  name: string;
  redirect_uris: string[];
  requested_scopes: string[];
  client_type: 'public' | 'confidential';
  allow_device_flow: boolean;
}

function AppsTab({
  appScope,
  isSuperAdmin,
  onScopeChange,
}: {
  appScope: OAuthAppListScope;
  isSuperAdmin: boolean;
  onScopeChange: (scope: OAuthAppListScope) => void;
}) {
  const { showToast } = useToast();
  const withClient = usePortalClient();
  const [apps, setApps] = useState<ShipOAuthApp[]>([]);
  const [scopes, setScopes] = useState<ShipScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [revealed, setRevealed] = useState<RevealedAppSecret | null>(null);
  const [pending, setPending] = useState<{ kind: 'rotate' | 'delete'; app: ShipOAuthApp } | null>(null);

  // Workspace lens goes through the SDK (the portal is a public-API client);
  // the super-admin all-apps lens is cross-workspace and stays on the slim
  // internal route. The scope catalog always comes from the SDK.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (appScope === 'all') {
        const [appsRes, scopesList] = await Promise.all([
          api.developer.listAllApps(),
          withClient((c) => c.scopes.list()),
        ]);
        if (appsRes.success && appsRes.data) setApps(appsRes.data);
        else throw new Error(appsRes.error?.message ?? 'Failed to load apps');
        setScopes(scopesList.data);
      } else {
        const [appsList, scopesList] = await withClient((c) => Promise.all([c.apps.list(), c.scopes.list()]));
        setApps(appsList.data);
        setScopes(scopesList.data);
      }
    } catch (err) {
      setError(sdkErrorMessage(err, 'Failed to load apps'));
    }
    setLoading(false);
  }, [appScope, withClient]);

  useEffect(() => {
    void load();
  }, [load]);

  // Creation always goes through the SDK: a created app is owned by the caller,
  // so it shows up in both lenses.
  async function handleCreate(input: CreateAppInput) {
    try {
      const created = await withClient((c) => c.apps.create(input));
      setRevealed(created);
      setShowCreate(false);
      showToast('OAuth app created', 'success');
      void load();
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to create app'), 'error', 5000);
    }
  }

  async function confirmAction() {
    if (!pending) return;
    const { kind, app } = pending;
    setPending(null);
    if (kind === 'rotate') {
      try {
        let rotated: RevealedAppSecret;
        if (appScope === 'all') {
          const res = await api.developer.rotateAppSecretAll(app.id);
          if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Failed to rotate secret');
          rotated = res.data;
        } else {
          rotated = await withClient((c) => c.apps.rotateSecret(app.id));
        }
        setRevealed(rotated);
        showToast('Client secret rotated', 'success');
        void load();
      } catch (err) {
        showToast(sdkErrorMessage(err, 'Failed to rotate secret'), 'error', 5000);
      }
    } else {
      try {
        if (appScope === 'all') {
          const res = await api.developer.deleteAppAll(app.id);
          if (!res.success) throw new Error(res.error?.message ?? 'Failed to delete app');
        } else {
          await withClient((c) => c.apps.delete(app.id));
        }
        showToast('OAuth app deleted', 'success');
        void load();
      } catch (err) {
        showToast(sdkErrorMessage(err, 'Failed to delete app'), 'error', 5000);
      }
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4" data-testid="dev-apps">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          OAuth clients that access the public API at <code className="font-mono">/api/v1</code>. Browser
          apps use public PKCE clients with no secret.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {isSuperAdmin && (
            <div className="flex overflow-hidden rounded-md border border-border" data-testid="dev-app-scope-toggle">
              <button
                type="button"
                onClick={() => onScopeChange('workspace')}
                data-testid="dev-app-scope-workspace"
                className={cn(
                  'px-3 py-1.5 text-sm transition-colors',
                  appScope === 'workspace'
                    ? 'bg-accent text-white'
                    : 'text-muted hover:bg-border/40 hover:text-foreground'
                )}
              >
                Workspace apps
              </button>
              <button
                type="button"
                onClick={() => onScopeChange('all')}
                data-testid="dev-app-scope-all"
                className={cn(
                  'border-l border-border px-3 py-1.5 text-sm transition-colors',
                  appScope === 'all'
                    ? 'bg-accent text-white'
                    : 'text-muted hover:bg-border/40 hover:text-foreground'
                )}
              >
                All apps
              </button>
            </div>
          )}
          {!showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              data-testid="dev-new-app"
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 transition-colors"
            >
              New app
            </button>
          )}
        </div>
      </div>

      {showCreate && <CreateAppForm scopes={scopes} onCancel={() => setShowCreate(false)} onCreate={handleCreate} />}

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-border/30">
            <tr>
              <th className={TH}>Name</th>
              <th className={TH}>Client ID</th>
              <th className={TH}>Type</th>
              <th className={TH}>Scopes</th>
              <th className={TH}>Device flow</th>
              <th className={TH}>Owner</th>
              <th className={TH}>Created</th>
              <th className={cn(TH, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {apps.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted">
                  No apps yet. Create one to start building on the API.
                </td>
              </tr>
            ) : (
              apps.map((app) => (
                <tr key={app.id} data-testid="dev-app-row">
                  <td className={cn(TD, 'font-medium text-foreground')}>
                    <div className="flex items-center gap-2">
                      {app.name}
                      {app.is_system && (
                        <span className="rounded bg-border/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                          System
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={TD}>
                    <code className="font-mono text-xs text-muted break-all">{app.client_id}</code>
                  </td>
                  <td className={cn(TD, 'text-muted')}>{app.client_type === 'public' ? 'Public PKCE' : 'Confidential'}</td>
                  <td className={cn(TD, 'text-muted')}>
                    {app.requested_scopes.length ? app.requested_scopes.join(', ') : '—'}
                  </td>
                  <td className={TD}>
                    {app.allow_device_flow ? (
                      <span className="text-green-500">Enabled</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={cn(TD, 'text-muted')}>{app.owner_email ?? '—'}</td>
                  <td className={cn(TD, 'text-muted whitespace-nowrap')}>
                    {new Date(app.created_at).toLocaleDateString()}
                  </td>
                  <td className={cn(TD, 'text-right whitespace-nowrap')}>
                    {app.is_system ? (
                      <span
                        className="text-sm text-muted"
                        title="This client is provisioned and managed by the platform."
                        data-testid="dev-app-system-managed"
                      >
                        Managed by platform
                      </span>
                    ) : (
                      <>
                        {app.client_type === 'confidential' && (
                          <button onClick={() => setPending({ kind: 'rotate', app })} className="text-sm text-accent-text hover:underline">
                            Rotate secret
                          </button>
                        )}
                        <button
                          onClick={() => setPending({ kind: 'delete', app })}
                          className={cn(
                            'text-sm text-red-500 hover:text-red-400 transition-colors',
                            app.client_type === 'confidential' && 'ml-4'
                          )}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {revealed && (
        <SecretRevealModal
          title={`Credentials for "${revealed.name}"`}
          warning={revealed.warning}
          rows={[
            { label: 'Client ID', value: revealed.client_id, testId: 'dev-client-id-value' },
            ...(revealed.client_secret
              ? [{ label: 'Client secret', value: revealed.client_secret, testId: 'dev-secret-value' }]
              : []),
          ]}
          onClose={() => setRevealed(null)}
        />
      )}

      {pending && (
        <ConfirmDialog
          open
          title={pending.kind === 'rotate' ? 'Rotate client secret?' : 'Delete OAuth app?'}
          description={
            pending.kind === 'rotate'
              ? `A new secret will be generated for "${pending.app.name}". The current secret stops working immediately.`
              : `This permanently deletes "${pending.app.name}" and invalidates every token issued to it. This cannot be undone.`
          }
          confirmLabel={pending.kind === 'rotate' ? 'Rotate secret' : 'Delete'}
          variant={pending.kind === 'delete' ? 'destructive' : 'default'}
          onConfirm={confirmAction}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function CreateAppForm({
  scopes,
  onCancel,
  onCreate,
}: {
  scopes: ShipScope[];
  onCancel: () => void;
  onCreate: (input: CreateAppInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [redirectText, setRedirectText] = useState('');
  const [clientType, setClientType] = useState<'public' | 'confidential'>('public');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [allowDeviceFlow, setAllowDeviceFlow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectUris = redirectText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Name is required.');
    if (!allowDeviceFlow && redirectUris.length === 0) {
      return setError('At least one redirect URI is required unless device flow is enabled.');
    }
    setSubmitting(true);
    await onCreate({
      name: name.trim(),
      redirect_uris: redirectUris,
      requested_scopes: selectedScopes,
      client_type: clientType,
      allow_device_flow: allowDeviceFlow,
    });
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-border/20 rounded-lg">
      <div>
        <label className="block text-xs font-medium text-muted mb-1">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Integration" autoFocus data-testid="dev-app-name-input" className={INPUT} />
      </div>
      <div>
        <label className="block text-xs font-medium text-muted mb-1">Redirect URIs</label>
        <textarea
          value={redirectText}
          onChange={(e) => setRedirectText(e.target.value)}
          placeholder={'https://app.example.com/callback\n(one per line; leave empty for a device-flow client)'}
          rows={3}
          data-testid="dev-app-redirects-input"
          className={cn(INPUT, 'font-mono')}
        />
      </div>
      <div>
        <div className="text-xs font-medium text-muted mb-2">Client type</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-3 text-sm text-foreground">
            <input
              type="radio"
              name="dev-client-type"
              value="public"
              checked={clientType === 'public'}
              onChange={() => setClientType('public')}
              data-testid="dev-client-type-public"
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">Public PKCE</span>
              <span className="block text-xs text-muted">Browser apps. No client secret.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-3 text-sm text-foreground">
            <input
              type="radio"
              name="dev-client-type"
              value="confidential"
              checked={clientType === 'confidential'}
              onChange={() => setClientType('confidential')}
              data-testid="dev-client-type-confidential"
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">Confidential</span>
              <span className="block text-xs text-muted">Backend apps. Secret shown once.</span>
            </span>
          </label>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={allowDeviceFlow} onChange={(e) => setAllowDeviceFlow(e.target.checked)} data-testid="dev-app-device-flow" className="rounded border-border" />
        Allow Device Authorization Grant (CLI / headless clients)
      </label>
      <div>
        <div className="text-xs font-medium text-muted mb-2">Scopes</div>
        <div className="space-y-2">
          {scopes.map((s) => (
            <label key={s.scope} className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={selectedScopes.includes(s.scope)}
                onChange={() => setSelectedScopes((p) => (p.includes(s.scope) ? p.filter((x) => x !== s.scope) : [...p, s.scope]))}
                data-testid={`dev-scope-${s.scope}`}
                className="mt-0.5 rounded border-border"
              />
              <span>
                <code className="font-mono">{s.scope}</code>
                <span className="text-muted"> — {s.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} data-testid="dev-app-create-submit" className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 disabled:opacity-50 transition-colors">
          {submitting ? 'Creating...' : 'Create app'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-muted hover:text-foreground transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Connections (apps with live access tokens) ───────────────────────────────

/**
 * Apps that currently hold live access tokens in the workspace — the result of
 * a user authorizing a CLI/SDK client via the device or auth-code flow. There's
 * no standing "grant" record (tokens are short-lived, no refresh), so this lists
 * active tokens grouped by (app, user). Revoking kills every live token for that
 * pair immediately.
 */
function ConnectionsTab() {
  const { showToast } = useToast();
  const withClient = usePortalClient();
  const [connections, setConnections] = useState<ShipConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ShipConnection | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await withClient((c) => c.connections.list());
      setConnections(res.data);
    } catch (err) {
      setError(sdkErrorMessage(err, 'Failed to load connections'));
    }
    setLoading(false);
  }, [withClient]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmRevoke() {
    if (!pending) return;
    const conn = pending;
    setPending(null);
    try {
      await withClient((c) => c.connections.revoke(conn.app_id, conn.user_id));
      showToast('Connection revoked', 'success');
      void load();
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to revoke connection'), 'error', 5000);
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4" data-testid="dev-connections">
      <p className="text-sm text-muted">
        Apps that currently hold a live access token in this workspace — granted when a member authorizes a
        CLI or SDK client. Tokens are short-lived; a connection disappears once its tokens expire. Revoke to
        cut off access immediately.
      </p>

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-border/30">
            <tr>
              <th className={TH}>App</th>
              <th className={TH}>Authorized by</th>
              <th className={TH}>Scopes</th>
              <th className={TH}>Last used</th>
              <th className={TH}>Expires</th>
              <th className={cn(TH, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {connections.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                  No connected apps. When a member authorizes a CLI or SDK client, it appears here while its
                  token is live.
                </td>
              </tr>
            ) : (
              connections.map((conn) => (
                <tr key={`${conn.app_id}:${conn.user_id}`} data-testid="dev-connection-row">
                  <td className={cn(TD, 'font-medium text-foreground')}>
                    <div className="flex items-center gap-2">
                      {conn.app_name}
                      {conn.is_system && (
                        <span className="rounded bg-border/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                          System
                        </span>
                      )}
                    </div>
                    <code className="font-mono text-xs text-muted break-all">{conn.client_id}</code>
                  </td>
                  <td className={cn(TD, 'text-muted')}>{conn.user_email}</td>
                  <td className={cn(TD, 'text-muted')}>
                    {conn.scopes.length ? conn.scopes.join(', ') : '—'}
                  </td>
                  <td className={cn(TD, 'text-muted whitespace-nowrap')}>
                    {conn.last_used_at ? new Date(conn.last_used_at).toLocaleString() : 'Never'}
                  </td>
                  <td className={cn(TD, 'text-muted whitespace-nowrap')}>
                    {new Date(conn.expires_at).toLocaleString()}
                  </td>
                  <td className={cn(TD, 'text-right whitespace-nowrap')}>
                    <button
                      onClick={() => setPending(conn)}
                      data-testid="dev-revoke-connection"
                      className="text-sm text-red-500 hover:text-red-400 transition-colors"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pending && (
        <ConfirmDialog
          open
          title="Revoke connection?"
          description={`Immediately revoke ${pending.user_email}'s "${pending.app_name}" access (${pending.active_token_count} live token${pending.active_token_count === 1 ? '' : 's'}). The app must be re-authorized to regain access.`}
          confirmLabel="Revoke"
          variant="destructive"
          onConfirm={confirmRevoke}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

// ── App picker (shared by Webhooks + Deliveries) ─────────────────────────────

function useApps() {
  const withClient = usePortalClient();
  const [apps, setApps] = useState<ShipOAuthApp[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const res = await withClient((c) => c.apps.list());
        setApps(res.data);
      } catch {
        // The picker just renders empty; tab-level actions surface their own errors.
      }
      setLoading(false);
    })();
  }, [withClient]);
  return { apps, loading };
}

function AppPicker({ apps, value, onChange }: { apps: ShipOAuthApp[]; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid="dev-app-picker" className={cn(INPUT, 'max-w-sm')}>
      <option value="">Select an app…</option>
      {apps.map((a) => (
        <option key={a.id} value={a.id}>
          {a.is_system ? `${a.name} (system)` : a.name}
        </option>
      ))}
    </select>
  );
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

function WebhooksTab() {
  const { showToast } = useToast();
  const withClient = usePortalClient();
  const { apps, loading: appsLoading } = useApps();
  const [appId, setAppId] = useState('');
  const [subs, setSubs] = useState<ShipWebhookSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [revealed, setRevealed] = useState<CreatedWebhookSubscription | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ShipWebhookSubscription | null>(null);

  const load = useCallback(async (id: string) => {
    if (!id) return setSubs([]);
    setLoading(true);
    try {
      const res = await withClient((c) => c.apps.webhooks.list(id));
      setSubs(res.data);
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to load subscriptions'), 'error', 5000);
    }
    setLoading(false);
  }, [withClient, showToast]);

  useEffect(() => {
    void load(appId);
  }, [appId, load]);

  async function handleCreate(input: { url: string; events: string[] }) {
    try {
      const created = await withClient((c) => c.apps.webhooks.create(appId, input));
      setRevealed(created);
      setShowCreate(false);
      showToast('Subscription created', 'success');
      void load(appId);
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to create subscription'), 'error', 5000);
    }
  }

  async function toggleActive(sub: ShipWebhookSubscription) {
    try {
      await withClient((c) => c.apps.webhooks.update(appId, sub.id, { active: !sub.active }));
      void load(appId);
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to update subscription'), 'error', 5000);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const sub = pendingDelete;
    setPendingDelete(null);
    try {
      await withClient((c) => c.apps.webhooks.delete(appId, sub.id));
      showToast('Subscription deleted', 'success');
      void load(appId);
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to delete subscription'), 'error', 5000);
    }
  }

  if (appsLoading) return <Loading />;

  return (
    <div className="space-y-4" data-testid="dev-webhooks">
      <div className="flex items-center justify-between gap-4">
        <AppPicker apps={apps} value={appId} onChange={setAppId} />
        {appId && !showCreate && (
          <button onClick={() => setShowCreate(true)} data-testid="dev-new-subscription" className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 transition-colors">
            New subscription
          </button>
        )}
      </div>

      {!appId ? (
        <EmptyState message="Select an app to manage its webhook subscriptions." />
      ) : showCreate ? (
        <CreateSubscriptionForm onCancel={() => setShowCreate(false)} onCreate={handleCreate} />
      ) : loading ? (
        <Loading />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-border/30">
              <tr>
                <th className={TH}>URL</th>
                <th className={TH}>Events</th>
                <th className={TH}>Status</th>
                <th className={cn(TH, 'text-right')}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {subs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted">
                    No subscriptions for this app yet.
                  </td>
                </tr>
              ) : (
                subs.map((sub) => (
                  <tr key={sub.id} data-testid="dev-subscription-row">
                    <td className={cn(TD, 'font-mono text-xs break-all')}>{sub.url}</td>
                    <td className={cn(TD, 'text-muted')}>{sub.events.join(', ')}</td>
                    <td className={TD}>
                      {sub.active ? <span className="text-green-500">Active</span> : <span className="text-muted">Inactive</span>}
                    </td>
                    <td className={cn(TD, 'text-right whitespace-nowrap')}>
                      <button onClick={() => void toggleActive(sub)} className="text-sm text-accent-text hover:underline">
                        {sub.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => setPendingDelete(sub)} className="ml-4 text-sm text-red-500 hover:text-red-400 transition-colors">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {revealed && (
        <SecretRevealModal
          title="Webhook signing secret"
          warning={SECRET_WARNING}
          rows={[{ label: 'Signing secret', value: revealed.secret, testId: 'dev-sub-secret-value' }]}
          onClose={() => setRevealed(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          open
          title="Delete subscription?"
          description={`Stop delivering events to ${pendingDelete.url}. This cannot be undone.`}
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function CreateSubscriptionForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (i: { url: string; events: string[] }) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [eventsText, setEventsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const events = eventsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!url.trim()) return setError('URL is required.');
    if (events.length === 0) return setError('At least one event type is required.');
    setSubmitting(true);
    await onCreate({ url: url.trim(), events });
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-border/20 rounded-lg">
      <div>
        <label className="block text-xs font-medium text-muted mb-1">Target URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/ship" autoFocus data-testid="dev-sub-url-input" className={cn(INPUT, 'font-mono')} />
      </div>
      <div>
        <label className="block text-xs font-medium text-muted mb-1">Event types</label>
        <textarea
          value={eventsText}
          onChange={(e) => setEventsText(e.target.value)}
          placeholder={'issue.created, issue.updated\n(comma or newline separated)'}
          rows={2}
          data-testid="dev-sub-events-input"
          className={cn(INPUT, 'font-mono')}
        />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} data-testid="dev-sub-create-submit" className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 disabled:opacity-50 transition-colors">
          {submitting ? 'Creating...' : 'Create subscription'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-muted hover:text-foreground transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Delivery log ──────────────────────────────────────────────────────────────

const DELIVERY_STATUS_COLOR: Record<string, string> = {
  delivered: 'text-green-500',
  pending: 'text-yellow-500',
  failed: 'text-red-500',
  dead_lettered: 'text-red-500',
  replayed: 'text-muted',
};

// Delivered rows are replayable too (e.g. to test a consumer's idempotency
// handling) — the replay reuses the original event, so the idempotency key
// is identical and the source keeps its `delivered` status.
const REPLAYABLE_STATUSES: ReadonlySet<string> = new Set(['delivered', 'failed', 'dead_lettered']);

function DeliveriesTab() {
  const { showToast } = useToast();
  const withClient = usePortalClient();
  const { apps, loading: appsLoading } = useApps();
  const [appId, setAppId] = useState('');
  const [deliveries, setDeliveries] = useState<ShipWebhookDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [detail, setDetail] = useState<ShipWebhookDeliveryDetail | null>(null);

  const load = useCallback(async (id: string, status: string) => {
    if (!id) return setDeliveries([]);
    setLoading(true);
    try {
      const res = await withClient((c) =>
        c.apps.deliveries.list(id, status ? { status: status as ShipWebhookDelivery['status'] } : {})
      );
      setDeliveries(res.data);
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to load deliveries'), 'error', 5000);
    }
    setLoading(false);
  }, [withClient, showToast]);

  useEffect(() => {
    void load(appId, statusFilter);
  }, [appId, statusFilter, load]);

  async function openDetail(id: string) {
    try {
      setDetail(await withClient((c) => c.apps.deliveries.get(appId, id)));
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to load delivery'), 'error', 5000);
    }
  }

  async function replay(id: string) {
    try {
      const res = await withClient((c) => c.apps.deliveries.replay(appId, id));
      showToast(`Replayed — new delivery ${res.delivery_id.slice(0, 8)}…`, 'success');
      void load(appId, statusFilter);
    } catch (err) {
      showToast(sdkErrorMessage(err, 'Failed to replay delivery'), 'error', 5000);
    }
  }

  if (appsLoading) return <Loading />;

  return (
    <div className="space-y-4" data-testid="dev-deliveries">
      <div className="flex items-center gap-3">
        <AppPicker apps={apps} value={appId} onChange={setAppId} />
        {appId && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} data-testid="dev-delivery-status-filter" className={cn(INPUT, 'max-w-[180px]')}>
            <option value="">All statuses</option>
            <option value="delivered">Delivered</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="dead_lettered">Dead-lettered</option>
            <option value="replayed">Replayed</option>
          </select>
        )}
      </div>

      {!appId ? (
        <EmptyState message="Select an app to browse its delivery log." />
      ) : loading ? (
        <Loading />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-border/30">
              <tr>
                <th className={TH}>Event</th>
                <th className={TH}>Status</th>
                <th className={TH}>Attempts</th>
                <th className={TH}>Last response</th>
                <th className={cn(TH, 'text-right')}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                    No deliveries match.
                  </td>
                </tr>
              ) : (
                deliveries.map((d) => (
                  <tr key={d.id} data-testid="dev-delivery-row">
                    <td className={cn(TD, 'font-mono text-xs')}>{d.event_type}</td>
                    <td className={cn(TD, DELIVERY_STATUS_COLOR[d.status] ?? '')}>{d.status}</td>
                    <td className={cn(TD, 'text-muted')}>{d.attempt_count}</td>
                    <td className={cn(TD, 'text-muted')}>{d.last_response_status ?? d.last_error ?? '—'}</td>
                    <td className={cn(TD, 'text-right whitespace-nowrap')}>
                      <button onClick={() => void openDetail(d.id)} className="text-sm text-accent-text hover:underline">
                        Details
                      </button>
                      {REPLAYABLE_STATUSES.has(d.status) && (
                        <button
                          onClick={() => void replay(d.id)}
                          data-testid={`dev-replay-${d.id}`}
                          className="ml-4 text-sm text-accent-text hover:underline"
                        >
                          Replay
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail && <DeliveryDetailModal detail={detail} onClose={() => setDetail(null)} onReplay={() => void replay(detail.id)} />}
    </div>
  );
}

function DeliveryDetailModal({ detail, onClose, onReplay }: { detail: ShipWebhookDeliveryDetail; onClose: () => void; onReplay: () => void }) {
  const canReplay = REPLAYABLE_STATUSES.has(detail.status);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content data-testid="dev-delivery-detail" className="fixed left-1/2 top-1/2 z-[101] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none max-h-[80vh] overflow-auto">
          <Dialog.Title className="text-lg font-semibold text-foreground">
            Delivery {detail.event_type}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Status <span className={DELIVERY_STATUS_COLOR[detail.status]}>{detail.status}</span>
            {detail.replay_of_delivery_id && <> · replay of {detail.replay_of_delivery_id.slice(0, 8)}…</>}
          </Dialog.Description>

          <h3 className="mt-4 mb-2 text-sm font-medium text-foreground">Attempt history</h3>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-border/30">
                <tr>
                  <th className={TH}>#</th>
                  <th className={TH}>Response</th>
                  <th className={TH}>Latency</th>
                  <th className={TH}>Error / excerpt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.attempts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted">No attempts recorded yet.</td>
                  </tr>
                ) : (
                  detail.attempts.map((a) => (
                    <tr key={a.id}>
                      <td className={TD}>{a.attempt_number}</td>
                      <td className={cn(TD, 'text-muted')}>{a.response_status ?? '—'}</td>
                      <td className={cn(TD, 'text-muted')}>{a.duration_ms != null ? `${a.duration_ms}ms` : '—'}</td>
                      <td className={cn(TD, 'text-muted break-all')}>{a.error ?? a.response_body_excerpt ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            {canReplay && (
              <button onClick={() => { onReplay(); onClose(); }} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90">
                Replay delivery
              </button>
            )}
            <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-border/50">
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── API audit ─────────────────────────────────────────────────────────────────

function AuditTab() {
  const withClient = usePortalClient();
  const [rows, setRows] = useState<PublicApiAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusClass, setStatusClass] = useState('');
  // The portal's own SDK calls are recorded like any client's; hide them by
  // default so this view isn't a feedback loop of its own polling.
  const [includePortal, setIncludePortal] = useState(false);

  const load = useCallback(async (sc: string, withPortal: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await withClient((c) =>
        c.audit.list({
          ...(sc ? { status_class: Number(sc) as 2 | 4 | 5 } : {}),
          ...(withPortal ? {} : { exclude_client_id: PORTAL_CLIENT_ID }),
        })
      );
      setRows(res.data);
      setTotal(res.total);
    } catch (err) {
      setError(sdkErrorMessage(err, 'Failed to load audit log'));
    }
    setLoading(false);
  }, [withClient]);

  useEffect(() => {
    void load(statusClass, includePortal);
  }, [statusClass, includePortal, load]);

  return (
    <div className="space-y-4" data-testid="dev-audit">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Authenticated requests to your workspace's public API ({total} total).</p>
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted whitespace-nowrap">
            <input
              type="checkbox"
              checked={includePortal}
              onChange={(e) => setIncludePortal(e.target.checked)}
              data-testid="dev-audit-include-portal"
              className="rounded border-border"
            />
            Include Developer Portal traffic
          </label>
          <select value={statusClass} onChange={(e) => setStatusClass(e.target.value)} data-testid="dev-audit-status-filter" className={cn(INPUT, 'max-w-[160px]')}>
            <option value="">All statuses</option>
            <option value="2">2xx success</option>
            <option value="4">4xx client error</option>
            <option value="5">5xx server error</option>
          </select>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(statusClass, includePortal)} />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-border/30">
              <tr>
                <th className={TH}>Time</th>
                <th className={TH}>Method</th>
                <th className={TH}>Route</th>
                <th className={TH}>Scope</th>
                <th className={TH}>Status</th>
                <th className={TH}>Latency</th>
                <th className={TH}>Request ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">No API calls recorded yet.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} data-testid="dev-audit-row">
                    <td className={cn(TD, 'text-muted whitespace-nowrap')}>{new Date(r.created_at).toLocaleString()}</td>
                    <td className={cn(TD, 'font-mono text-xs')}>{r.method}</td>
                    <td className={cn(TD, 'font-mono text-xs break-all')}>{r.route}</td>
                    <td className={cn(TD, 'text-muted')}>{r.scope ?? '—'}</td>
                    <td className={cn(TD, r.status >= 500 ? 'text-red-500' : r.status >= 400 ? 'text-yellow-500' : 'text-green-500')}>{r.status}</td>
                    <td className={cn(TD, 'text-muted')}>{r.latency_ms}ms</td>
                    <td className={cn(TD, 'font-mono text-xs text-muted break-all')}>{r.request_id ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────────

function Loading() {
  return (
    <div className="flex h-32 items-center justify-center" data-testid="dev-loading">
      <div className="text-muted">Loading…</div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted">{message}</div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-6 text-center" data-testid="dev-error">
      <p className="text-sm text-red-500">{message}</p>
      <button onClick={onRetry} className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-border/50">
        Retry
      </button>
    </div>
  );
}

function SecretRevealModal({
  title,
  warning,
  rows,
  onClose,
}: {
  title: string;
  warning: string;
  rows: Array<{ label: string; value: string; testId?: string }>;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content data-testid="dev-secret-modal" className="fixed left-1/2 top-1/2 z-[101] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-foreground">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-yellow-500">{warning}</Dialog.Description>
          <div className="mt-4 space-y-3">
            {rows.map((r) => (
              <div key={r.label}>
                <div className="text-xs font-medium text-muted mb-1">{r.label}</div>
                <div className="flex items-center gap-2">
                  <code data-testid={r.testId} className="flex-1 px-3 py-2 bg-border/30 rounded-md text-sm text-foreground break-all font-mono">
                    {r.value}
                  </code>
                  <CopyButton value={r.value} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end">
            <button onClick={onClose} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90">
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={cn('shrink-0 rounded-md px-3 py-2 text-sm transition-colors', copied ? 'bg-green-500/20 text-green-400' : 'bg-border/50 text-foreground hover:bg-border')}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}
