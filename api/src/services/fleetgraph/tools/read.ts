/**
 * FleetGraph read tools (U5).
 *
 * Gives the agent VISIBILITY-CORRECT read access to a focal Project/Week and
 * its associated entities. Every read threads a `FleetContext` (the same shape
 * `fleet-service.ts` uses) and applies the same `VISIBILITY_FILTER_SQL` so the
 * agent can NEVER see more than the requesting user can.
 *
 * Two layers live here:
 *
 *  1. Underlying async fetch functions (`fetchFocal`, `fetchAssociations`,
 *     `fetchPeople`, `fetchRecentActivity`) — FleetContext-scoped,
 *     visibility-filtered, returning already-escaped (prompt-safe) values.
 *     These are what `nodes/fetch.ts` fans out in parallel.
 *
 *  2. A CONSOLIDATED traversal (`assembleEntityContext`) that resolves the
 *     focal entity ONCE and then batches the dependent reads — mirroring the
 *     program→project→week→issues/standups assembly in `routes/claude.ts`
 *     (data traversal only; NOT its CSRF-bypass / no-visibility posture).
 *     `fetch.ts` calls this so a single fetch run does not issue per-entity
 *     duplicate queries (satisfies R3).
 *
 * (The chat reason node binds ONLY the write `propose_*` tools; the full read
 * context is pre-assembled into the system prompt by the fetch node, so there is
 * no agentic read-tool loop. LangChain `tool()` wrappers for the read functions
 * were removed as dead code.)
 *
 * PROMPT-INJECTION DEFENSE: every value derived from untrusted document content
 * (titles, plan text, body text, comment text, standup text) is run through
 * `escapeContent` before it leaves this module, so a document body containing
 * "</plan>" or "<system>" cannot break out of prompt delimiters downstream.
 */

import { pool } from '../../../db/client.js';
import { VISIBILITY_FILTER_SQL } from '../../../middleware/visibility.js';
import { extractText } from '../../../utils/document-content.js';
import type { FleetContext } from '../../fleet-service.js';

export type { FleetContext };

/** Entity types the chat can be scoped to. `week` resolves to a `sprint` doc. */
export type FleetEntityType = 'project' | 'week' | 'issue';

/**
 * Map a chat entityType to its backing document_type. There is NO `week`
 * document type — a "Week" is `document_type='sprint'` (with related
 * weekly_plan / weekly_retro docs).
 */
export function resolveDocumentType(entityType: FleetEntityType): 'project' | 'sprint' | 'issue' {
  if (entityType === 'week') return 'sprint';
  if (entityType === 'issue') return 'issue';
  return 'project';
}

// ---------------------------------------------------------------------------
// Prompt-injection escaping
// ---------------------------------------------------------------------------

/**
 * Escape angle brackets (and ampersand) so untrusted content cannot break out
 * of prompt delimiters or smuggle pseudo-tags. Mirrors `esc()` in
 * fleet-service.ts. Entity-encoding preserves meaningful characters ("<3 min").
 */
