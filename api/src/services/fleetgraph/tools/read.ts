/**
 * FleetGraph read tools (U5).
 *
 * Gives the agent VISIBILITY-CORRECT read access to a focal Project/Week and
 * its associated entities. Every read travels the public API (`/api/v1`)
 * through the Fleet API client (issue #95) with a token minted for the ACTING
 * user, so the agent can NEVER see more than that user can through the public
 * contract — scope-bounded, rate-limited, and recorded in the public audit
 * trail. (Pre-#95 these were direct SQL reads with an admin bypass via
 * VISIBILITY_FILTER_SQL; v1 has no admin bypass, so admin chat reads narrowed
 * to ordinary-member visibility — an intentional change.)
 *
 * Two layers live here:
 *
 *  1. Underlying async fetch functions (`fetchFocal`, `fetchAssociations`,
 *     `fetchPeople`, `fetchRecentActivity`) — FleetContext-scoped, returning
 *     already-escaped (prompt-safe) values. These are what `nodes/fetch.ts`
 *     fans out in parallel.
 *
 *  2. A CONSOLIDATED traversal (`assembleEntityContext`) that resolves the
 *     focal entity ONCE and then batches the dependent reads. `fetch.ts` calls
 *     this so a single fetch run does not issue per-entity duplicate requests
 *     (satisfies R3).
 *
 * Shareable-context invariant: list reads pass `visibility: 'workspace'` so
 * results never include the acting viewer's PRIVATE issues — the same
 * precedent as `gatherSignals` (results may be cached/shared beyond the
 * viewer).
 *
 * (The chat reason node binds ONLY the write `propose_*` tools; the full read
 * context is pre-assembled into the system prompt by the fetch node, so there is
 * no agentic read-tool loop.)
 *
 * PROMPT-INJECTION DEFENSE: every value derived from untrusted document content
 * (titles, plan text, body text, comment text, standup text) is run through
 * `escapeContent` before it leaves this module, so a document body containing
 * "</plan>" or "<system>" cannot break out of prompt delimiters downstream.
 */

import { ShipApiError, type ShipClient, type ShipDocument, type ShipIssue, type ShipSprint } from '@ryanjagger/ship-sdk';
import { extractText } from '../../../utils/document-content.js';
import { withFleetClient } from '../api-client.js';
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

/** Normalize a timestamp to an ISO string, or null. */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Swallow a v1 404 (not visible / wrong type / archived) into null. */
async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ShipApiError && err.status === 404) return null;
    throw err;
  }
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
    /** Project/week: retro success criteria (each escaped). Empty for issues. */
    successCriteria: string[];
    /** Project/week: expected monetary impact, coerced to an escaped string. */
    monetaryImpactExpected: string | null;
    /** Project/week: actual monetary impact, coerced to an escaped string. */
    monetaryImpactActual: string | null;
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

/**
 * Resolve + visibility-check the focal entity. Returns null when the entity is
 * not visible to the requester (used everywhere to deny without leaking).
 *
 * One `GET /api/v1/documents/{id}` covers every focal type: it carries title,
 * properties, AND content (the typed project/sprint DTOs deliberately omit
 * content), and enforces the v1 read posture (workspace-visible or own,
 * not archived/deleted).
 */
