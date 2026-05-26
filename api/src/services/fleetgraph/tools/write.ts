/**
 * FleetGraph write tools (U6) — confirmable mutations under USER permissions.
 *
 * The agent can create issues, patch issues (status / owner / priority /
 * assignment / title), and post comments — but ONLY through the same
 * load-then-mutate logic the HTTP routes use (`issues-service.ts`,
 * `comments-service.ts`), scoped by the requesting user's `FleetContext`.
 * There is NO privileged write path: a write the user could not perform
 * (target not visible, etc.) is rejected by the same authorization that
 * rejects the user directly.
 *
 * ── PROPOSAL / EXECUTE SPLIT (critical for U7) ──────────────────────────────
 * Every write tool, when INVOKED by the model, does NOT mutate. It validates
 * its args against a strict zod schema, resolves them into a fully-resolved
 * `WriteProposal` object describing EXACTLY what will change, and returns that
 * proposal. U7's action node serializes this proposal into `interrupt(proposal)`
 * to surface it for human confirmation.
 *
 * On confirmation, U7 calls `executeProposal(ctx, proposal)` with the SAME
 * proposal object it surfaced — NEVER re-deriving args from model/graph state.
 * `executeProposal` applies exactly `proposal.args`. This closes the
 * confused-deputy gap: the args displayed == the args executed.
 *
 * To let U7 verify nothing tampered with the proposal between interrupt and
 * resume, every proposal carries a stable `contentHash` over `{kind,args}`.
 * `executeProposal` recomputes it and refuses to run if it differs (defense in
 * depth; U7 should also compare the resumed object identity).
 *
 * ── STRICT ZOD VALIDATION (untrusted-content boundary) ──────────────────────
 * LLM-generated tool args are derived from untrusted document content. Each
 * tool's schema bounds them HARD: ids are `uuid`, status/priority are the real
 * DB enums, free text is length-capped. A malformed or out-of-scope arg is
 * rejected at the type boundary before any proposal is even formed, so injected
 * content cannot smuggle a write past the tool.
 *
 * ── AUDIT + PROVENANCE ──────────────────────────────────────────────────────
 * Every successful agent write logs `logAuditEvent({ action, resourceType,
 * resourceId, details: { agent_initiated: true, approved_by: userId } })`, and
 * field changes flow `actorSource='fleetgraph'` into `document_history.automated_by`
 * (issue patches), marking the agent as the field-change source.
 */

import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import { logAuditEvent } from '../../audit.js';
import {
  createIssueCore,
  patchIssueCore,
  runIssueSideEffects,
  type CreateIssueInput,
  type UpdateIssueInput,
} from '../../issues-service.js';
import { postCommentCore, type PostCommentInput } from '../../comments-service.js';
import type { FleetContext } from '../../fleet-service.js';

export type { FleetContext };

/** The actor-source recorded for agent-driven field changes. */
export const FLEETGRAPH_SOURCE = 'fleetgraph';

// ---------------------------------------------------------------------------
// Shared enums (MUST match the real DB enums used by the routes' schemas)
// ---------------------------------------------------------------------------

