import { Router } from 'express';
import type { Router as RouterType, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, assertAuthed } from '../../middleware/auth.js';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { findOAuthAppByClientId, findOAuthAppById, verifyClientSecret } from './apps.js';
import { validateAuthorizeAgainstApp, validateScopes, type AuthorizeParams } from './authorize-request.js';
import { issueAuthorizationCode, findAuthorizationCode, consumeAuthorizationCode } from './codes.js';
import {
  issueDeviceCode,
  pollDeviceCode,
  findDeviceByUserCode,
  approveDeviceCode,
  denyDeviceCode,
  formatUserCode,
} from './device-codes.js';
import { issueAccessToken } from './tokens.js';
import { verifyPkce } from './pkce.js';
import { sendOAuthError } from './oauth-errors.js';

/**
 * OAuth 2.0 Authorization Server endpoints (Ship as provider). Mounted under
 * `/api/oauth` so they ride the existing nginx/vite `/api` proxy with zero
 * infra changes (the consent screen itself is a SPA route at `/oauth/consent`).
 *
 * Two routers with different middleware needs:
 *  - oauthPublicRouter: front-channel `GET /authorize` (a redirect) and the
 *    back-channel `POST /token` exchange. NO session/CSRF — `/token` is a
 *    server-to-server call authenticated by client_id + client_secret.
 *  - oauthConsentRouter: `GET /authorize/validate` + `POST /authorize/decision`
 *    that back the React consent screen. Session-authed; the POST is CSRF-
 *    protected by the `conditionalCsrf` applied at mount in app.ts.
 */

// ── Public router (no session, no CSRF) ──────────────────────────────────────
export const oauthPublicRouter: RouterType = Router();

// GET /api/oauth/authorize — the authorization endpoint. Validation happens in
// the consent screen (which can render a friendly error); here we simply hand
// the browser to the React consent route, preserving the query string. We never
// auto-forward to redirect_uri without an explicit, validated approval, so this
// is not an open redirect.
oauthPublicRouter.get('/authorize', (req: Request, res: Response): void => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(`/oauth/consent${qs}`);
});

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const tokenSchema = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
  device_code: z.string().optional(),
});
type TokenRequest = z.infer<typeof tokenSchema>;

function tokenResponse(issued: { accessToken: string; expiresInSeconds: number; scopes: string[] }): Record<string, unknown> {
  return {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresInSeconds,
    scope: issued.scopes.join(' '),
  };
}

// Authorization Code + PKCE exchange (RFC 6749 §4.1.3) — confidential client.
async function handleAuthorizationCodeGrant(data: TokenRequest, res: Response): Promise<void> {
  const { code, redirect_uri, client_id, client_secret, code_verifier } = data;
  if (!code || !redirect_uri || !client_id || !client_secret || !code_verifier) {
    sendOAuthError(
      res,
      HTTP_STATUS.BAD_REQUEST,
      'invalid_request',
      'code, redirect_uri, client_id, client_secret, and code_verifier are required'
    );
    return;
  }

  const app = await findOAuthAppByClientId(client_id);
  if (!app || !(await verifyClientSecret(app, client_secret))) {
    sendOAuthError(res, HTTP_STATUS.UNAUTHORIZED, 'invalid_client', 'Client authentication failed');
    return;
  }

  // Validate the code fully BEFORE consuming, so a wrong PKCE verifier does not
  // burn an otherwise-valid code.
  const row = await findAuthorizationCode(code);
  const invalidGrant = (msg: string): void =>
    sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'invalid_grant', msg);

  if (!row) return invalidGrant('Authorization code is invalid');
  if (row.app_id !== app.id) return invalidGrant('Authorization code was not issued to this client');
  if (row.redirect_uri !== redirect_uri) return invalidGrant('redirect_uri does not match the authorization request');
  if (row.consumed_at || new Date(row.expires_at) < new Date()) return invalidGrant('Authorization code is expired or already used');
  if (!verifyPkce(code_verifier, row.code_challenge, row.code_challenge_method)) {
    return invalidGrant('PKCE verification failed');
  }

  // Atomic single-use consume (guards against a concurrent double-exchange).
  const consumed = await consumeAuthorizationCode(code);
  if (!consumed) return invalidGrant('Authorization code is expired or already used');

  const issued = await issueAccessToken({
    appId: consumed.app_id,
    userId: consumed.user_id,
    workspaceId: consumed.workspace_id,
    scopes: consumed.scopes,
  });
  res.status(HTTP_STATUS.OK).json(tokenResponse(issued));
}

