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
