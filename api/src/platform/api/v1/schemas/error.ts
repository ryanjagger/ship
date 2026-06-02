import { z } from 'zod';

/**
 * Zod mirror of the ApiError contract (see ../errors.ts), used to document the
 * error shape in the generated OpenAPI 3.1 spec.
 */
export const ApiErrorSchema = z.object({
  code: z.enum(['unauthorized', 'forbidden', 'not_found', 'validation_failed', 'rate_limited', 'server_error']),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  request_id: z.string(),
});
