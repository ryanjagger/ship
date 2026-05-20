import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parsePositiveInteger(value, fallback, name) {
  if ((value === undefined || value === '') && fallback !== null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveIntegerList(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = value.split(',').map((part) => parsePositiveInteger(part.trim(), null, name));
  if (parsed.length === 0) {
    throw new Error(`${name} must include at least one value`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3001';
const abPath = process.env.AB_PATH ?? '/usr/sbin/ab';
const benchmarkEmail = process.env.BENCHMARK_EMAIL ?? 'dev@ship.local';
const benchmarkPassword = process.env.BENCHMARK_PASSWORD ?? 'admin123';
const endpointSetName = process.env.BENCHMARK_ENDPOINT_SET ?? 'primary';
const endpointDelayMs = parseNonNegativeInteger(process.env.BENCHMARK_ENDPOINT_DELAY_MS, 0, 'BENCHMARK_ENDPOINT_DELAY_MS');

const endpointSets = {
  primary: {
    requestsPerRun: 300,
    connections: [10, 25, 50],
    endpoints: [
      { name: 'Wiki document list', method: 'GET', path: '/api/documents?type=wiki' },
      { name: 'Issue list', method: 'GET', path: '/api/issues' },
      { name: 'Project list', method: 'GET', path: '/api/projects' },
      { name: 'My Week dashboard', method: 'GET', path: '/api/dashboard/my-week' },
      { name: 'Team accountability grid', method: 'GET', path: '/api/team/accountability-grid-v3' },
    ],
  },
  'documents-appendix': {
    requestsPerRun: 3000,
    connections: [50],
    endpoints: [
      { name: 'All documents', method: 'GET', path: '/api/documents' },
      { name: 'Wiki documents', method: 'GET', path: '/api/documents?type=wiki' },
      { name: 'Issue documents', method: 'GET', path: '/api/documents?type=issue' },
      { name: 'Program documents', method: 'GET', path: '/api/documents?type=program' },
      { name: 'Project documents', method: 'GET', path: '/api/documents?type=project' },
      { name: 'Sprint documents', method: 'GET', path: '/api/documents?type=sprint' },
      { name: 'Person documents', method: 'GET', path: '/api/documents?type=person' },
      { name: 'Weekly plan documents', method: 'GET', path: '/api/documents?type=weekly_plan' },
      { name: 'Weekly retro documents', method: 'GET', path: '/api/documents?type=weekly_retro' },
      { name: 'Standup documents', method: 'GET', path: '/api/documents?type=standup' },
      { name: 'Weekly review documents', method: 'GET', path: '/api/documents?type=weekly_review' },
    ],
  },
};

const endpointSet = endpointSets[endpointSetName];
if (!endpointSet) {
  throw new Error(`Unknown BENCHMARK_ENDPOINT_SET "${endpointSetName}". Use one of: ${Object.keys(endpointSets).join(', ')}`);
}

const connections = parsePositiveIntegerList(process.env.BENCHMARK_CONNECTIONS, endpointSet.connections, 'BENCHMARK_CONNECTIONS');
const requestsPerRun = parsePositiveInteger(process.env.BENCHMARK_REQUESTS, endpointSet.requestsPerRun, 'BENCHMARK_REQUESTS');
const endpoints = endpointSet.endpoints;

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const cookie = response.headers.get('set-cookie');
  return cookie ? [cookie] : [];
}

function cookieHeader(cookies) {
  const parts = new Map();
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const [name, value] = pair.split('=');
    if (name && value) parts.set(name.trim(), value.trim());
  }
  return [...parts.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function login() {
  const csrfRes = await fetch(`${baseUrl}/api/csrf-token`);
  const csrfCookies = getSetCookies(csrfRes);
  const csrf = await csrfRes.json();
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf.token,
      cookie: cookieHeader(csrfCookies),
    },
    body: JSON.stringify({ email: benchmarkEmail, password: benchmarkPassword }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  return cookieHeader([...csrfCookies, ...getSetCookies(loginRes)]);
}

function parseAbOutput(output) {
  const percentile = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(50|95|99)%\s+(\d+)/);
    if (match) percentile[`p${match[1]}`] = Number(match[2]);
  }
  const failed = output.match(/Failed requests:\s+(\d+)/);
  const rps = output.match(/Requests per second:\s+([0-9.]+)/);
  return {
    p50: percentile.p50,
    p95: percentile.p95,
    p99: percentile.p99,
    failed: failed ? Number(failed[1]) : null,
    requestsPerSecond: rps ? Number(rps[1]) : null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function warmup(cookie, path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new Error(
        `Warmup failed for ${path}: 429 Too Many Requests. Wait for the one-minute rate-limit window to reset before rerunning. For the documents appendix, use BENCHMARK_ENDPOINT_DELAY_MS=65000.${body ? ` Response: ${body}` : ''}`
      );
    }
    throw new Error(`Warmup failed for ${path}: ${response.status}${body ? ` ${body}` : ''}`);
  }
  const body = await response.arrayBuffer();
  let itemCount = null;

  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
      itemCount = Array.isArray(parsed) ? parsed.length : null;
    } catch {
      itemCount = null;
    }
  }

  return {
    responseBytes: body.byteLength,
    itemCount,
  };
}

const cookie = await login();
const results = [];
const startedAt = new Date().toISOString();

for (const [endpointIndex, endpoint] of endpoints.entries()) {
  const warmupMetadata = await warmup(cookie, endpoint.path);
  for (const concurrency of connections) {
    const url = `${baseUrl}${endpoint.path}`;
    const { stdout } = await execFileAsync(abPath, [
      '-q',
      '-n',
      String(requestsPerRun),
      '-c',
      String(concurrency),
      '-H',
      `Cookie: ${cookie}`,
      url,
    ], { maxBuffer: 1024 * 1024 * 4 });
    results.push({
      ...endpoint,
      ...warmupMetadata,
      concurrency,
      requests: requestsPerRun,
      ...parseAbOutput(stdout),
    });
  }

  if (endpointDelayMs > 0 && endpointIndex < endpoints.length - 1) {
    console.error(`Waiting ${endpointDelayMs}ms before next endpoint to avoid local API rate limits...`);
    await delay(endpointDelayMs);
  }
}

console.log(JSON.stringify({
  metadata: {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl,
    abPath,
    endpointSet: endpointSetName,
    requestsPerRun,
    connections,
    endpointDelayMs,
    endpoints,
    authenticatedAs: benchmarkEmail,
  },
  results,
}, null, 2));
