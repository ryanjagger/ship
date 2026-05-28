/**
 * FleetGraph insight backing-store — system-authored documents that record
 * proactive sweep findings. The substrate for the (deferred) cron sweep:
 * `createOrRefreshInsight` is the workhorse callers invoke when the agent
 * decides to surface a finding; `resolveInsight` is what callers invoke when
 * the underlying condition clears; `listInsights` / `getInsight` are the
 * read paths the (deferred) endpoint + UI consume.
 *
 * See docs/plans/2026-05-27-002-feat-fleetgraph-insight-entity-plan.md for
 * the full design.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────
 * One `documents` row per insight, `document_type='insight'`. System-authored:
 * `created_by = NULL`. Hidden from generic surfaces (`documents.ts` already
 * excludes `'insight'` from list/by-id/search/conversion paths) and from the
 * collaboration server (`collaboration/index.ts` denies Yjs joins — a full
 * `properties = $3` replace would clobber `fleetgraph_insight`). The subject
 * link is one `document_associations` row with `relationship_type='discusses'`
 * (reused from the conversation precedent, not a new enum value).
 *
 * Lifecycle state lives under `properties.fleetgraph_insight` (a single
 * nested object — see `InsightProperties` in shared/src/types/document.ts).
 * Writes use deep-path `jsonb_set('{fleetgraph_insight,…}', …)` — never
 * read-modify-write of the whole `properties` blob — so the discipline
 * conversation.ts established for interleaved writers carries over even
 * though insight has a single writer per (subject, kind).
 *
 * ── IDENTITY INVARIANT (load-bearing) ────────────────────────────────────
 * One OPEN insight per `(workspace_id, subject_id, kind)` at any time.
 * Multiple resolved rows are intentional (append-only history — see Decision
 * 5 in the plan).
 *
 * Two layers enforce it:
 *
 *   1. `pg_advisory_xact_lock(hashtextextended(workspaceId:subjectId:kind))`
 *      serializes the create-or-refresh upsert at the application layer. This
 *      is the path service callers take.
 *
 *   2. Partial unique index `insights_open_per_subject_kind` (migration 046)
 *      keyed on the JSONB extracts catches out-of-band writers (manual SQL,
 *      backfills, code paths that forget the lock). Service paths NEVER
 *      expect to hit this conflict — a `23505` from this index is a contract
 *      violation worth alerting on, not a normal failure mode.
 *
 * State transitions never INSERT new rows except from `(none)` and from
 * `resolved` (which inserts a fresh OPEN row per the append-only history
 * design). So `dismissed`, `snoozed`, and `open` share a single live row at
 * any time, and the SELECT below safely takes `LIMIT 1`.
 *
 * ── VISIBILITY ───────────────────────────────────────────────────────────
 * Insight visibility is RECOMPUTED at read time by JOINing the subject and
 * applying VISIBILITY_FILTER_SQL against the subject's current visibility —
 * NOT snapshotted on the insight row. This means subject visibility changes
 * (e.g., a project flipped from `workspace` to `private`) take effect on the
 * next read without a backfill. The insight's own `visibility` column is set
 * to `'workspace'` at create time as a placeholder; it is not consulted by
 * read paths in this service.
 *
 * Note on `created_by = NULL`: the existing VISIBILITY_FILTER_SQL is
 * `(visibility='workspace' OR created_by=$userId OR isAdmin)`. The middle
 * branch can never match an insight (NULL ≠ anything). Reads apply the
 * filter to the SUBJECT, not the insight, so this is correct by construction.
 *
 * ── AUTH CONTRACT (CALLER'S RESPONSIBILITY) ──────────────────────────────
 * `listInsights` and `getInsight` accept `ctx: { workspaceId, userId,
 * isAdmin }` as plain arguments. Callers MUST derive `userId` and
 * `workspaceId` from a validated session (and `isAdmin` from
 * `getVisibilityContext`). The service trusts these values — it does NOT
 * verify workspace membership internally. The deferred read endpoint plan
 * will own the session→ctx mapping.
 *
 * ── CONCURRENCY DISCIPLINE ───────────────────────────────────────────────
 * `createOrRefreshInsight` uses a single `PoolClient` with explicit
 * `BEGIN`/`COMMIT` (NOT `pool.query` calls; `pool.query` auto-commits each
 * statement and cannot achieve cross-statement atomicity — the
 * documents+associations writes MUST share a transaction). The latent
 * two-`pool.query` gap in conversation.ts:createConversation is the
 * anti-pattern — see Risks in the plan.
 *
 * `SET LOCAL statement_timeout = '5s'` at the top of the transaction bounds
 * stuck-lock blast radius. If a 57014 (statement_timeout) fires, the
 * transaction rolls back and the lock is released — callers see the error
 * and can retry.
 *
 * `resolveInsight` uses a single CTE + `SELECT ... FOR UPDATE` UPDATE — the
 * shape `conversation.ts:claimPending` established. Idempotent: UPDATE
 * fires only when `state != 'resolved'`.
 *
 * ── WHAT IS NOT ENFORCED HERE ────────────────────────────────────────────
 * - `snoozeInsight` / `dismissInsight` write paths are deferred. The
 *   `snoozed_until` and dismissal fields are reserved in the JSONB shape so
 *   adding the writers later doesn't require a schema change.
 * - Auto-resolve on subject delete/archive is read-time only: queries filter
 *   `s.deleted_at IS NULL AND s.archived_at IS NULL` so stale insights are
 *   invisible to readers. A subject-delete hook that flips state to
 *   `resolved` is deferred (see Scope Boundaries in the plan).
 * - Content sanitization for `evidence`/`summary`/`recommended_action` is
 *   the caller's responsibility (only the sweep writes these; we control it).
 */