// Device Authorization Grant poll (RFC 8628 §3.4-3.5) — PUBLIC client, so the
// device_code is the proof of possession; NO client_secret is required.
async function handleDeviceCodeGrant(data: TokenRequest, res: Response): Promise<void> {
  if (!data.device_code || !data.client_id) {
    sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'invalid_request', 'device_code and client_id are required');
    return;
  }
  const app = await findOAuthAppByClientId(data.client_id);
  if (!app) {
    sendOAuthError(res, HTTP_STATUS.UNAUTHORIZED, 'invalid_client', 'Unknown client_id');
    return;
  }

  const poll = await pollDeviceCode(data.device_code, app.id);
  switch (poll.state) {
    case 'pending':
      return sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'authorization_pending', 'The user has not yet approved the request');
    case 'slow_down':
      return sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'slow_down', 'Polling too frequently; increase the interval by 5 seconds');
    case 'denied':
      return sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'access_denied', 'The user denied the request');
    case 'expired':
      return sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'expired_token', 'The device_code has expired; restart the flow');
    case 'invalid':
      return sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'invalid_grant', 'Unknown or already-redeemed device_code');
    case 'approved': {
      const issued = await issueAccessToken(poll.grant);
      res.status(HTTP_STATUS.OK).json(tokenResponse(issued));
      return;
    }
  }
}

// POST /api/oauth/token — dispatches by grant_type. Both grants speak the
// RFC 6749 token-endpoint error format on failure.
oauthPublicRouter.post('/token', async (req: Request, res: Response): Promise<void> => {
  const parsed = tokenSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'invalid_request', 'Malformed token request');
    return;
  }
  try {
    if (parsed.data.grant_type === 'authorization_code') {
      await handleAuthorizationCodeGrant(parsed.data, res);
      return;
    }
    if (parsed.data.grant_type === DEVICE_GRANT_TYPE) {
      await handleDeviceCodeGrant(parsed.data, res);
      return;
    }
    sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'unsupported_grant_type', 'Unsupported grant_type');
  } catch (error) {
    console.error('OAuth token endpoint error:', error);
    sendOAuthError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'server_error', 'Token request failed');
  }
});

// POST /api/oauth/device/authorization — Device Authorization Request (RFC 8628
// §3.1-3.2). Public: no session, no client_secret. Returns the device_code the
// client polls with + the user_code the human types at /device.
const deviceAuthSchema = z.object({
  client_id: z.string(),
  scope: z.string().optional(),
});

function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  // req.protocol honors `trust proxy` (X-Forwarded-Proto) when configured.
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

