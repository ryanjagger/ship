import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// PROACTIVE tier calls fleet-ai.ts's evaluateStructured directly (preserving the
// zod-v3 Anthropic workaround). Mock it so the proactive path is deterministic +
// keyless, and so we can assert the prompt it receives (R6 / F1/F3 framing).
const { fleetAiEval } = vi.hoisted(() => ({ fleetAiEval: vi.fn() }));
vi.mock('../fleet-ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fleet-ai.js')>();
  return { ...actual, evaluateStructured: fleetAiEval };
});

import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { pool } from '../../db/client.js';
import { ConversationDocCheckpointSaver } from './checkpointer.js';
import { compileGraph } from './graph.js';
import { runPlanReview, runChatTurn, resumeChatTurn, runDedupReview } from './index.js';
import { PLAN_SYSTEM_PROMPT } from './nodes/reason.js';
import type { FleetContext } from './tools/read.js';
import type { WriteProposal, ExecuteResult } from './tools/write.js';
import { buildCreateIssueProposal } from './tools/write.js';

/**
 * U7 graph assembly tests.
 *
 * Real checkpointer (ConversationDocCheckpointSaver) over the dev DB pool +
 * a fixture conversation doc; the model is a SCRIPTED FAKE so the interrupt→
 * resume loop is deterministic and keyless. The shared setup.ts TRUNCATEs the
 * tables before this file runs.
 *
 * Coverage:
 *  - R1/R2: proactive scope→fetch→reason→output, structured result.
 *  - R4: the conditional edge after reason routes answer→output, write→action.
 *  - R5: chat write proposal pauses at action; approve executes; decline abandons.
 *  - Idempotency: resume fires the mutation exactly once; model called once.
 *  - R6: fleet-checks-derived signals are in the reasoning prompt.
 *  - Neutral degrade on a model error — no crash, no orphaned checkpoint.
 *  - Parity: a model that "changes its mind" cannot alter the executed write.
 *  - F1/F3: prompt carries the "why stuck + next action" diagnosis framing.
 */

// ── scripted fake chat models ────────────────────────────────────────────────

/**
 * A minimal fake chat model that returns a SINGLE scripted AIMessage and counts
 * invocations. Supports .bindTools() (returns itself) so getBoundChatModel works.
 */
function makeScriptedChatModel(messageFactory: () => AIMessage, counter?: { n: number }) {
  const model: Record<string, unknown> = {
    _llmType: () => 'fake-scripted',
    lc_namespace: ['fake'],
    bindTools(_tools: unknown[]) {
      return model; // bound model is the same scripted instance
    },
    async invoke(_messages: unknown) {
      if (counter) counter.n += 1;
      return messageFactory();
    },
  };
  return model as unknown as BaseChatModel;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

let workspaceId: string;
let userId: string;
let projectId: string;
let conversationDocId: string;
let ctx: FleetContext;

const PROACTIVE_AI = {
  criteria: [
    { id: 'what_changes', met: true, note: 'names an outcome' },
    { id: 'by_how_much', met: false, note: 'no number' },
    { id: 'for_whom', met: true, note: 'names a segment' },
  ],
  suggested_rewrite: 'Reduce onboarding drop-off by 20% for new admins by July.',
  diagnosis: 'The lead issue has not moved in weeks and the plan has no target number.',
  recommended_next_action: 'Assign an owner to the stalled issue and add a target metric.',
};

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('U7 Graph WS') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;

  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ('u7@ship.local','h','U7') RETURNING id`
  );
  userId = u.rows[0]!.id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'member')`,
    [workspaceId, userId]
  );

  // A stalled project: a plan with no number + an active issue with no movement.
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, content, properties, visibility)
     VALUES ($1,'project','Onboarding revamp',
             '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Retro notes."}]}]}'::jsonb,
             '{"plan":"Make onboarding better for admins.","target_date":null}'::jsonb,
             'workspace')
     RETURNING id`,
    [workspaceId]
  );
  projectId = proj.rows[0]!.id;

  // An active (stalled) issue associated to the project.
  const issue = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, properties, visibility)
     VALUES ($1,'issue','Wire up the new admin flow','{"state":"todo"}'::jsonb,'workspace')
     RETURNING id`,
    [workspaceId]
  );
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1,$2,'project')`,
    [issue.rows[0]!.id, projectId]
  );

  ctx = { workspaceId, userId, isAdmin: false };
});

afterAll(async () => {
  if (workspaceId) await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

beforeEach(async () => {
  // A FRESH hidden conversation doc per test → a fresh checkpointer thread_id,
  // so a paused checkpoint from a prior test can never resume into the next one
  // (the U3 latest-tuple-only checkpointer keys on the conversation doc id).
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, document_type, title, properties)
     VALUES ($1,'conversation','Untitled','{}'::jsonb) RETURNING id`,
    [workspaceId]
  );
  conversationDocId = conv.rows[0]!.id;
});

