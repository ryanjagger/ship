import type { Response } from 'express';

/**
 * RFC 6749 §5.2 token-endpoint error responses. The token endpoint speaks the
 * OAuth error format (`{ error, error_description? }`), NOT the Platform API
 * `ApiError` shape — `ApiError` is the contract for `/api/v1/*` resource routes.
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'server_error';

export function sendOAuthError(
  res: Response,
  status: number,
  error: OAuthErrorCode,
  description?: string
): void {
  res.status(status).json(description ? { error, error_description: description } : { error });
}
