import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { createApp } from '../app.js'
import { pool } from '../db/client.js'
import { postCommentCore, type FleetContext } from './comments-service.js'

/**
 * Characterization + parity tests for the comment-post core.
 *
 * There was no comments.test.ts before U6. This captures the CURRENT behavior of
 * `POST /api/documents/:id/comments` (via supertest, the route now delegates to
 * the service) AND asserts the extracted `postCommentCore` produces identical
 * results when called directly with a FleetContext (refactor parity).
 */
describe('comments-service (U6)', () => {
  const app = createApp()
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const testEmail = `comments-svc-${testRunId}@ship.local`

  let sessionCookie: string
  let csrfToken: string
  let workspaceId: string
  let userId: string
  let documentId: string
  let ctx: FleetContext

  beforeAll(async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Comments Svc ${testRunId}`])
    workspaceId = ws.rows[0].id

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Comments Svc User') RETURNING id`,
      [testEmail]
    )
    userId = user.rows[0].id
    ctx = { workspaceId, userId, isAdmin: false }

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    )

    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId]
    )
    sessionCookie = `session_id=${sessionId}`

    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie)
    csrfToken = csrfRes.body.token
    const connectSidCookie = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || ''
    if (connectSidCookie) sessionCookie = `${sessionCookie}; ${connectSidCookie}`

    const doc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'wiki', 'Doc For Comments', 'workspace', $2) RETURNING id`,
      [workspaceId, userId]
    )
    documentId = doc.rows[0].id
  })

  afterAll(async () => {
    await pool.query('DELETE FROM comments WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [userId])
    await pool.query('DELETE FROM users WHERE id = $1', [userId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  describe('route: POST /api/documents/:id/comments (characterization)', () => {
    it('creates a comment (201)', async () => {
      const res = await request(app)
        .post(`/api/documents/${documentId}/comments`)
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ comment_id: crypto.randomUUID(), content: 'Hello from route' })

      expect(res.status).toBe(201)
      expect(res.body.content).toBe('Hello from route')
      expect(res.body.document_id).toBe(documentId)
      expect(res.body.author.id).toBe(userId)
    })

    it('404 when document does not exist', async () => {
      const res = await request(app)
        .post(`/api/documents/${crypto.randomUUID()}/comments`)
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ comment_id: crypto.randomUUID(), content: 'orphan' })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Document not found')
    })

    it('404 when parent comment does not exist', async () => {
      const res = await request(app)
        .post(`/api/documents/${documentId}/comments`)
        .set('Cookie', sessionCookie)
        .set('x-csrf-token', csrfToken)
        .send({ comment_id: crypto.randomUUID(), content: 'reply', parent_id: crypto.randomUUID() })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Parent comment not found')
    })
  })

  describe('service: postCommentCore (parity)', () => {
    it('produces the same shape as the route', async () => {
      const result = await postCommentCore(pool, ctx, documentId, {
        comment_id: crypto.randomUUID(),
        content: 'Hello from service',
      })
      expect(result.status).toBe(201)
      const body = result.body as any
      expect(body.content).toBe('Hello from service')
      expect(body.document_id).toBe(documentId)
      expect(body.author.id).toBe(userId)
      // Persisted
      const check = await pool.query('SELECT id FROM comments WHERE id = $1', [body.id])
      expect(check.rows.length).toBe(1)
    })

    it('404 document-not-found mirrors the route', async () => {
      const result = await postCommentCore(pool, ctx, crypto.randomUUID(), {
        comment_id: crypto.randomUUID(),
        content: 'x',
      })
      expect(result.status).toBe(404)
      expect((result.body as any).error).toBe('Document not found')
    })

    it('supports threaded replies', async () => {
      const parent = await postCommentCore(pool, ctx, documentId, {
        comment_id: crypto.randomUUID(),
        content: 'parent',
      })
      const parentId = (parent.body as any).id
      const reply = await postCommentCore(pool, ctx, documentId, {
        comment_id: crypto.randomUUID(),
        content: 'child',
        parent_id: parentId,
      })
      expect(reply.status).toBe(201)
      expect((reply.body as any).parent_id).toBe(parentId)
    })
  })
})
