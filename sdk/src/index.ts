/**
 * @ryanjagger/ship-sdk — typed client for the Ship Platform API (`/api/v1`).
 *
 * MVP surface (PRD §5.8): `new ShipClient({ token }).me()` returns the typed
 * authenticated user. The `documents` / `issues` resource clients keep the shape
 * from the brief so later work slots in without reshaping the public surface.
 *
 * Types are defined here (not imported from @ship/shared) so the SDK is an
 * independently publishable package with no monorepo coupling. Runtime uses the
 * global `fetch` (Node ≥18 / browsers) — no dependencies.
 */

export interface ShipClientOptions {
  /** OAuth 2.0 access token (Authorization Code + PKCE). Sent as a Bearer token. */
  token: string;
  /**
   * Origin of the Ship deployment, e.g. `https://ship.example.com`. Paths like
   * `/api/v1/me` are appended. Defaults to `''` (same-origin, for browser use).
   */
  baseUrl?: string;
  /** Override the fetch implementation (e.g. for testing or non-global environments). */
  fetch?: typeof fetch;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/** Thrown for any non-2xx Platform API response, carrying the ApiError contract. */
export class ShipApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: Partial<ApiErrorBody> | null) {
    super(body?.message ?? `Ship API request failed with status ${status}`);
    this.name = 'ShipApiError';
    this.status = status;
    this.code = body?.code ?? 'unknown';
    this.requestId = body?.request_id;
    this.details = body?.details;
  }
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
}

export interface AuthenticatedUser {
  id: string;
  name: string;
  email?: string;
  workspace: Workspace;
}

export interface ShipDocument {
  id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
  ticket_number: number | null;
  visibility: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  content?: unknown;
}

export interface DocumentList {
  data: ShipDocument[];
  next_cursor: string | null;
}

export interface ListDocumentsParams {
  limit?: number;
  cursor?: string;
  type?: string;
}

export interface CreateDocumentInput {
  title?: string;
  document_type?: string;
  parent_id?: string | null;
  properties?: Record<string, unknown>;
  visibility?: 'private' | 'workspace';
  content?: unknown;
}

/** Internal transport shared by the client and its resource sub-clients. */
interface Transport {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export class DocumentsClient {
  constructor(private readonly transport: Transport) {}

  list(params: ListDocumentsParams = {}): Promise<DocumentList> {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.type) qs.set('type', params.type);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.transport.request<DocumentList>('GET', `/api/v1/documents${suffix}`);
  }

  get(id: string): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('GET', `/api/v1/documents/${encodeURIComponent(id)}`);
  }

  create(input: CreateDocumentInput): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('POST', '/api/v1/documents', input);
  }
}

/** Stub for a future typed issues surface — keeps the ShipClient shape stable. */
export class IssuesClient {
  constructor(private readonly _transport: Transport) {}
}

export class ShipClient implements Transport {
  readonly documents: DocumentsClient;
  readonly issues: IssuesClient;

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShipClientOptions) {
    if (!options?.token) throw new Error('ShipClient requires a token');
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('No fetch implementation available; pass one via options.fetch');
    }
    this.fetchImpl = fetchImpl;

    this.documents = new DocumentsClient(this);
    this.issues = new IssuesClient(this);
  }

  /** GET /api/v1/me — the authenticated user + current workspace. */
  me(): Promise<AuthenticatedUser> {
    return this.request<AuthenticatedUser>('GET', '/api/v1/me');
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new ShipApiError(res.status, json as Partial<ApiErrorBody> | null);
    }
    return json as T;
  }
}

// ── Device Authorization Grant (RFC 8628) — `ship login` ────────────────────
// These are module-level (not on ShipClient) because they run BEFORE a token
// exists: the client requests a device_code, the user approves in a browser,
// and the client polls until a token is issued.

export interface DeviceAuthorization {
  device_code: string;
  /** Short human code (XXXX-XXXX) the user enters at verification_uri. */
  user_code: string;
  verification_uri: string;
  /** verification_uri with the user_code prefilled (?code=…). */
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/** Thrown for a terminal device-flow failure (OAuth `{ error }` shape). */
export class DeviceFlowError extends Error {
  readonly error: string;
  readonly status: number;
  readonly description?: string;

  constructor(status: number, error: string, description?: string) {
    super(description ?? `Device flow failed: ${error}`);
    this.name = 'DeviceFlowError';
    this.status = status;
    this.error = error;
    this.description = description;
  }
}

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resolveFetch(injected?: typeof fetch): typeof fetch {
  const impl = injected ?? globalThis.fetch;
  if (typeof impl !== 'function') {
    throw new Error('No fetch implementation available; pass one via options.fetch');
  }
  return impl;
}

async function postOAuthJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

export interface RequestDeviceAuthorizationOptions {
  clientId: string;
  baseUrl?: string;
  scope?: string;
  fetch?: typeof fetch;
}

/** Begin the device flow: POST /api/oauth/device/authorization. */
export async function requestDeviceAuthorization(
  opts: RequestDeviceAuthorizationOptions
): Promise<DeviceAuthorization> {
  if (!opts?.clientId) throw new Error('requestDeviceAuthorization requires a clientId');
  const fetchImpl = resolveFetch(opts.fetch);
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  const { ok, status, json } = await postOAuthJson(fetchImpl, baseUrl, '/api/oauth/device/authorization', {
    client_id: opts.clientId,
    scope: opts.scope,
  });
  if (!ok) {
    throw new DeviceFlowError(status, (json?.error as string) ?? 'request_failed', json?.error_description as string);
  }
  return json as unknown as DeviceAuthorization;
}

export interface PollDeviceTokenOptions {
  clientId: string;
  deviceCode: string;
  baseUrl?: string;
  intervalSeconds?: number;
  fetch?: typeof fetch;
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort the poll loop early. */
  signal?: AbortSignal;
}

/**
 * Poll the token endpoint until the user approves (RFC 8628 §3.4-3.5). Handles
 * `authorization_pending` (keep waiting) and `slow_down` (wait + widen the
 * interval); throws DeviceFlowError on `access_denied`, `expired_token`, or any
 * other terminal error.
 */
export async function pollDeviceToken(opts: PollDeviceTokenOptions): Promise<DeviceTokenResponse> {
  if (!opts?.clientId || !opts?.deviceCode) throw new Error('pollDeviceToken requires clientId and deviceCode');
  const fetchImpl = resolveFetch(opts.fetch);
  const sleep = opts.sleep ?? defaultSleep;
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  let interval = Math.max(1, opts.intervalSeconds ?? 5);

  for (;;) {
    if (opts.signal?.aborted) throw new DeviceFlowError(0, 'aborted', 'Polling was aborted');
    const { ok, status, json } = await postOAuthJson(fetchImpl, baseUrl, '/api/oauth/token', {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: opts.deviceCode,
      client_id: opts.clientId,
    });
    if (ok) return json as unknown as DeviceTokenResponse;

    const error = (json?.error as string | undefined) ?? 'request_failed';
    if (error === 'authorization_pending') {
      await sleep(interval * 1000);
      continue;
    }
    if (error === 'slow_down') {
      interval += 5;
      await sleep(interval * 1000);
      continue;
    }
    throw new DeviceFlowError(status, error, json?.error_description as string);
  }
}

export default ShipClient;
