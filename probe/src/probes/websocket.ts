import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { Socket } from 'node:net';
import type { ProbeConfig } from '../config.js';
import { ProbeHttpClient, responseBodyPath } from '../http-client.js';
import { finding, notTested, pass, type ProbeCheck, type ProbeSeverity } from '../report.js';

type RawWebSocket = {
  url: string;
  statusCode: number;
  statusLine: string;
  headers: Record<string, string>;
  socket?: Socket;
  bodyPreview?: string;
};

type FrameObservation = {
  closed: boolean;
  destroyed: boolean;
  closeCode?: number;
  error?: string;
  receivedBytes: number;
};

type ProbeDocument = {
  id: string;
  title: string;
};

const WS_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

export async function runWebSocketProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const userAgent = `ship-probe/${config.runId}`;

  checks.push(await checkUnauthenticatedUpgrade(config, '/events', 'websocket.events.unauthenticated'));
  checks.push(await checkUnauthenticatedUpgrade(
    config,
    '/collaboration/wiki:00000000-0000-0000-0000-000000000000',
    'websocket.collaboration.unauthenticated'
  ));

  if (!config.allowMutation) {
    checks.push(notTested('websocket.validation.mutating_cases', 'Authenticated WebSocket validation probes require --allow-mutation', 'websocket', {
      allowMutation: false,
      reason: 'The probe creates a dedicated document and sends malformed frames to a live server.',
    }));
    return checks;
  }

  const client = new ProbeHttpClient(config.apiUrl, config.timeoutMs, userAgent);
  const loginResponse = await client.login(config.email, config.password);
  if (!loginResponse.ok) {
    checks.push(notTested('websocket.validation.authenticated_cases', 'Authenticated WebSocket probes require successful login', 'websocket', {
      loginStatus: loginResponse.status,
      body: loginResponse.body,
      email: config.email,
    }));
    return checks;
  }

  const documentResult = await createProbeDocument(config, client);
  if ('check' in documentResult) {
    checks.push(documentResult.check);
    return checks;
  }

  const document = documentResult.document;
  checks.push(pass('websocket.fixture.document', 'Created dedicated document for WebSocket probes', 'websocket', {
    document,
  }, [
    `POST ${config.apiUrl}/api/documents with document_type=wiki`,
  ]));

  const cookieHeader = client.cookies.header();

  checks.push(await checkEventsMalformedJson(config, cookieHeader));
  checks.push(await checkEventsUnexpectedType(config, cookieHeader));
  checks.push(await checkCollaborationUnknownMessage(config, cookieHeader, document.id));
  checks.push(await checkCollaborationMalformedMessage(config, cookieHeader, document.id));
  checks.push(await checkCollaborationOversizedMessage(config, cookieHeader, document.id));

  if (!config.keepData) {
    checks.push(await cleanupProbeDocument(config, client, document));
  } else {
    checks.push(notTested('websocket.fixture.cleanup', 'WebSocket probe document cleanup skipped because --keep-data was set', 'websocket', {
      document,
    }));
  }

  return checks;
}

async function checkUnauthenticatedUpgrade(config: ProbeConfig, path: string, id: string): Promise<ProbeCheck> {
  const url = websocketUrl(config.apiUrl, path);
  const connection = await openRawWebSocket(url, {
    timeoutMs: config.timeoutMs,
    userAgent: `ship-probe/${config.runId}`,
  });
  connection.socket?.destroy();

  if (connection.statusCode === 401 || connection.statusCode === 403) {
    return pass(id, 'Unauthenticated WebSocket upgrade is rejected', 'websocket', {
      url,
      statusCode: connection.statusCode,
      statusLine: connection.statusLine,
    }, [`Open WebSocket ${url} without a session cookie`]);
  }

  if (connection.statusCode === 0) {
    const health = await checkHealth(config);
    if (health.ok) {
      return pass(id, 'Unauthenticated WebSocket upgrade was closed without accepting connection', 'websocket', {
        url,
        statusCode: connection.statusCode,
        statusLine: connection.statusLine,
        health,
      }, [`Open WebSocket ${url} without a session cookie`]);
    }

    return notTested(id, 'Unauthenticated WebSocket upgrade could not be tested because the API was unreachable', 'websocket', {
      url,
      statusCode: connection.statusCode,
      statusLine: connection.statusLine,
      health,
    }, [`Open WebSocket ${url} without a session cookie`]);
  }

  return finding(id, 'Unauthenticated WebSocket upgrade was not rejected', 'websocket', 'critical', {
    url,
    statusCode: connection.statusCode,
    statusLine: connection.statusLine,
    bodyPreview: connection.bodyPreview,
  }, [`Open WebSocket ${url} without a session cookie`]);
}

