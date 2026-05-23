import { pool } from '../db/client.js';

/**
 * Check if user is a workspace admin
 */
export async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId]
  );
  return result.rows[0]?.role === 'admin';
}

/**
 * Get visibility filter context for SQL queries.
 * Returns the isAdmin boolean that should be used with visibility filter SQL.
 *
 * The visibility filter pattern is:
 *   (visibility = 'workspace' OR created_by = $userId OR $isAdmin = TRUE)
 *
 * This allows:
 * - All workspace-visible documents to be seen by everyone
 * - Private documents to be seen only by their creator
 * - Admins to see all documents
 */
export async function getVisibilityContext(
  userId: string,
  workspaceId: string
): Promise<{ isAdmin: boolean }> {
  const isAdmin = await isWorkspaceAdmin(userId, workspaceId);
  return { isAdmin };
}

/**
 * SQL fragment for visibility filtering.
 *
 * Two calling shapes are supported:
 *
 * 1. Placeholder string (legacy): pass a SQL placeholder like '$3' for isAdmin
 *    and bind the boolean value in the params array. The clause becomes
 *    `(visibility = 'workspace' OR created_by = $userId OR $isAdmin = TRUE)`.
 *
 * 2. Resolved boolean (preferred for new code): pass the actual isAdmin
 *    boolean returned by getVisibilityContext. When true, the entire
 *    clause collapses to `TRUE` at SQL-construction time, so the planner
 *    can pick partial indexes that the OR shape would defeat. When false,
 *    the OR with the always-false branch is elided.
 *
 * Both shapes accept arbitrary table aliases. The boolean shape avoids
 * binding isAdmin as a parameter — callers should not push it into the
 * params array when using shape (2).
 *
 * Example (shape 1, legacy):
 *   const { isAdmin } = await getVisibilityContext(userId, workspaceId);
 *   const query = `SELECT * FROM documents d
 *     WHERE d.workspace_id = $1 AND ${VISIBILITY_FILTER_SQL('d', '$2', '$3')}`;
 *   await pool.query(query, [workspaceId, userId, isAdmin]);
 *
 * Example (shape 2, preferred):
 *   const { isAdmin } = await getVisibilityContext(userId, workspaceId);
 *   const query = `SELECT * FROM documents d
 *     WHERE d.workspace_id = $1 AND ${VISIBILITY_FILTER_SQL('d', '$2', isAdmin)}`;
 *   await pool.query(query, [workspaceId, userId]);
 */
export function VISIBILITY_FILTER_SQL(
  tableAlias: string,
  userIdParam: string,
  isAdminParamOrValue: string | boolean
): string {
  // For boolean shapes, the OR clause is replaced with a literal TRUE/FALSE
  // so the planner can constant-fold at planning time instead of treating
  // isAdmin as an opaque parameter. The userIdParam reference is preserved
  // so callers can keep userId in their params array regardless of shape.
  if (isAdminParamOrValue === true) {
    return `(${tableAlias}.visibility = 'workspace' OR ${tableAlias}.created_by = ${userIdParam} OR TRUE)`;
  }
  if (isAdminParamOrValue === false) {
    return `(${tableAlias}.visibility = 'workspace' OR ${tableAlias}.created_by = ${userIdParam})`;
  }
  return `(${tableAlias}.visibility = 'workspace' OR ${tableAlias}.created_by = ${userIdParam} OR ${isAdminParamOrValue} = TRUE)`;
}
