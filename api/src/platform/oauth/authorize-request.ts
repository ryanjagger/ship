import { isRegisteredRedirectUri, type OAuthApp } from './apps.js';
import { scopeRegistry } from '../api/v1/scopes/registry.js';

/**
 * Shared validation for an authorization request, used by both the consent
 * `validate` (render-time) and `decision` (issue-time) endpoints so they can
 * never disagree about what a valid request is.
 */
export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export type AuthorizeValidation =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: string };

export function parseScopes(scope?: string): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean);
}

type AppScopeFields = Pick<OAuthApp, 'redirect_uris' | 'requested_scopes'>;

export function validateAuthorizeAgainstApp(
  params: AuthorizeParams,
  app: AppScopeFields
): AuthorizeValidation {
  if (params.response_type !== 'code') {
    return { ok: false, reason: 'response_type must be "code"' };
  }
  if (!params.redirect_uri || !isRegisteredRedirectUri(app, params.redirect_uri)) {
    return { ok: false, reason: 'redirect_uri is not registered for this client' };
  }
  if (!params.code_challenge) {
    return { ok: false, reason: 'code_challenge is required (PKCE)' };
  }
  if (params.code_challenge_method !== 'S256') {
    return { ok: false, reason: 'code_challenge_method must be S256' };
  }

  const requested = parseScopes(params.scope);
  const { unknown } = scopeRegistry.partition(requested);
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown scope(s): ${unknown.join(', ')}` };
  }
  const notAllowed = requested.filter((s) => !app.requested_scopes.includes(s));
  if (notAllowed.length > 0) {
    return { ok: false, reason: `scope(s) not permitted for this client: ${notAllowed.join(', ')}` };
  }

  // If the client omits `scope`, grant the app's full registered scope set.
  const scopes = requested.length > 0 ? requested : app.requested_scopes;
  return { ok: true, scopes };
}
