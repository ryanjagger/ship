import { z } from 'zod';

const Uuid = z.string().uuid();
const DateTime = z.string();

/**
 * `document_id` is repeatable (`?document_id=a&document_id=b`, cap 100) so an
 * activity feed over N documents is ONE request, not N. Express parses the
 * repeated param to an array; a single occurrence arrives as a string.
 */
export const DocumentHistoryQuerySchema = z.object({
  document_id: z
    .union([Uuid, z.array(Uuid).min(1).max(100)])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  field: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const DocumentHistoryEntrySchema = z.object({
  id: z.number().int(),
  document_id: Uuid,
  field: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  changed_by: Uuid.nullable(),
  /** Automated change source: an OAuth client_id for agent edits, null for humans. */
  automated_by: z.string().nullable(),
  created_at: DateTime,
});

export const DocumentHistoryListSchema = z.object({
  data: z.array(DocumentHistoryEntrySchema),
});
