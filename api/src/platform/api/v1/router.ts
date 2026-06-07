import { Router } from 'express';
import type { Router as RouterType } from 'express';
import { requestIdMiddleware } from './request-id.js';
import { notFoundHandler, errorHandler } from './error-middleware.js';
import { meRouter } from './routes/me.js';
import { documentsRouter } from './routes/documents.js';
import { documentCommentsRouter } from './routes/comments.js';
import { documentHistoryRouter } from './routes/document-history.js';
import { typedDocumentRouters } from './routes/typed-documents.js';
import { webhooksRouter } from './routes/webhooks.js';
import { webhookDeliveriesRouter } from './routes/webhook-deliveries.js';
import { appsRouter } from './routes/apps.js';
import { connectionsRouter } from './routes/connections.js';
import { auditRouter } from './routes/audit.js';
import { scopesRouter } from './routes/scopes.js';
import { generateV1OpenApiDocument } from './openapi/spec.js';

/**
 * Public Platform API — version 1.
 *
 * This is the public contract a third party builds on. It is mounted at
 * `/api/v1` (see `app.ts`) and is deliberately separate from the internal
 * `/api/*` router.
 *
 * BOUNDARY (PRD §5.1): nothing under `api/src/platform/**` may import an
 * internal route handler (`api/src/routes/**`). The public layer talks to the
 * same db/services the internal routes use, but auth, scope, and audit attach
 * only here. The ESLint `no-restricted-imports` rule for `api/src/platform/**`
 * enforces this one-way door.
 *
 * Routes, the Bearer middleware, the ScopeRegistry, and the v1-specific error
 * middleware are wired into this router in later build phases.
 */
export const v1Router: RouterType = Router();

// Stamp a correlation id + X-Request-Id on every request first, so every
// response (including 404s and 500s below) can carry it.
v1Router.use(requestIdMiddleware);

// ── Resource routes ─────────────────────────────────────────────────────────
// Mounted in build order across later phases (me, documents, openapi.json).
// New routes go ABOVE the terminators.
// Public spec — no auth (a grader reads it before obtaining a token).
v1Router.get('/openapi.json', (_req, res) => {
  res.json(generateV1OpenApiDocument());
});

v1Router.use('/me', meRouter);
// Webhook routes before the typed-document loop so `/webhooks` and
// `/webhook-deliveries` are not shadowed by any future path collision.
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/webhook-deliveries', webhookDeliveriesRouter);
// Developer-platform admin surface (Developer Portal dogfoods these): apps +
// per-app webhooks/deliveries, connections, audit, and the scope catalog.
v1Router.use('/apps', appsRouter);
v1Router.use('/connections', connectionsRouter);
v1Router.use('/audit', auditRouter);
v1Router.use('/scopes', scopesRouter);
for (const resource of typedDocumentRouters) {
  v1Router.use(`/${resource.path}`, resource.router);
}
// Cross-document field history (one query for an N-document activity feed).
v1Router.use('/document-history', documentHistoryRouter);
// Document comments handle `/documents/:id/comments`; the generic documents
// router (`/:id`) doesn't match the extra segment, so order is cosmetic.
v1Router.use('/documents', documentCommentsRouter);
v1Router.use('/documents', documentsRouter);

// ── Terminators — keep LAST ─────────────────────────────────────────────────
// Any unmatched v1 path → ApiError 404; any thrown error → ApiError 500.
v1Router.use(notFoundHandler);
v1Router.use(errorHandler);

export default v1Router;
