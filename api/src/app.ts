import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { csrfSync } from 'csrf-sync';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import issuesRoutes from './routes/issues.js';
import feedbackRoutes, { publicFeedbackRouter } from './routes/feedback.js';
import programsRoutes from './routes/programs.js';
import projectsRoutes from './routes/projects.js';
import weeksRoutes from './routes/weeks.js';
import standupsRoutes from './routes/standups.js';
import iterationsRoutes from './routes/iterations.js';
import teamRoutes from './routes/team.js';
import workspacesRoutes from './routes/workspaces.js';
import adminRoutes from './routes/admin.js';
import invitesRoutes from './routes/invites.js';
import setupRoutes from './routes/setup.js';
import backlinksRoutes from './routes/backlinks.js';
import { searchRouter } from './routes/search.js';
import { filesRouter } from './routes/files.js';
import caiaAuthRoutes from './routes/caia-auth.js';
import apiTokensRoutes from './routes/api-tokens.js';
import adminCredentialsRoutes from './routes/admin-credentials.js';
import claudeRoutes from './routes/claude.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';
import associationsRoutes from './routes/associations.js';
import accountabilityRoutes from './routes/accountability.js';
import aiRoutes from './routes/ai.js';
import fleetgraphRoutes from './routes/fleetgraph.js';
import insightsRoutes from './routes/insights.js';
import weeklyPlansRoutes, { weeklyRetrosRouter } from './routes/weekly-plans.js';
import { documentCommentsRouter, commentsRouter } from './routes/comments.js';
import { v1Router } from './platform/api/v1/router.js';
import { apiRateLimitHandler } from './platform/api/v1/rate-limit.js';
import oauthAdminRoutes from './platform/oauth/admin-routes.js';
import developerRoutes from './routes/developer.js';
import { oauthPublicRouter, oauthConsentRouter } from './platform/oauth/routes.js';
import { setupSwagger } from './swagger.js';
import { initializeCAIA } from './services/caia.js';

// Validate SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production';

// CSRF protection setup
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

// Conditional CSRF middleware - skip for API token auth (Bearer tokens are not vulnerable to CSRF)
import { Request, Response, NextFunction } from 'express';
const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Skip CSRF for API token requests - Bearer tokens are not auto-attached by browsers
    return next();
  }
  // Apply CSRF protection for session-based auth
  return csrfSynchronisedProtection(req, res, next);
};

// Rate limiting configurations
// In test/dev environment, use much higher limits to avoid issues
// Production limits: login=5/15min (failed only), api=100/min
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
const isDevEnv = process.env.NODE_ENV !== 'production';

// Strict rate limit for login (5 failed attempts / 15 min) - brute force protection
// skipSuccessfulRequests: true means only failed attempts count toward the limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 1000 : 5, // High limit for tests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true, // Only count failed login attempts
});

// General API rate limit (100 req/min in prod, 1000 in dev)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100, // High limit for tests/dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  // Reshape 429s on the public /api/v1 prefix to the ApiError contract
  // (PRD §5.6). Other /api/* paths keep the legacy { error } body. No new
  // limiter is added — this is the existing global limiter's handler.
  handler: apiRateLimitHandler,
});


