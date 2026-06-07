import { z } from 'zod';

const Uuid = z.string().uuid();
const DateTime = z.string();

export const CommentAuthorSchema = z.object({
  id: Uuid,
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const CommentSchema = z.object({
  id: Uuid,
  document_id: Uuid,
  /** Editor thread anchor id — groups replies into one inline thread. */
  comment_id: Uuid,
  parent_id: Uuid.nullable(),
  content: z.string(),
  resolved_at: DateTime.nullable(),
  author: CommentAuthorSchema,
  created_at: DateTime,
  updated_at: DateTime,
});

/** Document-scoped, unpaginated: a document's comment thread is small. */
export const CommentListSchema = z.object({
  data: z.array(CommentSchema),
});

export const CreateCommentSchema = z.object({
  content: z.string().min(1).max(10000),
  /** Thread anchor; server-generated when omitted (a fresh top-level thread). */
  comment_id: Uuid.optional(),
  /** Reply target — must be an existing comment on the same document. */
  parent_id: Uuid.optional(),
});
