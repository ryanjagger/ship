import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';

// Mock the AI provider so route tests never hit a real model. Default:
// unavailable (deterministic-only). Individual tests flip availability.
const { isFleetAiAvailable, evaluateStructured, checkFleetRefreshRateLimit } = vi.hoisted(() => ({
  isFleetAiAvailable: vi.fn(() => false),
  evaluateStructured: vi.fn(),
  checkFleetRefreshRateLimit: vi.fn(() => true),
}));
vi.mock('../services/fleet-ai.js', () => ({
  isFleetAiAvailable,
  evaluateStructured,
  checkFleetRefreshRateLimit,
  isFleetAiError: (x: unknown) => typeof x === 'object' && x !== null && 'error' in x,
}));

import { createApp } from '../app.js';
import { pool } from '../db/client.js';
import { generateOpenAPIDocument } from '../openapi/registry.js';
import '../openapi/schemas/index.js'; // ensure Fleet paths register

const RUBRIC_IDS = [
  'measurable_outcome', 'quantifiable_target', 'baseline', 'timeframe',
  'scope', 'causal_claim', 'success_criteria_alignment',
];
function planAi(metCount: number) {
  return {
    criteria: RUBRIC_IDS.map((id, i) => ({ id, met: i < metCount, note: `n ${id}` })),
    suggested_rewrite: 'rewrite',
  };
}
const retroAi = {
  recommendation: 'insufficient_evidence',
  explanation: 'x',
  evidence_found: [],
  evidence_missing: ['No actual impact'],
  suggested_conclusion: '',
};
function wireAiAvailable() {
  isFleetAiAvailable.mockReturnValue(true);
  evaluateStructured.mockImplementation((req: { schemaName: string }) =>
    Promise.resolve(req.schemaName === 'fleet_plan_review' ? planAi(6) : retroAi)
  );
}

describe('Fleet plan-review API', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const testEmail = `fleet-${runId}@ship.local`;
  const otherEmail = `fleet-other-${runId}@ship.local`;
  const workspaceName = `Fleet Test ${runId}`;

  let sessionCookie: string;
  let otherSessionCookie: string;
  let csrfToken: string;
  let workspaceId: string;
  let userId: string;
  let otherUserId: string;
  let programId: string;
  let projectId: string;

  beforeAll(async () => {
    workspaceId = (await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [workspaceName])).rows[0].id;
    userId = (await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'h', 'Test User') RETURNING id`,
      [testEmail]
    )).rows[0].id;
    otherUserId = (await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'h', 'Other User') RETURNING id`,
      [otherEmail]
    )).rows[0].id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspaceId, userId]);

    const otherWsId = (await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Fleet Other ${runId}`])).rows[0].id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [otherWsId, otherUserId]);

    const sid = crypto.randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')`, [sid, userId, workspaceId]);
    sessionCookie = `session_id=${sid}`;
    const oSid = crypto.randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')`, [oSid, otherUserId, otherWsId]);
    otherSessionCookie = `session_id=${oSid}`;

    const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
    csrfToken = csrfRes.body.token;
    const connectSid = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
    if (connectSid) sessionCookie = `${sessionCookie}; ${connectSid}`;

    programId = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility) VALUES ($1,'program','P',$2,'workspace') RETURNING id`,
      [workspaceId, userId]
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id IN ($1,$2)', [userId, otherUserId]);
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id IN ($1,$2)', [userId, otherUserId]);
    await pool.query('DELETE FROM users WHERE id IN ($1,$2)', [userId, otherUserId]);
    await pool.query(`DELETE FROM workspaces WHERE name LIKE $1`, [`Fleet %${runId}`]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    isFleetAiAvailable.mockReturnValue(false);
    checkFleetRefreshRateLimit.mockReturnValue(true);
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1 AND document_type IN ('project','issue')`, [workspaceId]);
    projectId = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, parent_id, visibility, properties)
       VALUES ($1,'project','Test Project',$2,$3,'workspace',$4) RETURNING id`,
      [workspaceId, userId, programId, JSON.stringify({ plan: 'Reduce activation from 6 to 3 min by Q3', success_criteria: ['Median < 3 min'] })]
    )).rows[0].id;
  });

  it('GET returns 200 with plan_review, retro_recommendation, ai_available', async () => {
    wireAiAvailable();
    const res = await request(app).get(`/api/projects/${projectId}/fleet/plan-review`).set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.plan_review).toBeTruthy();
    expect(res.body.retro_recommendation).toBeTruthy();
    expect(res.body.ai_available).toBe(true);
    expect(res.body.plan_review.score).toBe(6);
  });

  it('AE4: with AI unavailable, GET still returns 200 with deterministic findings', async () => {
    isFleetAiAvailable.mockReturnValue(false);
    const res = await request(app).get(`/api/projects/${projectId}/fleet/plan-review`).set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.ai_available).toBe(false);
    expect(res.body.plan_review.score).toBeNull();
    expect(evaluateStructured).not.toHaveBeenCalled();
  });

  it('GET on nonexistent project → 404', async () => {
    const fake = crypto.randomUUID();
    const res = await request(app).get(`/api/projects/${fake}/fleet/plan-review`).set('Cookie', sessionCookie);
    expect(res.status).toBe(404);
  });

  it('GET unauthenticated → 401', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/fleet/plan-review`);
    expect(res.status).toBe(401);
  });

  it('GET for a user who cannot see the project → 404 (no cached analysis leak)', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/fleet/plan-review`).set('Cookie', otherSessionCookie);
    expect(res.status).toBe(404);
  });

  it('AE6: two GETs evaluate the model once (cache hit on the second)', async () => {
    wireAiAvailable();
    await request(app).get(`/api/projects/${projectId}/fleet/plan-review`).set('Cookie', sessionCookie).expect(200);
    const firstCallCount = evaluateStructured.mock.calls.length; // 2 (plan + retro)
    await request(app).get(`/api/projects/${projectId}/fleet/plan-review`).set('Cookie', sessionCookie).expect(200);
    expect(firstCallCount).toBe(2);
    expect(evaluateStructured.mock.calls.length).toBe(2); // unchanged → served from cache
  });

  it('POST refresh past the rate limit → 429 and no model call', async () => {
    wireAiAvailable();
    checkFleetRefreshRateLimit.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/projects/${projectId}/fleet/plan-review/refresh`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken);
    expect(res.status).toBe(429);
    expect(evaluateStructured).not.toHaveBeenCalled();
  });

  it('POST refresh forces a re-run even after a cached GET', async () => {
    wireAiAvailable();
    await request(app).get(`/api/projects/${projectId}/fleet/plan-review`).set('Cookie', sessionCookie).expect(200);
    expect(evaluateStructured.mock.calls.length).toBe(2);
    const res = await request(app)
      .post(`/api/projects/${projectId}/fleet/plan-review/refresh`)
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken);
    expect(res.status).toBe(200);
    expect(evaluateStructured.mock.calls.length).toBe(4); // forced re-run of both
  });

  it('OpenAPI document includes both Fleet paths', () => {
    const doc = generateOpenAPIDocument();
    expect(doc.paths['/projects/{id}/fleet/plan-review']?.get).toBeTruthy();
    expect(doc.paths['/projects/{id}/fleet/plan-review/refresh']?.post).toBeTruthy();
  });
});
