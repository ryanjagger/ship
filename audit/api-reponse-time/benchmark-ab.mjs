import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const baseUrl = 'http://localhost:3001';
const connections = [10, 25, 50];
const requestsPerRun = 300;

const endpoints = [
  { name: 'Wiki document list', method: 'GET', path: '/api/documents?type=wiki' },
  { name: 'Issue list', method: 'GET', path: '/api/issues' },
  { name: 'Project list', method: 'GET', path: '/api/projects' },
  { name: 'My Week dashboard', method: 'GET', path: '/api/dashboard/my-week' },
  { name: 'Team accountability grid', method: 'GET', path: '/api/team/accountability-grid-v3' },
];

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
    body: JSON.stringify({ email: 'dev@ship.local', password: 'admin123' }),
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

async function warmup(cookie, path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  if (!response.ok) {
    throw new Error(`Warmup failed for ${path}: ${response.status}`);
  }
  await response.arrayBuffer();
}

const cookie = await login();
const results = [];

for (const endpoint of endpoints) {
  await warmup(cookie, endpoint.path);
  for (const concurrency of connections) {
    const url = `${baseUrl}${endpoint.path}`;
    const { stdout } = await execFileAsync('/usr/sbin/ab', [
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
      concurrency,
      requests: requestsPerRun,
      ...parseAbOutput(stdout),
    });
  }
}

console.log(JSON.stringify(results, null, 2));
