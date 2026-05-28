/**
 * Workspace settings schemas (U4) — typed accessors over the
 * `workspaces.settings` JSONB column. Only the FleetGraph namespace is
 * exposed via REST today; future namespaces (`notifications.*`, etc.) can
 * add additional sub-routes here.
 */

import { z, registry } from '../registry.js';
import { ErrorResponseSchema } from './common.js';

export const FleetgraphSettingsSchema = z
  .object({
    sweepEnabled: z.boolean().openapi({
      description: 'Whether the per-workspace drift sweep is enabled.',
    }),
    llmVerdictsEnabled: z.boolean().openapi({
      description:
        'Whether the sweep uses LLM-generated verdicts (vs the deterministic templated verdict). Independent of sweepEnabled.',
    }),
  })
  .openapi('FleetgraphSettings');

registry.register('FleetgraphSettings', FleetgraphSettingsSchema);

/**
 * PATCH body — partial update. Either `sweepEnabled`, `llmVerdictsEnabled`,
 * or both may be supplied. At least one key MUST be present; an empty body
 * is rejected with 400 via the `.refine()` below. Independence between the
 * keys is by design — admins can flip one without disturbing the other.
 */
export const FleetgraphSettingsUpdateBodySchema = z
  .object({
    sweepEnabled: z.boolean().optional(),
    llmVerdictsEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.sweepEnabled !== undefined || body.llmVerdictsEnabled !== undefined,
    {
      message:
        'At least one of sweepEnabled or llmVerdictsEnabled must be provided.',
    }
  )
  .openapi('FleetgraphSettingsUpdateBody');

registry.register('FleetgraphSettingsUpdateBody', FleetgraphSettingsUpdateBodySchema);

registry.registerPath({
  method: 'get',
  path: '/workspaces/settings/fleetgraph',
  tags: ['Workspaces'],
  summary: 'Get FleetGraph settings for the current workspace',
  description:
    'Returns the FleetGraph-namespaced settings. Available to any workspace member.',
  responses: {
    200: {
      description: 'FleetGraph settings',
      content: {
        'application/json': { schema: FleetgraphSettingsSchema },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/workspaces/settings/fleetgraph',
  tags: ['Workspaces'],
  summary: 'Update FleetGraph settings for the current workspace',
  description:
    'Workspace-admin only. Accepts a partial body to toggle the sweep gate, the LLM-verdicts gate, or both independently. At least one field is required (empty body returns 400).',
  request: {
    body: {
      content: {
        'application/json': { schema: FleetgraphSettingsUpdateBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated FleetGraph settings',
      content: {
        'application/json': { schema: FleetgraphSettingsSchema },
      },
    },
    403: {
      description: 'Workspace admin access required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