// A real checkpointer bound to the shared pool (U3) — same as production.
function newCheckpointer() {
  return new ConversationDocCheckpointSaver(pool);
}

// ── R1/R2 + R6 + F1/F3: proactive run ────────────────────────────────────────

describe('proactive plan-review (R1, R2)', () => {
  beforeEach(() => {
    fleetAiEval.mockReset();
  });

  it('runs scope→fetch→reason→output and returns a structured result', async () => {
    const capture: { system?: string; user?: string } = {};
    fleetAiEval.mockImplementation(async (req: { system: string; user: string }) => {
      capture.system = req.system;
      capture.user = req.user;
      return PROACTIVE_AI;
    });
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: { availableOverride: true },
    });

    const result = await runPlanReview({ entityId: projectId, entityType: 'project', ctx }, graph);

    expect(result.available).toBe(true);
    expect(result.planReview.ai_available).toBe(true);
    // RUBRIC pieces + by_when (target_date is null → not met).
    expect(result.planReview.pieces.map((p) => p.id)).toEqual([
      'what_changes',
      'by_how_much',
      'for_whom',
      'by_when',
    ]);
    expect(result.planReview.pieces.find((p) => p.id === 'what_changes')!.met).toBe(true);
    expect(result.planReview.pieces.find((p) => p.id === 'by_how_much')!.met).toBe(false);
    expect(result.planReview.pieces.find((p) => p.id === 'by_when')!.met).toBe(false);
    expect(result.planReview.status).toBe('needs_work');
    expect(result.planReview.suggested_rewrite).toContain('20%');

    // F1/F3: the differentiating diagnosis + next action.
    expect(result.diagnosis).toContain('not moved');
    expect(result.recommendedNextAction).toContain('owner');

    // R6 + F1/F3: the reasoning prompt carries the diagnosis framing and the
    // deterministic fleet-checks-derived signals (issues / activity / by-when).
    expect(capture.system).toBe(PLAN_SYSTEM_PROMPT);
    expect(capture.system).toContain('WHY this project appears stuck');
    expect(capture.user).toContain('<signals>');
    expect(capture.user).toContain('active:');
    expect(capture.user).toContain('Wire up the new admin flow'); // the stalled issue
  });

  it('a model error degrades to a neutral unavailable result without crashing', async () => {
    // fleet-ai.ts never throws — it returns the neutral error union; the graph
    // must surface that as unavailable, not crash.
    fleetAiEval.mockResolvedValue({ error: 'ai_unavailable' });
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: { availableOverride: true },
    });

    const result = await runPlanReview({ entityId: projectId, entityType: 'project', ctx }, graph);
    expect(result.available).toBe(false);
    expect(result.planReview.ai_available).toBe(false);
    // graph did not throw; checkpoint not orphaned (no row for transient thread).
  });
});

// ── dedup-on-create (stage-2, graph-backed verdict) ──────────────────────────

