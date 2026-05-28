/**
 * Route-level tests for /api/insights/* and /api/workspaces/settings/fleetgraph.
 *
 * Mocked-pool + mocked-middleware shape (mirrors projects.test.ts). The
 * substrate functions are mocked at the module boundary so we can assert
 * argument shapes (e.g. that the route forwards `state`/`kind` correctly,
 * that resolve catches `InsightStateRaceError`, etc.) without firing real
 * SQL.
 *
 * The auth middleware mock toggles `isAdmin` per-test via a hoisted
 * `adminMode` flag — admin tests set it to true before the request, then
 * the `workspaceAdminMiddleware` factory mock either calls next() or 403s.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Hoisted state for middleware/service mocks ─────────────────────────

const {
  adminMode,
  mockListInsights,
  mockCountInsights,
  mockGetInsight,
  mockResolveInsight,
  mockSweepWorkspaceDrift,
  mockGetFleetgraphSettings,
  mockSetFleetgraphSweepEnabled,
} = vi.hoisted(() => ({
  adminMode: { value: false },
  mockListInsights: vi.fn(),
  mockCountInsights: vi.fn(),
  mockGetInsight: vi.fn(),
  mockResolveInsight: vi.fn(),
  mockSweepWorkspaceDrift: vi.fn(),
  mockGetFleetgraphSettings: vi.fn(),
  mockSetFleetgraphSweepEnabled: vi.fn(),
}));

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('../db/client.js', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../middleware/visibility.js', () => ({
  // Reflect adminMode so list/count/get pass the right isAdmin to the substrate.
  getVisibilityContext: vi.fn(async () => ({ isAdmin: adminMode.value })),
  VISIBILITY_FILTER_SQL: vi.fn(() => '1=1'),
}));

vi.mock('../middleware/auth.js', () => ({
  assertAuthed: vi.fn(() => true),
  assertUserAuthed: vi.fn(() => true),
  authMiddleware: vi.fn((req, _res, next) => {
    req.userId = 'user-123';
    req.workspaceId = 'ws-123';
    next();
  }),
  workspaceAdminMiddleware: vi.fn((req, res, next) => {
    if (adminMode.value) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Workspace admin access required' },
    });
  }),
}));

// We must use the same `InsightStateRaceError` and `SweepInProgressError`
// class identities the route imports, so the `instanceof` checks succeed
// when the mock throws them. Defining shims inside the vi.mock factory
// keeps them disjoint from the real classes (route would not match them);
// the route uses `err instanceof X`, which requires the SAME constructor.
// Solution: export real classes from the mock by referencing the real module.
vi.mock('../services/fleetgraph/insight.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/fleetgraph/insight.js')
  >('../services/fleetgraph/insight.js');
  return {
    ...actual,
    listInsights: mockListInsights,
    countInsights: mockCountInsights,
    getInsight: mockGetInsight,
    resolveInsight: mockResolveInsight,
  };
});

vi.mock('../services/fleetgraph/sweep.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/fleetgraph/sweep.js')
  >('../services/fleetgraph/sweep.js');
  return {
    ...actual,
    sweepWorkspaceDrift: mockSweepWorkspaceDrift,
  };
});

vi.mock('../services/workspace-settings.js', () => ({
  getFleetgraphSettings: mockGetFleetgraphSettings,
  setFleetgraphSweepEnabled: mockSetFleetgraphSweepEnabled,
}));

// Real imports — these must come AFTER the mocks.
import insightsRouter from './insights.js';
import workspacesRouter from './workspaces.js';
import { InsightStateRaceError } from '../services/fleetgraph/insight.js';
import { SweepInProgressError } from '../services/fleetgraph/sweep.js';

// ─── App factory ────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/insights', insightsRouter);
  app.use('/api/workspaces', workspacesRouter);
  return app;
}

function sampleInsight(overrides: Record<string, unknown> = {}) {
  return {
    id: 'insight-1',
    workspace_id: 'ws-123',
    title: 'Project drift: Acme',
    created_at: '2026-05-27T00:00:00.000Z',
    insight: {
      state: 'open',
      kind: 'project_drift',
      severity: 'fyi',
      subject_id: 'subj-1',
      subject_entity_type: 'project',
      summary: 'drifting',
      recommended_action: 'review',
      evidence: { signals: [] },
      verdict: { decision: 'SURFACE_FYI', reasoning: 'mild' },
      input_hash: 'h1',
      accountable_owner_id: null,
      first_seen_at: '2026-05-20T00:00:00.000Z',
      last_seen_at: '2026-05-27T00:00:00.000Z',
      last_changed_at: '2026-05-27T00:00:00.000Z',
      occurrence_count: 1,
      resolved_at: null,
      resolved_reason: null,
      snoozed_until: null,
      dismissed_at: null,
      dismissed_by: null,
    },
    subject_id: 'subj-1',
    subject_title: 'Acme',
    subject_document_type: 'project',
    ...overrides,
  };
}

beforeEach(() => {
  adminMode.value = false;
  mockListInsights.mockReset();
  mockCountInsights.mockReset();
  mockGetInsight.mockReset();
  mockResolveInsight.mockReset();
  mockSweepWorkspaceDrift.mockReset();
  mockGetFleetgraphSettings.mockReset();
  mockSetFleetgraphSweepEnabled.mockReset();
});

// ─── GET /api/insights ──────────────────────────────────────────────────

describe('GET /api/insights', () => {
  it('returns { items: [...] } from listInsights', async () => {
    mockListInsights.mockResolvedValueOnce([sampleInsight(), sampleInsight({ id: 'insight-2' })]);
    const res = await request(buildApp()).get('/api/insights');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].id).toBe('insight-1');
  });

  it('default state defaults to "open" and forwards to substrate', async () => {
    mockListInsights.mockResolvedValueOnce([]);
    await request(buildApp()).get('/api/insights');
    const opts = mockListInsights.mock.calls[0]![0];
    expect(opts.state).toBe('open');
    expect(opts.workspaceId).toBe('ws-123');
    expect(opts.userId).toBe('user-123');
    expect(opts.isAdmin).toBe(false);
    expect(opts.limit).toBe(25);
    expect(opts.offset).toBe(0);
  });

  it('passes state=resolved through to listInsights', async () => {
    mockListInsights.mockResolvedValueOnce([]);
    await request(buildApp()).get('/api/insights?state=resolved');
    expect(mockListInsights.mock.calls[0]![0].state).toBe('resolved');
  });

  it('passes state=all through to listInsights', async () => {
    mockListInsights.mockResolvedValueOnce([]);
    await request(buildApp()).get('/api/insights?state=all');
    expect(mockListInsights.mock.calls[0]![0].state).toBe('all');
  });

  it('forwards kind filter as a single-element kinds array', async () => {
    mockListInsights.mockResolvedValueOnce([]);
    await request(buildApp()).get('/api/insights?kind=project_drift');
    expect(mockListInsights.mock.calls[0]![0].kinds).toEqual(['project_drift']);
  });

  it('clamps limit > 100 to a 400 error', async () => {
    const res = await request(buildApp()).get('/api/insights?limit=200');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
    expect(mockListInsights).not.toHaveBeenCalled();
  });

  it('rejects invalid state with 400', async () => {
    const res = await request(buildApp()).get('/api/insights?state=garbage');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
    expect(mockListInsights).not.toHaveBeenCalled();
  });

  it('admin context (isAdmin=true) is forwarded to substrate', async () => {
    adminMode.value = true;
    mockListInsights.mockResolvedValueOnce([]);
    await request(buildApp()).get('/api/insights');
    expect(mockListInsights.mock.calls[0]![0].isAdmin).toBe(true);
  });
});

// ─── GET /api/insights/count ────────────────────────────────────────────

describe('GET /api/insights/count', () => {
  it('returns { count } from countInsights', async () => {
    mockCountInsights.mockResolvedValueOnce(7);
    const res = await request(buildApp()).get('/api/insights/count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 7 });
  });

  it('forwards default state="open" and respects isAdmin', async () => {
    mockCountInsights.mockResolvedValueOnce(0);
    await request(buildApp()).get('/api/insights/count');
    const opts = mockCountInsights.mock.calls[0]![0];
    expect(opts.state).toBe('open');
    expect(opts.isAdmin).toBe(false);
  });

  it('forwards kind filter', async () => {
    mockCountInsights.mockResolvedValueOnce(2);
    await request(buildApp()).get('/api/insights/count?kind=project_drift');
    expect(mockCountInsights.mock.calls[0]![0].kinds).toEqual(['project_drift']);
  });
});

// ─── GET /api/insights/:id ──────────────────────────────────────────────

describe('GET /api/insights/:id', () => {
  it('200 happy path', async () => {
    mockGetInsight.mockResolvedValueOnce(sampleInsight());
    const res = await request(buildApp()).get('/api/insights/insight-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('insight-1');
    expect(mockGetInsight).toHaveBeenCalledWith('insight-1', {
      workspaceId: 'ws-123',
      userId: 'user-123',
      isAdmin: false,
    });
  });

  it('404 when getInsight returns null (not visible)', async () => {
    mockGetInsight.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get('/api/insights/insight-x');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('404 when id does not exist', async () => {
    mockGetInsight.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get('/api/insights/missing-id');
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/insights/:id/resolve ─────────────────────────────────────

describe('POST /api/insights/:id/resolve', () => {
  it('200 + resolve result on happy path', async () => {
    mockGetInsight.mockResolvedValueOnce(sampleInsight());
    mockResolveInsight.mockResolvedValueOnce({ priorState: 'open', didResolve: true });

    const res = await request(buildApp())
      .post('/api/insights/insight-1/resolve')
      .send({ reason: 'cleared' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ priorState: 'open', didResolve: true });
    expect(mockResolveInsight).toHaveBeenCalledWith({
      insightId: 'insight-1',
      workspaceId: 'ws-123',
      reason: 'cleared',
    });
  });

  it('already-resolved → 200 with didResolve=false (idempotent)', async () => {
    mockGetInsight.mockResolvedValueOnce(sampleInsight());
    mockResolveInsight.mockResolvedValueOnce({
      priorState: 'resolved',
      didResolve: false,
    });
    const res = await request(buildApp())
      .post('/api/insights/insight-1/resolve')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.didResolve).toBe(false);
    expect(res.body.priorState).toBe('resolved');
  });

  it('404 when the insight is not visible (precondition getInsight returns null)', async () => {
    mockGetInsight.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .post('/api/insights/insight-hidden/resolve')
      .send({});
    expect(res.status).toBe(404);
    expect(mockResolveInsight).not.toHaveBeenCalled();
  });

  it('400 on invalid body (reason too long)', async () => {
    mockGetInsight.mockResolvedValueOnce(sampleInsight());
    const longReason = 'x'.repeat(501);
    const res = await request(buildApp())
      .post('/api/insights/insight-1/resolve')
      .send({ reason: longReason });
    expect(res.status).toBe(400);
    expect(mockResolveInsight).not.toHaveBeenCalled();
  });

  it('maps InsightStateRaceError to 409', async () => {
    mockGetInsight.mockResolvedValueOnce(sampleInsight());
    mockResolveInsight.mockRejectedValueOnce(
      new InsightStateRaceError('Expected open, found resolved')
    );
    const res = await request(buildApp())
      .post('/api/insights/insight-1/resolve')
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('state_race');
  });
});

// ─── POST /api/insights/sweep ───────────────────────────────────────────

describe('POST /api/insights/sweep', () => {
  it('admin → 200 + SweepResult', async () => {
    adminMode.value = true;
    mockSweepWorkspaceDrift.mockResolvedValueOnce({
      workspaceId: 'ws-123',
      scanned: 4,
      created: 1,
      refreshed: 2,
      skipped: 1,
    });

    const res = await request(buildApp()).post('/api/insights/sweep').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workspaceId: 'ws-123',
      scanned: 4,
      created: 1,
      refreshed: 2,
      skipped: 1,
    });
    expect(mockSweepWorkspaceDrift).toHaveBeenCalledWith('ws-123');
  });

  it('non-admin → 403', async () => {
    const res = await request(buildApp()).post('/api/insights/sweep').send({});
    expect(res.status).toBe(403);
    expect(mockSweepWorkspaceDrift).not.toHaveBeenCalled();
  });

  it('SweepInProgressError → 409 with error key', async () => {
    adminMode.value = true;
    mockSweepWorkspaceDrift.mockRejectedValueOnce(new SweepInProgressError());
    const res = await request(buildApp()).post('/api/insights/sweep').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'sweep_in_progress' });
  });
});

// ─── /api/workspaces/settings/fleetgraph ────────────────────────────────

describe('GET /api/workspaces/settings/fleetgraph', () => {
  it('returns the fleetgraph settings for the current workspace (any member)', async () => {
    mockGetFleetgraphSettings.mockResolvedValueOnce({ sweepEnabled: true });
    const res = await request(buildApp()).get(
      '/api/workspaces/settings/fleetgraph'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sweepEnabled: true });
    expect(mockGetFleetgraphSettings).toHaveBeenCalledWith('ws-123');
  });
});

describe('PATCH /api/workspaces/settings/fleetgraph', () => {
  it('admin → 200 + updated settings', async () => {
    adminMode.value = true;
    mockSetFleetgraphSweepEnabled.mockResolvedValueOnce({ sweepEnabled: true });
    const res = await request(buildApp())
      .patch('/api/workspaces/settings/fleetgraph')
      .send({ sweepEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sweepEnabled: true });
    expect(mockSetFleetgraphSweepEnabled).toHaveBeenCalledWith('ws-123', true);
  });

  it('non-admin → 403', async () => {
    const res = await request(buildApp())
      .patch('/api/workspaces/settings/fleetgraph')
      .send({ sweepEnabled: true });
    expect(res.status).toBe(403);
    expect(mockSetFleetgraphSweepEnabled).not.toHaveBeenCalled();
  });

  it('admin + invalid body → 400', async () => {
    adminMode.value = true;
    const res = await request(buildApp())
      .patch('/api/workspaces/settings/fleetgraph')
      .send({ sweepEnabled: 'yes' });
    expect(res.status).toBe(400);
    expect(mockSetFleetgraphSweepEnabled).not.toHaveBeenCalled();
  });
});
