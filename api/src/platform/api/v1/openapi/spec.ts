import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { MeResponseSchema } from '../schemas/me.js';
import {
  DocumentSummarySchema,
  DocumentDetailSchema,
  DocumentListResponseSchema,
  CreateDocumentSchema,
  ListDocumentsQuerySchema,
} from '../schemas/document.js';
import {
  TYPED_DOCUMENT_RESOURCES,
  TypedDocumentListQuerySchema,
} from '../schemas/typed-document.js';
import { ApiErrorSchema } from '../schemas/error.js';
import {
  WebhookSubscriptionSchema,
  CreatedWebhookSubscriptionSchema,
  CreateWebhookSubscriptionSchema,
  UpdateWebhookSubscriptionSchema,
  WebhookSubscriptionListSchema,
  WebhookDeliverySchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliveryListSchema,
  ListDeliveriesQuerySchema,
  ReplayResponseSchema,
} from '../schemas/webhook.js';

/**
 * The Platform API OpenAPI 3.1 spec (PRD §5.7). Generated in-process from the
 * SAME Zod schemas the routes validate against — never hand-written — using a
 * SEPARATE registry + `OpenApiGeneratorV31` (the existing 3.0 spec at
 * /api/openapi.json uses its own registry + V3 generator; we don't reuse it).
 */

