import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Per-request correlation id for the Platform API. Set by requestIdMiddleware. */
      platformRequestId?: string;
    }
  }
}

/**
 * First middleware in the v1 chain: stamp a request id and echo it as
 * `X-Request-Id`. Every `ApiError` carries this id so a grader/integrator can
 * correlate a failure response with server logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = req.platformRequestId ?? crypto.randomUUID();
  req.platformRequestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
