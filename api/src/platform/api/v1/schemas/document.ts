import { z } from 'zod';

/**
 * Zod schemas for the public `documents` resource (PRD §5.5), adjacent to the
 * handlers so the OpenAPI 3.1 generator (Phase 8) derives the contract from the
 * same source the routes validate against.
 *
 * The public document_type set is exactly Ship's user-facing types — the
 * backing-store types (`conversation`, `insight`) are intentionally absent, so
 * a client can neither receive them in a list nor create one.
 */
export const PublicDocumentTypeSchema = z.enum([
  'wiki',
  'issue',
  'program',
  'project',
  'sprint',
  'person',
  'weekly_plan',
  'weekly_retro',
  'standup',
  'weekly_review',
]);

export const DocumentSummarySchema = z.object({
  id: z.string().uuid(),
  document_type: z.string(),
  title: z.string(),
  parent_id: z.string().uuid().nullable(),
  ticket_number: z.number().int().nullable(),
  visibility: z.string(),
  properties: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string().uuid().nullable(),
});

export const DocumentDetailSchema = DocumentSummarySchema.extend({
  content: z.unknown().nullable(),
});

export const DocumentListResponseSchema = z.object({
  data: z.array(DocumentSummarySchema),
  next_cursor: z.string().nullable(),
});

export const ListDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
  type: PublicDocumentTypeSchema.optional(),
});

export const CreateDocumentSchema = z.object({
  title: z.string().min(1).max(255).optional().default('Untitled'),
  document_type: PublicDocumentTypeSchema.optional().default('wiki'),
  parent_id: z.string().uuid().nullable().optional(),
  properties: z.record(z.unknown()).optional(),
  visibility: z.enum(['private', 'workspace']).optional(),
  content: z.unknown().optional(),
});

export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;