import { pool } from '../../db/client.js';
import { VISIBILITY_FILTER_SQL } from '../../middleware/visibility.js';
import type {
  DocumentType,
  FleetInsight,
  InsightKind,
  InsightProperties,
  InsightSeverity,
  InsightStatus,
  InsightVerdict,
} from '@ship/shared';

// ─── Lock key derivation ────────────────────────────────────────────────
// Single named helper so every caller produces the SAME key for the same
// (workspace, subject, kind). hashtextextended() is Postgres-built-in,
// returns bigint, and accepts a seed (we pass 0 to use the default mixer).
// The colon-separated input avoids the prefix-collision pathology where
// `wsA + subB` and `wsAsub + B` would otherwise hash identically.

/** SQL fragment + params binding for the (workspace, subject, kind) advisory lock. */
function insightLockKeyParams(
  workspaceId: string,
  subjectId: string,
  kind: InsightKind
): string {
  return `${workspaceId}:${subjectId}:${kind}`;
}

// ─── Public types ───────────────────────────────────────────────────────

export interface CreateOrRefreshInsightArgs {
  workspaceId: string;
  subjectId: string;
  subjectEntityType: string;
  kind: InsightKind;
  severity: InsightSeverity;
  summary: string;
  recommendedAction: string;
  evidence: Record<string, unknown>;
  verdict: InsightVerdict;
  /**
   * Stable identifier for the underlying detection. Callers should derive
   * this from the inputs the model judged — when it changes, evidence
   * changed; when it matches, the detection is the same and the refresh is
   * a true no-op (only last_seen_at + occurrence_count advance).
   */
  inputHash: string;
  accountableOwnerId?: string | null;
}

export interface CreateOrRefreshInsightResult {
  /** Null only when the subject is missing/soft-deleted/archived (benign race). */
  insight: FleetInsight | null;
  didCreate: boolean;
  /**
   * True when severity transitioned `fyi → act` against an existing row,
   * INCLUDING the dismissed→open reopen path. `snoozed` rows never set this.
   * Drives downstream "should this re-notify?" decisions.
   */
  didEscalate: boolean;
}

// ─── createOrRefreshInsight ─────────────────────────────────────────────

/**
 * Upsert an insight under the (workspace, subject, kind) advisory lock,
 * applying the decision-matrix rules:
 *
 *   - No existing live row: INSERT new OPEN row + `discusses` association.
 *   - `open`, hash matches: bump `last_seen_at` + `occurrence_count` only.
 *   - `open`, hash differs: refresh evidence/severity/etc + both timestamps.
 *     FYI→ACT severity transition sets `didEscalate=true`.
 *   - `resolved`: filtered out of the existing-row SELECT (lives forever as
 *     history); fresh OPEN row is inserted via the no-row branch.
 *   - `snoozed`: silent refresh of evidence. State stays `snoozed`.
 *     `didEscalate=false` regardless of severity transition.
 *   - `dismissed`, same/lower severity: silent refresh. State stays.
 *   - `dismissed`, FYI→ACT escalation: flip to `open`, refresh,
 *     `didEscalate=true`.
 *
 * Returns `{ insight: null, didCreate: false }` when the subject was
 * soft-deleted or archived between the caller's decision and the FOR SHARE
 * probe — a benign race the sweep can recover from next cycle.
 */
