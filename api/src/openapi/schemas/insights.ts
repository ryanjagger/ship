/**
 * Insight schemas (U4 — `/api/insights/*`).
 *
 * Mirrors the shipped `FleetInsight` / `InsightProperties` shapes in
 * `shared/src/types/document.ts`. The query schemas expose only the
 * `open|resolved|all` slice of `InsightStatus` (snoozed/dismissed are
 * substrate-only — see plan Scope Boundaries).
 */

import { z, registry } from '../registry.js';
import { UuidSchema, DateTimeSchema, ErrorResponseSchema } from './common.js';

// ============== Lifecycle / category enums ==============

export const InsightStatusSchema = z
  .enum(['open', 'resolved', 'snoozed', 'dismissed'])
  .openapi({
    description:
      "Full insight lifecycle state — substrate exposes 'snoozed'/'dismissed' but the v1 UI surfaces only open/resolved.",
  });

registry.register('InsightStatus', InsightStatusSchema);

export const InsightStateQuerySchema = z
  .enum(['open', 'resolved', 'all'])
  .openapi({
    description:
      "State filter for list/count queries. 'all' drops the state predicate.",
  });

registry.register('InsightStateQuery', InsightStateQuerySchema);

export const InsightKindSchema = z.enum(['project_drift']).openapi({
  description: 'Detector kind. v1 only produces project_drift insights.',
});

registry.register('InsightKind', InsightKindSchema);

export const InsightSeveritySchema = z.enum(['fyi', 'act']).openapi({
  description:
    "Severity bucket. 'act' indicates the user should take action; 'fyi' is informational.",
});

registry.register('InsightSeverity', InsightSeveritySchema);

export const InsightVerdictDecisionSchema = z
  .enum(['SUPPRESS', 'SURFACE_FYI', 'SURFACE_ACT'])
  .openapi({ description: 'Authoring decision for the underlying detection.' });

export const InsightVerdictSchema = z
  .object({
    decision: InsightVerdictDecisionSchema,
    reasoning: z.string(),
  })
  .openapi('InsightVerdict');

registry.register('InsightVerdict', InsightVerdictSchema);

// ============== Properties + read shape ==============

export const InsightPropertiesSchema = z
  .object({
    state: InsightStatusSchema,
    kind: InsightKindSchema,
    severity: InsightSeveritySchema,
    subject_id: UuidSchema,
    subject_entity_type: z.string(),
    summary: z.string(),
    recommended_action: z.string(),
    evidence: z.record(z.unknown()),
    verdict: InsightVerdictSchema,
    input_hash: z.string(),
    accountable_owner_id: UuidSchema.nullable(),
    first_seen_at: DateTimeSchema,
    last_seen_at: DateTimeSchema,
    last_changed_at: DateTimeSchema,
    occurrence_count: z.number().int(),
    resolved_at: DateTimeSchema.nullable(),
    resolved_reason: z.string().nullable(),
    snoozed_until: DateTimeSchema.nullable(),
    dismissed_at: DateTimeSchema.nullable(),
    dismissed_by: UuidSchema.nullable(),
  })
  .openapi('InsightProperties');

registry.register('InsightProperties', InsightPropertiesSchema);

export const FleetInsightSchema = z
  .object({
    id: UuidSchema,
    workspace_id: UuidSchema,
    title: z.string(),
    created_at: DateTimeSchema,
    insight: InsightPropertiesSchema,
    subject_id: UuidSchema,
    subject_title: z.string(),
    subject_document_type: z.string().openapi({
      description: 'document_type of the joined subject (e.g. "project").',
    }),
  })
  .openapi('FleetInsight');

registry.register('FleetInsight', FleetInsightSchema);

// ============== Query / body schemas ==============

export const InsightListQuerySchema = z
  .object({
    state: InsightStateQuerySchema.optional().default('open'),
    kind: InsightKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi('InsightListQuery');

registry.register('InsightListQuery', InsightListQuerySchema);

export const InsightCountQuerySchema = z
  .object({
    state: InsightStateQuerySchema.optional().default('open'),
    kind: InsightKindSchema.optional(),
  })
  .openapi('InsightCountQuery');

registry.register('InsightCountQuery', InsightCountQuerySchema);

export const InsightResolveBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .openapi('InsightResolveBody');

registry.register('InsightResolveBody', InsightResolveBodySchema);

// ============== Sweep response ==============

export const SweepResultSchema = z
  .object({
    workspaceId: UuidSchema,
    scanned: z.number().int(),
    created: z.number().int(),
    refreshed: z.number().int(),
    skipped: z.number().int(),
  })
  .openapi('SweepResult');

registry.register('SweepResult', SweepResultSchema);

export const SweepEndpointResponseSchema = SweepResultSchema.openapi(
  'SweepEndpointResponse'
);

registry.register('SweepEndpointResponse', SweepEndpointResponseSchema);

// ============== Endpoint registration ==============

registry.registerPath({
  method: 'get',
  path: '/insights',
  tags: ['Insights'],
  summary: 'List insights',
  description:
    'Visibility-scoped list of insights for the current workspace. Filter by state (default open), kind, with offset/limit pagination.',
  request: { query: InsightListQuerySchema },
  responses: {
    200: {
      description: 'List of insights',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(FleetInsightSchema) }),
        },
      },
    },
    400: {
      description: 'Invalid query parameters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/insights/count',
  tags: ['Insights'],
  summary: 'Count insights',
  description:
    'Lightweight COUNT query reusing the same visibility-scoped shape as the list endpoint. Drives the rail badge.',
  request: { query: InsightCountQuerySchema },
  responses: {
    200: {
      description: 'Count of matching insights',
      content: {
        'application/json': {
          schema: z.object({ count: z.number().int() }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/insights/{id}',
  tags: ['Insights'],
  summary: 'Get insight by ID',
  request: { params: z.object({ id: UuidSchema }) },
  responses: {
    200: {
      description: 'Insight',
      content: { 'application/json': { schema: FleetInsightSchema } },
    },
    404: {
      description: 'Insight not found or not visible',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/insights/{id}/resolve',
  tags: ['Insights'],
  summary: 'Resolve insight',
  description:
    'Idempotent transition to state=resolved. Returns priorState (the state before the call) and didResolve (true if this call actually transitioned the row).',
  request: {
    params: z.object({ id: UuidSchema }),
    body: {
      content: { 'application/json': { schema: InsightResolveBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Resolve outcome',
      content: {
        'application/json': {
          schema: z.object({
            priorState: InsightStatusSchema.nullable(),
            didResolve: z.boolean(),
          }),
        },
      },
    },
    404: {
      description: 'Insight not found or not visible',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/insights/sweep',
  tags: ['Insights'],
  summary: 'Trigger manual workspace drift sweep',
  description:
    'Workspace-admin only. Runs the drift sweep for the caller workspace under a non-blocking advisory lock; returns 409 when another sweep is in flight.',
  responses: {
    200: {
      description: 'Sweep result',
      content: {
        'application/json': { schema: SweepEndpointResponseSchema },
      },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Another sweep is already in flight',
      content: {
        'application/json': {
          schema: z.object({ error: z.literal('sweep_in_progress') }),
        },
      },
    },
  },
});
