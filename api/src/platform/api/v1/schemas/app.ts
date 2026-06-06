import { z } from 'zod';

const Uuid = z.string().uuid();
const DateTime = z.string();

/**
 * An OAuth app as returned by the admin surface (`apps:manage`). Never includes
 * the secret hash; the raw `client_secret` appears only in the create/rotate
 * responses (one-time secret semantics, PRD §5.2).
 */
export const OAuthAppSchema = z.object({
  id: Uuid,
  client_id: z.string(),
  name: z.string(),
  redirect_uris: z.array(z.string()),
  owner_user_id: Uuid.nullable(),
  requested_scopes: z.array(z.string()),
  client_type: z.enum(['public', 'confidential']),
  allow_device_flow: z.boolean(),
  is_system: z.boolean(),
  owner_email: z.string().nullable(),
  owner_name: z.string().nullable(),
  created_at: DateTime,
  updated_at: DateTime,
});

export const OAuthAppListSchema = z.object({
  data: z.array(OAuthAppSchema),
});

export const CreateOAuthAppSchema = z
  .object({
    name: z.string().min(1).max(120),
    redirect_uris: z.array(z.string().url()).default([]),
    requested_scopes: z.array(z.string()).default([]),
    client_type: z.enum(['public', 'confidential']).default('confidential'),
    allow_device_flow: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.allow_device_flow && data.redirect_uris.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['redirect_uris'],
        message: 'At least one redirect URI is required unless allow_device_flow is enabled',
      });
    }
  });

/**
 * Create/rotate response. `client_secret` (confidential clients only) is shown
 * exactly once and never recoverable; `warning` spells that out for UIs.
 */
export const CreatedOAuthAppSchema = z.object({
  id: Uuid,
  client_id: z.string(),
  client_secret: z.string().optional(),
  name: z.string(),
  redirect_uris: z.array(z.string()),
  requested_scopes: z.array(z.string()),
  client_type: z.enum(['public', 'confidential']),
  allow_device_flow: z.boolean(),
  warning: z.string(),
});
