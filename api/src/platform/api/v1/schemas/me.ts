import { z } from 'zod';

/**
 * Public shape for GET /api/v1/me (PRD §5.5a). A small typed user + the current
 * workspace, in the public contract style — NOT the internal /api/auth/me
 * `success/data` envelope. Backs the SDK's `.me()`.
 */
export const MeWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: z.string(),
});

export const MeResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email().optional(),
  workspace: MeWorkspaceSchema,
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
