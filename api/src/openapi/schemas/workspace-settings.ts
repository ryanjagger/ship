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
  })
  .openapi('FleetgraphSettings');

registry.register('FleetgraphSettings', FleetgraphSettingsSchema);

export const FleetgraphSettingsUpdateBodySchema = z
  .object({
    sweepEnabled: z.boolean(),
  })
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
  description: 'Workspace-admin only. Toggles the per-workspace sweep gate.',
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
