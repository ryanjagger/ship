import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { apiGet, apiPost } from '@/lib/api';

/**
 * Device Authorization Grant approval screen (RFC 8628 §3.3) — the `/device`
 * page. A signed-in user lands here (typed the URL, or followed
 * verification_uri_complete with `?code=`), confirms the user_code shown on
 * their device, sees the requesting app + scopes, and approves or denies.
 *
 * Mirrors OAuthConsent.tsx: authenticated SPA route, validate-then-confirm,
 * decisions ride Ship's session + CSRF via apiPost.
 */

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'documents:read': 'Read all of your document content',
  'documents:write': 'Create and update documents',
  'issues:read': 'Read issues',
  'issues:write': 'Create and update issues',
  'sprints:read': 'Read sprints',
  'sprints:write': 'Create and update sprints',
  'wiki:read': 'Read wiki pages',
  'wiki:write': 'Create and update wiki pages',
  'webhooks:manage': 'Manage webhook subscriptions',
};

interface ValidateData {
  valid: boolean;
  reason?: string;
  app_name?: string;
  scopes?: string[];
  user_code?: string;
  status?: string;
}

type Screen =
  | { status: 'entering' }
  | { status: 'validating' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; appName: string; scopes: string[]; userCode: string }
  | { status: 'approved' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

export function DeviceVerifyPage() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [code, setCode] = useState(searchParams.get('code') ?? '');
  const [screen, setScreen] = useState<Screen>({ status: 'entering' });
  const [submitting, setSubmitting] = useState<null | 'approve' | 'deny'>(null);

  const validate = useCallback(async (userCode: string) => {
    if (!userCode.trim()) {
      setScreen({ status: 'entering' });
      return;
    }
    setScreen({ status: 'validating' });
    try {
      const res = await apiGet(`/api/oauth/device/validate?user_code=${encodeURIComponent(userCode)}`);
      const body = (await res.json()) as { success: boolean; data?: ValidateData };
      const data = body.data;
      if (!body.success || !data) {
        setScreen({ status: 'error', message: 'Could not validate the code.' });
        return;
      }
      if (!data.valid) {
        setScreen({ status: 'invalid', reason: data.reason ?? 'This code is invalid.' });
        return;
      }
      setScreen({
        status: 'ready',
        appName: data.app_name ?? 'An application',
        scopes: data.scopes ?? [],
        userCode: data.user_code ?? userCode,
      });
    } catch {
      setScreen({ status: 'error', message: 'Could not reach the authorization server.' });
    }
  }, []);

  // Auto-validate when arriving via verification_uri_complete (?code=…).
  useEffect(() => {
    const prefilled = searchParams.get('code');
    if (prefilled) void validate(prefilled);
  }, [searchParams, validate]);

  async function submitDecision(decision: 'approve' | 'deny') {
    if (screen.status !== 'ready') return;
    setSubmitting(decision);
    try {
      const res = await apiPost('/api/oauth/device/decision', { user_code: screen.userCode, decision });
      const body = (await res.json()) as { success: boolean; error?: { message: string } };
      if (body.success) {
        setScreen({ status: decision === 'approve' ? 'approved' : 'denied' });
        return;
      }
      setScreen({ status: 'error', message: body.error?.message ?? 'The authorization server rejected the request.' });
    } catch {
      setScreen({ status: 'error', message: 'Could not submit your decision. Please try again.' });
    } finally {
      setSubmitting(null);
    }
  }

  function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    void validate(code);
  }

  const showEntry = screen.status === 'entering' || screen.status === 'validating' || screen.status === 'invalid';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4" data-testid="device-verify">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">Connect a device</h1>

        {showEntry && (
          <form onSubmit={onSubmitCode} className="mt-4">
            <p className="text-sm text-muted">Enter the code shown on your device to continue.</p>

            {screen.status === 'invalid' && (
              <p className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700" data-testid="device-invalid">
                {screen.reason}
              </p>
            )}

            <label htmlFor="device-code" className="sr-only">
              Device code
            </label>
            <input
              id="device-code"
              data-testid="device-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              autoComplete="one-time-code"
              placeholder="XXXX-XXXX"
              className="mt-3 w-full rounded-md border border-border bg-background px-4 py-2.5 text-center font-mono text-lg uppercase tracking-widest text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />

            <button
              type="submit"
              data-testid="device-continue"
              disabled={screen.status === 'validating' || !code.trim()}
              className="mt-4 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {screen.status === 'validating' ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}

        {screen.status === 'error' && (
          <div className="mt-4" data-testid="device-error">
            <p className="rounded bg-red-50 p-3 text-sm text-red-700">{screen.message}</p>
          </div>
        )}

        {screen.status === 'ready' && (
          <div className="mt-4">
            <p className="text-sm text-foreground">
              <span className="font-medium" data-testid="device-app-name">{screen.appName}</span> wants to access your
              Ship account
              {currentWorkspace ? (
                <>
                  {' '}in workspace <span className="font-medium">{currentWorkspace.name}</span>
                </>
              ) : null}
              {user?.email ? <> as <span className="font-medium">{user.email}</span></> : null}.
            </p>

            <p className="mt-3 text-xs text-muted">
              Confirm the code on your device is <span className="font-mono font-medium text-foreground">{screen.userCode}</span>.
            </p>

            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">This will allow it to:</p>
            <ul className="mt-2 space-y-2" data-testid="device-scopes">
              {screen.scopes.length === 0 && (
                <li className="text-sm text-muted">Sign you in (no additional permissions).</li>
              )}
              {screen.scopes.map((scope) => (
                <li key={scope} className="flex items-start gap-2 text-sm text-foreground" data-scope={scope}>
                  <span aria-hidden className="mt-0.5 text-green-600">✓</span>
                  <span>
                    {SCOPE_DESCRIPTIONS[scope] ?? scope}
                    <code className="ml-1 rounded bg-muted/20 px-1 text-xs text-muted">{scope}</code>
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                data-testid="device-approve"
                disabled={submitting !== null}
                onClick={() => void submitDecision('approve')}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting === 'approve' ? 'Authorizing…' : 'Authorize'}
              </button>
              <button
                type="button"
                data-testid="device-deny"
                disabled={submitting !== null}
                onClick={() => void submitDecision('deny')}
                className="flex-1 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/10 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {screen.status === 'approved' && (
          <div className="mt-4" data-testid="device-success">
            <p className="rounded bg-green-50 p-3 text-sm text-green-700">
              You're all set — return to your terminal. You can close this page.
            </p>
          </div>
        )}

        {screen.status === 'denied' && (
          <div className="mt-4" data-testid="device-denied">
            <p className="rounded bg-muted/10 p-3 text-sm text-foreground">
              Request denied. Nothing was authorized. You can close this page.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
