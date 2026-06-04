import type { Request, Response } from 'express';
import { sendApiError } from '../errors.js';
import { consumeRateLimit, type BucketState } from './service.js';

/**
 * Platform rate-limit enforcement (PRD §6). Invoked from `bearerAuth` AFTER
 * `req.platform` is populated, so app_id and token_id are available. Returns
 * `true` when the request may proceed (and stamps `X-RateLimit-*` headers on the
 * response), or `false` after sending a 429 `rate_limited` ApiError with
 * `Retry-After`.
 *
 * Running it as the single post-auth step guarantees the success metric — every
 * authenticated `/api/v1/*` response carries rate-limit headers — without
 * touching each route. The public `GET /openapi.json` skips bearer auth, so it
 * is exempt by construction.
 */
function setRateLimitHeaders(res: Response, limiting: BucketState): void {
  res.setHeader('X-RateLimit-Limit', String(limiting.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limiting.remaining)));
  res.setHeader('X-RateLimit-Reset', String(limiting.resetAtSec));
}

export async function applyRateLimit(req: Request, res: Response): Promise<boolean> {
  const platform = req.platform;
  if (!platform) return true; // defensive: only called after auth

  let decision;
  try {
    decision = await consumeRateLimit(platform.appId, platform.tokenId);
  } catch (error) {
    // Fail OPEN: a limiter outage must not take down the whole public API. Log
    // and let the request through (the per-IP limiter still applies).
    console.error('[api/v1] rate limiter error (failing open):', error);
    return true;
  }

  setRateLimitHeaders(res, decision.limiting);

  if (!decision.allowed) {
    const retryAfter = Math.max(1, decision.limiting.retryAfterSec);
    res.setHeader('Retry-After', String(retryAfter));
    sendApiError(res, req, 'rate_limited', 'Rate limit exceeded. Please slow down.', {
      details: { retry_after: retryAfter, limit: decision.limiting.limit },
    });
    return false;
  }

  return true;
}
