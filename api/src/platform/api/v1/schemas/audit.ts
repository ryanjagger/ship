import { z } from 'zod';

const Uuid = z.string().uuid();
const DateTime = z.string();

/** One authenticated /api/v1 request (no bodies, tokens, or secrets — PRD §7). */
export const AuditLogEntrySchema = z.object({
  id: Uuid,
  created_at: DateTime,
  client_id: z.string().nullable(),
  app_id: Uuid.nullable(),
  token_id: Uuid.nullable(),
  user_id: Uuid.nullable(),
  workspace_id: Uuid.nullable(),
  method: z.string(),
  route: z.string(),
  scope: z.string().nullable(),
  status: z.number().int(),
  latency_ms: z.number().int(),
  request_id: z.string().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
});

export const AuditQuerySchema = z.object({
  app_id: Uuid.optional(),
  user_id: Uuid.optional(),
  route: z.string().optional(),
  status_class: z.coerce.number().int().refine((v): v is 2 | 3 | 4 | 5 => [2, 3, 4, 5].includes(v), { message: 'status_class must be 2, 3, 4, or 5' }).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /**
   * Hide one client's traffic (e.g. the Developer Portal excludes its own calls
   * by default so the audit view isn't a feedback loop of itself).
   */
  exclude_client_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const AuditLogListSchema = z.object({
  data: z.array(AuditLogEntrySchema),
  total: z.number().int(),
});