export async function createOrRefreshInsight(
  args: CreateOrRefreshInsightArgs
): Promise<CreateOrRefreshInsightResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");

    // Acquire the per-(workspace, subject, kind) advisory lock. Held for the
    // life of the transaction; released automatically on COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      insightLockKeyParams(args.workspaceId, args.subjectId, args.kind),
    ]);

    // Find the existing live (non-resolved) insight for this (subject, kind),
    // if any. Resolved rows are intentionally excluded — append-only history
    // means they live forever and re-detection inserts a fresh OPEN row.
    //
    // FOR UPDATE is load-bearing: a concurrent `resolveInsight` on the same row
    // would otherwise commit between this SELECT (READ COMMITTED snapshot still
    // shows state='open') and the UPDATE below, and our UPDATE would clobber
    // the resolution. FOR UPDATE makes the SELECT block until the concurrent
    // resolve commits; on unblock, the SELECT re-reads and the state filter
    // (`IN (open,snoozed,dismissed)`) correctly excludes the now-resolved row,
    // falling through to the no-row INSERT branch. Caught by U6 T40.
    const existing = await client.query<{
      id: string;
      ins: InsightProperties;
    }>(
      `SELECT id, properties->'fleetgraph_insight' AS ins
         FROM documents
        WHERE document_type = 'insight'
          AND workspace_id = $1
          AND properties->'fleetgraph_insight'->>'subject_id' = $2
          AND properties->'fleetgraph_insight'->>'kind' = $3
          AND properties->'fleetgraph_insight'->>'state' IN ('open', 'snoozed', 'dismissed')
          AND archived_at IS NULL
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [args.workspaceId, args.subjectId, args.kind]
    );

    if (existing.rows.length === 0) {
      // ── No-row branch: INSERT a fresh OPEN row. ─────────────────────────
      // First, FOR SHARE the subject inside the transaction to assert it
      // exists in THIS workspace and is not soft-deleted/archived. The
      // workspace_id check is load-bearing: without it, a caller passing a
      // foreign-workspace subjectId would silently create a cross-tenant
      // insight (row in workspace A pointing at a subject in workspace B).
      // The read-path JOIN on `s.workspace_id = i.workspace_id` would hide
      // it from list queries, but the row itself and any cross-tenant
      // subject metadata leaked back via getInsightInternal would still be
      // a contract violation. On miss (no row, or row in another
      // workspace), ROLLBACK and return `didCreate=false`.
      const subject = await client.query<{
        title: string;
        document_type: DocumentType;
      }>(
        `SELECT title, document_type
           FROM documents
          WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
          FOR SHARE`,
        [args.subjectId, args.workspaceId]
      );
      if (subject.rows.length === 0) {
        await client.query('ROLLBACK');
        return { insight: null, didCreate: false, didEscalate: false };
      }
      const subjectTitle = subject.rows[0]!.title;
      const subjectDocumentType = subject.rows[0]!.document_type;

      const now = new Date().toISOString();
      const insightProps: InsightProperties = {
        state: 'open',
        kind: args.kind,
        severity: args.severity,
        subject_id: args.subjectId,
        subject_entity_type: args.subjectEntityType,
        summary: args.summary,
        recommended_action: args.recommendedAction,
        evidence: args.evidence,
        verdict: args.verdict,
        input_hash: args.inputHash,
        accountable_owner_id: args.accountableOwnerId ?? null,
        first_seen_at: now,
        last_seen_at: now,
        last_changed_at: now,
        occurrence_count: 1,
        resolved_at: null,
        resolved_reason: null,
        snoozed_until: null,
        dismissed_at: null,
        dismissed_by: null,
      };
      const properties = { fleetgraph_insight: insightProps };
      const title = insightTitle(args.kind, subjectTitle);

      const inserted = await client.query<{
        id: string;
        workspace_id: string;
        title: string;
        created_at: string;
      }>(
        `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
            VALUES ($1, 'insight', $2, NULL, 'workspace', $3::jsonb)
         RETURNING id, workspace_id, title, created_at`,
        [args.workspaceId, title, JSON.stringify(properties)]
      );
      const insightRow = inserted.rows[0]!;

      // Subject association via 'discusses'. ON CONFLICT DO NOTHING for
      // idempotency — same shape as conversation.ts:createConversation.
      await client.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
            VALUES ($1, $2, 'discusses')
            ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
        [insightRow.id, args.subjectId]
      );

      await client.query('COMMIT');

      return {
        insight: {
          id: insightRow.id,
          workspace_id: insightRow.workspace_id,
          title: insightRow.title,
          created_at: insightRow.created_at,
          insight: insightProps,
          subject_id: args.subjectId,
          subject_title: subjectTitle,
          subject_document_type: subjectDocumentType,
        },
        didCreate: true,
        didEscalate: false,
      };
    }

    // ── Existing-row refresh branch. ─────────────────────────────────────
    const existingRow = existing.rows[0]!;
    const oldProps = existingRow.ins;
    const insightId = existingRow.id;

    const oldState = oldProps.state;
    const oldSeverity = oldProps.severity;
    const escalating = oldSeverity === 'fyi' && args.severity === 'act';
    const hashMatches = oldProps.input_hash === args.inputHash;
    const now = new Date().toISOString();

    if (oldState === 'open' && hashMatches) {
      // True no-op refresh: only last_seen_at + occurrence_count advance.
      // last_changed_at, severity, evidence, etc. are untouched.
      await client.query(
        `UPDATE documents
            SET properties = jsonb_set(
                  jsonb_set(properties, '{fleetgraph_insight,last_seen_at}', to_jsonb($1::text), false),
                  '{fleetgraph_insight,occurrence_count}',
                  to_jsonb(((properties->'fleetgraph_insight'->>'occurrence_count')::int + 1)),
                  false
                )
          WHERE id = $2 AND document_type = 'insight'`,
        [now, insightId]
      );
    } else {
      // Evidence-changed refresh (or dismissed → open reopen on escalation).
      // Replace the whole fleetgraph_insight key in one statement via a
      // single jsonb_set call — still disjoint from any other top-level
      // properties key.
      const dismissedReopen = oldState === 'dismissed' && escalating;
      const newState: InsightStatus = dismissedReopen ? 'open' : oldState;
      const newProps: InsightProperties = {
        ...oldProps,
        state: newState,
        severity: args.severity,
        summary: args.summary,
        recommended_action: args.recommendedAction,
        evidence: args.evidence,
        verdict: args.verdict,
        input_hash: args.inputHash,
        accountable_owner_id:
          args.accountableOwnerId !== undefined
            ? args.accountableOwnerId
            : oldProps.accountable_owner_id,
        last_seen_at: now,
        last_changed_at: now,
        occurrence_count: oldProps.occurrence_count + 1,
      };
      await client.query(
        `UPDATE documents
            SET properties = jsonb_set(properties, '{fleetgraph_insight}', $1::jsonb, false)
          WHERE id = $2 AND document_type = 'insight'`,
        [JSON.stringify(newProps), insightId]
      );
    }

    await client.query('COMMIT');

    // didEscalate fires for FYI→ACT against open OR dismissed (the reopen
    // path), but NEVER for snoozed (snooze suppresses pings).
    const didEscalate =
      (oldState === 'open' || oldState === 'dismissed') && escalating;

    const insight = await getInsightInternal(insightId);
    return { insight, didCreate: false, didEscalate };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Swallow rollback errors — original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── resolveInsight ─────────────────────────────────────────────────────

export interface ResolveInsightArgs {
  insightId: string;
  /**
   * Workspace scoping — load-bearing for cross-tenant safety. The CTE's
   * locked SELECT scopes by `workspace_id = $2`, so a caller passing an
   * `insightId` from a foreign workspace gets a no-row result (priorState:
   * null, didResolve: false). Without this, any caller anywhere with an
   * insight UUID could resolve insights in workspaces they don't belong
   * to. Callers MUST derive this from a validated session.
   */
  workspaceId: string;
  /** Optional human-readable reason; persisted as `properties.fleetgraph_insight.resolved_reason`. */
  reason?: string;
  /**
   * Race-detection guard. When provided, the resolve fires ONLY if the
   * current state matches. Used by user-initiated resolves to fail loudly
   * on race ("the row I'm resolving must still be in this state"). The
   * sweep's auto-resolve path omits it — it accepts any non-resolved state.
   * When provided and the row is in any state other than the expected one
   * — INCLUDING 'resolved' (the most common race outcome) — the function
   * throws `InsightStateRaceError`.
   */
  expectedState?: InsightStatus;
}

export interface ResolveInsightResult {
  /**
   * The state BEFORE this call (per the CTE's pre-update capture). `null`
   * when the id didn't match any insight row in the given workspace.
   */
  priorState: InsightStatus | null;
  /** True when this call actually transitioned the row to `resolved`. */
  didResolve: boolean;
}

/**
 * Idempotent transition to `state='resolved'`. Single-statement CTE +
 * `SELECT ... FOR UPDATE` so concurrent callers serialize at the row level
 * (the conversation.ts:claimPending pattern). The UPDATE fires ONLY when
 * the current state is non-resolved — calling resolve on an
 * already-resolved row is a true no-op (`didResolve: false`, no second
 * `resolved_at` stamp).
 *
 * Targets any non-resolved status (`open`, `snoozed`, `dismissed`) — when
 * the underlying drift condition clears, prior user state hints (snooze/
 * dismiss) become irrelevant.
 *
 * Workspace-scoped: the CTE locks rows by `(id, workspace_id)` so a caller
 * passing a foreign-workspace insightId gets a benign no-row result rather
 * than mutating a row they shouldn't see.
 *
 * When `expectedState` is provided, the resolve fires only if the
 * pre-update state matches. On mismatch — including the common "already
 * resolved by someone else" race outcome — throws `InsightStateRaceError`.
 */
export async function resolveInsight(
  args: ResolveInsightArgs
): Promise<ResolveInsightResult> {
  const now = new Date().toISOString();
  const res = await pool.query<{ prior_state: InsightStatus | null; updated: boolean }>(
    `WITH locked AS (
        SELECT id, properties->'fleetgraph_insight'->>'state' AS prior_state
          FROM documents
         WHERE id = $1 AND workspace_id = $2 AND document_type = 'insight'
         FOR UPDATE
      ),
      updated AS (
        UPDATE documents d
           SET properties = jsonb_set(
                 jsonb_set(
                   jsonb_set(d.properties, '{fleetgraph_insight,state}', '"resolved"'::jsonb, false),
                   '{fleetgraph_insight,resolved_at}', to_jsonb($3::text), false
                 ),
                 '{fleetgraph_insight,resolved_reason}',
                 CASE WHEN $4::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($4::text) END,
                 false
               )
          FROM locked
         WHERE d.id = locked.id
           AND locked.prior_state <> 'resolved'
           AND ($5::text IS NULL OR locked.prior_state = $5::text)
        RETURNING locked.prior_state
      )
      SELECT
        locked.prior_state AS prior_state,
        EXISTS (SELECT 1 FROM updated) AS updated
      FROM locked`,
    [args.insightId, args.workspaceId, now, args.reason ?? null, args.expectedState ?? null]
  );

  if (res.rows.length === 0) {
    return { priorState: null, didResolve: false };
  }
  const { prior_state, updated } = res.rows[0]!;

  // expectedState supplied but the UPDATE didn't fire → either we lost a
  // race (someone else resolved it) or the prior state doesn't match. Both
  // are race conditions the caller wants to know about. Drop the prior
  // `prior_state !== 'resolved'` guard that silently suppressed the most
  // common race outcome (caught by adversarial review).
  if (args.expectedState && !updated) {
    throw new InsightStateRaceError(
      `Expected state '${args.expectedState}' but found '${prior_state}'.`
    );
  }

  return { priorState: prior_state, didResolve: updated };
}

/** Thrown by `resolveInsight` when `expectedState` is supplied and the
 *  current row state does not match — caller likely lost a race. */
export class InsightStateRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsightStateRaceError';
  }
}

// ─── Read paths ─────────────────────────────────────────────────────────

export interface InsightReadContext {
  workspaceId: string;
  userId: string;
  /** Resolved boolean from getVisibilityContext — see middleware/visibility.ts. */
  isAdmin: boolean;
}

export interface ListInsightsOptions extends InsightReadContext {
  /** Optional filter: only return insights whose subject is in this set. */
  subjectIds?: string[];
  /** Optional filter: only return insights of these kinds. */
  kinds?: InsightKind[];
  /**
   * State filter. Defaults to `'open'` (preserves the historical
   * `listOpenInsights` behavior). `'all'` drops the state predicate entirely
   * — used by the `?state=all` endpoint shape. Any single `InsightStatus`
   * value (e.g. `'resolved'`) parameterizes the predicate.
   */
  state?: InsightStatus | 'all';
  /** Default 50. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

/**
 * Visibility-scoped list of insights for the workspace, filtered by `state`
 * (default `'open'` to preserve the historical `listOpenInsights` shape).
 * Visibility is evaluated against the JOINED SUBJECT —
 * `VISIBILITY_FILTER_SQL('s', ...)` — not against the insight row, so
 * subject visibility flips take effect without a backfill. Same-workspace
 * subject join is enforced (`s.workspace_id = i.workspace_id`) so a
 * malformed cross-workspace `discusses` association can't expose insights
 * to the wrong workspace.
 *
 * Ordering: severity (ACT first), then last_seen_at DESC, then id DESC
 * (deterministic tiebreaker).
 */
export async function listInsights(
  opts: ListInsightsOptions
): Promise<FleetInsight[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const state: InsightStatus | 'all' = opts.state ?? 'open';

  // Parameters: $1=workspaceId, $2=userId, then optional filters.
  const params: unknown[] = [opts.workspaceId, opts.userId];
  const filters: string[] = [];

  if (state !== 'all') {
    params.push(state);
    filters.push(`i.properties->'fleetgraph_insight'->>'state' = $${params.length}`);
  }
  if (opts.subjectIds && opts.subjectIds.length > 0) {
    params.push(opts.subjectIds);
    filters.push(`s.id = ANY($${params.length}::uuid[])`);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    params.push(opts.kinds);
    filters.push(`i.properties->'fleetgraph_insight'->>'kind' = ANY($${params.length}::text[])`);
  }
  // limit / offset always last
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const optionalWhere = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

  const sql = `
    SELECT i.id, i.workspace_id, i.title, i.created_at,
           i.properties->'fleetgraph_insight' AS ins,
           s.id AS s_id, s.title AS s_title, s.document_type AS s_type
      FROM documents i
      INNER JOIN document_associations da
             ON da.document_id = i.id AND da.relationship_type = 'discusses'
      INNER JOIN documents s
             ON s.id = da.related_id AND s.workspace_id = i.workspace_id
     WHERE i.workspace_id = $1
       AND i.document_type = 'insight'
       AND i.archived_at IS NULL
       AND i.deleted_at IS NULL
       AND s.deleted_at IS NULL
       AND s.archived_at IS NULL
       AND ${VISIBILITY_FILTER_SQL('s', '$2', opts.isAdmin)}
       ${optionalWhere}
     ORDER BY
       (i.properties->'fleetgraph_insight'->>'severity' = 'act') DESC,
       (i.properties->'fleetgraph_insight'->>'last_seen_at') DESC,
       i.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const res = await pool.query<{
    id: string;
    workspace_id: string;
    title: string;
    created_at: string;
    ins: InsightProperties;
    s_id: string;
    s_title: string;
    s_type: DocumentType;
  }>(sql, params);

  return res.rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    title: r.title,
    created_at: r.created_at,
    insight: r.ins,
    subject_id: r.s_id,
    subject_title: r.s_title,
    subject_document_type: r.s_type,
  }));
}

