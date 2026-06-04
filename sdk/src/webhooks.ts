/**
 * Webhook signature verification for the Ship Platform API.
 *
 * Ship signs outbound webhooks with `Ship-Signature: t=<unix>,v1=<hex-hmac>`,
 * where the HMAC-SHA256 input is `<timestamp>.<raw-request-body>` keyed by the
 * subscription's signing secret (`whsec_…`). `verifyWebhook` reproduces that and
 * compares in constant time.
 *
 * IMPORTANT: verify against the RAW request body bytes exactly as received — not
 * a re-serialized JSON object. In Express, capture the raw body (e.g.
 * `express.raw({ type: 'application/json' })`); in a Fetch handler use
 * `await request.text()` and parse only AFTER verifying.
 *
 * This runs server-side (Node) and uses `node:crypto`.
 */

import crypto from 'node:crypto';

/** Default tolerance: reject signatures whose timestamp is older than 5 minutes. */
export const DEFAULT_TOLERANCE_SEC = 300;

export interface VerifyWebhookOptions {
  /** Max signature age in seconds. Defaults to 300 (5 minutes). */
  toleranceSec?: number;
  /** Override "now" (unix seconds) — for testing. */
  now?: number;
}

/**
 * Headers as received. Accepts a plain object (Express `req.headers`) or a
 * `Headers`/`Map`-like with a `.get()` method (Fetch `Request.headers`).
 */
export type WebhookHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

const SIGNATURE_HEADER = 'ship-signature';

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  // HTTP header names are case-insensitive; Node lowercases incoming headers.
  const value = record[name] ?? record[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

interface ParsedSignature {
  timestamp: number;
  v1: string;
}

function parseSignatureHeader(header: string | undefined): ParsedSignature | null {
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

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** The HMAC-SHA256 signature of `<timestamp>.<rawBody>` as lowercase hex. */
export function signWebhookPayload(secret: string, timestamp: number, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Verify a Ship webhook signature.
 *
 * @param headers  The incoming request headers (Express object or Fetch Headers).
 * @param rawBody  The raw request body string/bytes exactly as received.
 * @param secret   The subscription signing secret (`whsec_…`).
 * @returns `true` only when the signature is present, fresh, and matches.
 */
export function verifyWebhook(
  headers: WebhookHeaders,
  rawBody: string,
  secret: string,
  options: VerifyWebhookOptions = {}
): boolean {
  const parsed = parseSignatureHeader(readHeader(headers, SIGNATURE_HEADER));
  if (!parsed) return false;

  const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  return timingSafeEqualHex(parsed.v1, signWebhookPayload(secret, parsed.timestamp, rawBody));
}