export function escapeContent(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Normalize a pg timestamp (Date or string) to an ISO string, or null. */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ---------------------------------------------------------------------------
// Returned shapes (all content-derived strings are already escaped)
// ---------------------------------------------------------------------------

export interface FocalEntity {
  id: string;
  entityType: FleetEntityType;
  documentType: 'project' | 'sprint' | 'issue';
  /** Escaped. */
  title: string;
  /** Escaped plain-text rendering of documents.content. */
  body: string;
  /** Selected structured properties (plan/status are escaped; flags are not). */
  properties: {
    /** Project/week: plan text. */
    plan: string | null;
    /** Project/week: status. */
    status: string | null;
    targetDate: string | null;
    planValidated: boolean | null;
    /** Issue: workflow state (todo/in_progress/done/cancelled). */
    state: string | null;
    /** Issue: priority (low/medium/high/critical). */
    priority: string | null;
    /** Issue: assignee person document id (not content-derived; no escaping needed). */
    assigneeId: string | null;
  };
}

export interface AssociatedEntity {
  id: string;
  documentType: string;
  /** Escaped. */
  title: string;
  /** How this entity relates to the focal entity / hierarchy. */
  relation: string;
  /** Escaped issue/sprint status, when applicable. */
  status: string | null;
}

export interface PersonRef {
  /** Person document id. */
  id: string;
  userId: string | null;
  /** Escaped. */
  name: string;
  /** Workspace role, when known (admin/member). Not content-derived. */
  role: string | null;
}

export interface ActivityItem {
  kind: 'standup' | 'comment' | 'status_change';
  id: string;
  /** Escaped summary text. */
  text: string;
  /** Escaped author/actor label, when known. */
  author: string | null;
  at: string | null;
}

export interface AssociationsResult {
  /** Program/project ancestors of the focal entity. */
  ancestors: AssociatedEntity[];
  /** Issues associated with the focal entity. */
  issues: AssociatedEntity[];
  /** Weeks (sprints) associated with a focal project. */
  weeks: AssociatedEntity[];
}

// ---------------------------------------------------------------------------
// Focal entity resolution (single source of truth for visibility)
// ---------------------------------------------------------------------------

interface FocalRow {
  id: string;
  title: string;
  content: unknown;
  properties: Record<string, unknown> | null;
}

/**
 * Resolve + visibility-check the focal entity. Returns null when the entity is
 * not visible to the requester (used everywhere to deny without leaking).
 *
 * Visibility uses the resolved-boolean shape of VISIBILITY_FILTER_SQL: a
 * non-admin sees workspace docs + their own private docs; an admin sees all.
 */
export async function fetchFocal(
  entityId: string,
  entityType: FleetEntityType,
  ctx: FleetContext
): Promise<FocalEntity | null> {
  const docType = resolveDocumentType(entityType);
  const result = await pool.query<FocalRow>(
    `SELECT id, title, content, properties FROM documents
       WHERE id = $1 AND workspace_id = $2 AND document_type = $3
         AND archived_at IS NULL AND deleted_at IS NULL
         AND ${VISIBILITY_FILTER_SQL('documents', '$4', ctx.isAdmin)}`,
    [entityId, ctx.workspaceId, docType, ctx.userId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const props = row.properties ?? {};
  if (docType === 'issue') {
    return {
      id: row.id,
      entityType,
      documentType: 'issue',
      title: escapeContent(row.title),
      body: escapeContent(extractText(row.content).trim()),
      properties: {
        plan: null,
        status: null,
        targetDate: null,
        planValidated: null,
        state: escapeContent((props.state as string | undefined) ?? null) || null,
        priority: escapeContent((props.priority as string | undefined) ?? null) || null,
        assigneeId: (props.assignee_id as string | undefined) ?? null,
      },
    };
  }
  return {
    id: row.id,
    entityType,
    documentType: docType,
    title: escapeContent(row.title),
    body: escapeContent(extractText(row.content).trim()),
    properties: {
      plan: escapeContent((props.plan as string | undefined) ?? null) || null,
      status: escapeContent((props.status as string | undefined) ?? null) || null,
      targetDate: (props.target_date as string | undefined) ?? null,
      planValidated: (props.plan_validated as boolean | undefined) ?? null,
      state: null,
      priority: null,
      assigneeId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Associations (hierarchy ancestors + issues + weeks)
// ---------------------------------------------------------------------------

/**
 * Fetch the focal entity's associations in BATCHED queries (not per-entity).
 * For a project: program ancestor + issues + weeks(sprints). For a week
 * (sprint): project + program ancestors + issues on the sprint.
 *
 * Issues are read at ORDINARY-MEMBER privilege (workspace-visible only, no
 * created_by personalization, no admin bypass) — the same precedent as
 * `gatherSignals` in fleet-service.ts, so results are shareable and never
 * surface another user's private issues.
 *
 * Pass `focalKnownVisible: true` only after fetchFocal has already authorized
 * the entity, to avoid re-running the visibility check.
 */
export async function fetchAssociations(
  entityId: string,
  entityType: FleetEntityType,
  ctx: FleetContext,
  opts: { focalKnownVisible?: boolean } = {}
): Promise<AssociationsResult> {
  if (!opts.focalKnownVisible) {
    const focal = await fetchFocal(entityId, entityType, ctx);
    if (!focal) return { ancestors: [], issues: [], weeks: [] };
  }

  const docType = resolveDocumentType(entityType);

  // For an issue: fetch its parent project/sprint as ancestors, then sibling issues.
  if (docType === 'issue') {
    const parentsResult = await pool.query<{ id: string; title: string; document_type: string; relation: string }>(
      `SELECT p.id, p.title, p.document_type::text AS document_type, da.relationship_type::text AS relation
         FROM document_associations da
         JOIN documents p ON p.id = da.related_id
         WHERE da.document_id = $1
           AND da.relationship_type IN ('project', 'sprint', 'program', 'parent')
           AND p.workspace_id = $2
           AND p.archived_at IS NULL AND p.deleted_at IS NULL
           AND p.visibility = 'workspace'`,
      [entityId, ctx.workspaceId]
    );

    // Find the parent project id to pull sibling issues.
    const parentProjectRow = parentsResult.rows.find((r) => r.document_type === 'project');
    let siblingIssues: AssociatedEntity[] = [];
    if (parentProjectRow) {
      const siblingsResult = await pool.query<{ id: string; title: string; status: string | null }>(
        `SELECT d.id, d.title, d.properties->>'state' AS status
           FROM documents d
           JOIN document_associations da ON da.document_id = d.id
             AND da.related_id = $1 AND da.relationship_type = 'project'
           WHERE d.workspace_id = $2 AND d.document_type = 'issue'
             AND d.id != $3
             AND d.archived_at IS NULL AND d.deleted_at IS NULL
             AND d.visibility = 'workspace'
           ORDER BY d.created_at ASC
           LIMIT 20`,
        [parentProjectRow.id, ctx.workspaceId, entityId]
      );
      siblingIssues = siblingsResult.rows.map((r) => ({
        id: r.id,
        documentType: 'issue',
        title: escapeContent(r.title),
        relation: 'project',
        status: escapeContent(r.status) || null,
      }));
    }

    return {
      ancestors: parentsResult.rows.map((r) => ({
        id: r.id,
        documentType: r.document_type,
        title: escapeContent(r.title),
        relation: r.relation,
        status: null,
      })),
      issues: siblingIssues,
      weeks: [],
    };
  }

  // For a project the issues/weeks link via relationship_type='project';
  // for a week (sprint) issues link via relationship_type='sprint'.
  const childRelation = docType === 'project' ? 'project' : 'sprint';

  // Ancestors: walk parent relationships (project→program, week→project→program).
  const ancestorsResult = await pool.query<{ id: string; title: string; document_type: string; relation: string }>(
    `SELECT p.id, p.title, p.document_type::text AS document_type, da.relationship_type::text AS relation
       FROM document_associations da
       JOIN documents p ON p.id = da.related_id
       WHERE da.document_id = $1
         AND da.relationship_type IN ('project', 'program', 'parent')
         AND p.workspace_id = $2
         AND p.archived_at IS NULL AND p.deleted_at IS NULL
         AND p.visibility = 'workspace'`,
    [entityId, ctx.workspaceId]
  );

  // Issues associated with the focal entity (workspace-visible, member privilege).
  const issuesResult = await pool.query<{ id: string; title: string; status: string | null }>(
    `SELECT d.id, d.title, d.properties->>'state' AS status
       FROM documents d
       JOIN document_associations da ON da.document_id = d.id
         AND da.related_id = $1 AND da.relationship_type = $2
       WHERE d.workspace_id = $3 AND d.document_type = 'issue'
         AND d.archived_at IS NULL AND d.deleted_at IS NULL
         AND d.visibility = 'workspace'
       ORDER BY d.created_at ASC`,
    [entityId, childRelation, ctx.workspaceId]
  );

  // Weeks (sprints) only make sense for a focal project.
  let weeks: AssociatedEntity[] = [];
  if (docType === 'project') {
    const weeksResult = await pool.query<{ id: string; title: string; status: string | null }>(
      `SELECT d.id, d.title, d.properties->>'status' AS status
         FROM documents d
         JOIN document_associations da ON da.document_id = d.id
           AND da.related_id = $1 AND da.relationship_type = 'project'
         WHERE d.workspace_id = $2 AND d.document_type = 'sprint'
           AND d.archived_at IS NULL AND d.deleted_at IS NULL
           AND d.visibility = 'workspace'
         ORDER BY (d.properties->>'sprint_number')::int NULLS LAST, d.created_at ASC`,
      [entityId, ctx.workspaceId]
    );
    weeks = weeksResult.rows.map((r) => ({
      id: r.id,
      documentType: 'sprint',
      title: escapeContent(r.title),
      relation: 'week',
      status: escapeContent(r.status) || null,
    }));
  }

  return {
    ancestors: ancestorsResult.rows.map((r) => ({
      id: r.id,
      documentType: r.document_type,
      title: escapeContent(r.title),
      relation: r.relation,
      status: null,
    })),
    issues: issuesResult.rows.map((r) => ({
      id: r.id,
      documentType: 'issue',
      title: escapeContent(r.title),
      relation: childRelation,
      status: escapeContent(r.status) || null,
    })),
    weeks,
  };
}

// ---------------------------------------------------------------------------
// People / roles
// ---------------------------------------------------------------------------

/**
 * Fetch the workspace people (person documents) and their roles. People/roles
 * are workspace-scoped membership facts, not focal-content; we list the
 * workspace's person docs joined to membership roles. Names are escaped.
 */
export async function fetchPeople(ctx: FleetContext): Promise<PersonRef[]> {
  const result = await pool.query<{ id: string; user_id: string | null; name: string; role: string | null }>(
    `SELECT d.id,
            d.properties->>'user_id' AS user_id,
            d.title AS name,
            wm.role::text AS role
       FROM documents d
       LEFT JOIN workspace_memberships wm
         ON wm.workspace_id = d.workspace_id
        AND wm.user_id = (d.properties->>'user_id')::uuid
       WHERE d.workspace_id = $1 AND d.document_type = 'person'
         AND d.archived_at IS NULL AND d.deleted_at IS NULL
         AND d.visibility = 'workspace'
       ORDER BY d.title ASC`,
    [ctx.workspaceId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    userId: r.user_id ?? null,
    name: escapeContent(r.name),
    role: r.role ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Recent activity (standups + comments + status changes)
// ---------------------------------------------------------------------------

/**
 * Fetch recent activity around the focal entity in BATCHED queries:
 *  - standups: for a week, the sprint's standups; for a project, standups
 *    across the project's sprints.
 *  - comments: comments on the focal document itself.
 *  - status_change: recent `state`/`status` field changes from document_history
 *    for the focal entity and (for a project) its issues.
 *
 * All free text is escaped before return.
 */
export async function fetchRecentActivity(
  entityId: string,
  entityType: FleetEntityType,
  ctx: FleetContext,
  opts: { limit?: number } = {}
): Promise<ActivityItem[]> {
  const limit = opts.limit ?? 10;
  const docType = resolveDocumentType(entityType);

  // Resolve the set of sprint ids whose standups are relevant.
  // Issues have no associated standups — skip the lookup for them.
  let sprintIds: string[];
  if (docType === 'sprint') {
    sprintIds = [entityId];
  } else if (docType === 'project') {
    const sprintsResult = await pool.query<{ id: string }>(
      `SELECT d.id FROM documents d
         JOIN document_associations da ON da.document_id = d.id
           AND da.related_id = $1 AND da.relationship_type = 'project'
         WHERE d.workspace_id = $2 AND d.document_type = 'sprint'
           AND d.archived_at IS NULL AND d.deleted_at IS NULL`,
      [entityId, ctx.workspaceId]
    );
    sprintIds = sprintsResult.rows.map((r) => r.id);
  } else {
    sprintIds = [];
  }

  // Standups across those sprints (single batched query via = ANY).
  const standups: ActivityItem[] = [];
  if (sprintIds.length > 0) {
    const standupsResult = await pool.query<{ id: string; title: string; content: unknown; author: string | null; created_at: string }>(
      `SELECT d.id, d.title, d.content, u.name AS author, d.created_at
         FROM documents d
         JOIN document_associations da ON da.document_id = d.id AND da.relationship_type = 'sprint'
         LEFT JOIN users u ON (d.properties->>'author_id')::uuid = u.id
         WHERE da.related_id = ANY($1) AND d.document_type = 'standup'
           AND d.workspace_id = $2
           AND d.archived_at IS NULL AND d.deleted_at IS NULL
           AND d.visibility = 'workspace'
         ORDER BY d.created_at DESC
         LIMIT $3`,
      [sprintIds, ctx.workspaceId, limit]
    );
    for (const r of standupsResult.rows) {
      const text = extractText(r.content).trim() || r.title;
      standups.push({
        kind: 'standup',
        id: r.id,
        text: escapeContent(text),
        author: escapeContent(r.author) || null,
        at: toIso(r.created_at),
      });
    }
  }

  // Comments on the focal document itself.
  const commentsResult = await pool.query<{ id: string; content: string; author: string | null; created_at: string }>(
    `SELECT c.id, c.content, u.name AS author, c.created_at
       FROM comments c
       LEFT JOIN users u ON c.author_id = u.id
       WHERE c.document_id = $1 AND c.workspace_id = $2
       ORDER BY c.created_at DESC
       LIMIT $3`,
    [entityId, ctx.workspaceId, limit]
  );
  const comments: ActivityItem[] = commentsResult.rows.map((r) => ({
    kind: 'comment' as const,
    id: r.id,
    text: escapeContent(r.content),
    author: escapeContent(r.author) || null,
    at: toIso(r.created_at),
  }));

  // Status changes: the focal entity + (for a project) its issues.
  // Collect candidate ids in one cheap query, then one history query via = ANY.
  let historyDocIds = [entityId];
  if (docType === 'project') {
    const issueIdsResult = await pool.query<{ id: string }>(
      `SELECT d.id FROM documents d
         JOIN document_associations da ON da.document_id = d.id
           AND da.related_id = $1 AND da.relationship_type = 'project'
         WHERE d.workspace_id = $2 AND d.document_type = 'issue'
           AND d.visibility = 'workspace'`,
      [entityId, ctx.workspaceId]
    );
    historyDocIds = [entityId, ...issueIdsResult.rows.map((r) => r.id)];
  }
  const statusResult = await pool.query<{ id: number; field: string; old_value: string | null; new_value: string | null; author: string | null; created_at: string }>(
    `SELECT dh.id, dh.field, dh.old_value, dh.new_value, u.name AS author, dh.created_at
       FROM document_history dh
       LEFT JOIN users u ON dh.changed_by = u.id
       WHERE dh.document_id = ANY($1)
         AND dh.field IN ('state', 'status', 'plan_validated')
       ORDER BY dh.created_at DESC
       LIMIT $2`,
    [historyDocIds, limit]
  );
  const statusChanges: ActivityItem[] = statusResult.rows.map((r) => ({
    kind: 'status_change' as const,
    id: String(r.id),
    text: `${escapeContent(r.field)}: ${escapeContent(r.old_value) || '∅'} → ${escapeContent(r.new_value) || '∅'}`,
    author: escapeContent(r.author) || null,
    at: toIso(r.created_at),
  }));

  // Merge, newest first, capped at `limit`.
  return [...standups, ...comments, ...statusChanges]
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Consolidated traversal — used by the fetch node (R3: no redundant queries)
// ---------------------------------------------------------------------------

export interface EntityContext {
  focal: FocalEntity | null;
  associations: AssociationsResult;
  people: PersonRef[];
  recentActivity: ActivityItem[];
}

const EMPTY_ASSOCIATIONS: AssociationsResult = { ancestors: [], issues: [], weeks: [] };

/**
 * Resolve the focal entity ONCE (authorizing visibility), then fan out the
 * dependent reads in parallel reusing that authorization (`focalKnownVisible`).
 * This is the single consolidated entry point the fetch node calls — it never
 * re-resolves the focal entity per associated read, satisfying R3.
 *
 * When the focal entity is not visible, returns a denied/empty context WITHOUT
 * issuing the dependent queries — so a denied user gets nothing, never another
 * user's data.
 */
export async function assembleEntityContext(
  entityId: string,
  entityType: FleetEntityType,
  ctx: FleetContext
): Promise<EntityContext> {
  const focal = await fetchFocal(entityId, entityType, ctx);
  if (!focal) {
    return { focal: null, associations: EMPTY_ASSOCIATIONS, people: [], recentActivity: [] };
  }

  const [associations, people, recentActivity] = await Promise.all([
    fetchAssociations(entityId, entityType, ctx, { focalKnownVisible: true }),
    fetchPeople(ctx),
    fetchRecentActivity(entityId, entityType, ctx),
  ]);

  return { focal, associations, people, recentActivity };
}
