import type { Request, Response, NextFunction } from 'express';
import { ApiErrorException, sendApiError } from './errors.js';

/**
 * 404 for any unmatched `/api/v1/*` path. Registered after all resource routes
 * so an unknown route still returns the `ApiError` shape rather than Express's
 * default HTML.
 */
export function notFoundHandler(req: Request, res: Response): void {
  sendApiError(res, req, 'not_found', `No such Platform API route: ${req.method} ${req.originalUrl}`);
}

/**
 * Terminal error middleware for the v1 router (4-arg signature → Express treats
 * it as an error handler). Guarantees every thrown failure ships as `ApiError`.
 * Known failures arrive as `ApiErrorException`; anything else is logged with the
 * request_id and surfaced as a generic `server_error` (no internals leaked).
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiErrorException) {
    sendApiError(res, req, err.code, err.message, { details: err.details, status: err.status });
    return;
  }

  console.error(`[api/v1] unhandled error (request_id=${req.platformRequestId ?? 'n/a'}):`, err);
  sendApiError(res, req, 'server_error', 'Internal server error');
}