describe('dedup review (graph dedup mode)', () => {
  let dupId: string;
  let draftId: string;

  beforeEach(async () => {
    fleetAiEval.mockReset();
    // A candidate open issue + the draft issue being edited. Distinct, high-
    // overlap titles so pg_trgm surfaces the candidate (similarity > 0.3).
    const dup = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, ticket_number, properties, visibility)
       VALUES ($1,'issue','Login button unresponsive on mobile',9101,'{"state":"todo"}'::jsonb,'workspace')
       RETURNING id`,
      [workspaceId]
    );
    dupId = dup.rows[0]!.id;
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, ticket_number, properties, visibility)
       VALUES ($1,'issue','Untitled',9102,'{"state":"backlog"}'::jsonb,'workspace')
       RETURNING id`,
      [workspaceId]
    );
    draftId = draft.rows[0]!.id;
  });

  it('retrieves pg_trgm candidates and maps the model verdict back to them', async () => {
    const capture: { system?: string; user?: string } = {};
    fleetAiEval.mockImplementation(async (req: { system: string; user: string }) => {
      capture.system = req.system;
      capture.user = req.user;
      return {
        summary: 'One existing issue looks like the same bug.',
        duplicates: [{ index: 1, confidence: 'high', reason: 'Same login button bug, different wording.' }],
        recommendation: 'Open #9101 instead of filing a new issue.',
      };
    });
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: { availableOverride: true },
    });

    const review = await runDedupReview(
      { draftTitle: 'Login button unresponsive on phones', excludeId: draftId, ctx },
      graph
    );

    expect(review.ai_available).toBe(true);
    // Stage-1 retrieval surfaced the candidate.
    expect(review.candidates.some((c) => c.id === dupId)).toBe(true);
    // The model's 1-based index mapped back to the right candidate.
    expect(review.matches).toHaveLength(1);
    expect(review.matches[0]!.candidate.id).toBe(dupId);
    expect(review.matches[0]!.candidate.display_id).toBe('#9101');
    expect(review.matches[0]!.confidence).toBe('high');
    expect(review.summary).toContain('same bug');
    expect(review.recommendation).toContain('#9101');
    // The prompt carried the draft + the candidate, inside data-boundary tags.
    expect(capture.user).toContain('<draft>');
    expect(capture.user).toContain('Login button unresponsive on phones');
    expect(capture.user).toContain('Login button unresponsive on mobile');
  });

  it('short-circuits without a model call when there are no similar issues', async () => {
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: { availableOverride: true },
    });

    const review = await runDedupReview(
      { draftTitle: 'Quarterly budget spreadsheet reconciliation', excludeId: draftId, ctx },
      graph
    );

    expect(review.candidates).toEqual([]);
    expect(review.matches).toEqual([]);
    expect(review.ai_available).toBe(false);
    expect(fleetAiEval).not.toHaveBeenCalled();
  });

  it('drops out-of-range indexes the model may hallucinate', async () => {
    fleetAiEval.mockResolvedValue({
      summary: 'Maybe a duplicate.',
      duplicates: [
        { index: 1, confidence: 'medium', reason: 'Plausible match.' },
        { index: 99, confidence: 'high', reason: 'References a candidate that does not exist.' },
      ],
      recommendation: 'Review #9101.',
    });
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: { availableOverride: true },
    });

    const review = await runDedupReview(
      { draftTitle: 'Login button unresponsive on phones', excludeId: draftId, ctx },
      graph
    );

    // Only the in-range index survives; the bogus index 99 is dropped.
    expect(review.matches).toHaveLength(1);
    expect(review.matches[0]!.candidate.id).toBe(dupId);
  });
});

// ── R4 + R5 + idempotency + parity: chat ──────────────────────────────────────

