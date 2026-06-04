/**
 * SSRF guard for webhook target URLs.
 *
 * Webhook delivery does a server-side `fetch(subscription.url)`, so an attacker
 * with `webhooks:manage` could otherwise point a subscription at loopback, the
 * cloud metadata endpoint (169.254.169.254), or other private-network services
 * and use delivery as an SSRF primitive. We reject non-http(s) schemes and
 * private/loopback/link-local hosts at create/update AND re-check at dispatch.
 *
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` is a dev/test escape hatch (e.g. a local
 * receiver on 127.0.0.1) — it must never be set in production.
 *
 * NOTE: this validates the literal host. A hostname that *resolves* to a private
 * IP (DNS rebinding) is not caught here; pinning the resolved IP at fetch time
 * is tracked as follow-up hardening.
 */

const PRIVATE_V4 = [
  /^0\./, // "this host"
  /^10\./, // RFC 1918
  /^127\./, // loopback
  /^169\.254\./, // link-local + cloud metadata (169.254.169.254)
  /^192\.168\./, // RFC 1918
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // RFC 1918 172.16.0.0/12
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT 100.64.0.0/10
];

/** Returns an error message if the URL is not a safe webhook target, else null. */
export function webhookTargetError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be a valid absolute URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'url must use http or https';
  }
  if (process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true') return null;

  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    return 'url must use https';
  }

  // URL.hostname strips IPv6 brackets; normalize defensively anyway.
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    return 'url host is not allowed (loopback)';
  }
  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10)
  // and IPv4-mapped IPv6 (::ffff:a.b.c.d).
  if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) {
    return 'url host is not allowed (private address)';
  }
  // IPv4 literal in a private/loopback/link-local range.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) {
    return 'url host is not allowed (private address)';
  }
  return null;
}
