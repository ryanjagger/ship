/**
 * Fleet schemas — Project Plan Review (on-demand plan testability + retro recommendation).
 */

import { z, registry } from '../registry.js';
import { UuidSchema } from './common.js';

const FleetFindingSchema = z.object({
  id: z.string(),
  label: z.string(),
  message: z.string(),
});

export const FleetPlanReviewSchema = z
  .object({
    status: z.enum(['no_plan', 'needs_work', 'looks_testable']),
    score: z.number().int().nullable().openapi({
      description: 'Count of rubric criteria met (0–7) when AI-scored; null in deterministic-only mode',
    }),
    findings: z.array(FleetFindingSchema),
    suggested_rewrite: z.string().nullable(),
    ai_available: z.boolean(),
    computed_at: z.string().optional(),
  })
  .openapi('FleetPlanReview');

export const FleetRetroRecommendationSchema = z
  .object({
    recommendation: z.enum(['validated_recommended', 'invalidated_recommended', 'insufficient_evidence']),
    explanation: z.string(),
    evidence_found: z.array(z.string()),
    evidence_missing: z.array(z.string()),
    suggested_conclusion: z.string().nullable(),
    ai_available: z.boolean(),
    computed_at: z.string().optional(),
  })
  .openapi('FleetRetroRecommendation');

export const FleetReviewResponseSchema = z
  .object({
    plan_review: FleetPlanReviewSchema,
    retro_recommendation: FleetRetroRecommendationSchema,
    ai_available: z.boolean(),
  })
  .openapi('FleetReviewResponse');

registry.register('FleetReviewResponse', FleetReviewResponseSchema);

registry.registerPath({
  method: 'get',
  path: '/projects/{id}/fleet/plan-review',
  tags: ['Fleet'],
  summary: 'Get Fleet plan review',
  description:
    'Reviews the project Plan for testability and returns a retro recommendation. Free deterministic checks always run; an AI provider (when configured) adds rubric scoring. Results are cached per input hash on the project.',
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'Fleet plan review and retro recommendation',
      content: { 'application/json': { schema: FleetReviewResponseSchema } },
    },
    404: { description: 'Project not found or not visible' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/projects/{id}/fleet/plan-review/refresh',
  tags: ['Fleet'],
  summary: 'Force-refresh Fleet plan review',
  description:
    'Forces a fresh AI evaluation, bypassing the input-hash cache. Rate-limited per user.',
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'Refreshed Fleet plan review and retro recommendation',
      content: { 'application/json': { schema: FleetReviewResponseSchema } },
    },
    404: { description: 'Project not found or not visible' },
    429: { description: 'Refresh rate limit exceeded' },
  },
});
