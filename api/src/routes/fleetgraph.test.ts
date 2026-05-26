import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// ── Mock the U4 model seam so the graph runs keyless + deterministic. ─────────
// `available` and the scripted chat model are mutated per-test. getBoundChatModel
// returns the scripted model so the chat reason node uses it.
const { modelState } = vi.hoisted(() => ({
  modelState: {
    available: true,
    next: () => new AIMessage('default'),
  } as { available: boolean; next: () => AIMessage },
}));

function scriptedModel(): BaseChatModel {
  const model: Record<string, unknown> = {
    _llmType: () => 'fake-scripted',
    lc_namespace: ['fake'],
    bindTools(_tools: unknown[]) {
      return model;
    },
    async invoke(_messages: unknown) {
      return modelState.next();
    },
  };
  return model as unknown as BaseChatModel;
}

vi.mock('../services/fleetgraph/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/fleetgraph/model.js')>();
  return {
    ...actual,
    isFleetGraphAvailable: () => modelState.available,
    getChatModel: () => scriptedModel(),
    getBoundChatModel: (_tools: unknown[]) => scriptedModel(),
  };
});

import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { generateOpenAPIDocument } from '../openapi/registry.js';
import '../openapi/schemas/index.js';
import { __resetFleetChatRateLimitForTests } from '../services/fleetgraph/rate-limit.js';

// Parse an SSE response body into typed events.
function parseSse(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const evLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (!evLine || !dataLine) continue;
    events.push({
      type: evLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)),
    });
  }
  return events;
}

