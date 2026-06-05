/**
 * @ryanjagger/ship-sdk — typed client for the Ship Platform API (`/api/v1`).
 *
 * MVP surface (PRD §5.8): `new ShipClient({ token }).me()` returns the typed
 * authenticated user. Typed resource clients expose the document-backed public
 * API while `documents` remains available as the legacy broad surface.
 *
 * Types are defined here (not imported from @ship/shared) so the SDK is an
 * independently publishable package with no monorepo coupling. Runtime uses the
 * global `fetch` (Node ≥18 / browsers) — no dependencies.
 */

import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  loopbackRedirectAdapter,
  browserRedirectAdapter,
  generatePkce,
  generateState,
  BROWSER_VERIFIER_KEY,
  BROWSER_STATE_KEY,
  type AuthCodeRedirectAdapter,
} from './auth/flows.js';
import type { PkcePair } from './auth/pkce.js';
import type { ITokenStore, ShipTokenSet } from './auth/token-store.js';

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

/**
 * Stable, exhaustively-switchable discriminator for every SDK error (PRD §5).
 * Consumers `switch (error.kind)` and the compiler enforces exhaustiveness.
 */
export type ShipSDKError =
  | { kind: 'auth'; status: 401 | 403; code: string; message: string; requestId?: string; details?: unknown }
  | { kind: 'rate_limit'; status: 429; retryAfter?: number; resetAt?: Date; limit?: number; remaining?: number; message: string; requestId?: string }
  | { kind: 'not_found'; status: 404; code: string; message: string; requestId?: string }
  | { kind: 'validation'; status: 400 | 422; code: string; message: string; details?: unknown; requestId?: string }
  | { kind: 'server'; status: number; code: string; message: string; requestId?: string; cause?: unknown };

export type ShipSDKErrorKind = ShipSDKError['kind'];

/** Rate-limit metadata parsed from response headers (X-RateLimit-* + Retry-After). */
export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAt?: Date;
  retryAfter?: number;
}

/** Map a public `ApiError.code` (+ status) to the stable SDK error `kind`. */
function kindForApiError(code: string, status: number): ShipSDKErrorKind {
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
      return 'auth';
    case 'rate_limited':
      return 'rate_limit';
    case 'not_found':
      return 'not_found';
    case 'validation_failed':
      return 'validation';
    default:
      // Status-based fallback for codes we don't recognize.
      if (status === 401 || status === 403) return 'auth';
      if (status === 429) return 'rate_limit';
      if (status === 404) return 'not_found';
      if (status === 400 || status === 422) return 'validation';
      return 'server';
  }
}

function parseRateLimitHeaders(headers?: Headers): RateLimitInfo | undefined {
  if (!headers) return undefined;
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw == null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  const resetSec = num('x-ratelimit-reset');
  const retryAfter = num('retry-after');
  if (limit == null && remaining == null && resetSec == null && retryAfter == null) return undefined;
  return {
    limit,
    remaining,
    resetAt: resetSec != null ? new Date(resetSec * 1000) : undefined,
    retryAfter,
  };
}

/**
 * Thrown for any non-2xx Platform API response, carrying the ApiError contract.
 * Also exposes the stable SDK discriminator (`kind`) + parsed rate-limit
 * metadata so it doubles as a `ShipSDKError` source (PRD §5: legacy
 * `ShipApiError` contains the new shape). Convert with `toSDKError()`.
 */
export class ShipApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: ShipSDKErrorKind;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
  readonly rateLimit?: RateLimitInfo;

  constructor(status: number, body: Partial<ApiErrorBody> | null, headers?: Headers) {
    super(body?.message ?? `Ship API request failed with status ${status}`);
    this.name = 'ShipApiError';
    this.status = status;
    this.code = body?.code ?? 'unknown';
    this.kind = kindForApiError(this.code, status);
    this.requestId = body?.request_id;
    this.details = body?.details;
    if (this.kind === 'rate_limit') this.rateLimit = parseRateLimitHeaders(headers);
  }

  /** Project onto the discriminated `ShipSDKError` union for exhaustive switching. */
  toSDKError(): ShipSDKError {
    return toShipSDKError(this);
  }
}

