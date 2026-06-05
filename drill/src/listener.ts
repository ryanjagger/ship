/**
 * Local signed-webhook listener.
 *
 * A throwaway HTTP server that captures the EXACT raw request body bytes and
 * headers of each incoming delivery — raw bytes matter because the signature is
 * an HMAC over `<timestamp>.<rawBody>`, and re-serializing the parsed JSON would
 * change the bytes and break verification. `waitFor` resolves on the first
 * delivery matching a predicate (or rejects on timeout).
 *
 * The API spawned by the env harness runs with WEBHOOK_ALLOW_PRIVATE_TARGETS=true,
 * so a 127.0.0.1 target URL passes the SSRF guard.
 */
import http from 'node:http';
import { once } from 'node:events';
import getPort from 'get-port';

export interface CapturedDelivery {
  headers: Record<string, string>;
  rawBody: string;
  receivedAt: number;
}

export interface Listener {
  url: string;
  /** Resolve with the first captured delivery matching `predicate`. */
  waitFor(predicate: (d: CapturedDelivery) => boolean, opts: { timeoutMs: number }): Promise<CapturedDelivery>;
  close(): Promise<void>;
}

export async function startListener(): Promise<Listener> {
  const captured: CapturedDelivery[] = [];
  const waiters: Array<{ predicate: (d: CapturedDelivery) => boolean; resolve: (d: CapturedDelivery) => void }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      // Express-style lowercased single-value headers — matches what verifyWebhook expects.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v[0] ?? '';
      }
      const delivery: CapturedDelivery = { headers, rawBody, receivedAt: Date.now() };
      captured.push(delivery);

      // Resolve any waiter whose predicate now matches.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w && w.predicate(delivery)) {
          waiters.splice(i, 1);
          w.resolve(delivery);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  const port = await getPort();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${port}`,

    waitFor(predicate, { timeoutMs }) {
      // Replay already-captured deliveries first (handles fast deliveries that
      // landed before the caller started waiting).
      const existing = captured.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise<CapturedDelivery>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for a matching webhook delivery`));
        }, timeoutMs);

        const wrapped = (d: CapturedDelivery): void => {
          clearTimeout(timer);
          resolve(d);
        };
        waiters.push({ predicate, resolve: wrapped });
      });
    },

    async close() {
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}