extendZodWithOpenApi(z);

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'OAuth 2.0 access token obtained via Authorization Code + PKCE. Send as `Authorization: Bearer <token>`.',
  });

  const ApiError = registry.register('ApiError', ApiErrorSchema);
  const MeResponse = registry.register('MeResponse', MeResponseSchema);
  const DocumentSummary = registry.register('DocumentSummary', DocumentSummarySchema);
  const DocumentDetail = registry.register('DocumentDetail', DocumentDetailSchema);
  const DocumentListResponse = registry.register('DocumentListResponse', DocumentListResponseSchema);
  const CreateDocument = registry.register('CreateDocument', CreateDocumentSchema);
  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: ApiError } },
  });

  registry.registerPath({
    method: 'get',
    path: '/me',
    tags: ['me'],
    summary: 'Get the authenticated user and current workspace',
    description: 'Auth-only: requires a valid access token but **no scope**.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The authenticated user', content: { 'application/json': { schema: MeResponse } } },
      401: errorResponse('Missing, invalid, or expired token'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/documents',
    tags: ['documents'],
    summary: 'List documents',
    description:
      'Requires scope `documents:read` (the broadest read scope). Returns any user-facing document_type; backing-store types are excluded. Paginated via an opaque `next_cursor`.',
    security: [{ bearerAuth: [] }],
    request: { query: ListDocumentsQuerySchema },
    responses: {
      200: { description: 'A page of documents', content: { 'application/json': { schema: DocumentListResponse } } },
      400: errorResponse('Invalid query parameters'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (documents:read)'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/documents/{id}',
    tags: ['documents'],
    summary: 'Get a document by id',
    description: 'Requires scope `documents:read`.',
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'The document', content: { 'application/json': { schema: DocumentDetail } } },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (documents:read)'),
      404: errorResponse('Document not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/documents',
    tags: ['documents'],
    summary: 'Create a document',
    description: 'Requires scope `documents:write`.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CreateDocument } } } },
    responses: {
      201: { description: 'The created document', content: { 'application/json': { schema: DocumentDetail } } },
      400: errorResponse('Invalid document'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (documents:write)'),
    },
  });

  for (const resource of TYPED_DOCUMENT_RESOURCES) {
    const tag = resource.path;
    const readScopes = `\`${resource.readScope}\` or broad superscope \`documents:read\``;
    const writeScopes = `\`${resource.writeScope}\` or broad superscope \`documents:write\``;
    const ResponseSchema = registry.register(resource.name, resource.responseSchema);
    const ListResponseSchema = registry.register(`${resource.name}ListResponse`, resource.listResponseSchema);
    const CreateSchema = registry.register(`Create${resource.name}`, resource.createSchema);
    const UpdateSchema = registry.register(`Update${resource.name}`, resource.updateSchema);

    registry.registerPath({
      method: 'get',
      path: `/${resource.path}`,
      tags: [tag],
      summary: `List ${resource.description.toLowerCase()}`,
      description: `Requires ${readScopes}. Returns only rows backed by document_type=\`${resource.documentType}\`.`,
      security: [{ bearerAuth: [] }],
      request: { query: TypedDocumentListQuerySchema },
      responses: {
        200: {
          description: `A page of ${resource.description.toLowerCase()}`,
          content: { 'application/json': { schema: ListResponseSchema } },
        },
        400: errorResponse('Invalid query parameters'),
        401: errorResponse('Unauthorized'),
        403: errorResponse(`Insufficient scope (${resource.readScope} or documents:read)`),
      },
    });

    registry.registerPath({
      method: 'get',
      path: `/${resource.path}/{id}`,
      tags: [tag],
      summary: `Get a ${resource.name}`,
      description: `Requires ${readScopes}.`,
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: `The ${resource.name}`, content: { 'application/json': { schema: ResponseSchema } } },
        401: errorResponse('Unauthorized'),
        403: errorResponse(`Insufficient scope (${resource.readScope} or documents:read)`),
        404: errorResponse(`${resource.name} not found`),
      },
    });

    registry.registerPath({
      method: 'post',
      path: `/${resource.path}`,
      tags: [tag],
      summary: `Create a ${resource.name}`,
      description: `Requires ${writeScopes}. The route fixes document_type to \`${resource.documentType}\`; clients do not send document_type.`,
      security: [{ bearerAuth: [] }],
      request: { body: { content: { 'application/json': { schema: CreateSchema } } } },
      responses: {
        201: { description: `The created ${resource.name}`, content: { 'application/json': { schema: ResponseSchema } } },
        400: errorResponse(`Invalid ${resource.name}`),
        401: errorResponse('Unauthorized'),
        403: errorResponse(`Insufficient scope (${resource.writeScope} or documents:write)`),
      },
    });

    registry.registerPath({
      method: 'patch',
      path: `/${resource.path}/{id}`,
      tags: [tag],
      summary: `Update a ${resource.name}`,
      description: `Requires ${writeScopes}.`,
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { 'application/json': { schema: UpdateSchema } } },
      },
      responses: {
        200: { description: `The updated ${resource.name}`, content: { 'application/json': { schema: ResponseSchema } } },
        400: errorResponse(`Invalid ${resource.name}`),
        401: errorResponse('Unauthorized'),
        403: errorResponse(`Insufficient scope (${resource.writeScope} or documents:write)`),
        404: errorResponse(`${resource.name} not found`),
      },
    });

    registry.registerPath({
      method: 'delete',
      path: `/${resource.path}/{id}`,
      tags: [tag],
      summary: `Delete a ${resource.name}`,
      description: `Requires ${writeScopes}.`,
      security: [{ bearerAuth: [] }],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: `${resource.name} deleted` },
        401: errorResponse('Unauthorized'),
        403: errorResponse(`Insufficient scope (${resource.writeScope} or documents:write)`),
        404: errorResponse(`${resource.name} not found`),
      },
    });
  }

  // ── Webhooks ────────────────────────────────────────────────────────────
  const WebhookSubscription = registry.register('WebhookSubscription', WebhookSubscriptionSchema);
  const CreatedWebhookSubscription = registry.register('CreatedWebhookSubscription', CreatedWebhookSubscriptionSchema);
  const CreateWebhookSubscription = registry.register('CreateWebhookSubscription', CreateWebhookSubscriptionSchema);
  const UpdateWebhookSubscription = registry.register('UpdateWebhookSubscription', UpdateWebhookSubscriptionSchema);
  const WebhookSubscriptionList = registry.register('WebhookSubscriptionList', WebhookSubscriptionListSchema);
  const WebhookDelivery = registry.register('WebhookDelivery', WebhookDeliverySchema);
  const WebhookDeliveryDetail = registry.register('WebhookDeliveryDetail', WebhookDeliveryDetailSchema);
  const WebhookDeliveryList = registry.register('WebhookDeliveryList', WebhookDeliveryListSchema);
  const ReplayResponse = registry.register('WebhookReplayResponse', ReplayResponseSchema);
  const webhookSecurity = [{ bearerAuth: [] }];
  const webhookScopeNote = 'Requires scope `webhooks:manage`. Subscribing to an event family also requires its read scope.';

  registry.registerPath({
    method: 'get',
    path: '/webhooks',
    tags: ['webhooks'],
    summary: 'List webhook subscriptions',
    description: 'Requires scope `webhooks:manage`.',
    security: webhookSecurity,
    responses: {
      200: { description: 'The app\'s webhook subscriptions', content: { 'application/json': { schema: WebhookSubscriptionList } } },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/webhooks',
    tags: ['webhooks'],
    summary: 'Create a webhook subscription',
    description: `${webhookScopeNote} The raw signing \`secret\` is returned ONLY here and on rotation.`,
    security: webhookSecurity,
    request: { body: { content: { 'application/json': { schema: CreateWebhookSubscription } } } },
    responses: {
      201: { description: 'The created subscription (with one-time secret)', content: { 'application/json': { schema: CreatedWebhookSubscription } } },
      400: errorResponse('Invalid subscription or unknown event type'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage or a required read scope)'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/webhooks/{id}',
    tags: ['webhooks'],
    summary: 'Get a webhook subscription',
    description: 'Requires scope `webhooks:manage`.',
    security: webhookSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'The subscription', content: { 'application/json': { schema: WebhookSubscription } } },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
      404: errorResponse('Subscription not found'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/webhooks/{id}',
    tags: ['webhooks'],
    summary: 'Update a webhook subscription',
    description: webhookScopeNote,
    security: webhookSecurity,
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: { content: { 'application/json': { schema: UpdateWebhookSubscription } } },
    },
    responses: {
      200: { description: 'The updated subscription', content: { 'application/json': { schema: WebhookSubscription } } },
      400: errorResponse('Invalid subscription or unknown event type'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage or a required read scope)'),
      404: errorResponse('Subscription not found'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/webhooks/{id}',
    tags: ['webhooks'],
    summary: 'Delete a webhook subscription',
    description: 'Requires scope `webhooks:manage`.',
    security: webhookSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      204: { description: 'Subscription deleted' },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
      404: errorResponse('Subscription not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/webhooks/{id}/rotate-secret',
    tags: ['webhooks'],
    summary: 'Rotate a webhook signing secret',
    description: `${webhookScopeNote} Returns a new one-time \`secret\`; the previous secret stops signing immediately.`,
    security: webhookSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'The subscription with a fresh one-time secret', content: { 'application/json': { schema: CreatedWebhookSubscription } } },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
      404: errorResponse('Subscription not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/webhook-deliveries',
    tags: ['webhooks'],
    summary: 'List webhook deliveries',
    description: 'Requires scope `webhooks:manage`. Filter by subscription, event type, and status.',
    security: webhookSecurity,
    request: { query: ListDeliveriesQuerySchema },
    responses: {
      200: { description: 'A page of deliveries', content: { 'application/json': { schema: WebhookDeliveryList } } },
      400: errorResponse('Invalid query parameters'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/webhook-deliveries/{id}',
    tags: ['webhooks'],
    summary: 'Get a webhook delivery with attempt history',
    description: 'Requires scope `webhooks:manage`.',
    security: webhookSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'The delivery and its attempts', content: { 'application/json': { schema: WebhookDeliveryDetail } } },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
      404: errorResponse('Delivery not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/webhook-deliveries/{id}/replay',
    tags: ['webhooks'],
    summary: 'Replay a webhook delivery',
    description: 'Requires scope `webhooks:manage`. Re-sends the original event (same idempotency key) as a new linked delivery with a fresh signature timestamp.',
    security: webhookSecurity,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      202: { description: 'A new replay delivery was created', content: { 'application/json': { schema: ReplayResponse } } },
      401: errorResponse('Unauthorized'),
      403: errorResponse('Insufficient scope (webhooks:manage)'),
      404: errorResponse('Delivery not found'),
    },
  });

  return registry;
}

let cached: ReturnType<OpenApiGeneratorV31['generateDocument']> | null = null;

export function generateV1OpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ship Platform API',
      version: '1.0.0',
      description:
        'Public Platform API (v1) — OAuth 2.0 Authorization Code + PKCE with scopes. See the README for the token quickstart.',
    },
    servers: [{ url: '/api/v1', description: 'Platform API v1' }],
  });
  return cached;
}