export function createApp(corsOrigin: string = 'http://localhost:5173'): express.Express {
  const app = express();

  // Trust the reverse proxy in front of us (AWS CloudFront/Elastic Beanstalk,
  // or Railway's edge) so secure-cookie handling, req.protocol, and
  // express-rate-limit's X-Forwarded-For client-IP resolution work correctly.
  // Railway terminates TLS at its edge and forwards X-Forwarded-For/-Proto;
  // without trust proxy, express-rate-limit throws
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. NODE_ENV alone is insufficient — the
  // Railway container may not run with NODE_ENV=production.
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    app.set('trust proxy', 1);
  }

  if (process.env.NODE_ENV === 'production') {
    // CloudFront with viewer_protocol_policy="redirect-to-https" always serves viewers over HTTPS.
    // However, CloudFront -> EB uses HTTP (origin_protocol_policy="http-only"), so CloudFront
    // sets X-Forwarded-Proto to "http". Override it to "https" when request comes via CloudFront.
    app.use((req, _res, next) => {
      // CloudFront adds Via header like "2.0 <id>.cloudfront.net (CloudFront)"
      const viaHeader = req.headers['via'] as string;
      if (viaHeader && viaHeader.includes('cloudfront')) {
        req.headers['x-forwarded-proto'] = 'https';
      }
      next();
    });
  }

  // gzip/deflate JSON responses. Default threshold is 1KB; list endpoints
  // like /api/issues and /api/documents?type=wiki are highly compressible.
  app.use(compression());

  // Middleware - Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },  // Allow images to be loaded cross-origin
    // Content Security Policy - prevents XSS attacks
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Admin credentials page uses inline scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // TipTap editor needs inline styles
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"], // WebSocket connections
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      }
    },
    // HTTP Strict Transport Security
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
  }));

  // Apply rate limiting to all API routes
  app.use('/api/', apiLimiter);
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));  // Large wiki documents can be several MB
  app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For HTML form submissions
  app.use(cookieParser(sessionSecret));

  // Session middleware for CSRF token storage
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes
    },
  }));

  // CSRF token endpoint (must be before CSRF protection middleware)
  app.get('/api/csrf-token', (req, res) => {
    res.json({ token: generateToken(req) });
  });

  // Health check (no CSRF needed)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // API documentation (no auth needed)
  setupSwagger(app);

  // Setup routes (CSRF protected - first-time setup only)
  app.use('/api/setup', conditionalCsrf, setupRoutes);

  // Public feedback routes - no auth or CSRF required (must be before protected routes)
  app.use('/api/feedback', publicFeedbackRouter);

  // Apply stricter rate limiting to login endpoint (brute force protection)
  app.use('/api/auth/login', loginLimiter);

  // Apply CSRF protection to all state-changing API routes
  app.use('/api/auth', conditionalCsrf, authRoutes);
  app.use('/api/documents', conditionalCsrf, documentsRoutes);
  app.use('/api/documents', conditionalCsrf, backlinksRoutes);
  app.use('/api/documents', conditionalCsrf, associationsRoutes);
  app.use('/api/issues', conditionalCsrf, issuesRoutes);
  app.use('/api/feedback', conditionalCsrf, feedbackRoutes);
  app.use('/api/programs', conditionalCsrf, programsRoutes);
  app.use('/api/projects', conditionalCsrf, projectsRoutes);
  app.use('/api/weeks', conditionalCsrf, weeksRoutes);
  app.use('/api/weeks', conditionalCsrf, iterationsRoutes);
  app.use('/api/standups', conditionalCsrf, standupsRoutes);
  app.use('/api/team', conditionalCsrf, teamRoutes);
  app.use('/api/workspaces', conditionalCsrf, workspacesRoutes);
  app.use('/api/admin', conditionalCsrf, adminRoutes);
  app.use('/api/invites', conditionalCsrf, invitesRoutes);
  app.use('/api/api-tokens', conditionalCsrf, apiTokensRoutes);

  // OAuth 2.0 Authorization Server (Ship as provider). Mounted under /api/oauth
  // so it rides the existing /api proxy. Two mounts with different needs:
  //   • public: GET /authorize (redirect) + POST /token (back-channel, NO CSRF —
  //     authenticated by client_id+client_secret, not a browser session).
  //   • consent: GET /authorize/validate + POST /authorize/decision back the
  //     React consent screen; session-authed and CSRF-protected (the POST).
  app.use('/api/oauth', oauthPublicRouter);
  app.use('/api/oauth', conditionalCsrf, oauthConsentRouter);

  // Public Platform API (v1). Bearer-token auth only, so no session CSRF here
  // (Bearer tokens are not auto-attached by browsers). Sits under the global
  // `/api/` rate limiter mounted above; its 429s are reshaped to ApiError by
  // that limiter's handler. Mounted separately from the internal `/api/*`
  // routers and owns its own error middleware.
  app.use('/api/v1', v1Router);

  // Claude context routes - read-only GET endpoints for Claude skills
  app.use('/api/claude', claudeRoutes);

  // Search routes are read-only GET endpoints - no CSRF needed
  app.use('/api/search', searchRouter);

  // Activity routes are read-only GET endpoints - no CSRF needed
  app.use('/api/activity', activityRoutes);

  // Dashboard routes are read-only GET endpoints - no CSRF needed
  app.use('/api/dashboard', dashboardRoutes);

  // Accountability routes - inference-based action items (read-only GET)
  app.use('/api/accountability', accountabilityRoutes);

  // AI analysis routes - plan and retro quality feedback (CSRF protected)
  app.use('/api/ai', conditionalCsrf, aiRoutes);

  // FleetGraph chat routes - SSE streaming turn + confirm/decline + conversation
  // fetch (CSRF protected). The chat POST sets `Content-Type: text/event-stream`
  // + `Cache-Control: no-transform` before its first write so the global
  // compression() (mounted at the top of createApp) does NOT buffer the stream;
  // mounting after compression does not by itself exempt the route.
  app.use('/api/fleetgraph', conditionalCsrf, fleetgraphRoutes);

  // Insights — read + resolve + manual sweep (writes are CSRF protected)
  app.use('/api/insights', conditionalCsrf, insightsRoutes);

  // Weekly plans routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-plans', conditionalCsrf, weeklyPlansRoutes);

  // Weekly retros routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-retros', conditionalCsrf, weeklyRetrosRouter);

  // CAIA auth routes - no CSRF protection (OAuth flow with external callback)
  // This is the single identity provider for PIV authentication
  // Mount at both /caia and /piv paths - /piv/callback is registered with CAIA
  app.use('/api/auth/caia', caiaAuthRoutes);
  app.use('/api/auth/piv', caiaAuthRoutes);

  // Admin credentials management (CSRF protected, super-admin only)
  app.use('/api/admin/credentials', conditionalCsrf, adminCredentialsRoutes);

  // OAuth app registration (CSRF protected, super-admin only). Mounted after
  // the generic /api/admin router so this more specific path is handled here;
  // same fall-through pattern as /api/admin/credentials above.
  app.use('/api/admin/oauth-apps', conditionalCsrf, oauthAdminRoutes);

  // Workspace-scoped developer portal (PRD §8): session-authed + CSRF +
  // workspace-admin guarded; wraps the OAuth/webhook/audit services.
  app.use('/api/developer', conditionalCsrf, developerRoutes);

  // File upload routes (CSRF protected for POST endpoints)
  app.use('/api/files', conditionalCsrf, filesRouter);

  // Comments routes
  app.use('/api/documents', conditionalCsrf, documentCommentsRouter);
  app.use('/api/comments', conditionalCsrf, commentsRouter);

  // Initialize CAIA OAuth client at startup
  initializeCAIA().catch((err) => {
    console.warn('CAIA initialization failed:', err);
  });

  return app;
}