oauthPublicRouter.post('/device/authorization', async (req: Request, res: Response): Promise<void> => {
  const parsed = deviceAuthSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'invalid_request', 'client_id is required');
    return;
  }
  try {
    const app = await findOAuthAppByClientId(parsed.data.client_id);
    if (!app) {
      sendOAuthError(res, HTTP_STATUS.UNAUTHORIZED, 'invalid_client', 'Unknown client_id');
      return;
    }
    const scopeCheck = validateScopes(parsed.data.scope, app);
    if (!scopeCheck.ok) {
      sendOAuthError(res, HTTP_STATUS.BAD_REQUEST, 'invalid_scope', scopeCheck.reason);
      return;
    }

    const issued = await issueDeviceCode({ appId: app.id, scopes: scopeCheck.scopes });
    const verificationUri = `${publicBaseUrl(req)}/device`;
    res.status(HTTP_STATUS.OK).json({
      device_code: issued.deviceCode,
      user_code: issued.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(issued.userCode)}`,
      expires_in: issued.expiresInSeconds,
      interval: issued.intervalSeconds,
    });
  } catch (error) {
    console.error('OAuth device authorization error:', error);
    sendOAuthError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'server_error', 'Device authorization failed');
  }
});

// ── Consent router (session-authed; POST is CSRF-protected at mount) ─────────
export const oauthConsentRouter: RouterType = Router();

function paramsFrom(source: Record<string, unknown>): AuthorizeParams {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    response_type: str(source.response_type),
    client_id: str(source.client_id),
    redirect_uri: str(source.redirect_uri),
    scope: str(source.scope),
    state: str(source.state),
    code_challenge: str(source.code_challenge),
    code_challenge_method: str(source.code_challenge_method),
  };
}

// GET /api/oauth/authorize/validate — render-time check for the consent screen.
// Always 200 with a discriminated payload so the SPA can show a friendly error
// for a bad client_id/redirect_uri without any redirect-on-4xx interference.
oauthConsentRouter.get('/authorize/validate', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const params = paramsFrom(req.query as Record<string, unknown>);
  try {
    const app = params.client_id ? await findOAuthAppByClientId(params.client_id) : null;
    if (!app) {
      res.json({ success: true, data: { valid: false, reason: 'Unknown client_id' } });
      return;
    }
    const validation = validateAuthorizeAgainstApp(params, app);
    if (!validation.ok) {
      res.json({ success: true, data: { valid: false, reason: validation.reason } });
      return;
    }
    res.json({
      success: true,
      data: {
        valid: true,
        app_name: app.name,
        client_id: app.client_id,
        redirect_uri: params.redirect_uri,
        scopes: validation.scopes,
        state: params.state ?? null,
      },
    });
  } catch (error) {
    console.error('OAuth authorize validate error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to validate authorization request' },
    });
  }
});

const decisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
});

// POST /api/oauth/authorize/decision — approve/deny. On approve, issue a code
// bound to the authenticated user + current workspace and return the redirect
// URL for the browser to follow back to the client.
oauthConsentRouter.post('/authorize/decision', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return; // needs userId + a selected workspaceId

  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid request', details: parsed.error.flatten() },
    });
    return;
  }

  const params = paramsFrom(parsed.data);
  const state = parsed.data.state;

  try {
    const app = params.client_id ? await findOAuthAppByClientId(params.client_id) : null;
    if (!app) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Unknown client_id' },
      });
      return;
    }

    const validation = validateAuthorizeAgainstApp(params, app);
    if (!validation.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: { code: ERROR_CODES.VALIDATION_ERROR, message: validation.reason },
      });
      return;
    }

    const redirectUrl = new URL(params.redirect_uri!);

    if (parsed.data.decision === 'deny') {
      redirectUrl.searchParams.set('error', 'access_denied');
      if (state) redirectUrl.searchParams.set('state', state);
      res.json({ success: true, data: { redirect_to: redirectUrl.toString() } });
      return;
    }

    const code = await issueAuthorizationCode({
      appId: app.id,
      userId: req.userId,
      workspaceId: req.workspaceId,
      redirectUri: params.redirect_uri!,
      codeChallenge: params.code_challenge!,
      codeChallengeMethod: params.code_challenge_method!,
      scopes: validation.scopes,
    });

    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.json({ success: true, data: { redirect_to: redirectUrl.toString() } });
  } catch (error) {
    console.error('OAuth authorize decision error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to process authorization decision' },
    });
  }
});

// ── Device flow approval (RFC 8628 §3.3) — session-authed, CSRF at mount ─────
// These back the `/device` SPA page where a signed-in user enters the user_code
// shown on their device and approves/denies it.

// GET /api/oauth/device/validate?user_code= — render-time check (always 200 with
// a discriminated payload, mirroring /authorize/validate).
oauthConsentRouter.get('/device/validate', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userCode = typeof req.query.user_code === 'string' ? req.query.user_code : '';
  try {
    const row = userCode ? await findDeviceByUserCode(userCode) : null;
    if (!row) {
      res.json({ success: true, data: { valid: false, reason: 'That code wasn’t found. Check it and try again.' } });
      return;
    }
    if (row.status !== 'pending' || new Date(row.expires_at) < new Date()) {
      const reason =
        row.status === 'approved'
          ? 'This code has already been approved.'
          : row.status === 'denied'
            ? 'This code was denied.'
            : 'This code has expired. Start over on your device.';
      res.json({ success: true, data: { valid: false, reason, status: row.status } });
      return;
    }
    const app = await findOAuthAppById(row.app_id);
    res.json({
      success: true,
      data: {
        valid: true,
        app_name: app?.name ?? 'An application',
        scopes: row.scopes,
        user_code: formatUserCode(row.user_code),
      },
    });
  } catch (error) {
    console.error('OAuth device validate error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to validate the device code' },
    });
  }
});

const deviceDecisionSchema = z.object({
  user_code: z.string(),
  decision: z.enum(['approve', 'deny']),
});

// POST /api/oauth/device/decision — approve/deny, binding the eventual token to
// the signed-in user + their current workspace.
oauthConsentRouter.post('/device/decision', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!assertAuthed(req, res)) return; // needs userId + a selected workspaceId

  const parsed = deviceDecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid request', details: parsed.error.flatten() },
    });
    return;
  }

  try {
    if (parsed.data.decision === 'deny') {
      await denyDeviceCode(parsed.data.user_code);
      res.json({ success: true, data: { status: 'denied' } });
      return;
    }

    const approved = await approveDeviceCode({
      userCode: parsed.data.user_code,
      userId: req.userId,
      workspaceId: req.workspaceId,
    });
    if (!approved) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'That code is no longer valid (expired or already handled).' },
      });
      return;
    }
    res.json({ success: true, data: { status: 'approved' } });
  } catch (error) {
    console.error('OAuth device decision error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to process device decision' },
    });
  }
});
