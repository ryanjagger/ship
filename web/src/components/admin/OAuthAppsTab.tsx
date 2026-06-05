import { useState, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { api, OAuthAppSummary, OAuthAppSecret, OAuthScope } from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';

const TH = 'px-4 py-3 text-left text-sm font-medium text-muted';
const TD = 'px-4 py-3 text-sm';

interface CreateInput {
  name: string;
  redirect_uris: string[];
  requested_scopes: string[];
  client_type: 'public' | 'confidential';
  allow_device_flow: boolean;
}

/**
 * Super-admin "OAuth Apps" surface (PRD §5.2). Lists registered OAuth clients and
 * lets an admin create one (secret shown once), rotate its secret, or delete it.
 * Rendered as a tab inside the Admin Dashboard — not the 4-panel document editor.
 */
export function OAuthAppsTab() {
  const { showToast } = useToast();
  const [apps, setApps] = useState<OAuthAppSummary[]>([]);
  const [scopes, setScopes] = useState<OAuthScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  // The once-only credentials to reveal (after create or rotate).
  const [revealed, setRevealed] = useState<OAuthAppSecret | null>(null);
  // A pending destructive/sensitive action awaiting confirmation.
  const [pending, setPending] = useState<{ kind: 'rotate' | 'delete'; app: OAuthAppSummary } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [appsRes, scopesRes] = await Promise.all([
      api.admin.listOAuthApps(),
      api.admin.listOAuthScopes(),
    ]);
    if (appsRes.success && appsRes.data) setApps(appsRes.data);
    if (scopesRes.success && scopesRes.data) setScopes(scopesRes.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(input: CreateInput) {
    const res = await api.admin.createOAuthApp(input);
    if (res.success && res.data) {
      setRevealed(res.data);
      setShowCreate(false);
      showToast('OAuth app created', 'success');
      void load();
    } else {
      showToast(res.error?.message ?? 'Failed to create app', 'error', 5000);
    }
  }

  async function confirmAction() {
    if (!pending) return;
    const { kind, app } = pending;
    setPending(null);

    if (kind === 'rotate') {
      const res = await api.admin.rotateOAuthAppSecret(app.id);
      if (res.success && res.data) {
        setRevealed(res.data);
        showToast('Client secret rotated', 'success');
        void load();
      } else {
        showToast(res.error?.message ?? 'Failed to rotate secret', 'error', 5000);
      }
    } else {
      const res = await api.admin.deleteOAuthApp(app.id);
      if (res.success) {
        showToast('OAuth app deleted', 'success');
        void load();
      } else {
        showToast(res.error?.message ?? 'Failed to delete app', 'error', 5000);
      }
    }
  }

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="oauth-apps-tab">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          OAuth clients that can access the public API at <code className="font-mono">/api/v1</code>. The
          browser PKCE flow uses public clients with no secret.
        </p>
        {!showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm text-muted hover:text-foreground transition-colors"
          >
            <PlusIcon />
            New OAuth App
          </button>
        )}
      </div>

      {showCreate && (
        <CreateOAuthAppForm scopes={scopes} onCancel={() => setShowCreate(false)} onCreate={handleCreate} />
      )}

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
                  No OAuth apps registered yet.
                </td>
              </tr>
            ) : (
              apps.map((app) => (
                <tr key={app.id}>
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
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs text-muted break-all">{app.client_id}</code>
                      <CopyButton value={app.client_id} small />
                    </div>
                  </td>
                  <td className={cn(TD, 'text-muted')}>
                    {app.client_type === 'public' ? 'Public PKCE' : 'Confidential'}
                  </td>
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
                        className="inline-flex items-center gap-1.5 text-sm text-muted"
                        title="This client is provisioned and managed by the platform."
                        data-testid="oauth-app-system-managed"
                      >
                        <LockIcon />
                        Managed by platform
                      </span>
                    ) : (
                      <>
                        {app.client_type === 'confidential' && (
                          <button
                            onClick={() => setPending({ kind: 'rotate', app })}
                            className="text-sm text-accent-text hover:underline"
                          >
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

      {revealed && <SecretRevealModal secret={revealed} onClose={() => setRevealed(null)} />}

      {pending && (
        <ConfirmDialog
          open
          title={pending.kind === 'rotate' ? 'Rotate client secret?' : 'Delete OAuth app?'}
          description={
            pending.kind === 'rotate'
              ? `A new secret will be generated for "${pending.app.name}". The current secret stops working immediately. Already-issued access tokens are not affected.`
              : `This permanently deletes "${pending.app.name}" and immediately invalidates every access token issued to it. This cannot be undone.`
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

function CreateOAuthAppForm({
  scopes,
  onCancel,
  onCreate,
}: {
  scopes: OAuthScope[];
  onCancel: () => void;
  onCreate: (input: CreateInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [redirectText, setRedirectText] = useState('');
  const [clientType, setClientType] = useState<'public' | 'confidential'>('public');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [allowDeviceFlow, setAllowDeviceFlow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Split on newlines or commas; trim and drop blanks.
  const redirectUris = redirectText
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  function toggleScope(scope: string) {
    setSelectedScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!allowDeviceFlow && redirectUris.length === 0) {
      setError('At least one redirect URI is required unless device flow is enabled.');
      return;
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

  const inputClass =
    'w-full px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent';

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 bg-border/20 rounded-lg">
      <div>
        <label className="block text-xs font-medium text-muted mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Integration"
          autoFocus
          data-testid="oauth-app-name-input"
          className={inputClass}
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-muted mb-1">Redirect URIs</label>
        <textarea
          value={redirectText}
          onChange={(e) => setRedirectText(e.target.value)}
          placeholder={'https://app.example.com/callback\n(one per line; leave empty for a device-flow client)'}
          rows={3}
          data-testid="oauth-app-redirects-input"
          className={cn(inputClass, 'font-mono')}
        />
      </div>

      <div>
        <div className="text-xs font-medium text-muted mb-2">Client type</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-3 text-sm text-foreground">
            <input
              type="radio"
              name="oauth-client-type"
              value="public"
              checked={clientType === 'public'}
              onChange={() => setClientType('public')}
              data-testid="oauth-client-type-public"
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
              name="oauth-client-type"
              value="confidential"
              checked={clientType === 'confidential'}
              onChange={() => setClientType('confidential')}
              data-testid="oauth-client-type-confidential"
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
        <input
          type="checkbox"
          checked={allowDeviceFlow}
          onChange={(e) => setAllowDeviceFlow(e.target.checked)}
          data-testid="oauth-app-device-flow"
          className="rounded border-border"
        />
        Allow Device Authorization Grant (RFC 8628) — for CLI / headless clients
      </label>

      <div>
        <div className="text-xs font-medium text-muted mb-2">Scopes</div>
        <div className="space-y-2">
          {scopes.map((s) => (
            <label key={s.scope} className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={selectedScopes.includes(s.scope)}
                onChange={() => toggleScope(s.scope)}
                data-testid={`oauth-scope-${s.scope}`}
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
        <button
          type="submit"
          disabled={submitting}
          data-testid="oauth-app-create-submit"
          className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Creating...' : 'Create app'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-muted hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function SecretRevealModal({ secret, onClose }: { secret: OAuthAppSecret; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        <Dialog.Content
          data-testid="oauth-secret-modal"
          className="fixed left-1/2 top-1/2 z-[101] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none"
        >
          <Dialog.Title className="text-lg font-semibold text-foreground">
            Credentials for “{secret.name}”
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-yellow-500">{secret.warning}</Dialog.Description>

          <div className="mt-4 space-y-3">
            <CredentialRow label="Client ID" value={secret.client_id} valueTestId="oauth-client-id-value" />
            {secret.client_secret && (
              <CredentialRow label="Client secret" value={secret.client_secret} valueTestId="oauth-secret-value" />
            )}
          </div>

          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background"
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CredentialRow({ label, value, valueTestId }: { label: string; value: string; valueTestId?: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code
          data-testid={valueTestId}
          className="flex-1 px-3 py-2 bg-border/30 rounded-md text-sm text-foreground break-all font-mono"
        >
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function CopyButton({ value, small }: { value: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={cn(
        'shrink-0 rounded-md transition-colors',
        small ? 'px-2 py-0.5 text-xs' : 'px-3 py-2 text-sm',
        copied ? 'bg-green-500/20 text-green-400' : 'bg-border/50 text-foreground hover:bg-border'
      )}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 0h10.5a.75.75 0 0 1 .75.75v8.25a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75v-8.25a.75.75 0 0 1 .75-.75Z"
      />
    </svg>
  );
}
