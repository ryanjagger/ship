import { z } from 'zod';

const Uuid = z.string().uuid();
const DateTime = z.string();

/** A webhook subscription as returned by the API (never includes the secret). */
export const WebhookSubscriptionSchema = z.object({
  id: Uuid,
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  secret_fingerprint: z.string(),
  created_at: DateTime,
  updated_at: DateTime,
});

/** Create/rotate response — the raw `secret` is shown exactly once. */
export const CreatedWebhookSubscriptionSchema = WebhookSubscriptionSchema.extend({
  secret: z.string(),
});

export const CreateWebhookSubscriptionSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  active: z.boolean().optional().default(true),
});

export const UpdateWebhookSubscriptionSchema = z
  .object({
    url: z.string().url().optional(),
    events: z.array(z.string()).min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.url !== undefined || v.events !== undefined || v.active !== undefined, {
    message: 'At least one of url, events, or active must be provided',
  });

export const WebhookSubscriptionListSchema = z.object({
  data: z.array(WebhookSubscriptionSchema),
});

export const DeliveryStatusSchema = z.enum(['pending', 'delivered', 'failed', 'dead_lettered', 'replayed']);

export const WebhookDeliverySchema = z.object({
  id: Uuid,
  subscription_id: Uuid,
  event_id: z.string(),
  event_type: z.string(),
  status: DeliveryStatusSchema,
  attempt_count: z.number().int(),
  last_response_status: z.number().int().nullable(),
  last_response_body_excerpt: z.string().nullable(),
  last_error: z.string().nullable(),
  next_attempt_at: DateTime.nullable(),
  delivered_at: DateTime.nullable(),
  dead_lettered_at: DateTime.nullable(),
  replay_of_delivery_id: Uuid.nullable(),
  created_at: DateTime,
  updated_at: DateTime,
});

export const WebhookDeliveryAttemptSchema = z.object({
  id: Uuid,
  delivery_id: Uuid,
  subscription_id: Uuid,
  event_id: z.string(),
  attempt_number: z.number().int(),
  response_status: z.number().int().nullable(),
  response_body_excerpt: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  error: z.string().nullable(),
  sent_at: DateTime,
});

/** GET /webhook-deliveries/:id returns the delivery plus its attempt history. */
export const WebhookDeliveryDetailSchema = WebhookDeliverySchema.extend({
  attempts: z.array(WebhookDeliveryAttemptSchema),
});

export const WebhookDeliveryListSchema = z.object({
  data: z.array(WebhookDeliverySchema),
});

export const ListDeliveriesQuerySchema = z.object({
  subscription_id: Uuid.optional(),
  event_type: z.string().optional(),
  status: DeliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const ReplayResponseSchema = z.object({
  delivery_id: Uuid,
  replay_of_delivery_id: Uuid,
});
