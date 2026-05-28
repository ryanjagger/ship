/**
 * /api/insights/* — read + resolve + manual-sweep endpoints over the
 * shipped insight substrate (`listInsights`, `getInsight`, `resolveInsight`,
 * `countInsights`) and the U2 sweep service (`sweepWorkspaceDrift`).
 *
 * AuthN: `authMiddleware` for every route.
 * AuthZ: visibility-scoped reads delegate to the substrate (`getInsight` /
 *        `listInsights` apply VISIBILITY_FILTER_SQL against the subject).
 *        The manual sweep route is `workspaceAdminMiddleware`-gated.
 *
 * See docs/plans/2026-05-28-001-feat-fleetgraph-insight-surfacing-plan.md
 * (U4) for the full design.
 */

import { Router, type Request, type Response } from 'express';
import type { Router as RouterType } from 'express';
import { z } from 'zod';
import {
  authMiddleware,
  assertAuthed,
  workspaceAdminMiddleware,
} from '../middleware/auth.js';
import { getVisibilityContext } from '../middleware/visibility.js';
import {
  listInsights,
  countInsights,
  getInsight,
  resolveInsight,
  InsightStateRaceError,
} from '../services/fleetgraph/insight.js';
import {
  sweepWorkspaceDrift,
  SweepInProgressError,
} from '../services/fleetgraph/sweep.js';
import type { InsightKind, InsightStatus } from '@ship/shared';

const router: RouterType = Router();

// ─── Local Zod schemas ──────────────────────────────────────────────────
// Mirror the OpenAPI registrations in openapi/schemas/insights.ts. We keep
// a local copy here so the route stays a single point of validation without
// reaching across the registry. Out-of-shape values get 400 before any
// service call.

const StateQuery = z.enum(['open', 'resolved', 'all']).optional().default('open');
const KindQuery = z.enum(['project_drift']).optional();

const ListQuery = z.object({
  state: StateQuery,
  kind: KindQuery,
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const CountQuery = z.object({
  state: StateQuery,
  kind: KindQuery,
});

const ResolveBody = z.object({
  reason: z.string().max(500).optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────

function toListStateOption(
  state: 'open' | 'resolved' | 'all'
): InsightStatus | 'all' {
  return state;
}

// ─── Routes ─────────────────────────────────────────────────────────────

// GET /api/insights — visibility-scoped list
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!assertAuthed(req, res)) return;

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_query',
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }
    const { state, kind, limit, offset } = parsed.data;

    const { isAdmin } = await getVisibilityContext(req.userId, req.workspaceId);

    const items = await listInsights({
      workspaceId: req.workspaceId,
      userId: req.userId,
      isAdmin,
      state: toListStateOption(state),
      kinds: kind ? [kind as InsightKind] : undefined,
      limit,
      offset,
    });

    res.json({ items });
  } catch (err) {
    console.error('List insights error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/insights/count — lightweight count
router.get('/count', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!assertAuthed(req, res)) return;

    const parsed = CountQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_query',
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }
    const { state, kind } = parsed.data;

    const { isAdmin } = await getVisibilityContext(req.userId, req.workspaceId);

    const count = await countInsights({
      workspaceId: req.workspaceId,
      userId: req.userId,
      isAdmin,
      state: toListStateOption(state),
      kinds: kind ? [kind as InsightKind] : undefined,
    });

    res.json({ count });
  } catch (err) {
    console.error('Count insights error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/insights/sweep — admin-only manual trigger. Registered BEFORE
// `/:id` so Express matches the literal path first.
router.post(
  '/sweep',
  authMiddleware,
  workspaceAdminMiddleware,
  async (req: Request, res: Response) => {
    try {
      if (!assertAuthed(req, res)) return;
      const result = await sweepWorkspaceDrift(req.workspaceId);
      res.json(result);
    } catch (err) {
      if (err instanceof SweepInProgressError) {
        res.status(409).json({ error: 'sweep_in_progress' });
        return;
      }
      console.error('Manual sweep error:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);

// GET /api/insights/:id — visibility-scoped fetch
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!assertAuthed(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!id) {
      res.status(400).json({ error: 'missing_id' });
      return;
    }

    const { isAdmin } = await getVisibilityContext(req.userId, req.workspaceId);

    const insight = await getInsight(id, {
      workspaceId: req.workspaceId,
      userId: req.userId,
      isAdmin,
    });

    if (!insight) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json(insight);
  } catch (err) {
    console.error('Get insight error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/insights/:id/resolve — visibility-checked, idempotent
router.post('/:id/resolve', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!assertAuthed(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!id) {
      res.status(400).json({ error: 'missing_id' });
      return;
    }

    const parsed = ResolveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_body',
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }

    // Precondition: caller must be able to see the insight. Using getInsight
    // here applies the substrate's visibility filter against the subject —
    // a non-visible insight returns 404 (same shape as a missing id),
    // preventing existence disclosure.
    const { isAdmin } = await getVisibilityContext(req.userId, req.workspaceId);
    const visible = await getInsight(id, {
      workspaceId: req.workspaceId,
      userId: req.userId,
      isAdmin,
    });
    if (!visible) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const result = await resolveInsight({
      insightId: id,
      workspaceId: req.workspaceId,
      reason: parsed.data.reason,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof InsightStateRaceError) {
      res.status(409).json({ error: 'state_race', message: err.message });
      return;
    }
    console.error('Resolve insight error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
