import { describe, it, expect, expectTypeOf } from 'vitest';
import { ShipClient, ShipApiError, toShipSDKError, type ShipSDKError } from '../index.js';

function erroringFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch) {
  return new ShipClient({ token: 't', baseUrl: 'https://api.test', fetch: fetchImpl });
}

describe('typed SDK error union', () => {
  it('maps each ApiError code to a stable kind', async () => {
    const cases: Array<[number, string, ShipSDKError['kind']]> = [
      [401, 'unauthorized', 'auth'],
      [403, 'forbidden', 'auth'],
      [404, 'not_found', 'not_found'],
      [422, 'validation_failed', 'validation'],
      [429, 'rate_limited', 'rate_limit'],
      [500, 'server_error', 'server'],
    ];
    for (const [status, code, kind] of cases) {
      try {
        await client(erroringFetch(status, { code, message: 'x', request_id: 'req_1' })).me();
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ShipApiError);
        expect((err as ShipApiError).kind).toBe(kind);
        expect(toShipSDKError(err).kind).toBe(kind);
      }
    }
  });

  it('parses Retry-After + rate-limit headers into the rate_limit variant', async () => {
    try {
      await client(
        erroringFetch(429, { code: 'rate_limited', message: 'slow down', request_id: 'req_2' }, {
          'Retry-After': '30',
          'X-RateLimit-Limit': '120',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1700000000',
        })
      ).issues.list();
      throw new Error('should have thrown');
    } catch (err) {
      const sdk = toShipSDKError(err);
      expect(sdk.kind).toBe('rate_limit');
      if (sdk.kind === 'rate_limit') {
        expect(sdk.retryAfter).toBe(30);
        expect(sdk.limit).toBe(120);
        expect(sdk.remaining).toBe(0);
        expect(sdk.resetAt).toEqual(new Date(1700000000 * 1000));
      }
    }
  });

  it('maps network failures to a server-kind error', async () => {
    const failing = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    try {
      await client(failing).me();
      throw new Error('should have thrown');
    } catch (err) {
      const sdk = toShipSDKError(err);
      expect(sdk.kind).toBe('server');
      expect(sdk.code).toBe('network_error');
    }
  });

  it('supports an exhaustive switch over kind (type-level)', () => {
    const describe = (e: ShipSDKError): string => {
      switch (e.kind) {
        case 'auth':
          return 'auth';
        case 'rate_limit':
          return 'rate_limit';
        case 'not_found':
          return 'not_found';
        case 'validation':
          return 'validation';
        case 'server':
          return 'server';
        default: {
          // Exhaustiveness: `e` is `never` here if all kinds are handled.
          const _never: never = e;
          return _never;
        }
      }
    };
    expect(describe({ kind: 'not_found', status: 404, code: 'not_found', message: 'x' })).toBe('not_found');
    expectTypeOf(describe).parameter(0).toMatchTypeOf<ShipSDKError>();
  });
});