const issueStateEnum = z.enum(['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
const issuePriorityEnum = z.enum(['urgent', 'high', 'medium', 'low', 'none']);
const belongsToTypeEnum = z.enum(['program', 'project', 'sprint', 'parent']);

const belongsToSchema = z.object({
  id: z.string().uuid(),
  type: belongsToTypeEnum,
});

// ---------------------------------------------------------------------------
// Strict per-tool arg schemas
// ---------------------------------------------------------------------------

/** create_issue: model-supplied args, hard-bounded. */
export const createIssueArgsSchema = z
  .object({
    title: z.string().min(1).max(500),
    state: issueStateEnum.optional(),
    priority: issuePriorityEnum.optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    belongs_to: z.array(belongsToSchema).max(20).optional(),
  })
  .strict();

/** patch_issue: status / owner / priority / assignment / title edit. */
export const patchIssueArgsSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    state: issueStateEnum.optional(),
    priority: issuePriorityEnum.optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    belongs_to: z.array(belongsToSchema).max(20).optional(),
    confirm_orphan_children: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.state !== undefined ||
      v.priority !== undefined ||
      v.assignee_id !== undefined ||
      v.belongs_to !== undefined,
    { message: 'patch_issue requires at least one field to change' }
  );

/** post_comment: free-text bounded; target + optional parent are uuids. */
export const postCommentArgsSchema = z
  .object({
    document_id: z.string().uuid(),
    content: z.string().min(1).max(10000),
    parent_id: z.string().uuid().optional(),
  })
  .strict();

export type CreateIssueArgs = z.infer<typeof createIssueArgsSchema>;
export type PatchIssueArgs = z.infer<typeof patchIssueArgsSchema>;
export type PostCommentArgs = z.infer<typeof postCommentArgsSchema>;

// ---------------------------------------------------------------------------
// Proposal shape (the object U7 serializes into interrupt(proposal))
// ---------------------------------------------------------------------------

export type WriteProposalKind = 'create_issue' | 'patch_issue' | 'post_comment';

/**
 * A fully-resolved, validated description of a pending write. This is the EXACT
 * object U7's action node surfaces via `interrupt()` and passes back to
 * `executeProposal()` on resume. U7 must NOT mutate `args` between surfacing and
 * executing — `executeProposal` re-verifies `contentHash` over `{kind,args}`.
 *
 * `summary` is a short human-readable line for the confirmation UI. `args` are
 * the validated tool args. `targetId` (when present) is the primary resource the
 * write acts on (for patch_issue / post_comment); create_issue has no target id
 * until executed.
 */
export interface WriteProposal {
  kind: WriteProposalKind;
  /** Human-readable one-liner for the confirmation surface. */
  summary: string;
  /** Primary resource id the write targets, when known pre-execution. */
  targetId: string | null;
  /** The validated tool args — the SINGLE source applied at execution time. */
  args: CreateIssueArgs | PatchIssueArgs | PostCommentArgs;
  /** Stable hash over {kind, args}; recomputed + checked at execute time. */
  contentHash: string;
}

function hashProposal(kind: WriteProposalKind, args: unknown): string {
  // Stable JSON (sorted keys) so the hash is deterministic across serialization.
  const json = JSON.stringify(args, Object.keys(args as object).sort());
  return crypto.createHash('sha256').update(`${kind}:${json}`).digest('hex');
}

function makeProposal(kind: WriteProposalKind, args: object, summary: string, targetId: string | null): WriteProposal {
  return { kind, summary, targetId, args: args as WriteProposal['args'], contentHash: hashProposal(kind, args) };
}

// ---------------------------------------------------------------------------
// Proposal builders (validate + resolve; NO mutation)
// ---------------------------------------------------------------------------

/**
 * Validate raw model args and build a proposal. Throws a ZodError if the args
 * are malformed/out-of-scope (uuid, enum, length) — the boundary that prevents
 * injected content from smuggling a write.
 */
export function buildCreateIssueProposal(rawArgs: unknown): WriteProposal {
  const args = createIssueArgsSchema.parse(rawArgs);
  return makeProposal('create_issue', args, `Create issue: "${args.title}"`, null);
}

export function buildPatchIssueProposal(rawArgs: unknown): WriteProposal {
  const args = patchIssueArgsSchema.parse(rawArgs);
  const parts: string[] = [];
  if (args.state) parts.push(`state→${args.state}`);
  if (args.priority) parts.push(`priority→${args.priority}`);
  if (args.assignee_id !== undefined) parts.push(`assignee→${args.assignee_id ?? 'none'}`);
  if (args.title) parts.push('title');
  if (args.belongs_to) parts.push('associations');
  return makeProposal('patch_issue', args, `Update issue ${args.id}: ${parts.join(', ') || 'no-op'}`, args.id);
}

export function buildPostCommentProposal(rawArgs: unknown): WriteProposal {
  const args = postCommentArgsSchema.parse(rawArgs);
  return makeProposal('post_comment', args, `Comment on ${args.document_id}`, args.document_id);
}

// ---------------------------------------------------------------------------
// Executor (applies EXACTLY the confirmed proposal args)
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  kind: WriteProposalKind;
  status: number;
  body: unknown;
  /** The resource id actually written (issue id / comment id). */
  resourceId: string | null;
  /** True iff a mutation was committed and audited. */
  mutated: boolean;
}

/**
 * Apply a confirmed proposal. Called by U7 on resume with the SAME proposal
 * object that was surfaced. Performs the mutation via the shared service core
 * (user-scoped authorization, transaction, provenance) and writes the audit
 * trail. Returns the route-equivalent status + body.
 *
 * A non-2xx status from the service core (e.g. 404 not-visible) is returned as
 * a NON-mutating result and is NOT audited as a write — the agent gets the same
 * denial the user would.
 */
export async function executeProposal(ctx: FleetContext, proposal: WriteProposal): Promise<ExecuteResult> {
  // Defense in depth: refuse to execute a proposal whose args were altered
  // after it was surfaced for confirmation.
  const expected = hashProposal(proposal.kind, proposal.args);
  if (expected !== proposal.contentHash) {
    throw new Error('Proposal integrity check failed: args differ from what was approved');
  }

  if (proposal.kind === 'create_issue') {
    return executeCreateIssue(ctx, proposal.args as CreateIssueArgs);
  }
  if (proposal.kind === 'patch_issue') {
    return executePatchIssue(ctx, proposal.args as PatchIssueArgs);
  }
  if (proposal.kind === 'post_comment') {
    return executePostComment(ctx, proposal.args as PostCommentArgs);
  }
  throw new Error(`Unknown proposal kind: ${(proposal as WriteProposal).kind}`);
}

