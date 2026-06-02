import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { apiGet, apiPost } from '@/lib/api';

/**
 * OAuth 2.0 consent screen (PRD §5.3, locked decision #5).
 *
 * A standalone authenticated SPA route at `/oauth/consent`. The browser arrives
 * here from `GET /api/oauth/authorize`, which preserves the original query
 * string. On mount we validate the request server-side (so a bad client_id /
 * redirect_uri shows a friendly error and is NEVER auto-forwarded), then render
 * the requesting app + requested scopes. Approve/Deny POSTs ride Ship's session
 * + CSRF (via apiPost) and the server returns the redirect URL to follow back
 * to the client.
 */

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'documents:read': 'Read all of your document content',
  'documents:write': 'Create and update documents',
  'issues:read': 'Read issues',
  'issues:write': 'Create and update issues',
  'sprints:read': 'Read sprints',
  'sprints:write': 'Create and update sprints',
  'webhooks:manage': 'Manage webhook subscriptions',
};

interface ValidateData {
  valid: boolean;
  reason?: string;
  app_name?: string;
  client_id?: string;
  redirect_uri?: string;
  scopes?: string[];
  state?: string | null;
}

type ScreenState =
  | { status: 'loading' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; appName: string; scopes: string[] }
  | { status: 'error'; message: string };

export function OAuthConsentPage() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [screen, setScreen] = useState<ScreenState>({ status: 'loading' });
  const [submitting, setSubmitting] = useState<null | 'approve' | 'deny'>(null);

  // The full authorization request, passed back to the decision endpoint verbatim.
  const authorizeParams = useMemo(() => {
    const keys = [
      'response_type',
      'client_id',
      'redirect_uri',
      'scope',
      'state',
      'code_challenge',
      'code_challenge_method',
    ] as const;
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = searchParams.get(k);
      if (v !== null) out[k] = v;
    }
    return out;
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams(authorizeParams).toString();
        const res = await apiGet(`/api/oauth/authorize/validate?${qs}`);
        const body = (await res.json()) as { success: boolean; data?: ValidateData };
        if (cancelled) return;
        const data = body.data;
        if (!body.success || !data) {
          setScreen({ status: 'error', message: 'Could not validate the authorization request.' });
          return;
        }
        if (!data.valid) {
          setScreen({ status: 'invalid', reason: data.reason ?? 'This authorization request is invalid.' });
          return;
        }
        setScreen({ status: 'ready', appName: data.app_name ?? data.client_id ?? 'An application', scopes: data.scopes ?? [] });
      } catch {
        if (!cancelled) setScreen({ status: 'error', message: 'Could not reach the authorization server.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizeParams]);

  async function submitDecision(decision: 'approve' | 'deny') {
    setSubmitting(decision);
    try {
      const res = await apiPost('/api/oauth/authorize/decision', { ...authorizeParams, decision });
      const body = (await res.json()) as { success: boolean; data?: { redirect_to: string }; error?: { message: string } };
      if (body.success && body.data?.redirect_to) {
        window.location.href = body.data.redirect_to;
        return;
      }
      setScreen({ status: 'error', message: body.error?.message ?? 'The authorization server rejected the request.' });
    } catch {
      setScreen({ status: 'error', message: 'Could not submit your decision. Please try again.' });
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4" data-testid="oauth-consent">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">Authorize application</h1>

        {screen.status === 'loading' && (
          <p className="mt-4 text-sm text-muted">Checking the request…</p>
        )}

        {screen.status === 'invalid' && (
          <div className="mt-4" data-testid="oauth-invalid">
            <p className="text-sm text-foreground">This authorization request can’t be completed:</p>
            <p className="mt-2 rounded bg-red-50 p-3 text-sm text-red-700">{screen.reason}</p>
          </div>
        )}

        {screen.status === 'error' && (
          <div className="mt-4" data-testid="oauth-error">
            <p className="mt-2 rounded bg-red-50 p-3 text-sm text-red-700">{screen.message}</p>
          </div>
        )}

        {screen.status === 'ready' && (
          <div className="mt-4">
            <p className="text-sm text-foreground">
              <span className="font-medium" data-testid="oauth-app-name">{screen.appName}</span> wants to access your Ship
              account
              {currentWorkspace ? (
                <>
                  {' '}in workspace <span className="font-medium">{currentWorkspace.name}</span>
                </>
              ) : null}
              {user?.email ? <> as <span className="font-medium">{user.email}</span></> : null}.
            </p>

            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted">This will allow it to:</p>
            <ul className="mt-2 space-y-2" data-testid="oauth-scopes">
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
                data-testid="oauth-approve"
                disabled={submitting !== null}
                onClick={() => void submitDecision('approve')}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting === 'approve' ? 'Authorizing…' : 'Authorize'}
              </button>
              <button
                type="button"
                data-testid="oauth-deny"
                disabled={submitting !== null}
                onClick={() => void submitDecision('deny')}
                className="flex-1 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/10 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
