import { z } from 'zod';

const Uuid = z.string().uuid();
const DateTime = z.string();

/**
 * A connected app: one row per (app, user) pair holding at least one live
 * access token in the workspace (see platform/oauth/connections.ts).
 */
export const ConnectionSchema = z.object({
  app_id: Uuid,
  client_id: z.string(),
  app_name: z.string(),
  is_system: z.boolean(),
  user_id: Uuid,
  user_email: z.string(),
  user_name: z.string(),
  scopes: z.array(z.string()),
  active_token_count: z.number().int(),
  first_authorized_at: DateTime,
  last_used_at: DateTime.nullable(),
  expires_at: DateTime,
});

export const ConnectionListSchema = z.object({
  data: z.array(ConnectionSchema),
});

export const RevokeConnectionResponseSchema = z.object({
  tokens_revoked: z.number().int(),
});