/**
 * Visibility-scoped COUNT for the same query shape `listInsights` uses.
 * Same JOINs, same WHERE (incl. the optional `state`/`kinds`/`subjectIds`
 * filters), but `SELECT COUNT(*)` with no LIMIT/OFFSET. Used to drive
 * lightweight badge counts without fetching rows.
 */
export async function countInsights(
  opts: ListInsightsOptions
): Promise<number> {
  const state: InsightStatus | 'all' = opts.state ?? 'open';

  const params: unknown[] = [opts.workspaceId, opts.userId];
  const filters: string[] = [];

  if (state !== 'all') {
    params.push(state);
    filters.push(`i.properties->'fleetgraph_insight'->>'state' = $${params.length}`);
  }
  if (opts.subjectIds && opts.subjectIds.length > 0) {
    params.push(opts.subjectIds);
    filters.push(`s.id = ANY($${params.length}::uuid[])`);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    params.push(opts.kinds);
    filters.push(`i.properties->'fleetgraph_insight'->>'kind' = ANY($${params.length}::text[])`);
  }

  const optionalWhere = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

  const sql = `
    SELECT COUNT(*)::text AS count
      FROM documents i
      INNER JOIN document_associations da
             ON da.document_id = i.id AND da.relationship_type = 'discusses'
      INNER JOIN documents s
             ON s.id = da.related_id AND s.workspace_id = i.workspace_id
     WHERE i.workspace_id = $1
       AND i.document_type = 'insight'
       AND i.archived_at IS NULL
       AND i.deleted_at IS NULL
       AND s.deleted_at IS NULL
       AND s.archived_at IS NULL
       AND ${VISIBILITY_FILTER_SQL('s', '$2', opts.isAdmin)}
       ${optionalWhere}
  `;

  const res = await pool.query<{ count: string }>(sql, params);
  return parseInt(res.rows[0]?.count ?? '0', 10);
}

