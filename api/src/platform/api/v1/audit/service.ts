import { pool } from '../../../../db/client.js';

/**
 * Public API audit trail (PRD §7): write one row per authenticated `/api/v1`
 * request, and query it (for the developer portal). NO request/response bodies,
 * bearer tokens, or client secrets are ever recorded here.
 */

export interface PublicApiAuditEntry {
  clientId: string | null;
  appId: string | null;
  tokenId: string | null;
  userId: string | null;
  workspaceId: string | null;
  method: string;
  route: string;
  scope: string | null;
  status: number;
  latencyMs: number;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Insert an audit row. Never throws — a logging failure must not fail the API request. */
export async function recordPublicApiRequest(entry: PublicApiAuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public_api_audit_logs
         (client_id, app_id, token_id, user_id, workspace_id, method, route, scope, status, latency_ms, request_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        entry.clientId,
        entry.appId,
        entry.tokenId,
        entry.userId,
        entry.workspaceId,
        entry.method,
        entry.route,
        entry.scope,
        entry.status,
        entry.latencyMs,
        entry.requestId,
        entry.ipAddress,
        entry.userAgent,
      ]
    );
  } catch (error) {
    console.error('[api/v1] audit write failed (non-fatal):', error);
  }
}

export interface AuditLogRow {
  id: string;
  created_at: string;
  client_id: string | null;
  app_id: string | null;
  token_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  method: string;
  route: string;
  scope: string | null;
  status: number;
  latency_ms: number;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuditQueryFilters {
  workspaceId: string;
  appId?: string;
  userId?: string;
  route?: string;
  /** Status class: 2,3,4,5 → matches 2xx/3xx/4xx/5xx. */
  statusClass?: 2 | 3 | 4 | 5;
  from?: Date;
  to?: Date;
  /**
   * Hide one client's traffic. The Developer Portal — itself a public-API
   * client — excludes its own client_id by default so the audit view isn't a
   * feedback loop of its own polling. Recording is unconditional; only the
   * query filters.
   */
  excludeClientId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  data: AuditLogRow[];
  total: number;
}

/**
 * Query the audit trail for a workspace with portal filters + pagination. Always
 * scoped by workspace_id so one workspace can never read another's logs.
 */
export async function queryPublicApiAudit(filters: AuditQueryFilters): Promise<AuditQueryResult> {
  const where: string[] = ['workspace_id = $1'];
  const params: unknown[] = [filters.workspaceId];
  let i = 2;

  if (filters.appId) {
    where.push(`app_id = $${i++}`);
    params.push(filters.appId);
  }
  if (filters.userId) {
    where.push(`user_id = $${i++}`);
    params.push(filters.userId);
  }
  if (filters.route) {
    where.push(`route = $${i++}`);
    params.push(filters.route);
  }
  if (filters.statusClass) {
    where.push(`status >= $${i} AND status < $${i + 1}`);
    params.push(filters.statusClass * 100, (filters.statusClass + 1) * 100);
    i += 2;
  }
  if (filters.from) {
    where.push(`created_at >= $${i++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`created_at <= $${i++}`);
    params.push(filters.to);
  }
  if (filters.excludeClientId) {
    where.push(`client_id IS DISTINCT FROM $${i++}`);
    params.push(filters.excludeClientId);
  }

  const whereSql = where.join(' AND ');
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const totalRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM public_api_audit_logs WHERE ${whereSql}`,
    params
  );
  const dataRes = await pool.query<AuditLogRow>(
    `SELECT * FROM public_api_audit_logs
      WHERE ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${i++} OFFSET $${i++}`,
    [...params, limit, offset]
  );

  return { data: dataRes.rows, total: Number(totalRes.rows[0]?.count ?? '0') };
}

/** Delete audit rows older than `days` (retention; default 90). Returns rows removed. */
export async function pruneAuditLogs(days = 90): Promise<number> {
  const res = await pool.query(
    `DELETE FROM public_api_audit_logs WHERE created_at < now() - make_interval(days => $1)`,
    [days]
  );
  return res.rowCount ?? 0;
}