async function checkEventsMalformedJson(config: ProbeConfig, cookieHeader: string): Promise<ProbeCheck> {
  return withWebSocketCase({
    config,
    id: 'websocket.events.malformed_json',
    title: '/events handles malformed JSON without crashing',
    path: '/events',
    cookieHeader,
    send: (ws) => sendFrame(ws, 0x1, Buffer.from('{not-json')),
    classify: ({ observation, health }) => classifyStability({
      observation,
      health,
      id: 'websocket.events.malformed_json',
      title: '/events handles malformed JSON without crashing',
      path: '/events',
      acceptableOpen: true,
    }),
  });
}

async function checkEventsUnexpectedType(config: ProbeConfig, cookieHeader: string): Promise<ProbeCheck> {
  return withWebSocketCase({
    config,
    id: 'websocket.events.unexpected_type',
    title: '/events handles unexpected message type without crashing',
    path: '/events',
    cookieHeader,
    send: (ws) => sendFrame(ws, 0x1, Buffer.from(JSON.stringify({ type: `probe:${config.runId}`, data: { unexpected: true } }))),
    classify: ({ observation, health }) => classifyStability({
      observation,
      health,
      id: 'websocket.events.unexpected_type',
      title: '/events handles unexpected message type without crashing',
      path: '/events',
      acceptableOpen: true,
    }),
  });
}

async function checkCollaborationUnknownMessage(config: ProbeConfig, cookieHeader: string, documentId: string): Promise<ProbeCheck> {
  const path = `/collaboration/wiki:${documentId}`;
  return withWebSocketCase({
    config,
    id: 'websocket.collaboration.unknown_message_type',
    title: 'Collaboration WebSocket handles unknown message type without crashing',
    path,
    cookieHeader,
    send: (ws) => sendFrame(ws, 0x2, Buffer.from([99])),
    classify: ({ observation, health }) => classifyStability({
      observation,
      health,
      id: 'websocket.collaboration.unknown_message_type',
      title: 'Collaboration WebSocket handles unknown message type without crashing',
      path,
      acceptableOpen: true,
    }),
  });
}

async function checkCollaborationMalformedMessage(config: ProbeConfig, cookieHeader: string, documentId: string): Promise<ProbeCheck> {
  const path = `/collaboration/wiki:${documentId}`;
  return withWebSocketCase({
    config,
    id: 'websocket.collaboration.malformed_empty_binary',
    title: 'Collaboration WebSocket rejects malformed empty binary message without crashing',
    path,
    cookieHeader,
    send: (ws) => sendFrame(ws, 0x2, Buffer.alloc(0)),
    classify: ({ observation, health }) => {
      if (!health.ok) {
        return finding('websocket.collaboration.malformed_empty_binary', 'Malformed collaboration message may have crashed the API', 'websocket', 'critical', {
          path,
          observation,
          health,
        }, [
          `Open WebSocket ${websocketUrl(config.apiUrl, path)} with a valid session cookie`,
          'Send an empty binary frame',
          `GET ${config.apiUrl}/health`,
        ]);
      }

      if (wasRejected(observation)) {
        return pass('websocket.collaboration.malformed_empty_binary', 'Malformed collaboration message closed or rejected without crashing API', 'websocket', {
          path,
          observation,
          health,
        }, [
          `Open WebSocket ${websocketUrl(config.apiUrl, path)} with a valid session cookie`,
          'Send an empty binary frame',
          `GET ${config.apiUrl}/health`,
        ]);
      }

      return finding('websocket.collaboration.malformed_empty_binary', 'Malformed collaboration message was silently accepted', 'websocket', 'medium', {
        path,
        observation,
        health,
      }, [
        `Open WebSocket ${websocketUrl(config.apiUrl, path)} with a valid session cookie`,
        'Send an empty binary frame',
      ]);
    },
  });
}

