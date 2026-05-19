import { chromium } from '@playwright/test';

const baseUrl = 'http://localhost:5173';
const requests = [];
const starts = new Map();
let currentFlow = 'bootstrap';

function pathWithQuery(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search}`;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
  localStorage.setItem('ship:disableActionItemsModal', 'true');
});
const page = await context.newPage();

page.on('request', (request) => {
  const url = request.url();
  if (url.includes('/api/')) {
    starts.set(request, performance.now());
  }
});

page.on('response', async (response) => {
  const request = response.request();
  if (!starts.has(request)) return;
  const startedAt = starts.get(request);
  starts.delete(request);
  requests.push({
    flow: currentFlow,
    method: request.method(),
    endpoint: pathWithQuery(response.url()),
    status: response.status(),
    durationMs: Math.round(performance.now() - startedAt),
  });
});

async function settle() {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(750);
}

currentFlow = 'login';
await page.goto(`${baseUrl}/login`);
await page.getByLabel('Email address').fill('dev@ship.local');
await page.getByLabel('Password').fill('admin123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
await settle();

const flows = [
  ['my-week', '/my-week'],
  ['docs', '/docs'],
  ['issues', '/issues'],
  ['projects', '/projects'],
  ['team-allocation', '/team/allocation'],
  ['team-status', '/team/status'],
];

for (const [name, path] of flows) {
  currentFlow = name;
  await page.goto(`${baseUrl}${path}`);
  await settle();
}

await browser.close();

const byEndpoint = new Map();
for (const request of requests) {
  const key = `${request.method} ${request.endpoint}`;
  const entry = byEndpoint.get(key) ?? {
    method: request.method,
    endpoint: request.endpoint,
    count: 0,
    flows: new Set(),
    durations: [],
    statuses: new Map(),
  };
  entry.count += 1;
  entry.flows.add(request.flow);
  entry.durations.push(request.durationMs);
  entry.statuses.set(request.status, (entry.statuses.get(request.status) ?? 0) + 1);
  byEndpoint.set(key, entry);
}

const summary = [...byEndpoint.values()]
  .map((entry) => ({
    method: entry.method,
    endpoint: entry.endpoint,
    count: entry.count,
    flows: [...entry.flows],
    minMs: Math.min(...entry.durations),
    maxMs: Math.max(...entry.durations),
    statuses: Object.fromEntries(entry.statuses),
  }))
  .sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint));

console.log(JSON.stringify({ requests, summary }, null, 2));
