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
import { ApiErrorSchema } from '../schemas/error.js';

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