/**
 * Visibility-scoped single-insight fetch. Returns null when the insight
 * doesn't exist OR when the caller cannot see its subject — callers MUST
 * surface this as a 404 (not 403) to prevent disclosure of the insight's
 * existence to unauthorized viewers.
 */
export async function getInsight(
  insightId: string,
  ctx: InsightReadContext
): Promise<FleetInsight | null> {
  const res = await pool.query<{
    id: string;
    workspace_id: string;
    title: string;
    created_at: string;
    ins: InsightProperties;
    s_id: string;
    s_title: string;
    s_type: DocumentType;
  }>(
    `SELECT i.id, i.workspace_id, i.title, i.created_at,
            i.properties->'fleetgraph_insight' AS ins,
            s.id AS s_id, s.title AS s_title, s.document_type AS s_type
       FROM documents i
       INNER JOIN document_associations da
              ON da.document_id = i.id AND da.relationship_type = 'discusses'
       INNER JOIN documents s
              ON s.id = da.related_id AND s.workspace_id = i.workspace_id
      WHERE i.id = $1
        AND i.workspace_id = $2
        AND i.document_type = 'insight'
        AND i.archived_at IS NULL
        AND i.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.archived_at IS NULL
        AND ${VISIBILITY_FILTER_SQL('s', '$3', ctx.isAdmin)}
      LIMIT 1`,
    [insightId, ctx.workspaceId, ctx.userId]
  );

  if (res.rows.length === 0) return null;
  const r = res.rows[0]!;
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    title: r.title,
    created_at: r.created_at,
    insight: r.ins,
    subject_id: r.s_id,
    subject_title: r.s_title,
    subject_document_type: r.s_type,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Human-readable insight title. Used at create time only; subject title is
 *  embedded as a snapshot — visibility flips don't rename existing rows. */
function insightTitle(kind: InsightKind, subjectTitle: string): string {
  switch (kind) {
    case 'project_drift':
      return `Project drift: ${subjectTitle}`;
    default: {
      // Exhaustiveness check — TS narrowing complains if a new kind is added
      // without updating this switch.
      const _exhaustive: never = kind;
      void _exhaustive;
      return `Insight: ${subjectTitle}`;
    }
  }
}

/**
 * Internal fetch by id — used by createOrRefreshInsight to return the
 * post-write state. Does NOT apply visibility (the upsert's transaction
 * already proved authorization at the subject layer). The public
 * visibility-applying read paths (`listInsights`, `getInsight`) live in
 * U5 below.
 */
async function getInsightInternal(
  insightId: string
): Promise<FleetInsight | null> {
  const res = await pool.query<{
    id: string;
    workspace_id: string;
    title: string;
    created_at: string;
    ins: InsightProperties;
    s_id: string;
    s_title: string;
    s_type: DocumentType;
  }>(
    `SELECT i.id, i.workspace_id, i.title, i.created_at,
            i.properties->'fleetgraph_insight' AS ins,
            s.id AS s_id, s.title AS s_title, s.document_type AS s_type
       FROM documents i
       INNER JOIN document_associations da
              ON da.document_id = i.id AND da.relationship_type = 'discusses'
       INNER JOIN documents s
              ON s.id = da.related_id AND s.workspace_id = i.workspace_id
      WHERE i.id = $1 AND i.document_type = 'insight'
        AND i.archived_at IS NULL AND i.deleted_at IS NULL
      LIMIT 1`,
    [insightId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0]!;
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    title: r.title,
    created_at: r.created_at,
    insight: r.ins,
    subject_id: r.s_id,
    subject_title: r.s_title,
    subject_document_type: r.s_type,
  };
}

