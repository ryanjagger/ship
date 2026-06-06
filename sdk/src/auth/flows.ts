/**
 * Authorization Code + PKCE plumbing (PRD §2). These helpers build the
 * authorize URL, drive the user through consent via a pluggable redirect
 * adapter (Node loopback, browser redirect, or a custom adapter), and exchange
 * the returned code for tokens. They return raw token data; `ShipClient`
 * (index.ts) wraps them to produce an authenticated client + persist the set.
 */
import { generatePkce, generateState, type PkcePair } from './pkce.js';

/** The result the consent step yields back: the authorization code + echoed state. */
export interface AuthorizeResult {
  code: string;
  state?: string;
}

/**
 * Owns the redirect/callback mechanics. Given the built authorization URL, it
 * must drive the user agent through consent and resolve with the `code`
 * (and `state`) delivered to `redirectUri`.
 */
export interface AuthCodeRedirectAdapter {
  authorize(authUrl: string, redirectUri: string): Promise<AuthorizeResult>;
}

export interface AuthorizationCodeFlowOptions {
  clientId: string;
  /** Confidential clients exchange the code with their secret. Public PKCE clients omit it. */
  clientSecret?: string;
  redirectUri: string;
  baseUrl?: string;
  scope?: string;
  fetch?: typeof fetch;
  /** How to obtain the code: 'loopback' (Node), 'browser', or a custom adapter. */
  redirect: 'loopback' | 'browser' | AuthCodeRedirectAdapter;
  /** Loopback only: open the URL in a browser (default true). */
  openBrowser?: boolean;
  /** Browser only: storage for the PKCE verifier/state across the redirect. */
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
}

export interface RawTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? '').replace(/\/$/, '');
}

export function buildAuthorizeUrl(opts: {
  baseUrl?: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  pkce: PkcePair;
}): string {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.pkce.challenge,
    code_challenge_method: opts.pkce.method,
  });
  if (opts.scope) qs.set('scope', opts.scope);
  return `${normalizeBaseUrl(opts.baseUrl)}/api/oauth/authorize?${qs.toString()}`;
}

/** Exchange an authorization code for tokens at POST /api/oauth/token. */
export async function exchangeAuthorizationCode(opts: {
  baseUrl?: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetch: typeof fetch;
}): Promise<RawTokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  };
  if (opts.clientSecret) body.client_secret = opts.clientSecret;

  const res = await opts.fetch(`${normalizeBaseUrl(opts.baseUrl)}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  if (!res.ok) {
    const error = (json?.error as string) ?? 'token_exchange_failed';
    const description = json?.error_description as string | undefined;
    throw new Error(`Token exchange failed: ${error}${description ? ` - ${description}` : ''}`);
  }
  return json as unknown as RawTokenResponse;
}

function openInBrowser(url: string): void {
  // Lazy import keeps this module importable in browsers (where child_process
  // doesn't exist). Best-effort: the URL is also returned for manual use.
  void import('node:child_process')
    .then(({ spawn }) => {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    })
    .catch(() => {});
}

/**
 * Node local-loopback adapter (RFC 8252): spins up a one-shot HTTP server on the
 * redirect URI's host/port, opens the browser, and resolves with the code on the
 * callback. `redirectUri` must be a loopback URL (127.0.0.1/localhost).
 */
export function loopbackRedirectAdapter(options: { openBrowser?: boolean } = {}): AuthCodeRedirectAdapter {
  return {
    authorize(authUrl, redirectUri): Promise<AuthorizeResult> {
      const url = new URL(redirectUri);
      const port = Number(url.port || '80');
      return new Promise<AuthorizeResult>((resolve, reject) => {
        void import('node:http').then(({ createServer }) => {
          const server = createServer((req, res) => {
            const reqUrl = new URL(req.url ?? '/', `http://${url.host}`);
            if (reqUrl.pathname !== url.pathname) {
              res.writeHead(404).end();
              return;
            }
            const code = reqUrl.searchParams.get('code');
            const error = reqUrl.searchParams.get('error');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
              `<!doctype html><meta charset="utf-8"><title>Ship</title><body style="font-family:system-ui;padding:2rem">` +
                `<h2>${code ? 'Signed in ✓' : 'Sign-in failed'}</h2>` +
                `<p>${code ? 'You can close this tab and return to your terminal.' : (error ?? 'No authorization code was returned.')}</p>`
            );
            server.close();
            if (code) resolve({ code, state: reqUrl.searchParams.get('state') ?? undefined });
            else reject(new Error(`Authorization failed: ${error ?? 'no code returned'}`));
          });
          server.on('error', reject);
          server.listen(port, url.hostname, () => {
            if (options.openBrowser !== false) openInBrowser(authUrl);
          });
        }).catch(reject);
      });
    },
  };
}

const BROWSER_VERIFIER_KEY = 'ship.pkce.verifier';
const BROWSER_STATE_KEY = 'ship.pkce.state';

/**
 * Browser redirect adapter. Two-phase: on the first call (no `?code=` in the
 * URL) it stores the verifier+state and navigates to the authorize URL — the
 * returned promise never resolves because the page unloads. After the redirect
 * back, calling the flow again detects `?code=` and resolves immediately.
 */
export function browserRedirectAdapter(storage?: AuthorizationCodeFlowOptions['storage']): AuthCodeRedirectAdapter {
  const store = storage ?? (globalThis as { localStorage?: NonNullable<AuthorizationCodeFlowOptions['storage']> }).localStorage;
  if (!store) throw new Error('browserRedirectAdapter requires localStorage or an explicit storage');
  const loc = (globalThis as { location?: { search: string; assign(url: string): void } }).location;
  if (!loc) throw new Error('browserRedirectAdapter requires a browser window.location');

  return {
    authorize(authUrl): Promise<AuthorizeResult> {
      const params = new URLSearchParams(loc.search);
      const code = params.get('code');
      if (code) {
        const state = params.get('state') ?? undefined;
        return Promise.resolve({ code, state });
      }
      // First leg: persist nothing here (verifier/state are persisted by the
      // caller before building authUrl) and navigate away.
      loc.assign(authUrl);
      return new Promise<AuthorizeResult>(() => {
        /* never resolves; the page is unloading */
      });
    },
  };
}

export { BROWSER_VERIFIER_KEY, BROWSER_STATE_KEY, generatePkce, generateState };