/**
 * Normalize any thrown value into the `ShipSDKError` union. `ShipApiError`
 * becomes its mapped `kind`; network/parse failures and unknown values become
 * `{ kind: 'server' }` (PRD §5: "everything else or network/parse → server").
 */
export function toShipSDKError(err: unknown): ShipSDKError {
  if (err instanceof ShipApiError) {
    const base = { message: err.message, requestId: err.requestId };
    switch (err.kind) {
      case 'auth':
        return { kind: 'auth', status: (err.status === 403 ? 403 : 401), code: err.code, details: err.details, ...base };
      case 'rate_limit':
        return {
          kind: 'rate_limit',
          status: 429,
          retryAfter: err.rateLimit?.retryAfter,
          resetAt: err.rateLimit?.resetAt,
          limit: err.rateLimit?.limit,
          remaining: err.rateLimit?.remaining,
          ...base,
        };
      case 'not_found':
        return { kind: 'not_found', status: 404, code: err.code, ...base };
      case 'validation':
        return { kind: 'validation', status: (err.status === 422 ? 422 : 400), code: err.code, details: err.details, ...base };
      case 'server':
        return { kind: 'server', status: err.status, code: err.code, ...base };
    }
  }
  return {
    kind: 'server',
    status: 0,
    code: 'network_error',
    message: err instanceof Error ? err.message : 'Network or parse error',
    cause: err,
  };
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

export interface UpdateDocumentInput {
  title?: string;
  parent_id?: string | null;
  properties?: Record<string, unknown>;
  visibility?: 'private' | 'workspace';
  content?: unknown;
}

export interface ListTypedResourceParams {
  limit?: number;
  cursor?: string;
}

export type CreateTypedResourceInput = Omit<CreateDocumentInput, 'document_type'>;
export type UpdateTypedResourceInput = UpdateDocumentInput;

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

interface BaseResource {
  id: string;
  created_at: string;
  updated_at: string;
}

interface ContentResource extends BaseResource {
  title: string;
  content?: unknown;
  created_by: string | null;
}

export interface ShipWikiPage extends ContentResource {
  parent_id: string | null;
  visibility: string;
  maintainer_id: string | null;
}

export type IssueState = 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type IssueSource = 'internal' | 'external' | 'action_items';

export interface ShipIssue extends ContentResource {
  display_id: string;
  ticket_number: number | null;
  state: IssueState;
  priority: IssuePriority;
  assignee_id: string | null;
  estimate: number | null;
  source: IssueSource;
  due_date: string | null;
  is_system_generated: boolean;
  accountability_target_id: string | null;
  accountability_type: string | null;
  rejection_reason: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  reopened_at?: string | null;
  converted_from_id?: string | null;
  belongs_to: Array<{ id: string; type: 'program' | 'project' | 'sprint' | 'parent'; title?: string; color?: string }>;
}

export interface ShipProgram extends BaseResource {
  name: string;
  color: string;
  emoji: string | null;
  owner_id: string | null;
  accountable_id: string | null;
  consulted_ids: string[];
  informed_ids: string[];
  issue_count: number;
  sprint_count: number;
  archived_at: string | null;
}

export interface ShipProject extends BaseResource {
  title: string;
  impact: number | null;
  confidence: number | null;
  ease: number | null;
  ice_score: number | null;
  color: string;
  emoji: string | null;
  program_id: string | null;
  owner_id: string | null;
  accountable_id: string | null;
  consulted_ids: string[];
  informed_ids: string[];
  plan: string | null;
  plan_approval: Record<string, unknown> | null;
  retro_approval: Record<string, unknown> | null;
  has_retro: boolean;
  has_design_review: boolean | null;
  design_review_notes: string | null;
  target_date: string | null;
  inferred_status: string;
  sprint_count: number;
  issue_count: number;
  is_complete: boolean | null;
  missing_fields: string[];
  archived_at: string | null;
  converted_from_id: string | null;
}

export interface ShipSprint extends BaseResource {
  name: string;
  sprint_number: number;
  status: 'planning' | 'active' | 'completed';
  owner_id: string | null;
  program_id: string | null;
  plan: string | null;
  success_criteria: string[] | null;
  confidence: number | null;
  plan_history: Array<Record<string, unknown>> | null;
  is_complete: boolean | null;
  missing_fields: string[];
  planned_issue_ids: string[] | null;
  snapshot_taken_at: string | null;
  plan_approval: Record<string, unknown> | null;
  review_approval: Record<string, unknown> | null;
  review_rating: Record<string, unknown> | null;
  accountable_id: string | null;
  issue_count: number;
  completed_count: number;
  started_count: number;
  has_plan: boolean;
  has_retro: boolean;
  retro_outcome: string | null;
  retro_id: string | null;
}

export interface ShipPerson extends BaseResource {
  name: string;
  email: string | null;
  role: string | null;
  capacity_hours: number | null;
  reports_to: string | null;
  visibility: string;
  created_by: string | null;
}

export interface ShipWeeklyPlan extends ContentResource {
  person_id: string | null;
  project_id: string | null;
  week_number: number | null;
  submitted_at: string | null;
}

export type ShipWeeklyRetro = ShipWeeklyPlan;

export interface ShipStandup extends ContentResource {
  author_id: string | null;
  date: string | null;
  submitted_at: string | null;
}

export interface ShipWeeklyReview extends ContentResource {
  sprint_id: string | null;
  owner_id: string | null;
  plan_validated: boolean | null;
}

export interface CreateWikiPageInput extends Omit<CreateTypedResourceInput, 'properties'> {
  maintainer_id?: string | null;
}
export interface UpdateWikiPageInput extends Omit<UpdateTypedResourceInput, 'properties'> {
  maintainer_id?: string | null;
}

export interface CreateIssueInput extends Omit<CreateTypedResourceInput, 'parent_id' | 'properties'> {
  title?: string;
  state?: IssueState;
  priority?: IssuePriority;
  assignee_id?: string | null;
  belongs_to?: Array<{ id: string; type: 'program' | 'project' | 'sprint' | 'parent' }>;
  estimate?: number | null;
  source?: IssueSource;
  due_date?: string | null;
  is_system_generated?: boolean;
  accountability_target_id?: string | null;
  accountability_type?: string | null;
}
export interface UpdateIssueInput extends Omit<UpdateTypedResourceInput, 'parent_id' | 'properties'> {
  state?: IssueState;
  priority?: IssuePriority;
  assignee_id?: string | null;
  belongs_to?: Array<{ id: string; type: 'program' | 'project' | 'sprint' | 'parent' }>;
  estimate?: number | null;
  due_date?: string | null;
  rejection_reason?: string | null;
}

export interface CreateProgramInput extends Omit<CreateTypedResourceInput, 'content' | 'parent_id' | 'properties'> {
  title?: string;
  color?: string;
  emoji?: string | null;
  owner_id?: string | null;
  accountable_id?: string | null;
  consulted_ids?: string[];
  informed_ids?: string[];
}
export type UpdateProgramInput = Partial<CreateProgramInput>;

export interface CreateProjectInput extends Omit<CreateTypedResourceInput, 'parent_id' | 'properties'> {
  impact?: number | null;
  confidence?: number | null;
  ease?: number | null;
  color?: string;
  emoji?: string | null;
  program_id?: string | null;
  owner_id?: string | null;
  accountable_id?: string | null;
  consulted_ids?: string[];
  informed_ids?: string[];
  plan?: string | null;
  target_date?: string | null;
}
export interface UpdateProjectInput extends Partial<CreateProjectInput> {
  has_design_review?: boolean | null;
  design_review_notes?: string | null;
}

export interface CreateSprintInput extends Omit<CreateTypedResourceInput, 'parent_id' | 'properties'> {
  sprint_number: number;
  owner_id?: string | null;
  program_id?: string | null;
  status?: 'planning' | 'active' | 'completed';
  plan?: string | null;
  success_criteria?: string[] | null;
  confidence?: number | null;
}
export type UpdateSprintInput = Partial<CreateSprintInput>;

export interface CreatePersonInput extends Omit<CreateTypedResourceInput, 'content' | 'parent_id' | 'properties'> {
  name?: string;
  email?: string | null;
  role?: string | null;
  capacity_hours?: number | null;
  reports_to?: string | null;
}
export type UpdatePersonInput = Partial<CreatePersonInput>;

export interface CreateWeeklyDocInput extends Omit<CreateTypedResourceInput, 'parent_id' | 'properties'> {
  person_id?: string | null;
  project_id?: string | null;
  week_number?: number | null;
  submitted_at?: string | null;
}
export type UpdateWeeklyDocInput = Partial<CreateWeeklyDocInput>;

export interface CreateStandupInput extends Omit<CreateTypedResourceInput, 'parent_id' | 'properties'> {
  author_id?: string | null;
  date?: string | null;
  submitted_at?: string | null;
}
export type UpdateStandupInput = Partial<CreateStandupInput>;

export interface CreateWeeklyReviewInput extends Omit<CreateTypedResourceInput, 'parent_id' | 'properties'> {
  sprint_id?: string | null;
  owner_id?: string | null;
  plan_validated?: boolean | null;
}
export type UpdateWeeklyReviewInput = Partial<CreateWeeklyReviewInput>;

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface ShipWebhookSubscription {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  secret_fingerprint: string;
  created_at: string;
  updated_at: string;
}

/** Returned by create + rotate-secret only: the raw signing secret, shown once. */
export interface CreatedWebhookSubscription extends ShipWebhookSubscription {
  secret: string;
}

export interface CreateWebhookSubscriptionInput {
  url: string;
  events: string[];
  active?: boolean;
}

export type UpdateWebhookSubscriptionInput = Partial<CreateWebhookSubscriptionInput>;

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_lettered' | 'replayed';

export interface ShipWebhookDelivery {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  last_response_status: number | null;
  last_response_body_excerpt: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  dead_lettered_at: string | null;
  replay_of_delivery_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryAttempt {
  id: string;
  delivery_id: string;
  subscription_id: string;
  event_id: string;
  attempt_number: number;
  response_status: number | null;
  response_body_excerpt: string | null;
  duration_ms: number | null;
  error: string | null;
  sent_at: string;
}

export interface ShipWebhookDeliveryDetail extends ShipWebhookDelivery {
  attempts: WebhookDeliveryAttempt[];
}

export interface WebhookDeliveryListParams {
  subscription_id?: string;
  event_type?: string;
  status?: WebhookDeliveryStatus;
  limit?: number;
}

export interface WebhookReplayResult {
  delivery_id: string;
  replay_of_delivery_id: string;
}

/** Wrapper for the webhook list endpoints, which return `{ data }` (no cursor). */
export interface DataList<T> {
  data: T[];
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

  /**
   * Lazily iterate every document across pages, hiding cursor walking. Fetches
   * the next page only when iteration continues; all filters except `cursor`
   * are preserved across pages.
   */
  async *iterate(params: Omit<ListDocumentsParams, 'cursor'> = {}): AsyncGenerator<ShipDocument, void, unknown> {
    let cursor: string | undefined;
    for (;;) {
      const page: DocumentList = await this.list({ ...params, cursor });
      for (const item of page.data) yield item;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

export class TypedResourceClient<TResource = unknown, TCreate = CreateTypedResourceInput, TUpdate = UpdateTypedResourceInput> {
  constructor(
    private readonly transport: Transport,
    private readonly path: string
  ) {}

  list(params: ListTypedResourceParams = {}): Promise<Page<TResource>> {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.transport.request<Page<TResource>>('GET', `/api/v1/${this.path}${suffix}`);
  }

  get(id: string): Promise<TResource> {
    return this.transport.request<TResource>('GET', `/api/v1/${this.path}/${encodeURIComponent(id)}`);
  }

  create(input: TCreate): Promise<TResource> {
    return this.transport.request<TResource>('POST', `/api/v1/${this.path}`, input);
  }

  update(id: string, input: TUpdate): Promise<TResource> {
    return this.transport.request<TResource>('PATCH', `/api/v1/${this.path}/${encodeURIComponent(id)}`, input);
  }

  async delete(id: string): Promise<void> {
    await this.transport.request<null>('DELETE', `/api/v1/${this.path}/${encodeURIComponent(id)}`);
  }

  /**
   * Lazily iterate every resource across pages, hiding cursor walking. Fetches
   * the next page only when iteration continues; all filters except `cursor`
   * are preserved across pages.
   */
  async *iterate(params: Omit<ListTypedResourceParams, 'cursor'> = {}): AsyncGenerator<TResource, void, unknown> {
    let cursor: string | undefined;
    for (;;) {
      const page: Page<TResource> = await this.list({ ...params, cursor });
      for (const item of page.data) yield item;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

/** Webhook delivery log + replay (`/api/v1/webhook-deliveries`). */
export class WebhookDeliveriesClient {
  constructor(private readonly transport: Transport) {}

  list(params: WebhookDeliveryListParams = {}): Promise<DataList<ShipWebhookDelivery>> {
    const qs = new URLSearchParams();
    if (params.subscription_id) qs.set('subscription_id', params.subscription_id);
    if (params.event_type) qs.set('event_type', params.event_type);
    if (params.status) qs.set('status', params.status);
    if (params.limit != null) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.transport.request<DataList<ShipWebhookDelivery>>('GET', `/api/v1/webhook-deliveries${suffix}`);
  }

  get(id: string): Promise<ShipWebhookDeliveryDetail> {
    return this.transport.request<ShipWebhookDeliveryDetail>('GET', `/api/v1/webhook-deliveries/${encodeURIComponent(id)}`);
  }

  replay(id: string): Promise<WebhookReplayResult> {
    return this.transport.request<WebhookReplayResult>('POST', `/api/v1/webhook-deliveries/${encodeURIComponent(id)}/replay`);
  }
}

/** Webhook subscription management (`/api/v1/webhooks`) + the delivery log. */
export class WebhooksClient {
  readonly deliveries: WebhookDeliveriesClient;

  constructor(private readonly transport: Transport) {
    this.deliveries = new WebhookDeliveriesClient(transport);
  }

  list(): Promise<DataList<ShipWebhookSubscription>> {
    return this.transport.request<DataList<ShipWebhookSubscription>>('GET', '/api/v1/webhooks');
  }

  get(id: string): Promise<ShipWebhookSubscription> {
    return this.transport.request<ShipWebhookSubscription>('GET', `/api/v1/webhooks/${encodeURIComponent(id)}`);
  }

  create(input: CreateWebhookSubscriptionInput): Promise<CreatedWebhookSubscription> {
    return this.transport.request<CreatedWebhookSubscription>('POST', '/api/v1/webhooks', input);
  }

  update(id: string, input: UpdateWebhookSubscriptionInput): Promise<ShipWebhookSubscription> {
    return this.transport.request<ShipWebhookSubscription>('PATCH', `/api/v1/webhooks/${encodeURIComponent(id)}`, input);
  }

  async delete(id: string): Promise<void> {
    await this.transport.request<null>('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`);
  }

  rotateSecret(id: string): Promise<CreatedWebhookSubscription> {
    return this.transport.request<CreatedWebhookSubscription>('POST', `/api/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`);
  }
}

export class ShipClient implements Transport {
  readonly documents: DocumentsClient;
  readonly wikiPages: TypedResourceClient<ShipWikiPage, CreateWikiPageInput, UpdateWikiPageInput>;
  readonly issues: TypedResourceClient<ShipIssue, CreateIssueInput, UpdateIssueInput>;
  readonly programs: TypedResourceClient<ShipProgram, CreateProgramInput, UpdateProgramInput>;
  readonly projects: TypedResourceClient<ShipProject, CreateProjectInput, UpdateProjectInput>;
  readonly sprints: TypedResourceClient<ShipSprint, CreateSprintInput, UpdateSprintInput>;
  readonly people: TypedResourceClient<ShipPerson, CreatePersonInput, UpdatePersonInput>;
  readonly weeklyPlans: TypedResourceClient<ShipWeeklyPlan, CreateWeeklyDocInput, UpdateWeeklyDocInput>;
  readonly weeklyRetros: TypedResourceClient<ShipWeeklyRetro, CreateWeeklyDocInput, UpdateWeeklyDocInput>;
  readonly standups: TypedResourceClient<ShipStandup, CreateStandupInput, UpdateStandupInput>;
  readonly weeklyReviews: TypedResourceClient<ShipWeeklyReview, CreateWeeklyReviewInput, UpdateWeeklyReviewInput>;
  readonly webhooks: WebhooksClient;

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
    this.fetchImpl = options.fetch ? fetchImpl : fetchImpl.bind(globalThis);

    this.documents = new DocumentsClient(this);
    this.wikiPages = new TypedResourceClient(this, 'wiki-pages');
    this.issues = new TypedResourceClient(this, 'issues');
    this.programs = new TypedResourceClient(this, 'programs');
    this.projects = new TypedResourceClient(this, 'projects');
    this.sprints = new TypedResourceClient(this, 'sprints');
    this.people = new TypedResourceClient(this, 'people');
    this.weeklyPlans = new TypedResourceClient(this, 'weekly-plans');
    this.weeklyRetros = new TypedResourceClient(this, 'weekly-retros');
    this.standups = new TypedResourceClient(this, 'standups');
    this.weeklyReviews = new TypedResourceClient(this, 'weekly-reviews');
    this.webhooks = new WebhooksClient(this);
  }

  /** GET /api/v1/me — the authenticated user + current workspace. */
  me(): Promise<AuthenticatedUser> {
    return this.request<AuthenticatedUser>('GET', '/api/v1/me');
  }

  /**
   * Device Authorization Grant (RFC 8628) end-to-end (PRD §2). Requests a device
   * code, invokes `onUserCode` so the consumer can display/open the verification
   * URL, polls at the server interval, persists the token via `store` (if given),
   * and resolves with an authenticated `ShipClient`.
   */
  static async deviceLogin(options: DeviceLoginOptions): Promise<ShipClient> {
    const auth = await requestDeviceAuthorization({
      clientId: options.clientId,
      baseUrl: options.baseUrl,
      scope: options.scope,
      fetch: options.fetch,
    });
    await options.onUserCode?.(auth);
    const token = await pollDeviceToken({
      clientId: options.clientId,
      baseUrl: options.baseUrl,
      deviceCode: auth.device_code,
      intervalSeconds: auth.interval,
      fetch: options.fetch,
      signal: options.signal,
      sleep: options.sleep,
    });
    await persistTokenSet(options.store, token);
    return new ShipClient({ token: token.access_token, baseUrl: options.baseUrl, fetch: options.fetch });
  }

  /**
   * Authorization Code + PKCE end-to-end (PRD §2) across three environments via
   * `redirect`: `'loopback'` (Node CLI/dev), `'browser'` (window.location +
   * storage, two-phase across the redirect), or a custom `AuthCodeRedirectAdapter`.
   * Persists the token via `store` (if given) and resolves with an authenticated
   * `ShipClient`.
   */
  static async authorizationCodeFlow(options: AuthorizationCodeFlowOptions): Promise<ShipClient> {
    const isBrowser = options.redirect === 'browser';
    const storage =
      options.storage ?? (isBrowser ? (globalThis as { localStorage?: NonNullable<AuthorizationCodeFlowOptions['storage']> }).localStorage : undefined);
    const loc = (globalThis as { location?: { search: string } }).location;
    const returningCode = isBrowser && loc ? new URLSearchParams(loc.search).get('code') : null;

    let pkce: PkcePair;
    let state: string;
    if (returningCode && storage) {
      // Returning leg of the browser redirect: restore the verifier + state.
      const verifier = storage.getItem(BROWSER_VERIFIER_KEY);
      if (!verifier) throw new Error('Missing PKCE verifier in storage; restart the authorization flow');
      pkce = { verifier, challenge: '', method: 'S256' };
      state = storage.getItem(BROWSER_STATE_KEY) ?? '';
    } else {
      pkce = await generatePkce();
      state = generateState();
      if (isBrowser && storage) {
        storage.setItem(BROWSER_VERIFIER_KEY, pkce.verifier);
        storage.setItem(BROWSER_STATE_KEY, state);
      }
    }

    const adapter: AuthCodeRedirectAdapter =
      typeof options.redirect === 'object'
        ? options.redirect
        : options.redirect === 'loopback'
          ? loopbackRedirectAdapter({ openBrowser: options.openBrowser })
          : browserRedirectAdapter(storage);

    const authUrl = buildAuthorizeUrl({
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      scope: options.scope,
      state,
      pkce,
    });

    const result = await adapter.authorize(authUrl, options.redirectUri);
    // We always send a generated `state`; the callback MUST echo it back. A
    // missing or differing `result.state` is treated as a mismatch (CSRF guard).
    if (state && result.state !== state) {
      throw new Error('OAuth state mismatch (possible CSRF); aborting');
    }

    const token = await exchangeAuthorizationCode({
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri,
      code: result.code,
      codeVerifier: pkce.verifier,
      fetch: resolveFetch(options.fetch),
    });

    if (isBrowser && storage) {
      storage.removeItem(BROWSER_VERIFIER_KEY);
      storage.removeItem(BROWSER_STATE_KEY);
    }
    await persistTokenSet(options.store, token);
    return new ShipClient({ token: token.access_token, baseUrl: options.baseUrl, fetch: options.fetch });
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      // Network failure (DNS, connection refused, abort): surface as a typed
      // server error rather than a raw fetch rejection (PRD §5).
      throw new ShipApiError(0, { code: 'network_error', message: (cause as Error)?.message ?? 'Network error' });
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) {
        throw new ShipApiError(res.status, { code: 'parse_error', message: 'Failed to parse response body' });
      }
    }

    if (!res.ok) {
      throw new ShipApiError(res.status, json as Partial<ApiErrorBody> | null, res.headers);
    }
    return json as T;
  }
}

// ── Auth helper option types (PRD §2) ───────────────────────────────────────

export interface DeviceLoginOptions {
  clientId: string;
  baseUrl?: string;
  scope?: string;
  fetch?: typeof fetch;
  /** Display/open callback — show the user_code + verification URL (or open it). */
  onUserCode?: (auth: DeviceAuthorization) => void | Promise<void>;
  /** Persist the resulting token set (e.g. FileTokenStore / LocalStorageTokenStore). */
  store?: ITokenStore;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

export interface AuthorizationCodeFlowOptions {
  clientId: string;
  /** Confidential clients exchange the code with their secret. Public PKCE clients omit it. */
  clientSecret?: string;
  redirectUri: string;
  baseUrl?: string;
  scope?: string;
  fetch?: typeof fetch;
  /** 'loopback' (Node), 'browser' (window.location), or a custom adapter. */
  redirect: 'loopback' | 'browser' | AuthCodeRedirectAdapter;
  /** Loopback only: open the authorize URL in a browser (default true). */
  openBrowser?: boolean;
  /** Browser only: storage for the PKCE verifier/state across the redirect. */
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  /** Persist the resulting token set. */
  store?: ITokenStore;
}

/** Persist an OAuth token response into a token store (no-op without a store). */
async function persistTokenSet(
  store: ITokenStore | undefined,
  token: {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  }
): Promise<void> {
  if (!store) return;
  const tokenSet: ShipTokenSet = {
    accessToken: token.access_token,
    tokenType: token.token_type,
    scope: token.scope,
    expiresAt: Date.now() + token.expires_in * 1000,
    refreshToken: token.refresh_token,
    refreshExpiresAt: token.refresh_token_expires_in ? Date.now() + token.refresh_token_expires_in * 1000 : undefined,
  };
  await store.set(tokenSet);
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
  refresh_token?: string;
  refresh_token_expires_in?: number;
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
  return injected ? impl : impl.bind(globalThis);
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

export interface RefreshAccessTokenOptions {
  clientId: string;
  refreshToken: string;
  /** Confidential clients must include their client secret. Public PKCE clients omit it. */
  clientSecret?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Persist the rotated token set. */
  store?: ITokenStore;
}

/** Exchange a rotating OAuth refresh token for a fresh access token. */
export async function refreshAccessToken(opts: RefreshAccessTokenOptions): Promise<DeviceTokenResponse> {
  if (!opts?.clientId || !opts.refreshToken) throw new Error('refreshAccessToken requires clientId and refreshToken');
  const fetchImpl = resolveFetch(opts.fetch);
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  };
  if (opts.clientSecret) body.client_secret = opts.clientSecret;

  const { ok, status, json } = await postOAuthJson(fetchImpl, baseUrl, '/api/oauth/token', body);
  if (!ok) {
    throw new DeviceFlowError(status, (json?.error as string) ?? 'refresh_failed', json?.error_description as string);
  }
  const token = json as unknown as DeviceTokenResponse;
  await persistTokenSet(opts.store, token);
  return token;
}

// Webhook signature verification (server-side; uses node:crypto).
export {
  verifyWebhook,
  signWebhookPayload,
  DEFAULT_TOLERANCE_SEC,
  type VerifyWebhookOptions,
  type WebhookHeaders,
} from './webhooks.js';

// Generated OpenAPI types (regenerate with `pnpm gen:types`). Consumers can use
// these as the authoritative wire contract; the hand-written interfaces above
// are kept in lockstep via `contract-types.ts`.
export type {
  paths as OpenApiPaths,
  components as OpenApiComponents,
  Schemas as OpenApiSchemas,
  Schema as OpenApiSchema,
} from './generated/index.js';

// Operation manifest + drift gate (see `contract.test.ts`).
export { OPERATION_MANIFEST, operationKey, type ManifestEntry } from './manifest.js';

// Token stores + OAuth flow adapters (PRD §2).
export {
  type ITokenStore,
  type ShipTokenSet,
  type WebStorageLike,
  MemoryTokenStore,
  FileTokenStore,
  LocalStorageTokenStore,
  coerceTokenSet,
} from './auth/token-store.js';
export {
  type AuthCodeRedirectAdapter,
  type AuthorizeResult,
  loopbackRedirectAdapter,
  browserRedirectAdapter,
} from './auth/flows.js';
export { generatePkce, generateState, type PkcePair } from './auth/pkce.js';

export default ShipClient;
