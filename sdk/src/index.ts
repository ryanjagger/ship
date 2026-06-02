/**
 * @ship/sdk — typed client for the Ship Platform API (`/api/v1`).
 *
 * MVP surface (PRD §5.8): `new ShipClient({ token }).me()` returns the typed
 * authenticated user. `documents` is the superset resource; `issues`, `sprints`,
 * and `wiki` are typed resources pinned to one document_type (the same shape,
 * minus the `type` selector).
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

/** List params for a typed resource (`issues`/`sprints`/`wiki`) — no `type` selector. */
export interface ListTypedParams {
  limit?: number;
  cursor?: string;
}

/** Create body for a typed resource — `document_type` is fixed by the route. */
export interface CreateTypedDocumentInput {
  title?: string;
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

/**
 * Client for a typed resource (`issues`, `sprints`, `wiki`). Backed by the same
 * documents engine server-side, pinned to one document_type — so it returns
 * `ShipDocument`s of that type and create() never takes a `document_type`.
 */
export class TypedResourceClient {
  constructor(
    private readonly transport: Transport,
    /** URL segment under /api/v1, e.g. "issues". */
    private readonly resource: string
  ) {}

  list(params: ListTypedParams = {}): Promise<DocumentList> {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.transport.request<DocumentList>('GET', `/api/v1/${this.resource}${suffix}`);
  }

  get(id: string): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('GET', `/api/v1/${this.resource}/${encodeURIComponent(id)}`);
  }

  create(input: CreateTypedDocumentInput): Promise<ShipDocument> {
    return this.transport.request<ShipDocument>('POST', `/api/v1/${this.resource}`, input);
  }
}

export class ShipClient implements Transport {
  readonly documents: DocumentsClient;
  readonly issues: TypedResourceClient;
  readonly sprints: TypedResourceClient;
  readonly wiki: TypedResourceClient;

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
    this.issues = new TypedResourceClient(this, 'issues');
    this.sprints = new TypedResourceClient(this, 'sprints');
    this.wiki = new TypedResourceClient(this, 'wiki');
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

export default ShipClient;
