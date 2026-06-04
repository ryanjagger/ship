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
    this.fetchImpl = fetchImpl;

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

// Webhook signature verification (server-side; uses node:crypto).
export {
  verifyWebhook,
  signWebhookPayload,
  DEFAULT_TOLERANCE_SEC,
  type VerifyWebhookOptions,
  type WebhookHeaders,
} from './webhooks.js';

export default ShipClient;
