import { pool } from '../../db/client.js';

/**
 * Connected apps (PRD §8). The device/authorization-code flows leave no
 * standing "grant" record — an approval issues a short-lived row in
 * `access_tokens` and nothing else (there are no refresh tokens; see
 * migration 050). So "apps connected to this workspace" is exactly the set of
 * access tokens that are still live (not revoked, not expired), grouped by the
 * (app, user) pair that authorized them. Revoking a connection flags every live
 * token for that pair — instant, since validation re-checks `revoked_at` on
 * every request (tokens.ts).
 */

export interface WorkspaceConnection {
  app_id: string;
  client_id: string;
  app_name: string;
  is_system: boolean;
  user_id: string;
  user_email: string;
  user_name: string;
  /** Union of scopes across the pair's live tokens. */
  scopes: string[];
  active_token_count: number;
  first_authorized_at: string;
  last_used_at: string | null;
  expires_at: string;
}

/**
 * Active connections in a workspace: one row per (app, user) pair holding at
 * least one live token. Expired/revoked tokens are excluded — once a token
 * lapses the app can no longer act, so it is no longer "connected".
 */
export async function listWorkspaceConnections(workspaceId: string): Promise<WorkspaceConnection[]> {
  const result = await pool.query<WorkspaceConnection>(
    `WITH live AS (
       SELECT t.app_id, a.client_id, a.name AS app_name, a.is_system,
              t.user_id, u.email AS user_email, u.name AS user_name,
              t.created_at, t.last_used_at, t.expires_at, t.scopes
         FROM access_tokens t
         JOIN oauth_apps a ON a.id = t.app_id
         JOIN users u ON u.id = t.user_id
        WHERE t.workspace_id = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
     )
     SELECT app_id, client_id, app_name, is_system, user_id, user_email, user_name,
            count(*)::int AS active_token_count,
            min(created_at) AS first_authorized_at,
            max(last_used_at) AS last_used_at,
            max(expires_at) AS expires_at,
            (SELECT coalesce(array_agg(DISTINCT s ORDER BY s), '{}')
               FROM live l2, unnest(l2.scopes) AS s
              WHERE l2.app_id = live.app_id AND l2.user_id = live.user_id) AS scopes
       FROM live
      GROUP BY app_id, client_id, app_name, is_system, user_id, user_email, user_name
      ORDER BY min(created_at) DESC`,
    [workspaceId]
  );
  return result.rows;
}

export interface RevokedConnection {
  revoked_count: number;
  app_name: string | null;
  client_id: string | null;
}

/**
 * Revoke every live token a user holds for an app in this workspace. Idempotent:
 * if the pair has no live tokens (already revoked, expired, or never existed)
 * `revoked_count` is 0 — which the route maps to a 404. `app_name`/`client_id`
 * reflect the app row if it still exists, independent of the revoke count.
 */
export async function revokeWorkspaceConnection(
  workspaceId: string,
  appId: string,
  userId: string
): Promise<RevokedConnection> {
  const result = await pool.query<RevokedConnection>(
    `WITH revoked AS (
       UPDATE access_tokens
          SET revoked_at = now()
        WHERE workspace_id = $1 AND app_id = $2 AND user_id = $3
          AND revoked_at IS NULL AND expires_at > now()
        RETURNING id
     )
     SELECT count(*)::int AS revoked_count,
            (SELECT name FROM oauth_apps WHERE id = $2) AS app_name,
            (SELECT client_id FROM oauth_apps WHERE id = $2) AS client_id
       FROM revoked`,
    [workspaceId, appId, userId]
  );
  return result.rows[0] ?? { revoked_count: 0, app_name: null, client_id: null };
}