export async function fetchFocal(
  entityId: string,
  entityType: FleetEntityType,
  ctx: FleetContext
): Promise<FocalEntity | null> {
  const docType = resolveDocumentType(entityType);
  const doc = await orNull(() => withFleetClient(ctx, (client) => client.documents.get(entityId)));
  if (!doc || doc.document_type !== docType) return null;

  const props = doc.properties ?? {};
  if (docType === 'issue') {
    return {
      id: doc.id,
      entityType,
      documentType: 'issue',
      title: escapeContent(doc.title),
      body: escapeContent(extractText(doc.content).trim()),
      properties: {
        plan: null,
        status: null,
        targetDate: null,
        planValidated: null,
        state: escapeContent((props.state as string | undefined) ?? null) || null,
        priority: escapeContent((props.priority as string | undefined) ?? null) || null,
        assigneeId: (props.assignee_id as string | undefined) ?? null,
        successCriteria: [],
        monetaryImpactExpected: null,
        monetaryImpactActual: null,
      },
    };
  }
  return {
    id: doc.id,
    entityType,
    documentType: docType,
    title: escapeContent(doc.title),
    body: escapeContent(extractText(doc.content).trim()),
    properties: {
      plan: escapeContent((props.plan as string | undefined) ?? null) || null,
      status: escapeContent((props.status as string | undefined) ?? null) || null,
      targetDate: (props.target_date as string | undefined) ?? null,
      planValidated: (props.plan_validated as boolean | undefined) ?? null,
      state: null,
      priority: null,
      assigneeId: null,
      // Retro signals. success_criteria is an array of strings; the monetary
      // fields are JSONB-sourced and can arrive as numbers, so coerce to string
      // BEFORE escaping (escapeContent calls .replace, which throws on a number).
      successCriteria: Array.isArray(props.success_criteria)
        ? (props.success_criteria as unknown[])
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map((c) => escapeContent(c))
        : [],
      monetaryImpactExpected:
        escapeContent(props.monetary_impact_expected == null ? null : String(props.monetary_impact_expected)) || null,
      monetaryImpactActual:
        escapeContent(props.monetary_impact_actual == null ? null : String(props.monetary_impact_actual)) || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Associations (hierarchy ancestors + issues + weeks)
// ---------------------------------------------------------------------------

const BELONGS_TO_DOC_TYPE: Record<string, string> = {
  program: 'program',
  project: 'project',
  sprint: 'sprint',
  parent: 'issue',
};

/** Drain a typed list with the shareable-context visibility posture. */
async function listAllIssues(
  client: ShipClient,
  belongsTo: string,
  belongsToType: 'program' | 'project' | 'sprint' | 'parent'
): Promise<ShipIssue[]> {
  const rows: ShipIssue[] = [];
  for await (const issue of client.issues.iterate({ belongs_to: belongsTo, belongs_to_type: belongsToType, visibility: 'workspace', limit: 100 })) {
    rows.push(issue);
  }
  return rows;
}

async function listAllSprints(client: ShipClient, projectId: string): Promise<ShipSprint[]> {
  const rows: ShipSprint[] = [];
  for await (const sprint of client.sprints.iterate({ belongs_to: projectId, belongs_to_type: 'project', visibility: 'workspace', limit: 100 })) {
    rows.push(sprint);
  }
  return rows;
}

function issueToAssociated(issue: ShipIssue, relation: string): AssociatedEntity {
  return {
    id: issue.id,
    documentType: 'issue',
    title: escapeContent(issue.title),
    relation,
    status: escapeContent(issue.state) || null,
  };
}

/**
 * Fetch the focal entity's associations: ancestors from the typed DTOs
 * (issue `belongs_to`; sprint `project_id`/`program_id`; project
 * `program_id`), plus issues/weeks via `belongs_to`-filtered lists at
 * ORDINARY-MEMBER privilege (`visibility: 'workspace'` — no created_by
 * personalization, no admin bypass), the same precedent as `gatherSignals`,
 * so results are shareable and never surface another user's private issues.
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

  // For an issue: ancestors come from its belongs_to DTO; siblings from the
  // parent project's issue list.
  if (docType === 'issue') {
    const issue = await orNull(() => withFleetClient(ctx, (client) => client.issues.get(entityId)));
    if (!issue) return { ancestors: [], issues: [], weeks: [] };

    const ancestors: AssociatedEntity[] = issue.belongs_to.map((bt) => ({
      id: bt.id,
      documentType: BELONGS_TO_DOC_TYPE[bt.type] ?? bt.type,
      title: escapeContent(bt.title ?? ''),
      relation: bt.type,
      status: null,
    }));

    const parentProject = issue.belongs_to.find((bt) => bt.type === 'project');
    let siblingIssues: AssociatedEntity[] = [];
    if (parentProject) {
      const siblings = await withFleetClient(ctx, (client) => listAllIssues(client, parentProject.id, 'project'));
      siblingIssues = siblings
        .filter((s) => s.id !== entityId)
        .slice(0, 20)
        .map((s) => issueToAssociated(s, 'project'));
    }

    return { ancestors, issues: siblingIssues, weeks: [] };
  }

  // For a project the issues/weeks link via relationship_type='project';
  // for a week (sprint) issues link via relationship_type='sprint'.
  const childRelation = docType === 'project' ? 'project' : 'sprint';

  return withFleetClient(ctx, async (client) => {
    // Ancestors from the focal DTO's belongs_to — associations are the
    // canonical hierarchy store (project→program, week→project/program), and
    // the entries already carry the related title.
    const focalDto =
      docType === 'project'
        ? await orNull(() => client.projects.get(entityId))
        : await orNull(() => client.sprints.get(entityId));
    const ancestors: AssociatedEntity[] = (focalDto?.belongs_to ?? [])
      .filter((bt) => bt.type === 'program' || bt.type === 'project' || bt.type === 'parent')
      .map((bt) => ({
        id: bt.id,
        documentType: BELONGS_TO_DOC_TYPE[bt.type] ?? bt.type,
        title: escapeContent(bt.title ?? ''),
        relation: bt.type,
        status: null,
      }));

    // Issues associated with the focal entity (workspace-visible, member privilege).
    const issues = (await listAllIssues(client, entityId, childRelation)).map((issue) =>
      issueToAssociated(issue, childRelation)
    );

    // Weeks (sprints) only make sense for a focal project.
    let weeks: AssociatedEntity[] = [];
    if (docType === 'project') {
      const sprints = await listAllSprints(client, entityId);
      weeks = sprints
        .sort((a, b) => (a.sprint_number ?? 0) - (b.sprint_number ?? 0))
        .map((sprint) => ({
          id: sprint.id,
          documentType: 'sprint',
          title: escapeContent(sprint.name),
          relation: 'week',
          status: escapeContent(sprint.status) || null,
        }));
    }

    return { ancestors, issues, weeks };
  });
}

// ---------------------------------------------------------------------------
// People / roles
// ---------------------------------------------------------------------------

/**
 * Fetch the workspace people (person documents) and their roles via the
 * public people list (the DTO carries `user_id` + `workspace_role`).
 * People/roles are workspace-scoped membership facts, not focal-content.
 * Names are escaped.
 */
export async function fetchPeople(ctx: FleetContext): Promise<PersonRef[]> {
  return withFleetClient(ctx, async (client) => {
    const people: PersonRef[] = [];
    for await (const person of client.people.iterate({ visibility: 'workspace', limit: 100 })) {
      people.push({
        id: person.id,
        userId: person.user_id ?? null,
        name: escapeContent(person.name),
        role: person.workspace_role ?? null,
      });
    }
    return people.sort((a, b) => a.name.localeCompare(b.name));
  });
}

// ---------------------------------------------------------------------------
// Recent activity (standups + comments + status changes)
// ---------------------------------------------------------------------------

/** Fields whose history rows surface as `status_change` activity. */
const STATUS_HISTORY_FIELDS = ['state', 'status', 'plan_validated'] as const;

/**
 * Fetch recent activity around the focal entity:
 *  - standups: for a week, the sprint's standups; for a project, standups
 *    across the project's sprints (top items hydrated via GET for body text —
 *    list DTOs intentionally omit content).
 *  - comments: comments on the focal document itself.
 *  - status_change: recent `state`/`status`/`plan_validated` history entries
 *    for the focal entity and (for a project) its issues, via the
 *    cross-document history endpoint (one call per field).
 *
 * Author labels resolve through the people directory (user_id → person name).
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

  return withFleetClient(ctx, async (client) => {
    // Author-name resolution (user id → person name).
    const nameByUserId = new Map<string, string>();
    for await (const person of client.people.iterate({ visibility: 'workspace', limit: 100 })) {
      if (person.user_id) nameByUserId.set(person.user_id, person.name);
    }
    const authorName = (userId: string | null | undefined): string | null => {
      if (!userId) return null;
      const name = nameByUserId.get(userId);
      return name ? escapeContent(name) || null : null;
    };

    // Resolve the set of sprint ids whose standups are relevant.
    // Issues have no associated standups — skip the lookup for them.
    let sprintIds: string[];
    if (docType === 'sprint') {
      sprintIds = [entityId];
    } else if (docType === 'project') {
      sprintIds = (await listAllSprints(client, entityId)).map((s) => s.id);
    } else {
      sprintIds = [];
    }

    // Standups across those sprints: list per sprint, merge newest-first, then
    // hydrate only the top `limit` via GET (the list DTO has no content).
    const standups: ActivityItem[] = [];
    if (sprintIds.length > 0) {
      const perSprint = await Promise.all(
        sprintIds.map((sprintId) =>
          client.standups.list({ belongs_to: sprintId, belongs_to_type: 'sprint', visibility: 'workspace', limit: Math.min(limit, 100) })
        )
      );
      const candidates = perSprint
        .flatMap((page) => page.data)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit);
      const hydrated = await Promise.all(candidates.map((s) => orNull(() => client.standups.get(s.id))));
      for (const standup of hydrated) {
        if (!standup) continue; // vanished between list and get
        const text = extractText(standup.content).trim() || standup.title;
        standups.push({
          kind: 'standup',
          id: standup.id,
          text: escapeContent(text),
          author: authorName(standup.author_id),
          at: toIso(standup.created_at),
        });
      }
    }

    // Comments on the focal document itself (oldest-first from v1; we want the
    // newest `limit`). The comment DTO carries the author directly.
    const commentList = await orNull(() => client.documents.comments.list(entityId));
    const comments: ActivityItem[] = (commentList?.data ?? [])
      .slice()
      .reverse()
      .slice(0, limit)
      .map((comment) => ({
        kind: 'comment' as const,
        id: comment.id,
        text: escapeContent(comment.content),
        author: escapeContent(comment.author.name ?? '') || null,
        at: toIso(comment.created_at),
      }));

    // Status changes: the focal entity + (for a project) its issues, via the
    // cross-document history endpoint (repeatable ids, capped at 100).
    let historyDocIds = [entityId];
    if (docType === 'project') {
      const issues = await listAllIssues(client, entityId, 'project');
      historyDocIds = [entityId, ...issues.map((issue) => issue.id)].slice(0, 100);
    }
    const perField = await Promise.all(
      STATUS_HISTORY_FIELDS.map((field) =>
        client.documentHistory.list({ document_id: historyDocIds, field, limit: Math.min(limit, 100) })
      )
    );
    const statusChanges: ActivityItem[] = perField
      .flatMap((page) => page.data)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((entry) => ({
        kind: 'status_change' as const,
        id: String(entry.id),
        text: `${escapeContent(entry.field)}: ${escapeContent(entry.old_value) || '∅'} → ${escapeContent(entry.new_value) || '∅'}`,
        author: authorName(entry.changed_by),
        at: toIso(entry.created_at),
      }));

    // Merge, newest first, capped at `limit`.
    return [...standups, ...comments, ...statusChanges]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit);
  });
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
 * re-resolves the focal entity per associated read, satisfying R3. (The first
 * call also warms the per-(user, workspace) token cache, so the fan-out
 * reuses one minted token.)
 *
 * When the focal entity is not visible, returns a denied/empty context WITHOUT
 * issuing the dependent requests — so a denied user gets nothing, never another
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