async function checkCollaborationOversizedMessage(config: ProbeConfig, cookieHeader: string, documentId: string): Promise<ProbeCheck> {
  const path = `/collaboration/wiki:${documentId}`;
  return withWebSocketCase({
    config,
    id: 'websocket.collaboration.oversized_message',
    title: 'Collaboration WebSocket rejects oversized message without crashing',
    path,
    cookieHeader,
    observeMs: 2_000,
    send: (ws) => sendFrame(ws, 0x2, Buffer.alloc(WS_MAX_MESSAGE_SIZE + 1, 0x61)),
    classify: ({ observation, health }) => {
      if (!health.ok) {
        return finding('websocket.collaboration.oversized_message', 'Oversized WebSocket message may have crashed the API', 'websocket', 'critical', {
          path,
          payloadBytes: WS_MAX_MESSAGE_SIZE + 1,
          observation,
          health,
        }, [
          `Open WebSocket ${websocketUrl(config.apiUrl, path)} with a valid session cookie`,
          `Send a ${WS_MAX_MESSAGE_SIZE + 1} byte binary frame`,
          `GET ${config.apiUrl}/health`,
        ]);
      }

      if (wasRejected(observation)) {
        return pass('websocket.collaboration.oversized_message', 'Oversized WebSocket message was rejected without crashing API', 'websocket', {
          path,
          payloadBytes: WS_MAX_MESSAGE_SIZE + 1,
          observation,
          health,
        }, [
          `Open WebSocket ${websocketUrl(config.apiUrl, path)} with a valid session cookie`,
          `Send a ${WS_MAX_MESSAGE_SIZE + 1} byte binary frame`,
        ]);
      }

      return finding('websocket.collaboration.oversized_message', 'Oversized WebSocket message remained accepted/open', 'websocket', 'high', {
        path,
        payloadBytes: WS_MAX_MESSAGE_SIZE + 1,
        observation,
        health,
      }, [
        `Open WebSocket ${websocketUrl(config.apiUrl, path)} with a valid session cookie`,
        `Send a ${WS_MAX_MESSAGE_SIZE + 1} byte binary frame`,
      ]);
    },
  });
}

async function withWebSocketCase(args: {
  config: ProbeConfig;
  id: string;
  title: string;
  path: string;
  cookieHeader: string;
  observeMs?: number;
  send: (ws: RawWebSocket) => void;
  classify: (result: { observation: FrameObservation; health: HealthCheck }) => ProbeCheck;
}): Promise<ProbeCheck> {
  const url = websocketUrl(args.config.apiUrl, args.path);
  const preHealth = await checkHealth(args.config);
  if (!preHealth.ok) {
    return notTested(args.id, `${args.title}: API was unreachable before this WebSocket case`, 'websocket', {
      url,
      health: preHealth,
    }, [
      `GET ${args.config.apiUrl}/health before opening ${url}`,
    ]);
  }

  const ws = await openRawWebSocket(url, {
    cookieHeader: args.cookieHeader,
    timeoutMs: args.config.timeoutMs,
    userAgent: `ship-probe/${args.config.runId}`,
  });

  if (ws.statusCode !== 101 || !ws.socket) {
    ws.socket?.destroy();
    return finding(args.id, `${args.title}: WebSocket upgrade failed`, 'websocket', 'high', {
      url,
      statusCode: ws.statusCode,
      statusLine: ws.statusLine,
      bodyPreview: ws.bodyPreview,
    }, [
      `Open WebSocket ${url} with a valid session cookie`,
    ]);
  }

  args.send(ws);
  const observation = await observeSocket(ws.socket, args.observeMs ?? 800);
  const health = await checkHealth(args.config);
  ws.socket.destroy();

  return args.classify({ observation, health });
}