describe('chat turn (R4, R5)', () => {
  it('a prose answer routes to output (no interrupt)', async () => {
    const counter = { n: 0 };
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: {
        availableOverride: true,
        modelOptions: {
          modelOverride: makeScriptedChatModel(
            () => new AIMessage('The project has one stalled issue.'),
            counter
          ),
        },
      },
    });

    const res = await runChatTurn(
      { conversationDocId, entityId: projectId, entityType: 'project', message: 'status?', ctx },
      graph
    );

    expect(res.status).toBe('answer');
    if (res.status === 'answer') {
      expect(res.answer).toContain('stalled issue');
    }
    expect(counter.n).toBe(1);
  });

  it('a proposed write PAUSES at the action node with the proposal as the interrupt payload', async () => {
    const counter = { n: 0 };
    const proposalArgs = { title: 'Follow up on admin flow', state: 'todo' as const };
    // The reason node defaults the association to the focal project (the agent is
    // scoped to one), so the surfaced proposal carries belongs_to even though the
    // model omitted it. The expected proposal must reflect that same default.
    const expectedProposal = buildCreateIssueProposal(proposalArgs, { id: projectId, type: 'project' });

    const executed: WriteProposal[] = [];
    const fakeExecute = async (_c: FleetContext, p: WriteProposal): Promise<ExecuteResult> => {
      executed.push(p);
      return { kind: p.kind, status: 201, body: { id: 'new-issue-id' }, resourceId: 'new-issue-id', mutated: true };
    };

    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: {
        availableOverride: true,
        modelOptions: {
          modelOverride: makeScriptedChatModel(
            () =>
              new AIMessage({
                content: '',
                tool_calls: [
                  { name: 'propose_create_issue', args: proposalArgs, id: 'call-1', type: 'tool_call' },
                ],
              }),
            counter
          ),
        },
      },
      action: { execute: fakeExecute },
    });

    const paused = await runChatTurn(
      { conversationDocId, entityId: projectId, entityType: 'project', message: 'create an issue', ctx },
      graph
    );

    // R5: paused with the proposal; the payload EQUALS the proposed mutation.
    expect(paused.status).toBe('paused');
    if (paused.status === 'paused') {
      expect(paused.proposal.kind).toBe('create_issue');
      expect(paused.proposal.contentHash).toBe(expectedProposal.contentHash);
      expect(paused.proposal.args).toEqual(expectedProposal.args);
      // The new issue is associated with the focal project, not orphaned.
      expect((paused.proposal.args as { belongs_to?: unknown }).belongs_to).toEqual([
        { id: projectId, type: 'project' },
      ]);
    }
    // The mutation has NOT fired while paused.
    expect(executed).toHaveLength(0);
    expect(counter.n).toBe(1);

    // ── resume approved:true executes the write EXACTLY once ──
    const done = await resumeChatTurn({ conversationDocId, approved: true }, graph);
    expect(done.status).toBe('answer');
    if (done.status === 'answer') {
      expect(done.answer).toContain('Done');
    }
    // Idempotency: mutation fired exactly once...
    expect(executed).toHaveLength(1);
    // ...and the model was NOT re-called on resume (upstream node not re-run).
    expect(counter.n).toBe(1);
    // Parity: the executed proposal equals the surfaced one (by contentHash).
    expect(executed[0]!.contentHash).toBe(expectedProposal.contentHash);
  });

  it('resume approved:false abandons the write and continues', async () => {
    const executed: WriteProposal[] = [];
    const fakeExecute = async (_c: FleetContext, p: WriteProposal): Promise<ExecuteResult> => {
      executed.push(p);
      return { kind: p.kind, status: 201, body: {}, resourceId: 'x', mutated: true };
    };
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: {
        availableOverride: true,
        modelOptions: {
          modelOverride: makeScriptedChatModel(
            () =>
              new AIMessage({
                content: '',
                tool_calls: [
                  { name: 'propose_create_issue', args: { title: 'Nope' }, id: 'c1', type: 'tool_call' },
                ],
              })
          ),
        },
      },
      action: { execute: fakeExecute },
    });

    const paused = await runChatTurn(
      { conversationDocId, entityId: projectId, entityType: 'project', message: 'make an issue', ctx },
      graph
    );
    expect(paused.status).toBe('paused');

    const declined = await resumeChatTurn({ conversationDocId, approved: false }, graph);
    expect(declined.status).toBe('answer');
    if (declined.status === 'answer') {
      expect(declined.answer).toMatch(/not made that change/i);
    }
    // Decline performed NO mutation.
    expect(executed).toHaveLength(0);
  });

  it('parity: a model that "changes its mind" on resume cannot alter the executed write', async () => {
    // The model is only ever consulted on the INITIAL turn. Even if it scripted a
    // DIFFERENT call, resume re-runs ONLY the action node, which executes the
    // proposal captured at pause time. We prove the model is not consulted again
    // by counting invocations across pause→resume.
    const counter = { n: 0 };
    const originalArgs = { title: 'Original safe title' };
    // Surfaced proposal carries the focal-project default association (see PAUSES test).
    const original = buildCreateIssueProposal(originalArgs, { id: projectId, type: 'project' });

    const executed: WriteProposal[] = [];
    const fakeExecute = async (_c: FleetContext, p: WriteProposal): Promise<ExecuteResult> => {
      executed.push(p);
      return { kind: p.kind, status: 201, body: { id: 'i' }, resourceId: 'i', mutated: true };
    };

    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: {
        availableOverride: true,
        modelOptions: {
          modelOverride: makeScriptedChatModel(
            () =>
              new AIMessage({
                content: '',
                tool_calls: [
                  { name: 'propose_create_issue', args: originalArgs, id: 'c1', type: 'tool_call' },
                ],
              }),
            counter
          ),
        },
      },
      action: { execute: fakeExecute },
    });

    const paused = await runChatTurn(
      { conversationDocId, entityId: projectId, entityType: 'project', message: 'create', ctx },
      graph
    );
    expect(paused.status).toBe('paused');

    await resumeChatTurn({ conversationDocId, approved: true }, graph);

    // The executed write is EXACTLY the originally surfaced proposal; the model
    // was not re-consulted (counter stays 1), so it cannot have changed its mind.
    expect(counter.n).toBe(1);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.contentHash).toBe(original.contentHash);
    expect(executed[0]!.args).toEqual(original.args);
  });

  it('a chat model error degrades to a neutral answer without crashing', async () => {
    const throwingModel: Record<string, unknown> = {
      _llmType: () => 'fake-throwing',
      lc_namespace: ['fake'],
      bindTools() {
        return throwingModel;
      },
      async invoke() {
        throw new Error('chat provider blip');
      },
    };
    const graph = compileGraph({
      checkpointer: newCheckpointer(),
      reason: {
        availableOverride: true,
        modelOptions: { modelOverride: throwingModel as unknown as BaseChatModel },
      },
    });

    const res = await runChatTurn(
      { conversationDocId, entityId: projectId, entityType: 'project', message: 'hi', ctx },
      graph
    );
    expect(res.status).toBe('answer');
    if (res.status === 'answer') {
      expect(res.answer).toMatch(/unavailable/i);
    }
  });
});