describe('FleetGraph chat API', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const email = `fg-${runId}@ship.local`;
  const otherEmail = `fg-other-${runId}@ship.local`;
  const adminEmail = `fg-admin-${runId}@ship.local`;

  let sessionCookie: string;
  let otherSessionCookie: string;
  let adminSessionCookie: string;
  let csrfToken: string;
  let otherCsrfToken: string;
  let adminCsrfToken: string;
  let workspaceId: string;
  let userId: string;
  let otherUserId: string;
  let adminUserId: string;
  let projectId: string;
  let sprintId: string;

  async function makeSession(uid: string, wid: string): Promise<{ cookie: string; csrf: string }> {
    const sid = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')`,
      [sid, uid, wid]
    );
    let cookie = `session_id=${sid}`;
    const res = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    const connect = res.headers['set-cookie']?.[0]?.split(';')[0] || '';
    if (connect) cookie = `${cookie}; ${connect}`;
    return { cookie, csrf: res.body.token };
  }

  beforeAll(async () => {
    workspaceId = (await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`FG WS ${runId}`])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,'h','U') RETURNING id`, [email])).rows[0].id;
    otherUserId = (await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,'h','O') RETURNING id`, [otherEmail])).rows[0].id;
    adminUserId = (await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,'h','A') RETURNING id`, [adminEmail])).rows[0].id;

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'member')`, [workspaceId, userId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`, [workspaceId, adminUserId]);

    // otherUser is in a DIFFERENT workspace (cross-workspace tests) AND a member
    // of this workspace too (so a same-workspace non-owner non-admin GET → 403).
    const otherWs = (await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`FG Other ${runId}`])).rows[0].id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'member')`, [otherWs, otherUserId]);
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'member')`, [workspaceId, otherUserId]);

    ({ cookie: sessionCookie, csrf: csrfToken } = await makeSession(userId, workspaceId));
    ({ cookie: otherSessionCookie, csrf: otherCsrfToken } = await makeSession(otherUserId, workspaceId));
    ({ cookie: adminSessionCookie, csrf: adminCsrfToken } = await makeSession(adminUserId, workspaceId));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id IN ($1,$2,$3)', [userId, otherUserId, adminUserId]);
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id IN ($1,$2,$3)', [userId, otherUserId, adminUserId]);
    await pool.query('DELETE FROM users WHERE id IN ($1,$2,$3)', [userId, otherUserId, adminUserId]);
    await pool.query(`DELETE FROM workspaces WHERE name LIKE $1`, [`FG %${runId}`]);
  });

  beforeEach(async () => {
    modelState.available = true;
    modelState.next = () => new AIMessage('The project has one stalled issue.');
    __resetFleetChatRateLimitForTests();
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1 AND document_type IN ('project','sprint','issue','conversation')`, [workspaceId]);
    projectId = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
       VALUES ($1,'project','Test Project',$2,'workspace',$3) RETURNING id`,
      [workspaceId, userId, JSON.stringify({ plan: 'Reduce activation time' })]
    )).rows[0].id;
    sprintId = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
       VALUES ($1,'sprint','Week 12',$2,'workspace',$3) RETURNING id`,
      [workspaceId, userId, JSON.stringify({ status: 'planning' })]
    )).rows[0].id;
  });

  function chat(body: object, cookie = sessionCookie, csrf = csrfToken) {
    return request(app).post('/api/fleetgraph/chat').set('Cookie', cookie).set('x-csrf-token', csrf).send(body);
  }

  // ── R10/R11: streamed, grounded answer + SSE headers ──
  it('streams a grounded answer for a Project with event-stream headers (not buffered)', async () => {
    const res = await chat({ message: 'status?', entityId: projectId, entityType: 'project' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-transform');
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'final')).toBe(true);
    const final = events.find((e) => e.type === 'final')!;
    expect(String(final.data.answer)).toContain('stalled issue');
  });

  it('streams a grounded answer for a Week (sprint)', async () => {
    const res = await chat({ message: 'status?', entityId: sprintId, entityType: 'week' });
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'final')).toBe(true);
  });

  // ── R5/R12: propose → confirm/decline ──
  it('proposes a write (paused), confirm applies it and decline abandons it', async () => {
    modelState.next = () =>
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'propose_create_issue', args: { title: 'Follow up' }, id: 'c1', type: 'tool_call' }],
      });

    const res = await chat({ message: 'create an issue', entityId: projectId, entityType: 'project' });
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const paused = events.find((e) => e.type === 'paused');
    expect(paused).toBeTruthy();
    expect((paused!.data.proposal as { kind: string }).kind).toBe('create_issue');
    const conversationId = paused!.data.threadId as string;

    // GET re-surfaces the STRUCTURED pending proposal (U10 card), not a boolean.
    const beforeConfirm = await request(app).get(`/api/fleetgraph/conversations/${conversationId}`).set('Cookie', sessionCookie);
    expect(beforeConfirm.status).toBe(200);
    expect(beforeConfirm.body.pendingProposal).toBeTruthy();
    expect(beforeConfirm.body.pendingProposal.kind).toBe('create_issue');
    expect(beforeConfirm.body.pendingProposal.args).toMatchObject({ title: 'Follow up' });
    expect(beforeConfirm.body.pendingProposal.contentHash).toEqual(expect.any(String));

    // Confirm → applies the write.
    const confirmed = await request(app)
      .post('/api/fleetgraph/chat/confirm')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ conversationId, approved: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('answer');
    expect(confirmed.body.answer).toContain('Done');
    // After confirm the pending proposal is cleared (null).
    const afterConfirm = await request(app).get(`/api/fleetgraph/conversations/${conversationId}`).set('Cookie', sessionCookie);
    expect(afterConfirm.body.pendingProposal).toBeNull();
    // The issue was actually created under this workspace.
    const created = await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND document_type='issue' AND title = 'Follow up'`,
      [workspaceId]
    );
    expect(created.rowCount).toBe(1);

    // A fresh conversation; decline abandons.
    modelState.next = () =>
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'propose_create_issue', args: { title: 'Should not exist' }, id: 'c2', type: 'tool_call' }],
      });
    const res2 = await chat({ message: 'create another', entityId: projectId, entityType: 'project' });
    const paused2 = parseSse(res2.text).find((e) => e.type === 'paused')!;
    const conv2 = paused2.data.threadId as string;
    const declined = await request(app)
      .post('/api/fleetgraph/chat/confirm')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ conversationId: conv2, approved: false });
    expect(declined.status).toBe(200);
    expect(declined.body.answer).toMatch(/not made that change/i);
    const notCreated = await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND title = 'Should not exist'`,
      [workspaceId]
    );
    expect(notCreated.rowCount).toBe(0);
    // After decline the pending proposal is cleared (null).
    const afterDecline = await request(app).get(`/api/fleetgraph/conversations/${conv2}`).set('Cookie', sessionCookie);
    expect(afterDecline.body.pendingProposal).toBeNull();
  });

  // ── R15: hidden conversation doc + 'discusses' association, absent from lists ──
  it('creates a hidden conversation doc associated via discusses; absent from document lists', async () => {
    const res = await chat({ message: 'hi', entityId: projectId, entityType: 'project' });
    const final = parseSse(res.text).find((e) => e.type === 'final')!;
    const conversationId = final.data.threadId as string;

    // Stored as a hidden 'conversation' doc with a 'discusses' link to the project.
    const conv = await pool.query(`SELECT document_type FROM documents WHERE id = $1`, [conversationId]);
    expect(conv.rows[0].document_type).toBe('conversation');
    const assoc = await pool.query(
      `SELECT relationship_type FROM document_associations WHERE document_id = $1 AND related_id = $2`,
      [conversationId, projectId]
    );
    expect(assoc.rows[0]?.relationship_type).toBe('discusses');

    // Retrievable via the conversation GET (owner).
    const got = await request(app).get(`/api/fleetgraph/conversations/${conversationId}`).set('Cookie', sessionCookie);
    expect(got.status).toBe(200);
    expect(Array.isArray(got.body.transcript)).toBe(true);
    expect(got.body.transcript.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(got.body.pendingProposal).toBeNull(); // no write proposed in this turn

    // Absent from generic document list and by-id.
    const list = await request(app).get('/api/documents').set('Cookie', sessionCookie);
    expect(list.status).toBe(200);
    const listIds = (list.body.documents ?? list.body ?? []).map?.((d: { id: string }) => d.id) ?? [];
    expect(listIds).not.toContain(conversationId);
    const byId = await request(app).get(`/api/documents/${conversationId}`).set('Cookie', sessionCookie);
    expect(byId.status).toBe(404);
  });

  // ── R19: rate limit → 429, no model call ──
  it('returns 429 past the per-user chat limit with no model call', async () => {
    let invoked = 0;
    modelState.next = () => {
      invoked += 1;
      return new AIMessage('x');
    };
    // Exhaust the limiter by spying: easier to force via the limiter directly.
    const { checkFleetChatRateLimit } = await import('../services/fleetgraph/rate-limit.js');
    // Drain to the limit.
    for (let i = 0; i < 60; i++) checkFleetChatRateLimit(userId);
    const res = await chat({ message: 'status?', entityId: projectId, entityType: 'project' });
    expect(res.status).toBe(429);
    expect(invoked).toBe(0);
  });

  // ── R18: provider unavailable ──
  it('reports 503 unavailable when no AI provider is configured', async () => {
    modelState.available = false;
    const res = await chat({ message: 'status?', entityId: projectId, entityType: 'project' });
    expect(res.status).toBe(503);
    const confirmRes = await request(app)
      .post('/api/fleetgraph/chat/confirm')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send({ conversationId: crypto.randomUUID(), approved: true });
    expect(confirmRes.status).toBe(503);
  });

  // ── R9 (P0): cross-user confirm → 403, no write; non-owner non-admin GET → 403 ──
  it('a different user cannot confirm someone else\'s paused write (403, no write)', async () => {
    modelState.next = () =>
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'propose_create_issue', args: { title: 'Owner only' }, id: 'c1', type: 'tool_call' }],
      });
    const res = await chat({ message: 'create', entityId: projectId, entityType: 'project' });
    const paused = parseSse(res.text).find((e) => e.type === 'paused')!;
    const conversationId = paused.data.threadId as string;

    // otherUser (same workspace, not owner) tries to confirm → 403.
    const attack = await request(app)
      .post('/api/fleetgraph/chat/confirm')
      .set('Cookie', otherSessionCookie)
      .set('x-csrf-token', otherCsrfToken)
      .send({ conversationId, approved: true });
    expect(attack.status).toBe(403);
    const notCreated = await pool.query(`SELECT id FROM documents WHERE workspace_id=$1 AND title='Owner only'`, [workspaceId]);
    expect(notCreated.rowCount).toBe(0);

    // Non-owner non-admin GET on the transcript → 403.
    const getAttack = await request(app).get(`/api/fleetgraph/conversations/${conversationId}`).set('Cookie', otherSessionCookie);
    expect(getAttack.status).toBe(403);

    // Workspace admin CAN read it.
    const adminGet = await request(app).get(`/api/fleetgraph/conversations/${conversationId}`).set('Cookie', adminSessionCookie);
    expect(adminGet.status).toBe(200);
  });

  // ── one-in-flight-turn: a second turn while a proposal is pending → 409 ──
  it('rejects a second turn on a conversation with a pending proposal (409)', async () => {
    modelState.next = () =>
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'propose_create_issue', args: { title: 'Pending' }, id: 'c1', type: 'tool_call' }],
      });
    const res = await chat({ message: 'create', entityId: projectId, entityType: 'project' });
    const paused = parseSse(res.text).find((e) => e.type === 'paused')!;
    const conversationId = paused.data.threadId as string;

    const second = await chat({ message: 'again', entityId: projectId, entityType: 'project', conversationId });
    expect(second.status).toBe(409);
  });

  // ── transport: GET on chat route → 405 ──
  it('GET on the chat-turn route returns 405', async () => {
    const res = await request(app).get('/api/fleetgraph/chat').set('Cookie', sessionCookie);
    expect(res.status).toBe(405);
  });

  // ── auth / CSRF / leak ──
  it('unauthenticated GET conversation → 401', async () => {
    // The GET route has no CSRF gate, so an unauthenticated request reaches
    // authMiddleware and gets 401 (the mutating POST routes are CSRF-gated first).
    const res = await request(app).get(`/api/fleetgraph/conversations/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it('unauthenticated chat (no CSRF) is rejected', async () => {
    // conditionalCsrf is mounted before the route, so an unauthenticated mutating
    // request is rejected at the CSRF gate (403) before reaching authMiddleware.
    const res = await request(app).post('/api/fleetgraph/chat').send({ message: 'x', entityId: projectId, entityType: 'project' });
    expect(res.status).toBe(403);
  });

  it('chat on a non-visible entity → 404 (no leak)', async () => {
    // otherUser is in this workspace but the project is workspace-visible, so use
    // a fresh private project owned by the admin to make it invisible to other.
    const priv = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
       VALUES ($1,'project','Private',$2,'private','{}'::jsonb) RETURNING id`,
      [workspaceId, adminUserId]
    )).rows[0].id;
    const res = await chat({ message: 'x', entityId: priv, entityType: 'project' }, otherSessionCookie, otherCsrfToken);
    expect(res.status).toBe(404);
  });

  it('chat without a CSRF token is rejected', async () => {
    const res = await request(app).post('/api/fleetgraph/chat').set('Cookie', sessionCookie).send({ message: 'x', entityId: projectId, entityType: 'project' });
    expect(res.status).toBe(403);
  });

  it('confirm without a CSRF token is rejected', async () => {
    const res = await request(app).post('/api/fleetgraph/chat/confirm').set('Cookie', sessionCookie).send({ conversationId: crypto.randomUUID(), approved: true });
    expect(res.status).toBe(403);
  });

  // ── OpenAPI ──
  it('OpenAPI document includes the FleetGraph chat paths', () => {
    const doc = generateOpenAPIDocument();
    expect(doc.paths['/fleetgraph/chat']?.post).toBeTruthy();
    expect(doc.paths['/fleetgraph/chat/confirm']?.post).toBeTruthy();
    expect(doc.paths['/fleetgraph/conversations/{id}']?.get).toBeTruthy();
  });
});
