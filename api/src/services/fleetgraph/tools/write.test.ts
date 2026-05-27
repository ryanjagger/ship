import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'crypto'
import { pool } from '../../../db/client.js'
import {
  buildCreateIssueProposal,
  buildPatchIssueProposal,
  buildPostCommentProposal,
  executeProposal,
  createWriteTools,
  type FleetContext,
} from './write.js'

/**
 * U6 write-tool tests:
 *  - R8:  each tool, given an approved proposal, performs the mutation.
 *  - R9/AE2: a write for a target the user cannot see is rejected identically.
 *  - R12: successful writes audit `agent_initiated:true` + approver; issue field
 *         changes record `automated_by='fleetgraph'` in document_history.
 *  - Parity: tool-driven writes match route-driven writes (same service core).
 *  - Rollback: a DB error leaves no partial state.
 *  - Strict zod: malformed/out-of-scope args are rejected before any DB write.
 */
describe('FleetGraph write tools (U6)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  let workspaceId: string
  let userId: string
  let otherUserId: string
  let programId: string
  let projectId: string
  let privateProjectId: string
  let docId: string

  // ctx for the requesting (member) user
  let ctx: FleetContext
  // ctx for a DIFFERENT user who should NOT see the requester's private docs
  let otherCtx: FleetContext

  beforeAll(async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Write Tools ${testRunId}`])
    workspaceId = ws.rows[0].id

    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'h', 'Writer') RETURNING id`,
      [`write-${testRunId}@ship.local`]
    )
    userId = u.rows[0].id

    const u2 = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'h', 'Other') RETURNING id`,
      [`write-other-${testRunId}@ship.local`]
    )
    otherUserId = u2.rows[0].id

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, userId])
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, otherUserId])

    ctx = { workspaceId, userId, isAdmin: false }
    otherCtx = { workspaceId, userId: otherUserId, isAdmin: false }

    const prog = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility) VALUES ($1, 'program', 'Prog', 'workspace') RETURNING id`,
      [workspaceId]
    )
    programId = prog.rows[0].id

    const proj = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, parent_id) VALUES ($1, 'project', 'Proj', 'workspace', $2) RETURNING id`,
      [workspaceId, programId]
    )
    projectId = proj.rows[0].id

    // A PRIVATE project owned by `userId` — otherUserId cannot see it.
    const priv = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by) VALUES ($1, 'issue', 'Private Issue', 'private', $2) RETURNING id`,
      [workspaceId, userId]
    )
    privateProjectId = priv.rows[0].id

    const doc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by) VALUES ($1, 'wiki', 'Doc', 'workspace', $2) RETURNING id`,
      [workspaceId, userId]
    )
    docId = doc.rows[0].id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM comments WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM document_history WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)', [workspaceId])
    await pool.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)', [workspaceId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, otherUserId]])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  // -------------------------------------------------------------------------
  // R8: approved proposal performs the mutation
  // -------------------------------------------------------------------------
  describe('R8: proposals execute', () => {
    it('create_issue: proposal then execute creates the issue', async () => {
      const proposal = buildCreateIssueProposal({
        title: 'Agent-created issue',
        priority: 'high',
        belongs_to: [{ id: projectId, type: 'project' }],
      })
      expect(proposal.kind).toBe('create_issue')
      expect(proposal.targetId).toBeNull()

      const result = await executeProposal(ctx, proposal)
      expect(result.mutated).toBe(true)
      expect(result.status).toBe(201)
      expect(result.resourceId).toBeTruthy()

      const check = await pool.query(`SELECT title, properties->>'priority' as priority FROM documents WHERE id = $1`, [result.resourceId])
      expect(check.rows[0].title).toBe('Agent-created issue')
      expect(check.rows[0].priority).toBe('high')
    })

    it('patch_issue: status + owner patch applies', async () => {
      const created = await executeProposal(ctx, buildCreateIssueProposal({ title: 'To patch' }))
      const issueId = created.resourceId!

      const result = await executeProposal(
        ctx,
        buildPatchIssueProposal({ id: issueId, state: 'in_progress', assignee_id: userId })
      )
      expect(result.mutated).toBe(true)
      expect(result.status).toBe(200)

      const check = await pool.query(`SELECT properties->>'state' as state, properties->>'assignee_id' as assignee FROM documents WHERE id = $1`, [issueId])
      expect(check.rows[0].state).toBe('in_progress')
      expect(check.rows[0].assignee).toBe(userId)
    })

    it('post_comment: posts the comment', async () => {
      const proposal = buildPostCommentProposal({ document_id: docId, content: 'Agent comment' })
      const result = await executeProposal(ctx, proposal)
      expect(result.mutated).toBe(true)
      expect(result.status).toBe(201)

      const check = await pool.query(`SELECT content, author_id FROM comments WHERE id = $1`, [result.resourceId])
      expect(check.rows[0].content).toBe('Agent comment')
      expect(check.rows[0].author_id).toBe(userId)
    })

    it('tool wrapper returns a proposal (no immediate mutation)', async () => {
      const createTool = createWriteTools(ctx)[0]!
      const before = await pool.query(`SELECT COUNT(*)::int c FROM documents WHERE workspace_id = $1 AND document_type = 'issue'`, [workspaceId])
      const out = await (createTool as any).invoke({ title: 'Proposed only' })
      const proposal = JSON.parse(out as string)
      expect(proposal.kind).toBe('create_issue')
      expect(proposal.contentHash).toBeTruthy()
      const after = await pool.query(`SELECT COUNT(*)::int c FROM documents WHERE workspace_id = $1 AND document_type = 'issue'`, [workspaceId])
      expect(after.rows[0].c).toBe(before.rows[0].c) // tool call did NOT mutate
    })
  })

  // -------------------------------------------------------------------------
  // R9 / AE2: no agent bypass — user-permission boundary enforced
  // -------------------------------------------------------------------------
  describe('R9/AE2: authorization, no agent bypass', () => {
    it('patch on an issue the user cannot see is rejected (404), no mutation', async () => {
      // otherUserId cannot see userId's private issue.
      const proposal = buildPatchIssueProposal({ id: privateProjectId, state: 'done' })
      const result = await executeProposal(otherCtx, proposal)
      expect(result.mutated).toBe(false)
      expect(result.status).toBe(404)

      // confirm unchanged
      const check = await pool.query(`SELECT properties->>'state' as state FROM documents WHERE id = $1`, [privateProjectId])
      expect(check.rows[0].state ?? null).not.toBe('done')
    })

    it('the owner CAN patch the same private issue (parity of authorization)', async () => {
      const result = await executeProposal(ctx, buildPatchIssueProposal({ id: privateProjectId, priority: 'urgent' }))
      expect(result.mutated).toBe(true)
      expect(result.status).toBe(200)
    })

    it('comment on a non-existent/invisible document is rejected (404)', async () => {
      const result = await executeProposal(otherCtx, buildPostCommentProposal({ document_id: crypto.randomUUID(), content: 'x' }))
      expect(result.mutated).toBe(false)
      expect(result.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // R12: audit + provenance
  // -------------------------------------------------------------------------
  describe('R12: audit + provenance', () => {
    it('successful write logs agent_initiated:true + approver', async () => {
      const result = await executeProposal(ctx, buildCreateIssueProposal({ title: 'Audited issue' }))
      const audit = await pool.query(
        `SELECT action, resource_id, actor_user_id, details FROM audit_logs WHERE workspace_id = $1 AND resource_id = $2`,
        [workspaceId, result.resourceId]
      )
      expect(audit.rows.length).toBe(1)
      expect(audit.rows[0].action).toBe('issue.create')
      expect(audit.rows[0].actor_user_id).toBe(userId)
      expect(audit.rows[0].details.agent_initiated).toBe(true)
      expect(audit.rows[0].details.approved_by).toBe(userId)
    })

    it('issue field change records automated_by=fleetgraph in history', async () => {
      const created = await executeProposal(ctx, buildCreateIssueProposal({ title: 'Provenance issue' }))
      const issueId = created.resourceId!
      await executeProposal(ctx, buildPatchIssueProposal({ id: issueId, state: 'todo' }))

      const hist = await pool.query(
        `SELECT field, new_value, automated_by FROM document_history WHERE document_id = $1 AND field = 'state'`,
        [issueId]
      )
      expect(hist.rows.length).toBeGreaterThanOrEqual(1)
      expect(hist.rows[0].automated_by).toBe('fleetgraph')
      expect(hist.rows[0].new_value).toBe('todo')
    })

    it('a REJECTED write is NOT audited as a mutation', async () => {
      const before = await pool.query(`SELECT COUNT(*)::int c FROM audit_logs WHERE workspace_id = $1`, [workspaceId])
      await executeProposal(otherCtx, buildPatchIssueProposal({ id: privateProjectId, state: 'cancelled' }))
      const after = await pool.query(`SELECT COUNT(*)::int c FROM audit_logs WHERE workspace_id = $1`, [workspaceId])
      expect(after.rows[0].c).toBe(before.rows[0].c)
    })
  })

  // -------------------------------------------------------------------------
  // Strict zod validation (untrusted-content boundary)
  // -------------------------------------------------------------------------
  describe('strict zod arg validation', () => {
    it('rejects a bad uuid before any write', () => {
      expect(() => buildPatchIssueProposal({ id: 'not-a-uuid', state: 'done' })).toThrow()
    })
    it('rejects an invalid status enum', () => {
      expect(() => buildPatchIssueProposal({ id: crypto.randomUUID(), state: 'shipped' })).toThrow()
    })
    it('rejects over-length comment text', () => {
      expect(() => buildPostCommentProposal({ document_id: crypto.randomUUID(), content: 'a'.repeat(10001) })).toThrow()
    })
    it('rejects unknown keys (strict)', () => {
      expect(() => buildCreateIssueProposal({ title: 'x', sql: 'DROP TABLE documents' })).toThrow()
    })
    it('rejects a no-op patch (no fields)', () => {
      expect(() => buildPatchIssueProposal({ id: crypto.randomUUID() })).toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Focal default: a new issue belongs to the scoped project/week by default
  // -------------------------------------------------------------------------
  describe('create_issue focal default association', () => {
    it('defaults belongs_to to the focal entity when the model omits it', () => {
      const focal = crypto.randomUUID()
      const proposal = buildCreateIssueProposal({ title: 'AI Issue 1', priority: 'high' }, { id: focal, type: 'project' })
      expect((proposal.args as any).belongs_to).toEqual([{ id: focal, type: 'project' }])
    })

    it('maps a focal week to a sprint association', () => {
      const focal = crypto.randomUUID()
      const proposal = buildCreateIssueProposal({ title: 'Sprint work' }, { id: focal, type: 'sprint' })
      expect((proposal.args as any).belongs_to).toEqual([{ id: focal, type: 'sprint' }])
    })

    it('does NOT override an explicit model-supplied association', () => {
      const focal = crypto.randomUUID()
      const elsewhere = crypto.randomUUID()
      const proposal = buildCreateIssueProposal(
        { title: 'Linked elsewhere', belongs_to: [{ id: elsewhere, type: 'parent' }] },
        { id: focal, type: 'project' }
      )
      expect((proposal.args as any).belongs_to).toEqual([{ id: elsewhere, type: 'parent' }])
    })

    it('leaves belongs_to empty when there is no focal default', () => {
      const proposal = buildCreateIssueProposal({ title: 'No focal' })
      expect((proposal.args as any).belongs_to).toBeUndefined()
    })

    it('bakes the focal default into the contentHash (parity: surfaced == executed)', () => {
      const focal = crypto.randomUUID()
      const withDefault = buildCreateIssueProposal({ title: 'Same' }, { id: focal, type: 'project' })
      const withExplicit = buildCreateIssueProposal({ title: 'Same', belongs_to: [{ id: focal, type: 'project' }] })
      expect(withDefault.contentHash).toBe(withExplicit.contentHash)
    })
  })

  // -------------------------------------------------------------------------
  // Proposal integrity: executor refuses tampered args
  // -------------------------------------------------------------------------
  describe('proposal integrity', () => {
    it('executor rejects a proposal whose args were altered after approval', async () => {
      const proposal = buildPostCommentProposal({ document_id: docId, content: 'original' })
      ;(proposal.args as any).content = 'TAMPERED'
      await expect(executeProposal(ctx, proposal)).rejects.toThrow(/integrity/i)
    })

    it('contentHash covers NESTED arg content (belongs_to[].type), not just top-level keys (B1)', () => {
      // Two proposals identical except for a NESTED field. The old top-level
      // array-replacer hash would collide; the deep stable hash must differ.
      const id = crypto.randomUUID()
      const projectId2 = crypto.randomUUID()
      const a = buildCreateIssueProposal({ title: 'Same title', belongs_to: [{ id: projectId2, type: 'project' }] })
      const b = buildCreateIssueProposal({ title: 'Same title', belongs_to: [{ id: projectId2, type: 'parent' }] })
      expect(a.contentHash).not.toBe(b.contentHash)
      void id

      // And the integrity check rejects a tampered NESTED arg at execute time.
      const tampered = buildCreateIssueProposal({ title: 'X', belongs_to: [{ id: projectId2, type: 'project' }] })
      ;(tampered.args as any).belongs_to[0].type = 'parent'
      return expect(executeProposal(ctx, tampered)).rejects.toThrow(/integrity/i)
    })
  })

  // -------------------------------------------------------------------------
  // Rollback: a failing multi-statement write leaves no partial state
  // -------------------------------------------------------------------------
  describe('transaction rollback', () => {
    it('create_issue with an invalid association id rolls back (no orphan issue)', async () => {
      const before = await pool.query(`SELECT COUNT(*)::int c FROM documents WHERE workspace_id = $1 AND document_type = 'issue'`, [workspaceId])
      // A belongs_to id that is a valid uuid (passes zod) but not a real document
      // forces the association INSERT (FK) to fail inside the transaction.
      const proposal = buildCreateIssueProposal({
        title: 'Should roll back',
        belongs_to: [{ id: crypto.randomUUID(), type: 'project' }],
      })
      await expect(executeProposal(ctx, proposal)).rejects.toThrow()
      const after = await pool.query(`SELECT COUNT(*)::int c FROM documents WHERE workspace_id = $1 AND document_type = 'issue'`, [workspaceId])
      expect(after.rows[0].c).toBe(before.rows[0].c) // no partial issue committed
    })
  })
})