function classifyStability(args: {
  observation: FrameObservation;
  health: HealthCheck;
  id: string;
  title: string;
  path: string;
  acceptableOpen: boolean;
}): ProbeCheck {
  if (!args.health.ok) {
    return finding(args.id, `${args.title}: API health check failed after WebSocket message`, 'websocket', 'critical', {
      path: args.path,
      observation: args.observation,
      health: args.health,
    }, [
      `Open WebSocket path ${args.path} with a valid session cookie`,
      'Send the documented invalid WebSocket message',
      'Check /health',
    ]);
  }

  if (args.observation.error) {
    return finding(args.id, `${args.title}: socket error after invalid message`, 'websocket', 'medium', {
      path: args.path,
      observation: args.observation,
      health: args.health,
    }, [
      `Open WebSocket path ${args.path} with a valid session cookie`,
      'Send the documented invalid WebSocket message',
    ]);
  }

  if (args.acceptableOpen || wasRejected(args.observation)) {
    return pass(args.id, args.title, 'websocket', {
      path: args.path,
      observation: args.observation,
      health: args.health,
    }, [
      `Open WebSocket path ${args.path} with a valid session cookie`,
      'Send the documented invalid WebSocket message',
      'Check /health',
    ]);
  }

  return finding(args.id, `${args.title}: invalid message remained open`, 'websocket', 'medium', {
    path: args.path,
    observation: args.observation,
    health: args.health,
  }, [
    `Open WebSocket path ${args.path} with a valid session cookie`,
    'Send the documented invalid WebSocket message',
  ]);
}

function wasRejected(observation: FrameObservation): boolean {
  return observation.closed || observation.destroyed || observation.closeCode !== undefined;
}

async function createProbeDocument(config: ProbeConfig, client: ProbeHttpClient): Promise<{ document: ProbeDocument } | { check: ProbeCheck }> {
  const title = `${config.runId} websocket probe`;
  const response = await client.request('/api/documents', {
    method: 'POST',
    csrf: true,
    body: {
      title,
      document_type: 'wiki',
      visibility: 'workspace',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'WebSocket probe fixture' }] }],
      },
    },
  });

  const id = stringPath(response.body, ['id']);
  if (!response.ok || !id) {
    return {
      check: finding('websocket.fixture.document', 'Could not create document for authenticated WebSocket probes', 'websocket', 'high', {
        status: response.status,
        body: response.body,
      }, [
        `POST ${config.apiUrl}/api/documents with document_type=wiki`,
      ]),
    };
  }

  return { document: { id, title } };
}

async function cleanupProbeDocument(config: ProbeConfig, client: ProbeHttpClient, document: ProbeDocument): Promise<ProbeCheck> {
  const response = await client.request(`/api/documents/${encodeURIComponent(document.id)}`, {
    method: 'DELETE',
    csrf: true,
  });

  if (response.ok || response.status === 204 || response.status === 404) {
    return pass('websocket.fixture.cleanup', 'WebSocket probe document was cleaned up', 'websocket', {
      document,
      status: response.status,
    }, [`DELETE ${config.apiUrl}/api/documents/${document.id}`]);
  }

  return finding('websocket.fixture.cleanup', 'WebSocket probe document cleanup failed', 'websocket', 'medium', {
    document,
    status: response.status,
    body: response.body,
  }, [`DELETE ${config.apiUrl}/api/documents/${document.id}`]);
}

type HealthCheck = {
  ok: boolean;
  status: number;
  body: unknown;
};

