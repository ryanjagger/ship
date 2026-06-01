import crypto from 'crypto';
import type { Request, Response } from 'express';

/**
 * The Platform API error contract (PRD §5.6).
 *
 * Every failure under `/api/v1/*` ships exactly this flat shape — distinct from
 * the internal `{ success:false, error:{ code, message } }` envelope and the
 * generic `{ error: string }`. A stranger integrates against one consistent
 * error shape, with `request_id` on every response for support correlation and
 * the missing scope named in `details` on a 403.
 */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  rate_limited: 429,
  server_error: 500,
};

export function statusForCode(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * The request_id stamped by `requestIdMiddleware`. Falls back to a fresh UUID
 * for the rare caller that runs before that middleware — notably the global
 * rate limiter, which is mounted on `/api/` ahead of the v1 router.
 */
export function resolveRequestId(req: Request): string {
  return req.platformRequestId ?? crypto.randomUUID();
}

export function buildApiError(
  code: ApiErrorCode,
  message: string,
  req: Request,
  details?: Record<string, unknown>
): ApiError {
  const request_id = resolveRequestId(req);
  return details ? { code, message, details, request_id } : { code, message, request_id };
}

export function sendApiError(
  res: Response,
  req: Request,
  code: ApiErrorCode,
  message: string,
  opts?: { details?: Record<string, unknown>; status?: number }
): void {
  res.status(opts?.status ?? STATUS_BY_CODE[code]).json(buildApiError(code, message, req, opts?.details));
}

/**
 * Throwable form. Handlers may `throw new ApiErrorException(...)`; the v1
 * `errorHandler` converts it to the `ApiError` body. Useful for unwinding out
 * of nested calls without threading `res` through.
 */
export class ApiErrorException extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts?: { details?: Record<string, unknown>; status?: number }
  ) {
    super(message);
    this.name = 'ApiErrorException';
    this.code = code;
    this.status = opts?.status ?? STATUS_BY_CODE[code];
    this.details = opts?.details;
  }
}
