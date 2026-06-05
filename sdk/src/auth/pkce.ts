/**
 * PKCE (RFC 7636) helpers for the Authorization Code flow. Uses Web Crypto
 * (`globalThis.crypto`), available in Node ≥18 and browsers — no dependencies.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Minimal structural Web Crypto surface (avoids needing the DOM lib types). */
interface WebCryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

function getCrypto(): WebCryptoLike {
  const c = (globalThis as { crypto?: unknown }).crypto as WebCryptoLike | undefined;
  if (!c?.subtle || typeof c.getRandomValues !== 'function') {
    throw new Error('Web Crypto (globalThis.crypto.subtle) is required for PKCE');
  }
  return c;
}

/** Generate a high-entropy code_verifier (RFC 7636 §4.1) and its S256 challenge. */
export async function generatePkce(): Promise<PkcePair> {
  const crypto = getCrypto();
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const verifier = base64UrlEncode(randomBytes); // 43-char unreserved string
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge, method: 'S256' };
}

/** Generate an opaque, URL-safe `state` value for CSRF protection of the redirect. */
export function generateState(): string {
  const crypto = getCrypto();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
