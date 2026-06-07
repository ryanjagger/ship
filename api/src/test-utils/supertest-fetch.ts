/**
 * Adapt the WHATWG `fetch` interface onto supertest so SDK-driven code (the
 * Fleet API client) can be exercised against an in-process Express app with no
 * listening socket. The SDK only uses `fetch(url, {method, headers, body})`
 * and reads `res.ok/status/headers/text()`, so the adapter covers exactly
 * that surface.
 */

import request from 'supertest';
import type { Express } from 'express';

export function supertestFetch(app: Express): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Base is irrelevant — supertest routes by path; it only normalizes
    // relative and absolute forms alike.
    const url = new URL(rawUrl, 'http://supertest.local');
    const path = `${url.pathname}${url.search}`;
    const method = (init?.method ?? 'GET').toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete' | 'head' | 'options';

    let req = request(app)[method](path);
    new Headers(init?.headers).forEach((value, key) => {
      req = req.set(key, value);
    });
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string') {
        throw new Error('supertestFetch only supports string bodies (the SDK always JSON.stringifies)');
      }
      req = req.send(init.body);
    }

    const res = await req;
    // `Response` forbids a body on 204/304 — pass null there.
    const noBody = res.status === 204 || res.status === 304;
    return new Response(noBody ? null : (res.text ?? ''), {
      status: res.status,
      headers: res.headers as Record<string, string>,
    });
  };
  return impl as typeof fetch;
}
