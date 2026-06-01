import type { Request, Response, NextFunction } from 'express';
import type { Options } from 'express-rate-limit';
import { buildApiError } from './errors.js';

/**
 * True for requests under the public `/api/v1` prefix. Uses `originalUrl`
 * because the global limiter is mounted at `app.use('/api/', ...)`, which
 * strips `/api` from `req.path`/`req.url` inside the handler — only
 * `originalUrl` retains the full path.
 */
export function isV1Request(req: Request): boolean {
  const url = req.originalUrl;
  return url === '/api/v1' || url.startsWith('/api/v1/') || url.startsWith('/api/v1?');
}

/**
 * Custom handler for the app's existing global `express-rate-limit` (PRD §5.6).
 * No new limiter is introduced. On the public `/api/v1` prefix it reshapes the
 * 429 to the `ApiError` contract (`code: 'rate_limited'`); every other `/api/*`
 * path keeps the legacy `{ error }` body unchanged. This is the only path
 * allowed to emit `rate_limited` for the gate.
 */
export function apiRateLimitHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
  options: Options
): void {
  if (isV1Request(req)) {
    res
      .status(options.statusCode)
      .json(buildApiError('rate_limited', 'Too many requests. Please slow down.', req));
    return;
  }
  res.status(options.statusCode).json(options.message);
}
