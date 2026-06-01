import crypto from 'crypto';

/**
 * PKCE (RFC 7636) verification. The MVP requires the S256 method (the plain
 * method is intentionally not accepted — /api/oauth/authorize rejects anything
 * but S256).
 */

export function base64UrlSha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Returns true iff `verifier` satisfies `challenge` under the given method.
 * Only S256 is honoured; any other method (including "plain") returns false.
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  return timingSafeEqualStr(base64UrlSha256(verifier), challenge);
}
