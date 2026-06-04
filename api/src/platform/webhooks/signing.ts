import crypto from 'crypto';

/**
 * Webhook request signing + verification (PRD §Signing).
 *
 * Outbound deliveries carry `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac>`.
 * The signed input is `<timestamp>.<raw-json-body>` under HMAC-SHA256 with the
 * subscription's raw signing secret. Verification is byte-exact against the raw
 * body (never re-serialized JSON), constant-time, and rejects stale timestamps.
 *
 * This module is the canonical algorithm; the public SDK's `verifyWebhook`
 * mirrors it exactly so the same test matrix applies to both.
 */

export const SIGNATURE_HEADER = 'Ship-Signature';
export const DEFAULT_TOLERANCE_SEC = 300; // reject signatures older than 5 minutes

/** HMAC-SHA256 of `<timestamp>.<rawBody>` as lowercase hex. */
export function signPayload(secret: string, timestamp: number, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** The full `Ship-Signature` header value for an outbound request. */
export function buildSignatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, rawBody)}`;
}

interface ParsedSignature {
  timestamp: number;
  v1: string;
}

/** Parse `t=...,v1=...` (order-independent). Returns null on any malformation. */
export function parseSignatureHeader(header: string | undefined | null): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      t = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      v1 = value;
    }
  }
  if (t === null || v1 === null) return null;
  return { timestamp: t, v1 };
}

/** Constant-time hex-string compare; false (not throw) on length mismatch. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface VerifyOptions {
  header: string | undefined | null;
  rawBody: string;
  secret: string;
  /** Max age in seconds (default 300). */
  toleranceSec?: number;
  /** Override "now" (unix seconds) for testing. */
  now?: number;
}

/**
 * Verify a webhook signature. Rejects malformed/missing headers, signatures
 * outside the tolerance window, and any payload/secret mismatch. Constant-time.
 */
export function verifySignature(opts: VerifyOptions): boolean {
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return false;

  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  const expected = signPayload(opts.secret, parsed.timestamp, opts.rawBody);
  return timingSafeEqualHex(parsed.v1, expected);
}
