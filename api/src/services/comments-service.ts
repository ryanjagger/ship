/**
 * Comments service (U6).
 *
 * Core of `POST /api/documents/:id/comments`, extracted out of the route into a
 * `FleetContext`-taking function shared by the HTTP route and the FleetGraph
 * `post_comment` write tool — single source of truth, no privileged agent path.
 *
 * The original comment-post path is a sequence of independent single statements
 * (document existence check → optional parent check → INSERT → author lookup),
 * NOT a multi-statement transaction, so this mirrors that exactly: it runs on a
 * query runner (the shared `pool` by default) and returns a discriminated
 * `ServiceResult` carrying the HTTP status + body the route used to send inline
 * (404 document-not-found, 404 parent-not-found, 201 created). Behavior is
 * preserved bit-for-bit.
 *
 * Authorization note: the original route only scoped by `workspace_id` (no
 * VISIBILITY_FILTER_SQL on the target document). We preserve that exact posture
 * so the refactor changes nothing; the write tool layer adds the visibility
 * gate it needs on top (see tools/write.ts) rather than silently widening or
 * narrowing the route's behavior here.
 */

import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/client.js';
import type { FleetContext } from './fleet-service.js';

export type { FleetContext };

type QueryRunner = Pool | PoolClient;

export interface ServiceResult<T> {
  status: number;
  body: T;
}

export interface PostCommentInput {
  comment_id: string;
  content: string;
  parent_id?: string;
}

interface CommentResponse {
  id: string;
  document_id: string;
  comment_id: string;
  parent_id: string | null;
  content: string;
  resolved_at: string | null;
  author: { id: string; name: string; email: string };
  created_at: string;
  updated_at: string;
}

/**
 * Core of `POST /api/documents/:id/comments`.
 *
 * @param runner  pg pool or client (route passes the shared pool).
 * @param ctx     the requesting user's FleetContext (workspace + user scope).
 * @param documentId  the target document.
 * @param input   validated comment input.
 */
export async function postCommentCore(
  runner: QueryRunner,
  ctx: FleetContext,
  documentId: string,
  input: PostCommentInput
): Promise<ServiceResult<CommentResponse | { error: string }>> {
  const { comment_id, content, parent_id } = input;

  // Verify document exists in the workspace.
  const docCheck = await runner.query(
    'SELECT id FROM documents WHERE id = $1 AND workspace_id = $2',
    [documentId, ctx.workspaceId]
  );
  if (docCheck.rows.length === 0) {
    return { status: 404, body: { error: 'Document not found' } };
  }

  // If replying, verify the parent exists and belongs to the same document.
  if (parent_id) {
    const parentCheck = await runner.query(
      'SELECT id FROM comments WHERE id = $1 AND document_id = $2',
      [parent_id, documentId]
    );
    if (parentCheck.rows.length === 0) {
      return { status: 404, body: { error: 'Parent comment not found' } };
    }
  }

  const result = await runner.query(
    `INSERT INTO comments (document_id, comment_id, parent_id, author_id, workspace_id, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
    [documentId, comment_id, parent_id || null, ctx.userId, ctx.workspaceId, content]
  );
  const comment = result.rows[0];

  const authorResult = await runner.query(
    'SELECT id, name, email FROM users WHERE id = $1',
    [ctx.userId]
  );
  const author = authorResult.rows[0];

  return {
    status: 201,
    body: {
      id: comment.id,
      document_id: comment.document_id,
      comment_id: comment.comment_id,
      parent_id: comment.parent_id,
      content: comment.content,
      resolved_at: comment.resolved_at,
      author: { id: author.id, name: author.name, email: author.email },
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    },
  };
}

/** Re-export the shared pool for callers that just want the default runner. */
export { pool };