async function executeCreateIssue(ctx: FleetContext, args: CreateIssueArgs): Promise<ExecuteResult> {
  const client = await pool.connect();
  try {
    const input: CreateIssueInput = {
      title: args.title,
      state: args.state,
      priority: args.priority,
      assignee_id: args.assignee_id ?? null,
      belongs_to: args.belongs_to ?? [],
    };
    const outcome = await createIssueCore(client, ctx, input);
    await runIssueSideEffects(outcome.sideEffects);
    const resourceId: string | null = (outcome.body as any)?.id ?? null;
    if (outcome.status === 201 && resourceId) {
      await logAuditEvent({
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId,
        action: 'issue.create',
        resourceType: 'issue',
        resourceId,
        details: { agent_initiated: true, approved_by: ctx.userId },
      });
    }
    return { kind: 'create_issue', status: outcome.status, body: outcome.body, resourceId, mutated: outcome.status === 201 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function executePatchIssue(ctx: FleetContext, args: PatchIssueArgs): Promise<ExecuteResult> {
  const client = await pool.connect();
  try {
    const input: UpdateIssueInput = {
      title: args.title,
      state: args.state,
      priority: args.priority,
      assignee_id: args.assignee_id,
      belongs_to: args.belongs_to,
      confirm_orphan_children: args.confirm_orphan_children,
    };
    // actorSource = 'fleetgraph' → document_history.automated_by provenance.
    const outcome = await patchIssueCore(client, ctx, args.id, input, FLEETGRAPH_SOURCE);
    await runIssueSideEffects(outcome.sideEffects);
    const mutated = outcome.status === 200;
    if (mutated) {
      await logAuditEvent({
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId,
        action: 'issue.update',
        resourceType: 'issue',
        resourceId: args.id,
        details: { agent_initiated: true, approved_by: ctx.userId },
      });
    }
    return { kind: 'patch_issue', status: outcome.status, body: outcome.body, resourceId: args.id, mutated };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function executePostComment(ctx: FleetContext, args: PostCommentArgs): Promise<ExecuteResult> {
  const input: PostCommentInput = {
    // The agent does not control the client-side comment_id; mint one server-side.
    comment_id: crypto.randomUUID(),
    content: args.content,
    parent_id: args.parent_id,
  };
  const outcome = await postCommentCore(pool, ctx, args.document_id, input);
  const mutated = outcome.status === 201;
  const resourceId: string | null = mutated ? (outcome.body as any).id : null;
  if (mutated) {
    await logAuditEvent({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      action: 'comment.create',
      resourceType: 'comment',
      resourceId: resourceId ?? undefined,
      details: { agent_initiated: true, approved_by: ctx.userId, document_id: args.document_id },
    });
  }
  return { kind: 'post_comment', status: outcome.status, body: outcome.body, resourceId, mutated };
}

// ---------------------------------------------------------------------------
// LangChain tool wrappers (model-invocable; FleetContext closed over)
// ---------------------------------------------------------------------------

/**
 * Build the write tools bound to a FleetContext. Each tool, when the model
 * calls it, returns a JSON-serialized `WriteProposal` — it does NOT mutate.
 * U7's action node intercepts the proposal, runs `interrupt()`, and on resume
 * calls `executeProposal(ctx, proposal)`.
 *
 * The FleetContext is captured in the closure and is NOT an LLM-visible arg, so
 * the model cannot widen its own scope.
 */
export function createWriteTools(ctx: FleetContext) {
  const createIssueTool = tool(
    async (rawArgs: unknown) => JSON.stringify(buildCreateIssueProposal(rawArgs)),
    {
      name: 'propose_create_issue',
      description:
        'Propose creating a new issue. Returns a proposal that must be confirmed by the user before it is executed. Does NOT create the issue immediately.',
      schema: createIssueArgsSchema,
    }
  );

  const patchIssueTool = tool(
    async (rawArgs: unknown) => JSON.stringify(buildPatchIssueProposal(rawArgs)),
    {
      name: 'propose_update_issue',
      description:
        'Propose updating an existing issue (status, priority, assignee, title, or associations). Returns a proposal that must be confirmed by the user before it is executed.',
      schema: patchIssueArgsSchema,
    }
  );

  const postCommentTool = tool(
    async (rawArgs: unknown) => JSON.stringify(buildPostCommentProposal(rawArgs)),
    {
      name: 'propose_post_comment',
      description:
        'Propose posting a comment on a document. Returns a proposal that must be confirmed by the user before it is executed.',
      schema: postCommentArgsSchema,
    }
  );

  return [createIssueTool, patchIssueTool, postCommentTool];
}