async function checkHealth(config: ProbeConfig): Promise<HealthCheck> {
  const client = new ProbeHttpClient(config.apiUrl, config.timeoutMs, `ship-probe/${config.runId}`);
  const response = await client.request('/health');
  return {
    ok: response.ok,
    status: response.status,
    body: response.body,
  };
}

function openRawWebSocket(url: string, options: {
  cookieHeader?: string;
  timeoutMs: number;
  userAgent: string;
}): Promise<RawWebSocket> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    const host = parsed.hostname;
    const path = `${parsed.pathname}${parsed.search}`;
    const key = randomBytes(16).toString('base64');
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let settled = false;
    let buffer = Buffer.alloc(0);

    const timeout = setTimeout(() => {
      finish({
        url,
        statusCode: 0,
        statusLine: 'timeout waiting for websocket upgrade',
        headers: {},
        socket,
      });
    }, options.timeoutMs);

    function finish(result: RawWebSocket): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      socket.off('secureConnect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (result.statusCode !== 101) socket.destroy();
      resolve(result);
    }

    function onConnect(): void {
      socket.setNoDelay(true);
      const headers = [
        `GET ${path} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `User-Agent: ${options.userAgent}`,
      ];
      if (options.cookieHeader) headers.push(`Cookie: ${options.cookieHeader}`);
      headers.push('\r\n');
      socket.write(headers.join('\r\n'));
    }

    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerText = buffer.slice(0, headerEnd).toString('utf8');
      const bodyPreview = buffer.slice(headerEnd + 4, headerEnd + 204).toString('utf8');
      const lines = headerText.split('\r\n');
      const statusLine = lines[0] ?? '';
      const statusCode = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }

      finish({ url, statusCode, statusLine, headers, socket, bodyPreview });
    }

    function onError(error: Error): void {
      finish({
        url,
        statusCode: 0,
        statusLine: error.message,
        headers: {},
        bodyPreview: error.message,
      });
    }

    function onClose(): void {
      finish({
        url,
        statusCode: 0,
        statusLine: 'connection closed before websocket upgrade',
        headers: {},
        bodyPreview: buffer.toString('utf8').slice(0, 200),
      });
    }

    socket.once(secure ? 'secureConnect' : 'connect', onConnect);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function sendFrame(ws: RawWebSocket, opcode: number, payload: Buffer): void {
  if (!ws.socket || ws.socket.destroyed) return;

  const firstByte = 0x80 | opcode;
  const maskBit = 0x80;
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.from([firstByte, maskBit | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }

  ws.socket.write(Buffer.concat([header, mask, masked]));
}

function observeSocket(socket: Socket, observeMs: number): Promise<FrameObservation> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    let closed = false;
    let error: string | undefined;

    const timeout = setTimeout(done, observeMs);

    function cleanup(): void {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    }

    function done(): void {
      cleanup();
      const closeCode = parseCloseCode(received);
      resolve({
        closed,
        destroyed: socket.destroyed,
        ...(closeCode !== undefined ? { closeCode } : {}),
        ...(error ? { error } : {}),
        receivedBytes: received.length,
      });
    }

    function onData(chunk: Buffer): void {
      received = Buffer.concat([received, chunk]);
    }

    function onClose(): void {
      closed = true;
      done();
    }

    function onError(err: Error): void {
      error = err.message;
      done();
    }

    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function parseCloseCode(buffer: Buffer): number | undefined {
  for (let offset = 0; offset + 2 <= buffer.length;) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) return undefined;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) return undefined;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      length = Number(longLength);
      headerLength = 10;
    }

    const payloadStart = offset + headerLength;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) return undefined;

    if (opcode === 0x8 && length >= 2) {
      return buffer.readUInt16BE(payloadStart);
    }

    offset = payloadEnd;
  }

  return undefined;
}

function websocketUrl(apiUrl: string, path: string): string {
  const parsed = new URL(apiUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = path;
  parsed.search = '';
  return parsed.toString();
}

function stringPath(body: unknown, path: string[]): string | undefined {
  const value = responseBodyPath({ body } as never, path);
  return typeof value === 'string' ? value : undefined;
}
